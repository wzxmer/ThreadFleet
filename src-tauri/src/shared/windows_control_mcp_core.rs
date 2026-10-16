//! Provider selection uses the native `windows-ui` MCP slot. Inactive profiles
//! stay disabled in the same config, preserving credentials and tool policies.
use std::{collections::BTreeMap, path::Path};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use toml_edit::{value, Array, Document, Item, Table};

use crate::shared::{config_toml_core, windows_ui_update_core};

const ACTIVE: &str = "windows-ui";
const PROFILE_PREFIX: &str = "threadfleet-windows-";

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum WindowsControlProvider {
    Sbroenne,
    Cursortouch,
    Custom,
}

impl WindowsControlProvider {
    fn profile_name(self) -> String {
        format!(
            "{PROFILE_PREFIX}{}",
            match self {
                Self::Sbroenne => "sbroenne",
                Self::Cursortouch => "cursortouch",
                Self::Custom => "custom",
            }
        )
    }
}

pub(crate) fn identify_provider(command: &str, args: &[String]) -> WindowsControlProvider {
    let executable = command
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(command)
        .to_ascii_lowercase();
    if executable == "sbroenne.windowsmcp.exe" {
        WindowsControlProvider::Sbroenne
    } else if matches!(executable.as_str(), "windows-mcp" | "windows-mcp.exe")
        || (matches!(
            executable.as_str(),
            "uvx" | "uvx.exe" | "uv" | "uv.exe" | "python" | "python.exe"
        ) && args.iter().any(|arg| {
            arg == "windows_mcp" || arg == "windows-mcp" || arg.starts_with("windows-mcp==")
        }))
    {
        WindowsControlProvider::Cursortouch
    } else {
        WindowsControlProvider::Custom
    }
}

// config/read reloads disk, while a running connection can still use the old
// provider. Prefer the actual service identity over the next-session config.
pub(crate) fn expected_runtime_identity(
    config: Option<&serde_json::Value>,
    status: Option<&crate::shared::computer_control_core::McpServerStatusListResponse>,
) -> Option<&'static str> {
    let actual = status
        .and_then(|s| s.data.iter().find(|s| s.name == ACTIVE))
        .and_then(|s| s.server_info.as_ref())
        .map(|s| s.name.as_str());
    match actual {
        Some("sbroenne.windows-mcp") => return Some("sbroenne.windows-mcp"),
        Some("windows-mcp") => return Some("windows-mcp"),
        _ => {}
    }
    let servers = config
        .and_then(|v| v.get("config"))
        .and_then(|v| v.get("mcp_servers").or_else(|| v.get("mcpServers")));
    if servers
        .and_then(|s| s.get(WindowsControlProvider::Custom.profile_name()))
        .and_then(|s| s.get("enabled"))
        .and_then(|v| v.as_bool())
        == Some(false)
    {
        return None;
    }
    let server = config
        .and_then(|v| v.get("config"))
        .and_then(|v| v.get("mcp_servers").or_else(|| v.get("mcpServers")))
        .and_then(|v| v.get(ACTIVE));
    let command = server
        .and_then(|v| v.get("command"))
        .and_then(|v| v.as_str());
    let args = server
        .and_then(|v| v.get("args"))
        .and_then(|v| v.as_array())
        .map(|v| {
            v.iter()
                .filter_map(|v| v.as_str().map(str::to_string))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    match command.map(|c| identify_provider(c, &args)) {
        Some(WindowsControlProvider::Cursortouch) => Some("windows-mcp"),
        Some(WindowsControlProvider::Custom) => None,
        _ => Some("sbroenne.windows-mcp"),
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WindowsControlLaunch {
    pub command: String,
    pub args: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WindowsControlMcpConfig {
    pub supported: bool,
    pub provider: WindowsControlProvider,
    pub enabled: bool,
    pub revision: String,
    pub profiles: BTreeMap<WindowsControlProvider, WindowsControlLaunch>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SetWindowsControlMcpRequest {
    pub provider: WindowsControlProvider,
    pub revision: String,
    pub command: String,
    pub args: Vec<String>,
}

fn launch(item: &Item) -> Option<WindowsControlLaunch> {
    let table = item.as_table_like()?;
    Some(WindowsControlLaunch {
        command: table.get("command")?.as_str()?.to_string(),
        args: table
            .get("args")
            .and_then(Item::as_array)
            .map(|args| {
                args.iter()
                    .filter_map(|v| v.as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default(),
    })
}

fn revision(document: &Document) -> String {
    // Other settings also write this native file. Only changes to our active
    // slot or retained profiles invalidate the user's provider selection.
    let servers = document.get("mcp_servers").and_then(Item::as_table_like);
    let mut hasher = Sha256::new();
    for name in [
        ACTIVE.to_string(),
        WindowsControlProvider::Sbroenne.profile_name(),
        WindowsControlProvider::Cursortouch.profile_name(),
        WindowsControlProvider::Custom.profile_name(),
    ] {
        let content = servers
            .and_then(|s| s.get(&name))
            .map(ToString::to_string)
            .unwrap_or_default();
        hasher.update((content.len() as u64).to_le_bytes());
        hasher.update(content.as_bytes());
    }
    format!("{:x}", hasher.finalize())
}

fn inspect(document: &Document) -> WindowsControlMcpConfig {
    let servers = document.get("mcp_servers").and_then(Item::as_table_like);
    let mut profiles = BTreeMap::new();
    if let Some(servers) = servers {
        for provider in [
            WindowsControlProvider::Sbroenne,
            WindowsControlProvider::Cursortouch,
            WindowsControlProvider::Custom,
        ] {
            if let Some(profile) = servers.get(&provider.profile_name()).and_then(launch) {
                profiles.insert(provider, profile);
            }
        }
    }
    let active = servers.and_then(|s| s.get(ACTIVE));
    let mut provider = WindowsControlProvider::Sbroenne;
    if let Some(current) = active.and_then(launch) {
        provider = identify_provider(&current.command, &current.args);
        profiles.insert(provider, current);
    }
    profiles
        .entry(WindowsControlProvider::Cursortouch)
        .or_insert(WindowsControlLaunch {
            command: "uvx".into(),
            args: vec!["windows-mcp".into(), "serve".into()],
        });
    WindowsControlMcpConfig {
        supported: cfg!(target_os = "windows"),
        provider,
        enabled: active.is_some_and(|v| {
            v.as_table_like()
                .and_then(|t| t.get("enabled"))
                .and_then(Item::as_bool)
                != Some(false)
        }),
        revision: revision(document),
        profiles,
    }
}

pub(crate) fn get_windows_control_mcp(
    codex_home: &Path,
) -> Result<WindowsControlMcpConfig, String> {
    Ok(inspect(
        &config_toml_core::load_global_config_snapshot(codex_home)?.document,
    ))
}

fn switch_document(
    document: &mut Document,
    request: &SetWindowsControlMcpRequest,
) -> Result<(), String> {
    if revision(document) != request.revision {
        return Err("MCP configuration changed. Refresh before switching providers.".into());
    }
    let command = request.command.trim();
    if command.is_empty() || command.contains(['\n', '\r', '\0']) {
        return Err("An executable command is required.".into());
    }
    if request.provider != WindowsControlProvider::Custom
        && identify_provider(command, &request.args) != request.provider
    {
        return Err("The command does not match the selected MCP provider.".into());
    }
    let servers = config_toml_core::ensure_table(document, "mcp_servers")?;
    if let Some(target) = servers.get(&request.provider.profile_name()) {
        if target
            .as_table_like()
            .and_then(|t| t.get("enabled"))
            .and_then(Item::as_bool)
            != Some(false)
        {
            return Err(
                "The selected saved profile is enabled separately. Disable it before switching."
                    .into(),
            );
        }
    }
    if let Some(active) = servers.get(ACTIVE).cloned() {
        let current = launch(&active).ok_or_else(|| "The current windows-ui configuration is not a local stdio server. Edit config.toml to manage it.".to_string())?;
        let provider = identify_provider(&current.command, &current.args);
        let name = provider.profile_name();
        if let Some(saved) = servers.get(&name) {
            if saved
                .as_table_like()
                .and_then(|t| t.get("enabled"))
                .and_then(Item::as_bool)
                != Some(false)
            {
                return Err("A profile name is already used by an enabled MCP server.".into());
            }
        }
        let mut saved = active;
        saved
            .as_table_like_mut()
            .ok_or("Invalid MCP table")?
            .insert("enabled", value(false));
        servers[&name] = saved;
    }
    let mut target = servers
        .get(&request.provider.profile_name())
        .cloned()
        .unwrap_or(Item::Table(Table::new()));
    let table = target
        .as_table_like_mut()
        .ok_or("Invalid MCP profile table")?;
    table.remove("url");
    table.insert("command", value(command));
    let mut args = Array::new();
    for arg in &request.args {
        args.push(arg.as_str());
    }
    table.insert("args", value(args));
    table.insert("enabled", value(true));
    if table.get("default_tools_approval_mode").is_none() {
        table.insert("default_tools_approval_mode", value("writes"));
    }
    if table.get("startup_timeout_sec").is_none() {
        table.insert("startup_timeout_sec", value(60));
    }
    if table.get("enabled_tools").is_none() && request.provider != WindowsControlProvider::Custom {
        let tools = match request.provider {
            WindowsControlProvider::Sbroenne => windows_ui_update_core::WINDOWS_UI_ENABLED_TOOLS,
            _ => &[
                "Snapshot",
                "Screenshot",
                "Click",
                "Type",
                "Scroll",
                "Move",
                "Shortcut",
                "App",
                "WaitFor",
                "DisplayInventory",
                "ControlStatus",
            ],
        };
        let mut enabled = Array::new();
        for tool in tools {
            enabled.push(*tool);
        }
        table.insert("enabled_tools", value(enabled));
    }
    servers[ACTIVE] = target;
    Ok(())
}

pub(crate) fn set_windows_control_mcp(
    codex_home: &Path,
    request: &SetWindowsControlMcpRequest,
) -> Result<WindowsControlMcpConfig, String> {
    if !cfg!(target_os = "windows") {
        return Err("Windows desktop MCP switching requires a Windows execution host.".into());
    }
    let snapshot = config_toml_core::load_global_config_snapshot(codex_home)?;
    let mut document = snapshot.document.clone();
    switch_document(&mut document, request)?;
    config_toml_core::persist_global_config_document_if_unchanged(
        codex_home, &snapshot, &document,
    )?;
    Ok(inspect(&document))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(
        doc: &Document,
        provider: WindowsControlProvider,
        command: &str,
    ) -> SetWindowsControlMcpRequest {
        SetWindowsControlMcpRequest {
            provider,
            command: command.into(),
            args: vec!["serve".into()],
            revision: revision(doc),
        }
    }

    #[test]
    fn switching_round_trips_native_policy_and_preserves_other_servers() {
        let mut doc = config_toml_core::parse_document("# keep\n[mcp_servers.docs]\nurl='https://example.com/mcp'\n[mcp_servers.windows-ui]\ncommand='C:/managed/Sbroenne.WindowsMcp.exe'\nenabled_tools=['ui_find']\n[mcp_servers.windows-ui.env]\nLOCAL_MODE='1'\n").unwrap();
        let next = request(
            &doc,
            WindowsControlProvider::Cursortouch,
            "D:/Tools/Windows-MCP/.venv/Scripts/windows-mcp.exe",
        );
        switch_document(&mut doc, &next).unwrap();
        assert_eq!(inspect(&doc).provider, WindowsControlProvider::Cursortouch);
        assert!(doc["mcp_servers"][ACTIVE]["enabled_tools"]
            .as_array()
            .unwrap()
            .iter()
            .any(|v| v.as_str() == Some("Snapshot")));
        assert_eq!(
            doc["mcp_servers"]["threadfleet-windows-sbroenne"]["enabled"].as_bool(),
            Some(false)
        );
        let next = request(
            &doc,
            WindowsControlProvider::Sbroenne,
            "C:/managed/Sbroenne.WindowsMcp.exe",
        );
        switch_document(&mut doc, &next).unwrap();
        assert_eq!(
            doc["mcp_servers"][ACTIVE]["env"]["LOCAL_MODE"].as_str(),
            Some("1")
        );
        assert_eq!(
            doc["mcp_servers"][ACTIVE]["enabled_tools"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            doc["mcp_servers"]["docs"]["url"].as_str(),
            Some("https://example.com/mcp")
        );
        assert!(doc.to_string().contains("# keep"));
    }

    #[test]
    fn stale_request_and_invalid_command_leave_document_unchanged() {
        let mut doc = Document::new();
        let mut next = request(&doc, WindowsControlProvider::Cursortouch, "wrong.exe");
        assert!(switch_document(&mut doc, &next).is_err());
        assert!(doc.is_empty());
        next.command = "windows-mcp.exe".into();
        doc["mcp_servers"] = Item::Table(Table::new());
        doc["mcp_servers"][ACTIVE] = Item::Table(Table::new());
        doc["mcp_servers"][ACTIVE]["command"] = value("changed.exe");
        assert!(switch_document(&mut doc, &next).is_err());
        assert_eq!(
            doc["mcp_servers"][ACTIVE]["command"].as_str(),
            Some("changed.exe")
        );
    }

    #[test]
    fn unrelated_settings_changes_preserve_selection_revision_and_are_retained() {
        let mut doc = Document::new();
        let next = request(&doc, WindowsControlProvider::Cursortouch, "windows-mcp.exe");
        doc["personality"] = value("friendly");
        assert_eq!(next.revision, revision(&doc));
        switch_document(&mut doc, &next).unwrap();
        assert_eq!(doc["personality"].as_str(), Some("friendly"));
    }

    #[test]
    fn custom_profile_survives_switching_back_and_enabled_profile_conflicts_are_rejected() {
        let mut doc = config_toml_core::parse_document("[mcp_servers.windows-ui]\ncommand='custom.exe'\nargs=['--local']\n[mcp_servers.windows-ui.env]\nLOCAL_MODE='1'\n").unwrap();
        let next = request(&doc, WindowsControlProvider::Cursortouch, "windows-mcp.exe");
        switch_document(&mut doc, &next).unwrap();
        let next = request(&doc, WindowsControlProvider::Custom, "custom.exe");
        switch_document(&mut doc, &next).unwrap();
        assert_eq!(
            doc["mcp_servers"][ACTIVE]["env"]["LOCAL_MODE"].as_str(),
            Some("1")
        );
        doc["mcp_servers"]["threadfleet-windows-cursortouch"]["enabled"] = value(true);
        let next = request(&doc, WindowsControlProvider::Cursortouch, "windows-mcp.exe");
        assert!(switch_document(&mut doc, &next).is_err());
        assert_eq!(inspect(&doc).provider, WindowsControlProvider::Custom);
    }

    #[test]
    #[cfg(target_os = "windows")]
    fn persistence_round_trip_rejects_stale_disk_revisions() {
        let dir = std::env::temp_dir().join(format!("tf-windows-control-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("config.toml"), "model='original'").unwrap();
        let original = get_windows_control_mcp(&dir).unwrap();
        let input = SetWindowsControlMcpRequest {
            provider: WindowsControlProvider::Cursortouch,
            revision: original.revision,
            command: "windows-mcp.exe".into(),
            args: vec!["serve".into()],
        };
        let saved = set_windows_control_mcp(&dir, &input).unwrap();
        assert_eq!(
            saved.revision,
            get_windows_control_mcp(&dir).unwrap().revision
        );
        assert!(set_windows_control_mcp(&dir, &input).is_err());
        assert!(std::fs::read_to_string(dir.join("config.toml"))
            .unwrap()
            .contains("model='original'"));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn runtime_identity_uses_config_when_no_service_is_observed() {
        let config = serde_json::json!({"config":{"mcp_servers":{"windows-ui":{"command":"D:/Tools/Windows-MCP/.venv/Scripts/windows-mcp.exe", "args":["serve"]}}}});
        assert_eq!(
            expected_runtime_identity(Some(&config), None),
            Some("windows-mcp")
        );
        assert_eq!(
            expected_runtime_identity(None, None),
            Some("sbroenne.windows-mcp")
        );
        let custom =
            serde_json::json!({"config":{"mcp_servers":{"windows-ui":{"command":"custom.exe"}}}});
        assert_eq!(expected_runtime_identity(Some(&custom), None), None);
    }

    #[test]
    fn saving_another_provider_does_not_invalidate_the_running_provider() {
        use crate::shared::computer_control_core::{
            normalize_mcp_server_capability_with_identity, ComputerControlAvailability,
            McpServerStatusListResponse,
        };
        let config = serde_json::json!({"config":{"mcp_servers":{"windows-ui":{"command":"windows-mcp.exe"}}}});
        let status: McpServerStatusListResponse = serde_json::from_value(serde_json::json!({"data":[{"name":"windows-ui","authStatus":"unsupported","tools":{"ui_find":{}},"serverInfo":{"name":"sbroenne.windows-mcp","version":"1.3.18"}}]})).unwrap();
        let identity = expected_runtime_identity(Some(&config), Some(&status));
        assert_eq!(identity, Some("sbroenne.windows-mcp"));
        assert_eq!(
            normalize_mcp_server_capability_with_identity(Some(&status), false, ACTIVE, identity)
                .availability,
            ComputerControlAvailability::Ready
        );
    }
}
