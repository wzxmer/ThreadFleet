use std::path::{Path, PathBuf};

use crate::types::{ManagedSession, SessionFileConfidence, SessionSource};

use super::file_map::is_path_within_root;
use super::parser::parse_session_metadata;

pub(crate) fn delete_exact_archived_session(
    source: &SessionSource,
    session: &ManagedSession,
    path: &Path,
) -> Result<(), String> {
    if !session.is_archived || session.archived_at.is_none() {
        return Err("Managed session is not reliably archived".to_string());
    }
    if session.file_confidence != SessionFileConfidence::Exact {
        return Err("Managed session does not have an exact verified mapping".to_string());
    }
    let source_root = PathBuf::from(&source.codex_home_path);
    let archived_root = source_root.join("archived_sessions");
    let source_metadata =
        std::fs::symlink_metadata(&source_root).map_err(|error| error.to_string())?;
    let archived_metadata =
        std::fs::symlink_metadata(&archived_root).map_err(|error| error.to_string())?;
    let file_metadata = std::fs::symlink_metadata(path).map_err(|error| error.to_string())?;
    if source_metadata.file_type().is_symlink()
        || archived_metadata.file_type().is_symlink()
        || file_metadata.file_type().is_symlink()
    {
        return Err("Symbolic links cannot be permanently deleted".to_string());
    }
    if !source_metadata.is_dir() || !archived_metadata.is_dir() || !file_metadata.is_file() {
        return Err("Permanent delete target is not a verified archived session file".to_string());
    }
    if !is_path_within_root(path, &source_root) || !is_path_within_root(path, &archived_root) {
        return Err("Permanent delete target escapes the archived session root".to_string());
    }
    let file_name_matches = path
        .file_stem()
        .and_then(|value| value.to_str())
        .is_some_and(|value| value.ends_with(&session.thread_id));
    if !file_name_matches {
        return Err("Permanent delete filename does not match the thread id".to_string());
    }
    let parsed = parse_session_metadata(path)?;
    if parsed.thread_id != session.thread_id {
        return Err("Permanent delete file content does not match the thread id".to_string());
    }
    std::fs::remove_file(path).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use std::fs;

    use uuid::Uuid;

    use super::delete_exact_archived_session;
    use crate::types::{
        ManagedSession, SessionFileConfidence, SessionFileStatus, SessionSource,
        SessionSourceStatus,
    };

    fn fixture() -> (
        std::path::PathBuf,
        SessionSource,
        ManagedSession,
        std::path::PathBuf,
    ) {
        let root = std::env::temp_dir().join(format!("session-delete-{}", Uuid::new_v4()));
        let archived = root.join("archived_sessions");
        fs::create_dir_all(&archived).unwrap();
        let path = archived.join("rollout-thread-a.jsonl");
        fs::write(
            &path,
            "{\"type\":\"session_meta\",\"payload\":{\"id\":\"thread-a\"}}\n",
        )
        .unwrap();
        let source = SessionSource {
            id: "source-a".into(),
            name: "A".into(),
            codex_home_path: root.to_string_lossy().to_string(),
            enabled: true,
            is_current: false,
            is_default: false,
            discovered_at: 1,
            last_scan_at: None,
            status: SessionSourceStatus::Ready,
            error: None,
        };
        let session = ManagedSession {
            key: "source-a:thread-a".into(),
            source_id: "source-a".into(),
            thread_id: "thread-a".into(),
            source_kind: None,
            cwd: None,
            title: "A".into(),
            title_is_fallback: false,
            preview: None,
            created_at: None,
            updated_at: None,
            archived_at: Some(1),
            is_archived: true,
            parent_thread_id: None,
            is_subagent: false,
            subagent_nickname: None,
            subagent_role: None,
            project_exists: false,
            file_status: SessionFileStatus::Mapped,
            file_confidence: SessionFileConfidence::Exact,
        };
        (root, source, session, path)
    }

    #[test]
    fn deletes_only_exact_archived_file() {
        let (root, source, session, path) = fixture();
        delete_exact_archived_session(&source, &session, &path).unwrap();
        assert!(!path.exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn rejects_active_directory_and_thread_mismatch() {
        let (root, source, mut session, path) = fixture();
        session.thread_id = "thread-b".into();
        assert!(delete_exact_archived_session(&source, &session, &path).is_err());
        let active = root.join("sessions").join("rollout-thread-a.jsonl");
        fs::create_dir_all(active.parent().unwrap()).unwrap();
        fs::rename(&path, &active).unwrap();
        session.thread_id = "thread-a".into();
        assert!(delete_exact_archived_session(&source, &session, &active).is_err());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn rejects_non_archived_directory_and_content_mismatch() {
        let (root, source, mut session, path) = fixture();
        session.is_archived = false;
        assert!(delete_exact_archived_session(&source, &session, &path).is_err());
        session.is_archived = true;
        assert!(delete_exact_archived_session(&source, &session, path.parent().unwrap()).is_err());
        fs::write(
            &path,
            "{\"type\":\"session_meta\",\"payload\":{\"id\":\"thread-other\"}}\n",
        )
        .unwrap();
        assert!(delete_exact_archived_session(&source, &session, &path).is_err());
        assert!(path.exists());
        let _ = fs::remove_dir_all(root);
    }
}
