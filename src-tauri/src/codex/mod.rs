use serde_json::{json, Map, Value};
use std::path::PathBuf;
use std::sync::Arc;

use tauri::{AppHandle, Emitter, Manager, State};

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
use crate::types::{AppSettings, WorkspaceEntry};

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
    timezone: Option<String>,
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
                "timezone": timezone,
            }),
        )
        .await;
    }

    provider_profiles_core::third_party_key_usage_core(base_url, api_key, timezone).await
}

#[tauri::command]
pub(crate) async fn workspace_third_party_key_usage(
    workspace_id: String,
    timezone: Option<String>,
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
