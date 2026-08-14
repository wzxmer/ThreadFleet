use crate::types::{SessionAdapterKind, SessionHostKind, SessionPlatform, SessionSource};

use super::compatibility::{source_supports, SessionSourceCapability};
use super::scanner::{
    scan_codex_session_source_with_archive_mode, SessionScanDiagnostic, SourceSessionScanResult,
};

pub(crate) trait SessionFormatAdapter {
    fn scan(&self, source: &SessionSource, include_archived: bool) -> SourceSessionScanResult;
}

struct CodexSessionAdapter;

impl SessionFormatAdapter for CodexSessionAdapter {
    fn scan(&self, source: &SessionSource, include_archived: bool) -> SourceSessionScanResult {
        scan_codex_session_source_with_archive_mode(source, include_archived)
    }
}

pub(crate) fn scan_source_with_archive_mode(
    source: &SessionSource,
    include_archived: bool,
) -> SourceSessionScanResult {
    if !source_supports(source, SessionSourceCapability::Browse) {
        return unavailable_scan(source);
    }
    match (source.adapter_kind, source.host.kind) {
        (SessionAdapterKind::Codex, SessionHostKind::Local) => {
            CodexSessionAdapter.scan(source, include_archived)
        }
        _ => unavailable_scan(source),
    }
}

fn unavailable_scan(source: &SessionSource) -> SourceSessionScanResult {
    let platform = match source.host.platform {
        SessionPlatform::Windows => "windows",
        SessionPlatform::Macos => "macos",
        SessionPlatform::Linux => "linux",
        SessionPlatform::Unknown => "unknown",
    };
    let host = match source.host.kind {
        SessionHostKind::Local => format!("local:{platform}"),
        SessionHostKind::Wsl => format!(
            "wsl:{}:{platform}",
            source.host.id.as_deref().unwrap_or("unconfigured")
        ),
        SessionHostKind::Remote => format!(
            "remote:{}:{platform}",
            source.host.id.as_deref().unwrap_or("unconfigured")
        ),
    };
    SourceSessionScanResult {
        source_id: source.id.clone(),
        sessions: Vec::new(),
        diagnostics: vec![SessionScanDiagnostic {
            source_id: source.id.clone(),
            path: None,
            error: format!(
                "Session adapter {:?} is unavailable on host {host}",
                source.adapter_kind
            ),
        }],
        files_by_key: Default::default(),
    }
}

#[cfg(test)]
mod tests {
    use super::scan_source_with_archive_mode;
    use crate::shared::session_manager_core::compatibility::reconcile_source_compatibility;
    use crate::types::{
        SessionAdapterKind, SessionHost, SessionHostKind, SessionPlatform, SessionSource,
        SessionSourceCapabilities, SessionSourceStatus,
    };

    fn source(adapter_kind: SessionAdapterKind, host: SessionHost) -> SessionSource {
        let mut source = SessionSource {
            id: "source-a".to_string(),
            name: "Source".to_string(),
            codex_home_path: "/home/test/.codex".to_string(),
            native_root: "/home/test/.codex".to_string(),
            adapter_kind,
            host,
            capabilities: SessionSourceCapabilities::default(),
            enabled: true,
            is_current: false,
            is_default: false,
            discovered_at: 0,
            last_scan_at: None,
            status: SessionSourceStatus::Ready,
            error: None,
        };
        reconcile_source_compatibility(&mut source);
        source
    }

    #[test]
    fn wsl_codex_sources_fail_closed_until_a_host_connector_exists() {
        let result = scan_source_with_archive_mode(
            &source(
                SessionAdapterKind::Codex,
                SessionHost {
                    kind: SessionHostKind::Wsl,
                    id: Some("Ubuntu".to_string()),
                    platform: SessionPlatform::Linux,
                },
            ),
            true,
        );

        assert!(result.sessions.is_empty());
        assert_eq!(result.diagnostics.len(), 1);
        assert!(result.diagnostics[0].error.contains("wsl:Ubuntu"));
    }

    #[test]
    fn third_party_adapters_fail_closed_without_reading_their_roots() {
        let result = scan_source_with_archive_mode(
            &source(SessionAdapterKind::ClaudeCode, SessionHost::default()),
            true,
        );

        assert!(result.sessions.is_empty());
        assert!(result.diagnostics[0].error.contains("ClaudeCode"));
    }

    #[test]
    fn macos_third_party_sources_report_their_platform_without_reading_the_root() {
        let result = scan_source_with_archive_mode(
            &source(
                SessionAdapterKind::GeminiCli,
                SessionHost {
                    kind: SessionHostKind::Local,
                    id: None,
                    platform: SessionPlatform::Macos,
                },
            ),
            true,
        );

        assert!(result.sessions.is_empty());
        assert!(result.diagnostics[0].error.contains("local:macos"));
    }
}
