use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tokio::sync::Mutex;

use crate::codex::config as codex_config;
use crate::codex::home as codex_home;
use crate::shared::provider_profiles_core::migrate_provider_settings;
use crate::shared::session_manager_core::sources::reconcile_session_sources;
use crate::storage::write_settings;
use crate::types::AppSettings;
use crate::utils::normalize_windows_namespace_path;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CodexStatusDto {
    pub(crate) codex_home_path: Option<String>,
    pub(crate) codex_home_source: String,
    pub(crate) config_path: Option<String>,
    pub(crate) config_exists: bool,
    pub(crate) global_agents_path: Option<String>,
    pub(crate) global_agents_exists: bool,
    pub(crate) codex_skills_path: Option<String>,
    pub(crate) codex_skills_count: usize,
    pub(crate) agents_skills_path: Option<String>,
    pub(crate) agents_skills_count: usize,
    pub(crate) model: Option<String>,
    pub(crate) model_error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CodexSyncDiagnosticsDto {
    pub(crate) username: Option<String>,
    pub(crate) user_profile: Option<String>,
    pub(crate) codex_home_path: Option<String>,
    pub(crate) codex_home_source: String,
    pub(crate) default_codex_home_path: Option<String>,
    pub(crate) shares_default_codex_sessions: Option<bool>,
    pub(crate) sessions_path: Option<String>,
    pub(crate) sessions_exists: bool,
    pub(crate) session_file_count: usize,
    pub(crate) latest_session_path: Option<String>,
    pub(crate) latest_session_modified_ms: Option<u64>,
}

fn normalize_personality(value: &str) -> Option<&'static str> {
    match value.trim() {
        "friendly" => Some("friendly"),
        "pragmatic" => Some("pragmatic"),
        _ => None,
    }
}

pub(crate) async fn get_app_settings_core(
    app_settings: &Mutex<AppSettings>,
    settings_path: &PathBuf,
) -> AppSettings {
    let mut settings = app_settings.lock().await.clone();
    let provider_settings_changed = migrate_provider_settings(&mut settings);
    let sources_changed = reconcile_settings_session_sources(&mut settings);
    if let Ok(Some(collaboration_modes_enabled)) =
        codex_config::read_collaboration_modes_enabled(&settings)
    {
        settings.collaboration_modes_enabled = collaboration_modes_enabled;
    }
    if let Ok(Some(steer_enabled)) = codex_config::read_steer_enabled(&settings) {
        settings.steer_enabled = steer_enabled;
    }
    if let Ok(Some(unified_exec_enabled)) = codex_config::read_unified_exec_enabled(&settings) {
        settings.unified_exec_enabled = unified_exec_enabled;
    }
    if let Ok(Some(apps_enabled)) = codex_config::read_apps_enabled(&settings) {
        settings.experimental_apps_enabled = apps_enabled;
    }
    if let Ok(personality) = codex_config::read_personality(&settings) {
        settings.personality = personality
            .as_deref()
            .and_then(normalize_personality)
            .unwrap_or("friendly")
            .to_string();
    }
    if let Ok(tool_output_token_limit) = codex_config::read_tool_output_token_limit(&settings) {
        settings.tool_output_token_limit = tool_output_token_limit;
    }
    if sources_changed || provider_settings_changed {
        if let Err(error) = write_settings(settings_path, &settings) {
            eprintln!("get_app_settings_core: failed to persist normalized settings: {error}");
        } else {
            *app_settings.lock().await = settings.clone();
        }
    }
    settings
}

pub(crate) async fn update_app_settings_core(
    mut settings: AppSettings,
    app_settings: &Mutex<AppSettings>,
    settings_path: &PathBuf,
) -> Result<AppSettings, String> {
    settings.global_worktrees_folder = settings
        .global_worktrees_folder
        .map(|path| normalize_windows_namespace_path(&path));
    settings.tool_output_token_limit = settings.tool_output_token_limit.filter(|value| *value > 0);
    migrate_provider_settings(&mut settings);
    reconcile_settings_session_sources(&mut settings);
    let _ = codex_config::write_collaboration_modes_enabled(
        &settings,
        settings.collaboration_modes_enabled,
    );
    let _ = codex_config::write_steer_enabled(&settings, settings.steer_enabled);
    let _ = codex_config::write_unified_exec_enabled(&settings, settings.unified_exec_enabled);
    let _ = codex_config::write_apps_enabled(&settings, settings.experimental_apps_enabled);
    let _ = codex_config::write_personality(&settings, settings.personality.as_str());
    codex_config::write_tool_output_token_limit(&settings, settings.tool_output_token_limit)?;
    write_settings(settings_path, &settings)?;
    let mut current = app_settings.lock().await;
    *current = settings.clone();
    Ok(settings)
}

fn reconcile_settings_session_sources(settings: &mut AppSettings) -> bool {
    let previous = settings.session_sources.clone();
    let current = codex_home::resolve_settings_codex_home(settings);
    let default = codex_home::resolve_home_dir().map(|home| home.join(".codex"));
    settings.session_sources = reconcile_session_sources(
        std::mem::take(&mut settings.session_sources),
        current.as_deref(),
        default.as_deref(),
        current_time_ms(),
    );
    settings.session_sources != previous
}

fn current_time_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or_default()
}

pub(crate) fn get_codex_config_path_core(settings: &AppSettings) -> Result<String, String> {
    codex_home::resolve_settings_codex_home(settings)
        .map(|home| home.join("config.toml"))
        .ok_or_else(|| "Unable to resolve CODEX_HOME".to_string())
        .and_then(|path| {
            path.to_str()
                .map(|value| value.to_string())
                .ok_or_else(|| "Unable to resolve CODEX_HOME".to_string())
        })
}

pub(crate) fn get_codex_status_core(settings: &AppSettings) -> CodexStatusDto {
    let configured_codex_home = settings
        .codex_home
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let codex_home = codex_home::resolve_settings_codex_home(settings);
    let codex_home_source = if configured_codex_home.is_some() {
        "设置"
    } else {
        match std::env::var("CODEX_HOME") {
            Ok(value) if !value.trim().is_empty() => "CODEX_HOME",
            _ => "默认路径",
        }
    }
    .to_string();
    let config_path = codex_home.as_ref().map(|home| home.join("config.toml"));
    let global_agents_path = codex_home.as_ref().map(|home| home.join("AGENTS.md"));
    let codex_skills_path = codex_home.as_ref().map(|home| home.join("skills"));
    let agents_skills_path =
        codex_home::resolve_home_dir().map(|home| home.join(".agents").join("skills"));
    let (model, model_error) = match codex_config::read_config_model(codex_home.clone()) {
        Ok(model) => (model, None),
        Err(error) => (None, Some(error)),
    };

    CodexStatusDto {
        codex_home_path: path_to_string(codex_home.as_deref()),
        codex_home_source,
        config_exists: path_exists(config_path.as_deref()),
        config_path: path_to_string(config_path.as_deref()),
        global_agents_exists: path_exists(global_agents_path.as_deref()),
        global_agents_path: path_to_string(global_agents_path.as_deref()),
        codex_skills_count: count_skill_dirs(codex_skills_path.as_deref()),
        codex_skills_path: path_to_string(codex_skills_path.as_deref()),
        agents_skills_count: count_skill_dirs(agents_skills_path.as_deref()),
        agents_skills_path: path_to_string(agents_skills_path.as_deref()),
        model,
        model_error,
    }
}

pub(crate) fn get_codex_sync_diagnostics_core(settings: &AppSettings) -> CodexSyncDiagnosticsDto {
    let configured_codex_home = settings
        .codex_home
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let codex_home = codex_home::resolve_settings_codex_home(settings);
    let default_codex_home = codex_home::resolve_default_codex_home();
    let shares_default_codex_sessions = codex_home
        .as_deref()
        .zip(default_codex_home.as_deref())
        .map(|(current, default)| paths_share_session_library(current, default));
    let codex_home_source = if configured_codex_home.is_some() {
        "设置"
    } else {
        match std::env::var("CODEX_HOME") {
            Ok(value) if !value.trim().is_empty() => "CODEX_HOME",
            _ => "默认路径",
        }
    }
    .to_string();
    let sessions_path = codex_home.as_ref().map(|home| home.join("sessions"));
    let (session_file_count, latest_session_path, latest_session_modified_ms) =
        collect_session_file_stats(sessions_path.as_deref());

    CodexSyncDiagnosticsDto {
        username: std::env::var("USERNAME")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .or_else(|| {
                std::env::var("USER")
                    .ok()
                    .filter(|value| !value.trim().is_empty())
            }),
        user_profile: std::env::var("USERPROFILE")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .or_else(|| {
                std::env::var("HOME")
                    .ok()
                    .filter(|value| !value.trim().is_empty())
            }),
        codex_home_path: path_to_string(codex_home.as_deref()),
        codex_home_source,
        default_codex_home_path: path_to_string(default_codex_home.as_deref()),
        shares_default_codex_sessions,
        sessions_exists: path_exists(sessions_path.as_deref()),
        sessions_path: path_to_string(sessions_path.as_deref()),
        session_file_count,
        latest_session_path,
        latest_session_modified_ms,
    }
}

fn paths_share_session_library(current: &Path, official: &Path) -> bool {
    if current == official {
        return true;
    }

    let current = fs::canonicalize(current).unwrap_or_else(|_| current.to_path_buf());
    let official = fs::canonicalize(official).unwrap_or_else(|_| official.to_path_buf());
    if current == official {
        return true;
    }

    normalized_path_key(&current) == normalized_path_key(&official)
}

fn normalized_path_key(path: &Path) -> String {
    let normalized = normalize_windows_namespace_path(&path.to_string_lossy());
    #[cfg(windows)]
    {
        normalized
            .replace('/', "\\")
            .trim_end_matches('\\')
            .to_lowercase()
    }
    #[cfg(not(windows))]
    {
        normalized.trim_end_matches('/').to_string()
    }
}

fn path_exists(path: Option<&Path>) -> bool {
    path.is_some_and(|path| path.exists())
}

fn path_to_string(path: Option<&Path>) -> Option<String> {
    path.map(|path| path.to_string_lossy().to_string())
}

fn count_skill_dirs(path: Option<&Path>) -> usize {
    let Some(path) = path else {
        return 0;
    };
    let Ok(entries) = fs::read_dir(path) else {
        return 0;
    };
    entries
        .filter_map(Result::ok)
        .filter(|entry| {
            entry
                .file_type()
                .map(|file_type| file_type.is_dir())
                .unwrap_or(false)
        })
        .count()
}

fn collect_session_file_stats(path: Option<&Path>) -> (usize, Option<String>, Option<u64>) {
    let Some(root) = path else {
        return (0, None, None);
    };
    let mut stack = vec![root.to_path_buf()];
    let mut count = 0;
    let mut latest_path: Option<PathBuf> = None;
    let mut latest_ms: Option<u64> = None;

    while let Some(dir) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.filter_map(Result::ok) {
            let path = entry.path();
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if file_type.is_dir() {
                stack.push(path);
                continue;
            }
            if !file_type.is_file()
                || path.extension().and_then(|value| value.to_str()) != Some("jsonl")
            {
                continue;
            }
            count += 1;
            let modified_ms = entry
                .metadata()
                .ok()
                .and_then(|metadata| metadata.modified().ok())
                .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
                .map(|duration| duration.as_millis() as u64);
            if modified_ms.is_some() && (latest_ms.is_none() || modified_ms > latest_ms) {
                latest_ms = modified_ms;
                latest_path = Some(path);
            }
        }
    }

    (count, path_to_string(latest_path.as_deref()), latest_ms)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_library_paths_match_after_canonicalization() {
        let temp_root = std::env::temp_dir().join(format!(
            "codex-monitor-session-sharing-{}",
            std::process::id()
        ));
        let nested = temp_root.join("sessions-root");
        fs::create_dir_all(&nested).expect("create session root");

        assert!(paths_share_session_library(
            &nested,
            &temp_root.join(".").join("sessions-root")
        ));

        fs::remove_dir_all(temp_root).expect("remove session root");
    }

    #[test]
    fn different_session_library_paths_do_not_match() {
        assert!(!paths_share_session_library(
            Path::new("/tmp/threadfleet-codex-home"),
            Path::new("/tmp/official-codex-home"),
        ));
    }
}
