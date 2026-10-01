use semver::Version;
use serde::Serialize;
use serde_json::Value;
#[cfg(target_os = "macos")]
use std::process::Command;
use std::process::Stdio;
use std::time::Duration;
use tokio::sync::Mutex;
use tokio::time::timeout;

use crate::backend::app_server::{build_codex_command_with_bin, check_codex_installation};
use crate::types::AppSettings;

const CODEX_DOCTOR_TIMEOUT: Duration = Duration::from_secs(45);

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
pub(crate) struct CodexCliUpdateCheckResult {
    pub(crate) status: CodexCliUpdateCheckStatus,
    pub(crate) installed: bool,
    pub(crate) current_version: Option<String>,
    pub(crate) latest_version: Option<String>,
    pub(crate) platform: String,
    pub(crate) source: Option<String>,
    pub(crate) package: Option<()>,
    pub(crate) reason_code: Option<String>,
}

#[derive(Debug)]
struct CommandOutput {
    success: bool,
    stdout: String,
    stderr: String,
}

fn normalize_codex_version(raw: &str) -> Result<Version, String> {
    raw.split_whitespace()
        .rev()
        .find_map(|token| Version::parse(token.trim_matches(['"', '\'', 'v', 'V'])).ok())
        .ok_or_else(|| format!("Unable to parse Codex CLI version from `{}`.", raw.trim()))
}

fn command_output_details(output: &CommandOutput) -> String {
    let stdout = output.stdout.trim();
    let stderr = output.stderr.trim();
    match (stdout.is_empty(), stderr.is_empty()) {
        (true, true) => "no output".to_string(),
        (false, true) => stdout.to_string(),
        (true, false) => stderr.to_string(),
        (false, false) => format!("{stdout}\n{stderr}"),
    }
}

async fn run_codex_command(
    codex_bin: Option<String>,
    args: Vec<String>,
    timeout_duration: Duration,
) -> Result<CommandOutput, String> {
    let mut command = build_codex_command_with_bin(codex_bin, None, args)?;
    command.stdout(Stdio::piped());
    command.stderr(Stdio::piped());

    let output = match timeout(timeout_duration, command.output()).await {
        Ok(result) => result.map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                "Codex CLI was not found on PATH.".to_string()
            } else {
                format!("Failed to run Codex CLI: {error}")
            }
        })?,
        Err(_) => return Err("Timed out while running Codex CLI.".to_string()),
    };

    Ok(CommandOutput {
        success: output.status.success(),
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
    })
}

fn doctor_update_details(report: &Value) -> Option<&serde_json::Map<String, Value>> {
    report
        .get("checks")
        .and_then(Value::as_object)
        .and_then(|checks| checks.get("updates.status"))
        .and_then(|check| check.get("details"))
        .and_then(Value::as_object)
}

fn doctor_detail<'a>(details: &'a serde_json::Map<String, Value>, key: &str) -> Option<&'a str> {
    details.get(key).and_then(Value::as_str)
}

fn update_source_from_action(action: &str) -> Option<&'static str> {
    let action = action.trim().to_ascii_lowercase();
    if action.starts_with("npm ") {
        return Some("npm");
    }
    if action.starts_with("brew upgrade --cask") {
        return Some("brew_cask");
    }
    if action.starts_with("brew upgrade") {
        return Some("brew_formula");
    }
    if action.starts_with("installer ") || action == "standalone installer" {
        return Some("standalone");
    }
    None
}

fn unsupported_result(
    platform: String,
    current: Version,
    reason_code: &str,
    source: Option<&str>,
) -> CodexCliUpdateCheckResult {
    CodexCliUpdateCheckResult {
        status: CodexCliUpdateCheckStatus::Unsupported,
        installed: true,
        current_version: Some(current.to_string()),
        latest_version: None,
        platform,
        source: source.map(str::to_string),
        package: None,
        reason_code: Some(reason_code.to_string()),
    }
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

pub(crate) fn managed_codex_platform() -> String {
    let architecture = resolve_managed_codex_architecture(
        std::env::consts::OS,
        std::env::consts::ARCH,
        macos_arm64_capable(),
    );
    format!("{}-{architecture}", std::env::consts::OS)
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
    let current_raw = match check_codex_installation(resolved_bin.clone()).await {
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

    let doctor = run_codex_command(
        resolved_bin,
        vec!["doctor".to_string(), "--json".to_string()],
        CODEX_DOCTOR_TIMEOUT,
    )
    .await?;
    if !doctor.success {
        return Err(format!(
            "Codex CLI update check failed: {}",
            command_output_details(&doctor)
        ));
    }
    let report = serde_json::from_str::<Value>(&doctor.stdout)
        .map_err(|error| format!("Codex CLI returned invalid doctor JSON: {error}"))?;
    let details = doctor_update_details(&report)
        .ok_or_else(|| "Codex CLI did not return update metadata.".to_string())?;
    let latest_raw = doctor_detail(details, "latest version")
        .ok_or_else(|| "Codex CLI did not return a latest version.".to_string())?;
    let latest = normalize_codex_version(latest_raw)?;
    let action = doctor_detail(details, "update action").unwrap_or("manual or unknown");
    let source = update_source_from_action(action);

    if latest <= current {
        return Ok(CodexCliUpdateCheckResult {
            status: CodexCliUpdateCheckStatus::UpToDate,
            installed: true,
            current_version: Some(current.to_string()),
            latest_version: Some(latest.to_string()),
            platform,
            source: source.map(str::to_string),
            package: None,
            reason_code: None,
        });
    }

    let Some(source) = source else {
        return Ok(unsupported_result(
            platform,
            current,
            "unsupportedInstallSource",
            None,
        ));
    };

    Ok(CodexCliUpdateCheckResult {
        status: CodexCliUpdateCheckStatus::Available,
        installed: true,
        current_version: Some(current.to_string()),
        latest_version: Some(latest.to_string()),
        platform,
        source: Some(source.to_string()),
        package: None,
        reason_code: None,
    })
}

#[cfg(test)]
mod tests {
    use super::{
        doctor_update_details, normalize_codex_version, resolve_managed_codex_architecture,
        update_source_from_action,
    };

    #[test]
    fn parses_codex_cli_version_output() {
        assert_eq!(
            normalize_codex_version("codex-cli 0.147.0")
                .unwrap()
                .to_string(),
            "0.147.0"
        );
        assert_eq!(
            normalize_codex_version("codex 0.148.0-alpha.15")
                .unwrap()
                .to_string(),
            "0.148.0-alpha.15"
        );
        assert_eq!(
            normalize_codex_version("\"0.149.0\"\n")
                .unwrap()
                .to_string(),
            "0.149.0"
        );
        assert!(normalize_codex_version("codex unknown").is_err());
    }

    #[test]
    fn recognizes_native_update_actions() {
        assert_eq!(
            update_source_from_action("npm install -g @openai/codex"),
            Some("npm")
        );
        assert_eq!(
            update_source_from_action("standalone installer"),
            Some("standalone")
        );
        assert_eq!(
            update_source_from_action("brew upgrade --cask codex"),
            Some("brew_cask")
        );
        assert_eq!(
            update_source_from_action("brew upgrade codex"),
            Some("brew_formula")
        );
        assert_eq!(update_source_from_action("manual or unknown"), None);
    }

    #[test]
    fn reads_update_metadata_from_doctor_report() {
        let report = serde_json::json!({
            "checks": {
                "updates.status": {
                    "details": {
                        "latest version": "0.159.3",
                        "update action": "npm install -g @openai/codex"
                    }
                }
            }
        });
        let details = doctor_update_details(&report).unwrap();
        assert_eq!(details.get("latest version").unwrap(), "0.159.3");
        assert_eq!(
            details.get("update action").unwrap(),
            "npm install -g @openai/codex"
        );
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
}
