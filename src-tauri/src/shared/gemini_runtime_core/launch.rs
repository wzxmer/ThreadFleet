use crate::shared::provider_profiles_core::{
    active_profile_runtime_fingerprint, effective_execution_profile,
};
use crate::types::{AppSettings, CodexKeyProfile};
use sha2::{Digest, Sha256};
use std::path::PathBuf;
use tokio::process::Command;

#[derive(Clone, Default)]
pub(crate) struct LaunchConfig {
    pub(super) bin: Option<String>,
    provider: Option<CodexKeyProfile>,
    provider_fingerprint: Option<String>,
}

impl From<Option<String>> for LaunchConfig {
    fn from(bin: Option<String>) -> Self {
        Self {
            bin,
            ..Default::default()
        }
    }
}

pub(super) struct SettingsFile(PathBuf);

impl Drop for SettingsFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

impl LaunchConfig {
    pub(crate) fn from_settings(settings: &AppSettings) -> Self {
        let provider = effective_execution_profile(settings)
            .filter(|profile| profile.provider_kind == "gemini");
        Self {
            bin: settings.gemini_bin.clone(),
            provider_fingerprint: provider
                .as_ref()
                .and_then(|_| active_profile_runtime_fingerprint(settings)),
            provider,
        }
    }

    pub(super) fn fingerprint(&self) -> String {
        let mut hasher = Sha256::new();
        hasher.update(self.bin.as_deref().unwrap_or_default());
        hasher.update(b"\0");
        hasher.update(self.provider_fingerprint.as_deref().unwrap_or("native"));
        format!("{:x}", hasher.finalize())
    }

    pub(super) fn model(&self) -> Option<&str> {
        self.provider
            .as_ref()
            .and_then(|profile| profile.model.as_deref())
            .map(str::trim)
            .filter(|model| !model.is_empty())
    }

    pub(super) fn apply(&self, command: &mut Command) -> Result<Option<SettingsFile>, String> {
        let Some(profile) = &self.provider else {
            return Ok(None);
        };
        let key = profile.key.trim();
        if key.is_empty() {
            return Err(
                "Gemini 服务商缺少 API 密钥，请在 TF 的服务商设置中填写并启用有效密钥。".into(),
            );
        }
        let base_url = profile
            .base_url
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty());
        let base_url = base_url.map(normalize_base_url).transpose()?;
        // Select API-key auth for this child only. No authenticate request is sent:
        // Gemini's ACP authenticate handler persists the user's auth selection.
        let path =
            std::env::temp_dir().join(format!("tf-gemini-auth-{}.json", uuid::Uuid::new_v4()));
        let settings_file = SettingsFile(path.clone());
        std::fs::write(
            &path,
            br#"{"security":{"auth":{"selectedType":"gemini-api-key"}}}"#,
        )
        .map_err(|_| "Cannot prepare Gemini runtime authentication settings".to_string())?;
        command.env("GEMINI_CLI_SYSTEM_SETTINGS_PATH", &path);
        command.env("GEMINI_API_KEY", key);
        command.env_remove("GOOGLE_API_KEY");
        command.env_remove("GOOGLE_GENAI_USE_VERTEXAI");
        command.env_remove("GOOGLE_GENAI_USE_GCA");
        if let Some(base_url) = base_url {
            command.env("GOOGLE_GEMINI_BASE_URL", base_url);
        } else {
            command.env_remove("GOOGLE_GEMINI_BASE_URL");
        }
        Ok(Some(settings_file))
    }
}

fn normalize_base_url(base_url: &str) -> Result<String, String> {
    let mut url = reqwest::Url::parse(base_url).map_err(|_| {
        "Gemini 服务商地址无效，请填写支持 Gemini 原生接口的 HTTP 或 HTTPS 地址。".to_string()
    })?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err("Gemini 服务商地址必须使用 HTTP 或 HTTPS。".into());
    }
    let path = url.path().trim_end_matches('/');
    let path = path
        .strip_suffix("/v1beta")
        .or_else(|| path.strip_suffix("/v1"))
        .unwrap_or(path)
        .to_string();
    url.set_path(&path);
    Ok(url.to_string().trim_end_matches('/').to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn settings(kind: &str) -> AppSettings {
        serde_json::from_value(json!({
            "activeCodexKeyProfileId": "relay",
            "codexKeyProfiles": [{
                "id":"relay", "name":"Relay", "providerKind":kind,
                "key":"test-key", "baseUrl":"https://relay.example/gemini/v1",
                "model":"gemini-test"
            }]
        }))
        .unwrap()
    }

    #[test]
    fn gemini_profile_sets_child_auth_and_preserves_native_settings() {
        let config = LaunchConfig::from_settings(&settings("gemini"));
        let mut command = Command::new("unused");
        let file = config.apply(&mut command).unwrap().unwrap();
        let env: std::collections::HashMap<_, _> = command
            .as_std()
            .get_envs()
            .map(|(key, value)| {
                (
                    key.to_string_lossy().into_owned(),
                    value.map(|value| value.to_string_lossy().into_owned()),
                )
            })
            .collect();
        assert_eq!(env["GEMINI_API_KEY"].as_deref(), Some("test-key"));
        assert_eq!(
            env["GOOGLE_GEMINI_BASE_URL"].as_deref(),
            Some("https://relay.example/gemini")
        );
        assert_eq!(env["GOOGLE_API_KEY"], None);
        assert_eq!(config.model(), Some("gemini-test"));
        let path = file.0.clone();
        let auth: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(
            auth,
            json!({"security":{"auth":{"selectedType":"gemini-api-key"}}})
        );
        drop(file);
        assert!(!path.exists());
    }

    #[test]
    fn codex_profile_leaves_gemini_native_auth_unchanged() {
        let config = LaunchConfig::from_settings(&settings("custom"));
        let mut command = Command::new("unused");
        assert!(config.apply(&mut command).unwrap().is_none());
        assert_eq!(command.as_std().get_envs().count(), 0);
        assert_eq!(config.model(), None);
    }

    #[test]
    fn changed_credentials_or_model_change_runtime_identity() {
        let mut settings = settings("gemini");
        let first = LaunchConfig::from_settings(&settings).fingerprint();
        settings.codex_key_profiles[0].key = "other-key".into();
        assert_ne!(first, LaunchConfig::from_settings(&settings).fingerprint());
        let second = LaunchConfig::from_settings(&settings).fingerprint();
        settings.codex_key_profiles[0].model = Some("other-model".into());
        assert_ne!(second, LaunchConfig::from_settings(&settings).fingerprint());
    }

    #[test]
    fn gemini_provider_cannot_be_used_as_a_codex_credential() {
        let settings = settings("gemini");
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let result = runtime.block_on(
            crate::shared::provider_profiles_core::active_codex_key_runtime(&settings, None),
        );
        assert!(matches!(result, Err(error) if error.contains("Gemini")));
        assert_eq!(
            crate::shared::provider_profiles_core::active_profile_codex_args(
                &settings,
                Some("--test".into())
            )
            .unwrap(),
            Some("--test".into())
        );
    }
}
