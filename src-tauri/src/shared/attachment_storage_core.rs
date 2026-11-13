use sha2::{Digest, Sha256};
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

pub(crate) const ATTACHMENTS_DIR: &str = "codex-monitor/attachments";

pub(crate) fn attachment_owner_directory_name(owner_id: &str) -> Result<String, String> {
    let owner_id = owner_id.trim();
    if owner_id.is_empty() {
        return Err("Attachment owner is required".to_string());
    }
    let digest = Sha256::digest(owner_id.as_bytes());
    Ok(digest.iter().map(|byte| format!("{byte:02x}")).collect())
}

pub(crate) fn attachments_root(codex_home: &Path) -> PathBuf {
    codex_home.join(ATTACHMENTS_DIR)
}

pub(crate) fn pending_attachment_dir(codex_home: &Path, owner_id: &str) -> Result<PathBuf, String> {
    Ok(attachments_root(codex_home)
        .join("pending")
        .join(attachment_owner_directory_name(owner_id)?))
}

pub(crate) fn session_attachment_dir(
    codex_home: &Path,
    thread_id: &str,
) -> Result<PathBuf, String> {
    Ok(attachments_root(codex_home)
        .join("sessions")
        .join(attachment_owner_directory_name(thread_id)?))
}

#[derive(Debug, Clone)]
pub(crate) struct ValidatedSessionAttachmentCleanup {
    codex_home: PathBuf,
    thread_id: String,
}

impl ValidatedSessionAttachmentCleanup {
    pub(crate) fn delete(self) -> Result<(), String> {
        let Some(target) = validate_session_attachment_target(&self.codex_home, &self.thread_id)?
        else {
            return Ok(());
        };
        fs::remove_dir_all(&target)
            .map_err(|error| format!("Failed to remove session attachment directory: {error}"))
    }
}

pub(crate) fn validate_session_attachment_cleanup(
    codex_home: &Path,
    thread_id: &str,
) -> Result<ValidatedSessionAttachmentCleanup, String> {
    let thread_id = thread_id.trim();
    // CODEX_HOME may be a migration junction. Pin its resolved directory so
    // revalidation cannot follow a retargeted source link into different data.
    let codex_home = fs::canonicalize(codex_home)
        .map_err(|error| format!("Failed to resolve source CODEX_HOME: {error}"))?;
    validate_session_attachment_target(&codex_home, thread_id)?;
    Ok(ValidatedSessionAttachmentCleanup {
        codex_home,
        thread_id: thread_id.to_string(),
    })
}

fn validate_session_attachment_target(
    codex_home: &Path,
    thread_id: &str,
) -> Result<Option<PathBuf>, String> {
    let target = session_attachment_dir(codex_home, thread_id)?;
    let root = attachments_root(codex_home);
    let sessions_root = root.join("sessions");

    let source_metadata = fs::symlink_metadata(codex_home)
        .map_err(|error| format!("Failed to inspect source CODEX_HOME: {error}"))?;
    if source_metadata.file_type().is_symlink() || !source_metadata.is_dir() {
        return Err("Session attachment source must be a real directory".to_string());
    }

    let Some(root_metadata) = optional_symlink_metadata(&root)? else {
        return Ok(None);
    };
    validate_real_directory(&root_metadata)?;

    let Some(sessions_metadata) = optional_symlink_metadata(&sessions_root)? else {
        return Ok(None);
    };
    validate_real_directory(&sessions_metadata)?;

    let Some(target_metadata) = optional_symlink_metadata(&target)? else {
        return Ok(None);
    };
    validate_real_directory(&target_metadata)?;

    let source = fs::canonicalize(codex_home)
        .map_err(|error| format!("Failed to resolve source CODEX_HOME: {error}"))?;
    let root_resolved = fs::canonicalize(&root)
        .map_err(|error| format!("Failed to resolve attachment root: {error}"))?;
    let sessions_resolved = fs::canonicalize(&sessions_root)
        .map_err(|error| format!("Failed to resolve session attachment root: {error}"))?;
    let target_resolved = fs::canonicalize(&target)
        .map_err(|error| format!("Failed to resolve session attachment directory: {error}"))?;
    if !root_resolved.starts_with(&source)
        || !sessions_resolved.starts_with(&root_resolved)
        || target_resolved.parent() != Some(sessions_resolved.as_path())
    {
        return Err("Session attachment directory escapes its source boundary".to_string());
    }
    Ok(Some(target))
}

fn optional_symlink_metadata(path: &Path) -> Result<Option<fs::Metadata>, String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => Ok(Some(metadata)),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!(
            "Failed to inspect session attachment path: {error}"
        )),
    }
}

fn validate_real_directory(metadata: &fs::Metadata) -> Result<(), String> {
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err("Session attachment path is not a real directory".to_string());
    }
    Ok(())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use uuid::Uuid;

    fn temp_codex_home(prefix: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!("{prefix}-{}", Uuid::new_v4()));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[cfg(windows)]
    pub(crate) fn create_directory_junction(target: &Path, link: &Path) {
        use std::os::windows::process::CommandExt;

        let output = std::process::Command::new("cmd")
            .args(["/d", "/c", "mklink", "/J"])
            .arg(link.to_string_lossy().replace('/', "\\"))
            .arg(target.to_string_lossy().replace('/', "\\"))
            .creation_flags(0x08000000)
            .output()
            .unwrap();
        assert!(output.status.success(), "{output:?}");
    }

    #[cfg(windows)]
    #[test]
    fn cleanup_pins_the_resolved_junction_source() {
        let root = temp_codex_home("session-attachments-junction");
        let home = root.join("data");
        let other_home = root.join("other-data");
        let target = session_attachment_dir(&home, "thread-a").unwrap();
        let other = session_attachment_dir(&other_home, "thread-a").unwrap();
        fs::create_dir_all(&target).unwrap();
        fs::create_dir_all(&other).unwrap();
        fs::write(other.join("keep.png"), b"keep").unwrap();
        let link = root.join("codex-home");
        create_directory_junction(&home, &link);

        let cleanup = validate_session_attachment_cleanup(&link, "thread-a").unwrap();
        fs::remove_dir(&link).unwrap();
        create_directory_junction(&other_home, &link);
        cleanup.delete().unwrap();

        assert!(!target.exists());
        assert!(other.join("keep.png").exists());
        fs::remove_dir(&link).unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn rejects_junction_attachment_directories() {
        for level in ["root", "sessions", "target"] {
            let home = temp_codex_home("session-attachments-nested-junction");
            let outside = temp_codex_home("session-attachments-outside");
            fs::write(outside.join("keep.png"), b"keep").unwrap();
            let link = match level {
                "root" => attachments_root(&home),
                "sessions" => attachments_root(&home).join("sessions"),
                _ => session_attachment_dir(&home, "thread-a").unwrap(),
            };
            fs::create_dir_all(link.parent().unwrap()).unwrap();
            create_directory_junction(&outside, &link);

            assert!(validate_session_attachment_cleanup(&home, "thread-a").is_err());
            assert!(outside.join("keep.png").exists());

            fs::remove_dir(&link).unwrap();
            fs::remove_dir_all(home).unwrap();
            fs::remove_dir_all(outside).unwrap();
        }
    }

    #[test]
    fn deletes_only_the_requested_session_directory() {
        let codex_home = temp_codex_home("session-attachments-delete");
        let target = session_attachment_dir(&codex_home, "thread-a").unwrap();
        let other = session_attachment_dir(&codex_home, "thread-b").unwrap();
        let pending = pending_attachment_dir(&codex_home, "draft-a").unwrap();
        fs::create_dir_all(&target).unwrap();
        fs::create_dir_all(&other).unwrap();
        fs::create_dir_all(&pending).unwrap();
        fs::write(target.join("image.png"), b"a").unwrap();
        fs::write(other.join("image.png"), b"b").unwrap();
        fs::write(pending.join("image.png"), b"p").unwrap();

        validate_session_attachment_cleanup(&codex_home, "thread-a")
            .unwrap()
            .delete()
            .unwrap();

        assert!(!target.exists());
        assert!(other.join("image.png").exists());
        assert!(pending.join("image.png").exists());
        let _ = fs::remove_dir_all(codex_home);
    }

    #[test]
    fn missing_attachment_storage_is_a_noop() {
        let codex_home = temp_codex_home("session-attachments-missing");
        validate_session_attachment_cleanup(&codex_home, "thread-a")
            .unwrap()
            .delete()
            .unwrap();
        assert!(!attachments_root(&codex_home).exists());
        let _ = fs::remove_dir_all(codex_home);
    }

    #[test]
    fn rejects_non_directory_session_target() {
        let codex_home = temp_codex_home("session-attachments-file-target");
        let target = session_attachment_dir(&codex_home, "thread-a").unwrap();
        fs::create_dir_all(target.parent().unwrap()).unwrap();
        fs::write(&target, b"not a directory").unwrap();
        let error = validate_session_attachment_cleanup(&codex_home, "thread-a").unwrap_err();
        assert!(!error.contains(&codex_home.to_string_lossy().to_string()));
        assert!(target.exists());
        let _ = fs::remove_dir_all(codex_home);
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlink_session_target() {
        use std::os::unix::fs::symlink;

        let codex_home = temp_codex_home("session-attachments-symlink");
        let outside = temp_codex_home("session-attachments-outside");
        let target = session_attachment_dir(&codex_home, "thread-a").unwrap();
        fs::create_dir_all(target.parent().unwrap()).unwrap();
        symlink(&outside, &target).unwrap();
        assert!(validate_session_attachment_cleanup(&codex_home, "thread-a").is_err());
        assert!(outside.exists());
        let _ = fs::remove_file(target);
        let _ = fs::remove_dir_all(codex_home);
        let _ = fs::remove_dir_all(outside);
    }
}
