use std::collections::HashMap;
use std::fs::File;
use std::io::{BufRead, BufReader, Read};
use std::path::Path;

use serde_json::Value;

use crate::types::{
    ManagedSession, SessionSearchMatch, SessionSearchMatchField, SessionSearchRequest,
    SessionSearchResult,
};

use super::scanner::{MultiSourceSessionScanResult, SearchableSessionFile};

const MAX_SEARCH_BYTES: u64 = 8 * 1024 * 1024;
const MAX_SNIPPET_CHARS: usize = 180;

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub(crate) struct SearchCacheKey {
    source_id: String,
    thread_id: String,
    modified_at: Option<i64>,
}

#[derive(Debug, Clone, Default)]
pub(crate) struct SearchDocument {
    segments: Vec<SearchSegment>,
    incomplete: bool,
}

#[derive(Debug, Clone)]
struct SearchSegment {
    field: SessionSearchMatchField,
    text: String,
    normalized: String,
}

pub(crate) fn search_scan_results(
    scan: &MultiSourceSessionScanResult,
    request: &SessionSearchRequest,
    cache: &mut HashMap<SearchCacheKey, SearchDocument>,
    is_cancelled: impl Fn() -> bool,
    mut on_progress: impl FnMut(Option<&SessionSearchResult>, &str, usize, bool),
) -> (Vec<SessionSearchResult>, bool, usize) {
    let query = request.query.trim().to_lowercase();
    if query.is_empty() {
        return (Vec::new(), false, 0);
    }
    let mut results = Vec::new();
    let mut any_incomplete = false;
    let mut scanned_files = 0;

    for session in &scan.sessions {
        if is_cancelled() {
            break;
        }
        if !request.source_ids.is_empty() && !request.source_ids.contains(&session.source_id) {
            continue;
        }
        if !request.include_archived && session.is_archived {
            continue;
        }
        if !request.include_subagents && session.is_subagent {
            continue;
        }

        let mut matches = summary_matches(session, &query);
        let mut incomplete = false;
        if let Some(file) = scan.files_by_key.get(&session.key) {
            scanned_files += 1;
            let cache_key = SearchCacheKey {
                source_id: session.source_id.clone(),
                thread_id: session.thread_id.clone(),
                modified_at: file.modified_at,
            };
            let document = cache
                .entry(cache_key)
                .or_insert_with(|| parse_search_document(file));
            incomplete = document.incomplete;
            for segment in &document.segments {
                if segment.normalized.contains(&query)
                    && !matches.iter().any(|item| item.field == segment.field)
                {
                    matches.push(SessionSearchMatch {
                        field: segment.field,
                        snippet: Some(snippet(&segment.text, &query)),
                    });
                }
            }
        }
        any_incomplete |= incomplete;
        if !matches.is_empty() {
            results.push(SessionSearchResult {
                session: session.clone(),
                matches,
                incomplete,
            });
            on_progress(
                results.last(),
                &session.source_id,
                scanned_files,
                any_incomplete,
            );
        } else {
            on_progress(None, &session.source_id, scanned_files, any_incomplete);
        }
    }

    (results, any_incomplete, scanned_files)
}

fn summary_matches(session: &ManagedSession, query: &str) -> Vec<SessionSearchMatch> {
    let mut matches = Vec::new();
    push_summary_match(
        &mut matches,
        SessionSearchMatchField::Title,
        &session.title,
        query,
    );
    push_summary_match(
        &mut matches,
        SessionSearchMatchField::ThreadId,
        &session.thread_id,
        query,
    );
    if let Some(cwd) = session.cwd.as_deref() {
        push_summary_match(
            &mut matches,
            SessionSearchMatchField::ProjectPath,
            cwd,
            query,
        );
        if let Some(name) = Path::new(cwd).file_name().and_then(|value| value.to_str()) {
            push_summary_match(
                &mut matches,
                SessionSearchMatchField::ProjectName,
                name,
                query,
            );
        }
    }
    matches
}

fn push_summary_match(
    matches: &mut Vec<SessionSearchMatch>,
    field: SessionSearchMatchField,
    value: &str,
    query: &str,
) {
    if value.to_lowercase().contains(query) {
        matches.push(SessionSearchMatch {
            field,
            snippet: Some(snippet(value, query)),
        });
    }
}

fn parse_search_document(file: &SearchableSessionFile) -> SearchDocument {
    let metadata = match std::fs::metadata(&file.path) {
        Ok(metadata) => metadata,
        Err(_) => {
            return SearchDocument {
                segments: Vec::new(),
                incomplete: true,
            }
        }
    };
    let incomplete = metadata.len() > MAX_SEARCH_BYTES;
    let file = match File::open(&file.path) {
        Ok(file) => file,
        Err(_) => {
            return SearchDocument {
                segments: Vec::new(),
                incomplete: true,
            }
        }
    };
    let reader = BufReader::new(file.take(MAX_SEARCH_BYTES));
    let mut segments = Vec::new();
    let mut parse_incomplete = incomplete;
    for line in reader.lines() {
        let line = match line {
            Ok(line) => line,
            Err(_) => {
                parse_incomplete = true;
                break;
            }
        };
        let value: Value = match serde_json::from_str(&line) {
            Ok(value) => value,
            Err(_) => {
                parse_incomplete = true;
                continue;
            }
        };
        extract_search_segments(&value, &mut segments);
    }
    SearchDocument {
        segments,
        incomplete: parse_incomplete,
    }
}

fn extract_search_segments(value: &Value, segments: &mut Vec<SearchSegment>) {
    let record_type = value.get("type").and_then(Value::as_str);
    let Some(payload) = value.get("payload") else {
        return;
    };
    match record_type {
        Some("event_msg") => match payload.get("type").and_then(Value::as_str) {
            Some("user_message") => push_text(
                segments,
                SessionSearchMatchField::UserMessage,
                payload.get("message"),
            ),
            Some("agent_message")
                if payload.get("phase").and_then(Value::as_str) == Some("final_answer") =>
            {
                push_text(
                    segments,
                    SessionSearchMatchField::AgentReply,
                    payload.get("message"),
                )
            }
            _ => {}
        },
        Some("response_item") if payload.get("type").and_then(Value::as_str) == Some("message") => {
            let field = match payload.get("role").and_then(Value::as_str) {
                Some("user") => Some(SessionSearchMatchField::UserMessage),
                Some("assistant")
                    if payload.get("phase").and_then(Value::as_str) == Some("final_answer") =>
                {
                    Some(SessionSearchMatchField::AgentReply)
                }
                _ => None,
            };
            if let Some(field) = field {
                if let Some(content) = payload.get("content").and_then(Value::as_array) {
                    for item in content {
                        let content_type = item.get("type").and_then(Value::as_str);
                        if matches!(content_type, Some("input_text" | "output_text" | "text")) {
                            push_text(segments, field, item.get("text"));
                        }
                    }
                }
            }
        }
        _ => {}
    }
}

fn push_text(
    segments: &mut Vec<SearchSegment>,
    field: SessionSearchMatchField,
    value: Option<&Value>,
) {
    let Some(text) = value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
    else {
        return;
    };
    if segments
        .iter()
        .any(|segment| segment.field == field && segment.text == text)
    {
        return;
    }
    segments.push(SearchSegment {
        field,
        text: text.to_string(),
        normalized: text.to_lowercase(),
    });
}

fn snippet(text: &str, query: &str) -> String {
    let normalized = text.to_lowercase();
    let byte_index = normalized.find(query).unwrap_or_default();
    let char_index = normalized[..byte_index].chars().count();
    let chars: Vec<char> = text.chars().collect();
    let start = char_index.saturating_sub(MAX_SNIPPET_CHARS / 3);
    let end = (start + MAX_SNIPPET_CHARS).min(chars.len());
    let mut value: String = chars[start..end].iter().collect();
    if start > 0 {
        value.insert(0, '…');
    }
    if end < chars.len() {
        value.push('…');
    }
    value
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::fs;

    use serde_json::json;
    use uuid::Uuid;

    use super::search_scan_results;
    use crate::shared::session_manager_core::scanner::{
        MultiSourceSessionScanResult, SearchableSessionFile,
    };
    use crate::types::{
        ManagedSession, SessionFileConfidence, SessionFileStatus, SessionSearchMatchField,
        SessionSearchRequest,
    };

    #[test]
    fn searches_only_user_and_final_agent_text() {
        let root = std::env::temp_dir().join(format!("codex-monitor-search-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("rollout-thread-a.jsonl");
        let records = [
            json!({"type":"event_msg","payload":{"type":"user_message","message":"find user needle"}}),
            json!({"type":"event_msg","payload":{"type":"agent_message","message":"final agent needle","phase":"final_answer"}}),
            json!({"type":"response_item","payload":{"type":"message","role":"assistant","phase":"commentary","content":[{"type":"output_text","text":"commentary needle"}]}}),
            json!({"type":"event_msg","payload":{"type":"agent_reasoning","text":"reasoning needle"}}),
            json!({"type":"response_item","payload":{"type":"function_call_output","output":"tool needle"}}),
            json!({"type":"event_msg","payload":{"type":"exec_command_end","output":"command needle"}}),
            json!({"type":"event_msg","payload":{"type":"approval_request","message":"approval needle"}}),
        ];
        fs::write(
            &path,
            records
                .iter()
                .map(|record| format!("{record}\n"))
                .collect::<String>(),
        )
        .unwrap();
        let session = ManagedSession {
            key: "source-a:thread-a".into(),
            source_id: "source-a".into(),
            thread_id: "thread-a".into(),
            source_kind: None,
            cwd: Some(root.to_string_lossy().to_string()),
            title: "Alpha".into(),
            title_is_fallback: false,
            preview: None,
            created_at: None,
            updated_at: None,
            archived_at: None,
            is_archived: false,
            parent_thread_id: None,
            is_subagent: false,
            subagent_nickname: None,
            subagent_role: None,
            project_exists: true,
            file_status: SessionFileStatus::Mapped,
            file_confidence: SessionFileConfidence::Exact,
        };
        let scan = MultiSourceSessionScanResult {
            sessions: vec![session],
            diagnostics: vec![],
            files_by_key: HashMap::from([(
                "source-a:thread-a".into(),
                SearchableSessionFile {
                    path,
                    modified_at: Some(1),
                },
            )]),
        };
        let request = |query: &str| SessionSearchRequest {
            request_id: "search-a".into(),
            query: query.into(),
            source_ids: vec![],
            include_archived: true,
            include_subagents: true,
        };
        let mut cache = HashMap::new();
        let (user, _, _) = search_scan_results(
            &scan,
            &request("user needle"),
            &mut cache,
            || false,
            |_, _, _, _| {},
        );
        assert_eq!(
            user[0].matches[0].field,
            SessionSearchMatchField::UserMessage
        );
        let (agent, _, _) = search_scan_results(
            &scan,
            &request("agent needle"),
            &mut cache,
            || false,
            |_, _, _, _| {},
        );
        assert_eq!(
            agent[0].matches[0].field,
            SessionSearchMatchField::AgentReply
        );
        for excluded in [
            "reasoning needle",
            "tool needle",
            "command needle",
            "approval needle",
            "commentary needle",
        ] {
            assert!(search_scan_results(
                &scan,
                &request(excluded),
                &mut cache,
                || false,
                |_, _, _, _| {}
            )
            .0
            .is_empty());
        }
        fs::remove_dir_all(root).unwrap();
    }
}
