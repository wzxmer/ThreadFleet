use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{SystemTime, UNIX_EPOCH};

use sha2::{Digest, Sha256};
use tokio::sync::Mutex;

use crate::shared::attachment_storage_core::validate_session_attachment_cleanup;
use crate::shared::session_manager_core::audit::{
    append_deletion_audit, normalized_source_path_id, DeletionAuditEntry, DeletionReason,
    DeletionResult,
};
use crate::shared::session_manager_core::cleanup::{
    cleanup_eligible_sessions, prepare_scheduled_cleanup,
};
use crate::shared::session_manager_core::delete::delete_exact_archived_session;
use crate::shared::session_manager_core::derivation::build_session_derivation_content;
use crate::shared::session_manager_core::ledger::{
    apply_archive_ledger, record_confirmed_archive_time, remove_archive_times,
};
use crate::shared::session_manager_core::scanner::{
    scan_session_source, scan_session_sources, scan_session_sources_with_archive_mode,
    MultiSourceSessionScanResult, SourceSessionScanResult,
};
use crate::shared::session_manager_core::search::{
    search_scan_results, SearchCacheKey, SearchDocument,
};
use crate::shared::session_manager_core::sources::{
    add_session_source, remove_session_source, rename_session_source, set_session_source_enabled,
};
use crate::storage::write_settings;
use crate::types::{
    AppSettings, ArchiveManagedSessionResult, ArchiveManagedSessionsRequest,
    ArchiveManagedSessionsResponse, ManagedSession, ManagedSessionCleanupPreview,
    ManagedSessionCleanupRequest, ManagedSessionCleanupResponse,
    ManagedSessionCleanupSchedulerRequest, ManagedSessionCleanupSchedulerResponse,
    ManagedSessionDerivationPreview, ManagedSessionPage, ManagedSessionPageRequest,
    PermanentlyDeleteManagedSessionRequest, PermanentlyDeleteManagedSessionResponse,
    PermanentlyDeleteManagedSessionResult, PrepareManagedSessionDerivationRequest,
    SessionScanDiagnosticDto, SessionScanRequest, SessionScanSummary, SessionSearchProgress,
    SessionSearchRequest, SessionSearchResponse, SessionSource, SessionSourceSnapshot,
    SessionSourceUpdateRequest, SessionThreadPresence, SessionThreadVerification,
    VerifySessionThreadsRequest, VerifySessionThreadsResponse,
};

const MAX_PAGE_LIMIT: usize = 500;
const MAX_VERIFY_THREAD_IDS: usize = 256;

#[derive(Debug, Clone, PartialEq, Eq)]
struct DeleteOperationOutcome {
    success: bool,
    error: Option<String>,
}

fn execute_delete_steps<DeleteSession, DeleteAttachments>(
    delete_session: DeleteSession,
    delete_attachments: DeleteAttachments,
) -> DeleteOperationOutcome
where
    DeleteSession: FnOnce() -> Result<(), String>,
    DeleteAttachments: FnOnce() -> Result<(), String>,
{
    if let Err(error) = delete_session() {
        return DeleteOperationOutcome {
            success: false,
            error: Some(error),
        };
    }
    let error = delete_attachments()
        .err()
        .map(|error| format!("Session attachment cleanup failed: {error}"));
    DeleteOperationOutcome {
        success: true,
        error,
    }
}

#[derive(Debug, Clone, Default)]
pub(crate) struct SessionManagerRuntime {
    scans: Arc<Mutex<HashMap<String, MultiSourceSessionScanResult>>>,
    latest_scan: Arc<Mutex<Option<MultiSourceSessionScanResult>>>,
    source_snapshots: Arc<Mutex<HashMap<String, SessionSourceSnapshot>>>,
    source_generation_counters: Arc<Mutex<HashMap<String, u64>>>,
    cancelled_requests: Arc<Mutex<HashSet<String>>>,
    search_cache: Arc<StdMutex<HashMap<SearchCacheKey, SearchDocument>>>,
    searches: Arc<StdMutex<HashMap<String, SessionSearchResponse>>>,
    confirmed_archive_times: Arc<Mutex<HashMap<String, i64>>>,
    archive_ledger_lock: Arc<Mutex<()>>,
    deletion_audit_lock: Arc<Mutex<()>>,
    cleanup_scheduler_lock: Arc<Mutex<()>>,
    cleanup_startup_pending: Arc<Mutex<bool>>,
    archive_ledger_path: Option<PathBuf>,
    deletion_audit_path: Option<PathBuf>,
    cleanup_scheduler_path: Option<PathBuf>,
}

fn fingerprint_source_scan(scan: &SourceSessionScanResult) -> String {
    let mut facts = scan
        .sessions
        .iter()
        .map(|session| {
            format!(
                "session\0{}\0{:?}\0{:?}\0{:?}\0{:?}",
                session.thread_id,
                session.updated_at,
                session.archived_at,
                session.file_status,
                session.file_confidence
            )
        })
        .collect::<Vec<_>>();
    facts.extend(scan.diagnostics.iter().map(|diagnostic| {
        format!(
            "diagnostic\0{}\0{}",
            diagnostic
                .path
                .as_ref()
                .map(|path| path.to_string_lossy().into_owned())
                .unwrap_or_default(),
            diagnostic.error
        )
    }));
    facts.sort();

    let mut digest = Sha256::new();
    digest.update(scan.source_id.as_bytes());
    for fact in facts {
        digest.update([0]);
        digest.update(fact.as_bytes());
    }
    format!("{:x}", digest.finalize())
}

async fn record_source_snapshot(
    runtime: &SessionManagerRuntime,
    source_id: &str,
    generation: u64,
    fingerprint: String,
    complete: bool,
    scanned_at: i64,
) -> SessionSourceSnapshot {
    let snapshot = SessionSourceSnapshot {
        source_id: source_id.to_string(),
        generation,
        fingerprint,
        complete,
        scanned_at,
    };
    let mut snapshots = runtime.source_snapshots.lock().await;
    if snapshots
        .get(source_id)
        .is_none_or(|current| current.generation <= generation)
    {
        snapshots.insert(source_id.to_string(), snapshot.clone());
    }
    snapshot
}

async fn reserve_source_generation(runtime: &SessionManagerRuntime, source_id: &str) -> u64 {
    let mut counters = runtime.source_generation_counters.lock().await;
    let generation = counters
        .get(source_id)
        .copied()
        .unwrap_or(0)
        .saturating_add(1);
    counters.insert(source_id.to_string(), generation);
    generation
}

fn scan_diagnostics_dto(scan: &SourceSessionScanResult) -> Vec<SessionScanDiagnosticDto> {
    scan.diagnostics
        .iter()
        .map(|diagnostic| SessionScanDiagnosticDto {
            source_id: diagnostic.source_id.clone(),
            path: diagnostic
                .path
                .as_ref()
                .map(|path| path.to_string_lossy().into_owned()),
            error: diagnostic.error.clone(),
        })
        .collect()
}

pub(crate) async fn permanently_delete_managed_session_core(
    request: PermanentlyDeleteManagedSessionRequest,
    app_settings: &Mutex<AppSettings>,
    runtime: &SessionManagerRuntime,
) -> Result<PermanentlyDeleteManagedSessionResponse, String> {
    permanently_delete_managed_session_with_reason(
        request,
        app_settings,
        runtime,
        DeletionReason::Manual,
    )
    .await
}

async fn permanently_delete_managed_session_with_reason(
    request: PermanentlyDeleteManagedSessionRequest,
    app_settings: &Mutex<AppSettings>,
    runtime: &SessionManagerRuntime,
    reason: DeletionReason,
) -> Result<PermanentlyDeleteManagedSessionResponse, String> {
    let source = app_settings
        .lock()
        .await
        .session_sources
        .iter()
        .find(|source| source.id == request.source_id.trim() && source.enabled)
        .cloned()
        .ok_or_else(|| "Session source is unavailable".to_string())?;
    let source_for_scan = source.clone();
    let mut fresh = tokio::task::spawn_blocking(move || scan_session_source(&source_for_scan))
        .await
        .map_err(|error| error.to_string())?;
    if let Some(path) = runtime.archive_ledger_path.as_deref() {
        let _ledger_guard = runtime.archive_ledger_lock.lock().await;
        apply_archive_ledger(&mut fresh.sessions, path, current_time_ms())?;
    }
    let thread_id = request.thread_id.trim();
    let target = fresh
        .sessions
        .iter()
        .find(|session| session.thread_id == thread_id)
        .cloned()
        .ok_or_else(|| "Managed session was not found during delete revalidation".to_string())?;
    if target.archived_at != Some(request.archived_at) {
        return Err("Managed session archive time changed; refresh and confirm again".to_string());
    }
    let mut targets = vec![target.clone()];
    if request.cascade_requested {
        targets.extend(
            fresh
                .sessions
                .iter()
                .filter(|session| session.parent_thread_id.as_deref() == Some(thread_id))
                .cloned(),
        );
    }
    let deleted_at = current_time_ms();
    let mut results = Vec::with_capacity(targets.len());
    let mut deleted_keys = Vec::new();
    let _audit_guard = runtime.deletion_audit_lock.lock().await;
    for session in targets {
        let outcome = match validate_session_attachment_cleanup(
            Path::new(&source.codex_home_path),
            &session.thread_id,
        ) {
            Ok(attachment_cleanup) => match fresh.files_by_key.get(&session.key) {
                Some(file) => execute_delete_steps(
                    || delete_exact_archived_session(&source, &session, &file.path),
                    || attachment_cleanup.delete(),
                ),
                None => DeleteOperationOutcome {
                    success: false,
                    error: Some("Managed session does not have an exact verified file".to_string()),
                },
            },
            Err(error) => DeleteOperationOutcome {
                success: false,
                error: Some(format!("Session attachment prevalidation failed: {error}")),
            },
        };
        let mut result = PermanentlyDeleteManagedSessionResult {
            source_id: source.id.clone(),
            thread_id: session.thread_id.clone(),
            success: outcome.success,
            error: outcome.error,
        };
        if let Some(path) = runtime.deletion_audit_path() {
            if let Err(error) = append_deletion_audit(
                path,
                &DeletionAuditEntry {
                    source_id: source.id.clone(),
                    source_path_id: normalized_source_path_id(&source.codex_home_path),
                    thread_id: session.thread_id.clone(),
                    archived_at: session.archived_at.unwrap_or(request.archived_at),
                    deleted_at,
                    reason,
                    result: if result.success {
                        DeletionResult::Success
                    } else {
                        DeletionResult::Failure
                    },
                    error_summary: result.error.clone(),
                    cascade_requested: request.cascade_requested,
                },
            ) {
                let summary = format!("Deletion audit write failed: {error}");
                result.error = Some(match result.error.take() {
                    Some(existing) => format!("{existing}; {summary}"),
                    None => summary,
                });
            }
        }
        if result.success {
            deleted_keys.push(session.key.clone());
            remove_session_from_runtime(runtime, &session.key).await;
        }
        results.push(result);
    }
    if let Some(path) = runtime.archive_ledger_path.as_deref() {
        let _ledger_guard = runtime.archive_ledger_lock.lock().await;
        if let Err(error) = remove_archive_times(path, &deleted_keys) {
            for result in results.iter_mut().filter(|result| result.success) {
                let summary = format!("Archive ledger cleanup failed: {error}");
                result.error = Some(match result.error.take() {
                    Some(existing) => format!("{existing}; {summary}"),
                    None => summary,
                });
            }
        }
    }
    let success_count = results.iter().filter(|result| result.success).count();
    Ok(PermanentlyDeleteManagedSessionResponse {
        failure_count: results.len() - success_count,
        success_count,
        results,
    })
}

async fn remove_session_from_runtime(runtime: &SessionManagerRuntime, key: &str) {
    if let Some(scan) = runtime.latest_scan.lock().await.as_mut() {
        scan.sessions.retain(|session| session.key != key);
        scan.files_by_key.remove(key);
    }
    for scan in runtime.scans.lock().await.values_mut() {
        scan.sessions.retain(|session| session.key != key);
        scan.files_by_key.remove(key);
    }
    runtime.confirmed_archive_times.lock().await.remove(key);
}

impl SessionManagerRuntime {
    pub(crate) fn with_storage_dir(storage_dir: &Path) -> Self {
        Self {
            archive_ledger_path: Some(storage_dir.join("session-archive-ledger.json")),
            deletion_audit_path: Some(storage_dir.join("session-deletion-audit.jsonl")),
            cleanup_scheduler_path: Some(storage_dir.join("session-cleanup-scheduler.json")),
            cleanup_startup_pending: Arc::new(Mutex::new(true)),
            ..Self::default()
        }
    }

    pub(crate) fn deletion_audit_path(&self) -> Option<&Path> {
        self.deletion_audit_path.as_deref()
    }
}

async fn scan_cleanup_candidates(
    request: &ManagedSessionCleanupRequest,
    app_settings: &Mutex<AppSettings>,
    runtime: &SessionManagerRuntime,
) -> Result<Vec<ManagedSession>, String> {
    let sources = app_settings
        .lock()
        .await
        .session_sources
        .iter()
        .filter(|source| source.enabled)
        .cloned()
        .collect::<Vec<_>>();
    let mut scan = scan_session_sources(sources, 4).await;
    let now = current_time_ms();
    if let Some(path) = runtime.archive_ledger_path.as_deref() {
        let _ledger_guard = runtime.archive_ledger_lock.lock().await;
        apply_archive_ledger(&mut scan.sessions, path, now)?;
    }
    let protected_thread_ids = request
        .protected_thread_ids
        .iter()
        .map(|thread_id| thread_id.trim())
        .filter(|thread_id| !thread_id.is_empty())
        .map(str::to_string)
        .collect::<HashSet<_>>();
    cleanup_eligible_sessions(
        &scan.sessions,
        request.retention_days,
        now,
        &protected_thread_ids,
    )
}

pub(crate) async fn preview_managed_session_cleanup_core(
    request: ManagedSessionCleanupRequest,
    app_settings: &Mutex<AppSettings>,
    runtime: &SessionManagerRuntime,
) -> Result<ManagedSessionCleanupPreview, String> {
    let eligible = scan_cleanup_candidates(&request, app_settings, runtime).await?;
    Ok(ManagedSessionCleanupPreview {
        eligible_count: eligible.len(),
    })
}

pub(crate) async fn cleanup_managed_sessions_now_core(
    request: ManagedSessionCleanupRequest,
    app_settings: &Mutex<AppSettings>,
    runtime: &SessionManagerRuntime,
) -> Result<ManagedSessionCleanupResponse, String> {
    cleanup_managed_sessions_with_reason(request, app_settings, runtime, DeletionReason::Manual)
        .await
}

async fn cleanup_managed_sessions_with_reason(
    request: ManagedSessionCleanupRequest,
    app_settings: &Mutex<AppSettings>,
    runtime: &SessionManagerRuntime,
    reason: DeletionReason,
) -> Result<ManagedSessionCleanupResponse, String> {
    let eligible = scan_cleanup_candidates(&request, app_settings, runtime).await?;
    let mut results = Vec::with_capacity(eligible.len());
    for session in eligible {
        let archived_at = session
            .archived_at
            .ok_or_else(|| "Cleanup candidate is missing archive time".to_string())?;
        match permanently_delete_managed_session_with_reason(
            PermanentlyDeleteManagedSessionRequest {
                source_id: session.source_id.clone(),
                thread_id: session.thread_id.clone(),
                archived_at,
                cascade_requested: false,
            },
            app_settings,
            runtime,
            reason,
        )
        .await
        {
            Ok(response) => results.extend(response.results),
            Err(error) => results.push(PermanentlyDeleteManagedSessionResult {
                source_id: session.source_id,
                thread_id: session.thread_id,
                success: false,
                error: Some(error),
            }),
        }
    }
    let success_count = results.iter().filter(|result| result.success).count();
    Ok(ManagedSessionCleanupResponse {
        failure_count: results.len() - success_count,
        success_count,
        results,
    })
}

pub(crate) async fn run_managed_session_cleanup_scheduler_core(
    request: ManagedSessionCleanupSchedulerRequest,
    additional_protected_thread_ids: Vec<String>,
    app_settings: &Mutex<AppSettings>,
    runtime: &SessionManagerRuntime,
) -> Result<ManagedSessionCleanupSchedulerResponse, String> {
    let _scheduler_guard = runtime.cleanup_scheduler_lock.lock().await;
    let settings = app_settings.lock().await.clone();
    let Some(path) = runtime.cleanup_scheduler_path.as_deref() else {
        return Ok(ManagedSessionCleanupSchedulerResponse {
            ran: false,
            results: Vec::new(),
            success_count: 0,
            failure_count: 0,
        });
    };
    if !settings.auto_delete_archived_threads_enabled {
        *runtime.cleanup_startup_pending.lock().await = false;
    }
    let has_available_source = settings
        .session_sources
        .iter()
        .any(|source| source.enabled && Path::new(&source.codex_home_path).is_dir());
    if settings.auto_delete_archived_threads_enabled && !has_available_source {
        return Ok(ManagedSessionCleanupSchedulerResponse {
            ran: false,
            results: Vec::new(),
            success_count: 0,
            failure_count: 0,
        });
    }
    let startup = if settings.auto_delete_archived_threads_enabled {
        let mut startup_pending = runtime.cleanup_startup_pending.lock().await;
        let startup = *startup_pending;
        *startup_pending = false;
        startup
    } else {
        false
    };
    let now = current_time_ms();
    let should_run = prepare_scheduled_cleanup(
        path,
        settings.auto_delete_archived_threads_enabled,
        startup,
        now,
    )?;
    if !should_run {
        return Ok(ManagedSessionCleanupSchedulerResponse {
            ran: false,
            results: Vec::new(),
            success_count: 0,
            failure_count: 0,
        });
    }

    let mut protected_thread_ids = request.protected_thread_ids;
    protected_thread_ids.extend(additional_protected_thread_ids);
    let response = cleanup_managed_sessions_with_reason(
        ManagedSessionCleanupRequest {
            retention_days: settings.auto_delete_archived_threads_days,
            protected_thread_ids,
        },
        app_settings,
        runtime,
        DeletionReason::Automatic,
    )
    .await?;
    Ok(ManagedSessionCleanupSchedulerResponse {
        ran: true,
        results: response.results,
        success_count: response.success_count,
        failure_count: response.failure_count,
    })
}

pub(crate) async fn list_session_sources_core(
    app_settings: &Mutex<AppSettings>,
) -> Vec<SessionSource> {
    app_settings.lock().await.session_sources.clone()
}

pub(crate) async fn update_session_source_core(
    request: SessionSourceUpdateRequest,
    app_settings: &Mutex<AppSettings>,
    settings_path: &Path,
) -> Result<Vec<SessionSource>, String> {
    let mut settings = app_settings.lock().await.clone();
    match request.action.as_str() {
        "add" => {
            let path = request
                .path
                .as_deref()
                .map(Path::new)
                .ok_or_else(|| "Session source path is required".to_string())?;
            settings.session_sources = add_session_source(
                settings.session_sources,
                request.name.as_deref().unwrap_or_default(),
                path,
                current_time_ms(),
            )?;
        }
        "rename" => rename_session_source(
            &mut settings.session_sources,
            required_source_id(&request)?,
            request.name.as_deref().unwrap_or_default(),
        )?,
        "setEnabled" => set_session_source_enabled(
            &mut settings.session_sources,
            required_source_id(&request)?,
            request
                .enabled
                .ok_or_else(|| "Session source enabled state is required".to_string())?,
        )?,
        "remove" => {
            remove_session_source(&mut settings.session_sources, required_source_id(&request)?)?
        }
        _ => return Err("Unsupported session source action".to_string()),
    }
    write_settings(&settings_path.to_path_buf(), &settings)?;
    let sources = settings.session_sources.clone();
    *app_settings.lock().await = settings;
    Ok(sources)
}

pub(crate) async fn scan_managed_sessions_core(
    request: SessionScanRequest,
    app_settings: &Mutex<AppSettings>,
    runtime: &SessionManagerRuntime,
) -> Result<SessionScanSummary, String> {
    let request_id = request.request_id.trim().to_string();
    if request_id.is_empty() {
        return Err("Session scan request id is required".to_string());
    }
    let include_archived = request.include_archived.unwrap_or(true);
    runtime.cancelled_requests.lock().await.remove(&request_id);
    let requested_sources: HashSet<&str> = request.source_ids.iter().map(String::as_str).collect();
    let sources = app_settings
        .lock()
        .await
        .session_sources
        .iter()
        .filter(|source| {
            source.enabled
                && (requested_sources.is_empty() || requested_sources.contains(source.id.as_str()))
        })
        .cloned()
        .collect::<Vec<_>>();
    let source_ids = sources
        .iter()
        .map(|source| source.id.clone())
        .collect::<Vec<_>>();
    let mut source_generations = HashMap::with_capacity(source_ids.len());
    if include_archived {
        for source_id in &source_ids {
            source_generations.insert(
                source_id.clone(),
                reserve_source_generation(runtime, source_id).await,
            );
        }
    }
    let mut result = scan_session_sources_with_archive_mode(sources, 4, include_archived).await;
    let snapshot_result = result.clone();
    if let Some(path) = runtime.archive_ledger_path.as_deref() {
        let _ledger_guard = runtime.archive_ledger_lock.lock().await;
        apply_archive_ledger(&mut result.sessions, path, current_time_ms())?;
    }
    let confirmed_archive_times = runtime.confirmed_archive_times.lock().await.clone();
    for session in &mut result.sessions {
        if let Some(archived_at) = confirmed_archive_times.get(&session.key) {
            session.is_archived = true;
            session.archived_at = Some(*archived_at);
        }
    }
    let cancelled = runtime.cancelled_requests.lock().await.remove(&request_id);
    if cancelled {
        runtime.scans.lock().await.remove(&request_id);
        return Ok(SessionScanSummary {
            request_id,
            total_sessions: 0,
            diagnostic_count: result.diagnostics.len(),
            cancelled: true,
            source_snapshots: Vec::new(),
        });
    }
    let scanned_at = current_time_ms();
    let mut source_snapshots = Vec::with_capacity(source_ids.len());
    for source_id in source_ids {
        if !include_archived {
            continue;
        }
        let source_scan = SourceSessionScanResult {
            source_id: source_id.clone(),
            sessions: snapshot_result
                .sessions
                .iter()
                .filter(|session| session.source_id == source_id)
                .cloned()
                .collect(),
            diagnostics: snapshot_result
                .diagnostics
                .iter()
                .filter(|diagnostic| diagnostic.source_id == source_id)
                .cloned()
                .collect(),
            files_by_key: HashMap::new(),
        };
        let fingerprint = fingerprint_source_scan(&source_scan);
        let complete = source_scan.diagnostics.is_empty();
        source_snapshots.push(
            record_source_snapshot(
                runtime,
                &source_id,
                source_generations[&source_id],
                fingerprint,
                complete,
                scanned_at,
            )
            .await,
        );
    }
    let summary = SessionScanSummary {
        request_id: request_id.clone(),
        total_sessions: result.sessions.len(),
        diagnostic_count: result.diagnostics.len(),
        cancelled: false,
        source_snapshots,
    };
    if include_archived {
        *runtime.latest_scan.lock().await = Some(result.clone());
    }
    runtime.scans.lock().await.insert(request_id, result);
    Ok(summary)
}

pub(crate) async fn verify_session_threads_core(
    request: VerifySessionThreadsRequest,
    app_settings: &Mutex<AppSettings>,
    runtime: &SessionManagerRuntime,
) -> Result<VerifySessionThreadsResponse, String> {
    let source_id = request.source_id.trim();
    if source_id.is_empty() {
        return Err("Session source id is required".to_string());
    }
    if request.thread_ids.len() > MAX_VERIFY_THREAD_IDS {
        return Err(format!(
            "At most {MAX_VERIFY_THREAD_IDS} session thread ids can be verified at once"
        ));
    }
    let mut seen = HashSet::new();
    let thread_ids = request
        .thread_ids
        .iter()
        .map(|thread_id| thread_id.trim())
        .filter(|thread_id| !thread_id.is_empty())
        .filter(|thread_id| seen.insert((*thread_id).to_string()))
        .map(str::to_string)
        .collect::<Vec<_>>();
    if thread_ids.is_empty() {
        return Err("At least one session thread id is required".to_string());
    }

    let source = app_settings
        .lock()
        .await
        .session_sources
        .iter()
        .find(|source| source.id == source_id && source.enabled)
        .cloned()
        .ok_or_else(|| "Session source is unavailable".to_string())?;
    let generation = reserve_source_generation(runtime, source_id).await;
    let scan = tokio::task::spawn_blocking(move || scan_session_source(&source))
        .await
        .map_err(|error| error.to_string())?;
    let complete = scan.diagnostics.is_empty();
    let present_ids = scan
        .sessions
        .iter()
        .map(|session| session.thread_id.as_str())
        .collect::<HashSet<_>>();
    let threads = thread_ids
        .into_iter()
        .map(|thread_id| {
            let presence = if present_ids.contains(thread_id.as_str()) {
                SessionThreadPresence::Present
            } else if complete {
                SessionThreadPresence::Missing
            } else {
                SessionThreadPresence::Unknown
            };
            SessionThreadVerification {
                thread_id,
                presence,
            }
        })
        .collect();
    let snapshot = record_source_snapshot(
        runtime,
        source_id,
        generation,
        fingerprint_source_scan(&scan),
        complete,
        current_time_ms(),
    )
    .await;
    Ok(VerifySessionThreadsResponse {
        snapshot,
        threads,
        diagnostics: scan_diagnostics_dto(&scan),
    })
}

pub(crate) async fn fetch_managed_sessions_page_core(
    request: ManagedSessionPageRequest,
    runtime: &SessionManagerRuntime,
) -> Result<ManagedSessionPage, String> {
    let request_id = request.request_id.trim().to_string();
    let scans = runtime.scans.lock().await;
    let result = scans
        .get(&request_id)
        .ok_or_else(|| "Session scan result not found".to_string())?;
    let limit = request.limit.clamp(1, MAX_PAGE_LIMIT);
    let offset = request.offset.min(result.sessions.len());
    let end = offset.saturating_add(limit).min(result.sessions.len());
    let diagnostics = if offset == 0 {
        result
            .diagnostics
            .iter()
            .map(|diagnostic| SessionScanDiagnosticDto {
                source_id: diagnostic.source_id.clone(),
                path: diagnostic
                    .path
                    .as_ref()
                    .map(|path| path.to_string_lossy().to_string()),
                error: diagnostic.error.clone(),
            })
            .collect()
    } else {
        Vec::new()
    };
    Ok(ManagedSessionPage {
        request_id,
        items: result.sessions[offset..end].to_vec(),
        diagnostics,
        total: result.sessions.len(),
        next_offset: (end < result.sessions.len()).then_some(end),
    })
}

pub(crate) async fn search_managed_sessions_core(
    request: SessionSearchRequest,
    runtime: &SessionManagerRuntime,
) -> Result<SessionSearchProgress, String> {
    let request_id = request.request_id.trim().to_string();
    if request_id.is_empty() {
        return Err("Session search request id is required".to_string());
    }
    if request.query.trim().chars().count() < 2 {
        return Err("Session search query must contain at least two characters".to_string());
    }
    runtime.cancelled_requests.lock().await.remove(&request_id);
    let scan = runtime
        .latest_scan
        .lock()
        .await
        .clone()
        .ok_or_else(|| "Session scan result not found".to_string())?;
    let source_ids = scan
        .sessions
        .iter()
        .filter(|session| {
            request.source_ids.is_empty() || request.source_ids.contains(&session.source_id)
        })
        .map(|session| session.source_id.clone())
        .collect::<HashSet<_>>();
    let total_sources = source_ids.len();
    let total_files = scan
        .files_by_key
        .keys()
        .filter(|key| {
            scan.sessions
                .iter()
                .any(|session| &session.key == *key && source_ids.contains(&session.source_id))
        })
        .count();
    let initial = SessionSearchProgress {
        request_id: request_id.clone(),
        scanned_sources: 0,
        total_sources,
        scanned_files: 0,
        total_files: Some(total_files),
        completed: false,
        cancelled: false,
        incomplete: false,
    };
    runtime
        .searches
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .insert(
            request_id.clone(),
            SessionSearchResponse {
                results: Vec::new(),
                progress: initial.clone(),
            },
        );

    let cancelled_requests = runtime.cancelled_requests.clone();
    let cache = runtime.search_cache.clone();
    let searches = runtime.searches.clone();
    let request_id_for_search = request_id.clone();
    tokio::task::spawn_blocking(move || {
        let mut cache = cache.lock().unwrap_or_else(|error| error.into_inner());
        let mut scanned_source_ids = HashSet::new();
        let (_, incomplete, scanned_files) = search_scan_results(
            &scan,
            &request,
            &mut cache,
            || {
                cancelled_requests
                    .blocking_lock()
                    .contains(&request_id_for_search)
            },
            |result, source_id, scanned_files, incomplete| {
                scanned_source_ids.insert(source_id.to_string());
                let mut searches = searches.lock().unwrap_or_else(|error| error.into_inner());
                if let Some(snapshot) = searches.get_mut(&request_id_for_search) {
                    if let Some(result) = result {
                        snapshot.results.push(result.clone());
                    }
                    snapshot.progress.scanned_sources = scanned_source_ids.len();
                    snapshot.progress.scanned_files = scanned_files;
                    snapshot.progress.incomplete |= incomplete;
                }
            },
        );
        let cancelled = cancelled_requests
            .blocking_lock()
            .remove(&request_id_for_search);
        let mut searches = searches.lock().unwrap_or_else(|error| error.into_inner());
        if let Some(snapshot) = searches.get_mut(&request_id_for_search) {
            snapshot.progress.scanned_sources = scanned_source_ids.len();
            snapshot.progress.scanned_files = scanned_files;
            snapshot.progress.completed = !cancelled;
            snapshot.progress.cancelled = cancelled;
            snapshot.progress.incomplete |= incomplete;
        }
    });
    Ok(initial)
}

pub(crate) fn fetch_session_search_results_core(
    request_id: String,
    runtime: &SessionManagerRuntime,
) -> Result<SessionSearchResponse, String> {
    runtime
        .searches
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .get(request_id.trim())
        .cloned()
        .ok_or_else(|| "Session search result not found".to_string())
}
pub(crate) async fn cancel_session_task_core(
    request_id: String,
    runtime: &SessionManagerRuntime,
) -> Result<(), String> {
    let request_id = request_id.trim().to_string();
    if request_id.is_empty() {
        return Err("Session task request id is required".to_string());
    }
    let completed_scan_removed = runtime.scans.lock().await.remove(&request_id).is_some();
    if !completed_scan_removed {
        runtime.cancelled_requests.lock().await.insert(request_id);
    }
    Ok(())
}

pub(crate) async fn resolve_managed_session_core(
    source_id: &str,
    thread_id: &str,
    app_settings: &Mutex<AppSettings>,
    runtime: &SessionManagerRuntime,
) -> Result<(SessionSource, ManagedSession), String> {
    resolve_indexed_managed_session(source_id, thread_id, app_settings, runtime, true).await
}

pub(crate) async fn fetch_managed_session_preview_core(
    request: crate::types::ManagedSessionPreviewRequest,
    app_settings: &Mutex<AppSettings>,
    runtime: &SessionManagerRuntime,
) -> Result<crate::types::ManagedSessionPreviewResponse, String> {
    let (_, session) = resolve_indexed_managed_session(
        &request.source_id,
        &request.thread_id,
        app_settings,
        runtime,
        false,
    )
    .await?;
    let path = runtime
        .latest_scan
        .lock()
        .await
        .as_ref()
        .and_then(|scan| scan.files_by_key.get(&session.key))
        .map(|file| file.path.clone())
        .ok_or_else(|| "Managed session preview file is unavailable".to_string())?;
    let full = request.full;
    let limit = request.limit.clamp(1, 12);
    let preview = tokio::task::spawn_blocking(move || {
        if full {
            crate::shared::session_manager_core::preview::read_session_conversation(&path)
        } else {
            crate::shared::session_manager_core::preview::read_session_conversation_preview(
                &path, limit,
            )
        }
    })
    .await
    .map_err(|error| format!("Managed session preview task failed: {error}"))??;
    Ok(crate::types::ManagedSessionPreviewResponse {
        opening_message: preview.opening_message,
        items: preview.items,
        incomplete: preview.incomplete,
    })
}

async fn resolve_indexed_managed_session(
    source_id: &str,
    thread_id: &str,
    app_settings: &Mutex<AppSettings>,
    runtime: &SessionManagerRuntime,
    require_project: bool,
) -> Result<(SessionSource, ManagedSession), String> {
    let source_id = source_id.trim();
    let thread_id = thread_id.trim();
    if source_id.is_empty() || thread_id.is_empty() {
        return Err("Session source and thread id are required".to_string());
    }
    let source = app_settings
        .lock()
        .await
        .session_sources
        .iter()
        .find(|source| source.id == source_id && source.enabled)
        .cloned()
        .ok_or_else(|| "Session source is unavailable".to_string())?;
    let scan =
        runtime.latest_scan.lock().await.clone().ok_or_else(|| {
            "Session index is not available; refresh the manager first".to_string()
        })?;
    let session = scan
        .sessions
        .into_iter()
        .find(|session| session.source_id == source_id && session.thread_id == thread_id)
        .ok_or_else(|| "Managed session was not found in the verified index".to_string())?;
    if session.file_confidence != crate::types::SessionFileConfidence::Exact {
        return Err("Managed session does not have an exact verified mapping".to_string());
    }
    if require_project {
        let cwd = session
            .cwd
            .as_deref()
            .map(str::trim)
            .filter(|cwd| !cwd.is_empty())
            .ok_or_else(|| "Managed session has no project path".to_string())?;
        if !Path::new(cwd).is_dir() {
            return Err("Managed session project path is unavailable".to_string());
        }
    }
    Ok((source, session))
}

pub(crate) async fn archive_managed_sessions_core<F, Fut>(
    request: ArchiveManagedSessionsRequest,
    app_settings: &Mutex<AppSettings>,
    runtime: &SessionManagerRuntime,
    mut archive_session: F,
) -> Result<ArchiveManagedSessionsResponse, String>
where
    F: FnMut(SessionSource, ManagedSession) -> Fut,
    Fut: Future<Output = Result<(), String>>,
{
    if request.items.is_empty() {
        return Err("At least one managed session is required".to_string());
    }
    if request.items.len() > MAX_PAGE_LIMIT {
        return Err(format!(
            "Cannot archive more than {MAX_PAGE_LIMIT} sessions at once"
        ));
    }
    let mut seen = HashSet::new();
    let mut results = Vec::with_capacity(request.items.len());
    for item in request.items {
        let source_id = item.source_id.trim().to_string();
        let thread_id = item.thread_id.trim().to_string();
        let item_key = format!("{source_id}:{thread_id}");
        let outcome = if !seen.insert(item_key.clone()) {
            Err("Duplicate managed session request".to_string())
        } else {
            match resolve_indexed_managed_session(
                &source_id,
                &thread_id,
                app_settings,
                runtime,
                false,
            )
            .await
            {
                Ok((_source, managed)) if managed.is_archived => {
                    Err("Managed session is already archived".to_string())
                }
                Ok((source, managed)) => archive_session(source, managed).await,
                Err(error) => Err(error),
            }
        };
        match outcome {
            Ok(()) => {
                let archived_at = current_time_ms();
                record_confirmed_archive(runtime, &source_id, &thread_id, &item_key, archived_at)
                    .await;
                results.push(ArchiveManagedSessionResult {
                    source_id,
                    thread_id,
                    success: true,
                    archived_at: Some(archived_at),
                    error: None,
                });
            }
            Err(error) => results.push(ArchiveManagedSessionResult {
                source_id,
                thread_id,
                success: false,
                archived_at: None,
                error: Some(error),
            }),
        }
    }
    let success_count = results.iter().filter(|result| result.success).count();
    Ok(ArchiveManagedSessionsResponse {
        failure_count: results.len() - success_count,
        success_count,
        results,
    })
}

pub(crate) async fn prepare_managed_session_derivation_core(
    request: PrepareManagedSessionDerivationRequest,
    app_settings: &Mutex<AppSettings>,
    runtime: &SessionManagerRuntime,
) -> Result<ManagedSessionDerivationPreview, String> {
    let (source, session) = resolve_indexed_managed_session(
        &request.source_id,
        &request.thread_id,
        app_settings,
        runtime,
        false,
    )
    .await?;
    let file = runtime
        .latest_scan
        .lock()
        .await
        .as_ref()
        .and_then(|scan| scan.files_by_key.get(&session.key))
        .cloned()
        .ok_or_else(|| "Managed session does not have an exact verified file".to_string())?;
    let content = build_session_derivation_content(
        &file.path,
        &session.title,
        &session.key,
        session.cwd.as_deref(),
    )?;
    Ok(ManagedSessionDerivationPreview {
        source_session_key: session.key.clone(),
        source_session: session,
        source_name: source.name,
        handoff_content: content.handoff_content,
        user_message_count: content.user_message_count,
        agent_reply_count: content.agent_reply_count,
        incomplete: content.incomplete,
    })
}

async fn record_confirmed_archive(
    runtime: &SessionManagerRuntime,
    source_id: &str,
    thread_id: &str,
    key: &str,
    archived_at: i64,
) {
    if let Some(path) = runtime.archive_ledger_path.as_deref() {
        let _ledger_guard = runtime.archive_ledger_lock.lock().await;
        if let Err(error) = record_confirmed_archive_time(path, source_id, thread_id, archived_at) {
            eprintln!("Failed to persist confirmed session archive time: {error}");
        }
    }
    runtime
        .confirmed_archive_times
        .lock()
        .await
        .insert(key.to_string(), archived_at);
    if let Some(scan) = runtime.latest_scan.lock().await.as_mut() {
        mark_scan_session_archived(scan, key, archived_at);
    }
    for scan in runtime.scans.lock().await.values_mut() {
        mark_scan_session_archived(scan, key, archived_at);
    }
}

fn mark_scan_session_archived(
    scan: &mut MultiSourceSessionScanResult,
    key: &str,
    archived_at: i64,
) {
    if let Some(session) = scan.sessions.iter_mut().find(|session| session.key == key) {
        session.is_archived = true;
        session.archived_at = Some(archived_at);
    }
}

fn required_source_id(request: &SessionSourceUpdateRequest) -> Result<&str, String> {
    request
        .source_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Session source id is required".to_string())
}

fn current_time_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::io::Write;
    use std::sync::{Arc, Mutex as StdMutex};

    use tokio::sync::Mutex;
    use uuid::Uuid;

    use super::{
        archive_managed_sessions_core, cancel_session_task_core, cleanup_managed_sessions_now_core,
        execute_delete_steps, fetch_managed_session_preview_core, fetch_managed_sessions_page_core,
        fetch_session_search_results_core, permanently_delete_managed_session_core,
        prepare_managed_session_derivation_core, preview_managed_session_cleanup_core,
        resolve_managed_session_core, run_managed_session_cleanup_scheduler_core,
        scan_managed_sessions_core, search_managed_sessions_core, update_session_source_core,
        verify_session_threads_core, SessionManagerRuntime,
    };
    use crate::shared::attachment_storage_core::session_attachment_dir;
    use crate::shared::session_manager_core::ledger::{
        read_archive_ledger, record_confirmed_archive_time, ArchiveTimeSource,
    };
    use crate::types::{
        AppSettings, ArchiveManagedSessionItem, ArchiveManagedSessionsRequest,
        ManagedSessionCleanupRequest, ManagedSessionCleanupSchedulerRequest,
        ManagedSessionPageRequest, ManagedSessionPreviewRequest,
        PermanentlyDeleteManagedSessionRequest, PrepareManagedSessionDerivationRequest,
        SessionScanRequest, SessionSearchRequest, SessionSourceUpdateRequest,
        SessionThreadPresence, VerifySessionThreadsRequest,
    };

    #[test]
    fn verifies_bounded_thread_presence_with_stable_source_generations() {
        let runtime_executor = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime_executor.block_on(async {
            let root = std::env::temp_dir().join(format!(
                "codex-monitor-source-verification-{}",
                Uuid::new_v4()
            ));
            let codex_home = root.join("codex-home");
            let sessions = codex_home.join("sessions");
            fs::create_dir_all(&sessions).unwrap();
            let session_path = sessions.join("rollout-thread-present.jsonl");
            fs::write(
                &session_path,
                "{\"type\":\"session_meta\",\"payload\":{\"id\":\"thread-present\"}}\n",
            )
            .unwrap();
            let settings = Mutex::new(AppSettings::default());
            let sources = update_session_source_core(
                SessionSourceUpdateRequest {
                    action: "add".to_string(),
                    source_id: None,
                    name: Some("Fixture".to_string()),
                    path: Some(codex_home.to_string_lossy().to_string()),
                    enabled: None,
                },
                &settings,
                &root.join("settings.json"),
            )
            .await
            .unwrap();
            let runtime = SessionManagerRuntime::default();
            let request = VerifySessionThreadsRequest {
                source_id: sources[0].id.clone(),
                thread_ids: vec!["thread-present".to_string(), "thread-missing".to_string()],
            };

            let first = verify_session_threads_core(request.clone(), &settings, &runtime)
                .await
                .unwrap();
            assert!(first.snapshot.complete);
            assert_eq!(first.snapshot.generation, 1);
            assert_eq!(first.threads[0].presence, SessionThreadPresence::Present);
            assert_eq!(first.threads[1].presence, SessionThreadPresence::Missing);

            let unchanged = verify_session_threads_core(request.clone(), &settings, &runtime)
                .await
                .unwrap();
            assert_eq!(unchanged.snapshot.generation, 2);
            assert_eq!(unchanged.snapshot.fingerprint, first.snapshot.fingerprint);

            fs::remove_file(&session_path).unwrap();
            let deleted = verify_session_threads_core(request, &settings, &runtime)
                .await
                .unwrap();
            assert_eq!(deleted.snapshot.generation, 3);
            assert_ne!(deleted.snapshot.fingerprint, first.snapshot.fingerprint);
            assert!(deleted
                .threads
                .iter()
                .all(|thread| thread.presence == SessionThreadPresence::Missing));

            let _ = fs::remove_dir_all(root);
        });
    }

    #[test]
    fn late_source_snapshot_cannot_replace_a_newer_generation() {
        let runtime_executor = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime_executor.block_on(async {
            let runtime = SessionManagerRuntime::default();
            let older = super::reserve_source_generation(&runtime, "source-a").await;
            let newer = super::reserve_source_generation(&runtime, "source-a").await;

            super::record_source_snapshot(
                &runtime,
                "source-a",
                newer,
                "newer".to_string(),
                true,
                20,
            )
            .await;
            super::record_source_snapshot(
                &runtime,
                "source-a",
                older,
                "older".to_string(),
                true,
                10,
            )
            .await;

            let snapshots = runtime.source_snapshots.lock().await;
            assert_eq!(snapshots["source-a"].generation, newer);
            assert_eq!(snapshots["source-a"].fingerprint, "newer");
        });
    }

    #[test]
    fn reports_unknown_instead_of_missing_when_source_scan_is_incomplete() {
        let runtime_executor = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime_executor.block_on(async {
            let root = std::env::temp_dir().join(format!(
                "codex-monitor-source-verification-missing-{}",
                Uuid::new_v4()
            ));
            fs::create_dir_all(&root).unwrap();
            let settings = Mutex::new(AppSettings::default());
            let sources = update_session_source_core(
                SessionSourceUpdateRequest {
                    action: "add".to_string(),
                    source_id: None,
                    name: Some("Missing".to_string()),
                    path: Some(root.join("missing-home").to_string_lossy().to_string()),
                    enabled: None,
                },
                &settings,
                &root.join("settings.json"),
            )
            .await
            .unwrap();

            let response = verify_session_threads_core(
                VerifySessionThreadsRequest {
                    source_id: sources[0].id.clone(),
                    thread_ids: vec!["thread-a".to_string()],
                },
                &settings,
                &SessionManagerRuntime::default(),
            )
            .await
            .unwrap();

            assert!(!response.snapshot.complete);
            assert_eq!(response.threads[0].presence, SessionThreadPresence::Unknown);
            assert!(!response.diagnostics.is_empty());
            let _ = fs::remove_dir_all(root);
        });
    }

    #[test]
    fn previews_and_immediately_cleans_expired_archives() {
        let runtime_executor = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime_executor.block_on(async {
            let root =
                std::env::temp_dir().join(format!("codex-monitor-cleanup-now-{}", Uuid::new_v4()));
            let codex_home = root.join("codex-home");
            let archived = codex_home.join("archived_sessions");
            fs::create_dir_all(&archived).unwrap();
            let session_path = archived.join("rollout-thread-expired.jsonl");
            fs::write(
                &session_path,
                "{\"type\":\"session_meta\",\"payload\":{\"id\":\"thread-expired\"}}\n",
            )
            .unwrap();
            let settings = Mutex::new(AppSettings::default());
            let sources = update_session_source_core(
                SessionSourceUpdateRequest {
                    action: "add".to_string(),
                    source_id: None,
                    name: Some("Fixture".to_string()),
                    path: Some(codex_home.to_string_lossy().to_string()),
                    enabled: None,
                },
                &settings,
                &root.join("settings.json"),
            )
            .await
            .unwrap();
            let runtime = SessionManagerRuntime::with_storage_dir(&root);
            let archived_at = super::current_time_ms() - 31 * 24 * 60 * 60 * 1000;
            record_confirmed_archive_time(
                &root.join("session-archive-ledger.json"),
                &sources[0].id,
                "thread-expired",
                archived_at,
            )
            .unwrap();
            let attachment_dir = session_attachment_dir(&codex_home, "thread-expired").unwrap();
            fs::create_dir_all(&attachment_dir).unwrap();
            fs::write(attachment_dir.join("image.png"), b"image").unwrap();
            let request = ManagedSessionCleanupRequest {
                retention_days: 30,
                protected_thread_ids: vec![],
            };

            let preview =
                preview_managed_session_cleanup_core(request.clone(), &settings, &runtime)
                    .await
                    .unwrap();
            assert_eq!(preview.eligible_count, 1);

            let response = cleanup_managed_sessions_now_core(request, &settings, &runtime)
                .await
                .unwrap();
            assert_eq!(response.success_count, 1);
            assert_eq!(response.failure_count, 0);
            assert!(!session_path.exists());
            assert!(!attachment_dir.exists());
            let _ = fs::remove_dir_all(root);
        });
    }

    #[test]
    fn scheduled_cleanup_uses_automatic_audit_reason() {
        let runtime_executor = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime_executor.block_on(async {
            let root = std::env::temp_dir().join(format!(
                "codex-monitor-scheduled-cleanup-{}",
                Uuid::new_v4()
            ));
            let codex_home = root.join("codex-home");
            let archived = codex_home.join("archived_sessions");
            fs::create_dir_all(&archived).unwrap();
            let session_path = archived.join("rollout-thread-expired.jsonl");
            fs::write(
                &session_path,
                "{\"type\":\"session_meta\",\"payload\":{\"id\":\"thread-expired\"}}\n",
            )
            .unwrap();
            let mut initial_settings = AppSettings::default();
            initial_settings.auto_delete_archived_threads_enabled = true;
            initial_settings.auto_delete_archived_threads_days = 30;
            let settings = Mutex::new(initial_settings);
            let sources = update_session_source_core(
                SessionSourceUpdateRequest {
                    action: "add".to_string(),
                    source_id: None,
                    name: Some("Fixture".to_string()),
                    path: Some(codex_home.to_string_lossy().to_string()),
                    enabled: None,
                },
                &settings,
                &root.join("settings.json"),
            )
            .await
            .unwrap();
            let runtime = SessionManagerRuntime::with_storage_dir(&root);
            record_confirmed_archive_time(
                &root.join("session-archive-ledger.json"),
                &sources[0].id,
                "thread-expired",
                super::current_time_ms() - 31 * 24 * 60 * 60 * 1000,
            )
            .unwrap();

            let response = run_managed_session_cleanup_scheduler_core(
                ManagedSessionCleanupSchedulerRequest {
                    protected_thread_ids: vec![],
                },
                vec![],
                &settings,
                &runtime,
            )
            .await
            .unwrap();

            assert!(response.ran);
            assert_eq!(response.success_count, 1);
            assert!(!session_path.exists());
            let audit = fs::read_to_string(root.join("session-deletion-audit.jsonl")).unwrap();
            assert!(audit.contains("\"reason\":\"automatic\""));
            let _ = fs::remove_dir_all(root);
        });
    }

    #[test]
    fn scheduled_cleanup_waits_for_an_available_source() {
        let runtime_executor = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime_executor.block_on(async {
            let root = std::env::temp_dir().join(format!(
                "codex-monitor-scheduled-cleanup-unavailable-{}",
                Uuid::new_v4()
            ));
            let mut initial_settings = AppSettings::default();
            initial_settings.auto_delete_archived_threads_enabled = true;
            let settings = Mutex::new(initial_settings);
            let runtime = SessionManagerRuntime::with_storage_dir(&root);

            let response = run_managed_session_cleanup_scheduler_core(
                ManagedSessionCleanupSchedulerRequest {
                    protected_thread_ids: vec![],
                },
                vec![],
                &settings,
                &runtime,
            )
            .await
            .unwrap();

            assert!(!response.ran);
            assert!(!root.join("session-cleanup-scheduler.json").exists());
            let _ = fs::remove_dir_all(root);
        });
    }

    #[test]
    fn enabling_during_the_same_process_does_not_use_startup_cleanup() {
        let runtime_executor = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime_executor.block_on(async {
            let root = std::env::temp_dir().join(format!(
                "codex-monitor-scheduled-cleanup-enable-{}",
                Uuid::new_v4()
            ));
            let codex_home = root.join("codex-home");
            fs::create_dir_all(&codex_home).unwrap();
            let settings = Mutex::new(AppSettings::default());
            let runtime = SessionManagerRuntime::with_storage_dir(&root);

            let disabled = run_managed_session_cleanup_scheduler_core(
                ManagedSessionCleanupSchedulerRequest {
                    protected_thread_ids: vec![],
                },
                vec![],
                &settings,
                &runtime,
            )
            .await
            .unwrap();
            assert!(!disabled.ran);

            settings.lock().await.auto_delete_archived_threads_enabled = true;
            update_session_source_core(
                SessionSourceUpdateRequest {
                    action: "add".to_string(),
                    source_id: None,
                    name: Some("Fixture".to_string()),
                    path: Some(codex_home.to_string_lossy().to_string()),
                    enabled: None,
                },
                &settings,
                &root.join("settings.json"),
            )
            .await
            .unwrap();

            let enabled = run_managed_session_cleanup_scheduler_core(
                ManagedSessionCleanupSchedulerRequest {
                    protected_thread_ids: vec![],
                },
                vec![],
                &settings,
                &runtime,
            )
            .await
            .unwrap();
            assert!(!enabled.ran);
            let _ = fs::remove_dir_all(root);
        });
    }

    #[test]
    fn session_delete_failure_never_runs_attachment_cleanup() {
        let attachment_cleanup_called = Arc::new(StdMutex::new(false));
        let called = attachment_cleanup_called.clone();
        let outcome = execute_delete_steps(
            || Err("session delete failed".to_string()),
            move || {
                *called.lock().unwrap() = true;
                Ok(())
            },
        );
        assert!(!outcome.success);
        assert_eq!(outcome.error.as_deref(), Some("session delete failed"));
        assert!(!*attachment_cleanup_called.lock().unwrap());
    }

    #[test]
    fn attachment_cleanup_failure_is_a_success_warning() {
        let outcome = execute_delete_steps(|| Ok(()), || Err("directory is locked".to_string()));
        assert!(outcome.success);
        assert_eq!(
            outcome.error.as_deref(),
            Some("Session attachment cleanup failed: directory is locked")
        );
    }

    #[test]
    fn permanent_delete_removes_source_bound_session_attachments() {
        let runtime_executor = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime_executor.block_on(async {
            let root = std::env::temp_dir().join(format!(
                "codex-monitor-delete-attachments-{}",
                Uuid::new_v4()
            ));
            let codex_home = root.join("codex-home");
            let archived = codex_home.join("archived_sessions");
            fs::create_dir_all(&archived).unwrap();
            fs::write(
                archived.join("rollout-thread-a.jsonl"),
                "{\"type\":\"session_meta\",\"payload\":{\"id\":\"thread-a\"}}\n",
            )
            .unwrap();
            let settings = Mutex::new(AppSettings::default());
            let sources = update_session_source_core(
                SessionSourceUpdateRequest {
                    action: "add".to_string(),
                    source_id: None,
                    name: Some("Fixture".to_string()),
                    path: Some(codex_home.to_string_lossy().to_string()),
                    enabled: None,
                },
                &settings,
                &root.join("settings.json"),
            )
            .await
            .unwrap();
            let runtime = SessionManagerRuntime::with_storage_dir(&root);
            scan_managed_sessions_core(
                SessionScanRequest {
                    request_id: "delete-attachment-scan".to_string(),
                    source_ids: vec![sources[0].id.clone()],
                    include_archived: None,
                },
                &settings,
                &runtime,
            )
            .await
            .unwrap();
            let page = fetch_managed_sessions_page_core(
                ManagedSessionPageRequest {
                    request_id: "delete-attachment-scan".to_string(),
                    offset: 0,
                    limit: 10,
                },
                &runtime,
            )
            .await
            .unwrap();
            let session = page
                .items
                .iter()
                .find(|session| session.thread_id == "thread-a")
                .unwrap();
            let attachment_dir = session_attachment_dir(&codex_home, "thread-a").unwrap();
            let other_dir = session_attachment_dir(&codex_home, "thread-b").unwrap();
            fs::create_dir_all(&attachment_dir).unwrap();
            fs::create_dir_all(&other_dir).unwrap();
            fs::write(attachment_dir.join("image.png"), b"a").unwrap();
            fs::write(other_dir.join("image.png"), b"b").unwrap();

            let response = permanently_delete_managed_session_core(
                PermanentlyDeleteManagedSessionRequest {
                    source_id: sources[0].id.clone(),
                    thread_id: "thread-a".to_string(),
                    archived_at: session.archived_at.unwrap(),
                    cascade_requested: false,
                },
                &settings,
                &runtime,
            )
            .await
            .unwrap();

            assert_eq!(response.success_count, 1);
            assert_eq!(response.failure_count, 0);
            assert!(!archived.join("rollout-thread-a.jsonl").exists());
            assert!(!attachment_dir.exists());
            assert!(other_dir.join("image.png").exists());
            let audit = fs::read_to_string(root.join("session-deletion-audit.jsonl")).unwrap();
            assert!(audit.contains("\"result\":\"success\""));
            assert!(audit.contains("\"errorSummary\":null"));
            let _ = fs::remove_dir_all(root);
        });
    }

    #[test]
    fn updates_sources_and_pages_scan_results() {
        let runtime_executor = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime_executor.block_on(async {
            let root =
                std::env::temp_dir().join(format!("codex-monitor-service-{}", Uuid::new_v4()));
            let settings_path = root.join("settings.json");
            let session_path = root
                .join("codex-home")
                .join("sessions")
                .join("2026")
                .join("07")
                .join("10");
            fs::create_dir_all(&session_path).unwrap();
            fs::write(
                session_path.join("rollout-thread-a.jsonl"),
                "{\"type\":\"session_meta\",\"payload\":{\"id\":\"thread-a\"}}\n{\"type\":\"event_msg\",\"payload\":{\"type\":\"agent_message\",\"message\":\"final needle\",\"phase\":\"final_answer\"}}\n",
            )
            .unwrap();
            let settings = Mutex::new(AppSettings::default());
            let runtime = SessionManagerRuntime::default();
            let sources = update_session_source_core(
                SessionSourceUpdateRequest {
                    action: "add".to_string(),
                    source_id: None,
                    name: Some("Fixture".to_string()),
                    path: Some(root.join("codex-home").to_string_lossy().to_string()),
                    enabled: None,
                },
                &settings,
                &settings_path,
            )
            .await
            .unwrap();

            let summary = scan_managed_sessions_core(
                SessionScanRequest {
                    request_id: "scan-a".to_string(),
                    source_ids: vec![sources[0].id.clone()],
                    include_archived: None,
                },
                &settings,
                &runtime,
            )
            .await
            .unwrap();
            assert_eq!(summary.total_sessions, 1);
            assert_eq!(summary.source_snapshots.len(), 1);
            assert_eq!(summary.source_snapshots[0].source_id, sources[0].id);
            assert_eq!(summary.source_snapshots[0].generation, 1);
            assert!(summary.source_snapshots[0].complete);
            assert!(!summary.source_snapshots[0].fingerprint.is_empty());
            let page = fetch_managed_sessions_page_core(
                ManagedSessionPageRequest {
                    request_id: "scan-a".to_string(),
                    offset: 0,
                    limit: 1,
                },
                &runtime,
            )
            .await
            .unwrap();
            assert_eq!(page.items[0].thread_id, "thread-a");
            let derivation = prepare_managed_session_derivation_core(
                PrepareManagedSessionDerivationRequest {
                    source_id: sources[0].id.clone(),
                    thread_id: "thread-a".to_string(),
                },
                &settings,
                &runtime,
            )
            .await
            .unwrap();
            assert_eq!(derivation.source_session_key, page.items[0].key);
            assert_eq!(derivation.agent_reply_count, 1);
            assert!(derivation.handoff_content.contains("final needle"));
            search_managed_sessions_core(
                SessionSearchRequest {
                    request_id: "search-a".to_string(),
                    query: "needle".to_string(),
                    source_ids: vec![],
                    include_archived: true,
                    include_subagents: true,
                },
                &runtime,
            )
            .await
            .unwrap();
            let search = loop {
                let snapshot = fetch_session_search_results_core(
                    "search-a".to_string(),
                    &runtime,
                )
                .unwrap();
                if snapshot.progress.completed {
                    break snapshot;
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            };
            assert_eq!(search.results.len(), 1);
            let rollout_path = session_path.join("rollout-thread-a.jsonl");
            let mut rollout = fs::OpenOptions::new().append(true).open(&rollout_path).unwrap();
            for index in 0..13 {
                writeln!(
                    rollout,
                    "{{\"type\":\"event_msg\",\"payload\":{{\"type\":\"agent_message\",\"message\":\"extra {index}\",\"phase\":\"final_answer\"}}}}"
                )
                .unwrap();
            }
            drop(rollout);
            let full = fetch_managed_session_preview_core(
                ManagedSessionPreviewRequest {
                    source_id: sources[0].id.clone(),
                    thread_id: "thread-a".to_string(),
                    limit: 6,
                    full: true,
                },
                &settings,
                &runtime,
            )
            .await
            .unwrap();
            let limited = fetch_managed_session_preview_core(
                ManagedSessionPreviewRequest {
                    source_id: sources[0].id.clone(),
                    thread_id: "thread-a".to_string(),
                    limit: 6,
                    full: false,
                },
                &settings,
                &runtime,
            )
            .await
            .unwrap();
            assert_eq!(full.items.len(), 14);
            assert_eq!(limited.items.len(), 6);
            cancel_session_task_core("scan-a".to_string(), &runtime)
                .await
                .unwrap();
            assert!(!runtime.cancelled_requests.lock().await.contains("scan-a"));
            assert!(fetch_managed_sessions_page_core(
                ManagedSessionPageRequest {
                    request_id: "scan-a".to_string(),
                    offset: 0,
                    limit: 1,
                },
                &runtime,
            )
            .await
            .is_err());
            let _ = fs::remove_dir_all(root);
        });
    }

    #[test]
    fn resolves_only_verified_sessions_with_available_projects() {
        let runtime_executor = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime_executor.block_on(async {
            let root = std::env::temp_dir().join(format!("codex-monitor-resume-{}", Uuid::new_v4()));
            let project = root.join("project");
            let session_path = root.join("codex-home").join("sessions").join("2026").join("07").join("10");
            fs::create_dir_all(&project).unwrap();
            fs::create_dir_all(&session_path).unwrap();
            let cwd = serde_json::to_string(&project.to_string_lossy()).unwrap();
            fs::write(
                session_path.join("rollout-thread-resume.jsonl"),
                format!("{{\"type\":\"session_meta\",\"payload\":{{\"id\":\"thread-resume\",\"cwd\":{cwd}}}}}\n"),
            ).unwrap();
            let settings_path = root.join("settings.json");
            let settings = Mutex::new(AppSettings::default());
            let runtime = SessionManagerRuntime::default();
            let sources = update_session_source_core(
                SessionSourceUpdateRequest { action: "add".to_string(), source_id: None, name: Some("Resume".to_string()), path: Some(root.join("codex-home").to_string_lossy().to_string()), enabled: None },
                &settings,
                &settings_path,
            ).await.unwrap();
            scan_managed_sessions_core(
                SessionScanRequest { request_id: "resume-scan".to_string(), source_ids: vec![sources[0].id.clone()], include_archived: None },
                &settings,
                &runtime,
            ).await.unwrap();
            let (_, session) = resolve_managed_session_core(&sources[0].id, "thread-resume", &settings, &runtime).await.unwrap();
            assert_eq!(session.cwd.as_deref(), project.to_str());
            fs::remove_dir_all(&project).unwrap();
            assert!(resolve_managed_session_core(&sources[0].id, "thread-resume", &settings, &runtime).await.is_err());
            let _ = fs::remove_dir_all(root);
        });
    }

    #[test]
    fn archives_by_source_and_continues_after_partial_failure() {
        let runtime_executor = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime_executor.block_on(async {
            let root =
                std::env::temp_dir().join(format!("codex-monitor-archive-{}", Uuid::new_v4()));
            let project = root.join("project");
            fs::create_dir_all(&project).unwrap();
            let settings_path = root.join("settings.json");
            let settings = Mutex::new(AppSettings::default());
            let runtime = SessionManagerRuntime::with_storage_dir(&root);
            let mut source_ids = Vec::new();
            for (name, thread_id) in [("Source A", "thread-a"), ("Source B", "thread-b")] {
                let codex_home = root.join(name.replace(' ', "-"));
                let session_path = codex_home.join("sessions").join("2026").join("07").join("10");
                fs::create_dir_all(&session_path).unwrap();
                let cwd = serde_json::to_string(&project.to_string_lossy()).unwrap();
                fs::write(
                    session_path.join(format!("rollout-{thread_id}.jsonl")),
                    format!("{{\"type\":\"session_meta\",\"payload\":{{\"id\":\"{thread_id}\",\"cwd\":{cwd}}}}}\n"),
                )
                .unwrap();
                let sources = update_session_source_core(
                    SessionSourceUpdateRequest {
                        action: "add".to_string(),
                        source_id: None,
                        name: Some(name.to_string()),
                        path: Some(codex_home.to_string_lossy().to_string()),
                        enabled: None,
                    },
                    &settings,
                    &settings_path,
                )
                .await
                .unwrap();
                source_ids.push(sources.last().unwrap().id.clone());
            }
            scan_managed_sessions_core(
                SessionScanRequest {
                    request_id: "archive-scan".to_string(),
                    source_ids: source_ids.clone(),
                    include_archived: None,
                },
                &settings,
                &runtime,
            )
            .await
            .unwrap();
            fs::remove_dir_all(&project).unwrap();
            let routed = Arc::new(StdMutex::new(Vec::new()));
            let response = archive_managed_sessions_core(
                ArchiveManagedSessionsRequest {
                    items: vec![
                        ArchiveManagedSessionItem {
                            source_id: source_ids[0].clone(),
                            thread_id: "thread-a".to_string(),
                        },
                        ArchiveManagedSessionItem {
                            source_id: source_ids[1].clone(),
                            thread_id: "thread-b".to_string(),
                        },
                    ],
                },
                &settings,
                &runtime,
                {
                    let routed = Arc::clone(&routed);
                    move |source, managed| {
                        let routed = Arc::clone(&routed);
                        async move {
                            routed
                                .lock()
                                .unwrap()
                                .push((source.id, managed.thread_id.clone()));
                            if managed.thread_id == "thread-b" {
                                Err("upstream archive failed".to_string())
                            } else {
                                Ok(())
                            }
                        }
                    }
                },
            )
            .await
            .unwrap();
            assert_eq!(response.success_count, 1);
            assert_eq!(response.failure_count, 1);
            assert_eq!(routed.lock().unwrap().len(), 2);
            assert!(response.results[0].archived_at.is_some());
            assert!(response.results[1].archived_at.is_none());
            let page = fetch_managed_sessions_page_core(
                ManagedSessionPageRequest {
                    request_id: "archive-scan".to_string(),
                    offset: 0,
                    limit: 10,
                },
                &runtime,
            )
            .await
            .unwrap();
            let archived = page
                .items
                .iter()
                .find(|session| session.thread_id == "thread-a")
                .unwrap();
            let failed = page
                .items
                .iter()
                .find(|session| session.thread_id == "thread-b")
                .unwrap();
            assert!(archived.is_archived);
            assert!(archived.archived_at.is_some());
            assert!(!failed.is_archived);
            assert!(failed.archived_at.is_none());
            let ledger = read_archive_ledger(&root.join("session-archive-ledger.json")).unwrap();
            let entry = &ledger.entries[&format!("{}:thread-a", source_ids[0])];
            assert_eq!(entry.time_source, ArchiveTimeSource::ConfirmedLocal);
            assert_eq!(runtime.deletion_audit_path(), Some(root.join("session-deletion-audit.jsonl").as_path()));
            let _ = fs::remove_dir_all(root);
        });
    }

    #[test]
    fn persists_legacy_archive_first_discovery_across_scans() {
        let runtime_executor = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime_executor.block_on(async {
            let root = std::env::temp_dir()
                .join(format!("codex-monitor-legacy-archive-{}", Uuid::new_v4()));
            let archived_path = root.join("codex-home").join("archived_sessions");
            fs::create_dir_all(&archived_path).unwrap();
            fs::write(
                archived_path.join("rollout-thread-legacy.jsonl"),
                "{\"type\":\"session_meta\",\"payload\":{\"id\":\"thread-legacy\"}}\n",
            )
            .unwrap();
            let settings_path = root.join("settings.json");
            let settings = Mutex::new(AppSettings::default());
            let runtime = SessionManagerRuntime::with_storage_dir(&root);
            let sources = update_session_source_core(
                SessionSourceUpdateRequest {
                    action: "add".to_string(),
                    source_id: None,
                    name: Some("Legacy".to_string()),
                    path: Some(root.join("codex-home").to_string_lossy().to_string()),
                    enabled: None,
                },
                &settings,
                &settings_path,
            )
            .await
            .unwrap();
            let source_id = sources[0].id.clone();
            scan_managed_sessions_core(
                SessionScanRequest {
                    request_id: "legacy-scan-a".to_string(),
                    source_ids: vec![source_id.clone()],
                    include_archived: None,
                },
                &settings,
                &runtime,
            )
            .await
            .unwrap();
            let first = fetch_managed_sessions_page_core(
                ManagedSessionPageRequest {
                    request_id: "legacy-scan-a".to_string(),
                    offset: 0,
                    limit: 10,
                },
                &runtime,
            )
            .await
            .unwrap()
            .items[0]
                .archived_at;
            scan_managed_sessions_core(
                SessionScanRequest {
                    request_id: "legacy-scan-b".to_string(),
                    source_ids: vec![source_id.clone()],
                    include_archived: None,
                },
                &settings,
                &runtime,
            )
            .await
            .unwrap();
            let second = fetch_managed_sessions_page_core(
                ManagedSessionPageRequest {
                    request_id: "legacy-scan-b".to_string(),
                    offset: 0,
                    limit: 10,
                },
                &runtime,
            )
            .await
            .unwrap()
            .items[0]
                .archived_at;
            assert!(first.is_some());
            assert_eq!(second, first);
            let ledger = read_archive_ledger(&root.join("session-archive-ledger.json")).unwrap();
            assert_eq!(
                ledger.entries[&format!("{source_id}:thread-legacy")].time_source,
                ArchiveTimeSource::FirstDiscovery
            );
            let _ = fs::remove_dir_all(root);
        });
    }
}
