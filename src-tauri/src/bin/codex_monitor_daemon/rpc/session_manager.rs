use serde::de::DeserializeOwned;

use super::*;

fn parse_request<T: DeserializeOwned>(params: &Value) -> Result<T, String> {
    let value = params
        .as_object()
        .and_then(|map| map.get("request"))
        .cloned()
        .ok_or_else(|| "missing `request`".to_string())?;
    serde_json::from_value(value).map_err(|error| error.to_string())
}

pub(super) async fn try_handle(
    state: &DaemonState,
    method: &str,
    params: &Value,
    client_version: &str,
) -> Option<Result<Value, String>> {
    match method {
        "list_session_sources" => Some(
            serde_json::to_value(state.list_session_sources().await)
                .map_err(|error| error.to_string()),
        ),
        "update_session_source" => {
            let request = match parse_request::<types::SessionSourceUpdateRequest>(params) {
                Ok(request) => request,
                Err(error) => return Some(Err(error)),
            };
            Some(
                state
                    .update_session_source(request)
                    .await
                    .and_then(to_value),
            )
        }
        "scan_managed_sessions" => {
            let request = match parse_request::<types::SessionScanRequest>(params) {
                Ok(request) => request,
                Err(error) => return Some(Err(error)),
            };
            Some(
                state
                    .scan_managed_sessions(request)
                    .await
                    .and_then(to_value),
            )
        }
        "verify_session_threads" => {
            let request = match parse_request::<types::VerifySessionThreadsRequest>(params) {
                Ok(request) => request,
                Err(error) => return Some(Err(error)),
            };
            Some(
                state
                    .verify_session_threads(request)
                    .await
                    .and_then(to_value),
            )
        }
        "fetch_managed_sessions_page" => {
            let request = match parse_request::<types::ManagedSessionPageRequest>(params) {
                Ok(request) => request,
                Err(error) => return Some(Err(error)),
            };
            Some(
                state
                    .fetch_managed_sessions_page(request)
                    .await
                    .and_then(to_value),
            )
        }
        "fetch_managed_session_preview" => {
            let request = match parse_request::<types::ManagedSessionPreviewRequest>(params) {
                Ok(request) => request,
                Err(error) => return Some(Err(error)),
            };
            Some(
                state
                    .fetch_managed_session_preview(request)
                    .await
                    .and_then(to_value),
            )
        }
        "search_managed_sessions" => {
            let request = match parse_request::<types::SessionSearchRequest>(params) {
                Ok(request) => request,
                Err(error) => return Some(Err(error)),
            };
            Some(
                state
                    .search_managed_sessions(request)
                    .await
                    .and_then(to_value),
            )
        }
        "fetch_session_search_results" => {
            let request_id = match parse_string(params, "requestId") {
                Ok(request_id) => request_id,
                Err(error) => return Some(Err(error)),
            };
            Some(
                state
                    .fetch_session_search_results(request_id)
                    .await
                    .and_then(to_value),
            )
        }
        "cancel_session_task" => {
            let request_id = match parse_string(params, "requestId") {
                Ok(request_id) => request_id,
                Err(error) => return Some(Err(error)),
            };
            Some(
                state
                    .cancel_session_task(request_id)
                    .await
                    .map(|_| Value::Null),
            )
        }
        "resume_managed_session" => {
            let request = match parse_request::<types::ResumeManagedSessionRequest>(params) {
                Ok(request) => request,
                Err(error) => return Some(Err(error)),
            };
            Some(
                state
                    .resume_managed_session(request, client_version.to_string())
                    .await
                    .and_then(to_value),
            )
        }
        "archive_managed_sessions" => {
            let request = match parse_request::<types::ArchiveManagedSessionsRequest>(params) {
                Ok(request) => request,
                Err(error) => return Some(Err(error)),
            };
            Some(
                state
                    .archive_managed_sessions(request, client_version.to_string())
                    .await
                    .and_then(to_value),
            )
        }
        "permanently_delete_managed_session" => {
            let request =
                match parse_request::<types::PermanentlyDeleteManagedSessionRequest>(params) {
                    Ok(request) => request,
                    Err(error) => return Some(Err(error)),
                };
            Some(
                state
                    .permanently_delete_managed_session(request)
                    .await
                    .and_then(to_value),
            )
        }
        "preview_managed_session_cleanup" => {
            let request = match parse_request::<types::ManagedSessionCleanupRequest>(params) {
                Ok(request) => request,
                Err(error) => return Some(Err(error)),
            };
            Some(
                state
                    .preview_managed_session_cleanup(request)
                    .await
                    .and_then(to_value),
            )
        }
        "cleanup_managed_sessions_now" => {
            let request = match parse_request::<types::ManagedSessionCleanupRequest>(params) {
                Ok(request) => request,
                Err(error) => return Some(Err(error)),
            };
            Some(
                state
                    .cleanup_managed_sessions_now(request)
                    .await
                    .and_then(to_value),
            )
        }
        "run_managed_session_cleanup_scheduler" => {
            let request =
                match parse_request::<types::ManagedSessionCleanupSchedulerRequest>(params) {
                    Ok(request) => request,
                    Err(error) => return Some(Err(error)),
                };
            Some(
                state
                    .run_managed_session_cleanup_scheduler(request)
                    .await
                    .and_then(to_value),
            )
        }
        "prepare_managed_session_derivation" => {
            let request =
                match parse_request::<types::PrepareManagedSessionDerivationRequest>(params) {
                    Ok(request) => request,
                    Err(error) => return Some(Err(error)),
                };
            Some(
                state
                    .prepare_managed_session_derivation(request)
                    .await
                    .and_then(to_value),
            )
        }
        _ => None,
    }
}

fn to_value<T: serde::Serialize>(value: T) -> Result<Value, String> {
    serde_json::to_value(value).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::parse_request;
    use crate::types::{
        ManagedSessionCleanupRequest, ManagedSessionCleanupSchedulerRequest, SessionScanRequest,
        VerifySessionThreadsRequest,
    };

    #[test]
    fn parses_camel_case_scan_contract() {
        let request: SessionScanRequest = parse_request(&json!({
            "request": {
                "requestId": "scan-a",
                "sourceIds": ["source-a"],
                "includeArchived": false
            }
        }))
        .unwrap();

        assert_eq!(request.request_id, "scan-a");
        assert_eq!(request.source_ids, vec!["source-a"]);
        assert_eq!(request.include_archived, Some(false));
    }

    #[test]
    fn parses_camel_case_thread_verification_contract() {
        let request: VerifySessionThreadsRequest = parse_request(&json!({
            "request": {
                "sourceId": "source-a",
                "threadIds": ["thread-a", "thread-b"]
            }
        }))
        .unwrap();

        assert_eq!(request.source_id, "source-a");
        assert_eq!(request.thread_ids, vec!["thread-a", "thread-b"]);
    }

    #[test]
    fn parses_cleanup_contract() {
        let request: ManagedSessionCleanupRequest = parse_request(&json!({
            "request": {
                "retentionDays": 60,
                "protectedThreadIds": ["thread-a"]
            }
        }))
        .unwrap();

        assert_eq!(request.retention_days, 60);
        assert_eq!(request.protected_thread_ids, vec!["thread-a"]);
    }

    #[test]
    fn parses_cleanup_scheduler_contract() {
        let request: ManagedSessionCleanupSchedulerRequest = parse_request(&json!({
            "request": {
                "protectedThreadIds": ["thread-a"]
            }
        }))
        .unwrap();

        assert_eq!(request.protected_thread_ids, vec!["thread-a"]);
    }
}
