use std::collections::HashSet;
use std::path::{Path, PathBuf};

use semver::Version;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use toml_edit::{value, Array, Item, Table};

use crate::shared::config_toml_core;

pub(crate) const WINDOWS_UI_SERVER_NAME: &str = "windows-ui";
pub(crate) const WINDOWS_UI_SERVER_INFO_NAME: &str = "sbroenne.windows-mcp";
pub(crate) const WINDOWS_UI_EXECUTABLE_NAME: &str = "Sbroenne.WindowsMcp.exe";
pub(crate) const WINDOWS_UI_RELEASE_API: &str =
    "https://api.github.com/repos/sbroenne/mcp-windows/releases/latest";
pub(crate) const WINDOWS_UI_RELEASE_TAG_API_PREFIX: &str =
    "https://api.github.com/repos/sbroenne/mcp-windows/releases/tags/v";
pub(crate) const WINDOWS_UI_MCP_PROTOCOL_VERSION: &str = "2025-06-18";
pub(crate) const WINDOWS_UI_MAX_ARCHIVE_BYTES: u64 = 256 * 1024 * 1024;
pub(crate) const WINDOWS_UI_MAX_EXTRACTED_BYTES: u64 = 512 * 1024 * 1024;
pub(crate) const WINDOWS_UI_MAX_ARCHIVE_ENTRIES: usize = 4_096;

pub(crate) const WINDOWS_UI_ENABLED_TOOLS: &[&str] = &[
    "app",
    "window_management",
    "ui_find",
    "ui_read",
    "ui_click",
    "ui_type",
    "screenshot_control",
    "mouse_control",
    "keyboard_control",
];

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) struct GithubRelease {
    pub(crate) tag_name: String,
    pub(crate) html_url: String,
    pub(crate) draft: bool,
    pub(crate) prerelease: bool,
    pub(crate) assets: Vec<GithubReleaseAsset>,
}

#[derive(Clone, Debug, Deserialize)]
pub(crate) struct GithubReleaseAsset {
    pub(crate) name: String,
    pub(crate) size: u64,
    pub(crate) browser_download_url: String,
    pub(crate) digest: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ResolvedWindowsUiRelease {
    pub(crate) version: Version,
    pub(crate) release_url: String,
    pub(crate) asset_name: String,
    pub(crate) asset_url: String,
    pub(crate) asset_size: u64,
    pub(crate) asset_sha256: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WindowsUiReleaseInfo {
    pub(crate) version: String,
    pub(crate) release_url: String,
    pub(crate) asset_size: u64,
    pub(crate) asset_sha256: String,
}

impl From<&ResolvedWindowsUiRelease> for WindowsUiReleaseInfo {
    fn from(release: &ResolvedWindowsUiRelease) -> Self {
        Self {
            version: release.version.to_string(),
            release_url: release.release_url.clone(),
            asset_size: release.asset_size,
            asset_sha256: release.asset_sha256.clone(),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum WindowsUiUpdateStatus {
    Unsupported,
    Unmanaged,
    UpToDate,
    Available,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WindowsUiUpdateCheckResult {
    pub(crate) status: WindowsUiUpdateStatus,
    pub(crate) installed: bool,
    pub(crate) managed: bool,
    pub(crate) current_version: Option<String>,
    pub(crate) release: Option<WindowsUiReleaseInfo>,
    pub(crate) reason_code: Option<String>,
}

impl WindowsUiUpdateCheckResult {
    pub(crate) fn unsupported(reason_code: &str) -> Self {
        Self {
            status: WindowsUiUpdateStatus::Unsupported,
            installed: false,
            managed: false,
            current_version: None,
            release: None,
            reason_code: Some(reason_code.to_string()),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InstalledWindowsUi {
    pub(crate) version: String,
    pub(crate) requires_codex_restart: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum WindowsUiInstallationKind {
    Missing,
    Managed,
    Unmanaged,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct WindowsUiInstallation {
    pub(crate) kind: WindowsUiInstallationKind,
    pub(crate) version: Option<Version>,
    pub(crate) executable_path: Option<PathBuf>,
    pub(crate) executable_exists: bool,
}

pub(crate) fn windows_ui_asset_arch(process_arch: &str) -> Result<&'static str, String> {
    match process_arch.trim().to_ascii_lowercase().as_str() {
        "x86_64" | "amd64" | "x64" => Ok("x64"),
        "aarch64" | "arm64" => Ok("arm64"),
        other => Err(format!(
            "windows-ui updates do not support architecture '{other}'."
        )),
    }
}

pub(crate) fn normalize_windows_ui_version(raw: &str) -> Result<Version, String> {
    let normalized = raw.trim().trim_start_matches(['v', 'V']);
    let version = Version::parse(normalized)
        .map_err(|error| format!("Invalid windows-ui version '{raw}': {error}"))?;
    if !version.pre.is_empty() || !version.build.is_empty() {
        return Err("windows-ui updater accepts stable SemVer releases only.".to_string());
    }
    Ok(version)
}

pub(crate) fn expected_windows_ui_asset_name(version: &Version, arch: &str) -> String {
    format!("windows-mcp-server-{version}-win-{arch}.zip")
}

pub(crate) fn resolve_windows_ui_release(
    release: GithubRelease,
    process_arch: &str,
) -> Result<ResolvedWindowsUiRelease, String> {
    if release.draft || release.prerelease {
        return Err("windows-ui updater rejects draft and prerelease releases.".to_string());
    }
    let version = normalize_windows_ui_version(&release.tag_name)?;
    if release.tag_name != format!("v{version}") {
        return Err(
            "windows-ui release tag does not use the canonical v<SemVer> form.".to_string(),
        );
    }
    validate_release_page_url(&release.html_url, &version)?;
    let arch = windows_ui_asset_arch(process_arch)?;
    let expected_name = expected_windows_ui_asset_name(&version, arch);
    let matching = release
        .assets
        .into_iter()
        .filter(|asset| asset.name == expected_name)
        .collect::<Vec<_>>();
    if matching.len() != 1 {
        return Err(format!(
            "windows-ui release must contain exactly one '{expected_name}' asset."
        ));
    }
    let asset = matching.into_iter().next().expect("one matching asset");
    if asset.size == 0 || asset.size > WINDOWS_UI_MAX_ARCHIVE_BYTES {
        return Err("windows-ui release asset size is outside the allowed range.".to_string());
    }
    validate_release_asset_url(&asset.browser_download_url, &version, &expected_name)?;
    let digest = asset
        .digest
        .as_deref()
        .ok_or_else(|| "windows-ui release asset is missing a GitHub digest.".to_string())?;
    let asset_sha256 = normalize_sha256_digest(digest)?;

    Ok(ResolvedWindowsUiRelease {
        version,
        release_url: release.html_url,
        asset_name: asset.name,
        asset_url: asset.browser_download_url,
        asset_size: asset.size,
        asset_sha256,
    })
}

pub(crate) fn validate_windows_ui_release_confirmation(
    release: &ResolvedWindowsUiRelease,
    expected_version: &Version,
    expected_asset_size: u64,
    expected_asset_sha256: &str,
) -> Result<(), String> {
    let expected_asset_sha256 = normalize_sha256_hex(expected_asset_sha256)
        .map_err(|_| "windows-ui release confirmation is invalid; check again.".to_string())?;
    if &release.version != expected_version
        || release.asset_size != expected_asset_size
        || release.asset_sha256 != expected_asset_sha256
    {
        return Err("windows-ui release changed after confirmation; check again.".to_string());
    }
    Ok(())
}

fn validate_release_page_url(url: &str, version: &Version) -> Result<(), String> {
    let parsed = reqwest::Url::parse(url)
        .map_err(|error| format!("Invalid windows-ui release page URL: {error}"))?;
    let expected_path = format!("/sbroenne/mcp-windows/releases/tag/v{version}");
    validate_github_url(&parsed, &expected_path, "release page")
}

fn validate_release_asset_url(
    url: &str,
    version: &Version,
    asset_name: &str,
) -> Result<(), String> {
    let parsed = reqwest::Url::parse(url)
        .map_err(|error| format!("Invalid windows-ui release asset URL: {error}"))?;
    let expected_path = format!("/sbroenne/mcp-windows/releases/download/v{version}/{asset_name}");
    validate_github_url(&parsed, &expected_path, "release asset")
}

fn validate_github_url(
    parsed: &reqwest::Url,
    expected_path: &str,
    label: &str,
) -> Result<(), String> {
    if parsed.scheme() != "https"
        || parsed.host_str() != Some("github.com")
        || parsed.port().is_some()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.path() != expected_path
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return Err(format!(
            "windows-ui {label} URL is outside the fixed GitHub repository path."
        ));
    }
    Ok(())
}

fn normalize_sha256_digest(raw: &str) -> Result<String, String> {
    let value = raw
        .trim()
        .strip_prefix("sha256:")
        .ok_or_else(|| "windows-ui release digest is not SHA-256.".to_string())?;
    normalize_sha256_hex(value)
}

fn normalize_sha256_hex(raw: &str) -> Result<String, String> {
    let value = raw.trim();
    if value.len() != 64 || !value.chars().all(|ch| ch.is_ascii_hexdigit()) {
        return Err("windows-ui release SHA-256 digest is malformed.".to_string());
    }
    Ok(value.to_ascii_lowercase())
}

pub(crate) fn windows_ui_install_root(codex_home: &Path) -> PathBuf {
    codex_home.join("mcp-servers").join("sbroenne-mcp-windows")
}

pub(crate) fn windows_ui_install_dir(codex_home: &Path, version: &Version) -> PathBuf {
    windows_ui_install_root(codex_home).join(version.to_string())
}

pub(crate) fn windows_ui_executable_path(codex_home: &Path, version: &Version) -> PathBuf {
    windows_ui_install_dir(codex_home, version).join(WINDOWS_UI_EXECUTABLE_NAME)
}

pub(crate) fn inspect_windows_ui_installation(
    codex_home: &Path,
) -> Result<WindowsUiInstallation, String> {
    let snapshot = config_toml_core::load_global_config_snapshot(codex_home)?;
    inspect_windows_ui_installation_document(codex_home, &snapshot.document)
}

pub(crate) fn load_windows_ui_installation_snapshot(
    codex_home: &Path,
) -> Result<
    (
        config_toml_core::GlobalConfigSnapshot,
        WindowsUiInstallation,
    ),
    String,
> {
    let snapshot = config_toml_core::load_global_config_snapshot(codex_home)?;
    let installation = inspect_windows_ui_installation_document(codex_home, &snapshot.document)?;
    Ok((snapshot, installation))
}

fn inspect_windows_ui_installation_document(
    codex_home: &Path,
    document: &toml_edit::Document,
) -> Result<WindowsUiInstallation, String> {
    let Some(mcp_servers_item) = document.get("mcp_servers") else {
        return Ok(missing_installation());
    };
    let mcp_servers = mcp_servers_item
        .as_table_like()
        .ok_or_else(|| "`mcp_servers` must be a table in config.toml".to_string())?;
    let Some(server_item) = mcp_servers.get(WINDOWS_UI_SERVER_NAME) else {
        return Ok(missing_installation());
    };
    let server = server_item
        .as_table_like()
        .ok_or_else(|| "`mcp_servers.windows-ui` must be a table in config.toml".to_string())?;
    if server.get("url").is_some() {
        return Ok(unmanaged_installation(None));
    }
    let command = server
        .get("command")
        .and_then(Item::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let Some(command) = command else {
        return Ok(unmanaged_installation(None));
    };
    let executable_path = PathBuf::from(command);
    let Some(version) = managed_version_from_command(codex_home, &executable_path) else {
        return Ok(unmanaged_installation(Some(executable_path)));
    };
    let executable_exists = executable_path.is_file();
    Ok(WindowsUiInstallation {
        kind: WindowsUiInstallationKind::Managed,
        version: Some(version),
        executable_path: Some(executable_path),
        executable_exists,
    })
}

fn missing_installation() -> WindowsUiInstallation {
    WindowsUiInstallation {
        kind: WindowsUiInstallationKind::Missing,
        version: None,
        executable_path: None,
        executable_exists: false,
    }
}

fn unmanaged_installation(executable_path: Option<PathBuf>) -> WindowsUiInstallation {
    let executable_exists = executable_path.as_deref().is_some_and(Path::is_file);
    WindowsUiInstallation {
        kind: WindowsUiInstallationKind::Unmanaged,
        version: None,
        executable_path,
        executable_exists,
    }
}

fn managed_version_from_command(codex_home: &Path, command: &Path) -> Option<Version> {
    if !command.is_absolute() {
        return None;
    }
    let relative = command
        .strip_prefix(windows_ui_install_root(codex_home))
        .ok()?;
    let components = relative.components().collect::<Vec<_>>();
    if components.len() != 2 {
        return None;
    }
    let version_raw = components[0].as_os_str().to_str()?;
    let executable_name = components[1].as_os_str().to_str()?;
    if executable_name != WINDOWS_UI_EXECUTABLE_NAME {
        return None;
    }
    let version = normalize_windows_ui_version(version_raw).ok()?;
    if version.to_string() != version_raw {
        return None;
    }
    Some(version)
}

pub(crate) fn configure_windows_ui(
    codex_home: &Path,
    executable_path: &Path,
    version: &Version,
    snapshot: &config_toml_core::GlobalConfigSnapshot,
) -> Result<(), String> {
    let expected_path = windows_ui_executable_path(codex_home, version);
    if executable_path != expected_path || !executable_path.is_file() {
        return Err("windows-ui executable is outside the verified version directory.".to_string());
    }

    let existing = inspect_windows_ui_installation_document(codex_home, &snapshot.document)?;
    if existing.kind == WindowsUiInstallationKind::Unmanaged {
        return Err(
            "Existing windows-ui MCP configuration is not managed by ThreadFleet; refusing to overwrite it."
                .to_string(),
        );
    }

    let mut document = snapshot.document.clone();
    let mcp_servers = config_toml_core::ensure_table(&mut document, "mcp_servers")?;
    if mcp_servers.get(WINDOWS_UI_SERVER_NAME).is_none() {
        mcp_servers[WINDOWS_UI_SERVER_NAME] = Item::Table(Table::new());
    }
    let server = mcp_servers[WINDOWS_UI_SERVER_NAME]
        .as_table_like_mut()
        .ok_or_else(|| "`mcp_servers.windows-ui` must be a table in config.toml".to_string())?;
    server.remove("url");
    server.insert("command", value(executable_path.to_string_lossy().as_ref()));
    server.insert("startup_timeout_sec", value(30.0));
    server.insert("tool_timeout_sec", value(60.0));
    server.insert("default_tools_approval_mode", value("writes"));
    let mut enabled_tools = Array::new();
    for tool in WINDOWS_UI_ENABLED_TOOLS {
        enabled_tools.push(*tool);
    }
    server.insert("enabled_tools", value(enabled_tools));

    config_toml_core::persist_global_config_document_if_unchanged(codex_home, snapshot, &document)
}

pub(crate) fn parse_windows_ui_version_output(output: &str) -> Result<Version, String> {
    let prefix = format!("{WINDOWS_UI_SERVER_INFO_NAME} version ");
    let raw = output
        .lines()
        .find_map(|line| line.trim().strip_prefix(&prefix))
        .ok_or_else(|| "windows-ui --version output has an unexpected identity.".to_string())?;
    normalize_windows_ui_version(raw)
}

pub(crate) fn validate_windows_ui_mcp_probe(
    initialize_response: &Value,
    tool_names: &HashSet<String>,
    expected_version: &Version,
) -> Result<(), String> {
    if initialize_response.get("error").is_some() {
        return Err("windows-ui MCP initialize returned an error.".to_string());
    }
    let result = initialize_response
        .get("result")
        .and_then(Value::as_object)
        .ok_or_else(|| "windows-ui MCP initialize response is missing a result.".to_string())?;
    if result.get("protocolVersion").and_then(Value::as_str)
        != Some(WINDOWS_UI_MCP_PROTOCOL_VERSION)
    {
        return Err("windows-ui MCP protocol identity changed.".to_string());
    }
    let server_info = result
        .get("serverInfo")
        .and_then(Value::as_object)
        .ok_or_else(|| "windows-ui MCP serverInfo is missing.".to_string())?;
    if server_info.get("name").and_then(Value::as_str) != Some(WINDOWS_UI_SERVER_INFO_NAME) {
        return Err("windows-ui MCP server identity changed.".to_string());
    }
    let reported_version = server_info
        .get("version")
        .and_then(Value::as_str)
        .ok_or_else(|| "windows-ui MCP server version is missing.".to_string())?;
    if normalize_windows_ui_version(reported_version)? != *expected_version {
        return Err("windows-ui MCP server version does not match the release.".to_string());
    }
    let missing_tools = WINDOWS_UI_ENABLED_TOOLS
        .iter()
        .copied()
        .filter(|tool| !tool_names.contains(*tool))
        .collect::<Vec<_>>();
    if !missing_tools.is_empty() {
        return Err(format!(
            "windows-ui MCP tool contract changed; missing: {}.",
            missing_tools.join(", ")
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    use serde_json::json;

    use super::*;

    fn release(version: &str, arch: &str, digest: Option<&str>) -> GithubRelease {
        let asset_name = format!("windows-mcp-server-{version}-win-{arch}.zip");
        GithubRelease {
            tag_name: format!("v{version}"),
            html_url: format!(
                "https://github.com/sbroenne/mcp-windows/releases/tag/v{version}"
            ),
            draft: false,
            prerelease: false,
            assets: vec![GithubReleaseAsset {
                name: asset_name.clone(),
                size: 54_072_316,
                browser_download_url: format!(
                    "https://github.com/sbroenne/mcp-windows/releases/download/v{version}/{asset_name}"
                ),
                digest: digest.map(str::to_string),
            }],
        }
    }

    fn temp_codex_home(prefix: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let root = std::env::temp_dir().join(format!("threadfleet-{prefix}-{nonce}"));
        fs::create_dir_all(&root).expect("create temp CODEX_HOME");
        root
    }

    #[test]
    fn release_resolution_requires_fixed_asset_and_digest() {
        let digest = format!("sha256:{}", "a".repeat(64));
        let resolved =
            resolve_windows_ui_release(release("1.3.18", "x64", Some(&digest)), "x86_64")
                .expect("resolve release");
        assert_eq!(resolved.version, Version::parse("1.3.18").unwrap());
        assert_eq!(resolved.asset_sha256, "a".repeat(64));
        validate_windows_ui_release_confirmation(
            &resolved,
            &Version::parse("1.3.18").unwrap(),
            54_072_316,
            &"A".repeat(64),
        )
        .expect("validate confirmation");
        assert!(validate_windows_ui_release_confirmation(
            &resolved,
            &Version::parse("1.3.18").unwrap(),
            54_072_315,
            &"a".repeat(64),
        )
        .unwrap_err()
        .contains("changed after confirmation"));

        assert!(
            resolve_windows_ui_release(release("1.3.18", "x64", None), "x86_64")
                .unwrap_err()
                .contains("missing a GitHub digest")
        );
    }

    #[test]
    fn release_resolution_rejects_redirected_asset_metadata() {
        let digest = format!("sha256:{}", "b".repeat(64));
        let mut release = release("1.3.18", "x64", Some(&digest));
        release.assets[0].browser_download_url =
            "https://example.com/windows-mcp-server-1.3.18-win-x64.zip".to_string();
        assert!(resolve_windows_ui_release(release, "x86_64")
            .unwrap_err()
            .contains("fixed GitHub repository path"));
    }

    #[test]
    fn release_resolution_maps_supported_windows_architectures() {
        let digest = format!("sha256:{}", "c".repeat(64));
        assert_eq!(windows_ui_asset_arch("x86_64").unwrap(), "x64");
        assert_eq!(windows_ui_asset_arch("aarch64").unwrap(), "arm64");
        assert!(
            resolve_windows_ui_release(release("1.3.18", "arm64", Some(&digest)), "aarch64")
                .is_ok()
        );
        assert!(windows_ui_asset_arch("x86").is_err());
    }

    #[test]
    fn managed_config_update_preserves_unrelated_content_and_security_defaults() {
        let codex_home = temp_codex_home("windows-ui-config");
        fs::write(
            codex_home.join("config.toml"),
            "model = \"gpt-5\"\n\n[mcp_servers.other]\ncommand = \"other.exe\"\n",
        )
        .expect("write config");
        let version = Version::parse("1.3.18").unwrap();
        let executable = windows_ui_executable_path(&codex_home, &version);
        fs::create_dir_all(executable.parent().unwrap()).expect("create version dir");
        fs::write(&executable, b"test").expect("write executable");

        let (snapshot, _) =
            load_windows_ui_installation_snapshot(&codex_home).expect("load snapshot");
        configure_windows_ui(&codex_home, &executable, &version, &snapshot).expect("configure");

        let config = fs::read_to_string(codex_home.join("config.toml")).expect("read config");
        assert!(config.contains("model = \"gpt-5\""));
        assert!(config.contains("[mcp_servers.other]"));
        assert!(config.contains("[mcp_servers.windows-ui]"));
        assert!(config.contains("default_tools_approval_mode = \"writes\""));
        assert!(config.contains("enabled_tools = [\"app\", \"window_management\""));
        let installation = inspect_windows_ui_installation(&codex_home).expect("inspect");
        assert_eq!(installation.kind, WindowsUiInstallationKind::Managed);
        assert_eq!(installation.version, Some(version));

        fs::remove_dir_all(codex_home).expect("remove temp CODEX_HOME");
    }

    #[test]
    fn managed_config_update_refuses_external_server_command() {
        let codex_home = temp_codex_home("windows-ui-unmanaged");
        fs::write(
            codex_home.join("config.toml"),
            "[mcp_servers.windows-ui]\ncommand = \"C:/custom/server.exe\"\n",
        )
        .expect("write config");
        let version = Version::parse("1.3.18").unwrap();
        let executable = windows_ui_executable_path(&codex_home, &version);
        fs::create_dir_all(executable.parent().unwrap()).expect("create version dir");
        fs::write(&executable, b"test").expect("write executable");

        let (snapshot, _) =
            load_windows_ui_installation_snapshot(&codex_home).expect("load snapshot");
        let error =
            configure_windows_ui(&codex_home, &executable, &version, &snapshot).unwrap_err();
        assert!(error.contains("refusing to overwrite"));

        fs::remove_dir_all(codex_home).expect("remove temp CODEX_HOME");
    }

    #[test]
    fn managed_config_update_refuses_changes_after_install_started() {
        let codex_home = temp_codex_home("windows-ui-config-cas");
        fs::write(codex_home.join("config.toml"), "model = \"gpt-5\"\n").expect("write config");
        let version = Version::parse("1.3.18").unwrap();
        let executable = windows_ui_executable_path(&codex_home, &version);
        fs::create_dir_all(executable.parent().unwrap()).expect("create version dir");
        fs::write(&executable, b"test").expect("write executable");
        let (snapshot, _) =
            load_windows_ui_installation_snapshot(&codex_home).expect("load snapshot");
        fs::write(
            codex_home.join("config.toml"),
            "model = \"gpt-5\"\napproval_policy = \"never\"\n",
        )
        .expect("change config");

        let error =
            configure_windows_ui(&codex_home, &executable, &version, &snapshot).unwrap_err();
        assert!(error.contains("changed since it was read"));
        let config = fs::read_to_string(codex_home.join("config.toml")).expect("read config");
        assert!(config.contains("approval_policy = \"never\""));
        assert!(!config.contains("mcp_servers.windows-ui"));

        fs::remove_dir_all(codex_home).expect("remove temp CODEX_HOME");
    }

    #[test]
    fn version_and_mcp_identity_are_strict() {
        let version = parse_windows_ui_version_output(
            "sbroenne.windows-mcp version 1.3.18\nService initialization: OK\n",
        )
        .expect("parse version");
        let tools = WINDOWS_UI_ENABLED_TOOLS
            .iter()
            .map(|tool| tool.to_string())
            .collect::<HashSet<_>>();
        validate_windows_ui_mcp_probe(
            &json!({
                "result": {
                    "protocolVersion": WINDOWS_UI_MCP_PROTOCOL_VERSION,
                    "serverInfo": {
                        "name": WINDOWS_UI_SERVER_INFO_NAME,
                        "version": "1.3.18"
                    }
                },
                "id": 1,
                "jsonrpc": "2.0"
            }),
            &tools,
            &version,
        )
        .expect("validate probe");

        let mut missing = tools.clone();
        missing.remove("ui_click");
        assert!(validate_windows_ui_mcp_probe(
            &json!({
                "result": {
                    "protocolVersion": WINDOWS_UI_MCP_PROTOCOL_VERSION,
                    "serverInfo": {
                        "name": WINDOWS_UI_SERVER_INFO_NAME,
                        "version": "1.3.18"
                    }
                }
            }),
            &missing,
            &version,
        )
        .unwrap_err()
        .contains("ui_click"));
    }
}
