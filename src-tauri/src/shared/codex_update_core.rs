#![allow(dead_code)]

use serde_json::Value;
use std::process::Stdio;
use std::time::Duration;

use tokio::sync::Mutex;
use tokio::time::timeout;

use crate::backend::app_server::{build_codex_command_with_bin, check_codex_installation};
use crate::types::AppSettings;

const CODEX_UPDATE_TIMEOUT: Duration = Duration::from_secs(60 * 10);

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

async fn run_codex_update(codex_bin: Option<String>) -> Result<(bool, String), String> {
    let mut command = build_codex_command_with_bin(codex_bin, None, vec!["update".to_string()])?;
    command.stdout(Stdio::piped());
    command.stderr(Stdio::piped());

    let output = match timeout(CODEX_UPDATE_TIMEOUT, command.output()).await {
        Ok(result) => result.map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                "Codex CLI was not found on PATH.".to_string()
            } else {
                format!("Failed to run `codex update`: {error}")
            }
        })?,
        Err(_) => return Err("Timed out while running `codex update`.".to_string()),
    };

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let combined = format!("{}\n{}", stdout.trim_end(), stderr.trim_end());
    Ok((output.status.success(), combined.trim().to_string()))
}

pub(crate) async fn codex_update_core(
    app_settings: &Mutex<AppSettings>,
    codex_bin: Option<String>,
    _codex_args: Option<String>,
) -> Result<Value, String> {
    let _update_guard = CODEX_UPDATE_LOCK.lock().await;
    let default_bin = app_settings.lock().await.codex_bin.clone();
    let resolved = codex_bin
        .filter(|value| !value.trim().is_empty())
        .or(default_bin);

    let before_version = check_codex_installation(resolved.clone())
        .await
        .ok()
        .flatten();
    let (upgrade_ok, output) = run_codex_update(resolved.clone()).await?;
    let after_version = match check_codex_installation(resolved).await {
        Ok(version) => version,
        Err(_error) if !upgrade_ok => None,
        Err(error) => {
            let result = CodexUpdateResult {
                ok: false,
                method: "codex".to_string(),
                package: None,
                before_version,
                after_version: None,
                upgraded: false,
                output: Some(trim_lines(&output, 8000)),
                details: Some(error),
            };
            return serde_json::to_value(result).map_err(|e| e.to_string());
        }
    };
    let upgraded = match (&before_version, &after_version) {
        (Some(before), Some(after)) => before != after,
        (None, Some(_)) => true,
        _ => upgrade_ok,
    };

    let details = if upgrade_ok {
        None
    } else if output.is_empty() {
        Some("`codex update` failed.".to_string())
    } else {
        Some(trim_lines(&output, 8000))
    };
    let result = CodexUpdateResult {
        ok: upgrade_ok,
        method: "codex".to_string(),
        package: None,
        before_version,
        after_version,
        upgraded,
        output: Some(trim_lines(&output, 8000)),
        details,
    };

    serde_json::to_value(result).map_err(|err| err.to_string())
}
