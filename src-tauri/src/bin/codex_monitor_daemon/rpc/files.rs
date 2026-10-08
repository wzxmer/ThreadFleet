use super::*;
use crate::codex::home::resolve_settings_codex_home;
use crate::shared::file_attachment_core::{
    stage_file_attachment_core, FileAttachmentSource, StageFileAttachmentRequest,
};
use crate::shared::message_reference_core::{
    create_content_reference_core, create_message_reference_core, CreateContentReferenceRequest,
    CreateMessageReferenceRequest,
};

pub(super) async fn try_handle(
    state: &DaemonState,
    method: &str,
    params: &Value,
) -> Option<Result<Value, String>> {
    if !matches!(
        method,
        "create_message_reference" | "create_content_reference" | "stage_file_attachment"
    ) {
        return None;
    }
    let settings = state.app_settings.lock().await.clone();
    let codex_home = match resolve_settings_codex_home(&settings) {
        Some(path) => path,
        None => return Some(Err("Unable to resolve CODEX_HOME".to_string())),
    };
    match method {
        "stage_file_attachment" => {
            let request = match serde_json::from_value::<StageFileAttachmentRequest>(params.clone())
            {
                Ok(request) => request,
                Err(error) => {
                    return Some(Err(format!("invalid file attachment request: {error}")))
                }
            };
            if matches!(request.source, FileAttachmentSource::Path { .. }) {
                return Some(Err(
                    "Remote attachments require uploaded data or a saved session file".to_string(),
                ));
            }
            let response = tokio::task::spawn_blocking(move || {
                stage_file_attachment_core(&codex_home, request)
            })
            .await
            .map_err(|error| error.to_string())
            .and_then(|result| result);
            Some(response.and_then(|response| {
                serde_json::to_value(response).map_err(|error| error.to_string())
            }))
        }
        "create_message_reference" => {
            let request =
                match serde_json::from_value::<CreateMessageReferenceRequest>(params.clone()) {
                    Ok(request) => request,
                    Err(error) => {
                        return Some(Err(format!("invalid message reference request: {error}")))
                    }
                };
            Some(
                create_message_reference_core(&codex_home, request).and_then(|response| {
                    serde_json::to_value(response).map_err(|error| error.to_string())
                }),
            )
        }
        "create_content_reference" => {
            let request =
                match serde_json::from_value::<CreateContentReferenceRequest>(params.clone()) {
                    Ok(request) => request,
                    Err(error) => {
                        return Some(Err(format!("invalid content reference request: {error}")))
                    }
                };
            Some(
                create_content_reference_core(&codex_home, request).and_then(|response| {
                    serde_json::to_value(response).map_err(|error| error.to_string())
                }),
            )
        }
        _ => None,
    }
}
