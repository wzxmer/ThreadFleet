use serde_json::json;
use tauri::{Manager, State, Window};

use crate::remote_backend;
use crate::shared::agents_config_core;
use crate::shared::settings_core::{
    get_app_settings_core, get_codex_config_path_core, get_codex_status_core,
    get_codex_sync_diagnostics_core, update_app_settings_core, CodexStatusDto,
    CodexSyncDiagnosticsDto,
};
use crate::state::AppState;
use crate::types::{AppSettings, BackendMode};
use crate::window;

#[tauri::command]
pub(crate) async fn get_app_settings(
    state: State<'_, AppState>,
    window: Window,
) -> Result<AppSettings, String> {
    let settings = get_app_settings_core(&state.app_settings, &state.settings_path).await;
    let _ = window::apply_window_appearance(&window, settings.theme.as_str());
    Ok(settings)
}

#[tauri::command]
pub(crate) async fn update_app_settings(
    settings: AppSettings,
    state: State<'_, AppState>,
    window: Window,
) -> Result<AppSettings, String> {
    let previous = state.app_settings.lock().await.clone();
    if should_sync_remote_app_settings(&previous, &settings) {
        remote_backend::call_remote(
            &*state,
            window.app_handle().clone(),
            "update_app_settings",
            json!({ "settings": settings.clone() }),
        )
        .await?;
    }
    let updated =
        update_app_settings_core(settings, &state.app_settings, &state.settings_path).await?;
    if let Err(error) =
        agents_config_core::remove_legacy_native_markdown_import_flag_for_settings(&updated)
    {
        eprintln!("update_app_settings: failed to remove legacy agent import marker: {error}");
    }
    if should_reset_remote_backend(&previous, &updated) {
        *state.remote_backend.lock().await = None;
    }
    ensure_remote_runtime_for_settings(&updated, state).await;
    crate::files::attachments::allow_attachment_asset_scope(window.app_handle(), &updated)
        .map_err(|error| format!("Failed to allow attachment previews: {error}"))?;
    let _ = window::apply_window_appearance(&window, updated.theme.as_str());
    Ok(updated)
}

#[tauri::command]
pub(crate) async fn get_codex_config_path(state: State<'_, AppState>) -> Result<String, String> {
    let settings = state.app_settings.lock().await.clone();
    get_codex_config_path_core(&settings)
}

#[tauri::command]
pub(crate) async fn get_codex_status(state: State<'_, AppState>) -> Result<CodexStatusDto, String> {
    let settings = state.app_settings.lock().await.clone();
    Ok(get_codex_status_core(&settings))
}

#[tauri::command]
pub(crate) async fn get_codex_sync_diagnostics(
    state: State<'_, AppState>,
) -> Result<CodexSyncDiagnosticsDto, String> {
    let settings = state.app_settings.lock().await.clone();
    Ok(get_codex_sync_diagnostics_core(&settings))
}

fn should_reset_remote_backend(previous: &AppSettings, updated: &AppSettings) -> bool {
    let backend_mode_changed = !matches!(
        (&previous.backend_mode, &updated.backend_mode),
        (
            crate::types::BackendMode::Local,
            crate::types::BackendMode::Local
        ) | (
            crate::types::BackendMode::Remote,
            crate::types::BackendMode::Remote
        )
    );
    backend_mode_changed
        || previous.remote_backend_provider != updated.remote_backend_provider
        || previous.remote_backend_host != updated.remote_backend_host
        || previous.remote_backend_token != updated.remote_backend_token
}

fn should_sync_remote_app_settings(previous: &AppSettings, updated: &AppSettings) -> bool {
    matches!(
        (&previous.backend_mode, &updated.backend_mode),
        (BackendMode::Remote, BackendMode::Remote)
    ) && !should_reset_remote_backend(previous, updated)
}

async fn ensure_remote_runtime_for_settings(settings: &AppSettings, state: State<'_, AppState>) {
    if cfg!(any(target_os = "android", target_os = "ios")) {
        return;
    }
    if !matches!(settings.backend_mode, BackendMode::Remote) {
        return;
    }

    let _ = crate::tailscale::tailscale_daemon_start(state).await;
}

#[cfg(test)]
mod tests {
    use super::{should_reset_remote_backend, should_sync_remote_app_settings};
    use crate::types::{AppSettings, BackendMode, CodexKeyProfile};

    #[test]
    fn should_reset_remote_backend_when_provider_changes() {
        let previous = AppSettings::default();
        let mut updated = previous.clone();
        updated.remote_backend_provider = crate::types::RemoteBackendProvider::Tcp;
        updated.remote_backend_host = "remote.example:4732".to_string();
        assert!(should_reset_remote_backend(&previous, &updated));
    }

    #[test]
    fn should_reset_remote_backend_when_transport_token_changes() {
        let previous = AppSettings::default();
        let mut updated = previous.clone();
        updated.remote_backend_token = Some("token-1".to_string());
        assert!(should_reset_remote_backend(&previous, &updated));
    }

    #[test]
    fn should_not_reset_remote_backend_for_non_transport_setting_changes() {
        let previous = AppSettings::default();
        let mut updated = previous.clone();
        updated.theme = "dark".to_string();
        updated.backend_mode = BackendMode::Local;
        assert!(!should_reset_remote_backend(&previous, &updated));
    }

    #[test]
    fn should_sync_remote_app_settings_for_provider_profile_changes() {
        let mut previous = AppSettings::default();
        previous.backend_mode = BackendMode::Remote;
        previous.codex_key_profiles = vec![CodexKeyProfile {
            id: "provider-a".to_string(),
            name: "Provider A".to_string(),
            provider_kind: "custom".to_string(),
            usage_protocol: "auto".to_string(),
            new_api_access_token: None,
            key_env_var: "OPENAI_API_KEY".to_string(),
            key: "sk-old".to_string(),
            base_url_env_var: "OPENAI_BASE_URL".to_string(),
            base_url: Some("https://api.example.com/v1".to_string()),
            model: Some("model-a".to_string()),
            context_window: None,
            max_output_tokens: None,
            use_gateway: false,
            transport_mode: "auto".to_string(),
            supports_thinking: false,
            supports_reasoning_effort: false,
            last_model_refresh_at_ms: None,
            cached_models: Vec::new(),
            group_name: None,
        }];
        previous.active_codex_key_profile_id = Some("provider-a".to_string());
        let mut updated = previous.clone();
        updated.codex_key_profiles[0].key = "sk-new".to_string();

        assert!(should_sync_remote_app_settings(&previous, &updated));
    }

    #[test]
    fn should_not_sync_remote_app_settings_when_transport_changes() {
        let mut previous = AppSettings::default();
        previous.backend_mode = BackendMode::Remote;
        previous.remote_backend_host = "old.example:4732".to_string();
        let mut updated = previous.clone();
        updated.remote_backend_host = "new.example:4732".to_string();

        assert!(!should_sync_remote_app_settings(&previous, &updated));
    }
}
