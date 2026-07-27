use super::*;
use serde::de::DeserializeOwned;

fn parse_input<T: DeserializeOwned>(params: &Value) -> Result<T, String> {
    let input_value = params
        .as_object()
        .and_then(|map| map.get("input"))
        .cloned()
        .ok_or_else(|| "missing `input`".to_string())?;
    serde_json::from_value(input_value).map_err(|err| err.to_string())
}

pub(super) async fn try_handle(
    state: &DaemonState,
    method: &str,
    params: &Value,
) -> Option<Result<Value, String>> {
    match method {
        "execution_binding_register" => {
            let input = match parse_input::<
                crate::shared::execution_binding_core::ExecutionBindingRegisterRequest,
            >(params)
            {
                Ok(value) => value,
                Err(err) => return Some(Err(err)),
            };
            Some(
                state
                    .execution_binding_register(input)
                    .await
                    .and_then(|value| serde_json::to_value(value).map_err(|err| err.to_string())),
            )
        }
        "execution_binding_observe" => {
            let input = match parse_input::<
                crate::shared::execution_binding_core::ExecutionBindingObserveRequest,
            >(params)
            {
                Ok(value) => value,
                Err(err) => return Some(Err(err)),
            };
            Some(
                state
                    .execution_binding_observe(input)
                    .await
                    .and_then(|value| serde_json::to_value(value).map_err(|err| err.to_string())),
            )
        }
        "execution_binding_list" => {
            let input = match parse_input::<
                crate::shared::execution_binding_core::ExecutionBindingQuery,
            >(params)
            {
                Ok(value) => value,
                Err(err) => return Some(Err(err)),
            };
            Some(
                state
                    .execution_binding_list(input)
                    .await
                    .and_then(|value| serde_json::to_value(value).map_err(|err| err.to_string())),
            )
        }
        "turn_execution_summary_get" => {
            let query = match parse_input::<
                crate::shared::turn_execution_summary_core::TurnExecutionSummaryQuery,
            >(params)
            {
                Ok(value) => value,
                Err(err) => return Some(Err(err)),
            };
            Some(
                state
                    .turn_execution_summary_get(query)
                    .await
                    .and_then(|value| serde_json::to_value(value).map_err(|err| err.to_string())),
            )
        }
        "turn_execution_summary_upsert" => {
            let input = match parse_input::<
                crate::shared::turn_execution_summary_core::TurnExecutionSummaryUpsert,
            >(params)
            {
                Ok(value) => value,
                Err(err) => return Some(Err(err)),
            };
            Some(
                state
                    .turn_execution_summary_upsert(input)
                    .await
                    .and_then(|value| serde_json::to_value(value).map_err(|err| err.to_string())),
            )
        }
        "get_codex_config_path" => {
            let settings = state.app_settings.lock().await.clone();
            let path = match settings_core::get_codex_config_path_core(&settings) {
                Ok(value) => value,
                Err(err) => return Some(Err(err)),
            };
            Some(Ok(Value::String(path)))
        }
        "get_codex_status" => {
            let settings = state.app_settings.lock().await.clone();
            Some(
                serde_json::to_value(settings_core::get_codex_status_core(&settings))
                    .map_err(|err| err.to_string()),
            )
        }
        "get_codex_sync_diagnostics" => {
            let settings = state.app_settings.lock().await.clone();
            Some(
                serde_json::to_value(settings_core::get_codex_sync_diagnostics_core(&settings))
                    .map_err(|err| err.to_string()),
            )
        }
        "get_config_model" => {
            let workspace_id = match parse_string(params, "workspaceId") {
                Ok(value) => value,
                Err(err) => return Some(Err(err)),
            };
            Some(state.get_config_model(workspace_id).await)
        }
        "get_provider_status" => {
            let workspace_id = match parse_string(params, "workspaceId") {
                Ok(value) => value,
                Err(err) => return Some(Err(err)),
            };
            Some(state.get_provider_status(workspace_id).await)
        }
        "third_party_key_usage" => {
            let base_url = match parse_string(params, "baseUrl") {
                Ok(value) => value,
                Err(err) => return Some(Err(err)),
            };
            let api_key = match parse_string(params, "apiKey") {
                Ok(value) => value,
                Err(err) => return Some(Err(err)),
            };
            let new_api_access_token = parse_optional_string(params, "newApiAccessToken");
            let timezone = parse_optional_string(params, "timezone");
            let day_start_unix = params.get("dayStartUnix").and_then(Value::as_i64);
            let usage_protocol = parse_optional_string(params, "usageProtocol");
            Some(
                provider_profiles_core::third_party_key_usage_core(
                    base_url,
                    api_key,
                    new_api_access_token,
                    timezone,
                    day_start_unix,
                    usage_protocol,
                )
                .await,
            )
        }
        "workspace_third_party_key_usage" => {
            let workspace_id = match parse_string(params, "workspaceId") {
                Ok(value) => value,
                Err(err) => return Some(Err(err)),
            };
            let timezone = parse_optional_string(params, "timezone");
            let day_start_unix = params.get("dayStartUnix").and_then(Value::as_i64);
            Some(
                state
                    .workspace_third_party_key_usage(workspace_id, timezone, day_start_unix)
                    .await,
            )
        }
        "provider_model_list" => {
            let base_url = match parse_string(params, "baseUrl") {
                Ok(value) => value,
                Err(err) => return Some(Err(err)),
            };
            let api_key = match parse_string(params, "apiKey") {
                Ok(value) => value,
                Err(err) => return Some(Err(err)),
            };
            Some(provider_profiles_core::provider_model_list_core(base_url, api_key).await)
        }
        "start_thread" => {
            let workspace_id = match parse_string(params, "workspaceId") {
                Ok(value) => value,
                Err(err) => return Some(Err(err)),
            };
            let token_efficiency_mode = parse_optional_string(params, "tokenEfficiencyMode");
            Some(
                state
                    .start_thread(workspace_id, token_efficiency_mode)
                    .await,
            )
        }
        "resume_thread" => {
            let workspace_id = match parse_string(params, "workspaceId") {
                Ok(value) => value,
                Err(err) => return Some(Err(err)),
            };
            let thread_id = match parse_string(params, "threadId") {
                Ok(value) => value,
                Err(err) => return Some(Err(err)),
            };
            Some(state.resume_thread(workspace_id, thread_id).await)
        }
        "get_thread_token_usage" => {
            let workspace_id = match parse_string(params, "workspaceId") {
                Ok(value) => value,
                Err(err) => return Some(Err(err)),
            };
            let thread_id = match parse_string(params, "threadId") {
                Ok(value) => value,
                Err(err) => return Some(Err(err)),
            };
            Some(state.get_thread_token_usage(workspace_id, thread_id).await)
        }
        "read_thread" => {
            let workspace_id = match parse_string(params, "workspaceId") {
                Ok(value) => value,
                Err(err) => return Some(Err(err)),
            };
            let thread_id = match parse_string(params, "threadId") {
                Ok(value) => value,
                Err(err) => return Some(Err(err)),
            };
            Some(state.read_thread(workspace_id, thread_id).await)
        }
        "thread_live_subscribe" => {
            let workspace_id = match parse_string(params, "workspaceId") {
                Ok(value) => value,
                Err(err) => return Some(Err(err)),
            };
            let thread_id = match parse_string(params, "threadId") {
                Ok(value) => value,
                Err(err) => return Some(Err(err)),
            };
            Some(state.thread_live_subscribe(workspace_id, thread_id).await)
        }
        "thread_live_unsubscribe" => {
            let workspace_id = match parse_string(params, "workspaceId") {
                Ok(value) => value,
                Err(err) => return Some(Err(err)),
            };
            let thread_id = match parse_string(params, "threadId") {
                Ok(value) => value,
                Err(err) => return Some(Err(err)),
            };
            Some(state.thread_live_unsubscribe(workspace_id, thread_id).await)
        }
        "fork_thread" => {
            let workspace_id = match parse_string(params, "workspaceId") {
                Ok(value) => value,
                Err(err) => return Some(Err(err)),
            };
            let thread_id = match parse_string(params, "threadId") {
                Ok(value) => value,
                Err(err) => return Some(Err(err)),
            };
            Some(state.fork_thread(workspace_id, thread_id).await)
        }
        "rollback_thread" => {
            let workspace_id = match parse_string(params, "workspaceId") {
                Ok(value) => value,
                Err(err) => return Some(Err(err)),
            };
            let thread_id = match parse_string(params, "threadId") {
                Ok(value) => value,
                Err(err) => return Some(Err(err)),
            };
            let num_turns = parse_optional_u32(params, "numTurns").unwrap_or(1);
            Some(
                state
                    .rollback_thread(workspace_id, thread_id, num_turns)
                    .await,
            )
        }
        "list_threads" => {
            let workspace_id = match parse_string(params, "workspaceId") {
                Ok(value) => value,
                Err(err) => return Some(Err(err)),
            };
            let cursor = parse_optional_string(params, "cursor");
            let limit = parse_optional_u32(params, "limit");
            let sort_key = parse_optional_string(params, "sortKey");
            let archived = parse_optional_bool(params, "archived");
            Some(
                state
                    .list_threads(workspace_id, cursor, limit, sort_key, archived)
                    .await,
            )
        }
        "list_mcp_server_status" => {
            let workspace_id = match parse_string(params, "workspaceId") {
                Ok(value) => value,
                Err(err) => return Some(Err(err)),
            };
            let cursor = parse_optional_string(params, "cursor");
            let limit = parse_optional_u32(params, "limit");
            Some(
                state
                    .list_mcp_server_status(workspace_id, cursor, limit)
                    .await,
            )
        }
        "computer_control_status" => {
            let workspace_id = match parse_string(params, "workspaceId") {
                Ok(value) => value,
                Err(err) => return Some(Err(err)),
            };
            let force_refresh = parse_optional_bool(params, "forceRefresh").unwrap_or(false);
            Some(
                state
                    .computer_control_status(workspace_id, force_refresh)
                    .await,
            )
        }
        "computer_control_preflight" => {
            let workspace_id = match parse_string(params, "workspaceId") {
                Ok(value) => value,
                Err(err) => return Some(Err(err)),
            };
            let task = match parse_string(params, "task") {
                Ok(value) => value,
                Err(err) => return Some(Err(err)),
            };
            let decision_id = match parse_string(params, "decisionId") {
                Ok(value) => value,
                Err(err) => return Some(Err(err)),
            };
            let explicit_backend = match parse_optional_string(params, "explicitBackend") {
                Some(value) => match serde_json::from_value(Value::String(value)) {
                    Ok(value) => Some(value),
                    Err(error) => return Some(Err(format!("invalid explicitBackend: {error}"))),
                },
                None => None,
            };
            Some(
                state
                    .computer_control_preflight(workspace_id, task, explicit_backend, decision_id)
                    .await,
            )
        }
        "archive_thread" => {
            let workspace_id = match parse_string(params, "workspaceId") {
                Ok(value) => value,
                Err(err) => return Some(Err(err)),
            };
            let thread_id = match parse_string(params, "threadId") {
                Ok(value) => value,
                Err(err) => return Some(Err(err)),
            };
            Some(state.archive_thread(workspace_id, thread_id).await)
        }
        "compact_thread" => {
            let workspace_id = match parse_string(params, "workspaceId") {
                Ok(value) => value,
                Err(err) => return Some(Err(err)),
            };
            let thread_id = match parse_string(params, "threadId") {
                Ok(value) => value,
                Err(err) => return Some(Err(err)),
            };
            Some(state.compact_thread(workspace_id, thread_id).await)
        }
        "set_thread_name" => {
            let workspace_id = match parse_string(params, "workspaceId") {
                Ok(value) => value,
                Err(err) => return Some(Err(err)),
            };
            let thread_id = match parse_string(params, "threadId") {
                Ok(value) => value,
                Err(err) => return Some(Err(err)),
            };
            let name = match parse_string(params, "name") {
                Ok(value) => value,
                Err(err) => return Some(Err(err)),
            };
            Some(state.set_thread_name(workspace_id, thread_id, name).await)
        }
        "send_user_message" => {
            let workspace_id = match parse_string(params, "workspaceId") {
                Ok(value) => value,
                Err(err) => return Some(Err(err)),
            };
            let thread_id = match parse_string(params, "threadId") {
                Ok(value) => value,
                Err(err) => return Some(Err(err)),
            };
            let text = match parse_string(params, "text") {
                Ok(value) => value,
                Err(err) => return Some(Err(err)),
            };
            let model = parse_optional_string(params, "model");
            let effort = parse_optional_string(params, "effort");
            let service_tier = parse_optional_nullable_string(params, "serviceTier");
            let access_mode = parse_optional_string(params, "accessMode");
            let images = parse_optional_string_array(params, "images");
            let app_mentions = parse_optional_value(params, "appMentions")
                .and_then(|value| value.as_array().cloned());
            let collaboration_mode = parse_optional_value(params, "collaborationMode");
            let additional_context = parse_optional_value(params, "additionalContext");
            Some(
                state
                    .send_user_message(
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
                    .await,
            )
        }
        "turn_interrupt" => {
            let workspace_id = match parse_string(params, "workspaceId") {
                Ok(value) => value,
                Err(err) => return Some(Err(err)),
            };
            let thread_id = match parse_string(params, "threadId") {
                Ok(value) => value,
                Err(err) => return Some(Err(err)),
            };
            let turn_id = match parse_string(params, "turnId") {
                Ok(value) => value,
                Err(err) => return Some(Err(err)),
            };
            Some(state.turn_interrupt(workspace_id, thread_id, turn_id).await)
        }
        "turn_steer" => {
            let workspace_id = match parse_string(params, "workspaceId") {
                Ok(value) => value,
                Err(err) => return Some(Err(err)),
            };
            let thread_id = match parse_string(params, "threadId") {
                Ok(value) => value,
                Err(err) => return Some(Err(err)),
            };
            let turn_id = match parse_string(params, "turnId") {
                Ok(value) => value,
                Err(err) => return Some(Err(err)),
            };
            let text = match parse_string(params, "text") {
                Ok(value) => value,
                Err(err) => return Some(Err(err)),
            };
            let images = parse_optional_string_array(params, "images");
            let app_mentions = parse_optional_value(params, "appMentions")
                .and_then(|value| value.as_array().cloned());
            let additional_context = parse_optional_value(params, "additionalContext");
            Some(
                state
                    .turn_steer(
                        workspace_id,
                        thread_id,
                        turn_id,
                        text,
                        images,
                        app_mentions,
                        additional_context,
                    )
                    .await,
            )
        }
        "start_review" => {
            let workspace_id = match parse_string(params, "workspaceId") {
                Ok(value) => value,
                Err(err) => return Some(Err(err)),
            };
            let thread_id = match parse_string(params, "threadId") {
                Ok(value) => value,
                Err(err) => return Some(Err(err)),
            };
            let target = match params
                .as_object()
                .and_then(|map| map.get("target"))
                .cloned()
                .ok_or("missing `target`")
            {
                Ok(value) => value,
                Err(err) => return Some(Err(err.to_string())),
            };
            let delivery = parse_optional_string(params, "delivery");
            Some(
                state
                    .start_review(workspace_id, thread_id, target, delivery)
                    .await,
            )
        }
        "model_list" => {
            let workspace_id = match parse_string(params, "workspaceId") {
                Ok(value) => value,
                Err(err) => return Some(Err(err)),
            };
            Some(state.model_list(workspace_id).await)
        }
        "experimental_feature_list" => {
            let workspace_id = match parse_string(params, "workspaceId") {
                Ok(value) => value,
                Err(err) => return Some(Err(err)),
            };
            let cursor = parse_optional_string(params, "cursor");
            let limit = parse_optional_u32(params, "limit");
            Some(
                state
                    .experimental_feature_list(workspace_id, cursor, limit)
                    .await,
            )
        }
        "collaboration_mode_list" => {
            let workspace_id = match parse_string(params, "workspaceId") {
                Ok(value) => value,
                Err(err) => return Some(Err(err)),
            };
            Some(state.collaboration_mode_list(workspace_id).await)
        }
        "set_codex_feature_flag" => {
            let feature_key = match parse_string(params, "featureKey") {
                Ok(value) => value,
                Err(err) => return Some(Err(err)),
            };
            let enabled = match parse_optional_bool(params, "enabled") {
                Some(value) => value,
                None => return Some(Err("missing or invalid `enabled`".to_string())),
            };
            Some(
                state
                    .set_codex_feature_flag(feature_key, enabled)
                    .await
                    .map(|_| json!({ "ok": true })),
            )
        }
        "get_agents_settings" => Some(
            state
                .get_agents_settings()
                .await
                .and_then(|value| serde_json::to_value(value).map_err(|err| err.to_string())),
        ),
        "set_agents_core_settings" => {
            let input = match parse_input::<agents_config_core::SetAgentsCoreInput>(params) {
                Ok(value) => value,
                Err(err) => return Some(Err(err)),
            };
            Some(
                state
                    .set_agents_core_settings(input)
                    .await
                    .and_then(|value| serde_json::to_value(value).map_err(|err| err.to_string())),
            )
        }
        "create_agent" => {
            let input = match parse_input::<agents_config_core::CreateAgentInput>(params) {
                Ok(value) => value,
                Err(err) => return Some(Err(err)),
            };
            Some(
                state
                    .create_agent(input)
                    .await
                    .and_then(|value| serde_json::to_value(value).map_err(|err| err.to_string())),
            )
        }
        "update_agent" => {
            let input = match parse_input::<agents_config_core::UpdateAgentInput>(params) {
                Ok(value) => value,
                Err(err) => return Some(Err(err)),
            };
            Some(
                state
                    .update_agent(input)
                    .await
                    .and_then(|value| serde_json::to_value(value).map_err(|err| err.to_string())),
            )
        }
        "delete_agent" => {
            let input = match parse_input::<agents_config_core::DeleteAgentInput>(params) {
                Ok(value) => value,
                Err(err) => return Some(Err(err)),
            };
            Some(
                state
                    .delete_agent(input)
                    .await
                    .and_then(|value| serde_json::to_value(value).map_err(|err| err.to_string())),
            )
        }
        "read_agent_config_toml" => {
            let agent_name = match parse_string(params, "agentName") {
                Ok(value) => value,
                Err(err) => return Some(Err(err)),
            };
            Some(
                state
                    .read_agent_config_toml(agent_name)
                    .await
                    .and_then(|value| serde_json::to_value(value).map_err(|err| err.to_string())),
            )
        }
        "write_agent_config_toml" => {
            let agent_name = match parse_string(params, "agentName") {
                Ok(value) => value,
                Err(err) => return Some(Err(err)),
            };
            let content = match parse_string(params, "content") {
                Ok(value) => value,
                Err(err) => return Some(Err(err)),
            };
            Some(
                state
                    .write_agent_config_toml(agent_name, content)
                    .await
                    .map(|_| json!({ "ok": true })),
            )
        }
        "account_rate_limits" => {
            let workspace_id = match parse_string(params, "workspaceId") {
                Ok(value) => value,
                Err(err) => return Some(Err(err)),
            };
            Some(state.account_rate_limits(workspace_id).await)
        }
        "account_read" => {
            let workspace_id = match parse_string(params, "workspaceId") {
                Ok(value) => value,
                Err(err) => return Some(Err(err)),
            };
            Some(state.account_read(workspace_id).await)
        }
        "codex_login" => {
            let workspace_id = match parse_string(params, "workspaceId") {
                Ok(value) => value,
                Err(err) => return Some(Err(err)),
            };
            Some(state.codex_login(workspace_id).await)
        }
        "codex_login_cancel" => {
            let workspace_id = match parse_string(params, "workspaceId") {
                Ok(value) => value,
                Err(err) => return Some(Err(err)),
            };
            Some(state.codex_login_cancel(workspace_id).await)
        }
        "skills_list" => {
            let workspace_id = match parse_string(params, "workspaceId") {
                Ok(value) => value,
                Err(err) => return Some(Err(err)),
            };
            Some(state.skills_list(workspace_id).await)
        }
        "workflow_preflight_preview" => {
            let workspace_id = match parse_string(params, "workspaceId") {
                Ok(value) => value,
                Err(err) => return Some(Err(err)),
            };
            let task = match parse_string(params, "task") {
                Ok(value) => value,
                Err(err) => return Some(Err(err)),
            };
            let mode = parse_optional_string(params, "mode");
            let provider_kind = match parse_string(params, "providerKind") {
                Ok(value) => value,
                Err(err) => return Some(Err(err)),
            };
            let model = parse_optional_string(params, "model");
            let workflow_id = parse_optional_string(params, "workflowId");
            Some(
                state
                    .workflow_preflight_preview(
                        workspace_id,
                        task,
                        mode,
                        provider_kind,
                        model,
                        workflow_id,
                    )
                    .await,
            )
        }
        "workflow_gate_status" => {
            let workspace_id = match parse_string(params, "workspaceId") {
                Ok(value) => value,
                Err(err) => return Some(Err(err)),
            };
            let workflow_id = match parse_string(params, "workflowId") {
                Ok(value) => value,
                Err(err) => return Some(Err(err)),
            };
            Some(state.workflow_gate_status(workspace_id, workflow_id).await)
        }
        "knowledge_status" => Some(state.knowledge_status().await),
        "knowledge_query" => {
            let query = match parse_string(params, "query") {
                Ok(value) => value,
                Err(err) => return Some(Err(err)),
            };
            let project_id = parse_optional_string(params, "projectId");
            Some(state.knowledge_query(query, project_id).await)
        }
        "knowledge_intake_capture" => {
            let input = match parse_input::<
                crate::shared::knowledge_adapter_core::KnowledgeIntakeCaptureRequest,
            >(params)
            {
                Ok(value) => value,
                Err(err) => return Some(Err(err)),
            };
            Some(state.knowledge_intake_capture(input).await)
        }
        "knowledge_task_init" => {
            let input = match parse_input::<
                crate::shared::knowledge_adapter_core::KnowledgeTaskInitRequest,
            >(params)
            {
                Ok(value) => value,
                Err(err) => return Some(Err(err)),
            };
            Some(state.knowledge_task_init(input).await)
        }
        "execution_router_shadow_preview" => {
            let input = match parse_input::<crate::shared::execution_router_core::ShadowRouteRequest>(
                params,
            ) {
                Ok(value) => value,
                Err(err) => return Some(Err(err)),
            };
            Some(
                async move {
                    let now_ms = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_millis() as u64;
                    let lock = state.task_coordination_ledger.lock().await;
                    let ledger = lock.clone().unwrap_or_default();
                    serde_json::to_value(crate::shared::execution_router_core::shadow_route(
                        &input, &ledger, now_ms,
                    ))
                    .map_err(|error| error.to_string())
                }
                .await,
            )
        }
        "task_coordination_release_claim" => {
            let group_id = match parse_string(params, "groupId") {
                Ok(value) => value,
                Err(err) => return Some(Err(err)),
            };
            let claim_id = match parse_string(params, "claimId") {
                Ok(value) => value,
                Err(err) => return Some(Err(err)),
            };
            Some(
                async move {
                    task_coordination_daemon_release_claim(state, group_id, claim_id)
                        .await
                        .map(|()| serde_json::Value::Null)
                }
                .await,
            )
        }
        "task_coordination_heartbeat" => {
            let group_id = match parse_string(params, "groupId") {
                Ok(value) => value,
                Err(err) => return Some(Err(err)),
            };
            let thread_key = match params.get("threadKey") {
                Some(v) => v.clone(),
                None => return Some(Err("missing threadKey".to_string())),
            };
            Some(
                async move {
                    task_coordination_daemon_heartbeat(state, group_id, thread_key)
                        .await
                        .map(|()| serde_json::Value::Null)
                }
                .await,
            )
        }
        "detect_python" => Some(
            async move {
                let settings = state.app_settings.lock().await;
                let user_path = settings.python_interpreter_path.as_deref();
                let (path, version) = crate::types::detect_python(user_path);
                Ok(serde_json::json!({
                    "available": path.is_some(),
                    "interpreterPath": path,
                    "version": version,
                    "source": "system",
                }))
            }
            .await,
        ),
        "task_coordination_detect_candidates" => {
            let target = match params.get("target") {
                Some(v) => v.clone(),
                None => return Some(Err("missing target".to_string())),
            };
            let target_repository_id = match parse_string(params, "targetRepositoryId") {
                Ok(value) => value,
                Err(err) => return Some(Err(err)),
            };
            let target_title = match parse_string(params, "targetTitle") {
                Ok(value) => value,
                Err(err) => return Some(Err(err)),
            };
            let known_threads = match params.get("knownThreads") {
                Some(v) => v.clone(),
                None => return Some(Err("missing knownThreads".to_string())),
            };
            let seen_pairs = match params.get("seenPairs") {
                Some(v) => v.clone(),
                None => return Some(Err("missing seenPairs".to_string())),
            };
            Some(
                async move {
                    task_coordination_daemon_detect_candidates(
                        state,
                        target,
                        target_repository_id,
                        target_title,
                        known_threads,
                        seen_pairs,
                    )
                    .await
                }
                .await,
            )
        }
        "apps_list" => {
            let workspace_id = match parse_string(params, "workspaceId") {
                Ok(value) => value,
                Err(err) => return Some(Err(err)),
            };
            let cursor = parse_optional_string(params, "cursor");
            let limit = parse_optional_u32(params, "limit");
            let thread_id = parse_optional_string(params, "threadId");
            Some(
                state
                    .apps_list(workspace_id, cursor, limit, thread_id)
                    .await,
            )
        }
        "task_coordination_list_groups" => Some(
            async move {
                let groups = task_coordination_daemon_list_groups(state).await;
                serde_json::to_value(groups).map_err(|e| e.to_string())
            }
            .await,
        ),
        "task_coordination_create_group" => {
            let group = match params.get("group") {
                Some(v) => v.clone(),
                None => return Some(Err("missing group".to_string())),
            };
            Some(async move { task_coordination_daemon_create_group(state, group).await }.await)
        }
        "task_coordination_acquire_claim" => {
            let group_id = match parse_string(params, "groupId") {
                Ok(value) => value,
                Err(err) => return Some(Err(err)),
            };
            let owner = match params.get("owner") {
                Some(v) => v.clone(),
                None => return Some(Err("missing owner".to_string())),
            };
            let kind = match parse_string(params, "kind") {
                Ok(value) => value,
                Err(err) => return Some(Err(err)),
            };
            let resource_key = match parse_string(params, "resourceKey") {
                Ok(value) => value,
                Err(err) => return Some(Err(err)),
            };
            let access = match parse_string(params, "access") {
                Ok(value) => value,
                Err(err) => return Some(Err(err)),
            };
            Some(
                async move {
                    task_coordination_daemon_acquire_claim(
                        state,
                        group_id,
                        owner,
                        kind,
                        resource_key,
                        access,
                    )
                    .await
                }
                .await,
            )
        }
        "respond_to_server_request" => {
            let workspace_id = match parse_string(params, "workspaceId") {
                Ok(value) => value,
                Err(err) => return Some(Err(err)),
            };
            let map = match params.as_object().ok_or("missing requestId") {
                Ok(value) => value,
                Err(err) => return Some(Err(err.to_string())),
            };
            let request_id = match map
                .get("requestId")
                .cloned()
                .filter(|value| value.is_number() || value.is_string())
                .ok_or("missing requestId")
            {
                Ok(value) => value,
                Err(err) => return Some(Err(err.to_string())),
            };
            let result = match map.get("result").cloned().ok_or("missing `result`") {
                Ok(value) => value,
                Err(err) => return Some(Err(err.to_string())),
            };
            Some(
                state
                    .respond_to_server_request(workspace_id, request_id, result)
                    .await,
            )
        }
        "remember_approval_rule" => {
            let workspace_id = match parse_string(params, "workspaceId") {
                Ok(value) => value,
                Err(err) => return Some(Err(err)),
            };
            let command = match parse_string_array(params, "command") {
                Ok(value) => value,
                Err(err) => return Some(Err(err)),
            };
            Some(state.remember_approval_rule(workspace_id, command).await)
        }
        "codex_doctor" => {
            let codex_bin = parse_optional_string(params, "codexBin");
            let codex_args = parse_optional_string(params, "codexArgs");
            Some(state.codex_doctor(codex_bin, codex_args).await)
        }
        "generate_run_metadata" => {
            let workspace_id = match parse_string(params, "workspaceId") {
                Ok(value) => value,
                Err(err) => return Some(Err(err)),
            };
            let prompt = match parse_string(params, "prompt") {
                Ok(value) => value,
                Err(err) => return Some(Err(err)),
            };
            Some(state.generate_run_metadata(workspace_id, prompt).await)
        }
        "generate_agent_description" => {
            let workspace_id = match parse_string(params, "workspaceId") {
                Ok(value) => value,
                Err(err) => return Some(Err(err)),
            };
            let description = match parse_string(params, "description") {
                Ok(value) => value,
                Err(err) => return Some(Err(err)),
            };
            Some(
                state
                    .generate_agent_description(workspace_id, description)
                    .await
                    .and_then(|value| serde_json::to_value(value).map_err(|err| err.to_string())),
            )
        }
        _ => None,
    }
}

async fn task_coordination_daemon_list_groups(state: &DaemonState) -> Vec<serde_json::Value> {
    let lock = state.task_coordination_ledger.lock().await;
    let ledger = lock.as_ref();
    match ledger {
        Some(l) => l
            .groups
            .values()
            .cloned()
            .map(|g| serde_json::to_value(&g).unwrap_or(serde_json::Value::Null))
            .collect(),
        None => vec![],
    }
}

async fn task_coordination_daemon_create_group(
    state: &DaemonState,
    group: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let mut lock = state.task_coordination_ledger.lock().await;
    let ledger = lock.as_mut().ok_or("Task coordination not initialized")?;
    let parsed: crate::shared::task_coordination_core::TaskCoordinationGroup =
        serde_json::from_value(group).map_err(|e| e.to_string())?;
    ledger.groups.insert(parsed.id.clone(), parsed.clone());
    serde_json::to_value(&parsed).map_err(|e| e.to_string())
}

async fn task_coordination_daemon_acquire_claim(
    state: &DaemonState,
    group_id: String,
    owner: serde_json::Value,
    kind: String,
    resource_key: String,
    access: String,
) -> Result<serde_json::Value, String> {
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
            serde_json::to_value(&claim).map_err(|e| e.to_string())
        }
        crate::shared::task_coordination_core::service::AcquireResult::Conflict(conflict) => {
            Err(serde_json::to_string(&conflict)
                .unwrap_or_else(|_| "Resource conflict".to_string()))
        }
    }
}

async fn task_coordination_daemon_release_claim(
    state: &DaemonState,
    group_id: String,
    claim_id: String,
) -> Result<(), String> {
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

async fn task_coordination_daemon_heartbeat(
    state: &DaemonState,
    group_id: String,
    thread_key: serde_json::Value,
) -> Result<(), String> {
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

async fn task_coordination_daemon_detect_candidates(
    state: &DaemonState,
    target: serde_json::Value,
    target_repository_id: String,
    target_title: String,
    known_threads: serde_json::Value,
    seen_pairs: serde_json::Value,
) -> Result<serde_json::Value, String> {
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
    let serialized: Vec<serde_json::Value> = results
        .iter()
        .map(|m| serde_json::to_value(m).unwrap_or(serde_json::Value::Null))
        .collect();
    Ok(serde_json::Value::Array(serialized))
}
