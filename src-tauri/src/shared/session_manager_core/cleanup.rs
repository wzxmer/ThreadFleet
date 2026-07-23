use std::collections::HashSet;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::types::{ManagedSession, SessionFileConfidence, SessionFileStatus};

pub(crate) const AUTO_DELETE_RETENTION_OPTIONS: [u32; 4] = [30, 60, 90, 180];
const DAY_MS: i64 = 24 * 60 * 60 * 1000;
pub(crate) const CLEANUP_CHECK_INTERVAL_MS: i64 = DAY_MS;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CleanupSchedulerState {
    pub(crate) enabled_at: Option<i64>,
    pub(crate) last_check_at: Option<i64>,
}

pub(crate) fn validate_retention_days(days: u32) -> Result<(), String> {
    if AUTO_DELETE_RETENTION_OPTIONS.contains(&days) {
        Ok(())
    } else {
        Err("Automatic delete retention must be 30, 60, 90, or 180 days".to_string())
    }
}

pub(crate) fn cleanup_eligible_sessions(
    sessions: &[ManagedSession],
    retention_days: u32,
    now_ms: i64,
    protected_thread_ids: &HashSet<String>,
) -> Result<Vec<ManagedSession>, String> {
    validate_retention_days(retention_days)?;
    let cutoff = now_ms.saturating_sub(i64::from(retention_days).saturating_mul(DAY_MS));
    Ok(sessions
        .iter()
        .filter(|session| {
            session.is_archived
                && session
                    .archived_at
                    .is_some_and(|archived_at| archived_at <= cutoff)
                && session.file_status == SessionFileStatus::Mapped
                && session.file_confidence == SessionFileConfidence::Exact
                && !protected_thread_ids.contains(&session.thread_id)
        })
        .cloned()
        .collect())
}

pub(crate) fn prepare_scheduled_cleanup(
    path: &Path,
    enabled: bool,
    startup: bool,
    now_ms: i64,
) -> Result<bool, String> {
    let mut state = read_cleanup_scheduler_state(path)?;
    if !enabled {
        if state.enabled_at.take().is_some() {
            write_cleanup_scheduler_state(path, &state)?;
        }
        return Ok(false);
    }

    let enabled_at = *state.enabled_at.get_or_insert(now_ms);
    let interval_elapsed = state.last_check_at.is_none_or(|last_check_at| {
        now_ms.saturating_sub(last_check_at) >= CLEANUP_CHECK_INTERVAL_MS
    });
    let enable_delay_elapsed = now_ms.saturating_sub(enabled_at) >= CLEANUP_CHECK_INTERVAL_MS;
    let should_run = interval_elapsed && (startup || enable_delay_elapsed);
    if should_run {
        state.last_check_at = Some(now_ms);
    }
    write_cleanup_scheduler_state(path, &state)?;
    Ok(should_run)
}

pub(crate) fn read_cleanup_scheduler_state(path: &Path) -> Result<CleanupSchedulerState, String> {
    restore_cleanup_scheduler_backup(path)?;
    if !path.exists() {
        return Ok(CleanupSchedulerState::default());
    }
    let data = std::fs::read_to_string(path).map_err(|error| error.to_string())?;
    if data.trim().is_empty() {
        return Ok(CleanupSchedulerState::default());
    }
    serde_json::from_str(&data).map_err(|error| format!("Invalid cleanup scheduler state: {error}"))
}

fn write_cleanup_scheduler_state(path: &Path, state: &CleanupSchedulerState) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let temp_path = temporary_path(path);
    let backup_path = backup_path(path);
    let data = serde_json::to_string_pretty(state).map_err(|error| error.to_string())?;
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

fn restore_cleanup_scheduler_backup(path: &Path) -> Result<(), String> {
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

    use super::*;

    fn session(thread_id: &str, archived_at: Option<i64>) -> ManagedSession {
        ManagedSession {
            key: format!("source-a:{thread_id}"),
            source_id: "source-a".to_string(),
            thread_id: thread_id.to_string(),
            source_kind: None,
            cwd: None,
            title: thread_id.to_string(),
            title_is_fallback: false,
            preview: None,
            created_at: None,
            updated_at: None,
            archived_at,
            is_archived: archived_at.is_some(),
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
    fn selects_only_expired_exact_unprotected_archives() {
        let day = DAY_MS;
        let now = 200 * day;
        let mut unmapped = session("unmapped", Some(100 * day));
        unmapped.file_confidence = SessionFileConfidence::Ambiguous;
        let sessions = vec![
            session("expired", Some(100 * day)),
            session("recent", Some(190 * day)),
            session("active", None),
            session("protected", Some(100 * day)),
            unmapped,
        ];
        let protected = HashSet::from(["protected".to_string()]);
        let eligible = cleanup_eligible_sessions(&sessions, 30, now, &protected).unwrap();
        assert_eq!(
            eligible
                .iter()
                .map(|session| session.thread_id.as_str())
                .collect::<Vec<_>>(),
            vec!["expired"]
        );
    }

    #[test]
    fn rejects_unsupported_retention() {
        assert!(cleanup_eligible_sessions(&[], 7, 0, &HashSet::new()).is_err());
    }

    #[test]
    fn scheduler_delays_same_run_enablement_but_runs_on_next_startup() {
        let root = std::env::temp_dir().join(format!("cleanup-scheduler-{}", Uuid::new_v4()));
        let path = root.join("state.json");
        let now = 100 * DAY_MS;
        assert!(!prepare_scheduled_cleanup(&path, true, false, now).unwrap());
        assert!(prepare_scheduled_cleanup(&path, true, true, now + 1).unwrap());
        assert!(!prepare_scheduled_cleanup(&path, true, true, now + 2).unwrap());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn scheduler_runs_after_enablement_and_check_intervals() {
        let root = std::env::temp_dir().join(format!("cleanup-scheduler-{}", Uuid::new_v4()));
        let path = root.join("state.json");
        let now = 100 * DAY_MS;
        assert!(!prepare_scheduled_cleanup(&path, true, false, now).unwrap());
        assert!(!prepare_scheduled_cleanup(&path, true, false, now + DAY_MS - 1).unwrap());
        assert!(prepare_scheduled_cleanup(&path, true, false, now + DAY_MS).unwrap());
        assert!(!prepare_scheduled_cleanup(&path, true, false, now + DAY_MS + 1).unwrap());
        assert!(prepare_scheduled_cleanup(&path, true, false, now + 2 * DAY_MS).unwrap());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn disabling_resets_enablement_delay() {
        let root = std::env::temp_dir().join(format!("cleanup-scheduler-{}", Uuid::new_v4()));
        let path = root.join("state.json");
        let now = 100 * DAY_MS;
        assert!(!prepare_scheduled_cleanup(&path, true, false, now).unwrap());
        assert!(!prepare_scheduled_cleanup(&path, false, false, now + 1).unwrap());
        assert!(!prepare_scheduled_cleanup(&path, true, false, now + DAY_MS + 1).unwrap());
        let state = read_cleanup_scheduler_state(&path).unwrap();
        assert_eq!(state.enabled_at, Some(now + DAY_MS + 1));
        let _ = fs::remove_dir_all(root);
    }
}
