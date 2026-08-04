use super::*;

#[path = "rpc/codex.rs"]
mod codex;
#[path = "rpc/daemon.rs"]
mod daemon;
#[path = "rpc/dispatcher.rs"]
mod dispatcher;
#[path = "rpc/files.rs"]
mod files;
#[path = "rpc/git.rs"]
mod git;
#[path = "rpc/installer_migration.rs"]
mod installer_migration;
#[path = "rpc/prompts.rs"]
mod prompts;
#[path = "rpc/session_manager.rs"]
mod session_manager;
#[path = "rpc/workspace.rs"]
mod workspace;

pub(super) fn build_error_response(id: Option<u64>, message: &str) -> Option<String> {
    let id = id?;
    Some(
        serde_json::to_string(&json!({
            "id": id,
            "error": { "message": message }
        }))
        .unwrap_or_else(|_| {
            "{\"id\":0,\"error\":{\"message\":\"serialization failed\"}}".to_string()
        }),
    )
}

pub(super) fn build_result_response(id: Option<u64>, result: Value) -> Option<String> {
    let id = id?;
    Some(
        serde_json::to_string(&json!({ "id": id, "result": result })).unwrap_or_else(|_| {
            "{\"id\":0,\"error\":{\"message\":\"serialization failed\"}}".to_string()
        }),
    )
}

fn build_event_notification(event: DaemonEvent) -> Option<String> {
    let payload = match event {
        DaemonEvent::AppServer(payload) => json!({
            "method": "app-server-event",
            "params": payload,
        }),
        DaemonEvent::TerminalOutput(payload) => json!({
            "method": "terminal-output",
            "params": payload,
        }),
        DaemonEvent::TerminalExit(payload) => json!({
            "method": "terminal-exit",
            "params": payload,
        }),
    };
    serde_json::to_string(&payload).ok()
}

pub(super) fn parse_auth_token(params: &Value) -> Option<String> {
    match params {
        Value::String(value) => Some(value.clone()),
        Value::Object(map) => map
            .get("token")
            .and_then(|value| value.as_str())
            .map(|v| v.to_string()),
        _ => None,
    }
}

pub(super) fn parse_string(value: &Value, key: &str) -> Result<String, String> {
    match value {
        Value::Object(map) => map
            .get(key)
            .and_then(|value| value.as_str())
            .map(|value| value.to_string())
            .ok_or_else(|| format!("missing or invalid `{key}`")),
        _ => Err(format!("missing `{key}`")),
    }
}

pub(super) fn parse_optional_string(value: &Value, key: &str) -> Option<String> {
    match value {
        Value::Object(map) => map
            .get(key)
            .and_then(|value| value.as_str())
            .map(|v| v.to_string()),
        _ => None,
    }
}

pub(super) fn parse_optional_nullable_string(value: &Value, key: &str) -> Option<Option<String>> {
    match value {
        Value::Object(map) => match map.get(key) {
            Some(Value::Null) => Some(None),
            Some(Value::String(value)) => Some(Some(value.to_string())),
            Some(_) => None,
            None => None,
        },
        _ => None,
    }
}

pub(super) fn parse_optional_u32(value: &Value, key: &str) -> Option<u32> {
    match value {
        Value::Object(map) => map.get(key).and_then(|value| value.as_u64()).and_then(|v| {
            if v > u32::MAX as u64 {
                None
            } else {
                Some(v as u32)
            }
        }),
        _ => None,
    }
}

pub(super) fn parse_optional_bool(value: &Value, key: &str) -> Option<bool> {
    match value {
        Value::Object(map) => map.get(key).and_then(|value| value.as_bool()),
        _ => None,
    }
}

pub(super) fn parse_optional_string_array(value: &Value, key: &str) -> Option<Vec<String>> {
    match value {
        Value::Object(map) => map
            .get(key)
            .and_then(|value| value.as_array())
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| item.as_str().map(|value| value.to_string()))
                    .collect::<Vec<_>>()
            }),
        _ => None,
    }
}

pub(super) fn parse_string_array(value: &Value, key: &str) -> Result<Vec<String>, String> {
    parse_optional_string_array(value, key).ok_or_else(|| format!("missing `{key}`"))
}

pub(super) fn parse_optional_value(value: &Value, key: &str) -> Option<Value> {
    match value {
        Value::Object(map) => map.get(key).cloned(),
        _ => None,
    }
}

pub(super) async fn handle_rpc_request(
    state: &DaemonState,
    method: &str,
    params: Value,
    client_version: String,
) -> Result<Value, String> {
    dispatcher::dispatch_rpc_request(state, method, &params, &client_version).await
}

pub(super) async fn forward_events(
    mut rx: broadcast::Receiver<DaemonEvent>,
    out_tx_events: mpsc::Sender<String>,
) {
    loop {
        let event = match rx.recv().await {
            Ok(event) => event,
            Err(broadcast::error::RecvError::Lagged(skipped)) => {
                let payload = json!({
                    "method": "remote/events_lagged",
                    "params": { "skipped": skipped },
                });
                let Ok(payload) = serde_json::to_string(&payload) else {
                    continue;
                };
                if out_tx_events.send(payload).await.is_err() {
                    break;
                }
                continue;
            }
            Err(broadcast::error::RecvError::Closed) => break,
        };

        let Some(payload) = build_event_notification(event) else {
            continue;
        };

        if out_tx_events.send(payload).await.is_err() {
            break;
        }
    }
}

#[cfg(test)]
mod event_forwarding_tests {
    use super::forward_events;
    use crate::backend::events::AppServerEvent;
    use crate::DaemonEvent;
    use serde_json::{json, Value};
    use tokio::sync::{broadcast, mpsc};

    #[test]
    fn lagged_event_receiver_reports_the_gap_before_forwarding_new_events() {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("tokio runtime")
            .block_on(async {
                let (events_tx, events_rx) = broadcast::channel(1);
                let (out_tx, mut out_rx) = mpsc::channel(4);

                for turn_id in ["turn-1", "turn-2"] {
                    assert!(
                        events_tx
                            .send(DaemonEvent::AppServer(AppServerEvent {
                                workspace_id: "ws-1".to_string(),
                                message: json!({
                                    "method": "turn/completed",
                                    "params": { "turnId": turn_id },
                                }),
                            }))
                            .is_ok(),
                        "broadcast event"
                    );
                }
                drop(events_tx);

                forward_events(events_rx, out_tx).await;

                let gap: Value =
                    serde_json::from_str(&out_rx.recv().await.expect("gap notification"))
                        .expect("valid gap notification");
                assert_eq!(gap["method"], "remote/events_lagged");
                assert_eq!(gap["params"]["skipped"], 1);

                let latest: Value =
                    serde_json::from_str(&out_rx.recv().await.expect("latest event"))
                        .expect("valid event notification");
                assert_eq!(latest["method"], "app-server-event");
                assert_eq!(latest["params"]["message"]["params"]["turnId"], "turn-2");
            });
    }
}

pub(super) fn spawn_rpc_response_task(
    state: Arc<DaemonState>,
    out_tx: mpsc::Sender<String>,
    id: Option<u64>,
    method: String,
    params: Value,
    client_version: String,
    request_limiter: Arc<Semaphore>,
) {
    tokio::spawn(async move {
        let Ok(_permit) = request_limiter.acquire_owned().await else {
            return;
        };
        let result = handle_rpc_request(&state, &method, params, client_version).await;
        let response = match result {
            Ok(result) => build_result_response(id, result),
            Err(message) => build_error_response(id, &message),
        };
        if let Some(response) = response {
            let _ = out_tx.send(response).await;
        }
    });
}
