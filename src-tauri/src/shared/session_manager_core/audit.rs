use std::io::Write;
use std::path::Path;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::types::source_identity_key;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum DeletionReason {
    Manual,
    Automatic,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum DeletionResult {
    Success,
    Failure,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeletionAuditEntry {
    pub(crate) source_id: String,
    pub(crate) source_path_id: String,
    pub(crate) thread_id: String,
    pub(crate) archived_at: i64,
    pub(crate) deleted_at: i64,
    pub(crate) reason: DeletionReason,
    pub(crate) result: DeletionResult,
    pub(crate) error_summary: Option<String>,
    pub(crate) cascade_requested: bool,
}

pub(crate) fn append_deletion_audit(path: &Path, entry: &DeletionAuditEntry) -> Result<(), String> {
    append_deletion_audits(path, std::slice::from_ref(entry))
}

pub(crate) fn append_deletion_audits(
    path: &Path,
    entries: &[DeletionAuditEntry],
) -> Result<(), String> {
    if entries.is_empty() {
        return Ok(());
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|error| error.to_string())?;
    for entry in entries {
        let line = serde_json::to_string(entry).map_err(|error| error.to_string())?;
        writeln!(file, "{line}").map_err(|error| error.to_string())?;
    }
    file.sync_data().map_err(|error| error.to_string())
}

pub(crate) fn normalized_source_path_id(path: &str) -> String {
    let digest = Sha256::digest(source_identity_key(path).as_bytes());
    let value: String = digest
        .iter()
        .take(16)
        .map(|byte| format!("{byte:02x}"))
        .collect();
    format!("path-{value}")
}

#[cfg(test)]
mod tests {
    use std::fs;

    use uuid::Uuid;

    use super::{
        append_deletion_audit, append_deletion_audits, normalized_source_path_id,
        DeletionAuditEntry, DeletionReason, DeletionResult,
    };

    #[test]
    fn appends_content_free_audit_entry() {
        let root = std::env::temp_dir().join(format!("delete-audit-{}", Uuid::new_v4()));
        let path = root.join("audit.jsonl");
        append_deletion_audit(
            &path,
            &DeletionAuditEntry {
                source_id: "source-a".to_string(),
                source_path_id: normalized_source_path_id(r"C:\Users\Test\.codex"),
                thread_id: "thread-a".to_string(),
                archived_at: 1,
                deleted_at: 2,
                reason: DeletionReason::Manual,
                result: DeletionResult::Failure,
                error_summary: Some("permission denied".to_string()),
                cascade_requested: false,
            },
        )
        .unwrap();
        let content = fs::read_to_string(&path).unwrap();
        assert!(content.contains("thread-a"));
        assert!(content.contains("permission denied"));
        assert!(!content.contains("Users"));
        assert!(!content.contains("message"));
        assert!(!content.contains("reasoning"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn appends_multiple_entries_in_one_batch() {
        let root = std::env::temp_dir().join(format!("delete-audit-batch-{}", Uuid::new_v4()));
        let path = root.join("audit.jsonl");
        let entry = |thread_id: &str| DeletionAuditEntry {
            source_id: "source-a".to_string(),
            source_path_id: normalized_source_path_id(r"C:\Users\Test\.codex"),
            thread_id: thread_id.to_string(),
            archived_at: 1,
            deleted_at: 2,
            reason: DeletionReason::Automatic,
            result: DeletionResult::Success,
            error_summary: None,
            cascade_requested: false,
        };

        append_deletion_audits(&path, &[entry("thread-a"), entry("thread-b")]).unwrap();

        let lines = fs::read_to_string(&path).unwrap();
        assert_eq!(lines.lines().count(), 2);
        assert!(lines.contains("thread-a"));
        assert!(lines.contains("thread-b"));
        let _ = fs::remove_dir_all(root);
    }
}
