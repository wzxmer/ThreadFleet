use serde_json::{json, Value};
use tauri::{AppHandle, State};

use crate::event_sink::TauriEventSink;
use crate::remote_backend;
use crate::shared::cli_discovery_core;
use crate::state::AppState;
use crate::types::AgentCliCandidate;

#[tauri::command]
pub(crate) async fn discover_agent_clis(
    engine: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<Vec<AgentCliCandidate>, String> {
    if remote_backend::is_remote_mode(&state).await {
        let value = remote_backend::call_remote(
            &state,
            app,
            "discover_agent_clis",
            json!({ "engine": engine }),
        )
        .await?;
        return serde_json::from_value(value).map_err(|error| error.to_string());
    }
    let settings = state.app_settings.lock().await.clone();
    let configured = match engine.as_str() {
        "codex" => settings.codex_bin.as_deref(),
        "gemini" => settings.gemini_bin.as_deref(),
        _ => return Err("Unsupported agent engine".into()),
    };
    let managed_root = state
        .settings_path
        .parent()
        .map(|dir| dir.join("managed-codex"));
    cli_discovery_core::discover_agent_clis(&engine, configured, managed_root.as_deref()).await
}

#[tauri::command]
pub(crate) async fn agent_runtime_request(
    workspace_id: String,
    operation: String,
    params: Value,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<Value, String> {
    if remote_backend::is_remote_mode(&state).await {
        return remote_backend::call_remote(
            &state,
            app,
            "agent_runtime_request",
            json!({
                "workspaceId": workspace_id, "operation": operation, "params": params,
            }),
        )
        .await;
    }
    let workspace = state
        .workspaces
        .lock()
        .await
        .get(&workspace_id)
        .cloned()
        .ok_or_else(|| "Workspace not found".to_string())?;
    let launch = crate::shared::gemini_runtime_core::LaunchConfig::from_settings(
        &*state.app_settings.lock().await,
    );
    state
        .gemini_runtime
        .request(
            &workspace_id,
            &workspace.path,
            launch,
            &operation,
            params,
            TauriEventSink::new(app),
        )
        .await
}
