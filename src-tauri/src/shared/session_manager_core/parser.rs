use std::fs::File;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::Path;

use chrono::DateTime;
use serde_json::Value;

const TAIL_SCAN_CHUNK_BYTES: u64 = 64 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ParsedSessionMetadata {
    pub(crate) thread_id: String,
    pub(crate) cwd: Option<String>,
    pub(crate) created_at: Option<i64>,
    pub(crate) last_activity_at: Option<i64>,
    pub(crate) source_kind: Option<String>,
    pub(crate) parent_thread_id: Option<String>,
    pub(crate) is_subagent: bool,
    pub(crate) subagent_nickname: Option<String>,
    pub(crate) subagent_role: Option<String>,
}

pub(crate) fn parse_session_metadata(path: &Path) -> Result<ParsedSessionMetadata, String> {
    let file = File::open(path).map_err(|error| error.to_string())?;
    let reader = BufReader::new(file);
    let mut parse_error = None;
    let mut metadata = None;
    for line in reader.lines() {
        let line = line.map_err(|error| error.to_string())?;
        let value: Value = match serde_json::from_str(&line) {
            Ok(value) => value,
            Err(error) => {
                parse_error = Some(error.to_string());
                continue;
            }
        };
        if value.get("type").and_then(Value::as_str) == Some("session_meta") {
            metadata = Some(parse_session_meta_value(&value)?);
            break;
        }
    }
    let mut metadata = metadata.ok_or_else(|| {
        parse_error.unwrap_or_else(|| "Session metadata record not found".to_string())
    })?;
    metadata.last_activity_at = read_last_activity_at(path)?.or(metadata.created_at);
    Ok(metadata)
}

fn read_last_activity_at(path: &Path) -> Result<Option<i64>, String> {
    let mut file = File::open(path).map_err(|error| error.to_string())?;
    let mut end = file.metadata().map_err(|error| error.to_string())?.len();
    let mut pending_suffix = Vec::new();

    while end > 0 {
        let start = end.saturating_sub(TAIL_SCAN_CHUNK_BYTES);
        let starts_at_line_boundary = if start == 0 {
            true
        } else {
            file.seek(SeekFrom::Start(start - 1))
                .map_err(|error| error.to_string())?;
            let mut previous = [0_u8; 1];
            file.read_exact(&mut previous)
                .map_err(|error| error.to_string())?;
            previous[0] == b'\n'
        };
        file.seek(SeekFrom::Start(start))
            .map_err(|error| error.to_string())?;
        let mut chunk = vec![0_u8; (end - start) as usize];
        file.read_exact(&mut chunk)
            .map_err(|error| error.to_string())?;
        chunk.extend_from_slice(&pending_suffix);

        let mut lines = chunk.split(|byte| *byte == b'\n');
        let first = lines.next().unwrap_or_default();
        let complete_lines = lines.collect::<Vec<_>>();
        for line in complete_lines.into_iter().rev() {
            if let Some(timestamp) = activity_timestamp_from_line(line) {
                return Ok(Some(timestamp));
            }
        }
        if starts_at_line_boundary {
            if let Some(timestamp) = activity_timestamp_from_line(first) {
                return Ok(Some(timestamp));
            }
            pending_suffix.clear();
        } else {
            pending_suffix = first.to_vec();
        }
        end = start;
    }

    Ok(None)
}

fn activity_timestamp_from_line(line: &[u8]) -> Option<i64> {
    let value: Value = serde_json::from_slice(line).ok()?;
    value
        .get("type")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())?;
    parse_timestamp_ms(value.get("timestamp").and_then(Value::as_str))
}

fn parse_session_meta_value(value: &Value) -> Result<ParsedSessionMetadata, String> {
    let payload = value
        .get("payload")
        .and_then(Value::as_object)
        .ok_or_else(|| "Session metadata payload is missing".to_string())?;
    let thread_id = payload
        .get("id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Session metadata id is missing".to_string())?
        .to_string();
    let source = payload.get("source");
    let thread_source = payload.get("thread_source").and_then(Value::as_str);
    let subagent = source
        .and_then(Value::as_object)
        .and_then(|value| value.get("subagent"));
    let thread_spawn = subagent
        .and_then(Value::as_object)
        .and_then(|value| value.get("thread_spawn"))
        .and_then(Value::as_object);
    let other_role = subagent
        .and_then(Value::as_object)
        .and_then(|value| value.get("other"))
        .and_then(Value::as_str);
    let is_subagent = thread_source.is_some_and(|value| value.eq_ignore_ascii_case("subagent"))
        || subagent.is_some();

    let created_at = parse_timestamp_ms(
        payload
            .get("timestamp")
            .and_then(Value::as_str)
            .or_else(|| value.get("timestamp").and_then(Value::as_str)),
    );

    Ok(ParsedSessionMetadata {
        thread_id,
        cwd: optional_string(payload.get("cwd")),
        created_at,
        last_activity_at: created_at,
        source_kind: parse_source_kind(source, thread_source),
        parent_thread_id: thread_spawn
            .and_then(|value| optional_string(value.get("parent_thread_id"))),
        is_subagent,
        subagent_nickname: thread_spawn
            .and_then(|value| optional_string(value.get("agent_nickname"))),
        subagent_role: thread_spawn
            .and_then(|value| optional_string(value.get("agent_role")))
            .or_else(|| other_role.map(str::to_string)),
    })
}

fn parse_source_kind(source: Option<&Value>, thread_source: Option<&str>) -> Option<String> {
    if let Some(source) = source.and_then(Value::as_str) {
        return non_empty(source);
    }
    if let Some(subagent) = source
        .and_then(Value::as_object)
        .and_then(|value| value.get("subagent"))
        .and_then(Value::as_object)
    {
        if subagent.contains_key("thread_spawn") {
            return Some("subAgentThreadSpawn".to_string());
        }
        if subagent.contains_key("review") {
            return Some("subAgentReview".to_string());
        }
        if subagent.contains_key("compact") {
            return Some("subAgentCompact".to_string());
        }
        return Some("subAgent".to_string());
    }
    if source.and_then(Value::as_object).is_some() {
        return Some("unknown".to_string());
    }
    thread_source.and_then(non_empty)
}

pub(crate) fn parse_timestamp_ms(value: Option<&str>) -> Option<i64> {
    value
        .and_then(|value| DateTime::parse_from_rfc3339(value).ok())
        .map(|value| value.timestamp_millis())
}

fn optional_string(value: Option<&Value>) -> Option<String> {
    value.and_then(Value::as_str).and_then(non_empty)
}

fn non_empty(value: &str) -> Option<String> {
    let value = value.trim();
    (!value.is_empty()).then(|| value.to_string())
}

#[cfg(test)]
mod tests {
    use std::io::Write;

    use serde_json::json;

    use super::{parse_session_meta_value, parse_timestamp_ms};

    #[test]
    fn parses_regular_session_metadata() {
        let parsed = parse_session_meta_value(&json!({
            "timestamp": "2026-07-10T08:00:00Z",
            "type": "session_meta",
            "payload": {
                "id": "thread-a",
                "timestamp": "2026-07-10T08:00:00Z",
                "cwd": "D:\\Project\\Alpha",
                "source": "vscode",
                "thread_source": "user"
            }
        }))
        .unwrap();

        assert_eq!(parsed.thread_id, "thread-a");
        assert_eq!(parsed.source_kind.as_deref(), Some("vscode"));
        assert!(!parsed.is_subagent);
        assert_eq!(
            parsed.created_at,
            parse_timestamp_ms(Some("2026-07-10T08:00:00Z"))
        );
        assert_eq!(parsed.last_activity_at, parsed.created_at);
    }

    #[test]
    fn parses_thread_spawn_subagent_metadata() {
        let parsed = parse_session_meta_value(&json!({
            "type": "session_meta",
            "payload": {
                "id": "thread-child",
                "thread_source": "subagent",
                "source": {
                    "subagent": {
                        "thread_spawn": {
                            "parent_thread_id": "thread-parent",
                            "agent_nickname": "Gauss",
                            "agent_role": "explorer"
                        }
                    }
                }
            }
        }))
        .unwrap();

        assert!(parsed.is_subagent);
        assert_eq!(parsed.source_kind.as_deref(), Some("subAgentThreadSpawn"));
        assert_eq!(parsed.parent_thread_id.as_deref(), Some("thread-parent"));
        assert_eq!(parsed.subagent_nickname.as_deref(), Some("Gauss"));
        assert_eq!(parsed.subagent_role.as_deref(), Some("explorer"));
    }

    #[test]
    fn preserves_explicit_visible_subagent_source_kinds() {
        for (source_key, expected) in [("review", "subAgentReview"), ("compact", "subAgentCompact")]
        {
            let parsed = parse_session_meta_value(&json!({
                "type": "session_meta",
                "payload": {
                    "id": format!("thread-{source_key}"),
                    "source": {
                        "subagent": {
                            (source_key): true
                        }
                    }
                }
            }))
            .unwrap();

            assert!(parsed.is_subagent);
            assert_eq!(parsed.source_kind.as_deref(), Some(expected));
        }
    }

    #[test]
    fn metadata_parser_can_skip_a_malformed_prefix_line() {
        let root =
            std::env::temp_dir().join(format!("codex-monitor-parser-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("rollout-thread-a.jsonl");
        std::fs::write(
            &path,
            "not-json\n{\"type\":\"session_meta\",\"payload\":{\"id\":\"thread-a\"}}\n",
        )
        .unwrap();

        let parsed = super::parse_session_metadata(&path).unwrap();
        assert_eq!(parsed.thread_id, "thread-a");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn metadata_parser_uses_the_last_valid_persisted_record_timestamp() {
        let root =
            std::env::temp_dir().join(format!("codex-monitor-parser-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("rollout-thread-a.jsonl");
        std::fs::write(
            &path,
            concat!(
                "{\"timestamp\":\"2026-07-10T08:00:00Z\",\"type\":\"session_meta\",\"payload\":{\"id\":\"thread-a\"}}\n",
                "{\"timestamp\":\"2026-07-10T09:00:00Z\",\"type\":\"response_item\"}\n",
                "not-json\n",
                "{\"timestamp\":\"invalid\",\"type\":\"event_msg\"}\n",
                "{\"timestamp\":\"2026-07-10T10:30:00Z\",\"type\":\"event_msg\"}\n",
                "{\"timestamp\":\"2026-07-10T12:00:00Z\",\"corrupt\":true}\n"
            ),
        )
        .unwrap();

        let parsed = super::parse_session_metadata(&path).unwrap();

        assert_eq!(
            parsed.last_activity_at,
            parse_timestamp_ms(Some("2026-07-10T10:30:00Z"))
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn metadata_parser_ignores_large_unreadable_middle_content() {
        let root =
            std::env::temp_dir().join(format!("codex-monitor-parser-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("rollout-thread-a.jsonl");
        let mut file = std::fs::File::create(&path).unwrap();
        file.write_all(
            b"{\"timestamp\":\"2026-07-10T08:00:00Z\",\"type\":\"session_meta\",\"payload\":{\"id\":\"thread-a\"}}\n",
        )
        .unwrap();
        file.write_all(&vec![0xff; 2 * 1024 * 1024]).unwrap();
        file.write_all(b"\n{\"timestamp\":\"2026-07-10T10:30:00Z\",\"type\":\"event_msg\"}\n")
            .unwrap();
        drop(file);

        let parsed = super::parse_session_metadata(&path).unwrap();

        assert_eq!(parsed.thread_id, "thread-a");
        assert_eq!(
            parsed.last_activity_at,
            parse_timestamp_ms(Some("2026-07-10T10:30:00Z"))
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn metadata_parser_does_not_invent_activity_time() {
        let root =
            std::env::temp_dir().join(format!("codex-monitor-parser-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("rollout-thread-a.jsonl");
        std::fs::write(
            &path,
            "{\"type\":\"session_meta\",\"payload\":{\"id\":\"thread-a\"}}\n",
        )
        .unwrap();

        let parsed = super::parse_session_metadata(&path).unwrap();

        assert_eq!(parsed.created_at, None);
        assert_eq!(parsed.last_activity_at, None);
        std::fs::remove_dir_all(root).unwrap();
    }
}
