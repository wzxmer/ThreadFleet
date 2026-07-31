use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const SIDECAR_VERSION: u32 = 1;
const DEFAULT_MAX_PER_THREAD: usize = 32;
const DEFAULT_MAX_TOTAL: usize = 2_048;
const SIDECAR_FILE: &str = "turn-execution-summaries.json";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TurnExecutionStatus {
    Active,
    Completed,
    Interrupted,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnExecutionSummary {
    pub schema_version: u32,
    pub execution_id: String,
    pub workspace_id: String,
    pub thread_id: String,
    pub turn_id: String,
    pub turn_chain: Vec<String>,
    #[serde(default)]
    pub model_id: Option<String>,
    pub status: TurnExecutionStatus,
    pub started_at_ms: u64,
    pub ended_at_ms: Option<u64>,
    pub working_duration_ms: Option<u64>,
    pub added_lines: Option<u64>,
    pub deleted_lines: Option<u64>,
    pub diff_revision: u64,
    pub record_revision: u64,
    pub updated_at_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnExecutionSummaryUpsert {
    #[serde(default)]
    pub source_id: String,
    #[serde(default)]
    pub runtime_id: String,
    pub summary: TurnExecutionSummary,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnExecutionSummaryQuery {
    #[serde(default)]
    pub source_id: String,
    #[serde(default)]
    pub runtime_id: String,
    pub workspace_id: String,
    pub thread_id: String,
}

pub fn source_id_for_codex_home(path: &Path) -> String {
    scoped_path_id("source", path)
}

pub fn runtime_id_for_data_dir(path: &Path) -> String {
    scoped_path_id("runtime", path)
}

fn scoped_path_id(prefix: &str, path: &Path) -> String {
    let normalized = path
        .to_string_lossy()
        .replace('\\', "/")
        .trim_end_matches('/')
        .to_lowercase();
    let digest = Sha256::digest(normalized.as_bytes());
    format!("{prefix}-{:x}", digest)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredSummary {
    source_id: String,
    runtime_id: String,
    summary: TurnExecutionSummary,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct Document {
    version: u32,
    summaries: Vec<StoredSummary>,
}

impl Default for Document {
    fn default() -> Self {
        Self {
            version: SIDECAR_VERSION,
            summaries: Vec::new(),
        }
    }
}

pub struct TurnExecutionSummarySidecar {
    path: PathBuf,
    max_per_thread: usize,
    max_total: usize,
}

impl TurnExecutionSummarySidecar {
    pub fn for_data_dir(data_dir: &Path) -> Self {
        Self::new(
            data_dir.join(SIDECAR_FILE),
            DEFAULT_MAX_PER_THREAD,
            DEFAULT_MAX_TOTAL,
        )
    }

    fn new(path: PathBuf, max_per_thread: usize, max_total: usize) -> Self {
        Self {
            path,
            max_per_thread,
            max_total,
        }
    }

    pub fn get(
        &mut self,
        query: &TurnExecutionSummaryQuery,
    ) -> Result<Vec<TurnExecutionSummary>, String> {
        validate_scope(
            &query.source_id,
            &query.runtime_id,
            &query.workspace_id,
            &query.thread_id,
        )?;
        let mut document = read_document(&self.path)?;
        prune(&mut document, self.max_per_thread, self.max_total);
        let mut summaries = document
            .summaries
            .into_iter()
            .filter(|entry| matches_query(entry, query))
            .map(|entry| entry.summary)
            .collect::<Vec<_>>();
        summaries.sort_by(summary_newest_first);
        Ok(summaries)
    }

    pub fn upsert(
        &mut self,
        input: TurnExecutionSummaryUpsert,
    ) -> Result<TurnExecutionSummary, String> {
        validate_scope(
            &input.source_id,
            &input.runtime_id,
            &input.summary.workspace_id,
            &input.summary.thread_id,
        )?;
        validate_summary(&input.summary)?;
        let mut document = read_document(&self.path)?;
        if let Some(existing) = document.summaries.iter().find(|existing| {
            same_record(
                existing,
                &input.source_id,
                &input.runtime_id,
                &input.summary,
            )
        }) {
            if existing.summary.record_revision > input.summary.record_revision {
                return Ok(existing.summary.clone());
            }
            if existing.summary.record_revision == input.summary.record_revision {
                if existing.summary == input.summary {
                    return Ok(existing.summary.clone());
                }
                return Err("turn execution summary revision conflict".to_string());
            }
            if existing.summary.execution_id == input.summary.execution_id
                && existing.summary.status != TurnExecutionStatus::Active
            {
                if input.summary.status == TurnExecutionStatus::Active {
                    return Err("terminal turn execution summary cannot become active".to_string());
                }
                if input.summary.status != existing.summary.status {
                    return Ok(existing.summary.clone());
                }
                if existing.summary.started_at_ms != input.summary.started_at_ms
                    || existing.summary.ended_at_ms != input.summary.ended_at_ms
                    || existing.summary.working_duration_ms != input.summary.working_duration_ms
                {
                    return Err("terminal turn execution summary timing is immutable".to_string());
                }
            }
        }
        document.summaries.retain(|existing| {
            !same_record(
                existing,
                &input.source_id,
                &input.runtime_id,
                &input.summary,
            )
        });
        document.summaries.push(StoredSummary {
            source_id: input.source_id,
            runtime_id: input.runtime_id,
            summary: input.summary.clone(),
        });
        prune(&mut document, self.max_per_thread, self.max_total);
        write_atomically(&self.path, &document)?;
        Ok(input.summary)
    }
}

fn matches_query(entry: &StoredSummary, query: &TurnExecutionSummaryQuery) -> bool {
    entry.source_id == query.source_id
        && entry.runtime_id == query.runtime_id
        && entry.summary.workspace_id == query.workspace_id
        && entry.summary.thread_id == query.thread_id
}

fn same_record(
    entry: &StoredSummary,
    source_id: &str,
    runtime_id: &str,
    summary: &TurnExecutionSummary,
) -> bool {
    entry.source_id == source_id
        && entry.runtime_id == runtime_id
        && entry.summary.workspace_id == summary.workspace_id
        && entry.summary.thread_id == summary.thread_id
        && (entry.summary.turn_id == summary.turn_id
            || entry.summary.execution_id == summary.execution_id)
}

fn same_thread_scope(left: &StoredSummary, right: &StoredSummary) -> bool {
    left.source_id == right.source_id
        && left.runtime_id == right.runtime_id
        && left.summary.workspace_id == right.summary.workspace_id
        && left.summary.thread_id == right.summary.thread_id
}

fn summary_newest_first(
    left: &TurnExecutionSummary,
    right: &TurnExecutionSummary,
) -> std::cmp::Ordering {
    right
        .updated_at_ms
        .cmp(&left.updated_at_ms)
        .then_with(|| left.execution_id.cmp(&right.execution_id))
}

fn stored_newest_first(left: &StoredSummary, right: &StoredSummary) -> std::cmp::Ordering {
    summary_newest_first(&left.summary, &right.summary)
        .then_with(|| left.source_id.cmp(&right.source_id))
        .then_with(|| left.runtime_id.cmp(&right.runtime_id))
        .then_with(|| left.summary.workspace_id.cmp(&right.summary.workspace_id))
        .then_with(|| left.summary.thread_id.cmp(&right.summary.thread_id))
}

fn prune(document: &mut Document, max_per_thread: usize, max_total: usize) {
    document.summaries.sort_by(stored_newest_first);
    let mut retained = Vec::new();
    for entry in document.summaries.drain(..) {
        if retained
            .iter()
            .filter(|existing| same_thread_scope(existing, &entry))
            .count()
            < max_per_thread
        {
            retained.push(entry);
        }
    }
    retained.truncate(max_total);
    document.summaries = retained;
}

fn validate_scope(
    source_id: &str,
    runtime_id: &str,
    workspace_id: &str,
    thread_id: &str,
) -> Result<(), String> {
    for (name, value) in [
        ("sourceId", source_id),
        ("runtimeId", runtime_id),
        ("workspaceId", workspace_id),
        ("threadId", thread_id),
    ] {
        if value.trim().is_empty() {
            return Err(format!("turn execution summary {name} is required"));
        }
    }
    Ok(())
}

fn validate_summary(summary: &TurnExecutionSummary) -> Result<(), String> {
    if summary.schema_version != SIDECAR_VERSION {
        return Err(format!(
            "unsupported turn execution summary schema version: {}",
            summary.schema_version
        ));
    }
    for (name, value) in [
        ("executionId", summary.execution_id.as_str()),
        ("turnId", summary.turn_id.as_str()),
    ] {
        if value.trim().is_empty() {
            return Err(format!("turn execution summary {name} is required"));
        }
    }
    if summary.turn_chain.last() != Some(&summary.turn_id) {
        return Err("turn execution summary turnChain must end with turnId".to_string());
    }
    match summary.status {
        TurnExecutionStatus::Active => {
            if summary.ended_at_ms.is_some() || summary.working_duration_ms.is_some() {
                return Err("active turn execution summary cannot be terminal".to_string());
            }
        }
        _ => {
            let ended_at_ms = summary
                .ended_at_ms
                .ok_or_else(|| "terminal turn execution summary requires endedAtMs".to_string())?;
            if ended_at_ms < summary.started_at_ms || summary.working_duration_ms.is_none() {
                return Err("terminal turn execution summary has invalid timing".to_string());
            }
        }
    }
    Ok(())
}

fn read_document(path: &Path) -> Result<Document, String> {
    restore_backup(path)?;
    if !path.exists() {
        return Ok(Document::default());
    }
    let data = std::fs::read_to_string(path).map_err(|error| error.to_string())?;
    if data.trim().is_empty() {
        return Ok(Document::default());
    }
    let document: Document = serde_json::from_str(&data)
        .map_err(|error| format!("Invalid turn execution summary sidecar: {error}"))?;
    if document.version != SIDECAR_VERSION {
        return Err(format!(
            "Unsupported turn execution summary sidecar version: {}",
            document.version
        ));
    }
    Ok(document)
}

fn write_atomically(path: &Path, document: &Document) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let temp = temp_path(path);
    let backup = backup_path(path);
    let data = serde_json::to_vec_pretty(document).map_err(|error| error.to_string())?;
    let mut temp_file = std::fs::File::create(&temp).map_err(|error| error.to_string())?;
    temp_file
        .write_all(&data)
        .map_err(|error| error.to_string())?;
    temp_file.sync_all().map_err(|error| error.to_string())?;
    drop(temp_file);
    if path.exists() {
        if backup.exists() {
            std::fs::remove_file(&backup).map_err(|error| error.to_string())?;
        }
        std::fs::rename(path, &backup).map_err(|error| error.to_string())?;
    }
    match std::fs::rename(&temp, path) {
        Ok(()) => {
            if backup.exists() {
                let _ = std::fs::remove_file(&backup);
            }
            Ok(())
        }
        Err(error) => {
            let _ = std::fs::remove_file(&temp);
            if backup.exists() && !path.exists() {
                let _ = std::fs::rename(&backup, path);
            }
            Err(error.to_string())
        }
    }
}

fn restore_backup(path: &Path) -> Result<(), String> {
    let backup = backup_path(path);
    if !path.exists() && backup.exists() {
        std::fs::rename(backup, path).map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn temp_path(path: &Path) -> PathBuf {
    path.with_extension("json.tmp")
}

fn backup_path(path: &Path) -> PathBuf {
    path.with_extension("json.bak")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn test_path(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "codex-monitor-turn-summary-{name}-{}.json",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

    fn summary(
        workspace: &str,
        thread: &str,
        execution: &str,
        turn: &str,
        updated: u64,
    ) -> TurnExecutionSummary {
        TurnExecutionSummary {
            schema_version: 1,
            execution_id: execution.into(),
            workspace_id: workspace.into(),
            thread_id: thread.into(),
            turn_id: turn.into(),
            turn_chain: vec![turn.into()],
            model_id: None,
            status: TurnExecutionStatus::Completed,
            started_at_ms: updated.saturating_sub(10),
            ended_at_ms: Some(updated),
            working_duration_ms: Some(10),
            added_lines: Some(2),
            deleted_lines: Some(1),
            diff_revision: 1,
            record_revision: 2,
            updated_at_ms: updated,
        }
    }

    fn input(
        source: &str,
        runtime: &str,
        value: TurnExecutionSummary,
    ) -> TurnExecutionSummaryUpsert {
        TurnExecutionSummaryUpsert {
            source_id: source.into(),
            runtime_id: runtime.into(),
            summary: value,
        }
    }

    fn query(
        source: &str,
        runtime: &str,
        workspace: &str,
        thread: &str,
    ) -> TurnExecutionSummaryQuery {
        TurnExecutionSummaryQuery {
            source_id: source.into(),
            runtime_id: runtime.into(),
            workspace_id: workspace.into(),
            thread_id: thread.into(),
        }
    }

    #[test]
    fn roundtrips_summary_with_atomic_sidecar() {
        let path = test_path("roundtrip");
        let mut sidecar = TurnExecutionSummarySidecar::new(path.clone(), 32, 2_048);
        let expected = summary("workspace-a", "thread-a", "execution-a", "turn-a", 20);
        sidecar
            .upsert(input("source-a", "runtime-a", expected.clone()))
            .unwrap();
        assert_eq!(
            sidecar
                .get(&query("source-a", "runtime-a", "workspace-a", "thread-a"))
                .unwrap(),
            vec![expected]
        );
        assert!(path.exists());
        assert!(!temp_path(&path).exists());
        assert!(!backup_path(&path).exists());
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn isolates_compound_key_and_replaces_same_turn() {
        let path = test_path("isolation");
        let mut sidecar = TurnExecutionSummarySidecar::new(path.clone(), 32, 2_048);
        let base = summary("workspace-a", "thread-a", "execution-a", "turn-1", 10);
        for value in [
            input("source-a", "runtime-a", base.clone()),
            input(
                "source-b",
                "runtime-a",
                summary("workspace-a", "thread-a", "execution-a", "turn-2", 20),
            ),
            input(
                "source-a",
                "runtime-b",
                summary("workspace-a", "thread-a", "execution-a", "turn-3", 30),
            ),
            input(
                "source-a",
                "runtime-a",
                summary("workspace-b", "thread-a", "execution-a", "turn-4", 40),
            ),
            input(
                "source-a",
                "runtime-a",
                summary("workspace-a", "thread-b", "execution-a", "turn-5", 50),
            ),
        ] {
            sidecar.upsert(value).unwrap();
        }
        let mut replacement = summary("workspace-a", "thread-a", "execution-b", "turn-1", 60);
        replacement.record_revision = 3;
        sidecar
            .upsert(input("source-a", "runtime-a", replacement.clone()))
            .unwrap();
        assert_eq!(
            sidecar
                .get(&query("source-a", "runtime-a", "workspace-a", "thread-a"))
                .unwrap(),
            vec![replacement]
        );
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn retains_latest_records_per_thread_scope() {
        let path = test_path("per-thread-bound");
        let mut sidecar = TurnExecutionSummarySidecar::new(path.clone(), 2, 10);
        for (execution, updated) in [
            ("execution-1", 10),
            ("execution-2", 20),
            ("execution-3", 30),
        ] {
            sidecar
                .upsert(input(
                    "source",
                    "runtime",
                    summary("workspace", "thread", execution, execution, updated),
                ))
                .unwrap();
        }
        let ids = sidecar
            .get(&query("source", "runtime", "workspace", "thread"))
            .unwrap()
            .into_iter()
            .map(|entry| entry.execution_id)
            .collect::<Vec<_>>();
        assert_eq!(ids, vec!["execution-3", "execution-2"]);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn enforces_global_bound_after_scope_pruning() {
        let path = test_path("global-bound");
        let mut sidecar = TurnExecutionSummarySidecar::new(path.clone(), 5, 2);
        for (thread, execution, updated) in [
            ("thread-a", "execution-1", 10),
            ("thread-b", "execution-2", 20),
            ("thread-c", "execution-3", 30),
        ] {
            sidecar
                .upsert(input(
                    "source",
                    "runtime",
                    summary("workspace", thread, execution, execution, updated),
                ))
                .unwrap();
        }
        let document = read_document(&path).unwrap();
        assert_eq!(document.summaries.len(), 2);
        assert!(document
            .summaries
            .iter()
            .all(|entry| entry.summary.updated_at_ms >= 20));
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn restores_backup_when_primary_is_missing() {
        let path = test_path("restore-backup");
        let mut sidecar = TurnExecutionSummarySidecar::new(path.clone(), 32, 2_048);
        sidecar
            .upsert(input(
                "source",
                "runtime",
                summary("workspace", "thread", "execution", "turn", 10),
            ))
            .unwrap();
        std::fs::rename(&path, backup_path(&path)).unwrap();
        assert_eq!(
            sidecar
                .get(&query("source", "runtime", "workspace", "thread"))
                .unwrap()
                .len(),
            1
        );
        assert!(path.exists());
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn stale_revision_cannot_overwrite_newer_summary() {
        let path = test_path("stale-revision");
        let mut sidecar = TurnExecutionSummarySidecar::new(path.clone(), 32, 2_048);
        let mut newest = summary("workspace", "thread", "execution", "turn", 30);
        newest.record_revision = 3;
        sidecar
            .upsert(input("source", "runtime", newest.clone()))
            .unwrap();
        let mut stale = summary("workspace", "thread", "execution", "turn", 20);
        stale.record_revision = 2;
        assert_eq!(
            sidecar.upsert(input("source", "runtime", stale)).unwrap(),
            newest
        );
        assert_eq!(
            sidecar
                .get(&query("source", "runtime", "workspace", "thread"))
                .unwrap(),
            vec![newest]
        );
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn equal_revision_with_different_payload_is_rejected() {
        let path = test_path("revision-conflict");
        let mut sidecar = TurnExecutionSummarySidecar::new(path.clone(), 32, 2_048);
        let original = summary("workspace", "thread", "execution", "turn", 20);
        sidecar
            .upsert(input("source", "runtime", original.clone()))
            .unwrap();
        let mut conflicting = original;
        conflicting.added_lines = Some(99);
        assert_eq!(
            sidecar
                .upsert(input("source", "runtime", conflicting))
                .unwrap_err(),
            "turn execution summary revision conflict"
        );
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn terminal_summary_cannot_regress_to_active() {
        let path = test_path("terminal-regression");
        let mut sidecar = TurnExecutionSummarySidecar::new(path.clone(), 32, 2_048);
        let terminal = summary("workspace", "thread", "execution", "turn", 20);
        sidecar
            .upsert(input("source", "runtime", terminal.clone()))
            .unwrap();
        let mut active = terminal;
        active.status = TurnExecutionStatus::Active;
        active.ended_at_ms = None;
        active.working_duration_ms = None;
        active.record_revision += 1;
        active.updated_at_ms += 1;
        assert_eq!(
            sidecar
                .upsert(input("source", "runtime", active))
                .unwrap_err(),
            "terminal turn execution summary cannot become active"
        );
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn terminal_summary_cannot_change_terminal_status() {
        let path = test_path("terminal-status-change");
        let mut sidecar = TurnExecutionSummarySidecar::new(path.clone(), 32, 2_048);
        let terminal = summary("workspace", "thread", "execution", "turn", 20);
        sidecar
            .upsert(input("source", "runtime", terminal.clone()))
            .unwrap();
        let mut failed = terminal.clone();
        failed.status = TurnExecutionStatus::Failed;
        failed.record_revision += 1;
        failed.updated_at_ms += 1;
        assert_eq!(
            sidecar.upsert(input("source", "runtime", failed)).unwrap(),
            terminal
        );
        let _ = std::fs::remove_file(path);
    }
}
