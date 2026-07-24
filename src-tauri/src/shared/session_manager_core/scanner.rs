use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::UNIX_EPOCH;

use serde_json::Value;
use tokio::sync::Semaphore;

use crate::types::{ManagedSession, SessionFileConfidence, SessionFileStatus, SessionSource};

use super::file_map::{is_path_within_root, map_session_files, SessionFileMapping};
use super::parser::{parse_session_metadata, parse_timestamp_ms, ParsedSessionMetadata};
use super::preview::read_session_opening_message;

const MIN_SCAN_CONCURRENCY: usize = 2;
const MAX_SCAN_CONCURRENCY: usize = 4;
const FALLBACK_PREVIEW_CHAR_LIMIT: usize = 512;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SessionScanDiagnostic {
    pub(crate) source_id: String,
    pub(crate) path: Option<PathBuf>,
    pub(crate) error: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SourceSessionScanResult {
    pub(crate) source_id: String,
    pub(crate) sessions: Vec<ManagedSession>,
    pub(crate) diagnostics: Vec<SessionScanDiagnostic>,
    pub(crate) files_by_key: HashMap<String, SearchableSessionFile>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SearchableSessionFile {
    pub(crate) path: PathBuf,
    pub(crate) modified_at: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub(crate) struct MultiSourceSessionScanResult {
    pub(crate) sessions: Vec<ManagedSession>,
    pub(crate) diagnostics: Vec<SessionScanDiagnostic>,
    pub(crate) files_by_key: HashMap<String, SearchableSessionFile>,
}

#[derive(Debug)]
struct SessionCandidate {
    metadata: ParsedSessionMetadata,
    path: PathBuf,
    is_archived: bool,
    modified_at: Option<i64>,
}

#[derive(Debug, Clone, Default)]
struct SessionIndexEntry {
    title: Option<String>,
    updated_at: Option<i64>,
    archived_at: Option<i64>,
}

pub(crate) async fn scan_session_sources(
    sources: Vec<SessionSource>,
    concurrency: usize,
) -> MultiSourceSessionScanResult {
    scan_session_sources_with_archive_mode(sources, concurrency, true).await
}

pub(crate) async fn scan_session_sources_with_archive_mode(
    sources: Vec<SessionSource>,
    concurrency: usize,
    include_archived: bool,
) -> MultiSourceSessionScanResult {
    let concurrency = concurrency.clamp(MIN_SCAN_CONCURRENCY, MAX_SCAN_CONCURRENCY);
    let semaphore = Arc::new(Semaphore::new(concurrency));
    let mut tasks = Vec::new();

    for source in sources.into_iter().filter(|source| source.enabled) {
        let semaphore = semaphore.clone();
        let source_id = source.id.clone();
        tasks.push(tokio::spawn(async move {
            let permit = match semaphore.acquire_owned().await {
                Ok(permit) => permit,
                Err(error) => return (source_id, Err(error.to_string())),
            };
            let result = tokio::task::spawn_blocking(move || {
                scan_session_source_with_archive_mode(&source, include_archived)
            })
            .await;
            drop(permit);
            (source_id, result.map_err(|error| error.to_string()))
        }));
    }

    let mut combined = MultiSourceSessionScanResult::default();
    for task in tasks {
        match task.await {
            Ok((_, Ok(result))) => {
                combined.sessions.extend(result.sessions);
                combined.diagnostics.extend(result.diagnostics);
                combined.files_by_key.extend(result.files_by_key);
            }
            Ok((source_id, Err(error))) => combined.diagnostics.push(SessionScanDiagnostic {
                source_id,
                path: None,
                error,
            }),
            Err(error) => combined.diagnostics.push(SessionScanDiagnostic {
                source_id: String::new(),
                path: None,
                error: error.to_string(),
            }),
        }
    }
    combined
}

pub(crate) fn scan_session_source(source: &SessionSource) -> SourceSessionScanResult {
    scan_session_source_with_archive_mode(source, true)
}

pub(crate) fn scan_session_source_with_archive_mode(
    source: &SessionSource,
    include_archived: bool,
) -> SourceSessionScanResult {
    let mut result = SourceSessionScanResult {
        source_id: source.id.clone(),
        sessions: Vec::new(),
        diagnostics: Vec::new(),
        files_by_key: HashMap::new(),
    };
    if !source.enabled {
        return result;
    }

    let source_root = PathBuf::from(&source.codex_home_path);
    let canonical_root = match source_root.canonicalize() {
        Ok(path) if path.is_dir() => path,
        Ok(_) => {
            result.diagnostics.push(diagnostic(
                source,
                Some(source_root),
                "Session source is not a directory",
            ));
            return result;
        }
        Err(error) => {
            result.diagnostics.push(diagnostic(
                source,
                Some(source_root),
                format!("Unable to access session source: {error}"),
            ));
            return result;
        }
    };

    let session_index = load_session_index(&canonical_root, source, &mut result.diagnostics);
    let mut candidates_by_thread_id: HashMap<String, Vec<SessionCandidate>> = HashMap::new();
    let directories = if include_archived {
        vec![("sessions", false), ("archived_sessions", true)]
    } else {
        vec![("sessions", false)]
    };
    for (directory_name, is_archived) in directories {
        let directory = canonical_root.join(directory_name);
        if !directory.exists() {
            continue;
        }
        if fs::symlink_metadata(&directory)
            .map(|metadata| metadata.file_type().is_symlink())
            .unwrap_or(true)
        {
            result.diagnostics.push(diagnostic(
                source,
                Some(directory),
                "Session directory symbolic links are not scanned",
            ));
            continue;
        }
        if !is_path_within_root(&directory, &canonical_root) {
            result.diagnostics.push(diagnostic(
                source,
                Some(directory),
                "Session directory escapes source root",
            ));
            continue;
        }
        collect_session_candidates(
            source,
            &canonical_root,
            &directory,
            is_archived,
            &mut candidates_by_thread_id,
            &mut result.diagnostics,
        );
    }

    let files_by_thread_id = candidates_by_thread_id
        .iter()
        .map(|(thread_id, candidates)| {
            (
                thread_id.clone(),
                candidates
                    .iter()
                    .map(|candidate| candidate.path.clone())
                    .collect(),
            )
        })
        .collect();
    let mappings = map_session_files(files_by_thread_id);

    for (thread_id, mut candidates) in candidates_by_thread_id {
        candidates.sort_by_key(|candidate| candidate.modified_at.unwrap_or_default());
        let Some(candidate) = candidates.pop() else {
            continue;
        };
        let mapping = mappings
            .get(&thread_id)
            .cloned()
            .unwrap_or(SessionFileMapping {
                path: None,
                status: SessionFileStatus::Unmapped,
                confidence: SessionFileConfidence::None,
            });
        let mapping = validate_filename_mapping(&thread_id, mapping);
        let index_entry = session_index.get(&thread_id).cloned().unwrap_or_default();
        let cwd = candidate.metadata.cwd.clone();
        let project_exists = cwd.as_deref().is_some_and(|cwd| Path::new(cwd).is_dir());
        let indexed_title = index_entry.title.filter(|title| !title.trim().is_empty());
        let title_is_fallback = indexed_title.is_none();
        let preview = title_is_fallback
            .then(|| read_session_opening_message(&candidate.path).ok().flatten())
            .flatten()
            .map(|message| message.chars().take(FALLBACK_PREVIEW_CHAR_LIMIT).collect());
        let title =
            indexed_title.unwrap_or_else(|| fallback_title(&candidate.metadata, &thread_id));

        let key = format!("{}:{}", source.id, thread_id);
        if mapping.confidence == SessionFileConfidence::Exact {
            if let Some(path) = mapping.path.clone() {
                result.files_by_key.insert(
                    key.clone(),
                    SearchableSessionFile {
                        path,
                        modified_at: candidate.modified_at,
                    },
                );
            }
        }
        result.sessions.push(ManagedSession {
            key,
            source_id: source.id.clone(),
            thread_id,
            source_kind: candidate.metadata.source_kind,
            cwd,
            title,
            title_is_fallback,
            preview,
            created_at: candidate.metadata.created_at,
            // File mtime and index writes are implementation details, not session usage time.
            // Only persisted rollout activity owns the last-used timestamp.
            updated_at: candidate.metadata.last_activity_at,
            archived_at: index_entry.archived_at,
            is_archived: candidate.is_archived,
            parent_thread_id: candidate.metadata.parent_thread_id,
            is_subagent: candidate.metadata.is_subagent,
            subagent_nickname: candidate.metadata.subagent_nickname,
            subagent_role: candidate.metadata.subagent_role,
            project_exists,
            file_status: mapping.status,
            file_confidence: mapping.confidence,
        });
    }
    result.sessions.sort_by(|left, right| {
        right
            .updated_at
            .cmp(&left.updated_at)
            .then_with(|| left.key.cmp(&right.key))
    });
    result
}

fn collect_session_candidates(
    source: &SessionSource,
    canonical_root: &Path,
    directory: &Path,
    is_archived: bool,
    candidates_by_thread_id: &mut HashMap<String, Vec<SessionCandidate>>,
    diagnostics: &mut Vec<SessionScanDiagnostic>,
) {
    let entries = match fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(error) => {
            diagnostics.push(diagnostic(
                source,
                Some(directory.to_path_buf()),
                format!("Unable to read session directory: {error}"),
            ));
            return;
        }
    };

    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) => {
                diagnostics.push(diagnostic(source, None, error.to_string()));
                continue;
            }
        };
        let path = entry.path();
        let metadata = match fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(error) => {
                diagnostics.push(diagnostic(source, Some(path), error.to_string()));
                continue;
            }
        };
        if metadata.file_type().is_symlink() {
            diagnostics.push(diagnostic(
                source,
                Some(path),
                "Symbolic links are not scanned",
            ));
            continue;
        }
        if metadata.is_dir() {
            collect_session_candidates(
                source,
                canonical_root,
                &path,
                is_archived,
                candidates_by_thread_id,
                diagnostics,
            );
            continue;
        }
        if !metadata.is_file() || path.extension().and_then(|value| value.to_str()) != Some("jsonl")
        {
            continue;
        }
        if !is_path_within_root(&path, canonical_root) {
            diagnostics.push(diagnostic(
                source,
                Some(path),
                "Session file escapes source root",
            ));
            continue;
        }
        match parse_session_metadata(&path) {
            Ok(parsed) => candidates_by_thread_id
                .entry(parsed.thread_id.clone())
                .or_default()
                .push(SessionCandidate {
                    metadata: parsed,
                    path,
                    is_archived,
                    modified_at: modified_time_ms(&metadata),
                }),
            Err(error) => diagnostics.push(diagnostic(source, Some(path), error)),
        }
    }
}

fn load_session_index(
    source_root: &Path,
    source: &SessionSource,
    diagnostics: &mut Vec<SessionScanDiagnostic>,
) -> HashMap<String, SessionIndexEntry> {
    let path = source_root.join("session_index.jsonl");
    if !path.is_file() || !is_path_within_root(&path, source_root) {
        return HashMap::new();
    }
    let file = match fs::File::open(&path) {
        Ok(file) => file,
        Err(error) => {
            diagnostics.push(diagnostic(source, Some(path), error.to_string()));
            return HashMap::new();
        }
    };
    let mut entries: HashMap<String, SessionIndexEntry> = HashMap::new();
    use std::io::{BufRead, BufReader};
    for line in BufReader::new(file).lines() {
        let line = match line {
            Ok(line) => line,
            Err(error) => {
                diagnostics.push(diagnostic(source, Some(path.clone()), error.to_string()));
                continue;
            }
        };
        let value: Value = match serde_json::from_str(&line) {
            Ok(value) => value,
            Err(error) => {
                diagnostics.push(diagnostic(source, Some(path.clone()), error.to_string()));
                continue;
            }
        };
        let Some(id) = value.get("id").and_then(Value::as_str) else {
            continue;
        };
        let candidate = SessionIndexEntry {
            title: value
                .get("thread_name")
                .and_then(Value::as_str)
                .map(str::to_string),
            updated_at: parse_timestamp_ms(value.get("updated_at").and_then(Value::as_str)),
            archived_at: parse_index_timestamp(
                value.get("archived_at").or_else(|| value.get("archivedAt")),
            ),
        };
        let current = entries.entry(id.to_string()).or_default();
        if candidate.updated_at >= current.updated_at {
            let archived_at = candidate.archived_at.or(current.archived_at);
            *current = SessionIndexEntry {
                archived_at,
                ..candidate
            };
        } else if current.archived_at.is_none() {
            current.archived_at = candidate.archived_at;
        }
    }
    entries
}

fn parse_index_timestamp(value: Option<&Value>) -> Option<i64> {
    match value {
        Some(Value::String(value)) => parse_timestamp_ms(Some(value)),
        Some(Value::Number(value)) => value.as_i64().filter(|value| *value > 0),
        _ => None,
    }
}

fn validate_filename_mapping(
    thread_id: &str,
    mut mapping: SessionFileMapping,
) -> SessionFileMapping {
    if mapping.confidence != SessionFileConfidence::Exact {
        return mapping;
    }
    let matches_thread_id = mapping
        .path
        .as_deref()
        .and_then(Path::file_stem)
        .and_then(|value| value.to_str())
        .is_some_and(|value| value.ends_with(thread_id));
    if !matches_thread_id {
        mapping.status = SessionFileStatus::Invalid;
        mapping.confidence = SessionFileConfidence::None;
    }
    mapping
}

fn fallback_title(metadata: &ParsedSessionMetadata, _thread_id: &str) -> String {
    metadata
        .cwd
        .as_deref()
        .and_then(|cwd| Path::new(cwd).file_name())
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .unwrap_or("Untitled session")
        .to_string()
}

fn modified_time_ms(metadata: &fs::Metadata) -> Option<i64> {
    metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .map(|value| value.as_millis().min(i64::MAX as u128) as i64)
}

fn diagnostic(
    source: &SessionSource,
    path: Option<PathBuf>,
    error: impl Into<String>,
) -> SessionScanDiagnostic {
    SessionScanDiagnostic {
        source_id: source.id.clone(),
        path,
        error: error.into(),
    }
}

#[cfg(test)]
mod tests {
    use super::fallback_title;
    use crate::shared::session_manager_core::parser::ParsedSessionMetadata;

    #[test]
    fn fallback_title_never_uses_thread_id() {
        let metadata = ParsedSessionMetadata {
            thread_id: "thread-123".to_string(),
            cwd: None,
            created_at: None,
            last_activity_at: None,
            source_kind: None,
            parent_thread_id: None,
            is_subagent: false,
            subagent_nickname: None,
            subagent_role: None,
        };
        assert_eq!(fallback_title(&metadata, "thread-123"), "Untitled session");
    }
}
