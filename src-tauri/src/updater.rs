use futures_util::StreamExt;
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use tauri::Emitter;
use tauri::Manager;
use tauri::State;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines};
use tokio::process::{ChildStdin, ChildStdout};

use crate::shared::process_core::{kill_child_process_tree, tokio_command};
use crate::shared::windows_ui_update_core::{
    configure_windows_ui, inspect_windows_ui_installation, load_windows_ui_installation_snapshot,
    normalize_windows_ui_version, parse_windows_ui_version_output, resolve_windows_ui_release,
    validate_windows_ui_mcp_probe, validate_windows_ui_release_confirmation,
    windows_ui_executable_path, windows_ui_install_dir, windows_ui_install_root, GithubRelease,
    InstalledWindowsUi, ResolvedWindowsUiRelease, WindowsUiInstallationKind, WindowsUiReleaseInfo,
    WindowsUiUpdateCheckResult, WindowsUiUpdateStatus, WINDOWS_UI_EXECUTABLE_NAME,
    WINDOWS_UI_MAX_ARCHIVE_ENTRIES, WINDOWS_UI_MAX_EXTRACTED_BYTES,
    WINDOWS_UI_MCP_PROTOCOL_VERSION, WINDOWS_UI_RELEASE_API, WINDOWS_UI_RELEASE_TAG_API_PREFIX,
};
use crate::state::AppState;
use crate::types::BackendMode;

const RELEASE_HOST: &str = "github.com";
const RELEASE_PATH_PREFIX: &str = "/wzxmer/ThreadFleet/releases/download/";
const INSTALLER_DIR_NAME: &str = "release-installers";
const DOWNLOAD_STALL_TIMEOUT_SECS: u64 = 30;
const TENCENT_UPDATE_BASE_URL: Option<&str> = option_env!("THREADFLEET_TENCENT_UPDATE_BASE_URL");
const ALIYUN_UPDATE_BASE_URL: Option<&str> = option_env!("THREADFLEET_ALIYUN_UPDATE_BASE_URL");
const TENCENT_CODEX_CLI_BASE_URL: Option<&str> =
    option_env!("THREADFLEET_TENCENT_CODEX_CLI_BASE_URL");
const ALIYUN_CODEX_CLI_BASE_URL: Option<&str> =
    option_env!("THREADFLEET_ALIYUN_CODEX_CLI_BASE_URL");
const WINDOWS_UI_RELEASE_RESPONSE_MAX_BYTES: usize = 1024 * 1024;
const WINDOWS_UI_MCP_PROBE_TIMEOUT_SECS: u64 = 10;

static WINDOWS_UI_INSTALL_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadedReleaseAsset {
    path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledManagedCodex {
    path: String,
    version: String,
}

#[tauri::command]
pub async fn check_windows_ui_update(
    state: State<'_, AppState>,
) -> Result<WindowsUiUpdateCheckResult, String> {
    if std::env::consts::OS != "windows" {
        return Ok(WindowsUiUpdateCheckResult::unsupported(
            "unsupportedPlatform",
        ));
    }
    let settings = state.app_settings.lock().await.clone();
    if matches!(settings.backend_mode, BackendMode::Remote) {
        return Ok(WindowsUiUpdateCheckResult::unsupported(
            "remoteExecutionHost",
        ));
    }
    let codex_home = crate::codex::home::resolve_settings_codex_home(&settings)
        .ok_or_else(|| "Unable to resolve CODEX_HOME for windows-ui updates.".to_string())?;
    let installation = inspect_windows_ui_installation(&codex_home)?;
    if installation.kind == WindowsUiInstallationKind::Unmanaged {
        return Ok(WindowsUiUpdateCheckResult {
            status: WindowsUiUpdateStatus::Unmanaged,
            installed: installation.executable_exists,
            managed: false,
            current_version: None,
            release: None,
            reason_code: Some("unmanagedConfiguration".to_string()),
        });
    }

    let verified_version = if installation.executable_exists {
        let executable = installation
            .executable_path
            .as_deref()
            .ok_or_else(|| "windows-ui executable path is missing.".to_string())?;
        let install_dir = executable
            .parent()
            .ok_or_else(|| "windows-ui executable directory is missing.".to_string())?;
        validate_existing_install_dir(&codex_home, install_dir)?;
        let expected_version = installation
            .version
            .as_ref()
            .ok_or_else(|| "windows-ui configured version is missing.".to_string())?;
        Some(verify_windows_ui_executable(executable, expected_version).await?)
    } else {
        None
    };
    let latest = fetch_windows_ui_release(WINDOWS_UI_RELEASE_API).await?;
    let update_available = verified_version
        .as_ref()
        .map(|current| latest.version > *current)
        .unwrap_or(true);

    Ok(WindowsUiUpdateCheckResult {
        status: if update_available {
            WindowsUiUpdateStatus::Available
        } else {
            WindowsUiUpdateStatus::UpToDate
        },
        installed: verified_version.is_some(),
        managed: true,
        current_version: verified_version.map(|version| version.to_string()),
        release: Some(WindowsUiReleaseInfo::from(&latest)),
        reason_code: if installation.kind == WindowsUiInstallationKind::Managed
            && !installation.executable_exists
        {
            Some("missingExecutable".to_string())
        } else {
            None
        },
    })
}

#[tauri::command]
pub async fn install_windows_ui_update(
    app_handle: tauri::AppHandle,
    state: State<'_, AppState>,
    version: String,
    request_id: String,
    expected_asset_size: u64,
    expected_asset_sha256: String,
) -> Result<InstalledWindowsUi, String> {
    if std::env::consts::OS != "windows" {
        return Err("windows-ui updates are only available on Windows.".to_string());
    }
    validate_download_request_id(&request_id)?;
    let requested_version = normalize_windows_ui_version(&version)?;
    let _install_guard = WINDOWS_UI_INSTALL_LOCK.lock().await;
    let settings = state.app_settings.lock().await.clone();
    if matches!(settings.backend_mode, BackendMode::Remote) {
        return Err("windows-ui updates cannot modify a remote execution host.".to_string());
    }
    let codex_home = crate::codex::home::resolve_settings_codex_home(&settings)
        .ok_or_else(|| "Unable to resolve CODEX_HOME for windows-ui updates.".to_string())?;
    let (config_snapshot, installation) = load_windows_ui_installation_snapshot(&codex_home)?;
    if installation.kind == WindowsUiInstallationKind::Unmanaged {
        return Err(
            "Existing windows-ui MCP configuration is not managed by ThreadFleet; refusing to overwrite it."
                .to_string(),
        );
    }

    let release_url = format!("{WINDOWS_UI_RELEASE_TAG_API_PREFIX}{requested_version}");
    let release = fetch_windows_ui_release(&release_url).await?;
    validate_windows_ui_release_confirmation(
        &release,
        &requested_version,
        expected_asset_size,
        &expected_asset_sha256,
    )?;

    ensure_windows_ui_install_root(&codex_home).await?;
    let install_dir = windows_ui_install_dir(&codex_home, &requested_version);
    let executable_path = windows_ui_executable_path(&codex_home, &requested_version);
    if install_dir.exists() {
        validate_existing_install_dir(&codex_home, &install_dir)?;
        if !executable_path.is_file() {
            return Err(
                "The target windows-ui version directory exists but is incomplete; remove it manually before retrying."
                    .to_string(),
            );
        }
        verify_windows_ui_executable(&executable_path, &requested_version).await?;
    } else {
        install_downloaded_windows_ui(&app_handle, &codex_home, &release, &request_id).await?;
    }

    let current_settings = state.app_settings.lock().await.clone();
    if matches!(current_settings.backend_mode, BackendMode::Remote) {
        return Err(
            "windows-ui execution target changed after confirmation; check again.".to_string(),
        );
    }
    let current_codex_home = crate::codex::home::resolve_settings_codex_home(&current_settings)
        .ok_or_else(|| "Unable to resolve CODEX_HOME for windows-ui updates.".to_string())?;
    if current_codex_home != codex_home {
        return Err(
            "windows-ui execution target changed after confirmation; check again.".to_string(),
        );
    }

    configure_windows_ui(
        &codex_home,
        &executable_path,
        &requested_version,
        &config_snapshot,
    )?;
    if let Some(previous_version) = installation.version.as_ref() {
        if previous_version != &requested_version {
            if let Err(error) =
                cleanup_previous_windows_ui_install(&codex_home, previous_version).await
            {
                eprintln!(
                    "windows-ui updater: installed {requested_version}, but failed to remove previous managed version {previous_version}: {error}"
                );
            }
        }
    }
    Ok(InstalledWindowsUi {
        version: requested_version.to_string(),
        requires_codex_restart: true,
    })
}

#[tauri::command]
pub fn managed_codex_platform() -> String {
    format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH)
}

fn resolve_release_architecture(
    os: &str,
    process_architecture: &str,
    macos_arm64_capable: Option<bool>,
) -> String {
    if os != "macos" {
        return process_architecture.to_string();
    }
    if matches!(process_architecture, "aarch64" | "arm64") {
        return "aarch64".to_string();
    }
    match macos_arm64_capable {
        Some(true) => "aarch64".to_string(),
        Some(false) if matches!(process_architecture, "x86_64" | "amd64" | "x64") => {
            "x86_64".to_string()
        }
        None if matches!(process_architecture, "x86_64" | "amd64" | "x64") => "x86_64".to_string(),
        _ => "unknown".to_string(),
    }
}

#[cfg(target_os = "macos")]
fn macos_arm64_capable() -> Option<bool> {
    let output = Command::new("/usr/sbin/sysctl")
        .args(["-n", "hw.optional.arm64"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    match String::from_utf8_lossy(&output.stdout).trim() {
        "1" => Some(true),
        "0" => Some(false),
        _ => None,
    }
}

#[cfg(not(target_os = "macos"))]
fn macos_arm64_capable() -> Option<bool> {
    None
}

#[tauri::command]
pub fn release_platform() -> String {
    let architecture = resolve_release_architecture(
        std::env::consts::OS,
        std::env::consts::ARCH,
        macos_arm64_capable(),
    );
    format!("{}-{architecture}", std::env::consts::OS)
}

#[tauri::command]
pub fn windows_installer_kind() -> String {
    crate::windows_installer::detect_installer_kind()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ReleaseAssetDownloadProgress {
    id: String,
    downloaded_bytes: u64,
    total_bytes: Option<u64>,
}

#[tauri::command]
pub async fn cleanup_downloaded_release_assets(app_handle: tauri::AppHandle) -> Result<(), String> {
    cleanup_installer_dir(&app_handle).await
}

#[tauri::command]
pub async fn download_and_open_release_asset(
    app_handle: tauri::AppHandle,
    urls: Vec<String>,
    file_name: String,
    request_id: String,
    expected_size: Option<u64>,
    expected_sha256: Option<String>,
) -> Result<DownloadedReleaseAsset, String> {
    let downloaded = download_release_asset_impl(
        app_handle,
        urls,
        file_name,
        request_id,
        expected_size,
        expected_sha256,
    )
    .await?;
    open_installer(Path::new(&downloaded.path))?;
    Ok(downloaded)
}

#[tauri::command]
pub async fn download_release_asset(
    app_handle: tauri::AppHandle,
    urls: Vec<String>,
    file_name: String,
    request_id: String,
    expected_size: Option<u64>,
    expected_sha256: Option<String>,
) -> Result<DownloadedReleaseAsset, String> {
    download_release_asset_impl(
        app_handle,
        urls,
        file_name,
        request_id,
        expected_size,
        expected_sha256,
    )
    .await
}

async fn download_release_asset_impl(
    app_handle: tauri::AppHandle,
    urls: Vec<String>,
    file_name: String,
    request_id: String,
    expected_size: Option<u64>,
    expected_sha256: Option<String>,
) -> Result<DownloadedReleaseAsset, String> {
    if urls.is_empty() {
        return Err("No release asset download URL was provided.".to_string());
    }
    let safe_file_name = sanitize_release_asset_file_name(&file_name)?;
    for url in &urls {
        validate_release_asset_url(url, &safe_file_name)?;
    }
    let dir = installer_dir(&app_handle)?;
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|error| format!("Failed to create installer directory: {error}"))?;

    let target_path = unique_target_path(&dir, &safe_file_name);
    let temp_path = target_path.with_extension(format!(
        "{}download",
        target_path
            .extension()
            .and_then(|value| value.to_str())
            .map(|value| format!("{value}."))
            .unwrap_or_default()
    ));

    let mut errors = Vec::new();
    let mut downloaded = false;
    for url in &urls {
        let _ = tokio::fs::remove_file(&temp_path).await;
        match download_to_path(
            &app_handle,
            &request_id,
            url,
            &temp_path,
            expected_size,
            expected_sha256.as_deref(),
        )
        .await
        {
            Ok(()) => {
                downloaded = true;
                break;
            }
            Err(error) => errors.push(error),
        }
    }
    if !downloaded {
        let _ = tokio::fs::remove_file(&temp_path).await;
        return Err(format!(
            "All update download routes failed: {}",
            errors.join(" | ")
        ));
    }
    tokio::fs::rename(&temp_path, &target_path)
        .await
        .map_err(|error| {
            format!(
                "Failed to finalize installer download from '{}' to '{}': {error}",
                temp_path.to_string_lossy(),
                target_path.to_string_lossy()
            )
        })?;

    Ok(DownloadedReleaseAsset {
        path: target_path.to_string_lossy().into_owned(),
    })
}

#[tauri::command]
pub async fn install_managed_codex(
    app_handle: tauri::AppHandle,
    urls: Vec<String>,
    file_name: String,
    request_id: String,
    version: String,
    expected_size: u64,
    expected_sha256: String,
) -> Result<InstalledManagedCodex, String> {
    if urls.is_empty() {
        return Err("No Codex CLI download URL was provided.".to_string());
    }
    let safe_file_name = sanitize_release_asset_file_name(&file_name)?;
    if !safe_file_name.to_ascii_lowercase().ends_with(".zip") {
        return Err("Managed Codex package must be a ZIP archive.".to_string());
    }
    for url in &urls {
        validate_release_asset_url(url, &safe_file_name)?;
    }
    let normalized_version = version.trim().trim_start_matches(['v', 'V']);
    if normalized_version.is_empty()
        || !normalized_version
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-' | '_'))
    {
        return Err("Invalid managed Codex version.".to_string());
    }

    let mut root = app_handle
        .path()
        .app_data_dir()
        .map_err(|error| format!("Failed to resolve app data directory: {error}"))?;
    root.push("managed-codex");
    root.push(normalized_version);
    tokio::fs::create_dir_all(&root)
        .await
        .map_err(|error| format!("Failed to create managed Codex directory: {error}"))?;
    let archive_path = root.join(&safe_file_name);
    let temp_path = archive_path.with_extension("zip.download");

    let mut errors = Vec::new();
    let mut downloaded = false;
    for url in &urls {
        let _ = tokio::fs::remove_file(&temp_path).await;
        match download_to_path(
            &app_handle,
            &request_id,
            url,
            &temp_path,
            Some(expected_size),
            Some(&expected_sha256),
        )
        .await
        {
            Ok(()) => {
                downloaded = true;
                break;
            }
            Err(error) => errors.push(error),
        }
    }
    if !downloaded {
        let _ = tokio::fs::remove_file(&temp_path).await;
        return Err(format!(
            "All Codex CLI download routes failed: {}",
            errors.join(" | ")
        ));
    }
    tokio::fs::rename(&temp_path, &archive_path)
        .await
        .map_err(|error| format!("Failed to finalize Codex CLI package: {error}"))?;

    let install_root = root.clone();
    let archive_for_extract = archive_path.clone();
    let executable_path = tokio::task::spawn_blocking(move || {
        extract_managed_codex_archive(&archive_for_extract, &install_root)
    })
    .await
    .map_err(|error| format!("Codex CLI extraction task failed: {error}"))??;
    let _ = tokio::fs::remove_file(&archive_path).await;

    let detected_version = crate::backend::app_server::check_codex_installation(Some(
        executable_path.to_string_lossy().into_owned(),
    ))
    .await?;
    Ok(InstalledManagedCodex {
        path: executable_path.to_string_lossy().into_owned(),
        version: detected_version.unwrap_or_else(|| normalized_version.to_string()),
    })
}

fn validate_download_request_id(request_id: &str) -> Result<(), String> {
    if request_id.is_empty()
        || request_id.len() > 128
        || !request_id
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.'))
    {
        return Err("Invalid windows-ui download request ID.".to_string());
    }
    Ok(())
}

async fn fetch_windows_ui_release(url: &str) -> Result<ResolvedWindowsUiRelease, String> {
    let response = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(10))
        .timeout(std::time::Duration::from_secs(20))
        .user_agent("ThreadFleet windows-ui updater")
        .build()
        .map_err(|error| format!("Failed to create windows-ui update client: {error}"))?
        .get(url)
        .header(reqwest::header::ACCEPT, "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .send()
        .await
        .map_err(|error| format!("Failed to check windows-ui release: {error}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "windows-ui release check failed ({}).",
            response.status()
        ));
    }
    if response
        .content_length()
        .is_some_and(|length| length > WINDOWS_UI_RELEASE_RESPONSE_MAX_BYTES as u64)
    {
        return Err("windows-ui release response is too large.".to_string());
    }
    let body = response
        .bytes()
        .await
        .map_err(|error| format!("Failed to read windows-ui release response: {error}"))?;
    if body.len() > WINDOWS_UI_RELEASE_RESPONSE_MAX_BYTES {
        return Err("windows-ui release response is too large.".to_string());
    }
    let release = serde_json::from_slice::<GithubRelease>(&body)
        .map_err(|error| format!("Invalid windows-ui release response: {error}"))?;
    resolve_windows_ui_release(release, std::env::consts::ARCH)
}

async fn ensure_windows_ui_install_root(codex_home: &Path) -> Result<(), String> {
    tokio::fs::create_dir_all(codex_home)
        .await
        .map_err(|error| format!("Failed to create CODEX_HOME: {error}"))?;
    let mcp_servers_dir = codex_home.join("mcp-servers");
    ensure_real_child_directory(codex_home, &mcp_servers_dir, "MCP server directory").await?;
    let install_root = windows_ui_install_root(codex_home);
    ensure_real_child_directory(
        &mcp_servers_dir,
        &install_root,
        "windows-ui install directory",
    )
    .await
}

async fn ensure_real_child_directory(
    parent: &Path,
    child: &Path,
    label: &str,
) -> Result<(), String> {
    if !tokio::fs::try_exists(child)
        .await
        .map_err(|error| format!("Failed to inspect {label}: {error}"))?
    {
        tokio::fs::create_dir(child)
            .await
            .map_err(|error| format!("Failed to create {label}: {error}"))?;
    }
    validate_real_child_directory(parent, child, label)
}

fn validate_real_child_directory(parent: &Path, child: &Path, label: &str) -> Result<(), String> {
    if child.parent() != Some(parent) {
        return Err(format!("{label} is outside its managed parent directory."));
    }
    let metadata = std::fs::symlink_metadata(child)
        .map_err(|error| format!("Failed to inspect {label}: {error}"))?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(format!("{label} must be a real directory."));
    }
    let canonical_parent = std::fs::canonicalize(parent)
        .map_err(|error| format!("Failed to validate {label} parent: {error}"))?;
    let canonical_child = std::fs::canonicalize(child)
        .map_err(|error| format!("Failed to validate {label}: {error}"))?;
    if canonical_child.parent() != Some(canonical_parent.as_path()) {
        return Err(format!("{label} escapes its managed parent directory."));
    }
    Ok(())
}

fn validate_existing_install_dir(codex_home: &Path, install_dir: &Path) -> Result<(), String> {
    let mcp_servers_dir = codex_home.join("mcp-servers");
    validate_real_child_directory(codex_home, &mcp_servers_dir, "MCP server directory")?;
    let install_root = windows_ui_install_root(codex_home);
    validate_real_child_directory(
        &mcp_servers_dir,
        &install_root,
        "windows-ui install directory",
    )?;
    validate_real_child_directory(&install_root, install_dir, "windows-ui version directory")
}

async fn cleanup_previous_windows_ui_install(
    codex_home: &Path,
    previous_version: &semver::Version,
) -> Result<(), String> {
    let previous_dir = windows_ui_install_dir(codex_home, previous_version);
    if !tokio::fs::try_exists(&previous_dir)
        .await
        .map_err(|error| format!("Failed to inspect previous windows-ui version: {error}"))?
    {
        return Ok(());
    }
    validate_existing_install_dir(codex_home, &previous_dir)?;
    tokio::fs::remove_dir_all(&previous_dir)
        .await
        .map_err(|error| format!("Failed to remove previous windows-ui version: {error}"))
}

async fn install_downloaded_windows_ui(
    app_handle: &tauri::AppHandle,
    codex_home: &Path,
    release: &ResolvedWindowsUiRelease,
    request_id: &str,
) -> Result<(), String> {
    let cache_dir = app_handle
        .path()
        .app_cache_dir()
        .map_err(|error| format!("Failed to resolve app cache directory: {error}"))?
        .join("windows-ui-updates")
        .join(uuid::Uuid::new_v4().to_string());
    tokio::fs::create_dir_all(&cache_dir)
        .await
        .map_err(|error| format!("Failed to create windows-ui download directory: {error}"))?;
    let archive_path = cache_dir.join(format!("{}.download", release.asset_name));
    let temporary_install_dir = windows_ui_install_root(codex_home).join(format!(
        ".{}-{}.installing",
        release.version,
        uuid::Uuid::new_v4()
    ));

    let result = async {
        download_to_path(
            app_handle,
            request_id,
            &release.asset_url,
            &archive_path,
            Some(release.asset_size),
            Some(&release.asset_sha256),
        )
        .await?;

        let archive_for_extract = archive_path.clone();
        let install_for_extract = temporary_install_dir.clone();
        tokio::task::spawn_blocking(move || {
            extract_windows_ui_archive(&archive_for_extract, &install_for_extract)
        })
        .await
        .map_err(|error| format!("windows-ui extraction task failed: {error}"))??;

        let temporary_executable = temporary_install_dir.join(WINDOWS_UI_EXECUTABLE_NAME);
        verify_windows_ui_executable(&temporary_executable, &release.version).await?;
        let final_install_dir = windows_ui_install_dir(codex_home, &release.version);
        tokio::fs::rename(&temporary_install_dir, &final_install_dir)
            .await
            .map_err(|error| format!("Failed to finalize windows-ui installation: {error}"))?;
        Ok(())
    }
    .await;

    let _ = tokio::fs::remove_dir_all(&cache_dir).await;
    if result.is_err() {
        let _ = tokio::fs::remove_dir_all(&temporary_install_dir).await;
    }
    result
}

fn extract_windows_ui_archive(archive_path: &Path, install_root: &Path) -> Result<(), String> {
    if install_root.exists() {
        return Err("Temporary windows-ui install directory already exists.".to_string());
    }
    std::fs::create_dir_all(install_root)
        .map_err(|error| format!("Failed to create temporary windows-ui directory: {error}"))?;
    let archive_file = std::fs::File::open(archive_path)
        .map_err(|error| format!("Failed to open windows-ui package: {error}"))?;
    let mut archive = zip::ZipArchive::new(archive_file)
        .map_err(|error| format!("Invalid windows-ui package: {error}"))?;
    if archive.len() == 0 || archive.len() > WINDOWS_UI_MAX_ARCHIVE_ENTRIES {
        return Err("windows-ui package has an invalid entry count.".to_string());
    }

    let mut extracted_bytes = 0_u64;
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|error| format!("Failed to read windows-ui package: {error}"))?;
        let relative_path = entry
            .enclosed_name()
            .ok_or_else(|| "windows-ui package contains an unsafe path.".to_string())?;
        if let Some(mode) = entry.unix_mode() {
            let file_type = mode & 0o170000;
            if file_type == 0o120000 {
                return Err("windows-ui package contains a symbolic link.".to_string());
            }
            if file_type != 0 && file_type != 0o040000 && file_type != 0o100000 {
                return Err("windows-ui package contains an unsupported entry type.".to_string());
            }
        }
        extracted_bytes = extracted_bytes
            .checked_add(entry.size())
            .ok_or_else(|| "windows-ui package expanded size overflowed.".to_string())?;
        if extracted_bytes > WINDOWS_UI_MAX_EXTRACTED_BYTES {
            return Err("windows-ui package expands beyond the allowed size.".to_string());
        }
        let target_path = install_root.join(&relative_path);
        if entry.is_dir() {
            std::fs::create_dir_all(&target_path).map_err(|error| {
                format!("Failed to create windows-ui package directory: {error}")
            })?;
            continue;
        }
        if let Some(parent) = target_path.parent() {
            std::fs::create_dir_all(parent).map_err(|error| {
                format!("Failed to create windows-ui package directory: {error}")
            })?;
        }
        let mut output = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&target_path)
            .map_err(|error| format!("Failed to create windows-ui package file: {error}"))?;
        let written = std::io::copy(&mut entry, &mut output)
            .map_err(|error| format!("Failed to extract windows-ui package file: {error}"))?;
        if written != entry.size() {
            return Err("windows-ui package entry size changed during extraction.".to_string());
        }
    }

    let executable = install_root.join(WINDOWS_UI_EXECUTABLE_NAME);
    if !executable.is_file() {
        return Err(format!(
            "windows-ui package does not contain {WINDOWS_UI_EXECUTABLE_NAME} at its root."
        ));
    }
    Ok(())
}

async fn verify_windows_ui_executable(
    executable_path: &Path,
    expected_version: &semver::Version,
) -> Result<semver::Version, String> {
    validate_real_windows_ui_executable(executable_path)?;
    let mut version_command = tokio_command(executable_path);
    version_command.arg("--version").kill_on_drop(true);
    let output = tokio::time::timeout(
        std::time::Duration::from_secs(WINDOWS_UI_MCP_PROBE_TIMEOUT_SECS),
        version_command.output(),
    )
    .await
    .map_err(|_| "windows-ui --version probe timed out.".to_string())?
    .map_err(|error| format!("Failed to run windows-ui --version: {error}"))?;
    if !output.status.success() {
        return Err("windows-ui --version probe failed.".to_string());
    }
    let version_output = format!(
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let reported_version = parse_windows_ui_version_output(&version_output)?;
    if &reported_version != expected_version {
        return Err(
            "windows-ui executable version does not match its release directory.".to_string(),
        );
    }
    probe_windows_ui_mcp(executable_path, expected_version).await?;
    Ok(reported_version)
}

fn validate_real_windows_ui_executable(executable_path: &Path) -> Result<(), String> {
    let parent = executable_path
        .parent()
        .ok_or_else(|| "windows-ui executable has no parent directory.".to_string())?;
    if executable_path.file_name().and_then(|value| value.to_str())
        != Some(WINDOWS_UI_EXECUTABLE_NAME)
    {
        return Err("windows-ui executable has an unexpected file name.".to_string());
    }
    let metadata = std::fs::symlink_metadata(executable_path)
        .map_err(|error| format!("Failed to inspect windows-ui executable: {error}"))?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err("windows-ui executable must be a real file.".to_string());
    }
    let canonical_parent = std::fs::canonicalize(parent)
        .map_err(|error| format!("Failed to validate windows-ui executable directory: {error}"))?;
    let canonical_executable = std::fs::canonicalize(executable_path)
        .map_err(|error| format!("Failed to validate windows-ui executable: {error}"))?;
    if canonical_executable.parent() != Some(canonical_parent.as_path()) {
        return Err("windows-ui executable escapes its verified version directory.".to_string());
    }
    Ok(())
}

async fn probe_windows_ui_mcp(
    executable_path: &Path,
    expected_version: &semver::Version,
) -> Result<(), String> {
    let mut command = tokio_command(executable_path);
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    if let Some(parent) = executable_path.parent() {
        command.current_dir(parent);
    }
    let mut child = command
        .spawn()
        .map_err(|error| format!("Failed to start windows-ui MCP probe: {error}"))?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| "windows-ui MCP probe stdin is unavailable.".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "windows-ui MCP probe stdout is unavailable.".to_string())?;
    let mut lines = BufReader::new(stdout).lines();

    let probe_result = async {
        write_mcp_message(
            &mut stdin,
            &json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {
                    "protocolVersion": WINDOWS_UI_MCP_PROTOCOL_VERSION,
                    "capabilities": {},
                    "clientInfo": {
                        "name": "threadfleet-windows-ui-updater",
                        "version": env!("CARGO_PKG_VERSION")
                    }
                }
            }),
        )
        .await?;
        let initialize_response = read_mcp_response(&mut lines, 1).await?;
        write_mcp_message(
            &mut stdin,
            &json!({
                "jsonrpc": "2.0",
                "method": "notifications/initialized",
                "params": {}
            }),
        )
        .await?;

        let mut tool_names = HashSet::new();
        let mut cursor: Option<String> = None;
        let mut exhausted = false;
        for page in 0..4_u64 {
            let request_id = 2 + page;
            let params = cursor
                .as_ref()
                .map(|cursor| json!({ "cursor": cursor }))
                .unwrap_or_else(|| json!({}));
            write_mcp_message(
                &mut stdin,
                &json!({
                    "jsonrpc": "2.0",
                    "id": request_id,
                    "method": "tools/list",
                    "params": params
                }),
            )
            .await?;
            let response = read_mcp_response(&mut lines, request_id).await?;
            if response.get("error").is_some() {
                return Err("windows-ui MCP tools/list returned an error.".to_string());
            }
            let result = response
                .get("result")
                .and_then(Value::as_object)
                .ok_or_else(|| "windows-ui MCP tools/list result is missing.".to_string())?;
            let tools = result
                .get("tools")
                .and_then(Value::as_array)
                .ok_or_else(|| "windows-ui MCP tool list is missing.".to_string())?;
            for tool in tools {
                if let Some(name) = tool.get("name").and_then(Value::as_str) {
                    tool_names.insert(name.to_string());
                }
            }
            cursor = result
                .get("nextCursor")
                .and_then(Value::as_str)
                .map(str::to_string)
                .filter(|value| !value.is_empty());
            if cursor.is_none() {
                exhausted = true;
                break;
            }
        }
        if !exhausted {
            return Err("windows-ui MCP tool list exceeded the probe page limit.".to_string());
        }
        validate_windows_ui_mcp_probe(&initialize_response, &tool_names, expected_version)
    }
    .await;

    kill_child_process_tree(&mut child).await;
    probe_result
}

async fn write_mcp_message(stdin: &mut ChildStdin, message: &Value) -> Result<(), String> {
    let mut encoded = serde_json::to_vec(message)
        .map_err(|error| format!("Failed to encode windows-ui MCP probe request: {error}"))?;
    encoded.push(b'\n');
    stdin
        .write_all(&encoded)
        .await
        .map_err(|error| format!("Failed to write windows-ui MCP probe request: {error}"))?;
    stdin
        .flush()
        .await
        .map_err(|error| format!("Failed to flush windows-ui MCP probe request: {error}"))
}

async fn read_mcp_response(
    lines: &mut Lines<BufReader<ChildStdout>>,
    request_id: u64,
) -> Result<Value, String> {
    let deadline = tokio::time::Instant::now()
        + std::time::Duration::from_secs(WINDOWS_UI_MCP_PROBE_TIMEOUT_SECS);
    for _ in 0..32 {
        let line = tokio::time::timeout_at(deadline, lines.next_line())
            .await
            .map_err(|_| "windows-ui MCP probe timed out.".to_string())?
            .map_err(|error| format!("Failed to read windows-ui MCP probe response: {error}"))?
            .ok_or_else(|| "windows-ui MCP probe closed unexpectedly.".to_string())?;
        if line.trim().is_empty() {
            continue;
        }
        let value = serde_json::from_str::<Value>(&line)
            .map_err(|error| format!("Invalid windows-ui MCP probe response: {error}"))?;
        if value.get("id").and_then(Value::as_u64) == Some(request_id) {
            return Ok(value);
        }
    }
    Err("windows-ui MCP probe returned too many unrelated messages.".to_string())
}

fn extract_managed_codex_archive(
    archive_path: &Path,
    install_root: &Path,
) -> Result<PathBuf, String> {
    let archive_file = std::fs::File::open(archive_path)
        .map_err(|error| format!("Failed to open Codex CLI package: {error}"))?;
    let mut archive = zip::ZipArchive::new(archive_file)
        .map_err(|error| format!("Invalid Codex CLI package: {error}"))?;
    let expected_name = if cfg!(target_os = "windows") {
        "codex.exe"
    } else {
        "codex"
    };
    let mut executable_path = None;
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|error| format!("Failed to read Codex CLI package: {error}"))?;
        let Some(relative_path) = entry.enclosed_name() else {
            continue;
        };
        if entry.is_dir() {
            continue;
        }
        let target = install_root.join(&relative_path);
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).map_err(|error| {
                format!("Failed to create managed Codex package directory: {error}")
            })?;
        }
        let mut output = std::fs::File::create(&target)
            .map_err(|error| format!("Failed to create managed Codex package file: {error}"))?;
        std::io::copy(&mut entry, &mut output)
            .map_err(|error| format!("Failed to extract managed Codex package file: {error}"))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if let Some(mode) = entry.unix_mode() {
                std::fs::set_permissions(&target, std::fs::Permissions::from_mode(mode)).map_err(
                    |error| format!("Failed to apply Codex package permissions: {error}"),
                )?;
            }
        }
        if relative_path.file_name().and_then(|value| value.to_str()) == Some(expected_name) {
            executable_path = Some(target);
        }
    }
    executable_path.ok_or_else(|| format!("Codex CLI package does not contain {expected_name}."))
}

fn validate_release_asset_url(url: &str, expected_file_name: &str) -> Result<(), String> {
    let parsed =
        reqwest::Url::parse(url).map_err(|error| format!("Invalid release asset URL: {error}"))?;
    if parsed.scheme() != "https" {
        return Err("Only HTTPS release assets can be downloaded.".to_string());
    }
    let is_github =
        parsed.host_str() == Some(RELEASE_HOST) && parsed.path().starts_with(RELEASE_PATH_PREFIX);
    let is_configured_mirror = [
        TENCENT_UPDATE_BASE_URL,
        ALIYUN_UPDATE_BASE_URL,
        TENCENT_CODEX_CLI_BASE_URL,
        ALIYUN_CODEX_CLI_BASE_URL,
    ]
    .into_iter()
    .flatten()
    .any(|base_url| url.starts_with(&format!("{}/", base_url.trim_end_matches('/'))));
    if !is_github && !is_configured_mirror {
        return Err("Release asset URL is not on the configured allowlist.".to_string());
    }
    let url_file_name = parsed
        .path_segments()
        .and_then(|segments| segments.last())
        .ok_or_else(|| "Release asset URL has no file name.".to_string())?;
    if url_file_name != expected_file_name {
        return Err(
            "Release asset URL file name does not match the selected installer.".to_string(),
        );
    }
    Ok(())
}

fn sanitize_release_asset_file_name(file_name: &str) -> Result<String, String> {
    let base_name = Path::new(file_name)
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "Invalid release asset file name.".to_string())?;
    let sanitized: String = base_name
        .chars()
        .map(|ch| match ch {
            'a'..='z' | 'A'..='Z' | '0'..='9' | '.' | '_' | '-' => ch,
            _ => '_',
        })
        .collect();
    if sanitized.is_empty() || sanitized == "." || sanitized == ".." {
        return Err("Invalid release asset file name.".to_string());
    }
    Ok(sanitized)
}

fn installer_dir(app_handle: &tauri::AppHandle) -> Result<PathBuf, String> {
    let mut dir = app_handle
        .path()
        .app_cache_dir()
        .map_err(|error| format!("Failed to resolve app cache directory: {error}"))?;
    dir.push(INSTALLER_DIR_NAME);
    Ok(dir)
}

async fn cleanup_installer_dir(app_handle: &tauri::AppHandle) -> Result<(), String> {
    let data_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|_| "Failed to resolve migration recovery storage.".to_string())?;
    let preserve_downloads = should_preserve_installer_downloads(
        crate::shared::installer_migration_service::installer_migration_recovery_status(&data_dir),
    );
    if preserve_downloads {
        return Ok(());
    }
    let dir = installer_dir(app_handle)?;
    match tokio::fs::remove_dir_all(&dir).await {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("Failed to clean downloaded installers: {error}")),
    }
}

fn should_preserve_installer_downloads(
    recovery_status: Result<
        crate::shared::installer_migration_service::InstallerMigrationRecoveryStatus,
        String,
    >,
) -> bool {
    match recovery_status {
        Ok(status) => status.recovery_required,
        Err(_) => true,
    }
}

fn unique_target_path(dir: &Path, file_name: &str) -> PathBuf {
    let mut candidate = dir.join(file_name);
    if !candidate.exists() {
        return candidate;
    }

    let path = Path::new(file_name);
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("installer");
    let extension = path.extension().and_then(|value| value.to_str());
    for index in 1..1000 {
        let name = match extension {
            Some(extension) => format!("{stem}-{index}.{extension}"),
            None => format!("{stem}-{index}"),
        };
        candidate = dir.join(name);
        if !candidate.exists() {
            return candidate;
        }
    }

    dir.join(format!("{stem}-latest"))
}

fn emit_download_progress(
    app_handle: &tauri::AppHandle,
    request_id: &str,
    downloaded_bytes: u64,
    total_bytes: Option<u64>,
) {
    let _ = app_handle.emit(
        "release-asset-download-progress",
        ReleaseAssetDownloadProgress {
            id: request_id.to_string(),
            downloaded_bytes,
            total_bytes,
        },
    );
}

fn checked_downloaded_size(
    downloaded_bytes: u64,
    chunk_size: usize,
    expected_size: Option<u64>,
) -> Result<u64, String> {
    let chunk_size = u64::try_from(chunk_size)
        .map_err(|_| "Installer download chunk size overflowed.".to_string())?;
    let next_size = downloaded_bytes
        .checked_add(chunk_size)
        .ok_or_else(|| "Installer download size overflowed.".to_string())?;
    if expected_size.is_some_and(|expected| next_size > expected) {
        return Err("Installer download exceeded the expected size.".to_string());
    }
    Ok(next_size)
}

async fn download_to_path(
    app_handle: &tauri::AppHandle,
    request_id: &str,
    url: &str,
    target_path: &Path,
    expected_size: Option<u64>,
    expected_sha256: Option<&str>,
) -> Result<(), String> {
    let response = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|error| format!("Failed to create update client: {error}"))?
        .get(url)
        .header(reqwest::header::ACCEPT, "application/octet-stream")
        .send()
        .await
        .map_err(|error| format!("Failed to download installer: {error}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "Release asset download failed ({}).",
            response.status()
        ));
    }
    let response_size = response.content_length();
    if let (Some(expected_size), Some(response_size)) = (expected_size, response_size) {
        if response_size != expected_size {
            return Err(format!(
                "Installer size mismatch: expected {expected_size}, got {response_size}."
            ));
        }
    }
    let total_bytes = expected_size.or(response_size);
    emit_download_progress(app_handle, request_id, 0, total_bytes);

    let mut file = tokio::fs::File::create(target_path)
        .await
        .map_err(|error| format!("Failed to create installer file: {error}"))?;
    let mut stream = response.bytes_stream();
    let mut downloaded_bytes = 0_u64;
    let mut hasher = Sha256::new();
    loop {
        let next_chunk = tokio::time::timeout(
            std::time::Duration::from_secs(DOWNLOAD_STALL_TIMEOUT_SECS),
            stream.next(),
        )
        .await
        .map_err(|_| "Installer download stalled.".to_string())?;
        let Some(chunk) = next_chunk else { break };
        let chunk = chunk.map_err(|error| format!("Failed to read installer download: {error}"))?;
        let next_downloaded_bytes =
            checked_downloaded_size(downloaded_bytes, chunk.len(), expected_size)?;
        hasher.update(&chunk);
        file.write_all(&chunk)
            .await
            .map_err(|error| format!("Failed to write installer file: {error}"))?;
        downloaded_bytes = next_downloaded_bytes;
        emit_download_progress(app_handle, request_id, downloaded_bytes, total_bytes);
    }
    file.flush()
        .await
        .map_err(|error| format!("Failed to flush installer file: {error}"))?;
    if let Some(expected_size) = expected_size {
        if downloaded_bytes != expected_size {
            return Err(format!(
                "Installer size mismatch: expected {expected_size}, got {downloaded_bytes}."
            ));
        }
    }
    if let Some(expected_sha256) = expected_sha256 {
        let actual_sha256 = format!("{:x}", hasher.finalize());
        if !actual_sha256.eq_ignore_ascii_case(expected_sha256) {
            return Err("Installer SHA-256 verification failed.".to_string());
        }
    }
    emit_download_progress(
        app_handle,
        request_id,
        downloaded_bytes,
        Some(downloaded_bytes),
    );
    Ok(())
}

fn open_installer(path: &Path) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let extension = path
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();
        let mut command = if extension == "msi" {
            let mut command = Command::new("msiexec.exe");
            command.arg("/i").arg(path);
            command
        } else {
            Command::new(path)
        };
        command
            .spawn()
            .map_err(|error| format!("Failed to open installer: {error}"))?;
        return Ok(());
    }

    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(path)
            .spawn()
            .map_err(|error| format!("Failed to open installer: {error}"))?;
        return Ok(());
    }

    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    {
        Command::new("xdg-open")
            .arg(path)
            .spawn()
            .map_err(|error| format!("Failed to open installer: {error}"))?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::{
        checked_downloaded_size, cleanup_previous_windows_ui_install,
        extract_managed_codex_archive, extract_windows_ui_archive, resolve_release_architecture,
        sanitize_release_asset_file_name, should_preserve_installer_downloads,
        validate_download_request_id, validate_real_child_directory,
        validate_real_windows_ui_executable, validate_release_asset_url,
    };
    use crate::windows_installer::{
        classify_windows_installer_registration, select_windows_installer_kind,
    };
    use std::io::Write;

    #[test]
    fn accepts_matching_github_release_asset() {
        let file_name = "ThreadFleet_1.2.3_x64.msi";
        let url =
            format!("https://github.com/wzxmer/ThreadFleet/releases/download/v1.2.3/{file_name}");
        assert!(validate_release_asset_url(&url, file_name).is_ok());
    }

    #[test]
    fn selects_macos_hardware_architecture_even_under_rosetta() {
        assert_eq!(
            resolve_release_architecture("macos", "x86_64", Some(true)),
            "aarch64"
        );
        assert_eq!(
            resolve_release_architecture("macos", "x86_64", Some(false)),
            "x86_64"
        );
        assert_eq!(
            resolve_release_architecture("windows", "x86_64", Some(true)),
            "x86_64"
        );
        assert_eq!(
            resolve_release_architecture("macos", "aarch64", None),
            "aarch64"
        );
        assert_eq!(
            resolve_release_architecture("macos", "x86_64", None),
            "x86_64"
        );
    }

    #[test]
    fn rejects_mismatched_release_asset_file_name() {
        let url = "https://github.com/wzxmer/ThreadFleet/releases/download/v1.2.3/other.msi";
        assert!(validate_release_asset_url(url, "ThreadFleet_1.2.3_x64.msi").is_err());
    }

    #[test]
    fn detects_installer_kind_from_current_registered_version() {
        assert_eq!(
            select_windows_installer_kind("1.2.3", [Some("1.2.3".into())], [Some("1.2.2".into())],),
            "mixed"
        );
        assert_eq!(
            select_windows_installer_kind("1.2.3", [Some("1.2.2".into())], [Some("1.2.3".into())],),
            "mixed"
        );
        assert_eq!(
            select_windows_installer_kind("1.2.3", [Some("1.2.3".into())], [Some("1.2.3".into())],),
            "mixed"
        );
        assert_eq!(
            select_windows_installer_kind(
                "1.2.3",
                [Some("1.2.3".into())],
                Vec::<Option<String>>::new(),
            ),
            "msi"
        );
        assert_eq!(
            select_windows_installer_kind(
                "1.2.3",
                Vec::<Option<String>>::new(),
                [Some("1.2.3".into())],
            ),
            "nsis"
        );
        assert_eq!(
            select_windows_installer_kind(
                "1.2.3",
                [Some("1.2.2".into())],
                Vec::<Option<String>>::new(),
            ),
            "unknown"
        );
        assert_eq!(
            select_windows_installer_kind("1.2.3", [Some("1.2.3".into())], [None],),
            "mixed"
        );
        assert_eq!(
            select_windows_installer_kind("1.2.3", [None], Vec::<Option<String>>::new(),),
            "unknown"
        );
    }

    #[test]
    fn classifies_only_explicit_windows_installer_families() {
        assert_eq!(
            classify_windows_installer_registration(Some(1), Some("MsiExec.exe /I")),
            Some("msi")
        );
        assert_eq!(
            classify_windows_installer_registration(None, Some("C:\\App\\uninstall.exe")),
            Some("nsis")
        );
        assert_eq!(
            classify_windows_installer_registration(None, Some("MsiExec.exe /I")),
            None
        );
        assert_eq!(classify_windows_installer_registration(None, None), None);
    }

    #[test]
    fn updater_cleanup_preserves_downloads_for_recovery_or_uncertain_status() {
        use crate::shared::installer_migration_service::InstallerMigrationRecoveryStatus;

        assert!(should_preserve_installer_downloads(Ok(
            InstallerMigrationRecoveryStatus {
                recovery_required: true,
                target_version: Some("1.2.3".into()),
            }
        )));
        assert!(should_preserve_installer_downloads(Err(
            "recovery state is unreadable".into()
        )));
        assert!(!should_preserve_installer_downloads(Ok(
            InstallerMigrationRecoveryStatus {
                recovery_required: false,
                target_version: None,
            }
        )));
    }

    #[test]
    fn strips_directory_components_from_release_asset_name() {
        assert_eq!(
            sanitize_release_asset_file_name("../ThreadFleet 1.2.3.msi").unwrap(),
            "ThreadFleet_1.2.3.msi"
        );
    }

    #[test]
    fn extracts_managed_codex_executable() {
        let root =
            std::env::temp_dir().join(format!("codex-monitor-updater-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let archive_path = root.join("codex.zip");
        let file = std::fs::File::create(&archive_path).unwrap();
        let mut archive = zip::ZipWriter::new(file);
        let executable_name = if cfg!(target_os = "windows") {
            "codex.exe"
        } else {
            "codex"
        };
        archive
            .start_file(executable_name, zip::write::SimpleFileOptions::default())
            .unwrap();
        archive.write_all(b"test-codex").unwrap();
        archive.finish().unwrap();

        let path = extract_managed_codex_archive(&archive_path, &root).unwrap();
        assert_eq!(std::fs::read(path).unwrap(), b"test-codex");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn extracts_windows_ui_package_into_an_empty_version_directory() {
        let root =
            std::env::temp_dir().join(format!("threadfleet-windows-ui-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let archive_path = root.join("windows-ui.zip");
        let file = std::fs::File::create(&archive_path).unwrap();
        let mut archive = zip::ZipWriter::new(file);
        archive
            .start_file(
                crate::shared::windows_ui_update_core::WINDOWS_UI_EXECUTABLE_NAME,
                zip::write::SimpleFileOptions::default(),
            )
            .unwrap();
        archive.write_all(b"test-windows-ui").unwrap();
        archive.finish().unwrap();

        let install_dir = root.join("install");
        extract_windows_ui_archive(&archive_path, &install_dir).unwrap();
        assert_eq!(
            std::fs::read(
                install_dir.join(crate::shared::windows_ui_update_core::WINDOWS_UI_EXECUTABLE_NAME)
            )
            .unwrap(),
            b"test-windows-ui"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_windows_ui_archive_path_traversal() {
        let root = std::env::temp_dir().join(format!(
            "threadfleet-windows-ui-unsafe-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let archive_path = root.join("windows-ui.zip");
        let file = std::fs::File::create(&archive_path).unwrap();
        let mut archive = zip::ZipWriter::new(file);
        archive
            .start_file(
                "../Sbroenne.WindowsMcp.exe",
                zip::write::SimpleFileOptions::default(),
            )
            .unwrap();
        archive.write_all(b"unsafe").unwrap();
        archive.finish().unwrap();

        let error = extract_windows_ui_archive(&archive_path, &root.join("install")).unwrap_err();
        assert!(error.contains("unsafe path"));
        assert!(!root.join("Sbroenne.WindowsMcp.exe").exists());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn validates_windows_ui_progress_request_ids() {
        assert!(validate_download_request_id("windows-ui.123_ab-c").is_ok());
        assert!(validate_download_request_id("").is_err());
        assert!(validate_download_request_id("../../escape").is_err());
    }

    #[test]
    fn bounds_windows_ui_downloads_before_writing_past_the_confirmed_size() {
        assert_eq!(checked_downloaded_size(40, 2, Some(42)).unwrap(), 42);
        assert!(checked_downloaded_size(42, 1, Some(42))
            .unwrap_err()
            .contains("exceeded the expected size"));
        assert!(checked_downloaded_size(u64::MAX, 1, None)
            .unwrap_err()
            .contains("overflowed"));
    }

    #[test]
    fn validates_windows_ui_managed_directory_and_executable_boundaries() {
        let root = std::env::temp_dir().join(format!(
            "threadfleet-windows-ui-boundary-{}",
            uuid::Uuid::new_v4()
        ));
        let parent = root.join("parent");
        let child = parent.join("child");
        let sibling = root.join("sibling");
        std::fs::create_dir_all(&child).unwrap();
        std::fs::create_dir_all(&sibling).unwrap();
        validate_real_child_directory(&parent, &child, "test child").unwrap();
        assert!(
            validate_real_child_directory(&parent, &sibling, "test child")
                .unwrap_err()
                .contains("outside its managed parent")
        );

        let executable =
            child.join(crate::shared::windows_ui_update_core::WINDOWS_UI_EXECUTABLE_NAME);
        std::fs::write(&executable, b"test").unwrap();
        validate_real_windows_ui_executable(&executable).unwrap();
        assert!(
            validate_real_windows_ui_executable(&child.join("other.exe"))
                .unwrap_err()
                .contains("unexpected file name")
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn removes_only_the_previous_managed_windows_ui_version() {
        let codex_home = std::env::temp_dir().join(format!(
            "threadfleet-windows-ui-cleanup-{}",
            uuid::Uuid::new_v4()
        ));
        let previous_version = semver::Version::parse("1.3.17").unwrap();
        let current_version = semver::Version::parse("1.3.18").unwrap();
        let previous_dir = crate::shared::windows_ui_update_core::windows_ui_install_dir(
            &codex_home,
            &previous_version,
        );
        let current_dir = crate::shared::windows_ui_update_core::windows_ui_install_dir(
            &codex_home,
            &current_version,
        );
        std::fs::create_dir_all(&previous_dir).unwrap();
        std::fs::create_dir_all(&current_dir).unwrap();
        std::fs::write(previous_dir.join("old.txt"), b"old").unwrap();
        std::fs::write(current_dir.join("current.txt"), b"current").unwrap();

        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(cleanup_previous_windows_ui_install(
                &codex_home,
                &previous_version,
            ))
            .unwrap();

        assert!(!previous_dir.exists());
        assert!(current_dir.join("current.txt").is_file());
        std::fs::remove_dir_all(codex_home).unwrap();
    }
}
