#![allow(dead_code)]

use serde_json::Value;
use std::time::Duration;

use tokio::sync::Mutex;
use tokio::time::timeout;

use crate::backend::app_server::{check_codex_installation, resolve_codex_command_path};
use crate::shared::process_core::tokio_command;
use crate::types::AppSettings;

static CODEX_UPDATE_LOCK: Mutex<()> = Mutex::const_new(());

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct CodexUpdateResult {
    ok: bool,
    method: String,
    package: Option<String>,
    before_version: Option<String>,
    after_version: Option<String>,
    upgraded: bool,
    output: Option<String>,
    details: Option<String>,
}

fn trim_lines(value: &str, max_len: usize) -> String {
    let trimmed = value.trim();
    if trimmed.len() <= max_len {
        return trimmed.to_string();
    }

    let mut shortened = trimmed[..max_len].to_string();
    shortened.push_str("…");
    shortened
}

async fn run_brew_check(args: &[&str]) -> Result<bool, String> {
    let mut command = tokio_command("brew");
    command.args(args);
    command.stdout(std::process::Stdio::piped());
    command.stderr(std::process::Stdio::piped());

    let output = match timeout(Duration::from_secs(8), command.output()).await {
        Ok(result) => match result {
            Ok(output) => output,
            Err(err) => {
                if err.kind() == std::io::ErrorKind::NotFound {
                    return Ok(false);
                }
                return Err(err.to_string());
            }
        },
        Err(_) => return Ok(false),
    };

    Ok(output.status.success())
}

async fn detect_brew_cask(name: &str) -> Result<bool, String> {
    run_brew_check(&["list", "--cask", "--versions", name]).await
}

async fn detect_brew_formula(name: &str) -> Result<bool, String> {
    run_brew_check(&["list", "--formula", "--versions", name]).await
}

async fn run_brew_upgrade(args: &[&str]) -> Result<(bool, String), String> {
    let mut command = tokio_command("brew");
    command.arg("upgrade");
    command.args(args);
    command.stdout(std::process::Stdio::piped());
    command.stderr(std::process::Stdio::piped());

    let output = match timeout(Duration::from_secs(60 * 10), command.output()).await {
        Ok(result) => result.map_err(|err| err.to_string())?,
        Err(_) => return Err("Timed out while running `brew upgrade`.".to_string()),
    };

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let combined = format!("{}\n{}", stdout.trim_end(), stderr.trim_end());
    Ok((output.status.success(), combined.trim().to_string()))
}

fn brew_output_indicates_upgrade(output: &str) -> bool {
    let lower = output.to_ascii_lowercase();
    if lower.contains("already up-to-date") {
        return false;
    }
    if lower.contains("already installed") && lower.contains("latest") {
        return false;
    }
    if lower.contains("upgraded") {
        return true;
    }
    if lower.contains("installing") || lower.contains("pouring") {
        return true;
    }
    false
}

async fn npm_has_package(package: &str) -> Result<bool, String> {
    let mut command = tokio_command("npm");
    command.arg("list");
    command.arg("-g");
    command.arg(package);
    command.arg("--depth=0");
    command.stdout(std::process::Stdio::piped());
    command.stderr(std::process::Stdio::piped());

    let output = match timeout(Duration::from_secs(10), command.output()).await {
        Ok(result) => match result {
            Ok(output) => output,
            Err(err) => {
                if err.kind() == std::io::ErrorKind::NotFound {
                    return Ok(false);
                }
                return Err(err.to_string());
            }
        },
        Err(_) => return Ok(false),
    };

    Ok(output.status.success())
}

async fn run_npm_install_latest(package: &str) -> Result<(bool, String), String> {
    let mut command = tokio_command("npm");
    command.arg("install");
    command.arg("-g");
    command.arg(format!("{package}@latest"));
    command.stdout(std::process::Stdio::piped());
    command.stderr(std::process::Stdio::piped());

    let output = match timeout(Duration::from_secs(60 * 10), command.output()).await {
        Ok(result) => result.map_err(|err| err.to_string())?,
        Err(_) => return Err("Timed out while running `npm install -g`.".to_string()),
    };

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let combined = format!("{}\n{}", stdout.trim_end(), stderr.trim_end());
    Ok((output.status.success(), combined.trim().to_string()))
}

fn normalized_path(value: &str) -> String {
    value.replace('\\', "/").to_ascii_lowercase()
}

fn path_is_npm_codex(path: &str) -> bool {
    let normalized = normalized_path(path);
    normalized.contains("/node_modules/@openai/codex/")
        || normalized.ends_with("/npm/codex")
        || normalized.ends_with("/npm/codex.cmd")
        || normalized.ends_with("/npm/codex.ps1")
        || normalized.ends_with("/npm/codex.bat")
}

fn path_is_brew_codex(path: &str) -> bool {
    let normalized = normalized_path(path);
    normalized.contains("/cellar/codex/")
        || normalized.contains("/homebrew/opt/codex/")
        || normalized.contains("/homebrew/bin/codex")
}

fn path_is_managed_codex(path: &str) -> bool {
    let normalized = normalized_path(path);
    normalized.contains("/managed-codex/")
        || normalized.ends_with("/managed-codex/codex")
        || normalized.ends_with("/managed-codex/codex.exe")
}

pub(crate) async fn codex_update_core(
    app_settings: &Mutex<AppSettings>,
    codex_bin: Option<String>,
    codex_args: Option<String>,
) -> Result<Value, String> {
    let _update_guard = CODEX_UPDATE_LOCK.lock().await;
    let (default_bin, default_args) = {
        let settings = app_settings.lock().await;
        (settings.codex_bin.clone(), settings.codex_args.clone())
    };
    let resolved = codex_bin
        .clone()
        .filter(|value| !value.trim().is_empty())
        .or(default_bin);
    let resolved_args = codex_args
        .clone()
        .filter(|value| !value.trim().is_empty())
        .or(default_args);
    let _ = resolved_args;

    let resolved_path = resolve_codex_command_path(resolved.as_deref());
    let path_is_npm = path_is_npm_codex(&resolved_path);
    let path_is_brew = path_is_brew_codex(&resolved_path);
    let path_is_managed = path_is_managed_codex(&resolved_path);

    let before_version = check_codex_installation(resolved.clone())
        .await
        .ok()
        .flatten();

    let (method, package, upgrade_ok, output, upgraded) =
        if path_is_brew && detect_brew_cask("codex").await? {
            let (ok, output) = run_brew_upgrade(&["--cask", "codex"]).await?;
            let upgraded = brew_output_indicates_upgrade(&output);
            (
                "brew_cask".to_string(),
                Some("codex".to_string()),
                ok,
                output,
                upgraded,
            )
        } else if path_is_brew && detect_brew_formula("codex").await? {
            let (ok, output) = run_brew_upgrade(&["codex"]).await?;
            let upgraded = brew_output_indicates_upgrade(&output);
            (
                "brew_formula".to_string(),
                Some("codex".to_string()),
                ok,
                output,
                upgraded,
            )
        } else if (path_is_npm || path_is_managed) && npm_has_package("@openai/codex").await? {
            let (ok, output) = run_npm_install_latest("@openai/codex").await?;
            (
                "npm".to_string(),
                Some("@openai/codex".to_string()),
                ok,
                output,
                ok,
            )
        } else {
            ("unknown".to_string(), None, false, String::new(), false)
        };

    let verification_bin = if method == "npm" && path_is_managed {
        Some(resolve_codex_command_path(None))
    } else {
        resolved.clone()
    };
    let after_version = if method == "unknown" {
        None
    } else {
        match check_codex_installation(verification_bin).await {
            Ok(version) => version,
            Err(err) => {
                let result = CodexUpdateResult {
                    ok: false,
                    method,
                    package,
                    before_version,
                    after_version: None,
                    upgraded,
                    output: Some(trim_lines(&output, 8000)),
                    details: Some(err),
                };
                return serde_json::to_value(result).map_err(|e| e.to_string());
            }
        }
    };

    let details = if method == "unknown" {
        Some(format!(
            "Unable to update the selected Codex CLI in place (resolved path: {resolved_path}). Select the package-manager installation or update this custom CLI manually."
        ))
    } else if upgrade_ok {
        None
    } else {
        Some("Codex update failed.".to_string())
    };

    let result = CodexUpdateResult {
        ok: upgrade_ok,
        method,
        package,
        before_version,
        after_version,
        upgraded,
        output: Some(trim_lines(&output, 8000)),
        details,
    };

    serde_json::to_value(result).map_err(|err| err.to_string())
}

#[cfg(test)]
mod tests {
    use super::{path_is_brew_codex, path_is_managed_codex, path_is_npm_codex};

    #[test]
    fn recognizes_npm_and_managed_codex_paths() {
        assert!(path_is_npm_codex(
            r"C:\Users\user\AppData\Roaming\npm\codex.ps1"
        ));
        assert!(path_is_npm_codex(
            r"C:\Users\user\AppData\Roaming\npm\node_modules\@openai\codex\bin\codex.js"
        ));
        assert!(path_is_managed_codex(
            r"C:\Users\user\AppData\Roaming\com.dimillian.codexmonitor\managed-codex\0.156.1\bin\codex.exe"
        ));
        assert!(!path_is_npm_codex(r"C:\Tools\codex.exe"));
    }

    #[test]
    fn recognizes_homebrew_codex_paths() {
        assert!(path_is_brew_codex(
            "/opt/homebrew/Cellar/codex/0.157.0/bin/codex"
        ));
        assert!(path_is_brew_codex("/opt/homebrew/bin/codex"));
        assert!(!path_is_brew_codex("/usr/local/bin/custom-codex"));
    }
}
