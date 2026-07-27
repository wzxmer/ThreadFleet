use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

pub const COMPUTER_CONTROL_SCHEMA_VERSION: u32 = 1;
pub const COMPUTER_CONTROL_SNAPSHOT_TTL_MS: u64 = 30_000;
pub const COMPUTER_USE_DISABLE_OVERRIDE: &str = "plugins.computer-use@openai-bundled.enabled=false";
pub const WINDOWS_UI_SERVER_NAME: &str = "windows-ui";
pub const NODE_REPL_SERVER_NAME: &str = "node_repl";
pub const CHROME_PLUGIN_ID: &str = "chrome@openai-bundled";
pub const BROWSER_PLUGIN_ID: &str = "browser@openai-bundled";
pub const COMPUTER_USE_PLUGIN_ID: &str = "computer-use@openai-bundled";
pub const CHROME_SKILL_NAME: &str = "chrome:control-chrome";
pub const BROWSER_SKILL_NAME: &str = "browser:control-in-app-browser";

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ComputerControlBackend {
    Direct,
    WindowsUi,
    Chrome,
    Browser,
    ComputerUse,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ComputerControlAvailability {
    Ready,
    Missing,
    Failed,
    Unknown,
    Unsupported,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ComputerControlTaskKind {
    Direct,
    NativeWindows,
    SignedInWeb,
    IsolatedWeb,
    Explicit,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ComputerControlEnforcement {
    Hard,
    Advisory,
    Unavailable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ComputerControlReasonCode {
    DirectTask,
    NativeWindowsTask,
    SignedInWebTask,
    IsolatedWebTask,
    ExplicitBackendRequested,
    ConflictingTaskSignals,
    UnknownTaskKind,
    BackendReady,
    BackendMissing,
    BackendFailed,
    BackendUnknown,
    BackendUnsupported,
    ComputerUseUnsupported,
    ComputerUseRedirectedToWindowsUi,
    BackendViolatesSafetyBoundary,
    NoAutomaticFallback,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputerControlBackendCapability {
    pub availability: ComputerControlAvailability,
    pub reason_code: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    diagnostic: Option<String>,
}

impl ComputerControlBackendCapability {
    pub fn new(availability: ComputerControlAvailability, reason_code: impl Into<String>) -> Self {
        Self {
            availability,
            reason_code: reason_code.into(),
            diagnostic: None,
        }
    }

    pub fn with_diagnostic(mut self, diagnostic: &str) -> Self {
        self.diagnostic = sanitize_diagnostic(diagnostic);
        self
    }

    pub fn diagnostic(&self) -> Option<&str> {
        self.diagnostic.as_deref()
    }
}

fn sanitize_diagnostic(value: &str) -> Option<String> {
    const MAX_DIAGNOSTIC_CHARS: usize = 160;
    const FORBIDDEN_TERMS: [&str; 8] = [
        "authorization",
        "bearer",
        "cookie",
        "credential",
        "password",
        "secret",
        "token",
        "api key",
    ];

    let collapsed = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.is_empty()
        || collapsed.chars().any(|character| {
            !character.is_ascii_alphanumeric()
                && !matches!(character, ' ' | '_' | '-' | '.' | ':' | '(' | ')')
        })
        || FORBIDDEN_TERMS
            .iter()
            .any(|term| collapsed.to_ascii_lowercase().contains(term))
    {
        return None;
    }

    Some(collapsed.chars().take(MAX_DIAGNOSTIC_CHARS).collect())
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputerControlCapabilitySnapshot {
    pub schema_version: u32,
    pub observed_at_ms: u64,
    pub execution_host: String,
    pub runtime_fingerprint: String,
    pub backends: BTreeMap<ComputerControlBackend, ComputerControlBackendCapability>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ComputerControlSnapshotInput {
    pub observed_at_ms: u64,
    pub execution_host: String,
    pub runtime_fingerprint: String,
    pub windows_ui: ComputerControlBackendCapability,
    pub chrome: ComputerControlBackendCapability,
    pub browser: ComputerControlBackendCapability,
    pub computer_use: ComputerControlBackendCapability,
}

pub fn build_capability_snapshot(
    input: ComputerControlSnapshotInput,
) -> ComputerControlCapabilitySnapshot {
    let mut backends = BTreeMap::new();
    backends.insert(
        ComputerControlBackend::Direct,
        ComputerControlBackendCapability::new(
            ComputerControlAvailability::Ready,
            "direct_tools_available",
        ),
    );
    backends.insert(ComputerControlBackend::WindowsUi, input.windows_ui);
    backends.insert(ComputerControlBackend::Chrome, input.chrome);
    backends.insert(ComputerControlBackend::Browser, input.browser);
    backends.insert(ComputerControlBackend::ComputerUse, input.computer_use);

    ComputerControlCapabilitySnapshot {
        schema_version: COMPUTER_CONTROL_SCHEMA_VERSION,
        observed_at_ms: input.observed_at_ms,
        execution_host: input.execution_host,
        runtime_fingerprint: input.runtime_fingerprint,
        backends,
    }
}

pub fn computer_control_runtime_fingerprint(
    codex_args: Option<&str>,
    provider_runtime_fingerprint: Option<&str>,
) -> String {
    let mut hasher = Sha256::new();
    for value in [
        codex_args.unwrap_or_default(),
        provider_runtime_fingerprint.unwrap_or_default(),
        COMPUTER_USE_DISABLE_OVERRIDE,
    ] {
        hasher.update((value.len() as u64).to_le_bytes());
        hasher.update(value.as_bytes());
    }
    format!("{:x}", hasher.finalize())
}

pub fn snapshot_is_fresh(
    snapshot: &ComputerControlCapabilitySnapshot,
    runtime_fingerprint: &str,
    now_ms: u64,
) -> bool {
    snapshot.runtime_fingerprint == runtime_fingerprint
        && now_ms.saturating_sub(snapshot.observed_at_ms) <= COMPUTER_CONTROL_SNAPSHOT_TTL_MS
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ComputerControlTaskSignals {
    #[serde(default)]
    pub direct: bool,
    #[serde(default)]
    pub native_windows: bool,
    #[serde(default)]
    pub signed_in_web: bool,
    #[serde(default)]
    pub isolated_web: bool,
    #[serde(default)]
    pub explicit_backend: Option<ComputerControlBackend>,
    #[serde(default)]
    pub explicit_backend_violates_safety_boundary: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputerControlTaskClassification {
    pub task_kind: ComputerControlTaskKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub explicit_backend: Option<ComputerControlBackend>,
    pub native_windows: bool,
    pub explicit_backend_violates_safety_boundary: bool,
    pub reason_codes: Vec<ComputerControlReasonCode>,
}

pub fn classify_computer_control_task(
    signals: &ComputerControlTaskSignals,
) -> ComputerControlTaskClassification {
    let signal_count = [
        signals.direct,
        signals.native_windows,
        signals.signed_in_web,
        signals.isolated_web,
    ]
    .into_iter()
    .filter(|value| *value)
    .count();

    if signal_count > 1 {
        return ComputerControlTaskClassification {
            task_kind: ComputerControlTaskKind::Unknown,
            explicit_backend: signals.explicit_backend,
            native_windows: false,
            explicit_backend_violates_safety_boundary: false,
            reason_codes: vec![ComputerControlReasonCode::ConflictingTaskSignals],
        };
    }

    if let Some(backend) = signals.explicit_backend {
        return ComputerControlTaskClassification {
            task_kind: ComputerControlTaskKind::Explicit,
            explicit_backend: Some(backend),
            native_windows: signals.native_windows,
            explicit_backend_violates_safety_boundary: signals
                .explicit_backend_violates_safety_boundary,
            reason_codes: vec![ComputerControlReasonCode::ExplicitBackendRequested],
        };
    }

    let (task_kind, reason_code) = if signals.direct {
        (
            ComputerControlTaskKind::Direct,
            ComputerControlReasonCode::DirectTask,
        )
    } else if signals.native_windows {
        (
            ComputerControlTaskKind::NativeWindows,
            ComputerControlReasonCode::NativeWindowsTask,
        )
    } else if signals.signed_in_web {
        (
            ComputerControlTaskKind::SignedInWeb,
            ComputerControlReasonCode::SignedInWebTask,
        )
    } else if signals.isolated_web {
        (
            ComputerControlTaskKind::IsolatedWeb,
            ComputerControlReasonCode::IsolatedWebTask,
        )
    } else {
        (
            ComputerControlTaskKind::Unknown,
            ComputerControlReasonCode::UnknownTaskKind,
        )
    };

    ComputerControlTaskClassification {
        task_kind,
        explicit_backend: None,
        native_windows: signals.native_windows,
        explicit_backend_violates_safety_boundary: false,
        reason_codes: vec![reason_code],
    }
}

pub fn infer_computer_control_task_signals(
    task: &str,
    explicit_backend: Option<ComputerControlBackend>,
) -> ComputerControlTaskSignals {
    let normalized = task.trim().to_ascii_lowercase();
    if normalized.is_empty() {
        return ComputerControlTaskSignals {
            direct: true,
            explicit_backend,
            ..Default::default()
        };
    }

    let has_any = |needles: &[&str]| needles.iter().any(|needle| normalized.contains(needle));
    let signed_in_web = has_any(&[
        "chrome:control-chrome",
        "existing chrome",
        "signed-in chrome",
        "logged-in chrome",
        "chrome 登录",
        "chrome登录",
        "登录态 chrome",
        "登录态chrome",
    ]);
    let isolated_web = has_any(&[
        "browser:control-in-app-browser",
        "in-app browser",
        "isolated browser",
        "应用内浏览器",
        "隔离浏览器",
    ]);
    let native_marker = has_any(&[
        "windows app",
        "windows ui",
        "windows-ui",
        "native windows",
        "desktop app",
        "电脑操控",
        "桌面软件",
        "windows 客户端",
        "windows客户端",
    ]);
    let native_action = has_any(&[
        "click",
        "type into",
        "screenshot",
        "control",
        "operate",
        "点击",
        "输入",
        "截图",
        "操控",
        "操作",
    ]);
    let native_windows = native_marker && native_action;
    let signal_count = [native_windows, signed_in_web, isolated_web]
        .into_iter()
        .filter(|value| *value)
        .count();

    ComputerControlTaskSignals {
        direct: signal_count == 0,
        native_windows,
        signed_in_web,
        isolated_web,
        explicit_backend,
        explicit_backend_violates_safety_boundary: matches!(
            (explicit_backend, native_windows),
            (
                Some(ComputerControlBackend::Chrome | ComputerControlBackend::Browser),
                true
            )
        ),
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ComputerControlRouteRequest<'a> {
    pub decision_id: String,
    pub classification: &'a ComputerControlTaskClassification,
    pub snapshot: &'a ComputerControlCapabilitySnapshot,
    pub now_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputerControlRouteDecision {
    pub schema_version: u32,
    pub decision_id: String,
    pub task_kind: ComputerControlTaskKind,
    pub primary_backend: ComputerControlBackend,
    pub availability: ComputerControlAvailability,
    pub enforcement: ComputerControlEnforcement,
    pub reason_codes: Vec<ComputerControlReasonCode>,
    pub execution_host: String,
    pub snapshot_age_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_fragment: Option<String>,
}

pub fn route_computer_control(
    request: ComputerControlRouteRequest<'_>,
) -> ComputerControlRouteDecision {
    let classification = request.classification;
    let mut reason_codes = classification.reason_codes.clone();
    let (backend, forced_availability) = match classification.task_kind {
        ComputerControlTaskKind::Direct => (ComputerControlBackend::Direct, None),
        ComputerControlTaskKind::NativeWindows => (ComputerControlBackend::WindowsUi, None),
        ComputerControlTaskKind::SignedInWeb => (ComputerControlBackend::Chrome, None),
        ComputerControlTaskKind::IsolatedWeb => (ComputerControlBackend::Browser, None),
        ComputerControlTaskKind::Explicit => match classification.explicit_backend {
            Some(ComputerControlBackend::ComputerUse) if classification.native_windows => {
                reason_codes.push(ComputerControlReasonCode::ComputerUseUnsupported);
                reason_codes.push(ComputerControlReasonCode::ComputerUseRedirectedToWindowsUi);
                (ComputerControlBackend::WindowsUi, None)
            }
            Some(ComputerControlBackend::ComputerUse) => {
                reason_codes.push(ComputerControlReasonCode::ComputerUseUnsupported);
                (
                    ComputerControlBackend::Direct,
                    Some(ComputerControlAvailability::Unsupported),
                )
            }
            Some(backend) if classification.explicit_backend_violates_safety_boundary => {
                reason_codes.push(ComputerControlReasonCode::BackendViolatesSafetyBoundary);
                (backend, Some(ComputerControlAvailability::Unsupported))
            }
            Some(backend) => (backend, None),
            None => (
                ComputerControlBackend::Direct,
                Some(ComputerControlAvailability::Unknown),
            ),
        },
        ComputerControlTaskKind::Unknown => (
            ComputerControlBackend::Direct,
            Some(ComputerControlAvailability::Unknown),
        ),
    };

    let availability = forced_availability.unwrap_or_else(|| {
        request
            .snapshot
            .backends
            .get(&backend)
            .map(|capability| capability.availability)
            .unwrap_or(ComputerControlAvailability::Unknown)
    });
    reason_codes.push(availability_reason(availability));

    let enforcement = match (backend, availability) {
        (_, availability) if availability != ComputerControlAvailability::Ready => {
            reason_codes.push(ComputerControlReasonCode::NoAutomaticFallback);
            ComputerControlEnforcement::Unavailable
        }
        (ComputerControlBackend::Chrome | ComputerControlBackend::Browser, _) => {
            ComputerControlEnforcement::Advisory
        }
        (ComputerControlBackend::ComputerUse, _) => ComputerControlEnforcement::Unavailable,
        _ => ComputerControlEnforcement::Hard,
    };

    ComputerControlRouteDecision {
        schema_version: COMPUTER_CONTROL_SCHEMA_VERSION,
        decision_id: request.decision_id,
        task_kind: classification.task_kind,
        primary_backend: backend,
        availability,
        enforcement,
        reason_codes,
        execution_host: request.snapshot.execution_host.clone(),
        snapshot_age_ms: request
            .now_ms
            .saturating_sub(request.snapshot.observed_at_ms),
        context_fragment: None,
    }
}

pub fn attach_computer_control_context(
    mut decision: ComputerControlRouteDecision,
) -> ComputerControlRouteDecision {
    if decision.task_kind == ComputerControlTaskKind::Direct {
        return decision;
    }
    let context = serde_json::json!({
        "schemaVersion": decision.schema_version,
        "decisionId": decision.decision_id,
        "taskKind": decision.task_kind,
        "primaryBackend": decision.primary_backend,
        "availability": decision.availability,
        "enforcement": decision.enforcement,
        "reasonCodes": decision.reason_codes,
        "executionHost": decision.execution_host,
    });
    decision.context_fragment = serde_json::to_string(&context).ok();
    decision
}

fn availability_reason(availability: ComputerControlAvailability) -> ComputerControlReasonCode {
    match availability {
        ComputerControlAvailability::Ready => ComputerControlReasonCode::BackendReady,
        ComputerControlAvailability::Missing => ComputerControlReasonCode::BackendMissing,
        ComputerControlAvailability::Failed => ComputerControlReasonCode::BackendFailed,
        ComputerControlAvailability::Unknown => ComputerControlReasonCode::BackendUnknown,
        ComputerControlAvailability::Unsupported => ComputerControlReasonCode::BackendUnsupported,
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerStatusListResponse {
    #[serde(default)]
    pub data: Vec<McpServerStatus>,
    #[serde(default)]
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerStatus {
    pub name: String,
    pub auth_status: String,
    #[serde(default)]
    pub tools: BTreeMap<String, Value>,
    #[serde(default)]
    pub server_info: Option<McpServerInfo>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerInfo {
    pub name: String,
    pub version: String,
}

pub fn parse_mcp_server_status_list(
    payload: &str,
) -> Result<McpServerStatusListResponse, serde_json::Error> {
    serde_json::from_str(payload)
}

pub fn normalize_mcp_server_capability(
    response: Option<&McpServerStatusListResponse>,
    request_failed: bool,
    server_name: &str,
) -> ComputerControlBackendCapability {
    normalize_mcp_server_capability_with_identity(response, request_failed, server_name, None)
}

pub fn normalize_mcp_server_capability_with_identity(
    response: Option<&McpServerStatusListResponse>,
    request_failed: bool,
    server_name: &str,
    expected_server_info_name: Option<&str>,
) -> ComputerControlBackendCapability {
    if request_failed {
        return ComputerControlBackendCapability::new(
            ComputerControlAvailability::Failed,
            "mcp_status_request_failed",
        );
    }
    let Some(response) = response else {
        return ComputerControlBackendCapability::new(
            ComputerControlAvailability::Unknown,
            "mcp_status_not_observed",
        );
    };
    let mut matches = response
        .data
        .iter()
        .filter(|server| server.name == server_name);
    let Some(server) = matches.next() else {
        let (availability, reason) = if response.next_cursor.is_some() {
            (
                ComputerControlAvailability::Unknown,
                "mcp_status_pagination_incomplete",
            )
        } else {
            (ComputerControlAvailability::Missing, "mcp_server_missing")
        };
        return ComputerControlBackendCapability::new(availability, reason);
    };
    if matches.next().is_some() {
        return ComputerControlBackendCapability::new(
            ComputerControlAvailability::Failed,
            "mcp_server_identity_ambiguous",
        );
    }
    if server.tools.is_empty() {
        return ComputerControlBackendCapability::new(
            ComputerControlAvailability::Failed,
            "mcp_server_has_no_tools",
        );
    }
    if let Some(expected_name) = expected_server_info_name {
        if server.server_info.as_ref().map(|info| info.name.as_str()) != Some(expected_name) {
            return ComputerControlBackendCapability::new(
                ComputerControlAvailability::Failed,
                "mcp_server_identity_mismatch",
            );
        }
    }

    ComputerControlBackendCapability::new(ComputerControlAvailability::Ready, "mcp_server_ready")
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginListResponse {
    #[serde(default)]
    pub marketplaces: Vec<PluginMarketplaceEntry>,
    #[serde(default)]
    pub marketplace_load_errors: Vec<MarketplaceLoadError>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginMarketplaceEntry {
    pub name: String,
    #[serde(default)]
    pub plugins: Vec<PluginSummary>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginSummary {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    pub installed: bool,
    #[serde(default = "default_plugin_availability")]
    pub availability: String,
}

fn default_plugin_availability() -> String {
    "AVAILABLE".to_string()
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketplaceLoadError {
    pub message: String,
}

pub fn parse_plugin_list(payload: &str) -> Result<PluginListResponse, serde_json::Error> {
    serde_json::from_str(payload)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PluginManagementStatus {
    InstalledEnabled,
    Disabled,
    NotInstalled,
    Unavailable,
    Missing,
    Failed,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BrowserBackendEvidence {
    pub plugin_management: PluginManagementStatus,
    pub runtime_tools: ComputerControlAvailability,
    pub node_repl: ComputerControlAvailability,
}

pub fn normalize_browser_backend_capability(
    evidence: BrowserBackendEvidence,
) -> ComputerControlBackendCapability {
    if evidence.plugin_management == PluginManagementStatus::Failed
        || evidence.runtime_tools == ComputerControlAvailability::Failed
        || evidence.node_repl == ComputerControlAvailability::Failed
    {
        return ComputerControlBackendCapability::new(
            ComputerControlAvailability::Failed,
            "browser_capability_probe_failed",
        );
    }
    if evidence.runtime_tools == ComputerControlAvailability::Unsupported
        || evidence.node_repl == ComputerControlAvailability::Unsupported
    {
        return ComputerControlBackendCapability::new(
            ComputerControlAvailability::Unsupported,
            "browser_runtime_dependency_unsupported",
        );
    }
    if evidence.runtime_tools == ComputerControlAvailability::Missing
        || evidence.node_repl == ComputerControlAvailability::Missing
    {
        return ComputerControlBackendCapability::new(
            ComputerControlAvailability::Missing,
            "browser_runtime_dependency_missing",
        );
    }
    if evidence.plugin_management != PluginManagementStatus::InstalledEnabled
        || evidence.runtime_tools != ComputerControlAvailability::Ready
        || evidence.node_repl != ComputerControlAvailability::Ready
    {
        return ComputerControlBackendCapability::new(
            ComputerControlAvailability::Unknown,
            "browser_runtime_readiness_unverified",
        );
    }

    ComputerControlBackendCapability::new(
        ComputerControlAvailability::Ready,
        "browser_runtime_ready",
    )
}

pub fn normalize_plugin_management_status(
    response: Option<&PluginListResponse>,
    request_failed: bool,
    plugin_id: &str,
) -> PluginManagementStatus {
    if request_failed {
        return PluginManagementStatus::Failed;
    }
    let Some(response) = response else {
        return PluginManagementStatus::Unknown;
    };
    if !response.marketplace_load_errors.is_empty() {
        return PluginManagementStatus::Unknown;
    }
    let mut matches = response
        .marketplaces
        .iter()
        .flat_map(|marketplace| &marketplace.plugins)
        .filter(|plugin| plugin.id == plugin_id);
    let Some(plugin) = matches.next() else {
        return PluginManagementStatus::Missing;
    };
    if matches.next().is_some() {
        return PluginManagementStatus::Unknown;
    }
    if plugin.availability != "AVAILABLE" {
        PluginManagementStatus::Unavailable
    } else if !plugin.installed {
        PluginManagementStatus::NotInstalled
    } else if !plugin.enabled {
        PluginManagementStatus::Disabled
    } else {
        PluginManagementStatus::InstalledEnabled
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillsListResponse {
    #[serde(default)]
    pub data: Vec<SkillsListEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillsListEntry {
    #[serde(default)]
    pub skills: Vec<SkillSummary>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillSummary {
    pub name: String,
    pub enabled: bool,
}

pub fn normalize_skill_availability(
    response: Option<&SkillsListResponse>,
    request_failed: bool,
    skill_name: &str,
) -> ComputerControlAvailability {
    if request_failed {
        return ComputerControlAvailability::Failed;
    }
    let Some(response) = response else {
        return ComputerControlAvailability::Unknown;
    };
    let mut matches = response
        .data
        .iter()
        .flat_map(|entry| &entry.skills)
        .filter(|skill| skill.name == skill_name);
    let Some(skill) = matches.next() else {
        return ComputerControlAvailability::Missing;
    };
    if matches.next().is_some() {
        return ComputerControlAvailability::Unknown;
    }
    if skill.enabled {
        ComputerControlAvailability::Ready
    } else {
        ComputerControlAvailability::Missing
    }
}

pub fn effective_plugin_enabled(
    config_read_result: Option<&Value>,
    plugin_id: &str,
) -> Option<bool> {
    config_read_result?
        .get("config")?
        .get("plugins")?
        .get(plugin_id)?
        .get("enabled")?
        .as_bool()
}

pub fn normalize_browser_runtime_evidence(
    effective_plugin_enabled: Option<bool>,
    skill_availability: ComputerControlAvailability,
) -> ComputerControlAvailability {
    match (effective_plugin_enabled, skill_availability) {
        (Some(true), ComputerControlAvailability::Ready) => ComputerControlAvailability::Ready,
        (Some(false), _) | (_, ComputerControlAvailability::Missing) => {
            ComputerControlAvailability::Missing
        }
        (_, ComputerControlAvailability::Failed) => ComputerControlAvailability::Failed,
        (_, ComputerControlAvailability::Unsupported) => ComputerControlAvailability::Unsupported,
        _ => ComputerControlAvailability::Unknown,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn capability(availability: ComputerControlAvailability) -> ComputerControlBackendCapability {
        ComputerControlBackendCapability::new(availability, "test")
    }

    fn snapshot(
        windows_ui: ComputerControlAvailability,
        chrome: ComputerControlAvailability,
        browser: ComputerControlAvailability,
    ) -> ComputerControlCapabilitySnapshot {
        build_capability_snapshot(ComputerControlSnapshotInput {
            observed_at_ms: 900,
            execution_host: "remote:daemon-a".to_string(),
            runtime_fingerprint: "runtime-1".to_string(),
            windows_ui: capability(windows_ui),
            chrome: capability(chrome),
            browser: capability(browser),
            computer_use: ComputerControlBackendCapability::new(
                ComputerControlAvailability::Unsupported,
                "computer_use_disabled_by_cm",
            ),
        })
    }

    #[test]
    fn route_matrix_preserves_backend_boundaries() {
        struct Case {
            name: &'static str,
            signals: ComputerControlTaskSignals,
            expected_backend: ComputerControlBackend,
            expected_enforcement: ComputerControlEnforcement,
        }

        let cases = [
            Case {
                name: "direct",
                signals: ComputerControlTaskSignals {
                    direct: true,
                    ..Default::default()
                },
                expected_backend: ComputerControlBackend::Direct,
                expected_enforcement: ComputerControlEnforcement::Hard,
            },
            Case {
                name: "native windows",
                signals: ComputerControlTaskSignals {
                    native_windows: true,
                    ..Default::default()
                },
                expected_backend: ComputerControlBackend::WindowsUi,
                expected_enforcement: ComputerControlEnforcement::Hard,
            },
            Case {
                name: "signed-in web",
                signals: ComputerControlTaskSignals {
                    signed_in_web: true,
                    ..Default::default()
                },
                expected_backend: ComputerControlBackend::Chrome,
                expected_enforcement: ComputerControlEnforcement::Advisory,
            },
            Case {
                name: "isolated web",
                signals: ComputerControlTaskSignals {
                    isolated_web: true,
                    ..Default::default()
                },
                expected_backend: ComputerControlBackend::Browser,
                expected_enforcement: ComputerControlEnforcement::Advisory,
            },
        ];
        let snapshot = snapshot(
            ComputerControlAvailability::Ready,
            ComputerControlAvailability::Ready,
            ComputerControlAvailability::Ready,
        );

        for case in cases {
            let classification = classify_computer_control_task(&case.signals);
            let decision = route_computer_control(ComputerControlRouteRequest {
                decision_id: case.name.to_string(),
                classification: &classification,
                snapshot: &snapshot,
                now_ms: 1_000,
            });
            assert_eq!(
                decision.primary_backend, case.expected_backend,
                "{}",
                case.name
            );
            assert_eq!(
                decision.enforcement, case.expected_enforcement,
                "{}",
                case.name
            );
            assert_eq!(decision.availability, ComputerControlAvailability::Ready);
        }
    }

    #[test]
    fn unavailable_backends_never_fallback() {
        let cases = [
            (
                ComputerControlTaskSignals {
                    native_windows: true,
                    ..Default::default()
                },
                ComputerControlBackend::WindowsUi,
            ),
            (
                ComputerControlTaskSignals {
                    signed_in_web: true,
                    ..Default::default()
                },
                ComputerControlBackend::Chrome,
            ),
            (
                ComputerControlTaskSignals {
                    isolated_web: true,
                    ..Default::default()
                },
                ComputerControlBackend::Browser,
            ),
        ];
        let snapshot = snapshot(
            ComputerControlAvailability::Missing,
            ComputerControlAvailability::Failed,
            ComputerControlAvailability::Unknown,
        );

        for (signals, expected_backend) in cases {
            let classification = classify_computer_control_task(&signals);
            let decision = route_computer_control(ComputerControlRouteRequest {
                decision_id: "decision".to_string(),
                classification: &classification,
                snapshot: &snapshot,
                now_ms: 1_000,
            });
            assert_eq!(decision.primary_backend, expected_backend);
            assert_eq!(
                decision.enforcement,
                ComputerControlEnforcement::Unavailable
            );
            assert!(decision
                .reason_codes
                .contains(&ComputerControlReasonCode::NoAutomaticFallback));
        }
    }

    #[test]
    fn every_non_ready_state_fails_closed_without_cross_backend_fallback() {
        let non_ready = [
            ComputerControlAvailability::Missing,
            ComputerControlAvailability::Failed,
            ComputerControlAvailability::Unknown,
            ComputerControlAvailability::Unsupported,
        ];

        for availability in non_ready {
            for (signals, expected_backend) in [
                (
                    ComputerControlTaskSignals {
                        native_windows: true,
                        ..Default::default()
                    },
                    ComputerControlBackend::WindowsUi,
                ),
                (
                    ComputerControlTaskSignals {
                        signed_in_web: true,
                        ..Default::default()
                    },
                    ComputerControlBackend::Chrome,
                ),
                (
                    ComputerControlTaskSignals {
                        isolated_web: true,
                        ..Default::default()
                    },
                    ComputerControlBackend::Browser,
                ),
            ] {
                let snapshot = snapshot(availability, availability, availability);
                let classification = classify_computer_control_task(&signals);
                let decision = route_computer_control(ComputerControlRouteRequest {
                    decision_id: "decision".to_string(),
                    classification: &classification,
                    snapshot: &snapshot,
                    now_ms: 1_000,
                });
                assert_eq!(decision.primary_backend, expected_backend);
                assert_eq!(decision.availability, availability);
                assert_eq!(
                    decision.enforcement,
                    ComputerControlEnforcement::Unavailable
                );
            }
        }
    }

    #[test]
    fn explicit_backends_require_readiness_and_respect_safety_boundary() {
        let ready_snapshot = snapshot(
            ComputerControlAvailability::Ready,
            ComputerControlAvailability::Ready,
            ComputerControlAvailability::Ready,
        );
        for (backend, enforcement) in [
            (
                ComputerControlBackend::Direct,
                ComputerControlEnforcement::Hard,
            ),
            (
                ComputerControlBackend::WindowsUi,
                ComputerControlEnforcement::Hard,
            ),
            (
                ComputerControlBackend::Chrome,
                ComputerControlEnforcement::Advisory,
            ),
            (
                ComputerControlBackend::Browser,
                ComputerControlEnforcement::Advisory,
            ),
        ] {
            let classification = classify_computer_control_task(&ComputerControlTaskSignals {
                explicit_backend: Some(backend),
                ..Default::default()
            });
            let decision = route_computer_control(ComputerControlRouteRequest {
                decision_id: "decision".to_string(),
                classification: &classification,
                snapshot: &ready_snapshot,
                now_ms: 1_000,
            });
            assert_eq!(decision.primary_backend, backend);
            assert_eq!(decision.enforcement, enforcement);
        }

        let classification = classify_computer_control_task(&ComputerControlTaskSignals {
            isolated_web: true,
            explicit_backend: Some(ComputerControlBackend::Chrome),
            explicit_backend_violates_safety_boundary: true,
            ..Default::default()
        });
        let decision = route_computer_control(ComputerControlRouteRequest {
            decision_id: "decision".to_string(),
            classification: &classification,
            snapshot: &ready_snapshot,
            now_ms: 1_000,
        });
        assert_eq!(decision.primary_backend, ComputerControlBackend::Chrome);
        assert_eq!(
            decision.availability,
            ComputerControlAvailability::Unsupported
        );
        assert_eq!(
            decision.enforcement,
            ComputerControlEnforcement::Unavailable
        );
        assert!(decision
            .reason_codes
            .contains(&ComputerControlReasonCode::BackendViolatesSafetyBoundary));
    }

    #[test]
    fn computer_use_is_never_selected() {
        let ready_snapshot = snapshot(
            ComputerControlAvailability::Ready,
            ComputerControlAvailability::Ready,
            ComputerControlAvailability::Ready,
        );
        for native_windows in [false, true] {
            let classification = classify_computer_control_task(&ComputerControlTaskSignals {
                native_windows,
                explicit_backend: Some(ComputerControlBackend::ComputerUse),
                ..Default::default()
            });
            let decision = route_computer_control(ComputerControlRouteRequest {
                decision_id: "decision".to_string(),
                classification: &classification,
                snapshot: &ready_snapshot,
                now_ms: 1_000,
            });
            assert_ne!(
                decision.primary_backend,
                ComputerControlBackend::ComputerUse
            );
            if native_windows {
                assert_eq!(decision.primary_backend, ComputerControlBackend::WindowsUi);
            } else {
                assert_eq!(
                    decision.availability,
                    ComputerControlAvailability::Unsupported
                );
            }
        }
        assert_eq!(
            ready_snapshot.backends[&ComputerControlBackend::ComputerUse].availability,
            ComputerControlAvailability::Unsupported
        );
    }

    #[test]
    fn unknown_and_conflicting_signals_fail_closed() {
        let ready_snapshot = snapshot(
            ComputerControlAvailability::Ready,
            ComputerControlAvailability::Ready,
            ComputerControlAvailability::Ready,
        );
        let cases = [
            ComputerControlTaskSignals::default(),
            ComputerControlTaskSignals {
                native_windows: true,
                signed_in_web: true,
                ..Default::default()
            },
        ];

        for signals in cases {
            let classification = classify_computer_control_task(&signals);
            let decision = route_computer_control(ComputerControlRouteRequest {
                decision_id: "decision".to_string(),
                classification: &classification,
                snapshot: &ready_snapshot,
                now_ms: 1_000,
            });
            assert_eq!(classification.task_kind, ComputerControlTaskKind::Unknown);
            assert_eq!(decision.availability, ComputerControlAvailability::Unknown);
            assert_eq!(
                decision.enforcement,
                ComputerControlEnforcement::Unavailable
            );
        }
    }

    #[test]
    fn execution_host_is_preserved_and_snapshot_age_saturates() {
        let snapshot = snapshot(
            ComputerControlAvailability::Ready,
            ComputerControlAvailability::Ready,
            ComputerControlAvailability::Ready,
        );
        let classification = classify_computer_control_task(&ComputerControlTaskSignals {
            direct: true,
            ..Default::default()
        });
        let decision = route_computer_control(ComputerControlRouteRequest {
            decision_id: "decision".to_string(),
            classification: &classification,
            snapshot: &snapshot,
            now_ms: 100,
        });
        assert_eq!(decision.execution_host, "remote:daemon-a");
        assert_eq!(decision.snapshot_age_ms, 0);
    }

    #[test]
    fn mcp_status_uses_server_and_tool_evidence_not_auth_display_text() {
        let payload = r#"{
            "data": [{
                "name": "windows-ui",
                "authStatus": "unsupported",
                "tools": {"mcp__windows-ui__get_screenshot": {"name": "get_screenshot", "inputSchema": {}}},
                "resources": [],
                "resourceTemplates": [],
                "serverInfo": {"name": "sbroenne.windows-mcp", "version": "1.0.0"}
            }],
            "nextCursor": null
        }"#;
        let response = parse_mcp_server_status_list(payload).expect("valid target schema");
        let capability =
            normalize_mcp_server_capability(Some(&response), false, WINDOWS_UI_SERVER_NAME);
        assert_eq!(capability.availability, ComputerControlAvailability::Ready);
    }

    #[test]
    fn mcp_status_missing_is_unknown_until_all_pages_are_seen() {
        let partial = McpServerStatusListResponse {
            data: Vec::new(),
            next_cursor: Some("next".to_string()),
        };
        let complete = McpServerStatusListResponse {
            data: Vec::new(),
            next_cursor: None,
        };
        assert_eq!(
            normalize_mcp_server_capability(Some(&partial), false, WINDOWS_UI_SERVER_NAME)
                .availability,
            ComputerControlAvailability::Unknown
        );
        assert_eq!(
            normalize_mcp_server_capability(Some(&complete), false, WINDOWS_UI_SERVER_NAME)
                .availability,
            ComputerControlAvailability::Missing
        );
    }

    #[test]
    fn plugin_list_is_normalized_as_management_state_only() {
        let payload = r#"{
            "marketplaces": [{
                "name": "openai-bundled",
                "plugins": [{
                    "id": "computer-use@openai-bundled",
                    "name": "Computer Use",
                    "enabled": true,
                    "installed": true,
                    "availability": "AVAILABLE",
                    "authPolicy": "ON_USE",
                    "installPolicy": "INSTALLED_BY_DEFAULT",
                    "source": {"type": "remote"}
                }]
            }],
            "featuredPluginIds": [],
            "marketplaceLoadErrors": []
        }"#;
        let response = parse_plugin_list(payload).expect("valid target schema");
        assert_eq!(
            normalize_plugin_management_status(
                Some(&response),
                false,
                "computer-use@openai-bundled"
            ),
            PluginManagementStatus::InstalledEnabled
        );
        // Runtime availability is deliberately absent from PluginManagementStatus.
        assert_eq!(
            build_capability_snapshot(ComputerControlSnapshotInput {
                observed_at_ms: 1,
                execution_host: "local".to_string(),
                runtime_fingerprint: "runtime".to_string(),
                windows_ui: capability(ComputerControlAvailability::Unknown),
                chrome: capability(ComputerControlAvailability::Unknown),
                browser: capability(ComputerControlAvailability::Unknown),
                computer_use: ComputerControlBackendCapability::new(
                    ComputerControlAvailability::Unsupported,
                    "computer_use_disabled_by_cm",
                ),
            })
            .backends[&ComputerControlBackend::ComputerUse]
                .availability,
            ComputerControlAvailability::Unsupported
        );
    }

    #[test]
    fn browser_readiness_requires_runtime_tools_and_node_repl() {
        let management_only = normalize_browser_backend_capability(BrowserBackendEvidence {
            plugin_management: PluginManagementStatus::InstalledEnabled,
            runtime_tools: ComputerControlAvailability::Unknown,
            node_repl: ComputerControlAvailability::Ready,
        });
        assert_eq!(
            management_only.availability,
            ComputerControlAvailability::Unknown
        );

        let ready = normalize_browser_backend_capability(BrowserBackendEvidence {
            plugin_management: PluginManagementStatus::InstalledEnabled,
            runtime_tools: ComputerControlAvailability::Ready,
            node_repl: ComputerControlAvailability::Ready,
        });
        assert_eq!(ready.availability, ComputerControlAvailability::Ready);

        let management_conflict = normalize_browser_backend_capability(BrowserBackendEvidence {
            plugin_management: PluginManagementStatus::Disabled,
            runtime_tools: ComputerControlAvailability::Ready,
            node_repl: ComputerControlAvailability::Ready,
        });
        assert_eq!(
            management_conflict.availability,
            ComputerControlAvailability::Unknown
        );
    }

    #[test]
    fn diagnostic_is_bounded_and_rejects_sensitive_shapes() {
        let bounded = capability(ComputerControlAvailability::Failed)
            .with_diagnostic(&"probe timeout ".repeat(40));
        assert_eq!(
            bounded
                .diagnostic()
                .expect("safe diagnostic")
                .chars()
                .count(),
            160
        );

        for unsafe_value in [
            r#"C:\Users\user\.codex\config.toml"#,
            "authorization bearer value",
            "api_key=private",
            "https://private.example/path",
        ] {
            assert_eq!(
                capability(ComputerControlAvailability::Failed)
                    .with_diagnostic(unsafe_value)
                    .diagnostic(),
                None
            );
        }
    }

    #[test]
    fn camel_case_and_snake_case_contract_is_stable() {
        let snapshot = snapshot(
            ComputerControlAvailability::Ready,
            ComputerControlAvailability::Ready,
            ComputerControlAvailability::Ready,
        );
        let json = serde_json::to_value(snapshot).expect("serialize snapshot");
        assert_eq!(json["schemaVersion"], 1);
        assert_eq!(json["executionHost"], "remote:daemon-a");
        assert_eq!(json["backends"]["windows_ui"]["availability"], "ready");
        assert_eq!(
            json["backends"]["computer_use"]["availability"],
            "unsupported"
        );
    }

    #[test]
    fn computer_control_runtime_fingerprint_covers_args_provider_and_override() {
        let baseline =
            computer_control_runtime_fingerprint(Some("--profile one"), Some("provider-a"));
        assert_eq!(baseline.len(), 64);
        assert_ne!(
            baseline,
            computer_control_runtime_fingerprint(Some("--profile two"), Some("provider-a"))
        );
        assert_ne!(
            baseline,
            computer_control_runtime_fingerprint(Some("--profile one"), Some("provider-b"))
        );
    }

    #[test]
    fn computer_control_snapshot_cache_requires_matching_runtime_and_ttl() {
        let snapshot = snapshot(
            ComputerControlAvailability::Ready,
            ComputerControlAvailability::Ready,
            ComputerControlAvailability::Ready,
        );
        assert!(snapshot_is_fresh(&snapshot, "runtime-1", 30_900));
        assert!(!snapshot_is_fresh(&snapshot, "runtime-1", 30_901));
        assert!(!snapshot_is_fresh(&snapshot, "runtime-2", 901));
    }

    #[test]
    fn computer_control_effective_config_reads_only_exact_plugin_boolean() {
        let value = serde_json::json!({
            "config": {
                "plugins": {
                    "computer-use@openai-bundled": { "enabled": false },
                    "chrome@openai-bundled": { "enabled": true }
                }
            },
            "origins": { "sensitive": "ignored" }
        });
        assert_eq!(
            effective_plugin_enabled(Some(&value), COMPUTER_USE_PLUGIN_ID),
            Some(false)
        );
        assert_eq!(
            effective_plugin_enabled(Some(&value), CHROME_PLUGIN_ID),
            Some(true)
        );
        assert_eq!(
            effective_plugin_enabled(Some(&value), BROWSER_PLUGIN_ID),
            None
        );
    }

    #[test]
    fn computer_control_skills_and_mcp_identity_fail_closed() {
        let skills: SkillsListResponse = serde_json::from_value(serde_json::json!({
            "data": [{
                "cwd": "redacted",
                "errors": [],
                "skills": [{ "name": CHROME_SKILL_NAME, "enabled": true }]
            }]
        }))
        .expect("skills response");
        assert_eq!(
            normalize_skill_availability(Some(&skills), false, CHROME_SKILL_NAME),
            ComputerControlAvailability::Ready
        );
        assert_eq!(
            normalize_skill_availability(Some(&skills), false, BROWSER_SKILL_NAME),
            ComputerControlAvailability::Missing
        );

        let mcp = parse_mcp_server_status_list(
            r#"{"data":[{"name":"node_repl","authStatus":"unsupported","tools":{"tool":{}},"serverInfo":{"name":"unexpected","version":"1"}}]}"#,
        )
        .expect("mcp response");
        assert_eq!(
            normalize_mcp_server_capability_with_identity(
                Some(&mcp),
                false,
                NODE_REPL_SERVER_NAME,
                Some("rmcp")
            )
            .availability,
            ComputerControlAvailability::Failed
        );
    }

    #[test]
    fn computer_control_text_classification_is_bounded_to_explicit_control_signals() {
        let direct =
            infer_computer_control_task_signals("Update the Windows build documentation", None);
        assert!(direct.direct);
        assert!(!direct.native_windows);

        let native = infer_computer_control_task_signals("请点击 Windows 客户端里的刷新按钮", None);
        assert!(native.native_windows);
        assert!(!native.direct);

        let chrome = infer_computer_control_task_signals(
            "Use signed-in Chrome to inspect the account page",
            None,
        );
        assert!(chrome.signed_in_web);

        let browser =
            infer_computer_control_task_signals("Use the in-app browser for local testing", None);
        assert!(browser.isolated_web);
    }

    #[test]
    fn computer_control_context_is_absent_for_direct_and_structured_for_control() {
        let snapshot = snapshot(
            ComputerControlAvailability::Ready,
            ComputerControlAvailability::Ready,
            ComputerControlAvailability::Ready,
        );
        for (signals, has_context) in [
            (
                ComputerControlTaskSignals {
                    direct: true,
                    ..Default::default()
                },
                false,
            ),
            (
                ComputerControlTaskSignals {
                    native_windows: true,
                    ..Default::default()
                },
                true,
            ),
        ] {
            let classification = classify_computer_control_task(&signals);
            let decision = attach_computer_control_context(route_computer_control(
                ComputerControlRouteRequest {
                    decision_id: "stable-decision".to_string(),
                    classification: &classification,
                    snapshot: &snapshot,
                    now_ms: 1_000,
                },
            ));
            assert_eq!(decision.context_fragment.is_some(), has_context);
            if let Some(context) = decision.context_fragment {
                let value: Value = serde_json::from_str(&context).expect("context json");
                assert_eq!(value["decisionId"], "stable-decision");
                assert_eq!(value["primaryBackend"], "windows_ui");
            }
        }
    }
}
