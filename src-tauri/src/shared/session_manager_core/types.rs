#[cfg(windows)]
use crate::utils::normalize_windows_namespace_path;
#[cfg(not(windows))]
use std::path::{Component, Path, PathBuf};

#[allow(unused_imports)]
pub(crate) use crate::types::{
    ManagedSession, SessionFileConfidence, SessionFileStatus, SessionSearchMatch,
    SessionSearchMatchField, SessionSearchProgress, SessionSearchRequest, SessionSearchResult,
    SessionSource, SessionSourceStatus, SourceScopedSessionKey,
};

pub(crate) fn normalize_source_path(path: &str) -> String {
    normalize_source_path_for_platform(path)
}

#[cfg(windows)]
fn normalize_source_path_for_platform(path: &str) -> String {
    let namespace_normalized = normalize_windows_namespace_path(path.trim());
    let slash_normalized = namespace_normalized.replace('/', "\\");
    let (root, remainder, is_absolute) = split_windows_root(&slash_normalized);
    let mut components = Vec::new();

    for component in remainder.split('\\') {
        match component {
            "" | "." => {}
            ".." if components.last().is_some_and(|value| *value != "..") => {
                components.pop();
            }
            ".." if !is_absolute => components.push(component),
            ".." => {}
            _ => components.push(component),
        }
    }

    let joined = components.join("\\");
    match (root.as_str(), joined.is_empty()) {
        ("", _) => joined,
        (_, true) => root,
        (_, false) if root.ends_with('\\') => format!("{root}{joined}"),
        (_, false) => format!("{root}\\{joined}"),
    }
}

#[cfg(not(windows))]
fn normalize_source_path_for_platform(path: &str) -> String {
    let path = Path::new(path.trim());
    let is_absolute = path.is_absolute();
    let mut normalized = PathBuf::new();

    for component in path.components() {
        match component {
            Component::Prefix(prefix) => normalized.push(prefix.as_os_str()),
            Component::RootDir => normalized.push(component.as_os_str()),
            Component::CurDir => {}
            Component::ParentDir
                if normalized
                    .components()
                    .next_back()
                    .is_some_and(|value| matches!(value, Component::Normal(_))) =>
            {
                normalized.pop();
            }
            Component::ParentDir if !is_absolute => normalized.push(component.as_os_str()),
            Component::ParentDir => {}
            Component::Normal(value) => normalized.push(value),
        }
    }

    normalized.to_string_lossy().into_owned()
}

pub(crate) fn source_identity_key(path: &str) -> String {
    let normalized = normalize_source_path(path);
    if cfg!(windows) {
        normalized.to_lowercase()
    } else {
        normalized
    }
}

#[cfg(windows)]
fn split_windows_root(path: &str) -> (String, &str, bool) {
    if let Some(remainder) = path.strip_prefix("\\\\") {
        let mut parts = remainder.splitn(3, '\\');
        let server = parts.next().unwrap_or_default();
        let share = parts.next().unwrap_or_default();
        let tail = parts.next().unwrap_or_default();
        let root = match (server.is_empty(), share.is_empty()) {
            (false, false) => format!(r"\\{server}\{share}"),
            _ => format!(r"\\{remainder}"),
        };
        return (root, tail, true);
    }

    let bytes = path.as_bytes();
    if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
        let drive_root = format!("{}\\", path[..2].to_ascii_uppercase());
        return (drive_root, path[2..].trim_start_matches('\\'), true);
    }

    (String::new(), path, false)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{normalize_source_path, source_identity_key};
    use super::{
        ManagedSession, SessionFileConfidence, SessionFileStatus, SessionSearchMatch,
        SessionSearchMatchField, SessionSearchProgress, SessionSearchRequest, SessionSearchResult,
        SessionSource, SessionSourceStatus, SourceScopedSessionKey,
    };

    #[cfg(windows)]
    #[test]
    fn normalizes_windows_source_paths_and_identity() {
        assert_eq!(
            normalize_source_path(r"  \\?\c:\Users\Lenovo\.codex\sessions\..  "),
            r"C:\Users\Lenovo\.codex"
        );
        assert_eq!(
            source_identity_key(r"C:\Users\Lenovo\.CODEX\"),
            source_identity_key(r"c:/users/lenovo/.codex")
        );
        assert_eq!(
            normalize_source_path(r"\\Server\Share\Codex\.\sessions\.."),
            r"\\Server\Share\Codex"
        );
        assert_eq!(normalize_source_path(r"c:\"), r"C:\");
        assert_eq!(
            normalize_source_path(r"\\Server\Share\..\Other"),
            r"\\Server\Share\Other"
        );
    }

    #[cfg(not(windows))]
    #[test]
    fn normalizes_unix_source_paths_and_preserves_case_sensitive_identity() {
        assert_eq!(
            normalize_source_path("  /Users/test/.codex/sessions/..  "),
            "/Users/test/.codex"
        );
        assert_eq!(normalize_source_path("/../../Users/test"), "/Users/test");
        assert_eq!(normalize_source_path("profiles/../.codex"), ".codex");
        assert_ne!(
            source_identity_key("/Users/test/.CODEX"),
            source_identity_key("/Users/test/.codex")
        );
    }

    #[test]
    fn source_scoped_keys_do_not_collide_across_sources() {
        let first = SourceScopedSessionKey::new("source-a", "thread-1");
        let second = SourceScopedSessionKey::new("source-b", "thread-1");

        assert_ne!(first, second);
        assert_eq!(first.stable_key(), "source-a:thread-1");
    }

    #[test]
    fn serializes_contracts_as_camel_case() {
        let source = SessionSource {
            id: "source-a".to_string(),
            name: "Default".to_string(),
            codex_home_path: r"C:\Users\Lenovo\.codex".to_string(),
            enabled: true,
            is_current: true,
            is_default: true,
            discovered_at: 10,
            last_scan_at: Some(20),
            status: SessionSourceStatus::Ready,
            error: None,
        };
        let session = ManagedSession {
            key: "source-a:thread-1".to_string(),
            source_id: "source-a".to_string(),
            thread_id: "thread-1".to_string(),
            source_kind: Some("vscode".to_string()),
            cwd: Some(r"D:\Project\ThreadFleet".to_string()),
            title: "Session".to_string(),
            title_is_fallback: false,
            preview: None,
            created_at: Some(1),
            updated_at: Some(2),
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
        let result = SessionSearchResult {
            session,
            matches: vec![SessionSearchMatch {
                field: SessionSearchMatchField::ThreadId,
                snippet: None,
            }],
            incomplete: false,
        };
        let progress = SessionSearchProgress {
            request_id: "request-1".to_string(),
            scanned_sources: 1,
            total_sources: 2,
            scanned_files: 3,
            total_files: Some(4),
            completed: false,
            cancelled: false,
            incomplete: true,
        };
        let request = SessionSearchRequest {
            request_id: "request-1".to_string(),
            query: "thread".to_string(),
            source_ids: vec!["source-a".to_string()],
            include_archived: true,
            include_subagents: false,
        };

        assert_eq!(
            serde_json::to_value(source).unwrap(),
            json!({
                "id": "source-a",
                "name": "Default",
                "codexHomePath": r"C:\Users\Lenovo\.codex",
                "enabled": true,
                "isCurrent": true,
                "isDefault": true,
                "discoveredAt": 10,
                "lastScanAt": 20,
                "status": "ready",
                "error": null
            })
        );
        let result_value = serde_json::to_value(result).unwrap();
        assert_eq!(result_value["session"]["sourceId"], "source-a");
        assert_eq!(result_value["session"]["titleIsFallback"], false);
        assert_eq!(result_value["session"]["fileConfidence"], "exact");
        assert_eq!(result_value["matches"][0]["field"], "threadId");
        assert_eq!(serde_json::to_value(progress).unwrap()["totalFiles"], 4);
        assert_eq!(
            serde_json::to_value(request).unwrap()["includeArchived"],
            true
        );
    }
}
