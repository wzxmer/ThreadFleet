mod protocol;
mod tcp_transport;
mod transport;

use serde_json::{json, Value};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tauri::AppHandle;
use tokio::sync::Mutex;
use tokio::time::timeout;

use crate::state::AppState;
use crate::types::BackendMode;

use self::protocol::{build_request_line, DEFAULT_REMOTE_HOST, DISCONNECTED_MESSAGE};
use self::tcp_transport::TcpTransport;
use self::transport::{PendingMap, RemoteTransport, RemoteTransportConfig, RemoteTransportKind};

const REMOTE_REQUEST_TIMEOUT: Duration = Duration::from_secs(300);
const REMOTE_LONG_RUNNING_REQUEST_TIMEOUT: Duration = Duration::from_secs(3600);
const REMOTE_SEND_TIMEOUT: Duration = Duration::from_secs(15);

pub(crate) fn normalize_path_for_remote(path: String) -> String {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return path;
    }

    if let Some(normalized) = normalize_wsl_unc_path(trimmed) {
        return normalized;
    }

    path
}

fn normalize_wsl_unc_path(path: &str) -> Option<String> {
    let lower = path.to_ascii_lowercase();
    let (prefix_len, raw) = if lower.starts_with("\\\\wsl$\\") {
        (7, path)
    } else if lower.starts_with("\\\\wsl.localhost\\") {
        (16, path)
    } else {
        return None;
    };

    let remainder = raw.get(prefix_len..)?;
    let mut segments = remainder.split('\\').filter(|segment| !segment.is_empty());
    segments.next()?;
    let joined = segments.collect::<Vec<_>>().join("/");
    Some(if joined.is_empty() {
        "/".to_string()
    } else {
        format!("/{joined}")
    })
}

#[derive(Clone)]
pub(crate) struct RemoteBackend {
    inner: Arc<RemoteBackendInner>,
}

struct RemoteBackendInner {
    out_tx: tokio::sync::mpsc::Sender<String>,
    pending: Arc<Mutex<PendingMap>>,
    next_id: AtomicU64,
    connected: Arc<std::sync::atomic::AtomicBool>,
}

impl RemoteBackend {
    pub(crate) async fn call(&self, method: &str, params: Value) -> Result<Value, String> {
        if !self.inner.connected.load(Ordering::SeqCst) {
            return Err(DISCONNECTED_MESSAGE.to_string());
        }

        let id = self.inner.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = tokio::sync::oneshot::channel();
        self.inner.pending.lock().await.insert(id, tx);

        let message = build_request_line(id, method, params)?;
        match timeout(REMOTE_SEND_TIMEOUT, self.inner.out_tx.send(message)).await {
            Ok(Ok(())) => {}
            Ok(Err(_)) => {
                self.inner.pending.lock().await.remove(&id);
                return Err(DISCONNECTED_MESSAGE.to_string());
            }
            Err(_) => {
                self.inner.pending.lock().await.remove(&id);
                return Err(format!(
                    "remote backend request dispatch timed out after {} seconds",
                    REMOTE_SEND_TIMEOUT.as_secs()
                ));
            }
        }

        let request_timeout = request_timeout_for_method(method);
        match timeout(request_timeout, rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(DISCONNECTED_MESSAGE.to_string()),
            Err(_) => {
                self.inner.pending.lock().await.remove(&id);
                Err(format!(
                    "remote backend request timed out after {} seconds",
                    request_timeout.as_secs()
                ))
            }
        }
    }
}

fn request_timeout_for_method(method: &str) -> Duration {
    if matches!(
        method,
        "send_user_message"
            | "start_review"
            | "preview_managed_session_cleanup"
            | "fetch_managed_session_preview"
            | "cleanup_managed_sessions_now"
            | "run_managed_session_cleanup_scheduler"
    ) {
        REMOTE_LONG_RUNNING_REQUEST_TIMEOUT
    } else {
        REMOTE_REQUEST_TIMEOUT
    }
}

pub(crate) async fn is_remote_mode(state: &AppState) -> bool {
    let settings = state.app_settings.lock().await;
    matches!(settings.backend_mode, BackendMode::Remote)
}

pub(crate) async fn call_remote(
    state: &AppState,
    app: AppHandle,
    method: &str,
    params: Value,
) -> Result<Value, String> {
    let client = ensure_remote_backend(state, app.clone()).await?;
    match client.call(method, params.clone()).await {
        Ok(value) => Ok(value),
        Err(err) if err == DISCONNECTED_MESSAGE => {
            *state.remote_backend.lock().await = None;
            if !can_retry_after_disconnect(method) {
                return Err(err);
            }
            let retry_client = ensure_remote_backend(state, app).await?;
            match retry_client.call(method, params).await {
                Ok(value) => Ok(value),
                Err(retry_err) => {
                    *state.remote_backend.lock().await = None;
                    Err(retry_err)
                }
            }
        }
        Err(err) => {
            *state.remote_backend.lock().await = None;
            Err(err)
        }
    }
}

fn can_retry_after_disconnect(method: &str) -> bool {
    matches!(
        method,
        "account_rate_limits"
            | "account_read"
            | "apps_list"
            | "collaboration_mode_list"
            | "computer_control_status"
            | "computer_control_preflight"
            | "connect_workspace"
            | "experimental_feature_list"
            | "set_workspace_runtime_codex_args"
            | "file_read"
            | "get_agents_settings"
            | "get_codex_status"
            | "get_config_model"
            | "get_provider_status"
            | "get_thread_token_usage"
            | "provider_model_list"
            | "provider_function_tool_probe"
            | "third_party_key_usage"
            | "workspace_third_party_key_usage"
            | "get_git_commit_diff"
            | "get_git_diffs"
            | "get_git_log"
            | "get_git_remote"
            | "get_git_status"
            | "get_github_issues"
            | "get_github_pull_request_comments"
            | "get_github_pull_request_diff"
            | "get_github_pull_requests"
            | "is_workspace_path_dir"
            | "list_git_branches"
            | "list_git_roots"
            | "list_mcp_server_status"
            | "list_session_sources"
            | "verify_session_threads"
            | "list_threads"
            | "local_usage_snapshot"
            | "list_workspace_files"
            | "list_workspaces"
            | "model_list"
            | "read_thread"
            | "read_thread_page"
            | "fetch_managed_sessions_page"
            | "fetch_managed_session_preview"
            | "search_managed_sessions"
            | "fetch_session_search_results"
            | "rollback_thread"
            | "read_agent_config_toml"
            | "read_workspace_file"
            | "resume_thread"
            | "thread_live_subscribe"
            | "thread_live_unsubscribe"
            | "skills_list"
            | "execution_binding_register"
            | "execution_binding_observe"
            | "execution_binding_list"
            | "execution_router_shadow_preview"
            | "workflow_preflight_preview"
            | "workflow_gate_status"
            | "knowledge_status"
            | "knowledge_query"
            | "knowledge_intake_capture"
            | "knowledge_task_init"
            | "worktree_setup_status"
    )
}

async fn ensure_remote_backend(state: &AppState, app: AppHandle) -> Result<RemoteBackend, String> {
    {
        let guard = state.remote_backend.lock().await;
        if let Some(client) = guard.as_ref() {
            return Ok(client.clone());
        }
    }

    let transport_config = {
        let settings = state.app_settings.lock().await;
        resolve_transport_config(&settings)?
    };
    let transport_kind = transport_config.kind();
    let auth_token = transport_config.auth_token().map(|value| value.to_string());

    let transport: Box<dyn RemoteTransport> = match transport_config.kind() {
        RemoteTransportKind::Tcp => Box::new(TcpTransport),
    };
    let connection = transport.connect(app, transport_config).await?;

    let client = RemoteBackend {
        inner: Arc::new(RemoteBackendInner {
            out_tx: connection.out_tx,
            pending: connection.pending,
            next_id: AtomicU64::new(1),
            connected: connection.connected,
        }),
    };

    if matches!(transport_kind, RemoteTransportKind::Tcp) {
        if let Some(token) = auth_token {
            client
                .call("auth", json!({ "token": token }))
                .await
                .map(|_| ())?;
        }
    }

    {
        let mut guard = state.remote_backend.lock().await;
        *guard = Some(client.clone());
    }

    Ok(client)
}

fn resolve_transport_config(
    settings: &crate::types::AppSettings,
) -> Result<RemoteTransportConfig, String> {
    let host = if settings.remote_backend_host.trim().is_empty() {
        DEFAULT_REMOTE_HOST.to_string()
    } else {
        settings.remote_backend_host.clone()
    };
    Ok(RemoteTransportConfig::Tcp {
        host,
        auth_token: settings.remote_backend_token.clone(),
    })
}

#[cfg(test)]
mod tests {
    use super::{
        can_retry_after_disconnect, request_timeout_for_method, resolve_transport_config,
        REMOTE_LONG_RUNNING_REQUEST_TIMEOUT, REMOTE_REQUEST_TIMEOUT,
    };
    use crate::remote_backend::transport::RemoteTransportConfig;
    use crate::types::AppSettings;

    #[test]
    fn resolve_tcp_transport_uses_remote_host() {
        let mut settings = AppSettings::default();
        settings.remote_backend_host = "tcp.example:4732".to_string();

        let config = resolve_transport_config(&settings).expect("transport config");
        let RemoteTransportConfig::Tcp { host, .. } = config;
        assert_eq!(host, "tcp.example:4732");
    }

    #[test]
    fn retries_only_retry_safe_methods_after_disconnect() {
        assert!(can_retry_after_disconnect("resume_thread"));
        assert!(can_retry_after_disconnect("get_thread_token_usage"));
        assert!(can_retry_after_disconnect("list_threads"));
        assert!(can_retry_after_disconnect("list_session_sources"));
        assert!(can_retry_after_disconnect("verify_session_threads"));
        assert!(can_retry_after_disconnect("fetch_managed_sessions_page"));
        assert!(can_retry_after_disconnect("search_managed_sessions"));
        assert!(can_retry_after_disconnect("fetch_session_search_results"));
        assert!(can_retry_after_disconnect("local_usage_snapshot"));
        assert!(can_retry_after_disconnect(
            "execution_router_shadow_preview"
        ));
        assert!(can_retry_after_disconnect("execution_binding_register"));
        assert!(can_retry_after_disconnect("execution_binding_observe"));
        assert!(can_retry_after_disconnect("execution_binding_list"));
        assert!(!can_retry_after_disconnect("send_user_message"));
        assert!(!can_retry_after_disconnect("start_thread"));
        assert!(!can_retry_after_disconnect("remove_workspace"));
        assert!(!can_retry_after_disconnect("scan_managed_sessions"));
        assert!(!can_retry_after_disconnect("update_session_source"));
        assert!(!can_retry_after_disconnect("cancel_session_task"));
        assert!(!can_retry_after_disconnect("cleanup_managed_sessions_now"));
        assert!(!can_retry_after_disconnect(
            "run_managed_session_cleanup_scheduler"
        ));
    }

    #[test]
    fn long_running_remote_methods_use_extended_timeout() {
        assert_eq!(
            request_timeout_for_method("send_user_message"),
            REMOTE_LONG_RUNNING_REQUEST_TIMEOUT
        );
        assert_eq!(
            request_timeout_for_method("start_review"),
            REMOTE_LONG_RUNNING_REQUEST_TIMEOUT
        );
        assert_eq!(
            request_timeout_for_method("preview_managed_session_cleanup"),
            REMOTE_LONG_RUNNING_REQUEST_TIMEOUT
        );
        assert_eq!(
            request_timeout_for_method("cleanup_managed_sessions_now"),
            REMOTE_LONG_RUNNING_REQUEST_TIMEOUT
        );
        assert_eq!(
            request_timeout_for_method("run_managed_session_cleanup_scheduler"),
            REMOTE_LONG_RUNNING_REQUEST_TIMEOUT
        );
        assert_eq!(
            request_timeout_for_method("list_threads"),
            REMOTE_REQUEST_TIMEOUT
        );
    }
}
