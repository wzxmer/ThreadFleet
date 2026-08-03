use std::collections::HashMap;
use std::future::Future;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};
use tokio::sync::{Mutex, RwLock};

use crate::backend::app_server::WorkspaceSession;
use crate::codex::args::resolve_workspace_codex_args;
use crate::codex::home::resolve_settings_codex_home;
use crate::shared::process_core::kill_child_process_tree;
use crate::shared::provider_config_sync_core::{
    sync_active_provider_profile_to_local_config, ProviderConfigSyncOutcome,
};
use crate::shared::provider_profiles_core::{
    active_profile_codex_args, active_profile_runtime_fingerprint,
};
use crate::shared::session_manager_core::runtime::{
    SessionSourceRuntimePool, SourceRuntimePurpose,
};
use crate::shared::turn_execution_summary_core::source_id_for_codex_home;
use crate::types::{AppSettings, WorkspaceEntry};

use super::connect::workspace_session_spawn_lock;
use super::helpers::resolve_entry_and_parent;

static PROVIDER_RUNTIME_SWITCH_GATE: OnceLock<RwLock<()>> = OnceLock::new();

pub(crate) fn provider_runtime_switch_gate() -> &'static RwLock<()> {
    PROVIDER_RUNTIME_SWITCH_GATE.get_or_init(|| RwLock::new(()))
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceRuntimeCodexArgsResult {
    pub(crate) applied_codex_args: Option<String>,
    pub(crate) respawned: bool,
    #[serde(default)]
    pub(crate) before_provider_runtime_fingerprint: Option<String>,
    #[serde(default)]
    pub(crate) after_provider_runtime_fingerprint: Option<String>,
    #[serde(default)]
    pub(crate) session_source_id: String,
    #[serde(default)]
    pub(crate) config_synced: bool,
}

fn unique_session_values(
    sessions: &HashMap<String, Arc<WorkspaceSession>>,
) -> Vec<Arc<WorkspaceSession>> {
    let mut unique = Vec::new();
    for session in sessions.values() {
        if !unique
            .iter()
            .any(|candidate| Arc::ptr_eq(candidate, session))
        {
            unique.push(Arc::clone(session));
        }
    }
    unique
}

async fn unique_sessions(
    sessions: &Mutex<HashMap<String, Arc<WorkspaceSession>>>,
    source_runtimes: Option<&SessionSourceRuntimePool>,
) -> Vec<Arc<WorkspaceSession>> {
    let mut unique = unique_session_values(&*sessions.lock().await);
    if let Some(source_runtimes) = source_runtimes {
        for session in source_runtimes.sessions_snapshot().await {
            if !unique
                .iter()
                .any(|candidate| Arc::ptr_eq(candidate, &session))
            {
                unique.push(session);
            }
        }
    }
    unique
}

fn runtime_matches_target(
    session: &WorkspaceSession,
    codex_args: &Option<String>,
    provider_runtime_fingerprint: &Option<String>,
) -> bool {
    session.codex_args == *codex_args
        && session.provider_runtime_fingerprint == *provider_runtime_fingerprint
}

async fn source_runtimes_match_target(
    source_runtimes: Option<&SessionSourceRuntimePool>,
    codex_args: &Option<String>,
    provider_runtime_fingerprint: &Option<String>,
) -> bool {
    let Some(source_runtimes) = source_runtimes else {
        return true;
    };
    source_runtimes
        .sessions_snapshot_for_purpose(SourceRuntimePurpose::Execution)
        .await
        .iter()
        .all(|session| runtime_matches_target(session, codex_args, provider_runtime_fingerprint))
}

async fn ensure_all_runtimes_quiescent(
    sessions: &Mutex<HashMap<String, Arc<WorkspaceSession>>>,
    source_runtimes: Option<&SessionSourceRuntimePool>,
) -> Result<(), String> {
    for session in unique_sessions(sessions, source_runtimes).await {
        if !session.active_turns.lock().await.is_empty() {
            return Err(
                "Cannot restart the Codex runtime while another thread is processing.".to_string(),
            );
        }
    }
    Ok(())
}

async fn terminate_unpublished_session(session: &Arc<WorkspaceSession>) {
    let mut child = session.child.lock().await;
    kill_child_process_tree(&mut child).await;
}

async fn sync_provider_config(settings: AppSettings, codex_home: PathBuf) -> Result<bool, String> {
    tokio::task::spawn_blocking(move || {
        sync_active_provider_profile_to_local_config(&codex_home, &settings).map(|outcome| {
            matches!(
                outcome,
                ProviderConfigSyncOutcome::Updated | ProviderConfigSyncOutcome::RestoredDefault
            )
        })
    })
    .await
    .map_err(|error| error.to_string())?
}

fn provider_transaction_matches(
    settings: &AppSettings,
    expected_settings: &AppSettings,
    expected_provider_runtime_fingerprint: &Option<String>,
    expected_session_source_id: &str,
) -> bool {
    let current_source =
        resolve_settings_codex_home(settings).map(|path| source_id_for_codex_home(&path));
    active_profile_runtime_fingerprint(settings) == *expected_provider_runtime_fingerprint
        && current_source.as_deref() == Some(expected_session_source_id)
        && settings.sync_provider_profile_to_local_config
            == expected_settings.sync_provider_profile_to_local_config
}

async fn sync_provider_config_if_current(
    app_settings: &Mutex<AppSettings>,
    settings_snapshot: AppSettings,
    provider_runtime_fingerprint: &Option<String>,
    session_source_id: &str,
    codex_home: PathBuf,
) -> Result<bool, String> {
    let current_settings = app_settings.lock().await;
    if !provider_transaction_matches(
        &current_settings,
        &settings_snapshot,
        provider_runtime_fingerprint,
        session_source_id,
    ) {
        return Err(
            "Provider settings changed during runtime switch; retrying is required".to_string(),
        );
    }
    sync_provider_config(settings_snapshot, codex_home).await
}

#[cfg(test)]
pub(crate) async fn set_workspace_runtime_codex_args_core<F, Fut>(
    workspace_id: String,
    codex_args_override: Option<String>,
    workspaces: &Mutex<HashMap<String, WorkspaceEntry>>,
    sessions: &Mutex<HashMap<String, Arc<WorkspaceSession>>>,
    app_settings: &Mutex<AppSettings>,
    spawn_session: F,
) -> Result<WorkspaceRuntimeCodexArgsResult, String>
where
    F: Fn(WorkspaceEntry, Option<String>, Option<String>, Option<PathBuf>, AppSettings) -> Fut,
    Fut: Future<Output = Result<Arc<WorkspaceSession>, String>>,
{
    set_workspace_runtime_codex_args_inner(
        workspace_id,
        codex_args_override,
        workspaces,
        sessions,
        app_settings,
        None,
        spawn_session,
    )
    .await
}

pub(crate) async fn set_workspace_runtime_codex_args_with_source_runtimes_core<F, Fut>(
    workspace_id: String,
    codex_args_override: Option<String>,
    workspaces: &Mutex<HashMap<String, WorkspaceEntry>>,
    sessions: &Mutex<HashMap<String, Arc<WorkspaceSession>>>,
    app_settings: &Mutex<AppSettings>,
    source_runtimes: &SessionSourceRuntimePool,
    spawn_session: F,
) -> Result<WorkspaceRuntimeCodexArgsResult, String>
where
    F: Fn(WorkspaceEntry, Option<String>, Option<String>, Option<PathBuf>, AppSettings) -> Fut,
    Fut: Future<Output = Result<Arc<WorkspaceSession>, String>>,
{
    set_workspace_runtime_codex_args_inner(
        workspace_id,
        codex_args_override,
        workspaces,
        sessions,
        app_settings,
        Some(source_runtimes),
        spawn_session,
    )
    .await
}

async fn set_workspace_runtime_codex_args_inner<F, Fut>(
    workspace_id: String,
    codex_args_override: Option<String>,
    workspaces: &Mutex<HashMap<String, WorkspaceEntry>>,
    sessions: &Mutex<HashMap<String, Arc<WorkspaceSession>>>,
    app_settings: &Mutex<AppSettings>,
    source_runtimes: Option<&SessionSourceRuntimePool>,
    spawn_session: F,
) -> Result<WorkspaceRuntimeCodexArgsResult, String>
where
    F: Fn(WorkspaceEntry, Option<String>, Option<String>, Option<PathBuf>, AppSettings) -> Fut,
    Fut: Future<Output = Result<Arc<WorkspaceSession>, String>>,
{
    let (entry, parent_entry) = resolve_entry_and_parent(workspaces, &workspace_id).await?;
    let _spawn_guard = workspace_session_spawn_lock().lock().await;
    let _switch_guard = provider_runtime_switch_gate().write().await;

    let (settings_snapshot, default_bin, resolved_args, codex_home) = {
        let settings = app_settings.lock().await.clone();
        (
            settings.clone(),
            settings.codex_bin.clone(),
            resolve_workspace_codex_args(&entry, parent_entry.as_ref(), Some(&settings)),
            resolve_settings_codex_home(&settings)
                .ok_or_else(|| "Unable to resolve CODEX_HOME for Provider switch".to_string())?,
        )
    };
    let session_source_id = source_id_for_codex_home(&codex_home);

    let target_args = codex_args_override
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or(resolved_args);
    let (effective_target_args, provider_runtime_fingerprint) = {
        (
            active_profile_codex_args(&settings_snapshot, target_args.clone())?,
            active_profile_runtime_fingerprint(&settings_snapshot),
        )
    };

    // If we are not connected, we can't respawn. Treat this as a no-op success; callers
    // should call again after connecting.
    let (workspace_connected, current_session) = {
        let sessions = sessions.lock().await;
        (
            sessions.contains_key(&entry.id),
            sessions.values().next().cloned(),
        )
    };
    if !workspace_connected {
        let config_synced = sync_provider_config_if_current(
            app_settings,
            settings_snapshot,
            &provider_runtime_fingerprint,
            &session_source_id,
            codex_home,
        )
        .await?;
        return Ok(WorkspaceRuntimeCodexArgsResult {
            applied_codex_args: target_args,
            respawned: false,
            before_provider_runtime_fingerprint: None,
            after_provider_runtime_fingerprint: None,
            session_source_id,
            config_synced,
        });
    }

    let Some(current_session) = current_session else {
        let config_synced = sync_provider_config_if_current(
            app_settings,
            settings_snapshot,
            &provider_runtime_fingerprint,
            &session_source_id,
            codex_home,
        )
        .await?;
        return Ok(WorkspaceRuntimeCodexArgsResult {
            applied_codex_args: target_args,
            respawned: false,
            before_provider_runtime_fingerprint: None,
            after_provider_runtime_fingerprint: None,
            session_source_id,
            config_synced,
        });
    };

    let before_provider_runtime_fingerprint = current_session.provider_runtime_fingerprint.clone();

    let current_runtime_matches = runtime_matches_target(
        &current_session,
        &effective_target_args,
        &provider_runtime_fingerprint,
    );
    let source_runtimes_match = source_runtimes_match_target(
        source_runtimes,
        &effective_target_args,
        &provider_runtime_fingerprint,
    )
    .await;

    if current_runtime_matches && source_runtimes_match {
        let config_synced = sync_provider_config_if_current(
            app_settings,
            settings_snapshot,
            &provider_runtime_fingerprint,
            &session_source_id,
            codex_home,
        )
        .await?;
        return Ok(WorkspaceRuntimeCodexArgsResult {
            applied_codex_args: target_args,
            respawned: false,
            before_provider_runtime_fingerprint: before_provider_runtime_fingerprint.clone(),
            after_provider_runtime_fingerprint: before_provider_runtime_fingerprint,
            session_source_id,
            config_synced,
        });
    }

    if current_runtime_matches {
        ensure_all_runtimes_quiescent(sessions, source_runtimes).await?;
        let config_synced = sync_provider_config_if_current(
            app_settings,
            settings_snapshot,
            &provider_runtime_fingerprint,
            &session_source_id,
            codex_home,
        )
        .await?;
        if let Some(source_runtimes) = source_runtimes {
            source_runtimes.close_all().await;
        }
        return Ok(WorkspaceRuntimeCodexArgsResult {
            applied_codex_args: target_args,
            respawned: true,
            before_provider_runtime_fingerprint: before_provider_runtime_fingerprint.clone(),
            after_provider_runtime_fingerprint: before_provider_runtime_fingerprint,
            session_source_id,
            config_synced,
        });
    }

    ensure_all_runtimes_quiescent(sessions, source_runtimes).await?;

    let new_session = spawn_session(
        entry.clone(),
        default_bin,
        target_args.clone(),
        Some(codex_home.clone()),
        settings_snapshot.clone(),
    )
    .await?;
    if new_session.codex_args != effective_target_args
        || new_session.provider_runtime_fingerprint != provider_runtime_fingerprint
    {
        terminate_unpublished_session(&new_session).await;
        return Err(
            "Spawned Codex runtime does not match the requested Provider settings".to_string(),
        );
    }
    let current_settings = app_settings.lock().await;
    if !provider_transaction_matches(
        &current_settings,
        &settings_snapshot,
        &provider_runtime_fingerprint,
        &session_source_id,
    ) {
        terminate_unpublished_session(&new_session).await;
        return Err(
            "Provider settings changed during runtime switch; retrying is required".to_string(),
        );
    }
    if let Err(error) = ensure_all_runtimes_quiescent(sessions, source_runtimes).await {
        terminate_unpublished_session(&new_session).await;
        return Err(error);
    }
    let config_synced = match sync_provider_config(settings_snapshot, codex_home).await {
        Ok(value) => value,
        Err(error) => {
            terminate_unpublished_session(&new_session).await;
            return Err(error);
        }
    };
    let (workspace_ids, replaced_sessions) = {
        let mut sessions = sessions.lock().await;
        let replaced_sessions = unique_session_values(&sessions);
        let keys: Vec<String> = sessions.keys().cloned().collect();
        for key in &keys {
            sessions.insert(key.clone(), Arc::clone(&new_session));
        }
        (keys, replaced_sessions)
    };
    drop(current_settings);
    let workspace_paths = {
        let workspaces = workspaces.lock().await;
        workspace_ids
            .iter()
            .map(|workspace_id| {
                let path = workspaces
                    .get(workspace_id)
                    .map(|entry| entry.path.clone())
                    .unwrap_or_default();
                (workspace_id.clone(), path)
            })
            .collect::<Vec<_>>()
    };
    for (workspace_id, workspace_path) in &workspace_paths {
        let path = if workspace_path.is_empty() {
            None
        } else {
            Some(workspace_path.as_str())
        };
        new_session
            .register_workspace_with_path(workspace_id, path)
            .await;
    }
    if let Some(source_runtimes) = source_runtimes {
        source_runtimes.close_all().await;
    }
    for replaced_session in replaced_sessions {
        if !Arc::ptr_eq(&replaced_session, &new_session) {
            terminate_unpublished_session(&replaced_session).await;
        }
    }

    Ok(WorkspaceRuntimeCodexArgsResult {
        applied_codex_args: target_args,
        respawned: true,
        before_provider_runtime_fingerprint,
        after_provider_runtime_fingerprint: provider_runtime_fingerprint,
        session_source_id,
        config_synced,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::process::Stdio;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use tokio::process::Command;

    use crate::shared::session_manager_core::runtime::SourceRuntimeKey;
    use crate::types::{CodexKeyProfile, WorkspaceKind, WorkspaceSettings};

    fn make_workspace_entry(id: &str) -> WorkspaceEntry {
        WorkspaceEntry {
            id: id.to_string(),
            name: id.to_string(),
            path: "/tmp".to_string(),
            kind: WorkspaceKind::Main,
            parent_id: None,
            worktree: None,
            settings: WorkspaceSettings::default(),
        }
    }

    fn make_session(_entry: WorkspaceEntry, codex_args: Option<String>) -> WorkspaceSession {
        make_session_with_provider(codex_args, None)
    }

    fn make_session_with_provider(
        codex_args: Option<String>,
        provider_runtime_fingerprint: Option<String>,
    ) -> WorkspaceSession {
        let mut cmd = if cfg!(windows) {
            let mut cmd = Command::new("cmd");
            cmd.args(["/C", "more"]);
            cmd
        } else {
            let mut cmd = Command::new("sh");
            cmd.args(["-c", "cat"]);
            cmd
        };

        cmd.stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null());

        let mut child = cmd.spawn().expect("spawn dummy child");
        let stdin = child.stdin.take().expect("dummy child stdin");

        WorkspaceSession::test_new(
            codex_args,
            provider_runtime_fingerprint,
            child,
            stdin,
            "test-owner".to_string(),
        )
    }

    fn make_session_for_settings(
        codex_args: Option<String>,
        settings: &AppSettings,
    ) -> WorkspaceSession {
        let effective =
            active_profile_codex_args(settings, codex_args).expect("resolve effective test args");
        make_session_with_provider(effective, active_profile_runtime_fingerprint(settings))
    }

    async fn make_exited_session_with_provider(
        codex_args: Option<String>,
        provider_runtime_fingerprint: Option<String>,
    ) -> WorkspaceSession {
        let mut cmd = if cfg!(windows) {
            let mut cmd = Command::new("cmd");
            cmd.args(["/C", "exit", "0"]);
            cmd
        } else {
            let mut cmd = Command::new("sh");
            cmd.args(["-c", "true"]);
            cmd
        };
        cmd.stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let mut child = cmd.spawn().expect("spawn exited dummy child");
        let stdin = child.stdin.take().expect("dummy child stdin");
        child.wait().await.expect("wait for dummy child");
        WorkspaceSession::test_new(
            codex_args,
            provider_runtime_fingerprint,
            child,
            stdin,
            "test-owner".to_string(),
        )
    }

    async fn make_exited_session_for_settings(
        codex_args: Option<String>,
        settings: &AppSettings,
    ) -> WorkspaceSession {
        let effective =
            active_profile_codex_args(settings, codex_args).expect("resolve effective test args");
        make_exited_session_with_provider(effective, active_profile_runtime_fingerprint(settings))
            .await
    }

    fn provider_settings(key: &str, sync_local_config: bool) -> AppSettings {
        let mut settings = AppSettings::default();
        settings.codex_key_profiles = vec![CodexKeyProfile {
            id: "profile".to_string(),
            name: "Profile".to_string(),
            provider_kind: "custom".to_string(),
            usage_protocol: "auto".to_string(),
            new_api_access_token: None,
            new_api_session_cookie: None,
            key_env_var: "OPENAI_API_KEY".to_string(),
            key: key.to_string(),
            base_url_env_var: "OPENAI_BASE_URL".to_string(),
            base_url: Some("https://api.example.com/v1".to_string()),
            model: Some("example-model".to_string()),
            context_window: Some(128_000),
            max_output_tokens: None,
            use_gateway: false,
            transport_mode: "auto".to_string(),
            supports_thinking: false,
            supports_reasoning_effort: false,
            last_model_refresh_at_ms: None,
            cached_models: Vec::new(),
            group_name: None,
        }];
        settings.active_codex_key_profile_id = Some("profile".to_string());
        settings.sync_provider_profile_to_local_config = sync_local_config;
        settings
    }

    #[test]
    fn set_workspace_runtime_codex_args_is_noop_when_workspace_not_connected() {
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let entry = make_workspace_entry("ws-1");
            let workspaces = Mutex::new(HashMap::from([(entry.id.clone(), entry.clone())]));
            let sessions = Mutex::new(HashMap::<String, Arc<WorkspaceSession>>::new());
            let app_settings = Mutex::new(AppSettings::default());

            let spawn_calls = Arc::new(AtomicUsize::new(0));
            let spawn_calls_ref = spawn_calls.clone();

            let result = set_workspace_runtime_codex_args_core(
                entry.id.clone(),
                Some("  --profile dev  ".to_string()),
                &workspaces,
                &sessions,
                &app_settings,
                move |_entry, _bin, args, _home, settings| {
                    let spawn_calls_ref = spawn_calls_ref.clone();
                    async move {
                        spawn_calls_ref.fetch_add(1, Ordering::SeqCst);
                        Ok(Arc::new(make_session_for_settings(args, &settings)))
                    }
                },
            )
            .await
            .expect("core call succeeds");

            assert_eq!(result.applied_codex_args, Some("--profile dev".to_string()));
            assert!(!result.respawned);
            assert!(!result.session_source_id.is_empty());
            assert_eq!(spawn_calls.load(Ordering::SeqCst), 0);
        });
    }

    #[test]
    fn set_workspace_runtime_codex_args_is_noop_when_args_match() {
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let entry = make_workspace_entry("ws-1");
            let workspaces = Mutex::new(HashMap::from([(entry.id.clone(), entry.clone())]));
            let current_session = Arc::new(make_session(entry.clone(), Some("--same".to_string())));
            let sessions = Mutex::new(HashMap::from([(entry.id.clone(), current_session)]));
            let app_settings = Mutex::new(AppSettings::default());

            let spawn_calls = Arc::new(AtomicUsize::new(0));
            let spawn_calls_ref = spawn_calls.clone();

            let result = set_workspace_runtime_codex_args_core(
                entry.id.clone(),
                Some("--same".to_string()),
                &workspaces,
                &sessions,
                &app_settings,
                move |_entry, _bin, args, _home, settings| {
                    let spawn_calls_ref = spawn_calls_ref.clone();
                    async move {
                        spawn_calls_ref.fetch_add(1, Ordering::SeqCst);
                        Ok(Arc::new(make_session_for_settings(args, &settings)))
                    }
                },
            )
            .await
            .expect("core call succeeds");

            assert_eq!(result.applied_codex_args, Some("--same".to_string()));
            assert!(!result.respawned);
            assert_eq!(spawn_calls.load(Ordering::SeqCst), 0);
        });
    }

    #[test]
    fn set_workspace_runtime_codex_args_compares_effective_profile_args() {
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let entry = make_workspace_entry("ws-1");
            let workspaces = Mutex::new(HashMap::from([(entry.id.clone(), entry.clone())]));
            let mut settings = AppSettings::default();
            settings.codex_key_profiles = vec![CodexKeyProfile {
                id: "profile".to_string(),
                name: "Profile".to_string(),
                provider_kind: "deepseek".to_string(),
                usage_protocol: "auto".to_string(),
                new_api_access_token: None,
                new_api_session_cookie: None,
                key_env_var: "OPENAI_API_KEY".to_string(),
                key: "sk-test".to_string(),
                base_url_env_var: "OPENAI_BASE_URL".to_string(),
                base_url: None,
                model: Some("deepseek-chat".to_string()),
                context_window: Some(128_000),
                max_output_tokens: None,
                use_gateway: false,
                transport_mode: "auto".to_string(),
                supports_thinking: false,
                supports_reasoning_effort: false,
                last_model_refresh_at_ms: None,
                cached_models: Vec::new(),
                group_name: None,
            }];
            settings.active_codex_key_profile_id = Some("profile".to_string());
            let effective_args =
                active_profile_codex_args(&settings, Some("--profile inherited".to_string()))
                    .expect("effective args");
            let provider_runtime_fingerprint = active_profile_runtime_fingerprint(&settings);
            let current_session = Arc::new(make_session_with_provider(
                effective_args,
                provider_runtime_fingerprint,
            ));
            let sessions = Mutex::new(HashMap::from([(entry.id.clone(), current_session)]));
            let app_settings = Mutex::new(settings);
            let spawn_calls = Arc::new(AtomicUsize::new(0));
            let spawn_calls_ref = spawn_calls.clone();

            let result = set_workspace_runtime_codex_args_core(
                entry.id.clone(),
                Some("--profile inherited".to_string()),
                &workspaces,
                &sessions,
                &app_settings,
                move |_entry, _bin, args, _home, settings| {
                    let spawn_calls_ref = spawn_calls_ref.clone();
                    async move {
                        spawn_calls_ref.fetch_add(1, Ordering::SeqCst);
                        Ok(Arc::new(make_session_for_settings(args, &settings)))
                    }
                },
            )
            .await
            .expect("core call succeeds");

            assert_eq!(
                result.applied_codex_args,
                Some("--profile inherited".to_string())
            );
            assert!(!result.respawned);
            assert_eq!(spawn_calls.load(Ordering::SeqCst), 0);
        });
    }

    #[test]
    fn set_workspace_runtime_codex_args_respawns_when_profile_key_changes() {
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let entry = make_workspace_entry("ws-1");
            let workspaces = Mutex::new(HashMap::from([(entry.id.clone(), entry.clone())]));
            let mut settings = AppSettings::default();
            settings.codex_key_profiles = vec![CodexKeyProfile {
                id: "profile".to_string(),
                name: "Profile".to_string(),
                provider_kind: "deepseek".to_string(),
                usage_protocol: "auto".to_string(),
                new_api_access_token: None,
                new_api_session_cookie: None,
                key_env_var: "OPENAI_API_KEY".to_string(),
                key: "sk-old".to_string(),
                base_url_env_var: "OPENAI_BASE_URL".to_string(),
                base_url: None,
                model: Some("deepseek-chat".to_string()),
                context_window: Some(128_000),
                max_output_tokens: None,
                use_gateway: false,
                transport_mode: "auto".to_string(),
                supports_thinking: false,
                supports_reasoning_effort: false,
                last_model_refresh_at_ms: None,
                cached_models: Vec::new(),
                group_name: None,
            }];
            settings.active_codex_key_profile_id = Some("profile".to_string());
            let effective_args =
                active_profile_codex_args(&settings, Some("--profile inherited".to_string()))
                    .expect("effective args");
            let old_fingerprint = active_profile_runtime_fingerprint(&settings);
            let current_session =
                Arc::new(make_session_with_provider(effective_args, old_fingerprint));
            let sessions = Mutex::new(HashMap::from([(entry.id.clone(), current_session)]));
            settings.codex_key_profiles[0].key = "sk-new".to_string();
            let app_settings = Mutex::new(settings);
            let spawn_calls = Arc::new(AtomicUsize::new(0));
            let spawn_calls_ref = spawn_calls.clone();

            let result = set_workspace_runtime_codex_args_core(
                entry.id.clone(),
                Some("--profile inherited".to_string()),
                &workspaces,
                &sessions,
                &app_settings,
                move |_entry, _bin, args, _home, settings| {
                    let spawn_calls_ref = spawn_calls_ref.clone();
                    async move {
                        spawn_calls_ref.fetch_add(1, Ordering::SeqCst);
                        Ok(Arc::new(make_session_for_settings(args, &settings)))
                    }
                },
            )
            .await
            .expect("core call succeeds");

            assert_eq!(
                result.applied_codex_args,
                Some("--profile inherited".to_string())
            );
            assert!(result.respawned);
            assert_eq!(
                result.after_provider_runtime_fingerprint,
                active_profile_runtime_fingerprint(&*app_settings.lock().await)
            );
            assert_eq!(spawn_calls.load(Ordering::SeqCst), 1);
        });
    }

    #[test]
    fn set_workspace_runtime_codex_args_respawns_when_args_change() {
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let entry = make_workspace_entry("ws-1");
            let workspaces = Mutex::new(HashMap::from([(entry.id.clone(), entry.clone())]));
            let current_session = Arc::new(make_session(entry.clone(), Some("--old".to_string())));
            let sessions = Mutex::new(HashMap::from([(entry.id.clone(), current_session)]));
            let app_settings = Mutex::new(AppSettings::default());

            let spawn_calls = Arc::new(AtomicUsize::new(0));
            let spawn_calls_ref = spawn_calls.clone();

            let result = set_workspace_runtime_codex_args_core(
                entry.id.clone(),
                Some("--new".to_string()),
                &workspaces,
                &sessions,
                &app_settings,
                move |_entry, _bin, args, _home, settings| {
                    let spawn_calls_ref = spawn_calls_ref.clone();
                    async move {
                        spawn_calls_ref.fetch_add(1, Ordering::SeqCst);
                        Ok(Arc::new(make_session_for_settings(args, &settings)))
                    }
                },
            )
            .await
            .expect("core call succeeds");

            assert_eq!(result.applied_codex_args, Some("--new".to_string()));
            assert!(result.respawned);
            assert_eq!(spawn_calls.load(Ordering::SeqCst), 1);

            let next = sessions
                .lock()
                .await
                .get(&entry.id)
                .expect("session updated")
                .codex_args
                .clone();
            assert_eq!(next, Some("--new".to_string()));
        });
    }

    #[test]
    fn set_workspace_runtime_codex_args_does_not_respawn_during_active_turn() {
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let entry = make_workspace_entry("ws-1");
            let workspaces = Mutex::new(HashMap::from([(entry.id.clone(), entry.clone())]));
            let current_session = Arc::new(make_session(entry.clone(), Some("--old".to_string())));
            current_session
                .active_turns
                .lock()
                .await
                .insert("thread-2".to_string(), "turn-2".to_string());
            let sessions = Mutex::new(HashMap::from([(entry.id.clone(), current_session)]));
            let app_settings = Mutex::new(AppSettings::default());
            let spawn_calls = Arc::new(AtomicUsize::new(0));
            let spawn_calls_ref = spawn_calls.clone();

            let error = set_workspace_runtime_codex_args_core(
                entry.id.clone(),
                Some("--new".to_string()),
                &workspaces,
                &sessions,
                &app_settings,
                move |_entry, _bin, args, _home, settings| {
                    let spawn_calls_ref = spawn_calls_ref.clone();
                    async move {
                        spawn_calls_ref.fetch_add(1, Ordering::SeqCst);
                        Ok(Arc::new(make_session_for_settings(args, &settings)))
                    }
                },
            )
            .await
            .expect_err("active turn blocks runtime restart");

            assert!(error.contains("another thread is processing"));
            assert_eq!(spawn_calls.load(Ordering::SeqCst), 0);
        });
    }

    #[test]
    fn provider_switch_checks_active_turns_across_all_runtime_sessions() {
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let entry = make_workspace_entry("ws-1");
            let hidden_entry = make_workspace_entry("ws-hidden");
            let current = Arc::new(make_session(entry.clone(), Some("--old".to_string())));
            let hidden = Arc::new(make_session(
                hidden_entry.clone(),
                Some("--old".to_string()),
            ));
            hidden
                .active_turns
                .lock()
                .await
                .insert("hidden-thread".to_string(), "hidden-turn".to_string());
            let workspaces = Mutex::new(HashMap::from([
                (entry.id.clone(), entry.clone()),
                (hidden_entry.id.clone(), hidden_entry),
            ]));
            let sessions = Mutex::new(HashMap::from([
                (entry.id.clone(), current),
                ("ws-hidden".to_string(), hidden),
            ]));
            let app_settings = Mutex::new(AppSettings::default());
            let spawn_calls = Arc::new(AtomicUsize::new(0));
            let spawn_calls_ref = spawn_calls.clone();

            let error = set_workspace_runtime_codex_args_core(
                entry.id,
                Some("--new".to_string()),
                &workspaces,
                &sessions,
                &app_settings,
                move |_entry, _bin, args, _home, settings| {
                    let spawn_calls_ref = spawn_calls_ref.clone();
                    async move {
                        spawn_calls_ref.fetch_add(1, Ordering::SeqCst);
                        Ok(Arc::new(make_session_for_settings(args, &settings)))
                    }
                },
            )
            .await
            .expect_err("hidden active turn must block the global runtime switch");

            assert!(error.contains("another thread is processing"));
            assert_eq!(spawn_calls.load(Ordering::SeqCst), 0);
        });
    }

    #[test]
    fn provider_switch_gate_prevents_a_new_turn_from_crossing_runtime_selection() {
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let entry = make_workspace_entry("ws-1");
            let current = Arc::new(make_session(entry.clone(), Some("--old".to_string())));
            let workspaces = Arc::new(Mutex::new(HashMap::from([(
                entry.id.clone(),
                entry.clone(),
            )])));
            let sessions = Arc::new(Mutex::new(HashMap::from([(
                entry.id.clone(),
                current.clone(),
            )])));
            let app_settings = Arc::new(Mutex::new(AppSettings::default()));
            let turn_gate = provider_runtime_switch_gate().read().await;
            let workspaces_for_switch = workspaces.clone();
            let sessions_for_switch = sessions.clone();
            let settings_for_switch = app_settings.clone();
            let switch = tokio::spawn(async move {
                set_workspace_runtime_codex_args_core(
                    entry.id,
                    Some("--new".to_string()),
                    &workspaces_for_switch,
                    &sessions_for_switch,
                    &settings_for_switch,
                    |_entry, _bin, args, _home, settings| async move {
                        Ok(Arc::new(make_session_for_settings(args, &settings)))
                    },
                )
                .await
            });

            tokio::task::yield_now().await;
            current
                .active_turns
                .lock()
                .await
                .insert("thread-1".to_string(), "pending-turn".to_string());
            drop(turn_gate);

            let error = switch
                .await
                .unwrap()
                .expect_err("turn registered under the read gate must block Provider switch");
            assert!(error.contains("another thread is processing"));
        });
    }

    #[test]
    fn provider_switch_checks_active_turns_in_session_source_runtime_pool() {
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let entry = make_workspace_entry("ws-1");
            let current = Arc::new(make_session(entry.clone(), Some("--old".to_string())));
            let source_session = Arc::new(make_session(
                entry.clone(),
                Some("--source-old".to_string()),
            ));
            source_session
                .active_turns
                .lock()
                .await
                .insert("source-thread".to_string(), "source-turn".to_string());
            let source_runtimes = SessionSourceRuntimePool::for_workspace_sessions();
            let source_session_for_pool = source_session.clone();
            source_runtimes
                .get_or_spawn(
                    SourceRuntimeKey::new("C:/codex-source", "C:/workspace").unwrap(),
                    || async move { Ok(source_session_for_pool) },
                )
                .await
                .unwrap();
            let workspaces = Mutex::new(HashMap::from([(entry.id.clone(), entry.clone())]));
            let sessions = Mutex::new(HashMap::from([(entry.id.clone(), current)]));
            let app_settings = Mutex::new(AppSettings::default());

            let error = set_workspace_runtime_codex_args_with_source_runtimes_core(
                entry.id,
                Some("--new".to_string()),
                &workspaces,
                &sessions,
                &app_settings,
                &source_runtimes,
                |_entry, _bin, args, _home, settings| async move {
                    Ok(Arc::new(make_session_for_settings(args, &settings)))
                },
            )
            .await
            .expect_err("source runtime active turn must block Provider switch");

            assert!(error.contains("another thread is processing"));
        });
    }

    #[test]
    fn successful_provider_switch_terminates_all_replaced_runtime_sessions() {
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let entry = make_workspace_entry("ws-1");
            let second_entry = make_workspace_entry("ws-2");
            let current = Arc::new(make_session(entry.clone(), Some("--old".to_string())));
            let second = Arc::new(make_session(
                second_entry.clone(),
                Some("--other-old".to_string()),
            ));
            let source_session = Arc::new(make_session(
                entry.clone(),
                Some("--source-old".to_string()),
            ));
            let source_runtimes = SessionSourceRuntimePool::for_workspace_sessions();
            let source_session_for_pool = source_session.clone();
            source_runtimes
                .get_or_spawn(
                    SourceRuntimeKey::new("C:/codex-source", "C:/workspace").unwrap(),
                    || async move { Ok(source_session_for_pool) },
                )
                .await
                .unwrap();
            let workspaces = Mutex::new(HashMap::from([
                (entry.id.clone(), entry.clone()),
                (second_entry.id.clone(), second_entry),
            ]));
            let sessions = Mutex::new(HashMap::from([
                (entry.id.clone(), current.clone()),
                ("ws-2".to_string(), second.clone()),
            ]));
            let app_settings = Mutex::new(AppSettings::default());

            let result = set_workspace_runtime_codex_args_with_source_runtimes_core(
                entry.id,
                Some("--new".to_string()),
                &workspaces,
                &sessions,
                &app_settings,
                &source_runtimes,
                |_entry, _bin, args, _home, settings| async move {
                    Ok(Arc::new(make_session_for_settings(args, &settings)))
                },
            )
            .await
            .expect("provider switch succeeds");

            assert!(result.respawned);
            assert!(current.child.lock().await.try_wait().unwrap().is_some());
            assert!(second.child.lock().await.try_wait().unwrap().is_some());
            assert!(source_session
                .child
                .lock()
                .await
                .try_wait()
                .unwrap()
                .is_some());
            assert!(source_runtimes.sessions_snapshot().await.is_empty());
            let published = sessions.lock().await;
            assert!(Arc::ptr_eq(&published["ws-1"], &published["ws-2"]));
        });
    }

    #[test]
    fn matching_primary_runtime_invalidates_stale_source_runtimes() {
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let entry = make_workspace_entry("ws-1");
            let target_settings = provider_settings("key-b", false);
            let stale_settings = provider_settings("key-a", false);
            let target_args = Some("--current".to_string());
            let current = Arc::new(
                make_exited_session_for_settings(target_args.clone(), &target_settings).await,
            );
            let source_session = Arc::new(
                make_exited_session_for_settings(target_args.clone(), &stale_settings).await,
            );
            let source_runtimes = SessionSourceRuntimePool::for_workspace_sessions();
            let source_session_for_pool = source_session.clone();
            source_runtimes
                .get_or_spawn(
                    SourceRuntimeKey::new("C:/codex-source", "C:/workspace").unwrap(),
                    || async move { Ok(source_session_for_pool) },
                )
                .await
                .unwrap();
            let workspaces = Mutex::new(HashMap::from([(entry.id.clone(), entry.clone())]));
            let sessions = Mutex::new(HashMap::from([(entry.id.clone(), current.clone())]));
            let app_settings = Mutex::new(target_settings);
            let spawn_calls = Arc::new(AtomicUsize::new(0));
            let spawn_calls_ref = spawn_calls.clone();

            let result = set_workspace_runtime_codex_args_with_source_runtimes_core(
                entry.id,
                target_args,
                &workspaces,
                &sessions,
                &app_settings,
                &source_runtimes,
                move |_entry, _bin, args, _home, settings| {
                    let spawn_calls_ref = spawn_calls_ref.clone();
                    async move {
                        spawn_calls_ref.fetch_add(1, Ordering::SeqCst);
                        Ok(Arc::new(make_session_for_settings(args, &settings)))
                    }
                },
            )
            .await
            .expect("stale source runtime cleanup succeeds");

            let source_pool_is_empty = source_runtimes.sessions_snapshot().await.is_empty();
            let source_was_closed = source_session.output_closed.load(Ordering::SeqCst);

            assert!(result.respawned);
            assert_eq!(spawn_calls.load(Ordering::SeqCst), 0);
            assert!(source_pool_is_empty);
            assert!(source_was_closed);
            assert!(!current.output_closed.load(Ordering::SeqCst));
        });
    }

    #[test]
    fn matching_primary_runtime_keeps_busy_stale_source_runtime() {
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let entry = make_workspace_entry("ws-1");
            let target_settings = provider_settings("key-b", false);
            let stale_settings = provider_settings("key-a", false);
            let target_args = Some("--current".to_string());
            let current = Arc::new(
                make_exited_session_for_settings(target_args.clone(), &target_settings).await,
            );
            let source_session = Arc::new(
                make_exited_session_for_settings(target_args.clone(), &stale_settings).await,
            );
            source_session
                .active_turns
                .lock()
                .await
                .insert("source-thread".to_string(), "source-turn".to_string());
            let source_runtimes = SessionSourceRuntimePool::for_workspace_sessions();
            let source_session_for_pool = source_session.clone();
            source_runtimes
                .get_or_spawn(
                    SourceRuntimeKey::new("C:/codex-source", "C:/workspace").unwrap(),
                    || async move { Ok(source_session_for_pool) },
                )
                .await
                .unwrap();
            let workspaces = Mutex::new(HashMap::from([(entry.id.clone(), entry.clone())]));
            let sessions = Mutex::new(HashMap::from([(entry.id.clone(), current)]));
            let app_settings = Mutex::new(target_settings);

            let error = set_workspace_runtime_codex_args_with_source_runtimes_core(
                entry.id,
                target_args,
                &workspaces,
                &sessions,
                &app_settings,
                &source_runtimes,
                |_entry, _bin, args, _home, settings| async move {
                    Ok(Arc::new(make_session_for_settings(args, &settings)))
                },
            )
            .await
            .expect_err("busy stale source runtime blocks cleanup");

            assert!(error.contains("another thread is processing"));
            assert_eq!(source_runtimes.sessions_snapshot().await.len(), 1);
            assert!(!source_session.output_closed.load(Ordering::SeqCst));
        });
    }

    #[test]
    fn matching_primary_runtime_ignores_history_runtime_identity() {
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let entry = make_workspace_entry("ws-1");
            let target_settings = provider_settings("key-b", false);
            let target_args = Some("--current".to_string());
            let current = Arc::new(
                make_exited_session_for_settings(target_args.clone(), &target_settings).await,
            );
            let history_session = Arc::new(
                make_exited_session_with_provider(Some("--history".to_string()), None).await,
            );
            let source_runtimes = SessionSourceRuntimePool::for_workspace_sessions();
            let history_session_for_pool = history_session.clone();
            source_runtimes
                .get_or_spawn(
                    SourceRuntimeKey::for_purpose(
                        "C:/codex-source",
                        "C:/workspace",
                        SourceRuntimePurpose::History,
                    )
                    .unwrap(),
                    || async move { Ok(history_session_for_pool) },
                )
                .await
                .unwrap();
            let workspaces = Mutex::new(HashMap::from([(entry.id.clone(), entry.clone())]));
            let sessions = Mutex::new(HashMap::from([(entry.id.clone(), current)]));
            let app_settings = Mutex::new(target_settings);
            let spawn_calls = Arc::new(AtomicUsize::new(0));
            let spawn_calls_ref = spawn_calls.clone();

            let result = set_workspace_runtime_codex_args_with_source_runtimes_core(
                entry.id,
                target_args,
                &workspaces,
                &sessions,
                &app_settings,
                &source_runtimes,
                move |_entry, _bin, args, _home, settings| {
                    let spawn_calls_ref = spawn_calls_ref.clone();
                    async move {
                        spawn_calls_ref.fetch_add(1, Ordering::SeqCst);
                        Ok(Arc::new(make_session_for_settings(args, &settings)))
                    }
                },
            )
            .await
            .expect("history runtime does not invalidate matching execution runtime");

            assert!(!result.respawned);
            assert_eq!(spawn_calls.load(Ordering::SeqCst), 0);
            assert_eq!(source_runtimes.sessions_snapshot().await.len(), 1);
            assert!(!history_session.output_closed.load(Ordering::SeqCst));
        });
    }

    #[test]
    fn failed_provider_runtime_spawn_keeps_the_previous_session() {
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let entry = make_workspace_entry("ws-1");
            let current = Arc::new(make_session(entry.clone(), Some("--old".to_string())));
            let workspaces = Mutex::new(HashMap::from([(entry.id.clone(), entry.clone())]));
            let sessions = Mutex::new(HashMap::from([(entry.id.clone(), current.clone())]));
            let app_settings = Mutex::new(AppSettings::default());

            let error =
                set_workspace_runtime_codex_args_core(
                    entry.id.clone(),
                    Some("--new".to_string()),
                    &workspaces,
                    &sessions,
                    &app_settings,
                    |_entry, _bin, _args, _home, _settings| async move {
                        Err("spawn failed".to_string())
                    },
                )
                .await
                .expect_err("spawn failure must abort the transaction");

            assert_eq!(error, "spawn failed");
            let retained = sessions.lock().await[&entry.id].clone();
            assert!(Arc::ptr_eq(&retained, &current));
        });
    }

    #[test]
    fn config_sync_failure_discards_new_runtime_and_keeps_previous_session() {
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let root = std::env::temp_dir().join(format!(
                "codex-monitor-provider-switch-config-{}",
                uuid::Uuid::new_v4()
            ));
            std::fs::create_dir_all(&root).unwrap();
            let entry = make_workspace_entry("ws-1");
            let current = Arc::new(make_session(entry.clone(), Some("--old".to_string())));
            let workspaces = Mutex::new(HashMap::from([(entry.id.clone(), entry.clone())]));
            let sessions = Mutex::new(HashMap::from([(entry.id.clone(), current.clone())]));
            let mut settings = provider_settings("sk-new", true);
            settings.codex_home = Some(root.to_string_lossy().to_string());
            settings.codex_key_profiles[0].use_gateway = true;
            let app_settings = Mutex::new(settings);

            let error = set_workspace_runtime_codex_args_core(
                entry.id.clone(),
                None,
                &workspaces,
                &sessions,
                &app_settings,
                |_entry, _bin, args, _home, settings| async move {
                    Ok(Arc::new(make_session_for_settings(args, &settings)))
                },
            )
            .await
            .expect_err("gateway profile cannot sync to config.toml");

            assert!(error.contains("gateway"));
            let retained = sessions.lock().await[&entry.id].clone();
            assert!(Arc::ptr_eq(&retained, &current));
            assert!(!root.join("config.toml").exists());
            let _ = std::fs::remove_dir_all(root);
        });
    }

    #[test]
    fn concurrent_provider_change_rejects_stale_runtime_without_source_drift() {
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let root = std::env::temp_dir().join(format!(
                "codex-monitor-provider-switch-source-{}",
                uuid::Uuid::new_v4()
            ));
            std::fs::create_dir_all(&root).unwrap();
            let entry = make_workspace_entry("ws-1");
            let current = Arc::new(make_session(entry.clone(), Some("--old".to_string())));
            let workspaces = Mutex::new(HashMap::from([(entry.id.clone(), entry.clone())]));
            let sessions = Mutex::new(HashMap::from([(entry.id.clone(), current.clone())]));
            let mut settings = provider_settings("sk-a", false);
            settings.codex_home = Some(root.to_string_lossy().to_string());
            let app_settings = Arc::new(Mutex::new(settings));
            let settings_for_spawn = app_settings.clone();

            let error = set_workspace_runtime_codex_args_core(
                entry.id.clone(),
                None,
                &workspaces,
                &sessions,
                app_settings.as_ref(),
                move |_entry, _bin, args, home, settings| {
                    let settings_for_spawn = settings_for_spawn.clone();
                    async move {
                        assert_eq!(
                            home.as_deref(),
                            resolve_settings_codex_home(&settings).as_deref()
                        );
                        settings_for_spawn.lock().await.codex_key_profiles[0].key =
                            "sk-b".to_string();
                        Ok(Arc::new(make_session_for_settings(args, &settings)))
                    }
                },
            )
            .await
            .expect_err("stale provider transaction must be rejected");

            assert!(error.contains("settings changed"));
            let retained = sessions.lock().await[&entry.id].clone();
            assert!(Arc::ptr_eq(&retained, &current));
            assert_eq!(
                source_id_for_codex_home(&root),
                source_id_for_codex_home(
                    &resolve_settings_codex_home(&*app_settings.lock().await).unwrap()
                )
            );
            let _ = std::fs::remove_dir_all(root);
        });
    }

    #[test]
    fn concurrent_config_sync_change_rejects_stale_provider_transaction() {
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let root = std::env::temp_dir().join(format!(
                "codex-monitor-provider-switch-sync-setting-{}",
                uuid::Uuid::new_v4()
            ));
            std::fs::create_dir_all(&root).unwrap();
            let entry = make_workspace_entry("ws-1");
            let current = Arc::new(make_session(entry.clone(), Some("--old".to_string())));
            let workspaces = Mutex::new(HashMap::from([(entry.id.clone(), entry.clone())]));
            let sessions = Mutex::new(HashMap::from([(entry.id.clone(), current.clone())]));
            let mut settings = provider_settings("sk-a", false);
            settings.codex_home = Some(root.to_string_lossy().to_string());
            let app_settings = Arc::new(Mutex::new(settings));
            let settings_for_spawn = app_settings.clone();

            let error = set_workspace_runtime_codex_args_core(
                entry.id.clone(),
                None,
                &workspaces,
                &sessions,
                app_settings.as_ref(),
                move |_entry, _bin, args, _home, settings| {
                    let settings_for_spawn = settings_for_spawn.clone();
                    async move {
                        settings_for_spawn
                            .lock()
                            .await
                            .sync_provider_profile_to_local_config = true;
                        Ok(Arc::new(make_session_for_settings(args, &settings)))
                    }
                },
            )
            .await
            .expect_err("changed config sync mode must invalidate the transaction");

            assert!(error.contains("settings changed"));
            let retained = sessions.lock().await[&entry.id].clone();
            assert!(Arc::ptr_eq(&retained, &current));
            assert!(!root.join("config.toml").exists());
            let _ = std::fs::remove_dir_all(root);
        });
    }

    #[test]
    fn successful_provider_transaction_syncs_config_and_preserves_source_identity() {
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let root = std::env::temp_dir().join(format!(
                "codex-monitor-provider-switch-success-{}",
                uuid::Uuid::new_v4()
            ));
            std::fs::create_dir_all(&root).unwrap();
            std::fs::write(root.join("config.toml"), "approval_policy = \"never\"\n").unwrap();
            let entry = make_workspace_entry("ws-1");
            let current = Arc::new(make_session(entry.clone(), Some("--old".to_string())));
            let workspaces = Mutex::new(HashMap::from([(entry.id.clone(), entry.clone())]));
            let sessions = Mutex::new(HashMap::from([(entry.id.clone(), current.clone())]));
            let mut settings = provider_settings("super-secret-key", true);
            settings.codex_home = Some(root.to_string_lossy().to_string());
            let expected_fingerprint = active_profile_runtime_fingerprint(&settings);
            let app_settings = Mutex::new(settings);
            let spawned_home = Arc::new(Mutex::new(None::<PathBuf>));
            let spawned_home_ref = spawned_home.clone();

            let result = set_workspace_runtime_codex_args_core(
                entry.id.clone(),
                None,
                &workspaces,
                &sessions,
                &app_settings,
                move |_entry, _bin, args, home, settings| {
                    let spawned_home_ref = spawned_home_ref.clone();
                    async move {
                        *spawned_home_ref.lock().await = home;
                        Ok(Arc::new(make_session_for_settings(args, &settings)))
                    }
                },
            )
            .await
            .expect("provider transaction succeeds");

            assert!(result.respawned);
            assert!(result.config_synced);
            assert_eq!(result.before_provider_runtime_fingerprint, None);
            assert_eq!(
                result.after_provider_runtime_fingerprint,
                expected_fingerprint
            );
            assert_eq!(result.session_source_id, source_id_for_codex_home(&root));
            assert_eq!(spawned_home.lock().await.as_deref(), Some(root.as_path()));
            let published = sessions.lock().await[&entry.id].clone();
            assert!(!Arc::ptr_eq(&published, &current));
            assert_eq!(published.provider_runtime_fingerprint, expected_fingerprint);
            let config = std::fs::read_to_string(root.join("config.toml")).unwrap();
            assert!(config.contains("approval_policy = \"never\""));
            assert!(config.contains("model_provider = \"codex_monitor\""));
            assert!(!config.contains("super-secret-key"));
            let _ = std::fs::remove_dir_all(root);
        });
    }
}
