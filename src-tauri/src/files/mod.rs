use serde_json::json;
use std::fs::OpenOptions;
use std::io::Write;
use std::path::Path;
use std::path::PathBuf;
use tauri::{AppHandle, State};

pub(crate) mod attachments;
use self::io::TextFileResponse;
use self::policy::{FileKind, FileScope};
use crate::remote_backend;
use crate::shared::codex_core;
use crate::shared::files_core::{file_read_core, file_write_core};
use crate::shared::message_reference_core::{
    create_content_reference_core, create_message_reference_core, ContentReferenceResponse,
    CreateContentReferenceRequest, CreateMessageReferenceRequest, MessageReferenceResponse,
};
use crate::state::AppState;

pub(crate) mod io;
pub(crate) mod ops;
pub(crate) mod policy;

async fn file_read_impl(
    scope: FileScope,
    kind: FileKind,
    workspace_id: Option<String>,
    state: &AppState,
    app: &AppHandle,
) -> Result<TextFileResponse, String> {
    if remote_backend::is_remote_mode(state).await {
        let response = remote_backend::call_remote(
            state,
            app.clone(),
            "file_read",
            json!({ "scope": scope, "kind": kind, "workspaceId": workspace_id }),
        )
        .await?;
        return serde_json::from_value(response).map_err(|err| err.to_string());
    }

    file_read_core(
        &state.workspaces,
        &state.app_settings,
        scope,
        kind,
        workspace_id,
    )
    .await
}

async fn file_write_impl(
    scope: FileScope,
    kind: FileKind,
    workspace_id: Option<String>,
    content: String,
    state: &AppState,
    app: &AppHandle,
) -> Result<(), String> {
    if remote_backend::is_remote_mode(state).await {
        remote_backend::call_remote(
            state,
            app.clone(),
            "file_write",
            json!({
                "scope": scope,
                "kind": kind,
                "workspaceId": workspace_id,
                "content": content,
            }),
        )
        .await?;
        return Ok(());
    }

    file_write_core(
        &state.workspaces,
        &state.app_settings,
        scope,
        kind,
        workspace_id,
        content,
    )
    .await
}

#[tauri::command]
pub(crate) async fn file_read(
    scope: FileScope,
    kind: FileKind,
    workspace_id: Option<String>,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<TextFileResponse, String> {
    file_read_impl(scope, kind, workspace_id, &*state, &app).await
}

#[tauri::command]
pub(crate) async fn file_write(
    scope: FileScope,
    kind: FileKind,
    workspace_id: Option<String>,
    content: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<(), String> {
    file_write_impl(scope, kind, workspace_id, content, &*state, &app).await
}

#[tauri::command]
pub(crate) async fn read_image_as_data_url(
    path: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<String, String> {
    let trimmed_path = path.trim();
    if trimmed_path.is_empty() {
        return Err("Image path is required".to_string());
    }

    let mobile_runtime = cfg!(any(target_os = "ios", target_os = "android"));
    let remote_mode = remote_backend::is_remote_mode(&*state).await;
    if !mobile_runtime && !remote_mode {
        return Err(
            "Image conversion is only supported in remote backend mode or on mobile runtimes"
                .to_string(),
        );
    }

    let normalized = codex_core::normalize_file_path(trimmed_path);
    if normalized.is_empty() {
        return Err("Image path is required".to_string());
    }

    let _ = app;
    codex_core::read_image_as_data_url_core(&normalized)
}

#[tauri::command]
pub(crate) async fn save_composer_images(
    workspace_id: String,
    owner_key: String,
    images: Vec<String>,
    state: State<'_, AppState>,
) -> Result<Vec<String>, String> {
    attachments::save_composer_images_impl(workspace_id, owner_key, images, &*state).await
}

#[tauri::command]
pub(crate) async fn promote_composer_images(
    workspace_id: String,
    thread_id: String,
    images: Vec<String>,
    state: State<'_, AppState>,
) -> Result<Vec<String>, String> {
    if remote_backend::is_remote_mode(&*state).await {
        return Ok(images);
    }
    attachments::promote_composer_images_impl(workspace_id, thread_id, images, &*state).await
}

#[tauri::command]
pub(crate) async fn create_message_reference(
    request: CreateMessageReferenceRequest,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<MessageReferenceResponse, String> {
    if remote_backend::is_remote_mode(&*state).await {
        let response = remote_backend::call_remote(
            &*state,
            app,
            "create_message_reference",
            serde_json::to_value(request).map_err(|error| error.to_string())?,
        )
        .await?;
        return serde_json::from_value(response).map_err(|error| error.to_string());
    }
    let settings = state.app_settings.lock().await.clone();
    let codex_home = crate::codex::home::resolve_settings_codex_home(&settings)
        .ok_or_else(|| "Unable to resolve CODEX_HOME".to_string())?;
    create_message_reference_core(&codex_home, request)
}

#[tauri::command]
pub(crate) async fn create_content_reference(
    request: CreateContentReferenceRequest,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<ContentReferenceResponse, String> {
    if remote_backend::is_remote_mode(&*state).await {
        let response = remote_backend::call_remote(
            &*state,
            app,
            "create_content_reference",
            serde_json::to_value(request).map_err(|error| error.to_string())?,
        )
        .await?;
        return serde_json::from_value(response).map_err(|error| error.to_string());
    }
    let settings = state.app_settings.lock().await.clone();
    let codex_home = crate::codex::home::resolve_settings_codex_home(&settings)
        .ok_or_else(|| "Unable to resolve CODEX_HOME".to_string())?;
    create_content_reference_core(&codex_home, request)
}

#[tauri::command]
pub(crate) fn write_text_file(path: String, content: String) -> Result<(), String> {
    let target = PathBuf::from(path.trim());
    if target.as_os_str().is_empty() {
        return Err("Path is required".to_string());
    }
    if let Some(parent) = target.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)
                .map_err(|err| format!("Failed to create export directory: {err}"))?;
        }
    }
    std::fs::write(&target, content).map_err(|err| format!("Failed to write export file: {err}"))
}

const MAX_EXPORT_BYTES: u64 = 128 * 1024 * 1024;

fn binary_export_temp_path(target: &Path) -> PathBuf {
    let mut path = target.as_os_str().to_os_string();
    path.push(".threadfleet-part");
    PathBuf::from(path)
}

#[cfg(target_os = "windows")]
fn finalize_binary_export(temp: &Path, target: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    let temp_wide = temp
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let target_wide = target
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let moved = unsafe {
        MoveFileExW(
            temp_wide.as_ptr(),
            target_wide.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if moved == 0 {
        return Err(format!(
            "Failed to finalize export file: {}",
            std::io::Error::last_os_error()
        ));
    }
    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn finalize_binary_export(temp: &Path, target: &Path) -> Result<(), String> {
    std::fs::rename(temp, target).map_err(|err| format!("Failed to finalize export file: {err}"))
}

#[tauri::command]
pub(crate) fn write_binary_file_chunk(
    path: String,
    content: Vec<u8>,
    offset: u64,
    total_length: u64,
) -> Result<bool, String> {
    let target = PathBuf::from(path.trim());
    if target.as_os_str().is_empty() {
        return Err("Path is required".to_string());
    }
    if total_length == 0 {
        return Err("Export content is empty".to_string());
    }
    if total_length > MAX_EXPORT_BYTES {
        return Err("Export file exceeds the 128 MB safety limit".to_string());
    }
    if content.is_empty() || offset.saturating_add(content.len() as u64) > total_length {
        return Err("Invalid export chunk bounds".to_string());
    }
    if let Some(parent) = target.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)
                .map_err(|err| format!("Failed to create export directory: {err}"))?;
        }
    }

    let temp = binary_export_temp_path(&target);
    let mut options = OpenOptions::new();
    options.create(true).write(true);
    if offset == 0 {
        options.truncate(true);
    } else {
        let current_length = std::fs::metadata(&temp)
            .map_err(|err| format!("Failed to inspect partial export file: {err}"))?
            .len();
        if current_length != offset {
            return Err("Export chunk offset does not match partial file".to_string());
        }
        options.append(true);
    }
    let mut file = options
        .open(&temp)
        .map_err(|err| format!("Failed to open partial export file: {err}"))?;
    file.write_all(&content)
        .map_err(|err| format!("Failed to write export chunk: {err}"))?;
    let written = offset + content.len() as u64;
    if written < total_length {
        return Ok(false);
    }

    file.sync_all()
        .map_err(|err| format!("Failed to flush export file: {err}"))?;
    drop(file);
    finalize_binary_export(&temp, &target)?;
    Ok(true)
}

#[tauri::command]
pub(crate) fn cancel_binary_file_write(path: String) -> Result<(), String> {
    let target = PathBuf::from(path.trim());
    if target.as_os_str().is_empty() {
        return Err("Path is required".to_string());
    }
    let temp = binary_export_temp_path(&target);
    if temp.exists() {
        std::fs::remove_file(temp)
            .map_err(|err| format!("Failed to remove partial export file: {err}"))?;
    }
    Ok(())
}

#[cfg(test)]
mod binary_export_tests {
    use super::*;
    use uuid::Uuid;

    #[test]
    fn writes_binary_export_chunks_atomically_and_cleans_cancelled_parts() {
        let root = std::env::temp_dir().join(format!("threadfleet-export-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&root).expect("create temp export directory");
        let target = root.join("conversation.pdf");
        let target_string = target.to_string_lossy().to_string();

        assert!(
            !write_binary_file_chunk(target_string.clone(), vec![1, 2], 0, 4)
                .expect("write first chunk")
        );
        assert!(!target.exists());
        assert!(binary_export_temp_path(&target).exists());
        assert!(
            write_binary_file_chunk(target_string.clone(), vec![3, 4], 2, 4)
                .expect("write final chunk")
        );
        assert_eq!(
            std::fs::read(&target).expect("read completed export"),
            vec![1, 2, 3, 4]
        );

        assert!(
            write_binary_file_chunk(target_string.clone(), vec![7, 8], 0, 2)
                .expect("replace completed export")
        );
        assert_eq!(
            std::fs::read(&target).expect("read replaced export"),
            vec![7, 8]
        );

        assert!(
            !write_binary_file_chunk(target_string.clone(), vec![5], 0, 2)
                .expect("start replacement")
        );
        cancel_binary_file_write(target_string).expect("cancel partial export");
        assert!(!binary_export_temp_path(&target).exists());
        assert_eq!(
            std::fs::read(&target).expect("keep completed export"),
            vec![7, 8]
        );

        std::fs::remove_dir_all(root).expect("remove temp export directory");
    }
}
