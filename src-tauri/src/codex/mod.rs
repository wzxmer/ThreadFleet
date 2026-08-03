use base64::Engine;
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, Instant};

use tauri::{
    webview::PageLoadEvent, AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder,
    WindowEvent,
};

pub(crate) mod args;
pub(crate) mod config;
pub(crate) mod home;

use crate::backend::app_server::spawn_workspace_session as spawn_workspace_session_inner;
pub(crate) use crate::backend::app_server::WorkspaceSession;
use crate::backend::events::AppServerEvent;
use crate::event_sink::TauriEventSink;
use crate::remote_backend;
use crate::shared::agents_config_core;
use crate::shared::codex_core::{self, insert_optional_nullable_string};
use crate::shared::execution_binding_core::{
    ExecutionBindingObserveRequest, ExecutionBindingQuery, ExecutionBindingRegisterRequest,
};
use crate::shared::execution_router_core::{self, ShadowRouteRequest};
use crate::shared::knowledge_adapter_core;
use crate::shared::provider_profiles_core::{self, active_codex_key_runtime};
use crate::shared::turn_execution_summary_core::{
    runtime_id_for_data_dir, source_id_for_codex_home, TurnExecutionSummaryQuery,
    TurnExecutionSummaryUpsert,
};
use crate::shared::workflow_gate_adapter_core;
use crate::shared::workflow_preflight_core;
use crate::state::AppState;
use crate::types::{AppSettings, CredentialSelection, WorkspaceEntry};

fn emit_thread_live_event(app: &AppHandle, workspace_id: &str, method: &str, params: Value) {
    let _ = app.emit(
        "app-server-event",
        AppServerEvent {
            workspace_id: workspace_id.to_string(),
            message: json!({
                "method": method,
                "params": params,
            }),
        },
    );
}

async fn resolve_turn_execution_summary_scope(
    workspace_id: &str,
    thread_id: &str,
    state: &AppState,
) -> Result<(String, String), String> {
    let source_id = if let Some(binding) = state
        .source_thread_runtimes
        .get(workspace_id, thread_id)
        .await
    {
        binding.source.id
    } else {
        let settings = state.app_settings.lock().await.clone();
        let codex_home = home::resolve_settings_codex_home(&settings)
            .ok_or_else(|| "Unable to resolve CODEX_HOME for turn execution summary".to_string())?;
        source_id_for_codex_home(&codex_home)
    };
    let data_dir = state
        .settings_path
        .parent()
        .ok_or_else(|| "Unable to resolve app data directory".to_string())?;
    Ok((source_id, runtime_id_for_data_dir(data_dir)))
}

pub(crate) async fn spawn_workspace_session(
    entry: WorkspaceEntry,
    default_codex_bin: Option<String>,
    codex_args: Option<String>,
    app_handle: AppHandle,
    codex_home: Option<PathBuf>,
) -> Result<Arc<WorkspaceSession>, String> {
    let settings = {
        let state = app_handle.state::<AppState>();
        let settings = state.app_settings.lock().await.clone();
        settings
    };
    spawn_workspace_session_with_settings(
        entry,
        default_codex_bin,
        codex_args,
        app_handle,
        codex_home,
        settings,
    )
    .await
}

pub(crate) async fn spawn_history_workspace_session(
    entry: WorkspaceEntry,
    default_codex_bin: Option<String>,
    codex_args: Option<String>,
    app_handle: AppHandle,
    codex_home: PathBuf,
) -> Result<Arc<WorkspaceSession>, String> {
    let client_version = app_handle.package_info().version.to_string();
    let event_sink = TauriEventSink::new(app_handle);
    crate::backend::app_server::spawn_history_workspace_session(
        entry,
        default_codex_bin,
        codex_args,
        codex_home,
        client_version,
        event_sink,
    )
    .await
}

pub(crate) async fn spawn_workspace_session_with_settings(
    entry: WorkspaceEntry,
    default_codex_bin: Option<String>,
    codex_args: Option<String>,
    app_handle: AppHandle,
    codex_home: Option<PathBuf>,
    settings: AppSettings,
) -> Result<Arc<WorkspaceSession>, String> {
    let client_version = app_handle.package_info().version.to_string();
    let runtime_env = active_codex_key_runtime(&settings, codex_args).await?;
    let event_sink = TauriEventSink::new(app_handle);
    spawn_workspace_session_inner(
        entry,
        default_codex_bin,
        runtime_env.codex_args,
        runtime_env.comparison_codex_args,
        runtime_env.env,
        runtime_env.provider_runtime_fingerprint,
        runtime_env.gateway_shutdown,
        codex_home,
        client_version,
        event_sink,
    )
    .await
}

#[tauri::command]
pub(crate) async fn codex_doctor(
    codex_bin: Option<String>,
    codex_args: Option<String>,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    crate::shared::codex_aux_core::codex_doctor_core(&state.app_settings, codex_bin, codex_args)
        .await
}

#[tauri::command]
pub(crate) async fn codex_update(
    codex_bin: Option<String>,
    codex_args: Option<String>,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    crate::shared::codex_update_core::codex_update_core(&state.app_settings, codex_bin, codex_args)
        .await
}

#[tauri::command]
pub(crate) async fn start_thread(
    workspace_id: String,
    token_efficiency_mode: Option<String>,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<Value, String> {
    if remote_backend::is_remote_mode(&*state).await {
        return remote_backend::call_remote(
            &*state,
            app,
            "start_thread",
            json!({
                "workspaceId": workspace_id,
                "tokenEfficiencyMode": token_efficiency_mode,
            }),
        )
        .await;
    }

    codex_core::start_thread_core(
        &state.sessions,
        &state.workspaces,
        workspace_id,
        token_efficiency_mode,
    )
    .await
}

#[tauri::command]
pub(crate) async fn resume_thread(
    workspace_id: String,
    thread_id: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<Value, String> {
    if remote_backend::is_remote_mode(&*state).await {
        return remote_backend::call_remote(
            &*state,
            app,
            "resume_thread",
            json!({ "workspaceId": workspace_id, "threadId": thread_id }),
        )
        .await;
    }

    if let Some(session) = crate::session_manager::source_runtime_for_bound_thread(
        &workspace_id,
        &thread_id,
        &state,
        app.clone(),
    )
    .await?
    {
        return codex_core::resume_thread_with_session_core(&session, workspace_id, thread_id)
            .await;
    }
    codex_core::resume_thread_core(&state.sessions, workspace_id, thread_id).await
}

#[tauri::command]
pub(crate) async fn get_thread_token_usage(
    workspace_id: String,
    thread_id: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<Value, String> {
    if remote_backend::is_remote_mode(&*state).await {
        return remote_backend::call_remote(
            &*state,
            app,
            "get_thread_token_usage",
            json!({ "workspaceId": workspace_id, "threadId": thread_id }),
        )
        .await;
    }

    Ok(crate::shared::local_usage_core::thread_token_usage_core(
        &state.workspaces,
        workspace_id,
        thread_id,
    )
    .await
    .unwrap_or(Value::Null))
}

#[tauri::command]
pub(crate) async fn read_thread(
    workspace_id: String,
    thread_id: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<Value, String> {
    if remote_backend::is_remote_mode(&*state).await {
        return remote_backend::call_remote(
            &*state,
            app,
            "read_thread",
            json!({ "workspaceId": workspace_id, "threadId": thread_id }),
        )
        .await;
    }

    let active_session =
        crate::shared::session_manager_core::runtime::active_execution_runtime_for_thread(
            &state.sessions,
            &state.session_source_runtimes,
            &state.source_thread_runtimes,
            &workspace_id,
            &thread_id,
        )
        .await;
    if let Some(session) = active_session {
        let response =
            codex_core::read_thread_with_session_core(&session, workspace_id, thread_id).await?;
        return Ok(codex_core::annotate_thread_read_authority(
            response,
            "execution",
        ));
    }

    let session = crate::session_manager::history_runtime_for_thread(
        &workspace_id,
        &thread_id,
        &state,
        app.clone(),
    )
    .await?;
    let response =
        codex_core::read_thread_with_session_core(&session, workspace_id, thread_id).await?;
    Ok(codex_core::annotate_thread_read_authority(
        response,
        "history-no-active-execution",
    ))
}

#[tauri::command]
pub(crate) async fn read_thread_page(
    workspace_id: String,
    thread_id: String,
    cursor: Option<String>,
    item_limit: Option<u32>,
    byte_limit: Option<u32>,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<Value, String> {
    if remote_backend::is_remote_mode(&*state).await {
        return remote_backend::call_remote(
            &*state,
            app,
            "read_thread_page",
            json!({
                "workspaceId": workspace_id,
                "threadId": thread_id,
                "cursor": cursor,
                "itemLimit": item_limit,
                "byteLimit": byte_limit
            }),
        )
        .await;
    }

    let active_session =
        crate::shared::session_manager_core::runtime::active_execution_runtime_for_thread(
            &state.sessions,
            &state.session_source_runtimes,
            &state.source_thread_runtimes,
            &workspace_id,
            &thread_id,
        )
        .await;
    if let Some(session) = active_session {
        let response = codex_core::read_thread_page_with_session_core(
            &session,
            workspace_id,
            thread_id,
            cursor,
            item_limit,
            byte_limit,
        )
        .await?;
        return Ok(codex_core::annotate_thread_read_authority(
            response,
            "execution",
        ));
    }

    let session = crate::session_manager::history_runtime_for_thread(
        &workspace_id,
        &thread_id,
        &state,
        app.clone(),
    )
    .await?;
    let response = codex_core::read_thread_page_with_session_core(
        &session,
        workspace_id,
        thread_id,
        cursor,
        item_limit,
        byte_limit,
    )
    .await?;
    Ok(codex_core::annotate_thread_read_authority(
        response,
        "history-no-active-execution",
    ))
}

#[tauri::command]
pub(crate) async fn turn_execution_summary_get(
    mut input: TurnExecutionSummaryQuery,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<Value, String> {
    if remote_backend::is_remote_mode(&*state).await {
        return remote_backend::call_remote(
            &*state,
            app,
            "turn_execution_summary_get",
            json!({ "input": input }),
        )
        .await;
    }
    let (source_id, runtime_id) =
        resolve_turn_execution_summary_scope(&input.workspace_id, &input.thread_id, &state).await?;
    input.source_id = source_id;
    input.runtime_id = runtime_id;
    let mut sidecar = state.turn_execution_summaries.lock().await;
    serde_json::to_value(sidecar.get(&input)?).map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) async fn turn_execution_summary_upsert(
    mut input: TurnExecutionSummaryUpsert,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<Value, String> {
    if remote_backend::is_remote_mode(&*state).await {
        return remote_backend::call_remote(
            &*state,
            app,
            "turn_execution_summary_upsert",
            json!({ "input": input }),
        )
        .await;
    }
    let (source_id, runtime_id) = resolve_turn_execution_summary_scope(
        &input.summary.workspace_id,
        &input.summary.thread_id,
        &state,
    )
    .await?;
    input.source_id = source_id;
    input.runtime_id = runtime_id;
    let mut sidecar = state.turn_execution_summaries.lock().await;
    serde_json::to_value(sidecar.upsert(input)?).map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) async fn execution_binding_register(
    mut input: ExecutionBindingRegisterRequest,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<Value, String> {
    if remote_backend::is_remote_mode(&*state).await {
        return remote_backend::call_remote(
            &*state,
            app,
            "execution_binding_register",
            json!({ "input": input }),
        )
        .await;
    }
    let (source_id, runtime_id) =
        resolve_turn_execution_summary_scope(&input.workspace_id, &input.parent_thread_id, &state)
            .await?;
    input.source_id = source_id;
    input.runtime_id = runtime_id;
    let mut sidecar = state.execution_bindings.lock().await;
    serde_json::to_value(sidecar.register(input)?).map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) async fn execution_binding_observe(
    mut input: ExecutionBindingObserveRequest,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<Value, String> {
    if remote_backend::is_remote_mode(&*state).await {
        return remote_backend::call_remote(
            &*state,
            app,
            "execution_binding_observe",
            json!({ "input": input }),
        )
        .await;
    }
    let (source_id, runtime_id) =
        resolve_turn_execution_summary_scope(&input.workspace_id, &input.parent_thread_id, &state)
            .await?;
    input.source_id = source_id;
    input.runtime_id = runtime_id;
    let mut sidecar = state.execution_bindings.lock().await;
    serde_json::to_value(sidecar.observe(input)?).map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) async fn execution_binding_list(
    mut input: ExecutionBindingQuery,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<Value, String> {
    if remote_backend::is_remote_mode(&*state).await {
        return remote_backend::call_remote(
            &*state,
            app,
            "execution_binding_list",
            json!({ "input": input }),
        )
        .await;
    }
    let (source_id, runtime_id) =
        resolve_turn_execution_summary_scope(&input.workspace_id, &input.parent_thread_id, &state)
            .await?;
    input.source_id = source_id;
    input.runtime_id = runtime_id;
    let mut sidecar = state.execution_bindings.lock().await;
    serde_json::to_value(sidecar.list(&input)?).map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) async fn thread_live_subscribe(
    workspace_id: String,
    thread_id: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<Value, String> {
    if remote_backend::is_remote_mode(&*state).await {
        return remote_backend::call_remote(
            &*state,
            app,
            "thread_live_subscribe",
            json!({ "workspaceId": workspace_id, "threadId": thread_id }),
        )
        .await;
    }

    if state
        .source_thread_runtimes
        .get(&workspace_id, &thread_id)
        .await
        .is_none()
    {
        codex_core::thread_live_subscribe_core(
            &state.sessions,
            workspace_id.clone(),
            thread_id.clone(),
        )
        .await?;
    }
    let subscription_id = format!("{}:{}", workspace_id, thread_id);
    emit_thread_live_event(
        &app,
        &workspace_id,
        "thread/live_attached",
        json!({
            "workspaceId": workspace_id,
            "threadId": thread_id,
            "subscriptionId": subscription_id,
        }),
    );
    Ok(json!({
        "subscriptionId": subscription_id,
        "state": "live",
    }))
}

#[tauri::command]
pub(crate) async fn thread_live_unsubscribe(
    workspace_id: String,
    thread_id: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<Value, String> {
    if remote_backend::is_remote_mode(&*state).await {
        return remote_backend::call_remote(
            &*state,
            app,
            "thread_live_unsubscribe",
            json!({ "workspaceId": workspace_id, "threadId": thread_id }),
        )
        .await;
    }

    if state
        .source_thread_runtimes
        .get(&workspace_id, &thread_id)
        .await
        .is_none()
    {
        codex_core::thread_live_unsubscribe_core(
            &state.sessions,
            workspace_id.clone(),
            thread_id.clone(),
        )
        .await?;
    }
    emit_thread_live_event(
        &app,
        &workspace_id,
        "thread/live_detached",
        json!({
            "workspaceId": workspace_id,
            "threadId": thread_id,
            "reason": "manual",
        }),
    );
    Ok(json!({ "ok": true }))
}

#[tauri::command]
pub(crate) async fn fork_thread(
    workspace_id: String,
    thread_id: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<Value, String> {
    if remote_backend::is_remote_mode(&*state).await {
        return remote_backend::call_remote(
            &*state,
            app,
            "fork_thread",
            json!({ "workspaceId": workspace_id, "threadId": thread_id }),
        )
        .await;
    }

    if let Some(session) = crate::session_manager::source_runtime_for_bound_thread(
        &workspace_id,
        &thread_id,
        &state,
        app.clone(),
    )
    .await?
    {
        return session
            .send_request_for_workspace(
                &workspace_id,
                "thread/fork",
                json!({ "threadId": thread_id }),
            )
            .await;
    }
    codex_core::fork_thread_core(&state.sessions, workspace_id, thread_id).await
}

#[tauri::command]
pub(crate) async fn rollback_thread(
    workspace_id: String,
    thread_id: String,
    num_turns: u32,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<Value, String> {
    if remote_backend::is_remote_mode(&*state).await {
        return remote_backend::call_remote(
            &*state,
            app,
            "rollback_thread",
            json!({
                "workspaceId": workspace_id,
                "threadId": thread_id,
                "numTurns": num_turns,
            }),
        )
        .await;
    }

    if let Some(session) = crate::session_manager::source_runtime_for_bound_thread(
        &workspace_id,
        &thread_id,
        &state,
        app.clone(),
    )
    .await?
    {
        return session
            .send_request_for_workspace(
                &workspace_id,
                "thread/rollback",
                json!({ "threadId": thread_id, "numTurns": num_turns }),
            )
            .await;
    }
    codex_core::rollback_thread_core(&state.sessions, workspace_id, thread_id, num_turns).await
}

#[tauri::command]
pub(crate) async fn list_threads(
    workspace_id: String,
    cursor: Option<String>,
    limit: Option<u32>,
    sort_key: Option<String>,
    archived: Option<bool>,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<Value, String> {
    if remote_backend::is_remote_mode(&*state).await {
        return remote_backend::call_remote(
            &*state,
            app,
            "list_threads",
            json!({
                "workspaceId": workspace_id,
                "cursor": cursor,
                "limit": limit,
                "sortKey": sort_key,
                "archived": archived
            }),
        )
        .await;
    }

    let session =
        crate::session_manager::history_runtime_for_workspace_id(&workspace_id, &state, app)
            .await?;
    codex_core::list_threads_with_session_core(
        &session,
        workspace_id,
        cursor,
        limit,
        sort_key,
        archived,
    )
    .await
}

#[tauri::command]
pub(crate) async fn list_mcp_server_status(
    workspace_id: String,
    cursor: Option<String>,
    limit: Option<u32>,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<Value, String> {
    if remote_backend::is_remote_mode(&*state).await {
        return remote_backend::call_remote(
            &*state,
            app,
            "list_mcp_server_status",
            json!({ "workspaceId": workspace_id, "cursor": cursor, "limit": limit }),
        )
        .await;
    }

    codex_core::list_mcp_server_status_core(&state.sessions, workspace_id, cursor, limit).await
}

#[tauri::command]
pub(crate) async fn computer_control_status(
    workspace_id: String,
    force_refresh: Option<bool>,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<Value, String> {
    if remote_backend::is_remote_mode(&*state).await {
        return remote_backend::call_remote(
            &*state,
            app,
            "computer_control_status",
            json!({ "workspaceId": workspace_id, "forceRefresh": force_refresh }),
        )
        .await;
    }

    let snapshot = codex_core::computer_control_status_core(
        &state.sessions,
        &state.workspaces,
        workspace_id,
        force_refresh.unwrap_or(false),
        "local".to_string(),
    )
    .await?;
    serde_json::to_value(snapshot).map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) async fn computer_control_preflight(
    workspace_id: String,
    task: String,
    explicit_backend: Option<crate::shared::computer_control_core::ComputerControlBackend>,
    decision_id: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<Value, String> {
    if remote_backend::is_remote_mode(&*state).await {
        return remote_backend::call_remote(
            &*state,
            app,
            "computer_control_preflight",
            json!({
                "workspaceId": workspace_id,
                "task": task,
                "explicitBackend": explicit_backend,
                "decisionId": decision_id
            }),
        )
        .await;
    }

    let decision = codex_core::computer_control_preflight_core(
        &state.sessions,
        &state.workspaces,
        workspace_id,
        task,
        explicit_backend,
        decision_id,
        "local".to_string(),
    )
    .await?;
    serde_json::to_value(decision).map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) async fn archive_thread(
    workspace_id: String,
    thread_id: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<Value, String> {
    if remote_backend::is_remote_mode(&*state).await {
        return remote_backend::call_remote(
            &*state,
            app,
            "archive_thread",
            json!({ "workspaceId": workspace_id, "threadId": thread_id }),
        )
        .await;
    }

    if let Some(session) = crate::session_manager::source_runtime_for_bound_thread(
        &workspace_id,
        &thread_id,
        &state,
        app.clone(),
    )
    .await?
    {
        let result = session
            .send_request_for_workspace(
                &workspace_id,
                "thread/archive",
                json!({ "threadId": thread_id }),
            )
            .await;
        if result.is_ok() {
            state
                .source_thread_runtimes
                .remove(&workspace_id, &thread_id)
                .await;
        }
        return result;
    }
    codex_core::archive_thread_core(&state.sessions, workspace_id, thread_id).await
}

#[tauri::command]
pub(crate) async fn compact_thread(
    workspace_id: String,
    thread_id: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<Value, String> {
    if remote_backend::is_remote_mode(&*state).await {
        return remote_backend::call_remote(
            &*state,
            app,
            "compact_thread",
            json!({ "workspaceId": workspace_id, "threadId": thread_id }),
        )
        .await;
    }

    if let Some(session) = crate::session_manager::source_runtime_for_bound_thread(
        &workspace_id,
        &thread_id,
        &state,
        app.clone(),
    )
    .await?
    {
        return session
            .send_request_for_workspace(
                &workspace_id,
                "thread/compact/start",
                json!({ "threadId": thread_id }),
            )
            .await;
    }
    codex_core::compact_thread_core(&state.sessions, workspace_id, thread_id).await
}

#[tauri::command]
pub(crate) async fn set_thread_name(
    workspace_id: String,
    thread_id: String,
    name: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<Value, String> {
    if remote_backend::is_remote_mode(&*state).await {
        return remote_backend::call_remote(
            &*state,
            app,
            "set_thread_name",
            json!({ "workspaceId": workspace_id, "threadId": thread_id, "name": name }),
        )
        .await;
    }

    if let Some(session) = crate::session_manager::source_runtime_for_bound_thread(
        &workspace_id,
        &thread_id,
        &state,
        app.clone(),
    )
    .await?
    {
        return session
            .send_request_for_workspace(
                &workspace_id,
                "thread/name/set",
                json!({ "threadId": thread_id, "name": name }),
            )
            .await;
    }
    codex_core::set_thread_name_core(&state.sessions, workspace_id, thread_id, name).await
}

#[tauri::command]
pub(crate) async fn send_user_message(
    workspace_id: String,
    thread_id: String,
    text: String,
    model: Option<String>,
    effort: Option<String>,
    service_tier: Option<Option<String>>,
    access_mode: Option<String>,
    images: Option<Vec<String>>,
    app_mentions: Option<Vec<Value>>,
    collaboration_mode: Option<Value>,
    additional_context: Option<Value>,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<Value, String> {
    if remote_backend::is_remote_mode(&*state).await {
        let images = images.map(|paths| {
            paths
                .into_iter()
                .map(remote_backend::normalize_path_for_remote)
                .collect::<Vec<_>>()
        });
        let mut payload = Map::new();
        payload.insert("workspaceId".to_string(), json!(workspace_id));
        payload.insert("threadId".to_string(), json!(thread_id));
        payload.insert("text".to_string(), json!(text));
        payload.insert("model".to_string(), json!(model));
        payload.insert("effort".to_string(), json!(effort));
        insert_optional_nullable_string(&mut payload, "serviceTier", service_tier);
        payload.insert("accessMode".to_string(), json!(access_mode));
        payload.insert("images".to_string(), json!(images));
        payload.insert("appMentions".to_string(), json!(app_mentions));
        payload.insert("additionalContext".to_string(), json!(additional_context));
        if let Some(mode) = collaboration_mode {
            if !mode.is_null() {
                payload.insert("collaborationMode".to_string(), mode);
            }
        }
        return remote_backend::call_remote(
            &*state,
            app,
            "send_user_message",
            Value::Object(payload),
        )
        .await;
    }

    let _runtime_switch_guard = crate::shared::workspaces_core::provider_runtime_switch_gate()
        .read()
        .await;
    if let Some(session) = crate::session_manager::source_runtime_for_bound_thread(
        &workspace_id,
        &thread_id,
        &state,
        app.clone(),
    )
    .await?
    {
        return codex_core::send_user_message_with_session_core(
            &session,
            &state.workspaces,
            workspace_id,
            thread_id,
            text,
            model,
            effort,
            service_tier,
            access_mode,
            images,
            app_mentions,
            collaboration_mode,
            additional_context,
        )
        .await;
    }
    codex_core::send_user_message_core(
        &state.sessions,
        &state.workspaces,
        workspace_id,
        thread_id,
        text,
        model,
        effort,
        service_tier,
        access_mode,
        images,
        app_mentions,
        collaboration_mode,
        additional_context,
    )
    .await
}

#[tauri::command]
pub(crate) async fn turn_steer(
    workspace_id: String,
    thread_id: String,
    turn_id: String,
    text: String,
    images: Option<Vec<String>>,
    app_mentions: Option<Vec<Value>>,
    additional_context: Option<Value>,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<Value, String> {
    if remote_backend::is_remote_mode(&*state).await {
        let images = images.map(|paths| {
            paths
                .into_iter()
                .map(remote_backend::normalize_path_for_remote)
                .collect::<Vec<_>>()
        });
        return remote_backend::call_remote(
            &*state,
            app,
            "turn_steer",
            json!({
                "workspaceId": workspace_id,
                "threadId": thread_id,
                "turnId": turn_id,
                "text": text,
                "images": images,
                "appMentions": app_mentions,
                "additionalContext": additional_context,
            }),
        )
        .await;
    }

    if let Some(session) = crate::session_manager::source_runtime_for_bound_thread(
        &workspace_id,
        &thread_id,
        &state,
        app.clone(),
    )
    .await?
    {
        return codex_core::turn_steer_with_session_core(
            &session,
            workspace_id,
            thread_id,
            turn_id,
            text,
            images,
            app_mentions,
            additional_context,
        )
        .await;
    }
    codex_core::turn_steer_core(
        &state.sessions,
        workspace_id,
        thread_id,
        turn_id,
        text,
        images,
        app_mentions,
        additional_context,
    )
    .await
}

#[tauri::command]
pub(crate) async fn collaboration_mode_list(
    workspace_id: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<Value, String> {
    if remote_backend::is_remote_mode(&*state).await {
        return remote_backend::call_remote(
            &*state,
            app,
            "collaboration_mode_list",
            json!({ "workspaceId": workspace_id }),
        )
        .await;
    }

    codex_core::collaboration_mode_list_core(&state.sessions, workspace_id).await
}

#[tauri::command]
pub(crate) async fn turn_interrupt(
    workspace_id: String,
    thread_id: String,
    turn_id: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<Value, String> {
    if remote_backend::is_remote_mode(&*state).await {
        return remote_backend::call_remote(
            &*state,
            app,
            "turn_interrupt",
            json!({ "workspaceId": workspace_id, "threadId": thread_id, "turnId": turn_id }),
        )
        .await;
    }

    if let Some(session) = crate::session_manager::source_runtime_for_bound_thread(
        &workspace_id,
        &thread_id,
        &state,
        app.clone(),
    )
    .await?
    {
        return codex_core::turn_interrupt_with_session_core(
            &session,
            workspace_id,
            thread_id,
            turn_id,
        )
        .await;
    }
    codex_core::turn_interrupt_core(&state.sessions, workspace_id, thread_id, turn_id).await
}

#[tauri::command]
pub(crate) async fn start_review(
    workspace_id: String,
    thread_id: String,
    target: Value,
    delivery: Option<String>,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<Value, String> {
    if remote_backend::is_remote_mode(&*state).await {
        return remote_backend::call_remote(
            &*state,
            app,
            "start_review",
            json!({
                "workspaceId": workspace_id,
                "threadId": thread_id,
                "target": target,
                "delivery": delivery,
            }),
        )
        .await;
    }

    if let Some(session) = crate::session_manager::source_runtime_for_bound_thread(
        &workspace_id,
        &thread_id,
        &state,
        app.clone(),
    )
    .await?
    {
        let mut params = Map::new();
        params.insert("threadId".to_string(), json!(thread_id));
        params.insert("target".to_string(), target);
        params.insert("delivery".to_string(), json!(delivery));
        return session
            .send_request_for_workspace(&workspace_id, "review/start", Value::Object(params))
            .await;
    }
    codex_core::start_review_core(&state.sessions, workspace_id, thread_id, target, delivery).await
}

#[tauri::command]
pub(crate) async fn model_list(
    workspace_id: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<Value, String> {
    if remote_backend::is_remote_mode(&*state).await {
        return remote_backend::call_remote(
            &*state,
            app,
            "model_list",
            json!({ "workspaceId": workspace_id }),
        )
        .await;
    }

    codex_core::model_list_core(&state.sessions, workspace_id).await
}

#[tauri::command]
pub(crate) async fn experimental_feature_list(
    workspace_id: String,
    cursor: Option<String>,
    limit: Option<u32>,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<Value, String> {
    if remote_backend::is_remote_mode(&*state).await {
        return remote_backend::call_remote(
            &*state,
            app,
            "experimental_feature_list",
            json!({
                "workspaceId": workspace_id,
                "cursor": cursor,
                "limit": limit
            }),
        )
        .await;
    }

    codex_core::experimental_feature_list_core(&state.sessions, workspace_id, cursor, limit).await
}

#[tauri::command]
pub(crate) async fn set_codex_feature_flag(
    feature_key: String,
    enabled: bool,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<(), String> {
    if remote_backend::is_remote_mode(&*state).await {
        remote_backend::call_remote(
            &*state,
            app,
            "set_codex_feature_flag",
            json!({
                "featureKey": feature_key,
                "enabled": enabled
            }),
        )
        .await?;
        return Ok(());
    }

    let settings = state.app_settings.lock().await.clone();
    config::write_feature_enabled(&settings, feature_key.as_str(), enabled)
}

#[tauri::command]
pub(crate) async fn get_agents_settings(
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<agents_config_core::AgentsSettingsDto, String> {
    if remote_backend::is_remote_mode(&*state).await {
        let response =
            remote_backend::call_remote(&*state, app, "get_agents_settings", json!({})).await?;
        return serde_json::from_value(response).map_err(|err| err.to_string());
    }

    let settings = state.app_settings.lock().await.clone();
    agents_config_core::get_agents_settings_core(settings.native_agent_markdown_import_enabled)
}

#[tauri::command]
pub(crate) async fn set_agents_core_settings(
    input: agents_config_core::SetAgentsCoreInput,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<agents_config_core::AgentsSettingsDto, String> {
    if remote_backend::is_remote_mode(&*state).await {
        let response = remote_backend::call_remote(
            &*state,
            app,
            "set_agents_core_settings",
            json!({ "input": input }),
        )
        .await?;
        return serde_json::from_value(response).map_err(|err| err.to_string());
    }

    let settings = state.app_settings.lock().await.clone();
    agents_config_core::set_agents_core_settings_core(
        input,
        settings.native_agent_markdown_import_enabled,
    )
}

#[tauri::command]
pub(crate) async fn create_agent(
    input: agents_config_core::CreateAgentInput,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<agents_config_core::AgentsSettingsDto, String> {
    if remote_backend::is_remote_mode(&*state).await {
        let response =
            remote_backend::call_remote(&*state, app, "create_agent", json!({ "input": input }))
                .await?;
        return serde_json::from_value(response).map_err(|err| err.to_string());
    }

    let settings = state.app_settings.lock().await.clone();
    agents_config_core::create_agent_core(input, settings.native_agent_markdown_import_enabled)
}

#[tauri::command]
pub(crate) async fn update_agent(
    input: agents_config_core::UpdateAgentInput,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<agents_config_core::AgentsSettingsDto, String> {
    if remote_backend::is_remote_mode(&*state).await {
        let response =
            remote_backend::call_remote(&*state, app, "update_agent", json!({ "input": input }))
                .await?;
        return serde_json::from_value(response).map_err(|err| err.to_string());
    }

    let settings = state.app_settings.lock().await.clone();
    agents_config_core::update_agent_core(input, settings.native_agent_markdown_import_enabled)
}

#[tauri::command]
pub(crate) async fn delete_agent(
    input: agents_config_core::DeleteAgentInput,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<agents_config_core::AgentsSettingsDto, String> {
    if remote_backend::is_remote_mode(&*state).await {
        let response =
            remote_backend::call_remote(&*state, app, "delete_agent", json!({ "input": input }))
                .await?;
        return serde_json::from_value(response).map_err(|err| err.to_string());
    }

    let settings = state.app_settings.lock().await.clone();
    agents_config_core::delete_agent_core(input, settings.native_agent_markdown_import_enabled)
}

#[tauri::command]
pub(crate) async fn read_agent_config_toml(
    agent_name: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<String, String> {
    if remote_backend::is_remote_mode(&*state).await {
        let response = remote_backend::call_remote(
            &*state,
            app,
            "read_agent_config_toml",
            json!({ "agentName": agent_name }),
        )
        .await?;
        return serde_json::from_value(response).map_err(|err| err.to_string());
    }

    agents_config_core::read_agent_config_toml_core(agent_name.as_str())
}

#[tauri::command]
pub(crate) async fn write_agent_config_toml(
    agent_name: String,
    content: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<(), String> {
    if remote_backend::is_remote_mode(&*state).await {
        remote_backend::call_remote(
            &*state,
            app,
            "write_agent_config_toml",
            json!({
                "agentName": agent_name,
                "content": content,
            }),
        )
        .await?;
        return Ok(());
    }

    agents_config_core::write_agent_config_toml_core(agent_name.as_str(), content.as_str())
}

#[tauri::command]
pub(crate) async fn account_rate_limits(
    workspace_id: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<Value, String> {
    if remote_backend::is_remote_mode(&*state).await {
        return remote_backend::call_remote(
            &*state,
            app,
            "account_rate_limits",
            json!({ "workspaceId": workspace_id }),
        )
        .await;
    }

    codex_core::account_rate_limits_core(&state.sessions, workspace_id).await
}

#[tauri::command]
pub(crate) async fn account_read(
    workspace_id: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<Value, String> {
    if remote_backend::is_remote_mode(&*state).await {
        return remote_backend::call_remote(
            &*state,
            app,
            "account_read",
            json!({ "workspaceId": workspace_id }),
        )
        .await;
    }

    codex_core::account_read_core(&state.sessions, &state.workspaces, workspace_id).await
}

#[tauri::command]
pub(crate) async fn codex_login(
    workspace_id: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<Value, String> {
    if remote_backend::is_remote_mode(&*state).await {
        return remote_backend::call_remote(
            &*state,
            app,
            "codex_login",
            json!({ "workspaceId": workspace_id }),
        )
        .await;
    }

    codex_core::codex_login_core(&state.sessions, &state.codex_login_cancels, workspace_id).await
}

#[tauri::command]
pub(crate) async fn codex_login_cancel(
    workspace_id: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<Value, String> {
    if remote_backend::is_remote_mode(&*state).await {
        return remote_backend::call_remote(
            &*state,
            app,
            "codex_login_cancel",
            json!({ "workspaceId": workspace_id }),
        )
        .await;
    }

    codex_core::codex_login_cancel_core(&state.sessions, &state.codex_login_cancels, workspace_id)
        .await
}

#[tauri::command]
pub(crate) async fn skills_list(
    workspace_id: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<Value, String> {
    if remote_backend::is_remote_mode(&*state).await {
        return remote_backend::call_remote(
            &*state,
            app,
            "skills_list",
            json!({ "workspaceId": workspace_id }),
        )
        .await;
    }

    codex_core::skills_list_core(&state.sessions, &state.workspaces, workspace_id).await
}

#[tauri::command]
pub(crate) async fn workflow_preflight_preview(
    workspace_id: String,
    task: String,
    mode: Option<String>,
    provider_kind: String,
    model: Option<String>,
    workflow_id: Option<String>,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<Value, String> {
    if remote_backend::is_remote_mode(&*state).await {
        return remote_backend::call_remote(
            &*state,
            app,
            "workflow_preflight_preview",
            json!({
                "workspaceId": workspace_id,
                "task": task,
                "mode": mode,
                "providerKind": provider_kind,
                "model": model,
                "workflowId": workflow_id,
            }),
        )
        .await;
    }

    workflow_preflight_core::workflow_preflight_preview_core(
        &state.workspaces,
        workspace_id,
        task,
        mode,
        provider_kind,
        model,
        workflow_id,
    )
    .await
}

#[tauri::command]
pub(crate) async fn workflow_gate_status(
    workspace_id: String,
    workflow_id: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<Value, String> {
    if remote_backend::is_remote_mode(&*state).await {
        return remote_backend::call_remote(
            &*state,
            app,
            "workflow_gate_status",
            json!({
                "workspaceId": workspace_id,
                "workflowId": workflow_id,
            }),
        )
        .await;
    }

    workflow_gate_adapter_core::workflow_gate_status_core(
        &state.workspaces,
        workspace_id,
        workflow_id,
    )
    .await
}

#[tauri::command]
pub(crate) async fn knowledge_status(
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<Value, String> {
    if remote_backend::is_remote_mode(&*state).await {
        return remote_backend::call_remote(&*state, app, "knowledge_status", json!({})).await;
    }
    knowledge_adapter_core::knowledge_status_core().await
}

#[tauri::command]
pub(crate) async fn knowledge_query(
    query: String,
    project_id: Option<String>,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<Value, String> {
    if remote_backend::is_remote_mode(&*state).await {
        return remote_backend::call_remote(
            &*state,
            app,
            "knowledge_query",
            json!({ "query": query, "projectId": project_id }),
        )
        .await;
    }
    knowledge_adapter_core::knowledge_query_core(query, project_id).await
}

#[tauri::command]
pub(crate) async fn knowledge_intake_capture(
    input: knowledge_adapter_core::KnowledgeIntakeCaptureRequest,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<Value, String> {
    if remote_backend::is_remote_mode(&*state).await {
        return remote_backend::call_remote(
            &*state,
            app,
            "knowledge_intake_capture",
            json!({ "input": input }),
        )
        .await;
    }
    knowledge_adapter_core::knowledge_intake_capture_core(input).await
}

#[tauri::command]
pub(crate) async fn knowledge_task_init(
    input: knowledge_adapter_core::KnowledgeTaskInitRequest,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<Value, String> {
    if remote_backend::is_remote_mode(&*state).await {
        return remote_backend::call_remote(
            &*state,
            app,
            "knowledge_task_init",
            json!({ "input": input }),
        )
        .await;
    }
    knowledge_adapter_core::knowledge_task_init_core(input).await
}

#[tauri::command]
pub(crate) async fn execution_router_shadow_preview(
    input: ShadowRouteRequest,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<Value, String> {
    if remote_backend::is_remote_mode(&*state).await {
        return remote_backend::call_remote(
            &*state,
            app,
            "execution_router_shadow_preview",
            json!({ "input": input }),
        )
        .await;
    }

    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    let lock = state.task_coordination_ledger.lock().await;
    let ledger = lock.clone().unwrap_or_default();
    serde_json::to_value(execution_router_core::shadow_route(&input, &ledger, now_ms))
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) async fn apps_list(
    workspace_id: String,
    cursor: Option<String>,
    limit: Option<u32>,
    thread_id: Option<String>,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<Value, String> {
    if remote_backend::is_remote_mode(&*state).await {
        return remote_backend::call_remote(
            &*state,
            app,
            "apps_list",
            json!({
                "workspaceId": workspace_id,
                "cursor": cursor,
                "limit": limit,
                "threadId": thread_id
            }),
        )
        .await;
    }

    codex_core::apps_list_core(&state.sessions, workspace_id, cursor, limit, thread_id).await
}

#[tauri::command]
pub(crate) async fn task_coordination_list_groups(
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<Value, String> {
    if remote_backend::is_remote_mode(&*state).await {
        return remote_backend::call_remote(
            &*state,
            app,
            "task_coordination_list_groups",
            json!({}),
        )
        .await;
    }
    let lock = state.task_coordination_ledger.lock().await;
    let ledger = lock.as_ref().ok_or("Task coordination not initialized")?;
    let groups: Vec<Value> = ledger
        .groups
        .values()
        .cloned()
        .map(|g| serde_json::to_value(&g).unwrap_or(Value::Null))
        .collect();
    Ok(Value::Array(groups))
}

#[tauri::command]
pub(crate) async fn task_coordination_create_group(
    group: Value,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<Value, String> {
    if remote_backend::is_remote_mode(&*state).await {
        return remote_backend::call_remote(
            &*state,
            app,
            "task_coordination_create_group",
            json!({ "group": group }),
        )
        .await;
    }
    let mut lock = state.task_coordination_ledger.lock().await;
    let ledger = lock.as_mut().ok_or("Task coordination not initialized")?;
    let parsed: crate::shared::task_coordination_core::TaskCoordinationGroup =
        serde_json::from_value(group).map_err(|e| e.to_string())?;
    ledger.groups.insert(parsed.id.clone(), parsed.clone());
    Ok(serde_json::to_value(&parsed).map_err(|e| e.to_string())?)
}

#[tauri::command]
pub(crate) async fn task_coordination_acquire_claim(
    group_id: String,
    owner: Value,
    kind: String,
    resource_key: String,
    access: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<Value, String> {
    if remote_backend::is_remote_mode(&*state).await {
        return remote_backend::call_remote(
            &*state,
            app,
            "task_coordination_acquire_claim",
            json!({
                "groupId": group_id,
                "owner": owner,
                "kind": kind,
                "resourceKey": resource_key,
                "access": access,
            }),
        )
        .await;
    }
    let mut lock = state.task_coordination_ledger.lock().await;
    let ledger = lock.as_mut().ok_or("Task coordination not initialized")?;
    let owner_key: crate::shared::task_coordination_core::ThreadKey =
        serde_json::from_value(owner).map_err(|e| e.to_string())?;
    let kind_enum = match kind.as_str() {
        "file" => crate::shared::task_coordination_core::ResourceKind::File,
        "directory" => crate::shared::task_coordination_core::ResourceKind::Directory,
        "logical" => crate::shared::task_coordination_core::ResourceKind::Logical,
        _ => return Err(format!("Invalid resource kind: {kind}")),
    };
    let access_enum = match access.as_str() {
        "read" => crate::shared::task_coordination_core::AccessLevel::Read,
        "write" => crate::shared::task_coordination_core::AccessLevel::Write,
        "exclusive" => crate::shared::task_coordination_core::AccessLevel::Exclusive,
        _ => return Err(format!("Invalid access level: {access}")),
    };
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    let existing = ledger.claims.get(&group_id).cloned().unwrap_or_default();
    let result = crate::shared::task_coordination_core::service::acquire_claim(
        &group_id,
        &owner_key,
        kind_enum,
        &resource_key,
        access_enum,
        &existing,
        now,
    );
    match result {
        crate::shared::task_coordination_core::service::AcquireResult::Granted(claim) => {
            let claims = ledger.claims.entry(group_id).or_default();
            claims.retain(|c| {
                !(c.owner_thread_key == owner_key
                    && c.state != crate::shared::task_coordination_core::ClaimState::Released)
            });
            claims.push(claim.clone());
            Ok(serde_json::to_value(&claim).map_err(|e| e.to_string())?)
        }
        crate::shared::task_coordination_core::service::AcquireResult::Conflict(conflict) => {
            Err(serde_json::to_string(&conflict)
                .unwrap_or_else(|_| "Resource conflict".to_string()))
        }
    }
}

#[tauri::command]
pub(crate) async fn task_coordination_release_claim(
    group_id: String,
    claim_id: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<(), String> {
    if remote_backend::is_remote_mode(&*state).await {
        remote_backend::call_remote(
            &*state,
            app,
            "task_coordination_release_claim",
            json!({ "groupId": group_id, "claimId": claim_id }),
        )
        .await?;
        return Ok(());
    }
    let mut lock = state.task_coordination_ledger.lock().await;
    let ledger = lock.as_mut().ok_or("Task coordination not initialized")?;
    if let Some(claims) = ledger.claims.get_mut(&group_id) {
        if let Some(claim) = claims.iter_mut().find(|c| c.id == claim_id) {
            claim.state = crate::shared::task_coordination_core::ClaimState::Released;
            claim.updated_at = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64;
        }
    }
    Ok(())
}
#[tauri::command]
pub(crate) async fn task_coordination_heartbeat(
    group_id: String,
    thread_key: Value,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<(), String> {
    if remote_backend::is_remote_mode(&*state).await {
        remote_backend::call_remote(
            &*state,
            app,
            "task_coordination_heartbeat",
            json!({ "groupId": group_id, "threadKey": thread_key }),
        )
        .await?;
        return Ok(());
    }
    let mut lock = state.task_coordination_ledger.lock().await;
    let ledger = lock.as_mut().ok_or("Task coordination not initialized")?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    if let Some(participants) = ledger.participants.get_mut(&group_id) {
        let key: crate::shared::task_coordination_core::ThreadKey =
            serde_json::from_value(thread_key).map_err(|e| e.to_string())?;
        if let Some(p) = participants.iter_mut().find(|p| p.thread_key == key) {
            crate::shared::task_coordination_core::leases::renew_lease(p, now, 30_000);
        }
    }
    Ok(())
}
#[tauri::command]
pub(crate) async fn task_coordination_detect_candidates(
    target: Value,
    target_repository_id: String,
    target_title: String,
    known_threads: Value,
    seen_pairs: Value,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<Value, String> {
    if remote_backend::is_remote_mode(&*state).await {
        return remote_backend::call_remote(
            &*state,
            app,
            "task_coordination_detect_candidates",
            json!({
                "target": target,
                "targetRepositoryId": target_repository_id,
                "targetTitle": target_title,
                "knownThreads": known_threads,
                "seenPairs": seen_pairs,
            }),
        )
        .await;
    }
    let target_key: crate::shared::task_coordination_core::ThreadKey =
        serde_json::from_value(target).map_err(|e| e.to_string())?;
    let known: Vec<(
        crate::shared::task_coordination_core::ThreadKey,
        String,
        String,
    )> = serde_json::from_value(known_threads).map_err(|e| e.to_string())?;
    let seen: std::collections::HashSet<String> =
        serde_json::from_value(seen_pairs).map_err(|e| e.to_string())?;
    let results = crate::shared::task_coordination_core::service::detect_candidates(
        &target_key,
        &target_repository_id,
        &target_title,
        &known,
        &seen,
    );
    let serialized: Vec<Value> = results
        .iter()
        .map(|m| serde_json::to_value(m).unwrap_or(Value::Null))
        .collect();
    Ok(Value::Array(serialized))
}

#[tauri::command]
pub(crate) async fn detect_python(
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<Value, String> {
    if remote_backend::is_remote_mode(&*state).await {
        return remote_backend::call_remote(&*state, app, "detect_python", json!({})).await;
    }

    let settings = state.app_settings.lock().await;
    let user_path = settings.python_interpreter_path.as_deref();
    let (path, version) = crate::types::detect_python(user_path);
    Ok(json!({
        "available": path.is_some(),
        "interpreterPath": path,
        "version": version,
        "source": "system",
    }))
}

#[tauri::command]
pub(crate) async fn respond_to_server_request(
    workspace_id: String,
    request_id: Value,
    result: Value,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<(), String> {
    if remote_backend::is_remote_mode(&*state).await {
        remote_backend::call_remote(
            &*state,
            app,
            "respond_to_server_request",
            json!({ "workspaceId": workspace_id, "requestId": request_id, "result": result }),
        )
        .await?;
        return Ok(());
    }

    if let Some(session) = crate::session_manager::source_runtime_for_bound_workspace(
        &workspace_id,
        &state,
        app.clone(),
    )
    .await?
    {
        return session.send_response(request_id, result).await;
    }
    codex_core::respond_to_server_request_core(&state.sessions, workspace_id, request_id, result)
        .await
}

#[tauri::command]
pub(crate) async fn remember_approval_rule(
    workspace_id: String,
    command: Vec<String>,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    codex_core::remember_approval_rule_core(&state.workspaces, workspace_id, command).await
}

#[tauri::command]
pub(crate) async fn get_config_model(
    workspace_id: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<Value, String> {
    if remote_backend::is_remote_mode(&*state).await {
        return remote_backend::call_remote(
            &*state,
            app,
            "get_config_model",
            json!({ "workspaceId": workspace_id }),
        )
        .await;
    }

    codex_core::get_config_model_core(&state.workspaces, workspace_id).await
}

#[tauri::command]
pub(crate) async fn get_provider_status(
    workspace_id: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<Value, String> {
    if remote_backend::is_remote_mode(&*state).await {
        return remote_backend::call_remote(
            &*state,
            app,
            "get_provider_status",
            json!({ "workspaceId": workspace_id }),
        )
        .await;
    }

    let settings = state.app_settings.lock().await.clone();
    codex_core::get_provider_status_core(&state.workspaces, &settings, workspace_id).await
}

#[tauri::command]
pub(crate) async fn third_party_key_usage(
    base_url: String,
    api_key: String,
    new_api_access_token: Option<String>,
    new_api_session_cookie: Option<String>,
    timezone: Option<String>,
    day_start_unix: Option<i64>,
    usage_protocol: Option<String>,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<Value, String> {
    if remote_backend::is_remote_mode(&*state).await {
        return remote_backend::call_remote(
            &*state,
            app,
            "third_party_key_usage",
            json!({
                "baseUrl": base_url,
                "apiKey": api_key,
                "newApiAccessToken": new_api_access_token,
                "newApiSessionCookie": new_api_session_cookie,
                "timezone": timezone,
                "dayStartUnix": day_start_unix,
                "usageProtocol": usage_protocol,
            }),
        )
        .await;
    }

    provider_profiles_core::third_party_key_usage_core(
        base_url,
        api_key,
        new_api_access_token,
        new_api_session_cookie,
        timezone,
        day_start_unix,
        usage_protocol,
    )
    .await
}

fn provider_login_target(base_url: &str) -> Result<(reqwest::Url, reqwest::Url), String> {
    let raw = base_url.trim();
    let normalized = if raw.contains("://") {
        raw.to_string()
    } else {
        format!("https://{raw}")
    };
    let parsed = reqwest::Url::parse(&normalized)
        .map_err(|_| "服务商 Base URL 无效，无法打开登录页面".to_string())?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err("服务商 Base URL 必须使用 HTTP 或 HTTPS".to_string());
    }
    let host = parsed
        .host_str()
        .ok_or_else(|| "服务商 Base URL 缺少主机名".to_string())?
        .to_ascii_lowercase();
    let (login_host, login_path) =
        if host == "duckcoding.ai" || host == "www.duckcoding.ai" || host == "api.duckcoding.ai" {
            ("www.duckcoding.ai", "/wallet")
        } else if host == "ooioo.work" || host == "www.ooioo.work" || host == "api.ooioo.work" {
            ("ooioo.work", "/wallet")
        } else if host == "congee.pro" || host == "www.congee.pro" || host == "api.congee.pro" {
            ("congee.pro", "/purchase")
        } else {
            (host.as_str(), "/")
        };
    let login_url = reqwest::Url::parse(&format!(
        "{}://{}{}",
        parsed.scheme(),
        login_host,
        login_path
    ))
    .map_err(|_| "无法构造服务商登录地址".to_string())?;
    Ok((login_url, parsed))
}

const WEBVIEW_PROXY_ENV_VARS: [&str; 6] = [
    "HTTPS_PROXY",
    "https_proxy",
    "HTTP_PROXY",
    "http_proxy",
    "ALL_PROXY",
    "all_proxy",
];

fn proxy_url_from_values<I, S>(values: I) -> Option<reqwest::Url>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    values.into_iter().find_map(|value| {
        let raw = value.as_ref().trim();
        if raw.is_empty() {
            return None;
        }
        let normalized = if raw.contains("://") {
            raw.to_string()
        } else {
            format!("http://{raw}")
        };
        let mut url = reqwest::Url::parse(&normalized).ok()?;
        match url.scheme().to_ascii_lowercase().as_str() {
            "http" | "socks5" => {}
            "socks5h" => {
                let _ = url.set_scheme("socks5");
            }
            _ => return None,
        }
        if url.host_str().is_none() || url.port().is_none() {
            return None;
        }
        Some(url)
    })
}

fn provider_webview_proxy_url() -> Option<reqwest::Url> {
    proxy_url_from_values(
        WEBVIEW_PROXY_ENV_VARS
            .iter()
            .filter_map(|name| std::env::var(name).ok()),
    )
}

const PROVIDER_LOGIN_LOADING_SCRIPT: &str = r#"
(() => {
  const overlayId = "__codex_provider_login_loading_overlay";
  const styleId = "__codex_provider_login_loading_style";
  let pageLoaded = false;

  const hide = () => {
    const overlay = document.getElementById(overlayId);
    if (!overlay) return;
    overlay.classList.add("__codex_provider_login_loading_overlay_done");
    window.setTimeout(() => overlay.remove(), 180);
  };

  const mount = () => {
    if (!document.documentElement) {
      window.setTimeout(mount, 0);
      return;
    }
    if (!document.getElementById(styleId)) {
      const style = document.createElement("style");
      style.id = styleId;
      style.textContent = `
        #${overlayId} {
          position: fixed;
          inset: 0;
          z-index: 2147483647;
          display: grid;
          place-items: center;
          background: #f5f7fb;
          opacity: 1;
          transition: opacity 180ms ease;
        }
        #${overlayId}.__codex_provider_login_loading_overlay_done {
          opacity: 0;
          pointer-events: none;
        }
        #${overlayId}::before {
          content: "";
          width: 30px;
          height: 30px;
          border: 3px solid rgba(79, 92, 113, 0.2);
          border-top-color: #4f6fed;
          border-radius: 50%;
          animation: __codex_provider_login_loading_spin 760ms linear infinite;
        }
        @keyframes __codex_provider_login_loading_spin {
          to { transform: rotate(360deg); }
        }
        @media (prefers-color-scheme: dark) {
          #${overlayId} { background: #20242b; }
          #${overlayId}::before {
            border-color: rgba(230, 235, 245, 0.2);
            border-top-color: #90a8ff;
          }
        }
        @media (prefers-reduced-motion: reduce) {
          #${overlayId} { transition: none; }
          #${overlayId}::before { animation: none; }
        }
      `;
      (document.head || document.documentElement).appendChild(style);
    }
    if (!document.getElementById(overlayId)) {
      const overlay = document.createElement("div");
      overlay.id = overlayId;
      overlay.setAttribute("aria-hidden", "true");
      (document.body || document.documentElement).appendChild(overlay);
    }
    if (pageLoaded) hide();
  };

  window.addEventListener("load", () => {
    pageLoaded = true;
    hide();
  }, { once: true });
  mount();
})();
"#;

const PROVIDER_LOGIN_TITLE: &str = "服务商登录";
const PROVIDER_LOGIN_TITLE_FRAMES: [&str; 4] = ["◴", "◷", "◶", "◵"];
const PROVIDER_USAGE_TITLE_PREFIX: &str = "__THREADFLEET_PROVIDER_USAGE__:";

const PROVIDER_USAGE_SCAN_SCRIPT: &str = r#"
(() => {
  const reportPrefix = "__THREADFLEET_PROVIDER_USAGE__:";
  const lastReportKey = "__codex_provider_usage_last_report";
  const balanceLabels = [
    "balance", "wallet", "remaining", "credit", "available", "quota",
    "current balance", "余额", "钱包", "剩余", "可用", "额度", "账户余额"
  ];
  const todayLabels = [
    "today cost", "today spend", "today usage", "daily cost", "daily spend",
    "今日消费", "今日消耗", "今日费用", "每日消费", "每日消耗", "本日"
  ];
  const totalLabels = [
    "total cost", "total spend", "total usage", "spent", "consumption",
    "actual cost", "累计消费", "累计消耗", "总消费", "总消耗", "总用量", "总费用"
  ];
  const currencyPattern = /(?:[$€£¥￥]\s*)(-?\d[\d,]*(?:\.\d+)?)/g;
  const numberPattern = /-?\d[\d,]*(?:\.\d+)?/g;

  const normalize = (value) => (value || "")
    .toLocaleLowerCase()
    .normalize("NFKC")
    .replace(/[\s_\-:：/]+/g, " ")
    .trim();

  const isVisible = (element) => {
    if (!(element instanceof Element)) return false;
    const style = window.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };

  const textOf = (element) => {
    if (!(element instanceof Element)) return "";
    const text = element.innerText || element.textContent || "";
    return text.replace(/\s+/g, " ").trim();
  };

  const descriptorOf = (element) => [
    textOf(element),
    element.getAttribute("aria-label"),
    element.getAttribute("title"),
    element.getAttribute("data-label"),
    element.id,
    element.className,
  ].filter(Boolean).join(" ");

  const hasLabel = (text, labels) => {
    const normalized = normalize(text);
    return labels.some((label) => normalized.includes(normalize(label)));
  };

  const parseNumber = (raw) => {
    const value = Number(String(raw).replace(/,/g, ""));
    return Number.isFinite(value) && Math.abs(value) <= 1e12 ? value : null;
  };

  const extractValue = (texts, allowPlainNumber) => {
    for (const text of texts) {
      const currencyValues = [...text.matchAll(currencyPattern)]
        .map((match) => parseNumber(match[1]))
        .filter((value) => value !== null);
      if (currencyValues.length > 0) return currencyValues[0];
    }
    if (!allowPlainNumber) return null;
    for (const text of texts) {
      const values = [...text.matchAll(numberPattern)]
        .map((match) => ({ raw: match[0], value: parseNumber(match[0]) }))
        .filter((item) => item.value !== null)
        .filter((item) => !/^\d{4}[-/]\d{1,2}/.test(item.raw));
      const decimal = values.find((item) => item.raw.includes("."));
      if (decimal) return decimal.value;
      if (values.length === 1) return values[0].value;
    }
    return null;
  };

  const nearbyTexts = (element) => {
    const texts = [];
    let current = element;
    for (let depth = 0; current && depth < 4; depth += 1, current = current.parentElement) {
      if (!isVisible(current)) continue;
      const text = textOf(current);
      if (text && text.length <= 220 && !texts.includes(text)) texts.push(text);
    }
    return texts;
  };

  const report = (snapshot) => {
    const serialized = JSON.stringify(snapshot);
    if (!serialized || window[lastReportKey] === serialized) return;
    window[lastReportKey] = serialized;
    try {
      document.title = reportPrefix + btoa(serialized);
    } catch (_) {
      // The payload is ASCII-only; ignore a transient title update failure.
    }
  };

  const scan = () => {
    if (!document.body) return;
    let balanceUsd = null;
    let todayCostUsd = null;
    let totalCostUsd = null;
    let isUnlimited = false;
    const elements = [...document.querySelectorAll("body *")].filter(isVisible);
    for (const element of elements) {
      const descriptor = descriptorOf(element);
      const nearby = nearbyTexts(element);
      if (!descriptor && nearby.length === 0) continue;
      const normalizedDescriptor = normalize(descriptor);
      if (/(unlimited|no limit|无上限|不限额|无限)/i.test(normalizedDescriptor)) {
        isUnlimited = true;
      }
      if (balanceUsd === null && hasLabel(descriptor, balanceLabels)) {
        balanceUsd = extractValue(nearby, true);
      }
      if (todayCostUsd === null && hasLabel(descriptor, todayLabels)) {
        todayCostUsd = extractValue(nearby, true);
      }
      if (totalCostUsd === null && hasLabel(descriptor, totalLabels)) {
        totalCostUsd = extractValue(nearby, true);
      }
      if (balanceUsd !== null && todayCostUsd !== null && totalCostUsd !== null) break;
    }
    if (balanceUsd === null && todayCostUsd === null && totalCostUsd === null && !isUnlimited) return;
    report({
      source: "page",
      balanceUsd,
      todayCostUsd,
      totalCostUsd,
      isUnlimited,
      isPartial: todayCostUsd === null && totalCostUsd === null,
    });
  };

  let scanTimer = null;
  const scheduleScan = () => {
    if (scanTimer !== null) window.clearTimeout(scanTimer);
    scanTimer = window.setTimeout(() => {
      scanTimer = null;
      scan();
    }, 180);
  };
  window.addEventListener("load", scheduleScan, { once: true });
  const start = () => {
    if (!document.documentElement) {
      window.setTimeout(start, 0);
      return;
    }
    new MutationObserver(scheduleScan).observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    window.setInterval(scan, 1800);
    scheduleScan();
  };
  start();
})();
"#;

fn decode_provider_usage_title(title: &str) -> Option<Value> {
    let encoded = title.strip_prefix(PROVIDER_USAGE_TITLE_PREFIX)?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .ok()?;
    let payload: Value = serde_json::from_slice(&bytes).ok()?;
    (payload.get("source").and_then(Value::as_str) == Some("page")).then_some(payload)
}

fn provider_login_title(frame_index: usize) -> String {
    format!(
        "{PROVIDER_LOGIN_TITLE} {}",
        PROVIDER_LOGIN_TITLE_FRAMES[frame_index % PROVIDER_LOGIN_TITLE_FRAMES.len()]
    )
}

fn provider_usage_has_displayable_quota(payload: &Value) -> bool {
    let Some(object) = payload.as_object() else {
        return false;
    };
    object
        .get("isUnlimited")
        .and_then(Value::as_bool)
        .unwrap_or(false)
        || object
            .get("balanceUsd")
            .is_some_and(|value| matches!(value, Value::Number(_)))
}

fn serialize_webview_cookies(cookie_jar: &BTreeMap<String, String>) -> String {
    cookie_jar
        .iter()
        .map(|(name, value)| format!("{name}={value}"))
        .collect::<Vec<_>>()
        .join("; ")
}

fn append_webview_cookies(
    target: &mut BTreeMap<String, String>,
    cookies: impl IntoIterator<Item = impl CookiePair>,
) {
    for cookie in cookies {
        let name = cookie.cookie_name().trim();
        let value = cookie.cookie_value().trim();
        if name.is_empty()
            || value.is_empty()
            || name.contains([';', '\r', '\n'])
            || value.contains([';', '\r', '\n'])
        {
            continue;
        }
        target.insert(name.to_string(), value.to_string());
    }
}

trait CookiePair {
    fn cookie_name(&self) -> &str;
    fn cookie_value(&self) -> &str;
}

impl CookiePair for tauri::webview::Cookie<'static> {
    fn cookie_name(&self) -> &str {
        self.name()
    }

    fn cookie_value(&self) -> &str {
        self.value()
    }
}

#[tauri::command]
pub(crate) async fn provider_session_login(
    base_url: String,
    usage_protocol: Option<String>,
    app: AppHandle,
) -> Result<String, String> {
    let (login_url, api_url) = provider_login_target(&base_url)?;
    let label = format!("provider-login-{}", uuid::Uuid::new_v4());
    // WebView2 requires a separate user-data directory when this webview uses
    // proxy settings that differ from the main webview.
    let app_cache_dir = app
        .path()
        .app_cache_dir()
        .map_err(|error| format!("无法准备登录缓存目录：{error}"))?;
    let login_data_dir = app_cache_dir.join("provider-login").join(&label);
    let empty_menu =
        tauri::menu::Menu::new(&app).map_err(|error| format!("无法创建登录窗口菜单：{error}"))?;
    let page_loading = Arc::new(AtomicBool::new(true));
    let page_loading_for_event = Arc::clone(&page_loading);
    let window_closed = Arc::new(AtomicBool::new(false));
    let page_usage = Arc::new(StdMutex::new(None::<Value>));
    let page_usage_for_title = Arc::clone(&page_usage);
    let initialization_script =
        format!("{PROVIDER_LOGIN_LOADING_SCRIPT}\n{PROVIDER_USAGE_SCAN_SCRIPT}");
    let mut login_window =
        WebviewWindowBuilder::new(&app, &label, WebviewUrl::External(login_url.clone()))
            .menu(empty_menu)
            .data_directory(login_data_dir)
            .initialization_script(initialization_script)
            .on_document_title_changed(move |_window, title| {
                if let Some(payload) = decode_provider_usage_title(&title) {
                    if let Ok(mut slot) = page_usage_for_title.lock() {
                        *slot = Some(payload);
                    }
                }
            })
            .on_page_load(move |window, payload| match payload.event() {
                PageLoadEvent::Started => {
                    page_loading_for_event.store(true, Ordering::Release);
                    let _ = window.set_title(&provider_login_title(0));
                }
                PageLoadEvent::Finished => {
                    page_loading_for_event.store(false, Ordering::Release);
                    let _ = window.set_title(PROVIDER_LOGIN_TITLE);
                }
            });
    if let Some(proxy_url) = provider_webview_proxy_url() {
        login_window = login_window.proxy_url(proxy_url);
    }
    let window = match login_window
        .title(provider_login_title(0))
        .inner_size(980.0, 760.0)
        .decorations(true)
        .resizable(true)
        .maximizable(true)
        .minimizable(true)
        .closable(true)
        .center()
        .build()
    {
        Ok(window) => window,
        Err(error) => return Err(format!("无法打开服务商登录页面：{error}")),
    };
    let _ = window.hide_menu();

    let title_animation_stopped = Arc::new(AtomicBool::new(false));
    let title_animation_window = window.clone();
    let title_animation_loading = Arc::clone(&page_loading);
    let title_animation_stopped_for_task = Arc::clone(&title_animation_stopped);
    let window_closed_for_task = Arc::clone(&window_closed);
    tokio::spawn(async move {
        let mut frame_index = 0usize;
        loop {
            if title_animation_stopped_for_task.load(Ordering::Acquire)
                || window_closed_for_task.load(Ordering::Acquire)
            {
                break;
            }
            if title_animation_loading.load(Ordering::Acquire) {
                if title_animation_window
                    .set_title(&provider_login_title(frame_index))
                    .is_err()
                {
                    break;
                }
                frame_index = frame_index.wrapping_add(1);
            } else {
                let _ = title_animation_window.set_title(PROVIDER_LOGIN_TITLE);
            }
            tokio::time::sleep(Duration::from_millis(120)).await;
        }
    });

    let window_closed_for_event = Arc::clone(&window_closed);
    window.on_window_event(move |event| {
        if matches!(
            event,
            WindowEvent::CloseRequested { .. } | WindowEvent::Destroyed
        ) {
            window_closed_for_event.store(true, Ordering::Release);
        }
    });

    let deadline = Instant::now() + Duration::from_secs(600);
    let usage_probe_interval = Duration::from_secs(2);
    let mut last_usage_probe_at = None;
    let mut cookie_jar = BTreeMap::<String, String>::new();
    loop {
        if window_closed.load(Ordering::Acquire) {
            break;
        }
        for cookie_url in [&login_url, &api_url] {
            match window.cookies_for_url(cookie_url.clone()) {
                Ok(cookies) => {
                    append_webview_cookies(&mut cookie_jar, cookies);
                }
                Err(_) => {}
            }
        }
        if let Ok(cookies) = window.cookies() {
            append_webview_cookies(&mut cookie_jar, cookies);
        }
        let page_payload = page_usage.lock().ok().and_then(|slot| slot.clone());
        if let Some(payload) = page_payload {
            let displayable = provider_usage_has_displayable_quota(&payload);
            if displayable && !cookie_jar.is_empty() {
                let session_cookie = serialize_webview_cookies(&cookie_jar);
                provider_profiles_core::cache_provider_session_usage(
                    &base_url,
                    &session_cookie,
                    payload,
                )
                .await;
                title_animation_stopped.store(true, Ordering::Release);
                let _ = window.close();
                return Ok(session_cookie);
            }
        }
        if !cookie_jar.is_empty()
            && last_usage_probe_at
                .map(|instant: Instant| instant.elapsed() >= usage_probe_interval)
                .unwrap_or(true)
        {
            last_usage_probe_at = Some(Instant::now());
            let session_cookie = serialize_webview_cookies(&cookie_jar);
            match provider_profiles_core::third_party_key_usage_core(
                base_url.clone(),
                String::new(),
                None,
                Some(session_cookie),
                Some("UTC".to_string()),
                None,
                usage_protocol.clone(),
            )
            .await
            {
                Ok(payload) => {
                    let displayable = provider_usage_has_displayable_quota(&payload);
                    if displayable {
                        let session_cookie = serialize_webview_cookies(&cookie_jar);
                        title_animation_stopped.store(true, Ordering::Release);
                        let _ = window.close();
                        return Ok(session_cookie);
                    }
                }
                Err(_) => {}
            }
        }
        if window_closed.load(Ordering::Acquire) || app.get_webview_window(&label).is_none() {
            break;
        }
        if Instant::now() >= deadline {
            title_animation_stopped.store(true, Ordering::Release);
            let _ = window.close();
            return Err("服务商登录等待超时，请重试".to_string());
        }
        tokio::time::sleep(Duration::from_millis(700)).await;
    }

    title_animation_stopped.store(true, Ordering::Release);
    if cookie_jar.is_empty() {
        return Err("登录窗口已关闭，未获取到 session Cookie".to_string());
    }
    Ok(serialize_webview_cookies(&cookie_jar))
}

#[tauri::command]
pub(crate) async fn workspace_third_party_key_usage(
    workspace_id: String,
    timezone: Option<String>,
    day_start_unix: Option<i64>,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<Value, String> {
    if remote_backend::is_remote_mode(&*state).await {
        return remote_backend::call_remote(
            &*state,
            app,
            "workspace_third_party_key_usage",
            json!({
                "workspaceId": workspace_id,
                "timezone": timezone,
                "dayStartUnix": day_start_unix,
            }),
        )
        .await;
    }

    let settings = state.app_settings.lock().await.clone();
    codex_core::workspace_third_party_key_usage_core(
        &state.workspaces,
        &settings,
        workspace_id,
        timezone,
        day_start_unix,
    )
    .await
}

#[tauri::command]
pub(crate) async fn provider_model_list(
    base_url: String,
    api_key: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<Value, String> {
    if remote_backend::is_remote_mode(&*state).await {
        return remote_backend::call_remote(
            &*state,
            app,
            "provider_model_list",
            json!({
                "baseUrl": base_url,
                "apiKey": api_key,
            }),
        )
        .await;
    }

    provider_profiles_core::provider_model_list_core(base_url, api_key).await
}

#[tauri::command]
pub(crate) async fn provider_function_tool_probe(
    selection: CredentialSelection,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<Value, String> {
    if remote_backend::is_remote_mode(&*state).await {
        return remote_backend::call_remote(
            &*state,
            app,
            "provider_function_tool_probe",
            json!({ "input": selection }),
        )
        .await;
    }
    let settings = state.app_settings.lock().await.clone();
    provider_profiles_core::provider_function_tool_probe_core(&settings, selection).await
}

/// Generates a commit message in the background without showing in the main chat
#[tauri::command]
pub(crate) async fn generate_commit_message(
    workspace_id: String,
    commit_message_model_id: Option<String>,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<String, String> {
    if remote_backend::is_remote_mode(&*state).await {
        let value = remote_backend::call_remote(
            &*state,
            app,
            "generate_commit_message",
            json!({
                "workspaceId": workspace_id,
                "commitMessageModelId": commit_message_model_id,
            }),
        )
        .await?;
        return serde_json::from_value(value).map_err(|err| err.to_string());
    }

    let diff = crate::git::get_workspace_diff(&workspace_id, &state).await?;

    let commit_message_prompt = {
        let settings = state.app_settings.lock().await;
        settings.commit_message_prompt.clone()
    };
    crate::shared::codex_aux_core::generate_commit_message_core(
        &state.sessions,
        &state.workspaces,
        workspace_id,
        &diff,
        &commit_message_prompt,
        commit_message_model_id.as_deref(),
        |workspace_id, thread_id| {
            let _ = app.emit(
                "app-server-event",
                AppServerEvent {
                    workspace_id: workspace_id.to_string(),
                    message: json!({
                        "method": "codex/backgroundThread",
                        "params": {
                            "threadId": thread_id,
                            "action": "hide"
                        }
                    }),
                },
            );
        },
    )
    .await
}

#[tauri::command]
pub(crate) async fn generate_run_metadata(
    workspace_id: String,
    prompt: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<Value, String> {
    if remote_backend::is_remote_mode(&*state).await {
        return remote_backend::call_remote(
            &*state,
            app,
            "generate_run_metadata",
            json!({ "workspaceId": workspace_id, "prompt": prompt }),
        )
        .await;
    }

    crate::shared::codex_aux_core::generate_run_metadata_core(
        &state.sessions,
        &state.workspaces,
        workspace_id,
        &prompt,
        |workspace_id, thread_id| {
            let _ = app.emit(
                "app-server-event",
                AppServerEvent {
                    workspace_id: workspace_id.to_string(),
                    message: json!({
                        "method": "codex/backgroundThread",
                        "params": {
                            "threadId": thread_id,
                            "action": "hide"
                        }
                    }),
                },
            );
        },
    )
    .await
}

#[tauri::command]
pub(crate) async fn generate_agent_description(
    workspace_id: String,
    description: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<crate::shared::codex_aux_core::GeneratedAgentConfiguration, String> {
    if remote_backend::is_remote_mode(&*state).await {
        let value = remote_backend::call_remote(
            &*state,
            app,
            "generate_agent_description",
            json!({ "workspaceId": workspace_id, "description": description }),
        )
        .await?;
        return serde_json::from_value(value).map_err(|err| err.to_string());
    }

    crate::shared::codex_aux_core::generate_agent_description_core(
        &state.sessions,
        &state.workspaces,
        workspace_id,
        &description,
        |workspace_id, thread_id| {
            let _ = app.emit(
                "app-server-event",
                AppServerEvent {
                    workspace_id: workspace_id.to_string(),
                    message: json!({
                        "method": "codex/backgroundThread",
                        "params": {
                            "threadId": thread_id,
                            "action": "hide"
                        }
                    }),
                },
            );
        },
    )
    .await
}

#[cfg(test)]
mod tests {
    use base64::Engine;
    use serde_json::{json, Value};

    use super::{
        decode_provider_usage_title, provider_login_title, provider_usage_has_displayable_quota,
        proxy_url_from_values, PROVIDER_LOGIN_LOADING_SCRIPT, PROVIDER_LOGIN_TITLE,
        PROVIDER_USAGE_SCAN_SCRIPT, PROVIDER_USAGE_TITLE_PREFIX,
    };

    #[test]
    fn provider_login_loading_indicator_stays_inside_the_webview() {
        assert!(PROVIDER_LOGIN_LOADING_SCRIPT.contains("__codex_provider_login_loading_overlay"));
        assert!(PROVIDER_LOGIN_LOADING_SCRIPT.contains("window.addEventListener(\"load\""));
    }

    #[test]
    fn provider_usage_scan_script_covers_bilingual_wallet_labels() {
        assert!(PROVIDER_USAGE_SCAN_SCRIPT.contains("current balance"));
        assert!(PROVIDER_USAGE_SCAN_SCRIPT.contains("total usage"));
        assert!(PROVIDER_USAGE_SCAN_SCRIPT.contains("余额"));
        assert!(PROVIDER_USAGE_SCAN_SCRIPT.contains("今日消耗"));
        assert!(PROVIDER_USAGE_SCAN_SCRIPT.contains("MutationObserver"));
    }

    #[test]
    fn provider_usage_title_decodes_page_snapshot_without_logging_cookie() {
        let payload = json!({
            "source": "page",
            "balanceUsd": 1.29,
            "totalCostUsd": 9.8,
            "isUnlimited": false,
        });
        let encoded = base64::engine::general_purpose::STANDARD
            .encode(serde_json::to_vec(&payload).expect("payload json"));
        assert_eq!(
            decode_provider_usage_title(&format!("{PROVIDER_USAGE_TITLE_PREFIX}{encoded}")),
            Some(payload)
        );
        assert!(decode_provider_usage_title("ordinary page title").is_none());
    }

    #[test]
    fn provider_login_title_uses_spinner_while_loading() {
        assert_eq!(provider_login_title(0), "服务商登录 ◴");
        assert_ne!(provider_login_title(1), PROVIDER_LOGIN_TITLE);
    }

    #[test]
    fn provider_usage_closes_login_only_for_balance_or_unlimited() {
        assert!(provider_usage_has_displayable_quota(&json!({
            "balanceUsd": 0.0,
            "isUnlimited": false,
        })));
        assert!(provider_usage_has_displayable_quota(&json!({
            "balanceUsd": null,
            "isUnlimited": true,
        })));
        assert!(!provider_usage_has_displayable_quota(&json!({
            "balanceUsd": null,
            "isUnlimited": false,
            "todayCostUsd": 1.25,
        })));
        assert!(!provider_usage_has_displayable_quota(&Value::Null));
    }

    #[test]
    fn webview_proxy_candidates_skip_invalid_values_and_keep_priority() {
        let proxy = proxy_url_from_values([
            "ftp://127.0.0.1:7890",
            "socks5://127.0.0.1:7891",
            "http://127.0.0.1:7892",
        ])
        .expect("a supported proxy should be selected");

        assert_eq!(proxy.as_str(), "socks5://127.0.0.1:7891");
    }

    #[test]
    fn webview_proxy_candidates_accept_proxy_without_scheme_as_http() {
        let proxy = proxy_url_from_values(["127.0.0.1:7890"]).expect("proxy should be parsed");

        assert_eq!(proxy.as_str(), "http://127.0.0.1:7890/");
    }
}
