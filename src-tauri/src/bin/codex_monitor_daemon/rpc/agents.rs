use super::*;

pub(super) async fn try_handle(
    state: &DaemonState,
    method: &str,
    params: &Value,
) -> Option<Result<Value, String>> {
    match method {
        "discover_agent_clis" => Some(discover(state, params).await),
        "agent_runtime_request" => Some(request(state, params).await),
        _ => None,
    }
}

async fn discover(state: &DaemonState, params: &Value) -> Result<Value, String> {
    let engine = parse_string(params, "engine")?;
    let settings = state.app_settings.lock().await.clone();
    let configured = match engine.as_str() {
        "codex" => settings.codex_bin.as_deref(),
        "gemini" => settings.gemini_bin.as_deref(),
        _ => return Err("Unsupported agent engine".into()),
    };
    let managed_root = state.data_dir.join("managed-codex");
    let candidates = crate::shared::cli_discovery_core::discover_agent_clis(
        &engine,
        configured,
        Some(&managed_root),
    )
    .await?;
    serde_json::to_value(candidates).map_err(|error| error.to_string())
}

async fn request(state: &DaemonState, params: &Value) -> Result<Value, String> {
    let workspace_id = parse_string(params, "workspaceId")?;
    let operation = parse_string(params, "operation")?;
    let workspace = state
        .workspaces
        .lock()
        .await
        .get(&workspace_id)
        .cloned()
        .ok_or_else(|| "Workspace not found".to_string())?;
    let settings = state.app_settings.lock().await.clone();
    let launch = crate::shared::gemini_runtime_core::LaunchConfig::from_settings(&settings);
    let runtime_params = crate::shared::artifact_storage_core::prepare_gemini_artifacts(
        &settings, &state.settings_path, &state.workspaces, &workspace_id, &operation,
        params.get("params").cloned().unwrap_or_else(|| json!({})),
    ).await?;
    state
        .gemini_runtime
        .request(
            &workspace_id,
            &workspace.path,
            launch,
            &operation,
            runtime_params,
            state.event_sink.clone(),
        )
        .await
}
