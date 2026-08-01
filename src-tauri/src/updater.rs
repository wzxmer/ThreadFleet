use futures_util::StreamExt;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::Emitter;
use tauri::Manager;
use tokio::io::AsyncWriteExt;

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
    let total_bytes = response.content_length();
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
        hasher.update(&chunk);
        file.write_all(&chunk)
            .await
            .map_err(|error| format!("Failed to write installer file: {error}"))?;
        downloaded_bytes = downloaded_bytes.saturating_add(chunk.len() as u64);
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
        extract_managed_codex_archive, resolve_release_architecture,
        sanitize_release_asset_file_name, should_preserve_installer_downloads,
        validate_release_asset_url,
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
}
