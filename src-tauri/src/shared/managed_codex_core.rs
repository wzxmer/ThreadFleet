use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::time::Duration;

use semver::Version;
use serde::Serialize;

use crate::backend::app_server::resolve_codex_command_path;
use crate::shared::windows_ui_update_core::GithubRelease;

const CODEX_RELEASE_API: &str = "https://api.github.com/repos/openai/codex/releases/latest";
const MAX_RELEASE_BYTES: usize = 1024 * 1024;
const MAX_PACKAGE_ENTRIES: usize = 4096;
const MAX_EXTRACTED_BYTES: u64 = 2 * 1024 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ManagedCodexPackage {
    pub(crate) version: String,
    pub(crate) file_name: String,
    pub(crate) urls: Vec<String>,
    pub(crate) size: u64,
    pub(crate) sha256: String,
}

pub(crate) fn is_managed_codex_bin(codex_bin: Option<&str>, managed_root: &Path) -> bool {
    let resolved = resolve_codex_command_path(codex_bin);
    match (
        std::fs::canonicalize(resolved),
        std::fs::canonicalize(managed_root),
    ) {
        (Ok(executable), Ok(root)) => executable.starts_with(root),
        _ => false,
    }
}

fn resolve_managed_codex_release(
    release: &GithubRelease,
    platform: &str,
) -> Result<ManagedCodexPackage, String> {
    let version = Version::parse(release.tag_name.trim_start_matches("rust-v"))
        .map_err(|error| format!("Invalid Codex CLI release version: {error}"))?;
    if release.draft || release.prerelease || !version.pre.is_empty() {
        return Err("Codex CLI update requires a stable release.".to_string());
    }
    let target = match platform {
        "windows-x86_64" => "x86_64-pc-windows-msvc",
        "windows-aarch64" => "aarch64-pc-windows-msvc",
        "macos-x86_64" => "x86_64-apple-darwin",
        "macos-aarch64" => "aarch64-apple-darwin",
        "linux-x86_64" => "x86_64-unknown-linux-musl",
        "linux-aarch64" => "aarch64-unknown-linux-musl",
        _ => return Err(format!("Unsupported Codex CLI platform: {platform}")),
    };
    let file_name = format!("codex-package-{target}.tar.gz");
    let asset = release
        .assets
        .iter()
        .find(|asset| asset.name == file_name)
        .ok_or_else(|| format!("Codex CLI release has no complete package for {platform}."))?;
    let expected_url = format!(
        "https://github.com/openai/codex/releases/download/{}/{file_name}",
        release.tag_name,
    );
    if asset.browser_download_url != expected_url || asset.size == 0 {
        return Err("Invalid official Codex CLI package metadata.".to_string());
    }
    let sha256 = asset
        .digest
        .as_deref()
        .and_then(|digest| digest.strip_prefix("sha256:"))
        .filter(|digest| digest.len() == 64 && digest.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .ok_or_else(|| "Codex CLI package has no valid SHA-256 digest.".to_string())?;
    Ok(ManagedCodexPackage {
        version: version.to_string(),
        file_name,
        urls: vec![expected_url],
        size: asset.size,
        sha256: sha256.to_ascii_lowercase(),
    })
}

pub(crate) async fn fetch_managed_codex_package(
    platform: &str,
) -> Result<ManagedCodexPackage, String> {
    let mut errors = Vec::new();
    #[cfg(target_os = "windows")]
    let system_proxy = crate::windows_proxy::resolve_proxy_for_url(CODEX_RELEASE_API.to_string())
        .await
        .unwrap_or_default();
    #[cfg(not(target_os = "windows"))]
    let system_proxy: Option<String> = None;
    let mut routes = Vec::new();
    if let Some(proxy) = system_proxy {
        routes.push((Some(proxy), true));
    }
    routes.extend([(None, false), (None, true)]);
    for (proxy, direct) in routes {
        let mut builder = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(8))
            .timeout(Duration::from_secs(20))
            .user_agent("ThreadFleet");
        if direct {
            builder = builder.no_proxy();
        }
        if let Some(proxy) = proxy {
            match reqwest::Proxy::all(&proxy) {
                Ok(proxy) => builder = builder.proxy(proxy),
                Err(_) => {
                    errors.push("Invalid Windows system proxy configuration.".to_string());
                    continue;
                }
            }
        }
        let client = builder
            .build()
            .map_err(|error| format!("Failed to create Codex CLI release client: {error}"))?;
        match fetch_release_with_client(&client).await {
            Ok(release) => return resolve_managed_codex_release(&release, platform),
            Err(error) => errors.push(error),
        }
    }
    Err(format!(
        "Failed to check official Codex CLI release: {}",
        errors.join(" | ")
    ))
}

async fn fetch_release_with_client(client: &reqwest::Client) -> Result<GithubRelease, String> {
    let mut response = client
        .get(CODEX_RELEASE_API)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|error| error.to_string())?
        .error_for_status()
        .map_err(|error| error.to_string())?;
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|error| error.to_string())? {
        if body.len().saturating_add(chunk.len()) > MAX_RELEASE_BYTES {
            return Err("Codex CLI release response is too large.".to_string());
        }
        body.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&body)
        .map_err(|error| format!("Invalid Codex CLI release response: {error}"))
}

fn write_package_file(
    install_root: &Path,
    relative_path: &Path,
    reader: &mut dyn Read,
    mode: Option<u32>,
) -> Result<PathBuf, String> {
    if relative_path.components().any(|component| {
        matches!(
            component,
            Component::ParentDir | Component::RootDir | Component::Prefix(_)
        )
    }) {
        return Err("Codex CLI package contains an unsafe path.".to_string());
    }
    let target = install_root.join(relative_path);
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("Failed to create Codex CLI package directory: {error}"))?;
    }
    let mut output = std::fs::File::create(&target)
        .map_err(|error| format!("Failed to create Codex CLI package file: {error}"))?;
    std::io::copy(reader, &mut output)
        .map_err(|error| format!("Failed to extract Codex CLI package file: {error}"))?;
    #[cfg(unix)]
    if let Some(mode) = mode {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&target, std::fs::Permissions::from_mode(mode))
            .map_err(|error| format!("Failed to apply Codex CLI package permissions: {error}"))?;
    }
    #[cfg(not(unix))]
    let _ = mode;
    Ok(target)
}

pub(crate) fn extract_managed_codex_archive(
    archive_path: &Path,
    install_root: &Path,
) -> Result<PathBuf, String> {
    let archive_file = std::fs::File::open(archive_path)
        .map_err(|error| format!("Failed to open Codex CLI package: {error}"))?;
    let expected_name = if cfg!(target_os = "windows") {
        "codex.exe"
    } else {
        "codex"
    };
    let mut executable_path = None;
    let mut extracted_bytes = 0u64;
    let mut record_file = |relative_path: &Path, reader: &mut dyn Read, size: u64, mode| {
        extracted_bytes = extracted_bytes.saturating_add(size);
        if extracted_bytes > MAX_EXTRACTED_BYTES {
            return Err("Codex CLI package expands beyond its size limit.".to_string());
        }
        let target = write_package_file(install_root, relative_path, reader, mode)?;
        if relative_path.file_name().and_then(|name| name.to_str()) == Some(expected_name) {
            if executable_path.is_some() {
                return Err("Codex CLI package contains multiple executables.".to_string());
            }
            executable_path = Some(target);
        }
        Ok(())
    };
    if archive_path.to_string_lossy().ends_with(".tar.gz") {
        let mut archive = tar::Archive::new(flate2::read::GzDecoder::new(archive_file));
        for (index, entry) in archive
            .entries()
            .map_err(|error| format!("Invalid Codex CLI package: {error}"))?
            .enumerate()
        {
            if index >= MAX_PACKAGE_ENTRIES {
                return Err("Codex CLI package contains too many entries.".to_string());
            }
            let mut entry =
                entry.map_err(|error| format!("Invalid Codex CLI package entry: {error}"))?;
            if entry.header().entry_type().is_dir() {
                continue;
            }
            if !entry.header().entry_type().is_file() {
                return Err("Codex CLI package contains an unsupported entry.".to_string());
            }
            let relative_path = entry
                .path()
                .map_err(|error| format!("Invalid Codex CLI package path: {error}"))?
                .into_owned();
            let size = entry.size();
            let mode = entry.header().mode().ok();
            record_file(&relative_path, &mut entry, size, mode)?;
        }
    } else {
        let mut archive = zip::ZipArchive::new(archive_file)
            .map_err(|error| format!("Invalid Codex CLI package: {error}"))?;
        if archive.len() > MAX_PACKAGE_ENTRIES {
            return Err("Codex CLI package contains too many entries.".to_string());
        }
        for index in 0..archive.len() {
            let mut entry = archive
                .by_index(index)
                .map_err(|error| format!("Invalid Codex CLI package entry: {error}"))?;
            if entry.is_dir() {
                continue;
            }
            if entry.is_symlink() {
                return Err("Codex CLI package contains an unsupported entry.".to_string());
            }
            let relative_path = entry
                .enclosed_name()
                .ok_or_else(|| "Codex CLI package contains an unsafe path.".to_string())?;
            let size = entry.size();
            let mode = entry.unix_mode();
            record_file(&relative_path, &mut entry, size, mode)?;
        }
    }
    executable_path.ok_or_else(|| format!("Codex CLI package does not contain {expected_name}."))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Cursor, Write};

    fn release_fixture(target: &str) -> GithubRelease {
        let name = format!("codex-package-{target}.tar.gz");
        serde_json::from_value(serde_json::json!({
            "tag_name": "rust-v0.160.1", "html_url": "https://github.com/openai/codex/releases/tag/rust-v0.160.1",
            "draft": false, "prerelease": false,
            "assets": [{ "name": name, "size": 123,
                "browser_download_url": format!("https://github.com/openai/codex/releases/download/rust-v0.160.1/{name}"),
                "digest": format!("sha256:{}", "a".repeat(64)) }]
        })).unwrap()
    }

    #[test]
    fn resolves_complete_official_packages_for_supported_platforms() {
        for (platform, target) in [
            ("windows-x86_64", "x86_64-pc-windows-msvc"),
            ("windows-aarch64", "aarch64-pc-windows-msvc"),
            ("macos-x86_64", "x86_64-apple-darwin"),
            ("macos-aarch64", "aarch64-apple-darwin"),
            ("linux-x86_64", "x86_64-unknown-linux-musl"),
            ("linux-aarch64", "aarch64-unknown-linux-musl"),
        ] {
            let package =
                resolve_managed_codex_release(&release_fixture(target), platform).unwrap();
            assert_eq!(package.version, "0.160.1");
            assert_eq!(package.file_name, format!("codex-package-{target}.tar.gz"));
            assert_eq!(package.sha256, "a".repeat(64));
            assert_eq!(
                serde_json::to_value(&package).unwrap()["fileName"],
                package.file_name
            );
        }
    }

    #[test]
    fn rejects_binary_only_packages_bad_digests_and_untrusted_urls() {
        let mut release = release_fixture("x86_64-pc-windows-msvc");
        release.assets[0].name = "codex-x86_64-pc-windows-msvc.tar.gz".to_string();
        assert!(resolve_managed_codex_release(&release, "windows-x86_64").is_err());
        let mut release = release_fixture("x86_64-pc-windows-msvc");
        release.assets[0].digest = None;
        assert!(resolve_managed_codex_release(&release, "windows-x86_64").is_err());
        let mut release = release_fixture("x86_64-pc-windows-msvc");
        release.assets[0].browser_download_url = "https://example.com/package.tar.gz".to_string();
        assert!(resolve_managed_codex_release(&release, "windows-x86_64").is_err());
        let mut release = release_fixture("x86_64-pc-windows-msvc");
        release.prerelease = true;
        assert!(resolve_managed_codex_release(&release, "windows-x86_64").is_err());
    }

    #[test]
    fn only_classifies_executables_inside_the_app_managed_root() {
        let root =
            std::env::temp_dir().join(format!("threadfleet-managed-test-{}", uuid::Uuid::new_v4()));
        let managed_root = root.join("managed-codex");
        let inside = managed_root.join("0.158.0/bin/codex.exe");
        std::fs::create_dir_all(inside.parent().unwrap()).unwrap();
        std::fs::write(&inside, b"cli").unwrap();
        let outside = root.join("custom-codex.exe");
        std::fs::write(&outside, b"custom").unwrap();
        assert!(is_managed_codex_bin(inside.to_str(), &managed_root));
        assert!(!is_managed_codex_bin(outside.to_str(), &managed_root));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn extracts_complete_tar_package_with_support_files() {
        let root =
            std::env::temp_dir().join(format!("threadfleet-managed-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let archive_path = root.join("package.tar.gz");
        let encoder = flate2::write::GzEncoder::new(
            std::fs::File::create(&archive_path).unwrap(),
            flate2::Compression::default(),
        );
        let mut archive = tar::Builder::new(encoder);
        let executable_name = if cfg!(target_os = "windows") {
            "codex.exe"
        } else {
            "codex"
        };
        for (path, content) in [
            (format!("bin/{executable_name}"), b"cli".as_slice()),
            ("bin/helper.dll".to_string(), b"helper".as_slice()),
            ("share/bridge/module.mjs".to_string(), b"bridge".as_slice()),
        ] {
            let mut header = tar::Header::new_gnu();
            header.set_size(content.len() as u64);
            header.set_mode(0o755);
            header.set_cksum();
            archive
                .append_data(&mut header, path, Cursor::new(content))
                .unwrap();
        }
        archive.into_inner().unwrap().finish().unwrap();
        let install_root = root.join("install");
        let executable = extract_managed_codex_archive(&archive_path, &install_root).unwrap();
        assert_eq!(std::fs::read(executable).unwrap(), b"cli");
        assert_eq!(
            std::fs::read(install_root.join("bin/helper.dll")).unwrap(),
            b"helper"
        );
        assert_eq!(
            std::fs::read(install_root.join("share/bridge/module.mjs")).unwrap(),
            b"bridge"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_archive_paths_outside_the_installation() {
        let root =
            std::env::temp_dir().join(format!("threadfleet-managed-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let archive_path = root.join("package.zip");
        let mut archive = zip::ZipWriter::new(std::fs::File::create(&archive_path).unwrap());
        archive
            .start_file("../escaped", zip::write::SimpleFileOptions::default())
            .unwrap();
        archive.write_all(b"bad").unwrap();
        archive.finish().unwrap();
        assert!(extract_managed_codex_archive(&archive_path, &root.join("install")).is_err());
        assert!(!root.join("escaped").exists());
        std::fs::remove_dir_all(root).unwrap();
    }
}
