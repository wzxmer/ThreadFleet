use serde::de::DeserializeOwned;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{AppHandle, State};
use uuid::Uuid;

use crate::remote_backend;
use crate::shared::session_manager_core::runtime::{
    SourceRuntimePurpose, SourceThreadRuntimeBinding,
};
use crate::shared::session_manager_core::service::{
    cancel_session_task_core, fetch_managed_session_preview_core, fetch_managed_sessions_page_core,
    fetch_session_search_results_core, list_session_sources_core, scan_managed_sessions_core,
    search_managed_sessions_core, update_session_source_core, verify_session_threads_core,
};
use crate::shared::settings_core;
use crate::state::AppState;
use crate::types::{
    ArchiveManagedSessionsRequest, ArchiveManagedSessionsResponse, ManagedSessionCleanupPreview,
    ManagedSessionCleanupRequest, ManagedSessionCleanupResponse,
    ManagedSessionCleanupSchedulerRequest, ManagedSessionCleanupSchedulerResponse,
    ManagedSessionDerivationPreview, ManagedSessionPage, ManagedSessionPageRequest,
    ManagedSessionPreviewRequest, ManagedSessionPreviewResponse,
    PermanentlyDeleteManagedSessionRequest, PermanentlyDeleteManagedSessionResponse,
    PrepareManagedSessionDerivationRequest, ResumeManagedSessionRequest,
    ResumeManagedSessionResponse, SessionScanRequest, SessionScanSummary, SessionSearchProgress,
    SessionSearchRequest, SessionSearchResponse, SessionSource, SessionSourceUpdateRequest,
    VerifySessionThreadsRequest, VerifySessionThreadsResponse, WorkspaceEntry, WorkspaceInfo,
    WorkspaceKind, WorkspaceSettings,
};

fn workspace_info(entry: &WorkspaceEntry, connected: bool) -> WorkspaceInfo {
    WorkspaceInfo {
        id: entry.id.clone(),
        name: entry.name.clone(),
        path: entry.path.clone(),
        connected,
        kind: entry.kind.clone(),
        parent_id: entry.parent_id.clone(),
        worktree: entry.worktree.clone(),
        settings: entry.settings.clone(),
    }
}

async fn resolve_or_prepare_workspace(
    cwd: &str,
    display_name: Option<&str>,
    state: &AppState,
) -> Result<(WorkspaceEntry, bool), String> {
    let normalized = crate::shared::workspaces_core::normalize_workspace_path_input(cwd);
    if !normalized.is_dir() {
        return Err("Managed session project path is unavailable".to_string());
    }
    let path = crate::shared::workspaces_core::workspace_path_to_string(&normalized);
    if let Some(entry) = state
        .workspaces
        .lock()
        .await
        .values()
        .find(|entry| entry.path.eq_ignore_ascii_case(&path))
        .cloned()
    {
        return Ok((entry, false));
    }
    let name = display_name.map(str::to_string).unwrap_or_else(|| {
        normalized
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("Workspace")
            .to_string()
    });
    Ok((
        WorkspaceEntry {
            id: Uuid::new_v4().to_string(),
            name,
            path,
            kind: WorkspaceKind::Main,
            parent_id: None,
            worktree: None,
            settings: WorkspaceSettings::default(),
        },
        true,
    ))
}

pub(crate) async fn source_runtime_for_workspace(
    source: &SessionSource,
    entry: crate::types::WorkspaceEntry,
    default_codex_bin: Option<String>,
    codex_args: Option<String>,
    state: &AppState,
    app: AppHandle,
) -> Result<Arc<crate::codex::WorkspaceSession>, String> {
    state.session_source_runtimes.close_idle().await;
    let workspace_context = entry.path.clone();
    state
        .session_source_runtimes
        .get_or_spawn_workspace_session_for_source(
            source,
            &workspace_context,
            move |codex_home: PathBuf| {
                crate::codex::spawn_workspace_session(
                    entry,
                    default_codex_bin,
                    codex_args,
                    app,
                    Some(codex_home),
                )
            },
        )
        .await
}

async fn history_runtime_for_workspace(
    source: SessionSource,
    entry: WorkspaceEntry,
    state: &AppState,
    app: AppHandle,
) -> Result<Arc<crate::codex::WorkspaceSession>, String> {
    let (default_codex_bin, codex_args) = {
        let settings = state.app_settings.lock().await;
        (
            settings.codex_bin.clone(),
            crate::codex::args::resolve_workspace_codex_args(&entry, None, Some(&settings)),
        )
    };
    state.session_source_runtimes.close_idle().await;
    let workspace_context = entry.path.clone();
    state
        .session_source_runtimes
        .get_or_spawn_workspace_session_for_source_purpose(
            &source,
            &workspace_context,
            SourceRuntimePurpose::History,
            move |codex_home| {
                crate::codex::spawn_history_workspace_session(
                    entry,
                    default_codex_bin,
                    codex_args,
                    app,
                    codex_home,
                )
            },
        )
        .await
}

async fn current_history_source_and_workspace(
    workspace_id: &str,
    state: &AppState,
) -> Result<(SessionSource, WorkspaceEntry), String> {
    let entry = state
        .workspaces
        .lock()
        .await
        .get(workspace_id)
        .cloned()
        .ok_or_else(|| "Workspace not found".to_string())?;
    let codex_home = {
        let settings = state.app_settings.lock().await;
        crate::codex::home::resolve_settings_codex_home(&settings)
            .ok_or_else(|| "Unable to resolve CODEX_HOME for session history".to_string())?
    };
    let source =
        crate::shared::session_manager_core::sources::session_source_for_codex_home(&codex_home)?;
    Ok((source, entry))
}

pub(crate) async fn history_runtime_for_workspace_id(
    workspace_id: &str,
    state: &AppState,
    app: AppHandle,
) -> Result<Arc<crate::codex::WorkspaceSession>, String> {
    let (source, entry) = current_history_source_and_workspace(workspace_id, state).await?;
    history_runtime_for_workspace(source, entry, state, app).await
}

pub(crate) async fn history_runtime_for_thread(
    workspace_id: &str,
    thread_id: &str,
    state: &AppState,
    app: AppHandle,
) -> Result<Arc<crate::codex::WorkspaceSession>, String> {
    if let Some(binding) = state
        .source_thread_runtimes
        .get(workspace_id, thread_id)
        .await
    {
        return history_runtime_for_workspace(binding.source, binding.workspace, state, app).await;
    }
    history_runtime_for_workspace_id(workspace_id, state, app).await
}

pub(crate) async fn source_runtime_for_bound_thread(
    workspace_id: &str,
    thread_id: &str,
    state: &AppState,
    app: AppHandle,
) -> Result<Option<Arc<crate::codex::WorkspaceSession>>, String> {
    let Some(binding) = state
        .source_thread_runtimes
        .get(workspace_id, thread_id)
        .await
    else {
        return Ok(None);
    };
    let (default_codex_bin, codex_args) = {
        let settings = state.app_settings.lock().await;
        (
            settings.codex_bin.clone(),
            crate::codex::args::resolve_workspace_codex_args(
                &binding.workspace,
                None,
                Some(&settings),
            ),
        )
    };
    state.session_source_runtimes.close_idle().await;
    let workspace_context = binding.workspace.path.clone();
    let workspace_for_spawn = binding.workspace.clone();
    let (runtime, spawned) = state
        .session_source_runtimes
        .get_or_spawn_workspace_session_for_source_with_status(
            &binding.source,
            &workspace_context,
            move |codex_home| {
                crate::codex::spawn_workspace_session(
                    workspace_for_spawn,
                    default_codex_bin,
                    codex_args,
                    app,
                    Some(codex_home),
                )
            },
        )
        .await?;
    runtime
        .register_workspace_with_path(&binding.workspace.id, Some(&binding.workspace.path))
        .await;
    if spawned {
        crate::shared::codex_core::resume_thread_with_session_core(
            &runtime,
            workspace_id.to_string(),
            thread_id.to_string(),
        )
        .await?;
    }
    Ok(Some(runtime))
}

pub(crate) async fn source_runtime_for_bound_workspace(
    workspace_id: &str,
    state: &AppState,
    app: AppHandle,
) -> Result<Option<Arc<crate::codex::WorkspaceSession>>, String> {
    let Some((thread_id, _)) = state
        .source_thread_runtimes
        .unique_for_workspace(workspace_id)
        .await
    else {
        return Ok(None);
    };
    source_runtime_for_bound_thread(workspace_id, &thread_id, state, app).await
}

#[tauri::command]
pub(crate) async fn resume_managed_session(
    request: ResumeManagedSessionRequest,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<ResumeManagedSessionResponse, String> {
    if remote_backend::is_remote_mode(&state).await {
        return remote_typed_if_enabled(
            &state,
            &app,
            "resume_managed_session",
            json!({ "request": request }),
        )
        .await?
        .ok_or_else(|| "Remote session resume returned no response".to_string());
    }
    settings_core::get_app_settings_core(&state.app_settings, &state.settings_path).await;
    let (source, managed) =
        crate::shared::session_manager_core::service::resolve_managed_session_core(
            &request.source_id,
            &request.thread_id,
            &state.app_settings,
            &state.session_manager,
        )
        .await?;
    let storage_dir = state.storage_path.parent().unwrap_or(&state.storage_path);
    let target =
        crate::shared::session_manager_core::mount::resolve_managed_session_workspace_target(
            storage_dir,
            &source.id,
            &managed.thread_id,
            managed.cwd.as_deref(),
        )?;
    let target_path = target.path.to_string_lossy();
    let (entry, is_new) =
        resolve_or_prepare_workspace(&target_path, target.display_name.as_deref(), &state).await?;
    let (default_codex_bin, codex_args) = {
        let settings = state.app_settings.lock().await;
        (
            settings.codex_bin.clone(),
            crate::codex::args::resolve_workspace_codex_args(&entry, None, Some(&settings)),
        )
    };
    let runtime = source_runtime_for_workspace(
        &source,
        entry.clone(),
        default_codex_bin,
        codex_args,
        &state,
        app,
    )
    .await?;
    runtime
        .register_workspace_with_path(&entry.id, Some(&entry.path))
        .await;
    crate::shared::codex_core::resume_thread_with_session_core(
        &runtime,
        entry.id.clone(),
        managed.thread_id.clone(),
    )
    .await?;
    state
        .source_thread_runtimes
        .bind(
            &entry.id,
            &managed.thread_id,
            SourceThreadRuntimeBinding {
                source: source.clone(),
                workspace: entry.clone(),
                client_version: None,
            },
        )
        .await;
    if is_new {
        let mut workspaces = state.workspaces.lock().await;
        workspaces.insert(entry.id.clone(), entry.clone());
        let list = workspaces.values().cloned().collect::<Vec<_>>();
        if let Err(error) = crate::storage::write_workspaces(&state.storage_path, &list) {
            workspaces.remove(&entry.id);
            state
                .source_thread_runtimes
                .remove(&entry.id, &managed.thread_id)
                .await;
            return Err(error);
        }
    }
    Ok(ResumeManagedSessionResponse {
        workspace: workspace_info(&entry, true),
        thread_id: managed.thread_id,
        source_id: source.id,
        source_name: source.name,
    })
}

#[tauri::command]
pub(crate) async fn archive_managed_sessions(
    request: ArchiveManagedSessionsRequest,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<ArchiveManagedSessionsResponse, String> {
    if remote_backend::is_remote_mode(&state).await {
        return remote_typed_if_enabled(
            &state,
            &app,
            "archive_managed_sessions",
            json!({ "request": request }),
        )
        .await?
        .ok_or_else(|| "Remote managed session archive returned no response".to_string());
    }
    settings_core::get_app_settings_core(&state.app_settings, &state.settings_path).await;
    crate::shared::session_manager_core::service::archive_managed_sessions_core(
        request,
        &state.app_settings,
        &state.session_manager,
        |source, managed| {
            let app = app.clone();
            let state = &*state;
            async move {
                let workspace_context = managed
                    .cwd
                    .as_deref()
                    .filter(|cwd| PathBuf::from(cwd).is_dir())
                    .unwrap_or(&source.codex_home_path);
                let (entry, _) =
                    resolve_or_prepare_workspace(workspace_context, None, state).await?;
                let (default_codex_bin, codex_args) = {
                    let settings = state.app_settings.lock().await;
                    (
                        settings.codex_bin.clone(),
                        crate::codex::args::resolve_workspace_codex_args(
                            &entry,
                            None,
                            Some(&settings),
                        ),
                    )
                };
                let runtime = source_runtime_for_workspace(
                    &source,
                    entry.clone(),
                    default_codex_bin,
                    codex_args,
                    state,
                    app,
                )
                .await?;
                runtime
                    .register_workspace_with_path(&entry.id, Some(&entry.path))
                    .await;
                runtime
                    .send_request_for_workspace(
                        &entry.id,
                        "thread/archive",
                        json!({ "threadId": managed.thread_id }),
                    )
                    .await?;
                state
                    .source_thread_runtimes
                    .remove_for_source_thread(&source.id, &managed.thread_id)
                    .await;
                Ok(())
            }
        },
    )
    .await
}

#[tauri::command]
pub(crate) async fn permanently_delete_managed_session(
    request: PermanentlyDeleteManagedSessionRequest,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<PermanentlyDeleteManagedSessionResponse, String> {
    if remote_backend::is_remote_mode(&state).await {
        return remote_typed_if_enabled(
            &state,
            &app,
            "permanently_delete_managed_session",
            json!({ "request": request }),
        )
        .await?
        .ok_or_else(|| "Remote permanent session delete returned no response".to_string());
    }
    settings_core::get_app_settings_core(&state.app_settings, &state.settings_path).await;
    crate::shared::session_manager_core::service::permanently_delete_managed_session_core(
        request,
        &state.app_settings,
        &state.session_manager,
    )
    .await
}

#[tauri::command]
pub(crate) async fn preview_managed_session_cleanup(
    request: ManagedSessionCleanupRequest,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<ManagedSessionCleanupPreview, String> {
    if remote_backend::is_remote_mode(&state).await {
        return remote_typed_if_enabled(
            &state,
            &app,
            "preview_managed_session_cleanup",
            json!({ "request": request }),
        )
        .await?
        .ok_or_else(|| "Remote session cleanup preview returned no response".to_string());
    }
    settings_core::get_app_settings_core(&state.app_settings, &state.settings_path).await;
    crate::shared::session_manager_core::service::preview_managed_session_cleanup_core(
        request,
        &state.app_settings,
        &state.session_manager,
    )
    .await
}

#[tauri::command]
pub(crate) async fn cleanup_managed_sessions_now(
    request: ManagedSessionCleanupRequest,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<ManagedSessionCleanupResponse, String> {
    if remote_backend::is_remote_mode(&state).await {
        return remote_typed_if_enabled(
            &state,
            &app,
            "cleanup_managed_sessions_now",
            json!({ "request": request }),
        )
        .await?
        .ok_or_else(|| "Remote session cleanup returned no response".to_string());
    }
    settings_core::get_app_settings_core(&state.app_settings, &state.settings_path).await;
    crate::shared::session_manager_core::service::cleanup_managed_sessions_now_core(
        request,
        &state.app_settings,
        &state.session_manager,
    )
    .await
}

#[tauri::command]
pub(crate) async fn run_managed_session_cleanup_scheduler(
    request: ManagedSessionCleanupSchedulerRequest,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<ManagedSessionCleanupSchedulerResponse, String> {
    if remote_backend::is_remote_mode(&state).await {
        return remote_typed_if_enabled(
            &state,
            &app,
            "run_managed_session_cleanup_scheduler",
            json!({ "request": request }),
        )
        .await?
        .ok_or_else(|| "Remote session cleanup scheduler returned no response".to_string());
    }
    settings_core::get_app_settings_core(&state.app_settings, &state.settings_path).await;
    let sessions = state
        .sessions
        .lock()
        .await
        .values()
        .cloned()
        .collect::<Vec<_>>();
    let mut running_thread_ids = Vec::new();
    for session in sessions {
        running_thread_ids.extend(session.active_turns.lock().await.keys().cloned());
    }
    crate::shared::session_manager_core::service::run_managed_session_cleanup_scheduler_core(
        request,
        running_thread_ids,
        &state.app_settings,
        &state.session_manager,
    )
    .await
}

#[tauri::command]
pub(crate) async fn prepare_managed_session_derivation(
    request: PrepareManagedSessionDerivationRequest,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<ManagedSessionDerivationPreview, String> {
    if remote_backend::is_remote_mode(&state).await {
        return remote_typed_if_enabled(
            &state,
            &app,
            "prepare_managed_session_derivation",
            json!({ "request": request }),
        )
        .await?
        .ok_or_else(|| "Remote managed session derivation returned no response".to_string());
    }
    settings_core::get_app_settings_core(&state.app_settings, &state.settings_path).await;
    crate::shared::session_manager_core::service::prepare_managed_session_derivation_core(
        request,
        &state.app_settings,
        &state.session_manager,
    )
    .await
}

async fn remote_typed_if_enabled<T: DeserializeOwned>(
    state: &AppState,
    app: &AppHandle,
    method: &str,
    params: Value,
) -> Result<Option<T>, String> {
    if !remote_backend::is_remote_mode(state).await {
        return Ok(None);
    }
    let value = remote_backend::call_remote(state, app.clone(), method, params).await?;
    serde_json::from_value(value)
        .map(Some)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) async fn list_session_sources(
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<Vec<SessionSource>, String> {
    if let Some(value) =
        remote_typed_if_enabled(&state, &app, "list_session_sources", json!({})).await?
    {
        return Ok(value);
    }
    settings_core::get_app_settings_core(&state.app_settings, &state.settings_path).await;
    Ok(list_session_sources_core(&state.app_settings).await)
}

#[tauri::command]
pub(crate) async fn update_session_source(
    request: SessionSourceUpdateRequest,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<Vec<SessionSource>, String> {
    if let Some(value) = remote_typed_if_enabled(
        &state,
        &app,
        "update_session_source",
        json!({ "request": request }),
    )
    .await?
    {
        return Ok(value);
    }
    update_session_source_core(request, &state.app_settings, &state.settings_path).await
}

#[tauri::command]
pub(crate) async fn scan_managed_sessions(
    request: SessionScanRequest,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<SessionScanSummary, String> {
    if let Some(value) = remote_typed_if_enabled(
        &state,
        &app,
        "scan_managed_sessions",
        json!({ "request": request }),
    )
    .await?
    {
        return Ok(value);
    }
    settings_core::get_app_settings_core(&state.app_settings, &state.settings_path).await;
    scan_managed_sessions_core(request, &state.app_settings, &state.session_manager).await
}

#[tauri::command]
pub(crate) async fn verify_session_threads(
    request: VerifySessionThreadsRequest,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<VerifySessionThreadsResponse, String> {
    if let Some(value) = remote_typed_if_enabled(
        &state,
        &app,
        "verify_session_threads",
        json!({ "request": request }),
    )
    .await?
    {
        return Ok(value);
    }
    settings_core::get_app_settings_core(&state.app_settings, &state.settings_path).await;
    verify_session_threads_core(request, &state.app_settings, &state.session_manager).await
}

#[tauri::command]
pub(crate) async fn fetch_managed_sessions_page(
    request: ManagedSessionPageRequest,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<ManagedSessionPage, String> {
    if let Some(value) = remote_typed_if_enabled(
        &state,
        &app,
        "fetch_managed_sessions_page",
        json!({ "request": request }),
    )
    .await?
    {
        return Ok(value);
    }
    fetch_managed_sessions_page_core(request, &state.session_manager).await
}

#[tauri::command]
pub(crate) async fn fetch_managed_session_preview(
    request: ManagedSessionPreviewRequest,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<ManagedSessionPreviewResponse, String> {
    if let Some(value) = remote_typed_if_enabled(
        &state,
        &app,
        "fetch_managed_session_preview",
        json!({ "request": request }),
    )
    .await?
    {
        return Ok(value);
    }
    settings_core::get_app_settings_core(&state.app_settings, &state.settings_path).await;
    fetch_managed_session_preview_core(request, &state.app_settings, &state.session_manager).await
}

#[tauri::command]
pub(crate) async fn search_managed_sessions(
    request: SessionSearchRequest,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<SessionSearchProgress, String> {
    if let Some(value) = remote_typed_if_enabled(
        &state,
        &app,
        "search_managed_sessions",
        json!({ "request": request }),
    )
    .await?
    {
        return Ok(value);
    }
    search_managed_sessions_core(request, &state.session_manager).await
}
#[tauri::command]
pub(crate) async fn fetch_session_search_results(
    request_id: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<SessionSearchResponse, String> {
    if let Some(value) = remote_typed_if_enabled(
        &state,
        &app,
        "fetch_session_search_results",
        json!({ "requestId": request_id }),
    )
    .await?
    {
        return Ok(value);
    }
    fetch_session_search_results_core(request_id, &state.session_manager)
}
#[tauri::command]
pub(crate) async fn cancel_session_task(
    request_id: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<(), String> {
    if remote_backend::is_remote_mode(&state).await {
        remote_backend::call_remote(
            &state,
            app,
            "cancel_session_task",
            json!({ "requestId": request_id }),
        )
        .await?;
        return Ok(());
    }
    cancel_session_task_core(request_id, &state.session_manager).await
}
