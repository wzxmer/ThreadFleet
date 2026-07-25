#![allow(dead_code)]

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use toml_edit::{value, Document, Item, Table};

use crate::shared::{config_toml_core, provider_profiles_core};
use crate::types::AppSettings;

const CODEX_MONITOR_PROVIDER_ID: &str = "codex_monitor";
const PROVIDER_SYNC_STATE_FILE: &str = ".codex-monitor-provider-sync-state.json";
const PROVIDER_SYNC_STATE_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ProviderConfigSyncOutcome {
    Disabled,
    NoActiveProfile,
    Updated,
    RestoredDefault,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProviderOwnedConfig {
    model_provider: Option<String>,
    model: Option<String>,
    model_context_window: Option<i64>,
    model_providers_present: bool,
    codex_monitor_provider_present: bool,
    provider_name: Option<String>,
    provider_base_url: Option<String>,
    provider_env_key: Option<String>,
    provider_wire_api: Option<String>,
    provider_requires_openai_auth: Option<bool>,
    provider_supports_websockets: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProviderConfigSyncState {
    version: u32,
    original: ProviderOwnedConfig,
    applied: ProviderOwnedConfig,
}

fn optional_string(item: Option<&Item>, path: &str) -> Result<Option<String>, String> {
    match item {
        None => Ok(None),
        Some(item) => item
            .as_str()
            .map(|value| Some(value.to_string()))
            .ok_or_else(|| format!("`{path}` must be a string in config.toml")),
    }
}

fn optional_integer(item: Option<&Item>, path: &str) -> Result<Option<i64>, String> {
    match item {
        None => Ok(None),
        Some(item) => item
            .as_integer()
            .map(Some)
            .ok_or_else(|| format!("`{path}` must be an integer in config.toml")),
    }
}

fn optional_bool(item: Option<&Item>, path: &str) -> Result<Option<bool>, String> {
    match item {
        None => Ok(None),
        Some(item) => item
            .as_bool()
            .map(Some)
            .ok_or_else(|| format!("`{path}` must be a boolean in config.toml")),
    }
}

impl ProviderOwnedConfig {
    fn capture(document: &Document) -> Result<Self, String> {
        let providers_item = document.get("model_providers");
        let providers =
            match providers_item {
                None => None,
                Some(item) => Some(item.as_table().ok_or_else(|| {
                    "`model_providers` must be a table in config.toml".to_string()
                })?),
            };
        let provider_item =
            providers.and_then(|providers| providers.get(CODEX_MONITOR_PROVIDER_ID));
        let provider = match provider_item {
            None => None,
            Some(item) => Some(item.as_table().ok_or_else(|| {
                format!(
                    "`model_providers.{CODEX_MONITOR_PROVIDER_ID}` must be a table in config.toml"
                )
            })?),
        };

        Ok(Self {
            model_provider: optional_string(document.get("model_provider"), "model_provider")?,
            model: optional_string(document.get("model"), "model")?,
            model_context_window: optional_integer(
                document.get("model_context_window"),
                "model_context_window",
            )?,
            model_providers_present: providers_item.is_some(),
            codex_monitor_provider_present: provider_item.is_some(),
            provider_name: optional_string(
                provider.and_then(|provider| provider.get("name")),
                "model_providers.codex_monitor.name",
            )?,
            provider_base_url: optional_string(
                provider.and_then(|provider| provider.get("base_url")),
                "model_providers.codex_monitor.base_url",
            )?,
            provider_env_key: optional_string(
                provider.and_then(|provider| provider.get("env_key")),
                "model_providers.codex_monitor.env_key",
            )?,
            provider_wire_api: optional_string(
                provider.and_then(|provider| provider.get("wire_api")),
                "model_providers.codex_monitor.wire_api",
            )?,
            provider_requires_openai_auth: optional_bool(
                provider.and_then(|provider| provider.get("requires_openai_auth")),
                "model_providers.codex_monitor.requires_openai_auth",
            )?,
            provider_supports_websockets: optional_bool(
                provider.and_then(|provider| provider.get("supports_websockets")),
                "model_providers.codex_monitor.supports_websockets",
            )?,
        })
    }

    fn restore_into(&self, document: &mut Document) -> Result<(), String> {
        set_optional_string(
            document.as_table_mut(),
            "model_provider",
            &self.model_provider,
        );
        set_optional_string(document.as_table_mut(), "model", &self.model);
        set_optional_integer(
            document.as_table_mut(),
            "model_context_window",
            self.model_context_window,
        );

        if document.get("model_providers").is_none()
            && (self.model_providers_present || self.codex_monitor_provider_present)
        {
            document["model_providers"] = Item::Table(Table::new());
        }

        let mut remove_providers = false;
        if let Some(providers_item) = document.get_mut("model_providers") {
            let providers = providers_item
                .as_table_mut()
                .ok_or_else(|| "`model_providers` must be a table in config.toml".to_string())?;
            if providers.get(CODEX_MONITOR_PROVIDER_ID).is_none()
                && self.codex_monitor_provider_present
            {
                providers[CODEX_MONITOR_PROVIDER_ID] = Item::Table(Table::new());
            }
            let mut remove_provider = false;
            if let Some(provider_item) = providers.get_mut(CODEX_MONITOR_PROVIDER_ID) {
                let provider = provider_item.as_table_mut().ok_or_else(|| {
                    format!(
                        "`model_providers.{CODEX_MONITOR_PROVIDER_ID}` must be a table in config.toml"
                    )
                })?;
                set_optional_string(provider, "name", &self.provider_name);
                set_optional_string(provider, "base_url", &self.provider_base_url);
                set_optional_string(provider, "env_key", &self.provider_env_key);
                set_optional_string(provider, "wire_api", &self.provider_wire_api);
                set_optional_bool(
                    provider,
                    "requires_openai_auth",
                    self.provider_requires_openai_auth,
                );
                set_optional_bool(
                    provider,
                    "supports_websockets",
                    self.provider_supports_websockets,
                );
                remove_provider = !self.codex_monitor_provider_present && provider.is_empty();
            }
            if remove_provider {
                let _ = providers.remove(CODEX_MONITOR_PROVIDER_ID);
            }
            remove_providers = !self.model_providers_present && providers.is_empty();
        }
        if remove_providers {
            let _ = document.remove("model_providers");
        }
        Ok(())
    }
}

fn set_optional_string(table: &mut Table, key: &str, value_raw: &Option<String>) {
    match value_raw {
        Some(value_raw) => table[key] = value(value_raw.as_str()),
        None => {
            let _ = table.remove(key);
        }
    }
}

fn set_optional_integer(table: &mut Table, key: &str, value_raw: Option<i64>) {
    match value_raw {
        Some(value_raw) => table[key] = value(value_raw),
        None => {
            let _ = table.remove(key);
        }
    }
}

fn set_optional_bool(table: &mut Table, key: &str, value_raw: Option<bool>) {
    match value_raw {
        Some(value_raw) => table[key] = value(value_raw),
        None => {
            let _ = table.remove(key);
        }
    }
}

pub(crate) fn apply_active_provider_profile(
    document: &mut Document,
    settings: &AppSettings,
) -> Result<ProviderConfigSyncOutcome, String> {
    if !settings.sync_provider_profile_to_local_config {
        return Ok(ProviderConfigSyncOutcome::Disabled);
    }
    let Some(active_id) = settings
        .active_codex_key_profile_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return Ok(ProviderConfigSyncOutcome::NoActiveProfile);
    };
    let profile = settings
        .codex_key_profiles
        .iter()
        .find(|profile| profile.id.trim() == active_id)
        .ok_or_else(|| format!("Active Provider profile `{active_id}` was not found"))?;
    if profile.key.trim().is_empty() {
        return Err("Active Provider profiles require a non-empty API key".to_string());
    }
    if provider_profiles_core::profile_uses_gateway(profile) {
        return Err(
            "Provider profiles that require the compatibility gateway cannot be written to config.toml"
                .to_string(),
        );
    }
    let base_url = provider_profiles_core::resolve_profile_base_url(profile)
        .ok_or_else(|| "Provider profiles require a provider base URL".to_string())?;
    let key_env_var = profile.key_env_var.trim();
    if key_env_var.is_empty() {
        return Err("Provider profiles require a non-empty key environment variable".to_string());
    }
    let model = profile
        .model
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());

    let mut updated = document.clone();
    config_toml_core::set_top_level_string(
        &mut updated,
        "model_provider",
        Some(CODEX_MONITOR_PROVIDER_ID),
    );
    if let Some(model) = model {
        config_toml_core::set_top_level_string(&mut updated, "model", Some(model));
    }
    if let Some(context_window) = profile.context_window.filter(|value| *value > 0) {
        config_toml_core::set_top_level_positive_integer(
            &mut updated,
            "model_context_window",
            Some(context_window),
        )?;
    }

    let providers = config_toml_core::ensure_table(&mut updated, "model_providers")?;
    if providers.get(CODEX_MONITOR_PROVIDER_ID).is_none() {
        providers[CODEX_MONITOR_PROVIDER_ID] = Item::Table(Table::new());
    }
    let provider = providers[CODEX_MONITOR_PROVIDER_ID]
        .as_table_mut()
        .ok_or_else(|| {
            format!("`model_providers.{CODEX_MONITOR_PROVIDER_ID}` must be a table in config.toml")
        })?;
    provider["name"] = value("ThreadFleet");
    provider["base_url"] = value(base_url);
    provider["env_key"] = value(key_env_var);
    provider["wire_api"] = value("responses");
    provider["requires_openai_auth"] = value(false);
    provider["supports_websockets"] = value(false);

    *document = updated;
    Ok(ProviderConfigSyncOutcome::Updated)
}

fn provider_sync_state_path(codex_home: &Path) -> PathBuf {
    codex_home.join(PROVIDER_SYNC_STATE_FILE)
}

fn load_provider_sync_state(codex_home: &Path) -> Result<Option<ProviderConfigSyncState>, String> {
    let path = provider_sync_state_path(codex_home);
    let contents = match fs::read_to_string(&path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(format!(
                "Failed to read Provider config sync state: {error}"
            ))
        }
    };
    let state: ProviderConfigSyncState = serde_json::from_str(&contents)
        .map_err(|error| format!("Failed to parse Provider config sync state: {error}"))?;
    if state.version != PROVIDER_SYNC_STATE_VERSION {
        return Err(format!(
            "Unsupported Provider config sync state version: {}",
            state.version
        ));
    }
    Ok(Some(state))
}

fn write_provider_sync_state(
    codex_home: &Path,
    state: &ProviderConfigSyncState,
) -> Result<(), String> {
    fs::create_dir_all(codex_home)
        .map_err(|error| format!("Failed to prepare Provider config sync state: {error}"))?;
    let path = provider_sync_state_path(codex_home);
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| format!("Failed to timestamp Provider config sync state: {error}"))?
        .as_nanos();
    let temp_path = codex_home.join(format!(
        "{PROVIDER_SYNC_STATE_FILE}.tmp-{}-{nonce}",
        std::process::id()
    ));
    let backup_path = codex_home.join(format!(
        "{PROVIDER_SYNC_STATE_FILE}.bak-{}-{nonce}",
        std::process::id()
    ));
    let rendered = serde_json::to_vec_pretty(state)
        .map_err(|error| format!("Failed to serialize Provider config sync state: {error}"))?;

    let write_result = (|| -> Result<(), String> {
        let mut file = fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temp_path)
            .map_err(|error| format!("Failed to create Provider config sync state: {error}"))?;
        file.write_all(&rendered)
            .map_err(|error| format!("Failed to write Provider config sync state: {error}"))?;
        file.sync_all()
            .map_err(|error| format!("Failed to flush Provider config sync state: {error}"))?;

        let had_previous = path.exists();
        if had_previous {
            fs::rename(&path, &backup_path).map_err(|error| {
                format!("Failed to stage previous Provider config sync state: {error}")
            })?;
        }
        if let Err(error) = fs::rename(&temp_path, &path) {
            if had_previous {
                let _ = fs::rename(&backup_path, &path);
            }
            return Err(format!(
                "Failed to replace Provider config sync state: {error}"
            ));
        }
        if had_previous {
            fs::remove_file(&backup_path).map_err(|error| {
                format!("Failed to remove previous Provider config sync state: {error}")
            })?;
        }
        Ok(())
    })();

    if temp_path.exists() {
        let _ = fs::remove_file(&temp_path);
    }
    if backup_path.exists() && !path.exists() {
        let _ = fs::rename(&backup_path, &path);
    }
    write_result
}

fn remove_provider_sync_state(codex_home: &Path) -> Result<(), String> {
    match fs::remove_file(provider_sync_state_path(codex_home)) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!(
            "Failed to remove Provider config sync state: {error}"
        )),
    }
}

fn ensure_sync_state_matches_current(
    state: &ProviderConfigSyncState,
    current: &ProviderOwnedConfig,
) -> Result<(), String> {
    if current == &state.applied || current == &state.original {
        return Ok(());
    }
    Err(
        "Provider-owned config.toml fields changed outside ThreadFleet; refusing to overwrite them"
            .to_string(),
    )
}

pub(crate) fn sync_active_provider_profile_to_local_config(
    codex_home: &Path,
    settings: &AppSettings,
) -> Result<ProviderConfigSyncOutcome, String> {
    let existing_state = load_provider_sync_state(codex_home)?;
    if !settings.sync_provider_profile_to_local_config && existing_state.is_none() {
        return Ok(ProviderConfigSyncOutcome::Disabled);
    }
    let has_active_profile = settings
        .active_codex_key_profile_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .is_some();

    let snapshot = config_toml_core::load_global_config_snapshot(codex_home)?;
    let current = ProviderOwnedConfig::capture(&snapshot.document)?;

    if !settings.sync_provider_profile_to_local_config || !has_active_profile {
        let Some(state) = existing_state else {
            return Ok(ProviderConfigSyncOutcome::NoActiveProfile);
        };
        if ensure_sync_state_matches_current(&state, &current).is_err() {
            remove_provider_sync_state(codex_home)?;
            return Ok(if settings.sync_provider_profile_to_local_config {
                ProviderConfigSyncOutcome::NoActiveProfile
            } else {
                ProviderConfigSyncOutcome::Disabled
            });
        }
        let mut document = snapshot.document.clone();
        state.original.restore_into(&mut document)?;
        config_toml_core::persist_global_config_document_if_unchanged(
            codex_home, &snapshot, &document,
        )?;
        remove_provider_sync_state(codex_home)?;
        return Ok(ProviderConfigSyncOutcome::RestoredDefault);
    }

    let original = if let Some(state) = existing_state.as_ref() {
        ensure_sync_state_matches_current(state, &current)?;
        state.original.clone()
    } else {
        current
    };
    let mut document = snapshot.document.clone();
    original.restore_into(&mut document)?;
    let outcome = apply_active_provider_profile(&mut document, settings)?;
    if outcome == ProviderConfigSyncOutcome::Updated {
        let applied = ProviderOwnedConfig::capture(&document)?;
        write_provider_sync_state(
            codex_home,
            &ProviderConfigSyncState {
                version: PROVIDER_SYNC_STATE_VERSION,
                original,
                applied,
            },
        )?;
        config_toml_core::persist_global_config_document_if_unchanged(
            codex_home, &snapshot, &document,
        )?;
    }
    Ok(outcome)
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::PathBuf;

    use toml_edit::Document;
    use uuid::Uuid;

    use super::*;
    use crate::shared::config_toml_core;
    use crate::types::CodexKeyProfile;

    fn temp_dir(prefix: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "codex-monitor-provider-config-{prefix}-{}",
            Uuid::new_v4()
        ));
        if dir.exists() {
            let _ = fs::remove_dir_all(&dir);
        }
        fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    fn profile(use_gateway: bool) -> CodexKeyProfile {
        CodexKeyProfile {
            id: "company".to_string(),
            name: "Company".to_string(),
            provider_kind: "custom".to_string(),
            usage_protocol: "auto".to_string(),
            new_api_access_token: None,
            key_env_var: "COMPANY_API_KEY".to_string(),
            key: "super-secret-provider-key".to_string(),
            base_url_env_var: "COMPANY_BASE_URL".to_string(),
            base_url: Some("https://api.example.com/v1".to_string()),
            model: Some("company-model".to_string()),
            context_window: Some(131_072),
            max_output_tokens: Some(8_192),
            use_gateway,
            supports_thinking: true,
            supports_reasoning_effort: true,
            last_model_refresh_at_ms: None,
            cached_models: Vec::new(),
            group_name: None,
        }
    }

    fn enabled_settings(use_gateway: bool) -> AppSettings {
        let mut settings = AppSettings::default();
        settings.sync_provider_profile_to_local_config = true;
        settings.codex_key_profiles = vec![profile(use_gateway)];
        settings.active_codex_key_profile_id = Some("company".to_string());
        settings
    }

    #[test]
    fn applies_owned_fields_without_losing_unrelated_toml_or_secrets() {
        let mut document: Document = r#"# keep this comment
approval_policy = "never"
model = "old-model"
model_context_window = 4096

[agents]
native_markdown_imported = true

[model_providers.other]
name = "Other"
base_url = "https://other.example/v1"

[model_providers.codex_monitor]
custom_field = "keep-me"
base_url = "https://old.example/v1"
"#
        .parse()
        .expect("parse fixture");

        let outcome = apply_active_provider_profile(&mut document, &enabled_settings(false))
            .expect("apply provider profile");
        let rendered = document.to_string();

        assert_eq!(outcome, ProviderConfigSyncOutcome::Updated);
        assert!(rendered.contains("# keep this comment"));
        assert!(rendered.contains("approval_policy = \"never\""));
        assert!(rendered.contains("native_markdown_imported = true"));
        assert!(rendered.contains("[model_providers.other]"));
        assert!(rendered.contains("custom_field = \"keep-me\""));
        assert!(rendered.contains("model_provider = \"codex_monitor\""));
        assert!(rendered.contains("model = \"company-model\""));
        assert!(rendered.contains("model_context_window = 131072"));
        assert!(rendered.contains("base_url = \"https://api.example.com/v1\""));
        assert!(rendered.contains("env_key = \"COMPANY_API_KEY\""));
        assert!(!rendered.contains("super-secret-provider-key"));
    }

    #[test]
    fn disabled_or_missing_active_profile_is_a_noop() {
        let original = "model = \"existing\"\n";
        let mut disabled = AppSettings::default();
        disabled.codex_key_profiles = vec![profile(false)];
        disabled.active_codex_key_profile_id = Some("company".to_string());
        let mut document = original.parse::<Document>().expect("parse");

        assert_eq!(
            apply_active_provider_profile(&mut document, &disabled).expect("disabled no-op"),
            ProviderConfigSyncOutcome::Disabled
        );
        assert_eq!(document.to_string(), original);

        let mut no_active = enabled_settings(false);
        no_active.active_codex_key_profile_id = None;
        assert_eq!(
            apply_active_provider_profile(&mut document, &no_active).expect("missing no-op"),
            ProviderConfigSyncOutcome::NoActiveProfile
        );
        assert_eq!(document.to_string(), original);
    }

    #[test]
    fn gateway_profile_is_rejected_without_mutating_document() {
        let original = "model = \"existing\"\n";
        let mut document = original.parse::<Document>().expect("parse");

        let error = apply_active_provider_profile(&mut document, &enabled_settings(true))
            .expect_err("gateway config must not be persisted");

        assert!(error.contains("gateway"));
        assert_eq!(document.to_string(), original);
    }

    #[test]
    fn opencode_profile_is_rejected_even_when_gateway_flag_is_false() {
        let original = "model = \"existing\"\n";
        let mut document = original.parse::<Document>().expect("parse");
        let mut settings = enabled_settings(false);
        settings.codex_key_profiles[0].provider_kind = "opencode".to_string();

        let error = apply_active_provider_profile(&mut document, &settings)
            .expect_err("OpenCode requires the compatibility gateway");

        assert!(error.contains("gateway"));
        assert_eq!(document.to_string(), original);
    }

    #[test]
    fn invalid_active_profile_is_rejected_without_mutating_document() {
        let original = "model = \"existing\"\n";
        for mutate in ["empty-key", "missing-base-url", "invalid-provider-table"] {
            let mut document = if mutate == "invalid-provider-table" {
                "model_providers = \"invalid\"\n"
                    .parse::<Document>()
                    .expect("parse invalid table fixture")
            } else {
                original.parse::<Document>().expect("parse")
            };
            let before = document.to_string();
            let mut settings = enabled_settings(false);
            match mutate {
                "empty-key" => settings.codex_key_profiles[0].key.clear(),
                "missing-base-url" => settings.codex_key_profiles[0].base_url = None,
                "invalid-provider-table" => {}
                _ => unreachable!(),
            }

            apply_active_provider_profile(&mut document, &settings)
                .expect_err("invalid profile or document must fail");
            assert_eq!(document.to_string(), before, "fixture: {mutate}");
        }
    }

    #[test]
    fn absent_optional_model_fields_preserve_existing_config_values() {
        let original = "model = \"user-model\"\nmodel_context_window = 65536\n";
        let mut document = original.parse::<Document>().expect("parse");
        let mut settings = enabled_settings(false);
        settings.codex_key_profiles[0].model = None;
        settings.codex_key_profiles[0].context_window = None;

        apply_active_provider_profile(&mut document, &settings).expect("apply profile");

        let rendered = document.to_string();
        assert!(rendered.contains("model = \"user-model\""));
        assert!(rendered.contains("model_context_window = 65536"));
    }

    #[test]
    fn concurrent_external_change_is_not_overwritten() {
        let codex_home = temp_dir("conflict");
        let config_path = codex_home.join("config.toml");
        fs::write(&config_path, "approval_policy = \"never\"\n").expect("seed config");
        let snapshot =
            config_toml_core::load_global_config_snapshot(&codex_home).expect("load snapshot");
        let mut document = snapshot.document.clone();
        apply_active_provider_profile(&mut document, &enabled_settings(false))
            .expect("apply provider profile");
        fs::write(&config_path, "approval_policy = \"on-request\"\n").expect("external edit");

        let error = config_toml_core::persist_global_config_document_if_unchanged(
            &codex_home,
            &snapshot,
            &document,
        )
        .expect_err("conflict must stop persistence");

        assert!(error.contains("changed since it was read"));
        assert_eq!(
            fs::read_to_string(&config_path).expect("read external config"),
            "approval_policy = \"on-request\"\n"
        );
        let _ = fs::remove_dir_all(codex_home);
    }

    #[test]
    fn successful_sync_uses_atomic_path_and_leaves_no_temp_file() {
        let codex_home = temp_dir("success");
        let config_path = codex_home.join("config.toml");
        fs::write(&config_path, "approval_policy = \"never\"\n").expect("seed config");

        let outcome =
            sync_active_provider_profile_to_local_config(&codex_home, &enabled_settings(false))
                .expect("sync config");

        assert_eq!(outcome, ProviderConfigSyncOutcome::Updated);
        let rendered = fs::read_to_string(&config_path).expect("read config");
        assert!(rendered.contains("approval_policy = \"never\""));
        assert!(rendered.contains("model_provider = \"codex_monitor\""));
        assert!(!rendered.contains("super-secret-provider-key"));
        let sync_state = fs::read_to_string(provider_sync_state_path(&codex_home))
            .expect("read Provider sync state");
        assert!(!sync_state.contains("super-secret-provider-key"));
        let mut files = fs::read_dir(&codex_home)
            .expect("read config dir")
            .map(|entry| entry.expect("entry").file_name())
            .collect::<Vec<_>>();
        files.sort();
        assert_eq!(
            files,
            vec![
                std::ffi::OsString::from(PROVIDER_SYNC_STATE_FILE),
                std::ffi::OsString::from("config.toml"),
            ]
        );
        let _ = fs::remove_dir_all(codex_home);
    }

    #[test]
    fn sync_creates_missing_config_and_is_idempotent() {
        let codex_home = temp_dir("missing");
        let settings = enabled_settings(false);

        sync_active_provider_profile_to_local_config(&codex_home, &settings)
            .expect("create config");
        let first = fs::read(codex_home.join("config.toml")).expect("read first config");
        sync_active_provider_profile_to_local_config(&codex_home, &settings).expect("repeat sync");
        let second = fs::read(codex_home.join("config.toml")).expect("read second config");

        assert_eq!(second, first);
        let _ = fs::remove_dir_all(codex_home);
    }

    #[test]
    fn switching_back_to_default_restores_original_provider_fields() {
        let codex_home = temp_dir("restore-default");
        let config_path = codex_home.join("config.toml");
        let original = r#"model_provider = "codex_local_access"
model = "gpt-default"
model_context_window = 65536
approval_policy = "never"

[model_providers.codex_local_access]
name = "Local access"
base_url = "http://127.0.0.1:1455/v1"
wire_api = "responses"
"#;
        fs::write(&config_path, original).expect("seed default config");

        let profile_settings = enabled_settings(false);
        sync_active_provider_profile_to_local_config(&codex_home, &profile_settings)
            .expect("sync active profile");

        let mut default_settings = profile_settings;
        default_settings.active_codex_key_profile_id = None;
        sync_active_provider_profile_to_local_config(&codex_home, &default_settings)
            .expect("restore default provider");

        let restored = fs::read_to_string(&config_path).expect("read restored config");
        assert_eq!(restored, original);
        assert!(!provider_sync_state_path(&codex_home).exists());
        let _ = fs::remove_dir_all(codex_home);
    }

    #[test]
    fn restoring_default_preserves_unrelated_external_config_edits() {
        let codex_home = temp_dir("restore-default-external-unrelated");
        let config_path = codex_home.join("config.toml");
        fs::write(
            &config_path,
            "model_provider = \"codex_local_access\"\napproval_policy = \"never\"\n",
        )
        .expect("seed default config");

        let profile_settings = enabled_settings(false);
        sync_active_provider_profile_to_local_config(&codex_home, &profile_settings)
            .expect("sync active profile");
        let mut externally_edited = fs::read_to_string(&config_path).expect("read synced config");
        externally_edited.push_str("\n[features]\nshell_tool = true\n");
        fs::write(&config_path, externally_edited).expect("write unrelated external edit");

        let mut default_settings = profile_settings;
        default_settings.active_codex_key_profile_id = None;
        sync_active_provider_profile_to_local_config(&codex_home, &default_settings)
            .expect("restore default provider");

        let restored = fs::read_to_string(&config_path).expect("read restored config");
        assert!(restored.contains("model_provider = \"codex_local_access\""));
        assert!(restored.contains("approval_policy = \"never\""));
        assert!(restored.contains("[features]"));
        assert!(restored.contains("shell_tool = true"));
        assert!(!restored.contains("[model_providers.codex_monitor]"));
        let _ = fs::remove_dir_all(codex_home);
    }

    #[test]
    fn restoring_default_relinquishes_external_edits_without_overwriting_them() {
        let codex_home = temp_dir("restore-default-external-owned");
        let config_path = codex_home.join("config.toml");
        fs::write(&config_path, "model_provider = \"codex_local_access\"\n")
            .expect("seed default config");

        let profile_settings = enabled_settings(false);
        sync_active_provider_profile_to_local_config(&codex_home, &profile_settings)
            .expect("sync active profile");
        let externally_edited = fs::read_to_string(&config_path)
            .expect("read synced config")
            .replace("model = \"company-model\"", "model = \"external-model\"");
        fs::write(&config_path, &externally_edited).expect("write owned external edit");

        let mut default_settings = profile_settings;
        default_settings.active_codex_key_profile_id = None;
        let outcome = sync_active_provider_profile_to_local_config(&codex_home, &default_settings)
            .expect("external Provider config must remain authoritative");

        assert_eq!(outcome, ProviderConfigSyncOutcome::NoActiveProfile);
        assert_eq!(
            fs::read_to_string(&config_path).expect("read preserved external config"),
            externally_edited
        );
        assert!(!provider_sync_state_path(&codex_home).exists());
        let _ = fs::remove_dir_all(codex_home);
    }

    #[test]
    fn turning_sync_off_restores_original_provider_fields() {
        let codex_home = temp_dir("disable-sync-restores");
        let config_path = codex_home.join("config.toml");
        let original = "model_provider = \"codex_local_access\"\nmodel = \"gpt-default\"\n";
        fs::write(&config_path, original).expect("seed default config");

        let mut settings = enabled_settings(false);
        sync_active_provider_profile_to_local_config(&codex_home, &settings)
            .expect("sync active profile");
        settings.sync_provider_profile_to_local_config = false;

        let outcome = sync_active_provider_profile_to_local_config(&codex_home, &settings)
            .expect("disable sync and restore default config");

        assert_eq!(outcome, ProviderConfigSyncOutcome::RestoredDefault);
        assert_eq!(
            fs::read_to_string(&config_path).expect("read restored config"),
            original
        );
        assert!(!provider_sync_state_path(&codex_home).exists());
        let _ = fs::remove_dir_all(codex_home);
    }

    #[test]
    fn switching_profiles_reapplies_optional_fields_from_original_baseline() {
        let codex_home = temp_dir("switch-profile-baseline");
        let config_path = codex_home.join("config.toml");
        fs::write(
            &config_path,
            "model_provider = \"codex_local_access\"\nmodel = \"gpt-default\"\nmodel_context_window = 65536\n",
        )
        .expect("seed default config");

        let mut settings = enabled_settings(false);
        sync_active_provider_profile_to_local_config(&codex_home, &settings)
            .expect("sync first profile");
        settings.codex_key_profiles[0].base_url = Some("https://second.example.com/v1".to_string());
        settings.codex_key_profiles[0].model = None;
        settings.codex_key_profiles[0].context_window = None;

        sync_active_provider_profile_to_local_config(&codex_home, &settings)
            .expect("sync second profile");

        let rendered = fs::read_to_string(&config_path).expect("read second profile config");
        assert!(rendered.contains("model = \"gpt-default\""));
        assert!(rendered.contains("model_context_window = 65536"));
        assert!(rendered.contains("base_url = \"https://second.example.com/v1\""));
        let _ = fs::remove_dir_all(codex_home);
    }
}
