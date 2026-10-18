//! Host-local artifact routing shared by the app and daemon. This is an agent
//! output convention, not a filesystem redirect or an automatic deletion policy.
use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::sync::Mutex;

use crate::types::{AppSettings, WorkspaceEntry};
use crate::utils::normalize_windows_namespace_path;

pub(crate) fn normalize_artifact_root(value: Option<String>) -> Result<Option<String>, String> {
    let value = normalize_artifact_setting(value)?;
    if value
        .as_deref()
        .is_some_and(|value| !Path::new(value).is_absolute())
    {
        return Err("Artifact directory must be an absolute path on the execution host".into());
    }
    if let Some(value) = value.as_deref() {
        if Path::new(value).exists() && !Path::new(value).is_dir() {
            return Err("Artifact directory must point to a directory".into());
        }
    }
    Ok(value)
}

// The client can store another OS's absolute path. Only the execution host may
// test whether that path exists or is a usable directory.
pub(crate) fn normalize_artifact_setting(value: Option<String>) -> Result<Option<String>, String> {
    let Some(value) = value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    else {
        return Ok(None);
    };
    let value = normalize_windows_namespace_path(&value);
    let bytes = value.as_bytes();
    let windows_absolute = bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && matches!(bytes[2], b'/' | b'\\');
    if value.chars().any(char::is_control)
        || !(value.starts_with('/') || value.starts_with("\\\\") || windows_absolute)
    {
        return Err("Artifact directory must be an absolute path on the execution host".into());
    }
    Ok(Some(value))
}

pub(crate) fn artifact_root(
    settings: &AppSettings,
    settings_path: &Path,
) -> Result<PathBuf, String> {
    if let Some(path) = normalize_artifact_root(settings.artifact_root.clone())? {
        return Ok(PathBuf::from(path));
    }
    settings_path
        .parent()
        .map(|parent| parent.join("artifacts"))
        .ok_or_else(|| "Cannot resolve the default artifact directory".into())
}

fn directory_component(label: &str, identity: &str) -> String {
    let label: String = label
        .chars()
        .map(|ch| {
            if ch.is_alphanumeric() || ch == '-' || ch == '_' {
                ch
            } else {
                '-'
            }
        })
        .take(48)
        .collect();
    let label = label.trim_matches('-');
    let label = if label.is_empty() { "session" } else { label };
    let digest = format!("{:x}", Sha256::digest(identity.as_bytes()));
    format!("{label}-{}", &digest[..12])
}

pub(crate) struct ArtifactTurn {
    pub(crate) directory: PathBuf,
    pub(crate) additional_context: Option<Value>,
}

pub(crate) async fn prepare_artifact_turn(
    settings: &AppSettings,
    settings_path: &Path,
    workspaces: &Mutex<HashMap<String, WorkspaceEntry>>,
    workspace_id: &str,
    thread_id: &str,
    read_only: bool,
    additional_context: Option<Value>,
) -> Result<ArtifactTurn, String> {
    let workspace = workspaces
        .lock()
        .await
        .get(workspace_id)
        .cloned()
        .ok_or_else(|| "Workspace not found".to_string())?;
    let directory = artifact_root(settings, settings_path)?
        .join(directory_component(&workspace.name, &workspace.path))
        .join(directory_component(thread_id, thread_id));
    if !read_only {
        tokio::fs::create_dir_all(&directory)
            .await
            .map_err(|error| {
                format!(
                    "Cannot create artifact directory {}: {error}",
                    directory.display()
                )
            })?;
        let temporary = directory.join(".threadfleet-tmp");
        match tokio::fs::create_dir(&temporary).await {
            Ok(()) => {
                tokio::fs::write(
                    temporary.join(".threadfleet-disposable"),
                    b"ThreadFleet disposable cache v1",
                )
                .await
                .map_err(|e| e.to_string())?;
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error.to_string()),
        }
    }
    let mut context = match additional_context {
        None | Some(Value::Null) => serde_json::Map::new(),
        Some(Value::Object(context)) => context,
        _ => return Err("Additional context must be an object".into()),
    };
    context.insert(
        "cm.artifact-storage".into(),
        json!({
            "kind": "application",
            "value": artifact_instructions(&directory, read_only),
        }),
    );
    Ok(ArtifactTurn {
        directory,
        additional_context: Some(Value::Object(context)),
    })
}

pub(crate) fn artifact_instructions(directory: &Path, read_only: bool) -> String {
    let path = serde_json::to_string(&directory.to_string_lossy()).unwrap_or_default();
    format!(
        "ThreadFleet artifact directory for this project and session: {path}.\n\
         Store task-generated reports, screenshots, diagnostics, temporary build outputs and backups here; use task subdirectories as needed. \
         Keep product source, required project files and canonical knowledge in their owning locations. \
         Honor explicit user output paths. Reuse dependencies where practical instead of copying node_modules into each task. \
         Put only reproducible intermediate files in the reserved .threadfleet-tmp subdirectory; files there may be automatically removed after the configured retention period. \
         Never put reports, attachments, credentials, source, deployment backups or rollback materials in .threadfleet-tmp. \
         Do not move or delete existing artifacts or backups automatically. \
         This path is an output convention, not permission to bypass sandbox or approvals.{}",
        if read_only { " Read-only mode: do not create or write artifacts." } else { "" },
    )
}

pub(crate) async fn prepare_gemini_artifacts(
    settings: &AppSettings,
    settings_path: &Path,
    workspaces: &Mutex<HashMap<String, WorkspaceEntry>>,
    workspace_id: &str,
    operation: &str,
    mut params: Value,
) -> Result<Value, String> {
    // Never accept a client-supplied host artifact instruction.
    if let Some(object) = params.as_object_mut() {
        object.remove("artifactContext");
    }
    if operation == "send" {
        let thread_id = params
            .get("threadId")
            .and_then(Value::as_str)
            .ok_or_else(|| "Gemini thread ID is required".to_string())?;
        let read_only = params.get("accessMode").and_then(Value::as_str) == Some("read-only");
        let turn = prepare_artifact_turn(
            settings,
            settings_path,
            workspaces,
            workspace_id,
            thread_id,
            read_only,
            None,
        )
        .await?;
        params["artifactContext"] = json!(artifact_instructions(&turn.directory, read_only));
    }
    Ok(params)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn artifact_paths_are_host_absolute_and_optional() {
        assert_eq!(normalize_artifact_root(Some("  ".into())).unwrap(), None);
        assert!(normalize_artifact_root(Some("artifacts".into())).is_err());
        assert!(normalize_artifact_root(Some("bad\npath".into())).is_err());
        assert_eq!(
            normalize_artifact_setting(Some("/srv/artifacts".into())).unwrap(),
            Some("/srv/artifacts".into())
        );
        assert_eq!(
            normalize_artifact_setting(Some("D:\\Artifacts".into())).unwrap(),
            Some("D:\\Artifacts".into())
        );
        let root = std::env::temp_dir().join("tf-artifacts");
        assert_eq!(
            normalize_artifact_root(Some(root.to_string_lossy().into())).unwrap(),
            Some(root.to_string_lossy().into())
        );
    }

    #[test]
    fn artifact_components_do_not_escape_or_collide_after_sanitization() {
        let first = directory_component("../../same:name", "project-a");
        let second = directory_component("../../same/name", "project-b");
        assert!(!first.contains(['/', '\\', '.', ':']));
        assert_ne!(first, second);
        assert_eq!(first, directory_component("../../same:name", "project-a"));
    }

    #[test]
    fn artifact_turn_preserves_context_and_read_only_creates_nothing() {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(async {
                let root =
                    std::env::temp_dir().join(format!("tf-artifacts-{}", uuid::Uuid::new_v4()));
                let settings_path = root.join("settings.json");
                let workspace: WorkspaceEntry = serde_json::from_value(json!({
                    "id":"ws", "name":"Project", "path":root.join("project"), "settings":{}
                }))
                .unwrap();
                let workspaces = Mutex::new(HashMap::from([("ws".into(), workspace)]));
                let turn = prepare_artifact_turn(
                    &AppSettings::default(),
                    &settings_path,
                    &workspaces,
                    "ws",
                    "thread-a",
                    true,
                    Some(json!({"cm.rule.0":{"kind":"application","value":"keep"}})),
                )
                .await
                .unwrap();
                assert!(!root.exists());
                assert!(turn.directory.starts_with(root.join("artifacts")));
                assert_eq!(
                    turn.additional_context.as_ref().unwrap()["cm.rule.0"]["value"],
                    "keep"
                );
                assert!(
                    turn.additional_context.unwrap()["cm.artifact-storage"]["value"]
                        .as_str()
                        .unwrap()
                        .contains("Read-only")
                );
                let saved = prepare_artifact_turn(
                    &AppSettings::default(),
                    &settings_path,
                    &workspaces,
                    "ws",
                    "thread-a",
                    false,
                    None,
                )
                .await
                .unwrap();
                assert_eq!(saved.directory, turn.directory);
                assert!(saved.directory.is_dir());
                assert_eq!(
                    tokio::fs::read_to_string(
                        saved
                            .directory
                            .join(".threadfleet-tmp/.threadfleet-disposable")
                    )
                    .await
                    .unwrap(),
                    "ThreadFleet disposable cache v1"
                );
                let other = prepare_artifact_turn(
                    &AppSettings::default(),
                    &settings_path,
                    &workspaces,
                    "ws",
                    "thread-b",
                    true,
                    None,
                )
                .await
                .unwrap();
                assert_ne!(saved.directory, other.directory);
                let custom_root = root.join("custom artifacts");
                let settings: AppSettings = serde_json::from_value(json!({
                    "artifactRoot": custom_root.to_string_lossy(),
                }))
                .unwrap();
                let reloaded: AppSettings =
                    serde_json::from_value(serde_json::to_value(&settings).unwrap()).unwrap();
                let changed = prepare_artifact_turn(
                    &reloaded,
                    &settings_path,
                    &workspaces,
                    "ws",
                    "thread-a",
                    false,
                    None,
                )
                .await
                .unwrap();
                assert!(changed.directory.starts_with(&custom_root));
                assert!(
                    saved.directory.is_dir(),
                    "Changing the root must preserve old artifacts"
                );
                std::fs::remove_dir_all(root).unwrap();
            });
    }
}
