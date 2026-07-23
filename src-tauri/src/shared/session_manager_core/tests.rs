use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use serde_json::json;
use uuid::Uuid;

use super::scanner::{
    scan_session_source, scan_session_source_with_archive_mode, scan_session_sources,
};
use crate::types::{SessionFileConfidence, SessionFileStatus, SessionSource, SessionSourceStatus};

#[test]
fn scans_multiple_sources_with_duplicate_thread_ids() {
    let fixture = SessionFixture::new();
    let first_root = fixture.root.join("home-a");
    let second_root = fixture.root.join("home-b");
    create_session(
        &first_root,
        false,
        "thread-shared",
        Some(&fixture.root.join("project-a")),
        json!("vscode"),
        Some("user"),
    );
    create_session(
        &second_root,
        false,
        "thread-shared",
        Some(&fixture.root.join("project-b")),
        json!("cli"),
        Some("user"),
    );
    fs::create_dir_all(fixture.root.join("project-a")).unwrap();
    fs::create_dir_all(fixture.root.join("project-b")).unwrap();

    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let result = runtime.block_on(scan_session_sources(
        vec![
            source("source-a", &first_root),
            source("source-b", &second_root),
        ],
        99,
    ));

    assert_eq!(result.sessions.len(), 2);
    assert_ne!(result.sessions[0].key, result.sessions[1].key);
    assert!(result
        .sessions
        .iter()
        .all(|session| session.thread_id == "thread-shared"));
    assert!(result.sessions.iter().all(|session| session.project_exists));
}

#[test]
fn source_scan_distinguishes_an_existing_session_from_a_true_deletion() {
    let fixture = SessionFixture::new();
    let source_root = fixture.root.join("home");
    create_session(
        &source_root,
        false,
        "thread-visible",
        None,
        json!("vscode"),
        Some("user"),
    );

    let before_delete = scan_session_source(&source("source-a", &source_root));

    assert_eq!(before_delete.sessions.len(), 1);
    assert_eq!(before_delete.sessions[0].key, "source-a:thread-visible");

    let session_path = source_root
        .join("sessions")
        .join("2026")
        .join("07")
        .join("10")
        .join("rollout-2026-07-10T08-00-00-thread-visible.jsonl");
    fs::remove_file(session_path).unwrap();

    let after_delete = scan_session_source(&source("source-a", &source_root));

    assert!(after_delete.sessions.is_empty());
}

#[test]
fn scans_archived_missing_project_and_subagent_metadata() {
    let fixture = SessionFixture::new();
    let source_root = fixture.root.join("home");
    create_session(
        &source_root,
        true,
        "thread-child",
        Some(&fixture.root.join("missing-project")),
        json!({
            "subagent": {
                "thread_spawn": {
                    "parent_thread_id": "thread-parent",
                    "agent_nickname": "Tesla",
                    "agent_role": "explorer"
                }
            }
        }),
        Some("subagent"),
    );
    write_index(&source_root, "thread-child", "Indexed child");

    let result = scan_session_source(&source("source-a", &source_root));

    assert_eq!(result.sessions.len(), 1);
    let session = &result.sessions[0];
    assert!(session.is_archived);
    assert!(!session.project_exists);
    assert!(session.is_subagent);
    assert_eq!(session.parent_thread_id.as_deref(), Some("thread-parent"));
    assert_eq!(session.subagent_nickname.as_deref(), Some("Tesla"));
    assert_eq!(session.subagent_role.as_deref(), Some("explorer"));
    assert_eq!(session.title, "Indexed child");
    assert_eq!(session.archived_at, Some(1_783_677_600_000));
    assert!(matches!(session.file_status, SessionFileStatus::Mapped));
    assert!(matches!(
        session.file_confidence,
        SessionFileConfidence::Exact
    ));
}

#[test]
fn source_scan_marks_project_name_title_as_fallback_when_index_title_is_missing() {
    let fixture = SessionFixture::new();
    let source_root = fixture.root.join("home");
    let project_root = fixture.root.join("CodexMonitor");
    create_session(
        &source_root,
        false,
        "thread-without-index-title",
        Some(&project_root),
        json!("vscode"),
        Some("user"),
    );

    let result = scan_session_source(&source("source-a", &source_root));

    assert_eq!(result.sessions[0].title, "CodexMonitor");
    assert!(result.sessions[0].title_is_fallback);
    assert_eq!(result.sessions[0].preview, None);
}

#[test]
fn active_only_scan_excludes_archived_sessions() {
    let fixture = SessionFixture::new();
    let source_root = fixture.root.join("home");
    create_session(
        &source_root,
        false,
        "thread-active",
        None,
        json!("vscode"),
        Some("user"),
    );
    create_session(
        &source_root,
        true,
        "thread-archived",
        None,
        json!("vscode"),
        Some("user"),
    );

    let result = scan_session_source_with_archive_mode(&source("source-a", &source_root), false);

    assert_eq!(result.sessions.len(), 1);
    assert_eq!(result.sessions[0].thread_id, "thread-active");
    assert!(!result.sessions[0].is_archived);
}

#[test]
fn scans_native_sessions_and_archived_sessions_directories() {
    let fixture = SessionFixture::new();
    let source_root = fixture.root.join("home");
    create_session(
        &source_root,
        false,
        "thread-active",
        None,
        json!("cli"),
        Some("user"),
    );
    create_session(
        &source_root,
        true,
        "thread-archived",
        None,
        json!("cli"),
        Some("user"),
    );

    let result = scan_session_source(&source("source-a", &source_root));

    assert!(result.diagnostics.is_empty(), "{:?}", result.diagnostics);
    assert_eq!(result.sessions.len(), 2);
    assert!(result
        .sessions
        .iter()
        .any(|session| session.thread_id == "thread-active" && !session.is_archived));
    assert!(result
        .sessions
        .iter()
        .any(|session| session.thread_id == "thread-archived" && session.is_archived));
}

#[test]
fn source_scan_uses_persisted_activity_instead_of_index_or_file_time() {
    let fixture = SessionFixture::new();
    let source_root = fixture.root.join("home");
    create_session(
        &source_root,
        false,
        "thread-active",
        None,
        json!("vscode"),
        Some("user"),
    );
    write_index(&source_root, "thread-active", "Indexed title");
    let path = session_path(&source_root, false, "thread-active");
    fs::OpenOptions::new()
        .append(true)
        .open(&path)
        .unwrap()
        .write_all(b"{\"timestamp\":\"2026-07-10T11:30:00Z\",\"type\":\"event_msg\"}\n")
        .unwrap();

    let first = scan_session_source(&source("source-a", &source_root));
    let first_updated_at = first.sessions[0].updated_at;
    let contents = fs::read(&path).unwrap();
    fs::write(&path, contents).unwrap();
    let second = scan_session_source(&source("source-a", &source_root));

    assert_eq!(first_updated_at, Some(1_783_683_000_000));
    assert_eq!(second.sessions[0].updated_at, first_updated_at);
}

#[test]
fn source_scan_does_not_fall_back_to_index_when_rollout_has_no_time() {
    let fixture = SessionFixture::new();
    let source_root = fixture.root.join("home");
    let path = session_path(&source_root, false, "thread-unknown");
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(
        &path,
        "{\"type\":\"session_meta\",\"payload\":{\"id\":\"thread-unknown\"}}\n",
    )
    .unwrap();
    write_index(&source_root, "thread-unknown", "Indexed title");

    let result = scan_session_source(&source("source-a", &source_root));

    assert_eq!(result.sessions[0].updated_at, None);
}

#[test]
fn isolates_malformed_files_and_marks_same_source_duplicates_ambiguous() {
    let fixture = SessionFixture::new();
    let source_root = fixture.root.join("home");
    create_session(
        &source_root,
        false,
        "thread-duplicate",
        None,
        json!("vscode"),
        Some("user"),
    );
    create_session(
        &source_root,
        true,
        "thread-duplicate",
        None,
        json!("vscode"),
        Some("user"),
    );
    let malformed = source_root
        .join("sessions")
        .join("2026")
        .join("07")
        .join("10")
        .join("rollout-malformed.jsonl");
    fs::create_dir_all(malformed.parent().unwrap()).unwrap();
    fs::write(&malformed, "not-json\n").unwrap();

    let result = scan_session_source(&source("source-a", &source_root));

    assert_eq!(result.sessions.len(), 1);
    assert!(matches!(
        result.sessions[0].file_status,
        SessionFileStatus::Invalid
    ));
    assert!(matches!(
        result.sessions[0].file_confidence,
        SessionFileConfidence::Ambiguous
    ));
    assert!(
        result
            .diagnostics
            .iter()
            .filter_map(|diagnostic| diagnostic.path.as_deref())
            .any(|path| path.file_name() == malformed.file_name()),
        "diagnostics: {:?}",
        result.diagnostics
    );
}

struct SessionFixture {
    root: PathBuf,
}

impl SessionFixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("codex-monitor-scan-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        Self { root }
    }
}

impl Drop for SessionFixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn source(id: &str, path: &Path) -> SessionSource {
    SessionSource {
        id: id.to_string(),
        name: id.to_string(),
        codex_home_path: path.to_string_lossy().to_string(),
        enabled: true,
        is_current: false,
        is_default: false,
        discovered_at: 1,
        last_scan_at: None,
        status: SessionSourceStatus::Ready,
        error: None,
    }
}

fn create_session(
    source_root: &Path,
    archived: bool,
    thread_id: &str,
    cwd: Option<&Path>,
    source: serde_json::Value,
    thread_source: Option<&str>,
) {
    let path = session_path(source_root, archived, thread_id);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    let record = json!({
        "timestamp": "2026-07-10T08:00:00Z",
        "type": "session_meta",
        "payload": {
            "id": thread_id,
            "timestamp": "2026-07-10T08:00:00Z",
            "cwd": cwd.map(|path| path.to_string_lossy().to_string()),
            "source": source,
            "thread_source": thread_source
        }
    });
    fs::write(path, format!("{record}\n")).unwrap();
}

fn session_path(source_root: &Path, archived: bool, thread_id: &str) -> PathBuf {
    let directory = if archived {
        source_root.join("archived_sessions")
    } else {
        source_root
            .join("sessions")
            .join("2026")
            .join("07")
            .join("10")
    };
    directory.join(format!("rollout-2026-07-10T08-00-00-{thread_id}.jsonl"))
}

fn write_index(source_root: &Path, thread_id: &str, title: &str) {
    fs::create_dir_all(source_root).unwrap();
    let record = json!({
        "id": thread_id,
        "thread_name": title,
        "updated_at": "2026-07-10T09:00:00Z",
        "archived_at": "2026-07-10T10:00:00Z"
    });
    fs::write(
        source_root.join("session_index.jsonl"),
        format!("{record}\n"),
    )
    .unwrap();
}
