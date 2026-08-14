use semver::Version;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
#[cfg(target_os = "macos")]
use std::process::Command;
use std::time::Duration;
use tokio::sync::Mutex;

use crate::backend::app_server::check_codex_installation;
use crate::types::AppSettings;

const DEFAULT_MANIFEST_URL: &str =
    "https://github.com/wzxmer/ThreadFleet/releases/latest/download/codex-cli-latest.json";
const MANIFEST_RESPONSE_MAX_BYTES: usize = 1024 * 1024;
const TENCENT_MANIFEST_URL: Option<&str> =
    option_env!("VITE_TENCENT_CODEX_CLI_MANIFEST_URL");
const ALIYUN_MANIFEST_URL: Option<&str> = option_env!("VITE_ALIYUN_CODEX_CLI_MANIFEST_URL");

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum CodexCliUpdateCheckStatus {
    Available,
    UpToDate,
    NotInstalled,
    Unsupported,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ManagedCodexPackage {
    pub(crate) version: String,
    pub(crate) file_name: String,
    pub(crate) urls: Vec<String>,
    pub(crate) size: u64,
    pub(crate) sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CodexCliUpdateCheckResult {
    pub(crate) status: CodexCliUpdateCheckStatus,
    pub(crate) installed: bool,
    pub(crate) current_version: Option<String>,
    pub(crate) latest_version: Option<String>,
    pub(crate) platform: String,
    pub(crate) source: Option<String>,
    pub(crate) package: Option<ManagedCodexPackage>,
    pub(crate) reason_code: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ManagedCodexManifest {
    version: Option<String>,
    packages: Option<std::collections::HashMap<String, ManagedCodexManifestPackage>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManagedCodexManifestPackage {
    file_name: Option<String>,
    urls: Option<Vec<String>>,
    size: Option<u64>,
    sha256: Option<String>,
}

fn normalize_codex_version(raw: &str) -> Result<Version, String> {
    raw.split_whitespace()
        .rev()
        .find_map(|token| Version::parse(token.trim_start_matches(['v', 'V'])).ok())
        .ok_or_else(|| format!("Unable to parse Codex CLI version from `{}`.", raw.trim()))
}

pub(crate) fn resolve_managed_codex_architecture(
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
        None if matches!(process_architecture, "x86_64" | "amd64" | "x64") => {
            "x86_64".to_string()
        }
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

pub(crate) fn managed_codex_platform() -> String {
    let architecture = resolve_managed_codex_architecture(
        std::env::consts::OS,
        std::env::consts::ARCH,
        macos_arm64_capable(),
    );
    format!("{}-{architecture}", std::env::consts::OS)
}

fn manifest_routes_from(
    tencent_url: Option<&str>,
    aliyun_url: Option<&str>,
) -> Vec<(String, String)> {
    let mut seen = HashSet::new();
    [
        ("tencent", tencent_url),
        ("aliyun", aliyun_url),
        ("github", Some(DEFAULT_MANIFEST_URL)),
    ]
    .into_iter()
    .filter_map(|(source, url)| {
        let url = url?.trim();
        if !url.starts_with("https://") || !seen.insert(url.to_string()) {
            return None;
        }
        Some((source.to_string(), url.to_string()))
    })
    .collect()
}

fn manifest_routes() -> Vec<(String, String)> {
    manifest_routes_from(TENCENT_MANIFEST_URL, ALIYUN_MANIFEST_URL)
}

fn parse_manifest_package(
    manifest: ManagedCodexManifest,
    platform: &str,
) -> Result<ManagedCodexPackage, String> {
    let version = manifest
        .version
        .map(|value| value.trim().trim_start_matches(['v', 'V']).to_string())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Managed Codex manifest version is missing.".to_string())?;
    Version::parse(&version)
        .map_err(|error| format!("Invalid managed Codex version `{version}`: {error}"))?;
    let package = manifest
        .packages
        .and_then(|packages| packages.into_iter().find(|(key, _)| key == platform))
        .map(|(_, package)| package)
        .ok_or_else(|| format!("Managed Codex package is unavailable for `{platform}`."))?;
    let file_name = package
        .file_name
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Managed Codex package file name is missing.".to_string())?;
    if !file_name.to_ascii_lowercase().ends_with(".zip") {
        return Err("Managed Codex package must be a ZIP archive.".to_string());
    }
    let urls = package
        .urls
        .unwrap_or_default()
        .into_iter()
        .map(|value| value.trim().to_string())
        .filter(|value| value.starts_with("https://"))
        .collect::<Vec<_>>();
    if urls.is_empty() {
        return Err("Managed Codex package has no HTTPS download route.".to_string());
    }
    let size = package
        .size
        .filter(|size| *size > 0)
        .ok_or_else(|| "Managed Codex package size is invalid.".to_string())?;
    let sha256 = package
        .sha256
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| value.len() == 64 && value.chars().all(|ch| ch.is_ascii_hexdigit()))
        .ok_or_else(|| "Managed Codex package checksum is invalid.".to_string())?;

    Ok(ManagedCodexPackage {
        version,
        file_name,
        urls,
        size,
        sha256,
    })
}

async fn fetch_managed_codex_package(
    platform: &str,
) -> Result<(ManagedCodexPackage, String), String> {
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|error| format!("Failed to create Codex update client: {error}"))?;
    let mut errors = Vec::new();
    for (source, url) in manifest_routes() {
        let result = async {
            let response = client
                .get(&url)
                .header(reqwest::header::ACCEPT, "application/json")
                .send()
                .await
                .map_err(|error| error.to_string())?;
            if !response.status().is_success() {
                return Err(format!("HTTP {}", response.status()));
            }
            if response
                .content_length()
                .is_some_and(|size| size > MANIFEST_RESPONSE_MAX_BYTES as u64)
            {
                return Err("response is too large".to_string());
            }
            let bytes = response.bytes().await.map_err(|error| error.to_string())?;
            if bytes.len() > MANIFEST_RESPONSE_MAX_BYTES {
                return Err("response is too large".to_string());
            }
            let manifest = serde_json::from_slice::<ManagedCodexManifest>(&bytes)
                .map_err(|error| format!("invalid JSON: {error}"))?;
            parse_manifest_package(manifest, platform)
        }
        .await;
        match result {
            Ok(package) => return Ok((package, source)),
            Err(error) => errors.push(format!("{source}: {error}")),
        }
    }
    Err(format!(
        "All Codex CLI update metadata routes failed: {}",
        errors.join(" | ")
    ))
}

pub(crate) async fn check_codex_cli_update_core(
    app_settings: &Mutex<AppSettings>,
    codex_bin: Option<String>,
) -> Result<CodexCliUpdateCheckResult, String> {
    let default_bin = app_settings.lock().await.codex_bin.clone();
    let resolved_bin = codex_bin
        .filter(|value| !value.trim().is_empty())
        .or(default_bin);
    let platform = managed_codex_platform();
    let current_raw = match check_codex_installation(resolved_bin).await {
        Ok(Some(version)) => version,
        Ok(None) => {
            return Ok(CodexCliUpdateCheckResult {
                status: CodexCliUpdateCheckStatus::NotInstalled,
                installed: false,
                current_version: None,
                latest_version: None,
                platform,
                source: None,
                package: None,
                reason_code: Some("missingCodexCli".to_string()),
            });
        }
        Err(error) if error.to_ascii_lowercase().contains("not found") => {
            return Ok(CodexCliUpdateCheckResult {
                status: CodexCliUpdateCheckStatus::NotInstalled,
                installed: false,
                current_version: None,
                latest_version: None,
                platform,
                source: None,
                package: None,
                reason_code: Some("missingCodexCli".to_string()),
            });
        }
        Err(error) => return Err(error),
    };
    let current = normalize_codex_version(&current_raw)?;
    if platform.ends_with("-unknown") {
        return Ok(CodexCliUpdateCheckResult {
            status: CodexCliUpdateCheckStatus::Unsupported,
            installed: true,
            current_version: Some(current.to_string()),
            latest_version: None,
            platform,
            source: None,
            package: None,
            reason_code: Some("unsupportedArchitecture".to_string()),
        });
    }
    let (package, source) = fetch_managed_codex_package(&platform).await?;
    let latest = Version::parse(&package.version)
        .map_err(|error| format!("Invalid managed Codex version: {error}"))?;
    let status = if latest > current {
        CodexCliUpdateCheckStatus::Available
    } else {
        CodexCliUpdateCheckStatus::UpToDate
    };
    Ok(CodexCliUpdateCheckResult {
        status,
        installed: true,
        current_version: Some(current.to_string()),
        latest_version: Some(latest.to_string()),
        platform,
        source: Some(source),
        package: Some(package),
        reason_code: None,
    })
}

#[cfg(test)]
mod tests {
    use super::{
        manifest_routes_from, normalize_codex_version, parse_manifest_package,
        resolve_managed_codex_architecture, ManagedCodexManifest,
    };

    #[test]
    fn parses_codex_cli_version_output() {
        assert_eq!(
            normalize_codex_version("codex-cli 0.147.0").unwrap().to_string(),
            "0.147.0"
        );
        assert_eq!(
            normalize_codex_version("codex 0.148.0-alpha.15")
                .unwrap()
                .to_string(),
            "0.148.0-alpha.15"
        );
        assert!(normalize_codex_version("codex unknown").is_err());
    }

    #[test]
    fn resolves_macos_hardware_architecture_under_rosetta() {
        assert_eq!(
            resolve_managed_codex_architecture("macos", "x86_64", Some(true)),
            "aarch64"
        );
        assert_eq!(
            resolve_managed_codex_architecture("macos", "x86_64", Some(false)),
            "x86_64"
        );
        assert_eq!(
            resolve_managed_codex_architecture("windows", "x86_64", Some(true)),
            "x86_64"
        );
        assert_eq!(
            resolve_managed_codex_architecture("macos", "riscv64", None),
            "unknown"
        );
    }

    #[test]
    fn accepts_only_complete_platform_packages() {
        let manifest = serde_json::from_value::<ManagedCodexManifest>(serde_json::json!({
            "version": "0.147.0",
            "packages": {
                "windows-x86_64": {
                    "fileName": "codex-cli-0.147.0-windows-x86_64.zip",
                    "urls": ["https://download.example/codex.zip"],
                    "size": 42,
                    "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
                }
            }
        }))
        .unwrap();
        let package = parse_manifest_package(manifest, "windows-x86_64").unwrap();
        assert_eq!(package.version, "0.147.0");
        assert_eq!(package.size, 42);
    }

    #[test]
    fn rejects_missing_platform_package() {
        let manifest = serde_json::from_value::<ManagedCodexManifest>(serde_json::json!({
            "version": "0.147.0",
            "packages": {}
        }))
        .unwrap();
        assert!(parse_manifest_package(manifest, "macos-aarch64")
            .unwrap_err()
            .contains("unavailable"));
    }

    #[test]
    fn prefers_domestic_routes_and_deduplicates_before_github() {
        let routes = manifest_routes_from(
            Some("https://cos.example/codex-cli-latest.json"),
            Some("https://oss.example/codex-cli-latest.json"),
        );
        assert_eq!(routes[0].0, "tencent");
        assert_eq!(routes[1].0, "aliyun");
        assert_eq!(routes[2].0, "github");

        let duplicate = manifest_routes_from(
            Some("https://mirror.example/codex-cli-latest.json"),
            Some("https://mirror.example/codex-cli-latest.json"),
        );
        assert_eq!(duplicate.len(), 2);
        assert_eq!(duplicate[0].0, "tencent");
        assert_eq!(duplicate[1].0, "github");

        let insecure = manifest_routes_from(
            Some("http://cos.example/codex-cli-latest.json"),
            None,
        );
        assert_eq!(insecure.len(), 1);
        assert_eq!(insecure[0].0, "github");
    }
}
