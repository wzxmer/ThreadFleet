use crate::types::{
    current_session_platform, SessionAdapterKind, SessionHost, SessionHostKind, SessionPlatform,
    SessionSource, SessionSourceCapabilities,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SessionSourceCapability {
    Browse,
    Preview,
    Search,
    Derive,
    Archive,
    Delete,
    ResumeInApp,
}

pub(crate) fn effective_source_capabilities(
    adapter_kind: SessionAdapterKind,
    host: &SessionHost,
) -> SessionSourceCapabilities {
    effective_source_capabilities_for_platform(adapter_kind, host, current_session_platform())
}

fn effective_source_capabilities_for_platform(
    adapter_kind: SessionAdapterKind,
    host: &SessionHost,
    runtime_platform: SessionPlatform,
) -> SessionSourceCapabilities {
    match (adapter_kind, host.kind, host.platform == runtime_platform) {
        (SessionAdapterKind::Codex, SessionHostKind::Local, true) => SessionSourceCapabilities {
            browse: true,
            preview: true,
            search: true,
            derive: true,
            archive: true,
            delete: true,
            open_external: false,
            resume_in_app: true,
        },
        _ => SessionSourceCapabilities::default(),
    }
}

pub(crate) fn reconcile_source_compatibility(source: &mut SessionSource) {
    if source.native_root.trim().is_empty() {
        source.native_root = source.codex_home_path.clone();
    }
    if source.codex_home_path.trim().is_empty() {
        source.codex_home_path = source.native_root.clone();
    }
    source.host.id = source
        .host
        .id
        .take()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    source.host.platform = match (source.host.kind, source.host.platform) {
        (SessionHostKind::Local, SessionPlatform::Unknown) => current_session_platform(),
        (SessionHostKind::Wsl, _) => SessionPlatform::Linux,
        (_, platform) => platform,
    };
    source.capabilities = effective_source_capabilities(source.adapter_kind, &source.host);
}

pub(crate) fn source_supports(source: &SessionSource, capability: SessionSourceCapability) -> bool {
    let capabilities = effective_source_capabilities(source.adapter_kind, &source.host);
    match capability {
        SessionSourceCapability::Browse => capabilities.browse,
        SessionSourceCapability::Preview => capabilities.preview,
        SessionSourceCapability::Search => capabilities.search,
        SessionSourceCapability::Derive => capabilities.derive,
        SessionSourceCapability::Archive => capabilities.archive,
        SessionSourceCapability::Delete => capabilities.delete,
        SessionSourceCapability::ResumeInApp => capabilities.resume_in_app,
    }
}

pub(crate) fn unsupported_capability_error(
    source: &SessionSource,
    capability: SessionSourceCapability,
) -> String {
    format!(
        "Session source '{}' does not support {capability:?} on {:?}",
        source.name, source.host.kind
    )
}

#[cfg(test)]
mod tests {
    use super::{
        effective_source_capabilities, effective_source_capabilities_for_platform,
        reconcile_source_compatibility,
    };
    use crate::types::{
        SessionAdapterKind, SessionHost, SessionHostKind, SessionPlatform, SessionSource,
        SessionSourceCapabilities, SessionSourceStatus,
    };

    fn source(adapter_kind: SessionAdapterKind, host: SessionHost) -> SessionSource {
        SessionSource {
            id: "source-a".to_string(),
            name: "Source".to_string(),
            codex_home_path: "/home/test/.codex".to_string(),
            native_root: String::new(),
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
        }
    }

    #[test]
    fn local_codex_sources_keep_full_current_capabilities() {
        let capabilities =
            effective_source_capabilities(SessionAdapterKind::Codex, &SessionHost::default());

        assert!(capabilities.browse);
        assert!(capabilities.preview);
        assert!(capabilities.search);
        assert!(capabilities.derive);
        assert!(capabilities.archive);
        assert!(capabilities.delete);
        assert!(capabilities.resume_in_app);
    }

    #[test]
    fn unavailable_hosts_and_adapters_fail_closed() {
        let mut wsl = source(
            SessionAdapterKind::Codex,
            SessionHost {
                kind: SessionHostKind::Wsl,
                id: Some(" Ubuntu ".to_string()),
                platform: SessionPlatform::Unknown,
            },
        );
        reconcile_source_compatibility(&mut wsl);

        assert_eq!(wsl.native_root, "/home/test/.codex");
        assert_eq!(wsl.host.id.as_deref(), Some("Ubuntu"));
        assert_eq!(wsl.host.platform, SessionPlatform::Linux);
        assert_eq!(wsl.capabilities, SessionSourceCapabilities::default());
        assert_eq!(
            effective_source_capabilities(SessionAdapterKind::ClaudeCode, &SessionHost::default()),
            SessionSourceCapabilities::default()
        );
    }

    #[test]
    fn macos_local_contract_supports_codex_and_fails_closed_for_other_formats() {
        let mac = SessionHost {
            kind: SessionHostKind::Local,
            id: None,
            platform: SessionPlatform::Macos,
        };

        assert!(
            effective_source_capabilities_for_platform(
                SessionAdapterKind::Codex,
                &mac,
                SessionPlatform::Macos,
            )
            .browse
        );
        for adapter_kind in [
            SessionAdapterKind::ClaudeCode,
            SessionAdapterKind::GeminiCli,
            SessionAdapterKind::OpenCode,
        ] {
            assert_eq!(
                effective_source_capabilities_for_platform(
                    adapter_kind,
                    &mac,
                    SessionPlatform::Macos,
                ),
                SessionSourceCapabilities::default()
            );
        }
    }
}
