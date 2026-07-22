use std::fmt::Write;
use std::fs;
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

const MISSING_PROJECT_MOUNTS_DIR: &str = "missing-project-mounts";
const MISSING_PROJECT_DISPLAY_PREFIX: &str = "项目不存在";

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ManagedSessionWorkspaceTarget {
    pub(crate) path: PathBuf,
    pub(crate) display_name: Option<String>,
}

fn digest_hex(digest: &[u8]) -> String {
    let mut value = String::with_capacity(digest.len() * 2);
    for byte in digest {
        let _ = write!(value, "{byte:02x}");
    }
    value
}

fn display_suffix(digest: &[u8]) -> String {
    digest
        .iter()
        .take(3)
        .map(|byte| char::from(b'A' + (byte % 26)))
        .collect()
}

pub(crate) fn resolve_managed_session_workspace_target(
    storage_dir: &Path,
    source_id: &str,
    thread_id: &str,
    original_cwd: Option<&str>,
) -> Result<ManagedSessionWorkspaceTarget, String> {
    let original_cwd = original_cwd
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if let Some(cwd) = original_cwd {
        let path = PathBuf::from(cwd);
        if path.is_dir() {
            return Ok(ManagedSessionWorkspaceTarget {
                path,
                display_name: None,
            });
        }
    }

    let identity = original_cwd.unwrap_or(thread_id.trim());
    let mut hasher = Sha256::new();
    hasher.update(source_id.trim().as_bytes());
    hasher.update([0]);
    hasher.update(identity.as_bytes());
    let digest = hasher.finalize();
    let path = storage_dir
        .join(MISSING_PROJECT_MOUNTS_DIR)
        .join(digest_hex(&digest));
    fs::create_dir_all(&path)
        .map_err(|error| format!("Failed to create missing project mount: {error}"))?;

    Ok(ManagedSessionWorkspaceTarget {
        path,
        display_name: Some(format!(
            "{MISSING_PROJECT_DISPLAY_PREFIX}-{}",
            display_suffix(&digest)
        )),
    })
}

#[cfg(test)]
mod tests {
    use std::fs;

    use uuid::Uuid;

    use super::resolve_managed_session_workspace_target;

    #[test]
    fn creates_stable_isolated_mounts_for_missing_projects() {
        let root = std::env::temp_dir().join(format!("missing-project-mount-{}", Uuid::new_v4()));

        let first = resolve_managed_session_workspace_target(
            &root,
            "source-a",
            "thread-a",
            Some("D:/missing/alpha"),
        )
        .unwrap();
        let repeated = resolve_managed_session_workspace_target(
            &root,
            "source-a",
            "thread-b",
            Some("D:/missing/alpha"),
        )
        .unwrap();
        let second = resolve_managed_session_workspace_target(
            &root,
            "source-a",
            "thread-c",
            Some("D:/missing/beta"),
        )
        .unwrap();

        assert_eq!(first, repeated);
        assert_ne!(first.path, second.path);
        assert!(first.path.is_dir());
        assert!(first
            .display_name
            .as_deref()
            .is_some_and(|name| name.starts_with("项目不存在-") && name.chars().count() == 9));
        let _ = fs::remove_dir_all(root);
    }
}
