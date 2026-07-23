use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::types::ManagedSession;

const ARCHIVE_LEDGER_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ArchiveTimeSource {
    Upstream,
    ConfirmedLocal,
    FirstDiscovery,
}

impl ArchiveTimeSource {
    fn priority(self) -> u8 {
        match self {
            Self::Upstream => 3,
            Self::ConfirmedLocal => 2,
            Self::FirstDiscovery => 1,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ArchiveLedgerEntry {
    pub(crate) source_id: String,
    pub(crate) thread_id: String,
    pub(crate) archived_at: i64,
    pub(crate) time_source: ArchiveTimeSource,
    pub(crate) first_discovered_at: i64,
    pub(crate) updated_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ArchiveLedger {
    pub(crate) version: u32,
    pub(crate) entries: HashMap<String, ArchiveLedgerEntry>,
}

impl Default for ArchiveLedger {
    fn default() -> Self {
        Self {
            version: ARCHIVE_LEDGER_VERSION,
            entries: HashMap::new(),
        }
    }
}

pub(crate) fn apply_archive_ledger(
    sessions: &mut [ManagedSession],
    path: &Path,
    now: i64,
) -> Result<(), String> {
    let mut ledger = read_archive_ledger(path)?;
    let mut changed = false;
    for session in sessions.iter_mut().filter(|session| session.is_archived) {
        let source = if session.archived_at.is_some() {
            ArchiveTimeSource::Upstream
        } else {
            ArchiveTimeSource::FirstDiscovery
        };
        let candidate_time = session.archived_at.unwrap_or(now);
        let entry = upsert_archive_time(
            &mut ledger,
            &session.source_id,
            &session.thread_id,
            candidate_time,
            source,
            now,
        );
        changed |= entry.changed;
        session.archived_at = Some(entry.archived_at);
    }
    if changed {
        write_archive_ledger(path, &ledger)?;
    }
    Ok(())
}

pub(crate) fn record_confirmed_archive_time(
    path: &Path,
    source_id: &str,
    thread_id: &str,
    archived_at: i64,
) -> Result<(), String> {
    let mut ledger = read_archive_ledger(path)?;
    upsert_archive_time(
        &mut ledger,
        source_id,
        thread_id,
        archived_at,
        ArchiveTimeSource::ConfirmedLocal,
        archived_at,
    );
    write_archive_ledger(path, &ledger)
}

pub(crate) fn remove_archive_times(path: &Path, keys: &[String]) -> Result<(), String> {
    let mut ledger = read_archive_ledger(path)?;
    let mut changed = false;
    for key in keys {
        changed |= ledger.entries.remove(key).is_some();
    }
    if changed {
        write_archive_ledger(path, &ledger)?;
    }
    Ok(())
}

pub(crate) fn read_archive_ledger(path: &Path) -> Result<ArchiveLedger, String> {
    restore_archive_ledger_backup(path)?;
    if !path.exists() {
        return Ok(ArchiveLedger::default());
    }
    let data = std::fs::read_to_string(path).map_err(|error| error.to_string())?;
    if data.trim().is_empty() {
        return Ok(ArchiveLedger::default());
    }
    if let Ok(mut ledger) = serde_json::from_str::<ArchiveLedger>(&data) {
        ledger.version = ARCHIVE_LEDGER_VERSION;
        return Ok(ledger);
    }
    let legacy = serde_json::from_str::<HashMap<String, i64>>(&data)
        .map_err(|error| format!("Invalid archive ledger: {error}"))?;
    let mut ledger = ArchiveLedger::default();
    for (key, archived_at) in legacy {
        let Some((source_id, thread_id)) = key.split_once(':') else {
            continue;
        };
        let source_id = source_id.to_string();
        let thread_id = thread_id.to_string();
        ledger.entries.insert(
            key,
            ArchiveLedgerEntry {
                source_id,
                thread_id,
                archived_at,
                time_source: ArchiveTimeSource::ConfirmedLocal,
                first_discovered_at: archived_at,
                updated_at: archived_at,
            },
        );
    }
    write_archive_ledger(path, &ledger)?;
    Ok(ledger)
}

fn write_archive_ledger(path: &Path, ledger: &ArchiveLedger) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let temp_path = temporary_path(path);
    let backup_path = backup_path(path);
    let data = serde_json::to_string_pretty(ledger).map_err(|error| error.to_string())?;
    std::fs::write(&temp_path, data).map_err(|error| error.to_string())?;
    if path.exists() {
        if backup_path.exists() {
            std::fs::remove_file(&backup_path).map_err(|error| error.to_string())?;
        }
        std::fs::rename(path, &backup_path).map_err(|error| error.to_string())?;
    }
    match std::fs::rename(&temp_path, path) {
        Ok(()) => {
            if backup_path.exists() {
                std::fs::remove_file(backup_path).map_err(|error| error.to_string())?;
            }
            Ok(())
        }
        Err(error) => {
            let _ = std::fs::remove_file(&temp_path);
            if backup_path.exists() && !path.exists() {
                let _ = std::fs::rename(&backup_path, path);
            }
            Err(error.to_string())
        }
    }
}

struct UpsertResult {
    archived_at: i64,
    changed: bool,
}

fn upsert_archive_time(
    ledger: &mut ArchiveLedger,
    source_id: &str,
    thread_id: &str,
    archived_at: i64,
    source: ArchiveTimeSource,
    now: i64,
) -> UpsertResult {
    let key = format!("{source_id}:{thread_id}");
    match ledger.entries.get_mut(&key) {
        Some(current)
            if source.priority() > current.time_source.priority()
                || (source == current.time_source
                    && source != ArchiveTimeSource::FirstDiscovery
                    && archived_at != current.archived_at) =>
        {
            current.archived_at = archived_at;
            current.time_source = source;
            current.updated_at = now;
            UpsertResult {
                archived_at,
                changed: true,
            }
        }
        Some(current) => UpsertResult {
            archived_at: current.archived_at,
            changed: false,
        },
        None => {
            ledger.entries.insert(
                key,
                ArchiveLedgerEntry {
                    source_id: source_id.to_string(),
                    thread_id: thread_id.to_string(),
                    archived_at,
                    time_source: source,
                    first_discovered_at: now,
                    updated_at: now,
                },
            );
            UpsertResult {
                archived_at,
                changed: true,
            }
        }
    }
}

fn temporary_path(path: &Path) -> PathBuf {
    let mut value = path.as_os_str().to_os_string();
    value.push(".tmp");
    PathBuf::from(value)
}

fn backup_path(path: &Path) -> PathBuf {
    let mut value = path.as_os_str().to_os_string();
    value.push(".bak");
    PathBuf::from(value)
}

fn restore_archive_ledger_backup(path: &Path) -> Result<(), String> {
    let backup_path = backup_path(path);
    if !path.exists() && backup_path.exists() {
        std::fs::rename(backup_path, path).map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::fs;

    use uuid::Uuid;

    use super::{
        apply_archive_ledger, read_archive_ledger, record_confirmed_archive_time,
        remove_archive_times, ArchiveTimeSource,
    };
    use crate::types::{ManagedSession, SessionFileConfidence, SessionFileStatus};

    fn archived_session() -> ManagedSession {
        ManagedSession {
            key: "source-a:thread-a".to_string(),
            source_id: "source-a".to_string(),
            thread_id: "thread-a".to_string(),
            source_kind: None,
            cwd: None,
            title: "Archived".to_string(),
            title_is_fallback: false,
            preview: None,
            created_at: None,
            updated_at: None,
            archived_at: None,
            is_archived: true,
            parent_thread_id: None,
            is_subagent: false,
            subagent_nickname: None,
            subagent_role: None,
            project_exists: false,
            file_status: SessionFileStatus::Mapped,
            file_confidence: SessionFileConfidence::Exact,
        }
    }

    #[test]
    fn prioritizes_upstream_then_confirmed_then_first_discovery() {
        let root = std::env::temp_dir().join(format!("archive-ledger-{}", Uuid::new_v4()));
        let path = root.join("ledger.json");
        let mut sessions = vec![archived_session()];
        apply_archive_ledger(&mut sessions, &path, 1_000).unwrap();
        assert_eq!(sessions[0].archived_at, Some(1_000));
        record_confirmed_archive_time(&path, "source-a", "thread-a", 900).unwrap();
        sessions[0].archived_at = None;
        apply_archive_ledger(&mut sessions, &path, 2_000).unwrap();
        assert_eq!(sessions[0].archived_at, Some(900));
        record_confirmed_archive_time(&path, "source-a", "thread-a", 950).unwrap();
        sessions[0].archived_at = None;
        apply_archive_ledger(&mut sessions, &path, 2_500).unwrap();
        assert_eq!(sessions[0].archived_at, Some(950));
        sessions[0].archived_at = Some(800);
        apply_archive_ledger(&mut sessions, &path, 3_000).unwrap();
        assert_eq!(sessions[0].archived_at, Some(800));
        let ledger = read_archive_ledger(&path).unwrap();
        assert_eq!(
            ledger.entries["source-a:thread-a"].time_source,
            ArchiveTimeSource::Upstream
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn preserves_first_discovery_time_across_scans() {
        let root = std::env::temp_dir().join(format!("archive-ledger-stable-{}", Uuid::new_v4()));
        let path = root.join("ledger.json");
        let mut sessions = vec![archived_session()];
        apply_archive_ledger(&mut sessions, &path, 1_000).unwrap();
        sessions[0].archived_at = None;
        apply_archive_ledger(&mut sessions, &path, 9_000).unwrap();
        assert_eq!(sessions[0].archived_at, Some(1_000));
        let ledger = read_archive_ledger(&path).unwrap();
        assert_eq!(
            ledger.entries["source-a:thread-a"].first_discovered_at,
            1_000
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn migrates_legacy_timestamp_map() {
        let root = std::env::temp_dir().join(format!("archive-ledger-migrate-{}", Uuid::new_v4()));
        let path = root.join("ledger.json");
        fs::create_dir_all(&root).unwrap();
        fs::write(&path, r#"{"source-a:thread-a":123}"#).unwrap();
        let ledger = read_archive_ledger(&path).unwrap();
        assert_eq!(ledger.entries["source-a:thread-a"].archived_at, 123);
        assert_eq!(
            ledger.entries["source-a:thread-a"].time_source,
            ArchiveTimeSource::ConfirmedLocal
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn removes_deleted_session_times() {
        let root = std::env::temp_dir().join(format!("archive-ledger-remove-{}", Uuid::new_v4()));
        let path = root.join("ledger.json");
        record_confirmed_archive_time(&path, "source-a", "thread-a", 123).unwrap();
        remove_archive_times(&path, &["source-a:thread-a".to_string()]).unwrap();
        assert!(read_archive_ledger(&path).unwrap().entries.is_empty());
        let _ = fs::remove_dir_all(root);
    }
}
