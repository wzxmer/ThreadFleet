use base64::prelude::*;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};
use tauri::Manager;
use uuid::Uuid;

use crate::codex::home::resolve_settings_codex_home;
use crate::shared::attachment_storage_core::{
    attachments_root, pending_attachment_dir, session_attachment_dir,
};
use crate::state::AppState;
use crate::types::AppSettings;

const LEGACY_ATTACHMENTS_DIR: &str = ".codex-monitor/attachments";
const PENDING_ATTACHMENT_MAX_AGE: Duration = Duration::from_secs(30 * 24 * 60 * 60);

pub(crate) fn allow_attachment_asset_scope(
    app_handle: &tauri::AppHandle,
    settings: &AppSettings,
) -> tauri::Result<()> {
    if let Some(codex_home) = resolve_settings_codex_home(settings) {
        app_handle
            .asset_protocol_scope()
            .allow_directory(attachments_root(&codex_home), true)?;
    }
    Ok(())
}

#[derive(Debug)]
struct AttachmentEntry {
    path: PathBuf,
    modified: SystemTime,
}

fn image_extension_for_mime(mime: &str) -> Option<&'static str> {
    match mime.to_ascii_lowercase().as_str() {
        "image/png" => Some("png"),
        "image/jpeg" | "image/jpg" => Some("jpg"),
        "image/gif" => Some("gif"),
        "image/webp" => Some("webp"),
        "image/bmp" => Some("bmp"),
        "image/tiff" => Some("tiff"),
        "image/heic" => Some("heic"),
        "image/heif" => Some("heif"),
        _ => None,
    }
}

fn image_extension_for_path(path: &Path) -> Option<String> {
    let extension = path
        .extension()?
        .to_string_lossy()
        .trim()
        .to_ascii_lowercase();
    match extension.as_str() {
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "tiff" | "tif" | "heic" | "heif" => {
            Some(extension)
        }
        _ => None,
    }
}

fn parse_data_url_image(input: &str) -> Result<Option<(&str, Vec<u8>)>, String> {
    let Some(rest) = input.strip_prefix("data:") else {
        return Ok(None);
    };
    let Some((meta, encoded)) = rest.split_once(',') else {
        return Err("Invalid image data URL".to_string());
    };
    let mut parts = meta.split(';');
    let mime = parts.next().unwrap_or_default();
    if !mime.starts_with("image/") {
        return Ok(None);
    }
    if !parts.any(|part| part.eq_ignore_ascii_case("base64")) {
        return Err("Image data URL must be base64 encoded".to_string());
    }
    let bytes = BASE64_STANDARD
        .decode(encoded.as_bytes())
        .map_err(|err| format!("Failed to decode pasted image: {err}"))?;
    Ok(Some((mime, bytes)))
}

fn ensure_attachment_dir(dir: &Path) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|err| format!("Failed to create attachment directory: {err}"))
}

fn unique_attachment_path(dir: &Path, extension: &str) -> PathBuf {
    let timestamp = chrono::Utc::now().format("%Y%m%d-%H%M%S%.3f");
    dir.join(format!(
        "image-{timestamp}-{}.{}",
        Uuid::new_v4(),
        extension
    ))
}

fn collect_attachment_entries(dir: &Path, entries: &mut Vec<AttachmentEntry>) {
    let Ok(read_dir) = fs::read_dir(dir) else {
        return;
    };
    for entry in read_dir.filter_map(Result::ok) {
        let path = entry.path();
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        if metadata.is_dir() {
            collect_attachment_entries(&path, entries);
        } else if metadata.is_file() {
            entries.push(AttachmentEntry {
                path,
                modified: metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH),
            });
        }
    }
}

fn prune_empty_dirs(start: Option<&Path>, boundary: &Path) {
    let mut current = start.map(Path::to_path_buf);
    while let Some(dir) = current {
        if dir == boundary || !dir.starts_with(boundary) {
            break;
        }
        let is_empty = fs::read_dir(&dir)
            .map(|mut entries| entries.next().is_none())
            .unwrap_or(false);
        if !is_empty || fs::remove_dir(&dir).is_err() {
            break;
        }
        current = dir.parent().map(Path::to_path_buf);
    }
}

fn cleanup_stale_pending_attachments(codex_home: &Path) {
    let pending_root = attachments_root(codex_home).join("pending");
    let mut entries = Vec::new();
    collect_attachment_entries(&pending_root, &mut entries);
    let now = SystemTime::now();
    for entry in entries {
        let expired = now
            .duration_since(entry.modified)
            .map(|age| age > PENDING_ATTACHMENT_MAX_AGE)
            .unwrap_or(false);
        if expired && fs::remove_file(&entry.path).is_ok() {
            prune_empty_dirs(entry.path.parent(), &pending_root);
        }
    }
}

fn path_is_within(path: &Path, root: &Path) -> bool {
    let Ok(path) = fs::canonicalize(path) else {
        return false;
    };
    let Ok(root) = fs::canonicalize(root) else {
        return false;
    };
    path.starts_with(root)
}

fn cleanup_empty_legacy_attachment_dir(workspace_path: &Path) {
    let legacy_dir = workspace_path.join(LEGACY_ATTACHMENTS_DIR);
    let Ok(entries) = fs::read_dir(&legacy_dir) else {
        return;
    };
    let entries = entries.filter_map(Result::ok).collect::<Vec<_>>();
    let has_cached_files = entries
        .iter()
        .any(|entry| entry.file_name().to_string_lossy() != ".gitignore");
    if has_cached_files {
        return;
    }
    let _ = fs::remove_file(legacy_dir.join(".gitignore"));
    let _ = fs::remove_dir(&legacy_dir);
    let metadata_dir = workspace_path.join(".codex-monitor");
    let metadata_is_empty = fs::read_dir(&metadata_dir)
        .map(|mut entries| entries.next().is_none())
        .unwrap_or(false);
    if metadata_is_empty {
        let _ = fs::remove_dir(metadata_dir);
    }
}

async fn resolve_attachment_context(
    workspace_id: &str,
    state: &AppState,
) -> Result<(PathBuf, PathBuf), String> {
    let workspace_path = {
        let workspaces = state.workspaces.lock().await;
        workspaces
            .get(workspace_id)
            .map(|workspace| PathBuf::from(&workspace.path))
            .ok_or_else(|| format!("Workspace not found: {workspace_id}"))?
    };
    let settings = state.app_settings.lock().await.clone();
    let codex_home = resolve_settings_codex_home(&settings)
        .ok_or_else(|| "Unable to resolve CODEX_HOME".to_string())?;
    Ok((workspace_path, codex_home))
}

fn save_images_to_dir(dir: &Path, images: Vec<String>) -> Result<Vec<String>, String> {
    ensure_attachment_dir(dir)?;
    let mut saved = Vec::new();
    for image in images {
        let trimmed = image.trim();
        if trimmed.is_empty() {
            continue;
        }

        if let Some((mime, bytes)) = parse_data_url_image(trimmed)? {
            let extension = image_extension_for_mime(mime)
                .ok_or_else(|| format!("Unsupported pasted image type: {mime}"))?;
            let target = unique_attachment_path(dir, extension);
            fs::write(&target, bytes)
                .map_err(|err| format!("Failed to save pasted image: {err}"))?;
            saved.push(target.to_string_lossy().to_string());
            continue;
        }

        if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
            saved.push(trimmed.to_string());
            continue;
        }

        let source = PathBuf::from(trimmed);
        if path_is_within(&source, dir) {
            saved.push(source.to_string_lossy().to_string());
            continue;
        }
        let extension = image_extension_for_path(&source)
            .ok_or_else(|| format!("Unsupported image extension: {trimmed}"))?;
        let target = unique_attachment_path(dir, &extension);
        fs::copy(&source, &target)
            .map_err(|err| format!("Failed to copy image attachment {trimmed}: {err}"))?;
        saved.push(target.to_string_lossy().to_string());
    }
    Ok(saved)
}

pub(crate) async fn cleanup_attachment_storage(state: &AppState) {
    let settings = state.app_settings.lock().await.clone();
    if let Some(codex_home) = resolve_settings_codex_home(&settings) {
        cleanup_stale_pending_attachments(&codex_home);
    }
    let workspace_paths = state
        .workspaces
        .lock()
        .await
        .values()
        .map(|workspace| PathBuf::from(&workspace.path))
        .collect::<Vec<_>>();
    for workspace_path in workspace_paths {
        cleanup_empty_legacy_attachment_dir(&workspace_path);
    }
}

pub(crate) async fn save_composer_images_impl(
    workspace_id: String,
    owner_key: String,
    images: Vec<String>,
    state: &AppState,
) -> Result<Vec<String>, String> {
    let (_, codex_home) = resolve_attachment_context(&workspace_id, state).await?;
    cleanup_stale_pending_attachments(&codex_home);
    let dir = pending_attachment_dir(&codex_home, &owner_key)?;
    save_images_to_dir(&dir, images)
}

pub(crate) async fn promote_composer_images_impl(
    workspace_id: String,
    thread_id: String,
    images: Vec<String>,
    state: &AppState,
) -> Result<Vec<String>, String> {
    let (workspace_path, codex_home) = resolve_attachment_context(&workspace_id, state).await?;
    let session_dir = session_attachment_dir(&codex_home, &thread_id)?;
    ensure_attachment_dir(&session_dir)?;
    let pending_root = attachments_root(&codex_home).join("pending");
    let legacy_root = workspace_path.join(LEGACY_ATTACHMENTS_DIR);
    let mut promoted = Vec::new();

    for image in images {
        let trimmed = image.trim();
        if trimmed.is_empty() {
            continue;
        }
        if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
            promoted.push(trimmed.to_string());
            continue;
        }
        if parse_data_url_image(trimmed)?.is_some() {
            promoted.extend(save_images_to_dir(&session_dir, vec![trimmed.to_string()])?);
            continue;
        }

        let source = PathBuf::from(trimmed);
        if path_is_within(&source, &session_dir) {
            promoted.push(source.to_string_lossy().to_string());
            continue;
        }
        let extension = image_extension_for_path(&source)
            .ok_or_else(|| format!("Unsupported image extension: {trimmed}"))?;
        let target = unique_attachment_path(&session_dir, &extension);
        fs::copy(&source, &target)
            .map_err(|err| format!("Failed to persist image attachment {trimmed}: {err}"))?;

        let managed_pending = path_is_within(&source, &pending_root);
        let managed_legacy = path_is_within(&source, &legacy_root);
        if managed_pending || managed_legacy {
            let _ = fs::remove_file(&source);
            if managed_pending {
                prune_empty_dirs(source.parent(), &pending_root);
            } else {
                prune_empty_dirs(source.parent(), &workspace_path);
                cleanup_empty_legacy_attachment_dir(&workspace_path);
            }
        }
        promoted.push(target.to_string_lossy().to_string());
    }

    Ok(promoted)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(prefix: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("{prefix}-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    #[test]
    fn parses_png_data_url() {
        let parsed = parse_data_url_image("data:image/png;base64,aGVsbG8=").expect("parse result");
        let (mime, bytes) = parsed.expect("image data");
        assert_eq!(mime, "image/png");
        assert_eq!(bytes, b"hello");
    }

    #[test]
    fn ignores_non_data_url() {
        let parsed = parse_data_url_image("/tmp/image.png").expect("parse result");
        assert!(parsed.is_none());
    }

    #[test]
    fn owner_paths_stay_below_codex_monitor_namespace() {
        let codex_home = PathBuf::from("C:/Users/Test/.codex");
        let session = session_attachment_dir(&codex_home, "../thread/unsafe").expect("session dir");
        let pending = pending_attachment_dir(&codex_home, "draft:workspace").expect("pending dir");
        assert!(session.starts_with(attachments_root(&codex_home).join("sessions")));
        assert!(pending.starts_with(attachments_root(&codex_home).join("pending")));
        assert_eq!(session.file_name().unwrap().to_string_lossy().len(), 64);
        assert_eq!(pending.file_name().unwrap().to_string_lossy().len(), 64);
    }

    #[test]
    fn empty_legacy_cache_is_removed_without_touching_workspace_files() {
        let workspace = temp_dir("codex-monitor-legacy-empty");
        fs::write(workspace.join("keep.txt"), "keep").expect("write workspace file");
        let legacy = workspace.join(LEGACY_ATTACHMENTS_DIR);
        fs::create_dir_all(&legacy).expect("create legacy dir");
        fs::write(legacy.join(".gitignore"), "*\n!.gitignore\n").expect("write gitignore");

        cleanup_empty_legacy_attachment_dir(&workspace);

        assert!(!legacy.exists());
        assert!(!workspace.join(".codex-monitor").exists());
        assert!(workspace.join("keep.txt").exists());
        let _ = fs::remove_dir_all(workspace);
    }

    #[test]
    fn non_empty_legacy_cache_is_preserved() {
        let workspace = temp_dir("codex-monitor-legacy-preserve");
        let legacy = workspace.join(LEGACY_ATTACHMENTS_DIR);
        fs::create_dir_all(&legacy).expect("create legacy dir");
        fs::write(legacy.join("image.png"), b"png").expect("write image");

        cleanup_empty_legacy_attachment_dir(&workspace);

        assert!(legacy.join("image.png").exists());
        let _ = fs::remove_dir_all(workspace);
    }
}
