use base64::{
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
    Engine as _,
};
use futures_util::future::join4;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::sync::oneshot::error::TryRecvError;
use tokio::sync::{oneshot, Mutex};
use tokio::time::timeout;
use tokio::time::Instant;

use crate::backend::app_server::WorkspaceSession;
use crate::codex::config as codex_config;
use crate::codex::home::{
    resolve_default_codex_home, resolve_home_dir, resolve_workspace_codex_home,
};
use crate::rules;
use crate::shared::account::{build_account_response, read_auth_account, read_auth_api_key};
use crate::shared::computer_control_core::{
    attach_computer_control_context, build_capability_snapshot, classify_computer_control_task,
    effective_plugin_enabled, infer_computer_control_task_signals,
    normalize_browser_backend_capability, normalize_browser_runtime_evidence,
    normalize_mcp_server_capability_with_identity, normalize_plugin_management_status,
    normalize_skill_availability, route_computer_control, snapshot_is_fresh,
    BrowserBackendEvidence, ComputerControlAvailability, ComputerControlBackend,
    ComputerControlBackendCapability, ComputerControlCapabilitySnapshot,
    ComputerControlRouteDecision, ComputerControlRouteRequest, ComputerControlSnapshotInput,
    ComputerControlTaskKind, McpServerStatusListResponse, PluginListResponse, SkillsListResponse,
    BROWSER_PLUGIN_ID, BROWSER_SKILL_NAME, CHROME_PLUGIN_ID, CHROME_SKILL_NAME,
    COMPUTER_USE_PLUGIN_ID, NODE_REPL_SERVER_NAME, WINDOWS_UI_SERVER_NAME,
};
use crate::shared::{config_toml_core, provider_profiles_core, workflow_registry_core};
use crate::types::{AppSettings, WorkspaceEntry};

const LOGIN_START_TIMEOUT: Duration = Duration::from_secs(30);
const TURN_INTERRUPT_CONFIRM_TIMEOUT: Duration = Duration::from_secs(3);
#[allow(dead_code)]
const MAX_INLINE_IMAGE_BYTES: u64 = 50 * 1024 * 1024;
const MAX_INLINE_TEXT_ATTACHMENT_BYTES: usize = 1024 * 1024;
const THREAD_LIST_SOURCE_KINDS: &[&str] = &[
    "cli",
    "vscode",
    "appServer",
    "subAgentReview",
    "subAgentCompact",
    "subAgentThreadSpawn",
    "unknown",
];
const LOCAL_CODEX_WORKSPACE_ID: &str = "__local_codex_sessions__";
// MCP discovery can cross the ten-second mark on a cold app-server start while
// its child servers initialize. Keep this below the session request timeout,
// but leave enough headroom for the real startup path.
const COMPUTER_CONTROL_PROBE_TIMEOUT: Duration = Duration::from_secs(20);
const THREAD_HISTORY_PAGE_DEFAULT_ITEMS: usize = 250;
const THREAD_HISTORY_PAGE_MAX_ITEMS: usize = 500;
const THREAD_HISTORY_PAGE_DEFAULT_BYTES: usize = 8 * 1024 * 1024;
const THREAD_HISTORY_PAGE_MAX_BYTES: usize = 16 * 1024 * 1024;

#[allow(dead_code)]
fn image_extension_for_path(path: &str) -> Option<String> {
    Path::new(path)
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase())
}

#[allow(dead_code)]
fn image_mime_type_for_path(path: &str) -> Option<&'static str> {
    let extension = image_extension_for_path(path)?;
    match extension.as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        "bmp" => Some("image/bmp"),
        "tiff" | "tif" => Some("image/tiff"),
        _ => None,
    }
}

#[allow(dead_code)]
fn should_inline_image_path_for_codex(path: &str) -> bool {
    matches!(
        image_extension_for_path(path).as_deref(),
        Some("heic") | Some("heif")
    )
}

#[cfg(target_os = "macos")]
fn temp_converted_image_path(path: &str, extension: &str) -> PathBuf {
    let stem = Path::new(path)
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("image");
    let safe_stem = stem
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { '-' })
        .collect::<String>();
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_millis())
        .unwrap_or_default();
    std::env::temp_dir().join(format!("codex-monitor-image-{safe_stem}-{ts}.{extension}"))
}

#[cfg(target_os = "macos")]
fn convert_heif_image_to_jpeg_bytes(path: &str) -> Result<Vec<u8>, String> {
    let output_path = temp_converted_image_path(path, "jpg");
    let status = std::process::Command::new("/usr/bin/sips")
        .args(["-s", "format", "jpeg"])
        .arg(path)
        .arg("--out")
        .arg(&output_path)
        .status()
        .map_err(|err| format!("Failed to launch HEIC/HEIF conversion for {path}: {err}"))?;
    if !status.success() {
        let _ = std::fs::remove_file(&output_path);
        return Err(format!(
            "Failed to convert HEIC/HEIF image into a Codex-compatible JPEG: {path}"
        ));
    }
    let bytes = std::fs::read(&output_path).map_err(|err| {
        format!(
            "Failed to read converted JPEG for {path} at {}: {err}",
            output_path.display()
        )
    })?;
    let _ = std::fs::remove_file(&output_path);
    if bytes.is_empty() {
        return Err(format!(
            "Converted JPEG is empty after HEIC/HEIF conversion: {path}"
        ));
    }
    Ok(bytes)
}

#[allow(dead_code)]
pub(crate) fn normalize_file_path(raw: &str) -> String {
    let path = raw.trim();
    let file_uri_path = path
        .strip_prefix("file://localhost")
        .or_else(|| path.strip_prefix("file://"));
    let Some(path) = file_uri_path else {
        return path.to_string();
    };

    percent_decode_lossy(path)
}

fn percent_decode_lossy(value: &str) -> String {
    let mut decoded = Vec::with_capacity(value.len());
    let bytes = value.as_bytes();
    let mut index = 0usize;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            let hi = bytes[index + 1];
            let lo = bytes[index + 2];
            let hi_value = match hi {
                b'0'..=b'9' => Some(hi - b'0'),
                b'a'..=b'f' => Some(hi - b'a' + 10),
                b'A'..=b'F' => Some(hi - b'A' + 10),
                _ => None,
            };
            let lo_value = match lo {
                b'0'..=b'9' => Some(lo - b'0'),
                b'a'..=b'f' => Some(lo - b'a' + 10),
                b'A'..=b'F' => Some(lo - b'A' + 10),
                _ => None,
            };
            if let (Some(hi_nibble), Some(lo_nibble)) = (hi_value, lo_value) {
                decoded.push((hi_nibble << 4) | lo_nibble);
                index += 3;
                continue;
            }
        }
        decoded.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&decoded).into_owned()
}

#[allow(dead_code)]
pub(crate) fn read_image_as_data_url_core(path: &str) -> Result<String, String> {
    let trimmed_path = normalize_file_path(path);
    if trimmed_path.is_empty() {
        return Err("Image path is required".to_string());
    }
    if should_inline_image_path_for_codex(&trimmed_path) {
        #[cfg(target_os = "macos")]
        {
            let encoded = STANDARD.encode(convert_heif_image_to_jpeg_bytes(&trimmed_path)?);
            return Ok(format!("data:image/jpeg;base64,{encoded}"));
        }
        #[cfg(not(target_os = "macos"))]
        {
            return Err(format!(
                "HEIC/HEIF images are not supported on this platform; convert to JPEG or PNG first: {trimmed_path}"
            ));
        }
    }
    let mime_type = image_mime_type_for_path(&trimmed_path).ok_or_else(|| {
        format!("Unsupported or missing image extension for path: {trimmed_path}")
    })?;
    let metadata = std::fs::symlink_metadata(&trimmed_path)
        .map_err(|err| format!("Failed to stat image file at {trimmed_path}: {err}"))?;
    if metadata.file_type().is_symlink() {
        return Err(format!("Image path must not be a symlink: {trimmed_path}"));
    }
    if !metadata.is_file() {
        return Err(format!("Image path is not a file: {trimmed_path}"));
    }
    if metadata.len() > MAX_INLINE_IMAGE_BYTES {
        return Err(format!(
            "Image file exceeds maximum size of {MAX_INLINE_IMAGE_BYTES} bytes: {trimmed_path}"
        ));
    }
    let bytes = std::fs::read(&trimmed_path)
        .map_err(|err| format!("Failed to read image file at {trimmed_path}: {err}"))?;
    if bytes.is_empty() {
        return Err(format!("Image file is empty: {trimmed_path}"));
    }
    let encoded = STANDARD.encode(bytes);
    Ok(format!("data:{mime_type};base64,{encoded}"))
}

pub(crate) enum CodexLoginCancelState {
    PendingStart(oneshot::Sender<()>),
    LoginId(String),
}

async fn get_session_clone(
    sessions: &Mutex<HashMap<String, Arc<WorkspaceSession>>>,
    workspace_id: &str,
) -> Result<Arc<WorkspaceSession>, String> {
    let session = {
        let sessions = sessions.lock().await;
        if let Some(session) = sessions.get(workspace_id).cloned() {
            Some(session)
        } else if workspace_id == LOCAL_CODEX_WORKSPACE_ID {
            sessions.values().next().cloned()
        } else {
            None
        }
    };
    if let Some(session) = session {
        if session.is_process_alive().await {
            return Ok(session);
        }
        let mut sessions = sessions.lock().await;
        sessions.retain(|_, candidate| !Arc::ptr_eq(candidate, &session));
    }
    Err("workspace not connected".to_string())
}

fn data_url_attachment_name(meta: &str) -> String {
    meta.split(';')
        .find_map(|part| part.strip_prefix("name="))
        .map(|value| value.trim_matches('"').to_string())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "pasted-file".to_string())
}

fn parse_text_attachment_data_url(input: &str) -> Result<Option<(String, String)>, String> {
    let Some(rest) = input.strip_prefix("data:") else {
        return Ok(None);
    };
    let Some((meta, encoded)) = rest.split_once(',') else {
        return Err("Invalid attachment data URL".to_string());
    };
    if meta.starts_with("image/") {
        return Ok(None);
    }
    let name = data_url_attachment_name(meta);
    let bytes = if meta
        .split(';')
        .any(|part| part.eq_ignore_ascii_case("base64"))
    {
        STANDARD
            .decode(encoded.as_bytes())
            .map_err(|err| format!("Failed to decode pasted attachment: {err}"))?
    } else {
        percent_decode_lossy(encoded).into_bytes()
    };
    if bytes.len() > MAX_INLINE_TEXT_ATTACHMENT_BYTES {
        return Err(format!(
            "Attachment is too large to inline as text: {name} (max 1 MB)"
        ));
    }
    if bytes.iter().any(|byte| *byte == 0) {
        return Err(format!(
            "Attachment is binary and cannot be inlined as text: {name}"
        ));
    }
    let content = String::from_utf8(bytes)
        .map_err(|_| format!("Attachment is not valid UTF-8 text: {name}"))?;
    Ok(Some((name, content)))
}

fn read_text_attachment_path(path: &str) -> Result<(String, String, bool), String> {
    let normalized = normalize_file_path(path);
    let target = PathBuf::from(&normalized);
    let name = target
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(normalized.as_str())
        .to_string();
    let mut file = std::fs::File::open(&target)
        .map_err(|err| format!("Failed to open attachment {normalized}: {err}"))?;
    let mut bytes = Vec::new();
    file.by_ref()
        .take((MAX_INLINE_TEXT_ATTACHMENT_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|err| format!("Failed to read attachment {normalized}: {err}"))?;
    let truncated = bytes.len() > MAX_INLINE_TEXT_ATTACHMENT_BYTES;
    if truncated {
        bytes.truncate(MAX_INLINE_TEXT_ATTACHMENT_BYTES);
    }
    if bytes.iter().any(|byte| *byte == 0) {
        return Err(format!(
            "Attachment is binary and cannot be inlined as text: {normalized}"
        ));
    }
    let mut content = String::from_utf8(bytes)
        .map_err(|_| format!("Attachment is not valid UTF-8 text: {normalized}"))?;
    if truncated {
        content.push_str("\n\n[Attachment truncated after 1 MB]");
    }
    Ok((name, content, truncated))
}

fn build_text_attachment_item(name: &str, content: &str, truncated: bool) -> Value {
    let truncated_note = if truncated { " truncated=\"true\"" } else { "" };
    json!({
        "type": "text",
        "text": format!(
            "<attached_file name=\"{}\"{}>\n{}\n</attached_file>",
            name.replace('"', "&quot;"),
            truncated_note,
            content
        )
    })
}

async fn resolve_workspace_and_parent(
    workspaces: &Mutex<HashMap<String, WorkspaceEntry>>,
    workspace_id: &str,
) -> Result<(WorkspaceEntry, Option<WorkspaceEntry>), String> {
    let workspaces = workspaces.lock().await;
    let entry = workspaces
        .get(workspace_id)
        .cloned()
        .ok_or_else(|| "workspace not found".to_string())?;
    let parent_entry = entry
        .parent_id
        .as_ref()
        .and_then(|parent_id| workspaces.get(parent_id))
        .cloned();
    Ok((entry, parent_entry))
}

async fn resolve_codex_home_for_workspace_core(
    workspaces: &Mutex<HashMap<String, WorkspaceEntry>>,
    workspace_id: &str,
) -> Result<PathBuf, String> {
    if workspace_id == LOCAL_CODEX_WORKSPACE_ID {
        return resolve_default_codex_home()
            .ok_or_else(|| "Unable to resolve CODEX_HOME".to_string());
    }
    let (entry, parent_entry) = resolve_workspace_and_parent(workspaces, workspace_id).await?;
    resolve_workspace_codex_home(&entry, parent_entry.as_ref())
        .or_else(resolve_default_codex_home)
        .ok_or_else(|| "Unable to resolve CODEX_HOME".to_string())
}

async fn resolve_workspace_path_core(
    workspaces: &Mutex<HashMap<String, WorkspaceEntry>>,
    workspace_id: &str,
) -> Result<String, String> {
    if workspace_id == LOCAL_CODEX_WORKSPACE_ID {
        return Ok(resolve_home_dir()
            .or_else(|| std::env::current_dir().ok())
            .unwrap_or_else(|| ".".into())
            .to_string_lossy()
            .to_string());
    }
    let workspaces = workspaces.lock().await;
    let entry = workspaces
        .get(workspace_id)
        .ok_or_else(|| "workspace not found".to_string())?;
    Ok(entry.path.clone())
}

fn build_read_thread_params(thread_id: String) -> Value {
    json!({ "threadId": thread_id, "includeTurns": true })
}

fn build_read_thread_metadata_params(thread_id: &str) -> Value {
    json!({ "threadId": thread_id, "includeTurns": false })
}

const MAX_ROLLOUT_TOOL_ARGUMENT_CHARS: usize = 200_000;
const MAX_ROLLOUT_TOOL_OUTPUT_CHARS: usize = 20_000;
const MAX_ROLLOUT_MESSAGE_CHARS: usize = 20_000;

#[derive(Default)]
struct RolloutThreadEnrichment {
    turns: HashMap<String, RolloutTurnEnrichment>,
    pending_tools: HashMap<String, (String, usize)>,
}

#[derive(Default)]
struct RolloutTurnEnrichment {
    message_timestamps: Vec<(String, String)>,
    sequence: Vec<RolloutSequenceItem>,
}

enum RolloutSequenceItem {
    Anchor {
        id: Option<String>,
        item_type: &'static str,
    },
    AgentMessage(Value),
    DynamicTool(Value),
}

fn truncate_rollout_text(value: &str, max_chars: usize) -> String {
    let mut chars = value.chars();
    let prefix: String = chars.by_ref().take(max_chars).collect();
    if chars.next().is_none() {
        prefix
    } else {
        format!("{prefix}...")
    }
}

fn normalize_rollout_tool_status(status: Option<&str>) -> &'static str {
    match status.unwrap_or_default() {
        "failed" | "error" => "failed",
        "inProgress" | "in_progress" | "running" => "inProgress",
        _ => "completed",
    }
}

fn rollout_apply_patch_line_stats(input: Option<&str>) -> Value {
    let Some(input) = input.filter(|value| value.contains("*** Begin Patch")) else {
        return Value::Null;
    };
    let mut additions = 0usize;
    let mut deletions = 0usize;
    let mut inside_patch = false;
    for line in input.lines() {
        if line.contains("*** Begin Patch") {
            inside_patch = true;
            continue;
        }
        if line.contains("*** End Patch") {
            inside_patch = false;
            continue;
        }
        if !inside_patch || line.starts_with("+++") || line.starts_with("---") {
            continue;
        }
        if line.starts_with('+') {
            additions += 1;
        } else if line.starts_with('-') {
            deletions += 1;
        }
    }
    if additions == 0 && deletions == 0 {
        Value::Null
    } else {
        json!({ "additions": additions, "deletions": deletions })
    }
}

fn rollout_tool_arguments(payload: &Value, field: &str) -> Value {
    let Some(raw) = payload.get(field) else {
        return Value::Null;
    };
    let Some(text) = raw.as_str() else {
        return raw.clone();
    };
    let text = truncate_rollout_text(text, MAX_ROLLOUT_TOOL_ARGUMENT_CHARS);
    serde_json::from_str(&text).unwrap_or(Value::String(text))
}

fn rollout_tool_content_items(output: Option<&Value>) -> Vec<Value> {
    let Some(output) = output else {
        return Vec::new();
    };
    let raw_items = output
        .as_array()
        .cloned()
        .unwrap_or_else(|| vec![output.clone()]);
    raw_items
        .into_iter()
        .filter_map(|item| {
            if let Some(text) = item.get("text").and_then(Value::as_str) {
                return Some(json!({
                    "type": "inputText",
                    "text": truncate_rollout_text(text, MAX_ROLLOUT_TOOL_OUTPUT_CHARS)
                }));
            }
            if let Some(image_url) = item
                .get("image_url")
                .or_else(|| item.get("imageUrl"))
                .and_then(Value::as_str)
            {
                return Some(json!({ "type": "inputImage", "imageUrl": image_url }));
            }
            item.as_str().map(|text| {
                json!({
                    "type": "inputText",
                    "text": truncate_rollout_text(text, MAX_ROLLOUT_TOOL_OUTPUT_CHARS)
                })
            })
        })
        .collect()
}

fn rollout_message_text(payload: &Value) -> String {
    payload
        .get("content")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|item| item.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("\n")
}

fn collect_rollout_enrichment_line(
    line: &str,
    current_turn_id: &mut Option<String>,
    enrichment: &mut RolloutThreadEnrichment,
) {
    let Ok(value) = serde_json::from_str::<Value>(line) else {
        return;
    };
    match value.get("type").and_then(Value::as_str) {
        Some("turn_context") => {
            *current_turn_id = value
                .pointer("/payload/turn_id")
                .and_then(Value::as_str)
                .map(str::to_string);
        }
        Some("response_item") => {
            let Some(turn_id) = current_turn_id.as_ref() else {
                return;
            };
            let Some(payload) = value.get("payload") else {
                return;
            };
            let payload_type = payload.get("type").and_then(Value::as_str);
            let turn = enrichment.turns.entry(turn_id.clone()).or_default();
            match payload_type {
                Some("message") => {
                    if let (Some(role @ ("user" | "assistant")), Some(timestamp)) = (
                        payload.get("role").and_then(Value::as_str),
                        value.get("timestamp").and_then(Value::as_str),
                    ) {
                        turn.message_timestamps
                            .push((role.to_string(), timestamp.to_string()));
                    }
                    match payload.get("role").and_then(Value::as_str) {
                        Some("user") => {
                            turn.sequence.push(RolloutSequenceItem::Anchor {
                                id: payload
                                    .get("id")
                                    .and_then(Value::as_str)
                                    .map(str::to_string),
                                item_type: "userMessage",
                            });
                        }
                        Some("assistant") => {
                            let id = payload
                                .get("id")
                                .and_then(Value::as_str)
                                .map(str::to_string);
                            let Some(id) = id else {
                                return;
                            };
                            let text = truncate_rollout_text(
                                &rollout_message_text(payload),
                                MAX_ROLLOUT_MESSAGE_CHARS,
                            );
                            if text.trim().is_empty() {
                                turn.sequence.push(RolloutSequenceItem::Anchor {
                                    id: Some(id),
                                    item_type: "agentMessage",
                                });
                                return;
                            }
                            let mut item = json!({
                                "type": "agentMessage",
                                "id": id,
                                "text": text,
                                "createdAt": value.get("timestamp").cloned().unwrap_or(Value::Null),
                            });
                            if let Some(phase) = payload.get("phase").and_then(Value::as_str) {
                                if let Some(object) = item.as_object_mut() {
                                    object.insert("phase".to_string(), json!(phase));
                                }
                            }
                            turn.sequence.push(RolloutSequenceItem::AgentMessage(item));
                        }
                        _ => {}
                    }
                }
                Some("reasoning") => {
                    turn.sequence.push(RolloutSequenceItem::Anchor {
                        id: payload
                            .get("id")
                            .and_then(Value::as_str)
                            .map(str::to_string),
                        item_type: "reasoning",
                    });
                }
                Some("custom_tool_call") => {
                    let (Some(id), Some(call_id), Some(tool)) = (
                        payload.get("id").and_then(Value::as_str),
                        payload.get("call_id").and_then(Value::as_str),
                        payload.get("name").and_then(Value::as_str),
                    ) else {
                        return;
                    };
                    let item = json!({
                        "type": "dynamicToolCall",
                        "id": id,
                        "namespace": "functions",
                        "tool": tool,
                        "arguments": rollout_tool_arguments(payload, "input"),
                        "lineChangeStats": rollout_apply_patch_line_stats(
                            payload.get("input").and_then(Value::as_str)
                        ),
                        "status": normalize_rollout_tool_status(
                            payload.get("status").and_then(Value::as_str)
                        ),
                        "contentItems": Value::Null,
                        "success": Value::Null,
                        "durationMs": Value::Null
                    });
                    let index = turn.sequence.len();
                    turn.sequence.push(RolloutSequenceItem::DynamicTool(item));
                    enrichment
                        .pending_tools
                        .insert(call_id.to_string(), (turn_id.clone(), index));
                }
                Some("function_call")
                    if payload.get("name").and_then(Value::as_str) == Some("wait") =>
                {
                    let (Some(id), Some(call_id), Some(tool)) = (
                        payload.get("id").and_then(Value::as_str),
                        payload.get("call_id").and_then(Value::as_str),
                        payload.get("name").and_then(Value::as_str),
                    ) else {
                        return;
                    };
                    let item = json!({
                        "type": "dynamicToolCall",
                        "id": id,
                        "namespace": "functions",
                        "tool": tool,
                        "arguments": rollout_tool_arguments(payload, "arguments"),
                        "status": "inProgress",
                        "contentItems": Value::Null,
                        "success": Value::Null,
                        "durationMs": Value::Null
                    });
                    let index = turn.sequence.len();
                    turn.sequence.push(RolloutSequenceItem::DynamicTool(item));
                    enrichment
                        .pending_tools
                        .insert(call_id.to_string(), (turn_id.clone(), index));
                }
                Some("custom_tool_call_output" | "function_call_output") => {
                    let Some(call_id) = payload.get("call_id").and_then(Value::as_str) else {
                        return;
                    };
                    let Some((pending_turn_id, index)) = enrichment.pending_tools.remove(call_id)
                    else {
                        return;
                    };
                    let Some(RolloutSequenceItem::DynamicTool(item)) = enrichment
                        .turns
                        .get_mut(&pending_turn_id)
                        .and_then(|pending_turn| pending_turn.sequence.get_mut(index))
                    else {
                        return;
                    };
                    let content_items = rollout_tool_content_items(payload.get("output"));
                    if let Some(object) = item.as_object_mut() {
                        object.insert("status".to_string(), json!("completed"));
                        object.insert("contentItems".to_string(), json!(content_items));
                    }
                }
                _ => {}
            }
        }
        _ => {}
    }
}

fn rollout_agent_message_matches(existing: &Value, candidate: &Value) -> bool {
    if existing.get("type").and_then(Value::as_str) != Some("agentMessage") {
        return false;
    }
    if existing.get("text").and_then(Value::as_str) != candidate.get("text").and_then(Value::as_str)
    {
        return false;
    }
    let existing_phase = existing.get("phase").and_then(Value::as_str);
    let candidate_phase = candidate.get("phase").and_then(Value::as_str);
    existing_phase.is_none() || candidate_phase.is_none() || existing_phase == candidate_phase
}

fn merge_rollout_agent_message(existing: &mut Value, candidate: &Value) {
    let Some(object) = existing.as_object_mut() else {
        return;
    };
    if let Some(phase) = candidate.get("phase").and_then(Value::as_str) {
        object.insert("phase".to_string(), json!(phase));
    }
    if object
        .get("text")
        .and_then(Value::as_str)
        .unwrap_or("")
        .len()
        < candidate
            .get("text")
            .and_then(Value::as_str)
            .unwrap_or("")
            .len()
    {
        if let Some(text) = candidate.get("text") {
            object.insert("text".to_string(), text.clone());
        }
    }
    if object.get("createdAt").is_none() {
        if let Some(created_at) = candidate.get("createdAt") {
            object.insert("createdAt".to_string(), created_at.clone());
        }
    }
}

fn apply_rollout_enrichment(response: &mut Value, enrichment: &RolloutThreadEnrichment) {
    let Some(turns) = response
        .pointer_mut("/result/thread/turns")
        .and_then(Value::as_array_mut)
    else {
        return;
    };
    for turn in turns {
        let Some(turn_id) = turn.get("id").and_then(Value::as_str).map(str::to_string) else {
            continue;
        };
        let Some(turn_enrichment) = enrichment.turns.get(&turn_id) else {
            continue;
        };
        let Some(items) = turn.get_mut("items").and_then(Value::as_array_mut) else {
            continue;
        };
        let mut existing_ids: HashSet<String> = items
            .iter()
            .filter_map(|item| item.get("id").and_then(Value::as_str).map(str::to_string))
            .collect();
        let mut cursor = items
            .iter()
            .take_while(|item| item.get("type").and_then(Value::as_str) == Some("userMessage"))
            .count();
        for sequence_item in &turn_enrichment.sequence {
            match sequence_item {
                RolloutSequenceItem::Anchor { id, item_type } => {
                    let id_match = id.as_deref().and_then(|id| {
                        items
                            .iter()
                            .position(|item| item.get("id").and_then(Value::as_str) == Some(id))
                    });
                    let type_match = items[cursor.min(items.len())..]
                        .iter()
                        .position(|item| {
                            item.get("type").and_then(Value::as_str) == Some(*item_type)
                        })
                        .map(|relative_index| cursor + relative_index);
                    if let Some(index) = id_match.or(type_match) {
                        cursor = cursor.max(index + 1);
                    }
                }
                RolloutSequenceItem::DynamicTool(item) => {
                    let Some(id) = item.get("id").and_then(Value::as_str) else {
                        continue;
                    };
                    if existing_ids.insert(id.to_string()) {
                        items.insert(cursor.min(items.len()), item.clone());
                        cursor += 1;
                    }
                }
                RolloutSequenceItem::AgentMessage(item) => {
                    let Some(id) = item.get("id").and_then(Value::as_str) else {
                        continue;
                    };
                    let id_match = items.iter().position(|existing| {
                        existing.get("id").and_then(Value::as_str) == Some(id)
                    });
                    let semantic_match = items[cursor.min(items.len())..]
                        .iter()
                        .position(|existing| rollout_agent_message_matches(existing, item))
                        .map(|relative_index| cursor.min(items.len()) + relative_index);
                    if let Some(index) = id_match.or(semantic_match) {
                        if let Some(existing) = items.get_mut(index) {
                            merge_rollout_agent_message(existing, item);
                        }
                        cursor = cursor.max(index + 1);
                    } else if existing_ids.insert(id.to_string()) {
                        let is_final_answer =
                            item.get("phase").and_then(Value::as_str) == Some("final_answer");
                        let insert_at = if is_final_answer {
                            items.len()
                        } else {
                            cursor.min(items.len())
                        };
                        items.insert(insert_at, item.clone());
                        cursor = insert_at + 1;
                    }
                }
            }
        }
        let mut timestamp_index = 0;
        for item in items {
            let expected_role = match item.get("type").and_then(Value::as_str) {
                Some("userMessage") => "user",
                Some("agentMessage") => "assistant",
                _ => continue,
            };
            let Some(relative_index) = turn_enrichment.message_timestamps[timestamp_index..]
                .iter()
                .position(|(role, _)| role == expected_role)
            else {
                continue;
            };
            timestamp_index += relative_index;
            if item.get("createdAt").is_none() {
                if let Some(object) = item.as_object_mut() {
                    object.insert(
                        "createdAt".to_string(),
                        Value::String(
                            turn_enrichment.message_timestamps[timestamp_index]
                                .1
                                .clone(),
                        ),
                    );
                }
            }
            timestamp_index += 1;
        }
    }
}

async fn enrich_thread_history_from_rollout(response: &mut Value) {
    let Some(path) = response
        .pointer("/result/thread/path")
        .and_then(Value::as_str)
        .map(str::to_string)
    else {
        return;
    };
    let Ok(file) = tokio::fs::File::open(path).await else {
        return;
    };
    let mut lines = BufReader::new(file).lines();
    let mut current_turn_id = None;
    let mut enrichment = RolloutThreadEnrichment::default();
    while let Ok(Some(line)) = lines.next_line().await {
        collect_rollout_enrichment_line(&line, &mut current_turn_id, &mut enrichment);
    }
    apply_rollout_enrichment(response, &enrichment);
}

fn build_thread_list_params(
    cursor: Option<String>,
    limit: Option<u32>,
    sort_key: Option<String>,
    archived: Option<bool>,
) -> Value {
    json!({
        "cursor": cursor,
        "limit": limit,
        "sortKey": sort_key,
        "archived": archived,
        // Keep interactive and sub-agent sessions visible across CLI versions so
        // thread/list refreshes do not drop valid historical conversations.
        // Intentionally exclude generic "subAgent" so parentless internal jobs
        // (for example memory consolidation) do not leak back into app state.
        "sourceKinds": THREAD_LIST_SOURCE_KINDS
    })
}

const BALANCED_TOKEN_EFFICIENCY_INSTRUCTIONS: &str = "Work token-efficiently without reducing correctness or required verification.\nPrefer targeted searches and bounded file reads over broad dumps.\nRefer to stable file paths for large logs, diffs, and documents; load only needed portions.\nKeep responses concise unless the user asks for detail. Use subagents only when parallel work is justified.";

const ECONOMY_TOKEN_EFFICIENCY_INSTRUCTIONS: &str = "Minimize token use while preserving correctness, safety, and required verification.\nUse the smallest sufficient reasoning and tool scope; prefer targeted searches and bounded file reads.\nAvoid repeating unchanged context, large outputs, logs, diffs, or documents; reference stable paths and load only needed portions.\nSummarize intermediate results and keep final responses concise unless the user asks for detail.\nDo not skip tests, safety checks, exact error evidence, or user-requested detail to save tokens.";

fn token_efficiency_developer_instructions(mode: Option<&str>) -> Option<&'static str> {
    match mode {
        Some("balanced") => Some(BALANCED_TOKEN_EFFICIENCY_INSTRUCTIONS),
        Some("economy") => Some(ECONOMY_TOKEN_EFFICIENCY_INSTRUCTIONS),
        _ => None,
    }
}

fn model_provider_override_for_runtime(
    provider_runtime_fingerprint: Option<&str>,
) -> Option<&'static str> {
    provider_runtime_fingerprint
        .filter(|fingerprint| !fingerprint.trim().is_empty())
        .map(|_| crate::shared::provider_profiles_core::CODEX_MONITOR_PROVIDER_ID)
}

fn build_start_thread_params(
    workspace_path: String,
    token_efficiency_mode: Option<&str>,
    model_provider: Option<&str>,
) -> Value {
    let mut params = Map::new();
    params.insert("cwd".to_string(), json!(workspace_path));
    params.insert("approvalPolicy".to_string(), json!("on-request"));
    if let Some(model_provider) = model_provider {
        params.insert("modelProvider".to_string(), json!(model_provider));
    }
    if let Some(instructions) = token_efficiency_developer_instructions(token_efficiency_mode) {
        params.insert("developerInstructions".to_string(), json!(instructions));
    }
    Value::Object(params)
}

pub(crate) async fn start_thread_core(
    sessions: &Mutex<HashMap<String, Arc<WorkspaceSession>>>,
    workspaces: &Mutex<HashMap<String, WorkspaceEntry>>,
    workspace_id: String,
    token_efficiency_mode: Option<String>,
) -> Result<Value, String> {
    let session = get_session_clone(sessions, &workspace_id).await?;
    let workspace_path = resolve_workspace_path_core(workspaces, &workspace_id).await?;
    let params = build_start_thread_params(
        workspace_path,
        token_efficiency_mode.as_deref(),
        model_provider_override_for_runtime(session.provider_runtime_fingerprint.as_deref()),
    );
    session
        .send_request_for_workspace(&workspace_id, "thread/start", params)
        .await
}

pub(crate) async fn resume_thread_core(
    sessions: &Mutex<HashMap<String, Arc<WorkspaceSession>>>,
    workspace_id: String,
    thread_id: String,
) -> Result<Value, String> {
    let session = get_session_clone(sessions, &workspace_id).await?;
    resume_thread_with_session_core(&session, workspace_id, thread_id).await
}

pub(crate) async fn resume_thread_with_session_core(
    session: &WorkspaceSession,
    workspace_id: String,
    thread_id: String,
) -> Result<Value, String> {
    let mut params = Map::new();
    params.insert("threadId".to_string(), json!(thread_id));
    if let Some(model_provider) =
        model_provider_override_for_runtime(session.provider_runtime_fingerprint.as_deref())
    {
        params.insert("modelProvider".to_string(), json!(model_provider));
    }
    send_enriched_thread_history_request(
        session,
        &workspace_id,
        "thread/resume",
        Value::Object(params),
    )
    .await
}

pub(crate) async fn read_thread_with_session_core(
    session: &WorkspaceSession,
    workspace_id: String,
    thread_id: String,
) -> Result<Value, String> {
    let params = build_read_thread_params(thread_id);
    send_enriched_thread_history_request(session, &workspace_id, "thread/read", params).await
}

fn thread_history_snapshot_id(response: &Value) -> String {
    let thread = response.pointer("/result/thread").unwrap_or(&Value::Null);
    let identity = thread
        .get("path")
        .and_then(Value::as_str)
        .or_else(|| thread.get("id").and_then(Value::as_str))
        .unwrap_or("unknown-thread");
    format!("{:x}", Sha256::digest(identity.as_bytes()))
}

fn encode_thread_history_cursor(snapshot_id: &str, before: usize) -> String {
    URL_SAFE_NO_PAD
        .encode(json!({ "version": 1, "snapshotId": snapshot_id, "before": before }).to_string())
}

fn decode_thread_history_cursor(cursor: &str) -> Result<(String, usize), String> {
    let bytes = URL_SAFE_NO_PAD
        .decode(cursor)
        .map_err(|_| "Invalid thread history cursor".to_string())?;
    let value: Value =
        serde_json::from_slice(&bytes).map_err(|_| "Invalid thread history cursor".to_string())?;
    if value.get("version").and_then(Value::as_u64) != Some(1) {
        return Err("Unsupported thread history cursor version".to_string());
    }
    let snapshot_id = value
        .get("snapshotId")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Invalid thread history cursor snapshot".to_string())?
        .to_string();
    let before = value
        .get("before")
        .and_then(Value::as_u64)
        .and_then(|value| usize::try_from(value).ok())
        .ok_or_else(|| "Invalid thread history cursor position".to_string())?;
    Ok((snapshot_id, before))
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct NativeThreadHistoryCursor {
    snapshot_id: String,
    upstream_cursor: Option<String>,
    offset: usize,
    page_limit: usize,
    boundary_item_hash: Option<String>,
}

fn encode_native_thread_history_cursor(cursor: &NativeThreadHistoryCursor) -> String {
    URL_SAFE_NO_PAD.encode(
        json!({
            "version": 2,
            "source": "threadItemsList",
            "snapshotId": cursor.snapshot_id,
            "upstreamCursor": cursor.upstream_cursor,
            "offset": cursor.offset,
            "pageLimit": cursor.page_limit,
            "boundaryItemHash": cursor.boundary_item_hash,
        })
        .to_string(),
    )
}

fn decode_native_thread_history_cursor(
    cursor: &str,
) -> Result<Option<NativeThreadHistoryCursor>, String> {
    let bytes = URL_SAFE_NO_PAD
        .decode(cursor)
        .map_err(|_| "Invalid thread history cursor".to_string())?;
    let value: Value =
        serde_json::from_slice(&bytes).map_err(|_| "Invalid thread history cursor".to_string())?;
    if value.get("version").and_then(Value::as_u64) != Some(2) {
        return Ok(None);
    }
    if value.get("source").and_then(Value::as_str) != Some("threadItemsList") {
        return Err("Unsupported thread history cursor source".to_string());
    }
    let snapshot_id = value
        .get("snapshotId")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Invalid thread history cursor snapshot".to_string())?
        .to_string();
    let upstream_cursor = match value.get("upstreamCursor") {
        None | Some(Value::Null) => None,
        Some(Value::String(value)) if !value.is_empty() => Some(value.clone()),
        _ => return Err("Invalid upstream thread history cursor".to_string()),
    };
    let offset = value
        .get("offset")
        .and_then(Value::as_u64)
        .and_then(|value| usize::try_from(value).ok())
        .ok_or_else(|| "Invalid thread history cursor offset".to_string())?;
    let page_limit = value
        .get("pageLimit")
        .and_then(Value::as_u64)
        .and_then(|value| usize::try_from(value).ok())
        .ok_or_else(|| "Invalid thread history cursor page limit".to_string())?
        .clamp(1, THREAD_HISTORY_PAGE_MAX_ITEMS);
    let boundary_item_hash = match value.get("boundaryItemHash") {
        None | Some(Value::Null) => None,
        Some(Value::String(value)) if !value.is_empty() => Some(value.clone()),
        _ => return Err("Invalid thread history cursor boundary".to_string()),
    };
    Ok(Some(NativeThreadHistoryCursor {
        snapshot_id,
        upstream_cursor,
        offset,
        page_limit,
        boundary_item_hash,
    }))
}

fn thread_history_entry_hash(entry: &Value) -> Result<String, String> {
    let bytes = serde_json::to_vec(entry)
        .map_err(|error| format!("Failed to identify thread history item: {error}"))?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

fn normalize_thread_history_limits(
    item_limit: Option<u32>,
    byte_limit: Option<u32>,
) -> (usize, usize) {
    let item_limit = item_limit
        .and_then(|value| usize::try_from(value).ok())
        .unwrap_or(THREAD_HISTORY_PAGE_DEFAULT_ITEMS)
        .clamp(1, THREAD_HISTORY_PAGE_MAX_ITEMS);
    let byte_limit = byte_limit
        .and_then(|value| usize::try_from(value).ok())
        .unwrap_or(THREAD_HISTORY_PAGE_DEFAULT_BYTES)
        .clamp(1, THREAD_HISTORY_PAGE_MAX_BYTES);
    (item_limit, byte_limit)
}

fn build_native_thread_history_turns(
    entries_descending: &[Value],
    latest_turn_response: &Value,
) -> Result<Vec<Value>, String> {
    let mut turns = Vec::<Value>::new();
    for entry in entries_descending.iter().rev() {
        let turn_id = entry
            .get("turnId")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| "Thread item page entry has no turn id".to_string())?;
        let item = entry
            .get("item")
            .cloned()
            .ok_or_else(|| "Thread item page entry has no item".to_string())?;
        let belongs_to_last_turn = turns
            .last()
            .and_then(|turn| turn.get("id"))
            .and_then(Value::as_str)
            == Some(turn_id);
        if !belongs_to_last_turn {
            turns.push(json!({ "id": turn_id, "items": [] }));
        }
        turns
            .last_mut()
            .and_then(|turn| turn.get_mut("items"))
            .and_then(Value::as_array_mut)
            .ok_or_else(|| "Failed to build thread history turn".to_string())?
            .push(item);
    }

    let Some(latest_turn) = latest_turn_response
        .pointer("/result/data")
        .and_then(Value::as_array)
        .and_then(|turns| turns.first())
        .cloned()
    else {
        return Ok(turns);
    };
    let Some(latest_turn_id) = latest_turn
        .get("id")
        .and_then(Value::as_str)
        .map(str::to_string)
    else {
        return Ok(turns);
    };
    if let Some(existing) = turns
        .iter_mut()
        .find(|turn| turn.get("id").and_then(Value::as_str) == Some(latest_turn_id.as_str()))
    {
        let items = existing
            .get("items")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        *existing = latest_turn;
        if let Some(object) = existing.as_object_mut() {
            object.insert("items".to_string(), Value::Array(items));
        }
    } else {
        let mut latest_turn = latest_turn;
        if let Some(object) = latest_turn.as_object_mut() {
            object.insert("items".to_string(), Value::Array(Vec::new()));
        }
        turns.push(latest_turn);
    }
    Ok(turns)
}

fn native_history_page_misses_latest_terminal_agent_message(response: &Value) -> bool {
    let Some(latest_turn) = response
        .pointer("/result/thread/turns")
        .and_then(Value::as_array)
        .and_then(|turns| turns.last())
    else {
        return false;
    };
    let Some(status) = latest_turn
        .get("status")
        .and_then(Value::as_str)
        .map(|value| value.to_ascii_lowercase())
    else {
        return false;
    };
    let is_terminal = matches!(
        status.as_str(),
        "completed" | "complete" | "failed" | "error" | "interrupted" | "cancelled"
    );
    if !is_terminal {
        return false;
    }
    !latest_turn
        .get("items")
        .and_then(Value::as_array)
        .is_some_and(|items| {
            items.iter().any(|item| {
                item.get("type").and_then(Value::as_str) == Some("agentMessage")
                    && item.get("phase").and_then(Value::as_str) == Some("final_answer")
            })
        })
}

fn paginate_native_thread_history_response(
    mut metadata_response: Value,
    items_response: &Value,
    latest_turn_response: &Value,
    cursor: Option<&NativeThreadHistoryCursor>,
    item_limit: usize,
    byte_limit: usize,
) -> Result<Value, String> {
    let snapshot_id = thread_history_snapshot_id(&metadata_response);
    if cursor.is_some_and(|cursor| cursor.snapshot_id != snapshot_id) {
        return Err("Thread history cursor snapshot does not match".to_string());
    }
    let entries = items_response
        .pointer("/result/data")
        .and_then(Value::as_array)
        .ok_or_else(|| "Thread item page response has no data".to_string())?;
    let offset = if let Some(boundary_item_hash) =
        cursor.and_then(|cursor| cursor.boundary_item_hash.as_deref())
    {
        let mut anchored_offset = None;
        for (index, entry) in entries.iter().enumerate() {
            if thread_history_entry_hash(entry)? == boundary_item_hash {
                anchored_offset = Some(index + 1);
                break;
            }
        }
        anchored_offset.ok_or_else(|| "Thread history cursor boundary is stale".to_string())?
    } else {
        cursor.map_or(0, |cursor| cursor.offset)
    };
    if offset > entries.len() {
        return Err("Thread history cursor is stale".to_string());
    }
    let page_limit = cursor.map_or(item_limit, |cursor| cursor.page_limit);
    let mut consumed = 0usize;
    let mut byte_count = 0usize;
    let mut oversized_item = false;
    for entry in entries[offset..].iter().take(item_limit) {
        let item = entry
            .get("item")
            .ok_or_else(|| "Thread item page entry has no item".to_string())?;
        let item_bytes = serde_json::to_vec(item)
            .map_err(|error| format!("Failed to measure thread history item: {error}"))?
            .len();
        if consumed > 0 && byte_count.saturating_add(item_bytes) > byte_limit {
            break;
        }
        if consumed == 0 && item_bytes > byte_limit {
            oversized_item = true;
        }
        consumed += 1;
        byte_count = byte_count.saturating_add(item_bytes);
    }
    let selected = entries[offset..offset + consumed].to_vec();
    let upstream_request_cursor = cursor.and_then(|cursor| cursor.upstream_cursor.clone());
    let upstream_next_cursor = items_response
        .pointer("/result/nextCursor")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let next_position = offset + consumed;
    let next_cursor_state = if next_position < entries.len() {
        Some(NativeThreadHistoryCursor {
            snapshot_id: snapshot_id.clone(),
            upstream_cursor: upstream_request_cursor,
            offset: next_position,
            page_limit,
            boundary_item_hash: selected.last().map(thread_history_entry_hash).transpose()?,
        })
    } else {
        upstream_next_cursor.map(|upstream_cursor| NativeThreadHistoryCursor {
            snapshot_id: snapshot_id.clone(),
            upstream_cursor: Some(upstream_cursor),
            offset: 0,
            page_limit,
            boundary_item_hash: None,
        })
    };
    let turns = build_native_thread_history_turns(&selected, latest_turn_response)?;
    let thread = metadata_response
        .pointer_mut("/result/thread")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| "Thread metadata response has no thread".to_string())?;
    thread.insert("turns".to_string(), Value::Array(turns));
    let next_cursor = next_cursor_state
        .as_ref()
        .map(encode_native_thread_history_cursor);
    metadata_response
        .as_object_mut()
        .ok_or_else(|| "Thread metadata response is not an object".to_string())?
        .insert(
            "codexMonitorHistoryPage".to_string(),
            json!({
                "version": 2,
                "source": "threadItemsList",
                "snapshotId": snapshot_id,
                "nextCursor": next_cursor,
                "hasMore": next_cursor_state.is_some(),
                "itemCount": consumed,
                "byteCount": byte_count,
                "oversizedItem": oversized_item,
                "pageStart": Value::Null,
                "pageEnd": Value::Null,
                "totalItems": Value::Null,
            }),
        );
    Ok(metadata_response)
}

pub(crate) fn paginate_thread_history_response(
    mut response: Value,
    cursor: Option<String>,
    item_limit: Option<u32>,
    byte_limit: Option<u32>,
) -> Result<Value, String> {
    let snapshot_id = thread_history_snapshot_id(&response);
    let (item_limit, byte_limit) = normalize_thread_history_limits(item_limit, byte_limit);

    let (start, end, total_items, byte_count, oversized_item) = {
        let turns = response
            .pointer("/result/thread/turns")
            .and_then(Value::as_array)
            .ok_or_else(|| "Thread history response has no turns".to_string())?;
        let items = turns
            .iter()
            .flat_map(|turn| {
                turn.get("items")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
            })
            .collect::<Vec<_>>();
        let total_items = items.len();
        let end = match cursor.as_deref() {
            Some(cursor) => {
                let (cursor_snapshot_id, before) = decode_thread_history_cursor(cursor)?;
                if cursor_snapshot_id != snapshot_id {
                    return Err("Thread history cursor snapshot does not match".to_string());
                }
                if before > total_items {
                    return Err("Thread history cursor is stale".to_string());
                }
                before
            }
            None => total_items,
        };
        let mut start = end;
        let mut byte_count = 0usize;
        let mut oversized_item = false;
        for item in items[..end].iter().rev().take(item_limit) {
            let item_bytes = serde_json::to_vec(item)
                .map_err(|error| format!("Failed to measure thread history item: {error}"))?
                .len();
            if start < end && byte_count.saturating_add(item_bytes) > byte_limit {
                break;
            }
            if start == end && item_bytes > byte_limit {
                oversized_item = true;
            }
            byte_count = byte_count.saturating_add(item_bytes);
            start -= 1;
        }
        (start, end, total_items, byte_count, oversized_item)
    };

    let turns = response
        .pointer_mut("/result/thread/turns")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| "Thread history response has no turns".to_string())?;
    let latest_turn_index = cursor
        .is_none()
        .then(|| turns.len().checked_sub(1))
        .flatten();
    let mut global_index = 0usize;
    for turn in turns.iter_mut() {
        let Some(items) = turn.get_mut("items").and_then(Value::as_array_mut) else {
            continue;
        };
        let turn_start = global_index;
        let turn_end = turn_start + items.len();
        global_index = turn_end;
        let keep_start = start.saturating_sub(turn_start).min(items.len());
        let keep_end = end.saturating_sub(turn_start).min(items.len());
        *items = if keep_start < keep_end {
            items[keep_start..keep_end].to_vec()
        } else {
            Vec::new()
        };
    }
    let mut turn_index = 0usize;
    turns.retain(|turn| {
        let keep = turn_index == latest_turn_index.unwrap_or(usize::MAX)
            || turn
                .get("items")
                .and_then(Value::as_array)
                .is_some_and(|items| !items.is_empty());
        turn_index += 1;
        keep
    });

    let has_more = start > 0;
    let next_cursor = has_more.then(|| encode_thread_history_cursor(&snapshot_id, start));
    let page = json!({
        "version": 1,
        "snapshotId": snapshot_id,
        "nextCursor": next_cursor,
        "hasMore": has_more,
        "itemCount": end.saturating_sub(start),
        "byteCount": byte_count,
        "oversizedItem": oversized_item,
        "pageStart": start,
        "pageEnd": end,
        "totalItems": total_items
    });
    response
        .as_object_mut()
        .ok_or_else(|| "Thread history response is not an object".to_string())?
        .insert("codexMonitorHistoryPage".to_string(), page);
    Ok(response)
}

async fn try_read_native_thread_history_page(
    session: &WorkspaceSession,
    workspace_id: &str,
    thread_id: &str,
    cursor: Option<&NativeThreadHistoryCursor>,
    item_limit: usize,
    byte_limit: usize,
) -> Result<Option<Value>, String> {
    let page_limit = cursor.map_or(item_limit, |cursor| cursor.page_limit);
    let items_response = session
        .send_request_for_workspace(
            workspace_id,
            "thread/items/list",
            json!({
                "threadId": thread_id,
                "cursor": cursor.and_then(|cursor| cursor.upstream_cursor.clone()),
                "limit": page_limit,
                "sortDirection": "desc",
            }),
        )
        .await?;
    if let Some(message) = rpc_error_message(&items_response) {
        if cursor.is_some() {
            return Err(format!(
                "Native thread history pagination failed: {message}"
            ));
        }
        return Ok(None);
    }

    let metadata_response = session
        .send_request_for_workspace(
            workspace_id,
            "thread/read",
            build_read_thread_metadata_params(thread_id),
        )
        .await?;
    if let Some(message) = rpc_error_message(&metadata_response) {
        return Err(message.to_string());
    }

    let latest_turn_response = session
        .send_request_for_workspace(
            workspace_id,
            "thread/turns/list",
            json!({
                "threadId": thread_id,
                "cursor": Value::Null,
                "limit": 1,
                "sortDirection": "desc",
            }),
        )
        .await?;
    if let Some(message) = rpc_error_message(&latest_turn_response) {
        if cursor.is_some() {
            return Err(format!("Native thread turn pagination failed: {message}"));
        }
        return Ok(None);
    }

    paginate_native_thread_history_response(
        metadata_response,
        &items_response,
        &latest_turn_response,
        cursor,
        item_limit,
        byte_limit,
    )
    .map(Some)
}

pub(crate) async fn read_thread_page_with_session_core(
    session: &WorkspaceSession,
    workspace_id: String,
    thread_id: String,
    cursor: Option<String>,
    item_limit: Option<u32>,
    byte_limit: Option<u32>,
) -> Result<Value, String> {
    let (normalized_item_limit, normalized_byte_limit) =
        normalize_thread_history_limits(item_limit, byte_limit);
    let native_cursor = cursor
        .as_deref()
        .map(decode_native_thread_history_cursor)
        .transpose()?
        .flatten();
    if cursor.is_none() || native_cursor.is_some() {
        if let Some(response) = try_read_native_thread_history_page(
            session,
            &workspace_id,
            &thread_id,
            native_cursor.as_ref(),
            normalized_item_limit,
            normalized_byte_limit,
        )
        .await?
        {
            if cursor.is_none()
                && native_history_page_misses_latest_terminal_agent_message(&response)
            {
                let response =
                    read_thread_with_session_core(session, workspace_id, thread_id).await?;
                return paginate_thread_history_response(response, None, item_limit, byte_limit);
            }
            return Ok(response);
        }
    }
    let response = read_thread_with_session_core(session, workspace_id, thread_id).await?;
    paginate_thread_history_response(response, cursor, item_limit, byte_limit)
}

async fn send_enriched_thread_history_request(
    session: &WorkspaceSession,
    workspace_id: &str,
    method: &str,
    params: Value,
) -> Result<Value, String> {
    let mut response = session
        .send_request_for_workspace(workspace_id, method, params)
        .await?;
    enrich_thread_history_from_rollout(&mut response).await;
    Ok(response)
}

pub(crate) fn annotate_thread_read_authority(mut response: Value, authority: &str) -> Value {
    if let Some(object) = response.as_object_mut() {
        object.insert(
            "codexMonitorReadAuthority".to_string(),
            Value::String(authority.to_string()),
        );
    }
    response
}

pub(crate) async fn thread_live_subscribe_core(
    sessions: &Mutex<HashMap<String, Arc<WorkspaceSession>>>,
    workspace_id: String,
    thread_id: String,
) -> Result<(), String> {
    if thread_id.trim().is_empty() {
        return Err("threadId is required".to_string());
    }
    let _ = get_session_clone(sessions, &workspace_id).await?;
    Ok(())
}

pub(crate) async fn thread_live_unsubscribe_core(
    sessions: &Mutex<HashMap<String, Arc<WorkspaceSession>>>,
    workspace_id: String,
    thread_id: String,
) -> Result<(), String> {
    if thread_id.trim().is_empty() {
        return Err("threadId is required".to_string());
    }
    let _ = get_session_clone(sessions, &workspace_id).await?;
    Ok(())
}

pub(crate) async fn fork_thread_core(
    sessions: &Mutex<HashMap<String, Arc<WorkspaceSession>>>,
    workspace_id: String,
    thread_id: String,
) -> Result<Value, String> {
    let session = get_session_clone(sessions, &workspace_id).await?;
    let params = json!({ "threadId": thread_id });
    session
        .send_request_for_workspace(&workspace_id, "thread/fork", params)
        .await
}

pub(crate) async fn rollback_thread_core(
    sessions: &Mutex<HashMap<String, Arc<WorkspaceSession>>>,
    workspace_id: String,
    thread_id: String,
    num_turns: u32,
) -> Result<Value, String> {
    if num_turns == 0 {
        return Err("numTurns must be at least 1".to_string());
    }
    let session = get_session_clone(sessions, &workspace_id).await?;
    let params = json!({ "threadId": thread_id, "numTurns": num_turns });
    session
        .send_request_for_workspace(&workspace_id, "thread/rollback", params)
        .await
}

pub(crate) async fn list_threads_with_session_core(
    session: &WorkspaceSession,
    workspace_id: String,
    cursor: Option<String>,
    limit: Option<u32>,
    sort_key: Option<String>,
    archived: Option<bool>,
) -> Result<Value, String> {
    let params = build_thread_list_params(cursor, limit, sort_key, archived);
    session
        .send_request_for_workspace(&workspace_id, "thread/list", params)
        .await
}

pub(crate) async fn list_mcp_server_status_core(
    sessions: &Mutex<HashMap<String, Arc<WorkspaceSession>>>,
    workspace_id: String,
    cursor: Option<String>,
    limit: Option<u32>,
) -> Result<Value, String> {
    let session = get_session_clone(sessions, &workspace_id).await?;
    let params = json!({ "cursor": cursor, "limit": limit });
    session
        .send_request_for_workspace(&workspace_id, "mcpServerStatus/list", params)
        .await
}

fn response_result(response: Result<Value, String>) -> Option<Value> {
    response
        .ok()?
        .get("result")
        .filter(|result| !result.is_null())
        .cloned()
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

pub(crate) async fn computer_control_status_core(
    sessions: &Mutex<HashMap<String, Arc<WorkspaceSession>>>,
    workspaces: &Mutex<HashMap<String, WorkspaceEntry>>,
    workspace_id: String,
    force_refresh: bool,
    execution_host: String,
) -> Result<ComputerControlCapabilitySnapshot, String> {
    let session = get_session_clone(sessions, &workspace_id).await?;
    let observed_at_ms = now_ms();
    if force_refresh {
        session.invalidate_computer_control_snapshot().await;
    } else {
        if let Some(snapshot) = session.computer_control_snapshot.lock().await.clone() {
            if snapshot_is_fresh(
                &snapshot,
                &session.computer_control_runtime_fingerprint,
                observed_at_ms,
            ) {
                return Ok(snapshot);
            }
        }
    }

    let workspace_path = resolve_workspace_path_core(workspaces, &workspace_id).await?;
    let mcp_request = timeout(
        COMPUTER_CONTROL_PROBE_TIMEOUT,
        session.send_request_for_workspace(
            &workspace_id,
            "mcpServerStatus/list",
            json!({ "cursor": null, "limit": 100, "detail": "toolsAndAuthOnly" }),
        ),
    );
    let plugin_request = timeout(
        COMPUTER_CONTROL_PROBE_TIMEOUT,
        session.send_request_for_workspace(
            &workspace_id,
            "plugin/list",
            json!({ "cwds": [workspace_path.clone()], "marketplaceKinds": ["local"] }),
        ),
    );
    let skills_request = timeout(
        COMPUTER_CONTROL_PROBE_TIMEOUT,
        session.send_request_for_workspace(
            &workspace_id,
            "skills/list",
            json!({ "cwd": workspace_path.clone() }),
        ),
    );
    let config_request = timeout(
        COMPUTER_CONTROL_PROBE_TIMEOUT,
        session.send_request_for_workspace(
            &workspace_id,
            "config/read",
            json!({ "cwd": workspace_path, "includeLayers": false }),
        ),
    );
    let (mcp_response, plugin_response, skills_response, config_response) =
        join4(mcp_request, plugin_request, skills_request, config_request).await;

    let mcp_result = mcp_response.ok().and_then(response_result);
    let plugin_result = plugin_response.ok().and_then(response_result);
    let skills_result = skills_response.ok().and_then(response_result);
    let config_result = config_response.ok().and_then(response_result);
    let mcp: Option<McpServerStatusListResponse> = mcp_result
        .as_ref()
        .and_then(|value| serde_json::from_value(value.clone()).ok());
    let plugins: Option<PluginListResponse> = plugin_result
        .as_ref()
        .and_then(|value| serde_json::from_value(value.clone()).ok());
    let skills: Option<SkillsListResponse> = skills_result
        .as_ref()
        .and_then(|value| serde_json::from_value(value.clone()).ok());

    let windows_ui = normalize_mcp_server_capability_with_identity(
        mcp.as_ref(),
        mcp_result.is_none(),
        WINDOWS_UI_SERVER_NAME,
        Some("sbroenne.windows-mcp"),
    );
    let node_repl = normalize_mcp_server_capability_with_identity(
        mcp.as_ref(),
        mcp_result.is_none(),
        NODE_REPL_SERVER_NAME,
        Some("rmcp"),
    );
    let node_repl_availability = node_repl.availability;
    let browser_capability = |plugin_id: &str, skill_name: &str| {
        let management = normalize_plugin_management_status(
            plugins.as_ref(),
            plugin_result.is_none(),
            plugin_id,
        );
        let skill =
            normalize_skill_availability(skills.as_ref(), skills_result.is_none(), skill_name);
        let runtime_tools = normalize_browser_runtime_evidence(
            effective_plugin_enabled(config_result.as_ref(), plugin_id),
            skill,
        );
        normalize_browser_backend_capability(BrowserBackendEvidence {
            plugin_management: management,
            runtime_tools,
            node_repl: node_repl_availability,
        })
    };
    let computer_use_reason =
        match effective_plugin_enabled(config_result.as_ref(), COMPUTER_USE_PLUGIN_ID) {
            Some(false) => "computer_use_disabled_by_cm",
            Some(true) => "computer_use_disable_override_not_effective",
            None => "computer_use_disable_override_unverified",
        };
    let snapshot = build_capability_snapshot(ComputerControlSnapshotInput {
        observed_at_ms,
        execution_host,
        runtime_fingerprint: session.computer_control_runtime_fingerprint.clone(),
        windows_ui,
        chrome: browser_capability(CHROME_PLUGIN_ID, CHROME_SKILL_NAME),
        browser: browser_capability(BROWSER_PLUGIN_ID, BROWSER_SKILL_NAME),
        computer_use: ComputerControlBackendCapability::new(
            ComputerControlAvailability::Unsupported,
            computer_use_reason,
        ),
    });
    *session.computer_control_snapshot.lock().await = Some(snapshot.clone());
    Ok(snapshot)
}

pub(crate) async fn computer_control_preflight_core(
    sessions: &Mutex<HashMap<String, Arc<WorkspaceSession>>>,
    workspaces: &Mutex<HashMap<String, WorkspaceEntry>>,
    workspace_id: String,
    task: String,
    explicit_backend: Option<ComputerControlBackend>,
    decision_id: String,
    execution_host: String,
) -> Result<ComputerControlRouteDecision, String> {
    let signals = infer_computer_control_task_signals(&task, explicit_backend);
    let classification = classify_computer_control_task(&signals);
    let observed_at_ms = now_ms();
    let snapshot = if classification.task_kind == ComputerControlTaskKind::Direct {
        build_capability_snapshot(ComputerControlSnapshotInput {
            observed_at_ms,
            execution_host,
            runtime_fingerprint: "direct-no-probe".to_string(),
            windows_ui: ComputerControlBackendCapability::new(
                ComputerControlAvailability::Unknown,
                "not_probed_for_direct_task",
            ),
            chrome: ComputerControlBackendCapability::new(
                ComputerControlAvailability::Unknown,
                "not_probed_for_direct_task",
            ),
            browser: ComputerControlBackendCapability::new(
                ComputerControlAvailability::Unknown,
                "not_probed_for_direct_task",
            ),
            computer_use: ComputerControlBackendCapability::new(
                ComputerControlAvailability::Unsupported,
                "computer_use_disabled_by_cm",
            ),
        })
    } else {
        computer_control_status_core(sessions, workspaces, workspace_id, false, execution_host)
            .await?
    };
    Ok(attach_computer_control_context(route_computer_control(
        ComputerControlRouteRequest {
            decision_id,
            classification: &classification,
            snapshot: &snapshot,
            now_ms: now_ms(),
        },
    )))
}

pub(crate) async fn archive_thread_core(
    sessions: &Mutex<HashMap<String, Arc<WorkspaceSession>>>,
    workspace_id: String,
    thread_id: String,
) -> Result<Value, String> {
    let session = get_session_clone(sessions, &workspace_id).await?;
    let params = json!({ "threadId": thread_id });
    session
        .send_request_for_workspace(&workspace_id, "thread/archive", params)
        .await
}

pub(crate) async fn compact_thread_core(
    sessions: &Mutex<HashMap<String, Arc<WorkspaceSession>>>,
    workspace_id: String,
    thread_id: String,
) -> Result<Value, String> {
    let session = get_session_clone(sessions, &workspace_id).await?;
    let params = json!({ "threadId": thread_id });
    session
        .send_request_for_workspace(&workspace_id, "thread/compact/start", params)
        .await
}

pub(crate) async fn set_thread_name_core(
    sessions: &Mutex<HashMap<String, Arc<WorkspaceSession>>>,
    workspace_id: String,
    thread_id: String,
    name: String,
) -> Result<Value, String> {
    let session = get_session_clone(sessions, &workspace_id).await?;
    let params = json!({ "threadId": thread_id, "name": name });
    session
        .send_request_for_workspace(&workspace_id, "thread/name/set", params)
        .await
}

fn build_turn_input_items(
    text: String,
    images: Option<Vec<String>>,
    app_mentions: Option<Vec<Value>>,
) -> Result<Vec<Value>, String> {
    let trimmed_text = text.trim();
    let mut input: Vec<Value> = Vec::new();
    if !trimmed_text.is_empty() {
        input.push(json!({ "type": "text", "text": trimmed_text }));
    }
    if let Some(paths) = images {
        for path in paths {
            let trimmed = path.trim();
            if trimmed.is_empty() {
                continue;
            }
            if trimmed.starts_with("data:image/")
                || trimmed.starts_with("http://")
                || trimmed.starts_with("https://")
            {
                input.push(json!({ "type": "image", "url": trimmed }));
            } else if should_inline_image_path_for_codex(trimmed) {
                input.push(json!({
                    "type": "image",
                    "url": read_image_as_data_url_core(trimmed)?,
                }));
            } else if image_mime_type_for_path(trimmed).is_some() {
                input.push(json!({ "type": "localImage", "path": trimmed }));
            } else if let Some((name, content)) = parse_text_attachment_data_url(trimmed)? {
                input.push(build_text_attachment_item(&name, &content, false));
            } else {
                let (name, content, truncated) = read_text_attachment_path(trimmed)?;
                input.push(build_text_attachment_item(&name, &content, truncated));
            }
        }
    }
    if let Some(mentions) = app_mentions {
        let mut seen_paths: HashSet<String> = HashSet::new();
        for mention in mentions {
            let object = mention
                .as_object()
                .ok_or_else(|| "invalid app mention payload".to_string())?;
            let name = object
                .get("name")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| "invalid app mention name".to_string())?;
            let path = object
                .get("path")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| "invalid app mention path".to_string())?;
            if !path.starts_with("app://") || path.len() <= "app://".len() {
                return Err("invalid app mention path".to_string());
            }
            if !seen_paths.insert(path.to_string()) {
                continue;
            }
            input.push(json!({ "type": "mention", "name": name, "path": path }));
        }
    }
    if input.is_empty() {
        return Err("empty user message".to_string());
    }
    Ok(input)
}

pub(crate) fn insert_optional_nullable_string(
    params: &mut Map<String, Value>,
    key: &str,
    value: Option<Option<String>>,
) {
    if let Some(value) = value {
        params.insert(key.to_string(), json!(value));
    }
}

fn insert_optional_non_null_value(
    params: &mut Map<String, Value>,
    key: &str,
    value: Option<Value>,
) {
    if let Some(value) = value.filter(|value| !value.is_null()) {
        params.insert(key.to_string(), value);
    }
}

pub(crate) async fn send_user_message_core(
    sessions: &Mutex<HashMap<String, Arc<WorkspaceSession>>>,
    workspaces: &Mutex<HashMap<String, WorkspaceEntry>>,
    workspace_id: String,
    thread_id: String,
    text: String,
    model: Option<String>,
    effort: Option<String>,
    service_tier: Option<Option<String>>,
    access_mode: Option<String>,
    images: Option<Vec<String>>,
    app_mentions: Option<Vec<Value>>,
    collaboration_mode: Option<Value>,
    additional_context: Option<Value>,
) -> Result<Value, String> {
    let session = get_session_clone(sessions, &workspace_id).await?;
    send_user_message_with_session_core(
        &session,
        workspaces,
        workspace_id,
        thread_id,
        text,
        model,
        effort,
        service_tier,
        access_mode,
        images,
        app_mentions,
        collaboration_mode,
        additional_context,
    )
    .await
}

pub(crate) async fn send_user_message_with_session_core(
    session: &WorkspaceSession,
    workspaces: &Mutex<HashMap<String, WorkspaceEntry>>,
    workspace_id: String,
    thread_id: String,
    text: String,
    model: Option<String>,
    effort: Option<String>,
    service_tier: Option<Option<String>>,
    access_mode: Option<String>,
    images: Option<Vec<String>>,
    app_mentions: Option<Vec<Value>>,
    collaboration_mode: Option<Value>,
    additional_context: Option<Value>,
) -> Result<Value, String> {
    let workspace_path = resolve_workspace_path_core(workspaces, &workspace_id).await?;
    let access_mode = access_mode.unwrap_or_else(|| "current".to_string());
    let sandbox_policy = match access_mode.as_str() {
        "full-access" => json!({ "type": "dangerFullAccess" }),
        "read-only" => json!({ "type": "readOnly" }),
        _ => json!({
            "type": "workspaceWrite",
            "writableRoots": [workspace_path.clone()],
            "networkAccess": true
        }),
    };

    let approval_policy = if access_mode == "full-access" {
        "never"
    } else {
        "on-request"
    };

    let input = build_turn_input_items(text, images, app_mentions)?;

    let mut params = Map::new();
    params.insert("threadId".to_string(), json!(thread_id));
    params.insert("input".to_string(), json!(input));
    params.insert("cwd".to_string(), json!(workspace_path));
    params.insert("approvalPolicy".to_string(), json!(approval_policy));
    params.insert("sandboxPolicy".to_string(), json!(sandbox_policy));
    params.insert("model".to_string(), json!(model));
    params.insert("effort".to_string(), json!(effort));
    insert_optional_nullable_string(&mut params, "serviceTier", service_tier);
    if let Some(mode) = collaboration_mode {
        if !mode.is_null() {
            params.insert("collaborationMode".to_string(), mode);
        }
    }
    insert_optional_non_null_value(&mut params, "additionalContext", additional_context);
    session
        .send_request_for_workspace(&workspace_id, "turn/start", Value::Object(params))
        .await
}

pub(crate) async fn turn_steer_core(
    sessions: &Mutex<HashMap<String, Arc<WorkspaceSession>>>,
    workspace_id: String,
    thread_id: String,
    turn_id: String,
    text: String,
    images: Option<Vec<String>>,
    app_mentions: Option<Vec<Value>>,
    additional_context: Option<Value>,
) -> Result<Value, String> {
    let session = get_session_clone(sessions, &workspace_id).await?;
    turn_steer_with_session_core(
        &session,
        workspace_id,
        thread_id,
        turn_id,
        text,
        images,
        app_mentions,
        additional_context,
    )
    .await
}

pub(crate) async fn turn_steer_with_session_core(
    session: &WorkspaceSession,
    workspace_id: String,
    thread_id: String,
    turn_id: String,
    text: String,
    images: Option<Vec<String>>,
    app_mentions: Option<Vec<Value>>,
    additional_context: Option<Value>,
) -> Result<Value, String> {
    if turn_id.trim().is_empty() {
        return Err("missing active turn id".to_string());
    }
    let input = build_turn_input_items(text, images, app_mentions)?;
    let mut params = Map::from_iter([
        ("threadId".to_string(), json!(thread_id)),
        ("expectedTurnId".to_string(), json!(turn_id)),
        ("input".to_string(), json!(input)),
    ]);
    insert_optional_non_null_value(&mut params, "additionalContext", additional_context);
    let params = Value::Object(params);
    session
        .send_request_for_workspace(&workspace_id, "turn/steer", params)
        .await
}

pub(crate) async fn collaboration_mode_list_core(
    sessions: &Mutex<HashMap<String, Arc<WorkspaceSession>>>,
    workspace_id: String,
) -> Result<Value, String> {
    let session = get_session_clone(sessions, &workspace_id).await?;
    session
        .send_request_for_workspace(&workspace_id, "collaborationMode/list", json!({}))
        .await
}

pub(crate) async fn turn_interrupt_core(
    sessions: &Mutex<HashMap<String, Arc<WorkspaceSession>>>,
    workspace_id: String,
    thread_id: String,
    turn_id: String,
) -> Result<Value, String> {
    let session = get_session_clone(sessions, &workspace_id).await?;
    turn_interrupt_with_session_core(&session, workspace_id, thread_id, turn_id).await
}

pub(crate) async fn turn_interrupt_with_session_core(
    session: &WorkspaceSession,
    workspace_id: String,
    thread_id: String,
    turn_id: String,
) -> Result<Value, String> {
    let params = json!({ "threadId": thread_id, "turnId": turn_id });
    let response = session
        .send_request_for_workspace(&workspace_id, "turn/interrupt", params)
        .await?;
    if let Some(message) = rpc_error_message(&response) {
        return Err(message.to_string());
    }
    if turn_id == "pending"
        || session
            .wait_for_turn_inactive(&thread_id, &turn_id, TURN_INTERRUPT_CONFIRM_TIMEOUT)
            .await
    {
        return Ok(response);
    }

    let thread = read_thread_with_session_core(session, workspace_id, thread_id.clone()).await?;
    if thread_response_confirms_terminal_turn(&thread, &turn_id) {
        session
            .clear_active_turn_if_matches(&thread_id, &turn_id)
            .await;
        return Ok(response);
    }

    Err("Turn interruption was acknowledged, but completion could not be confirmed.".to_string())
}

fn thread_response_confirms_terminal_turn(response: &Value, turn_id: &str) -> bool {
    let payload = response.get("result").unwrap_or(response);
    let thread = payload.get("thread").unwrap_or(payload);
    thread
        .get("turns")
        .and_then(Value::as_array)
        .is_some_and(|turns| {
            turns.iter().any(|turn| {
                turn.get("id").and_then(Value::as_str) == Some(turn_id)
                    && matches!(
                        turn.get("status").and_then(Value::as_str),
                        Some("completed" | "interrupted" | "failed")
                    )
            })
        })
}

fn rpc_error_message(response: &Value) -> Option<&str> {
    response
        .get("error")
        .and_then(|error| error.get("message"))
        .and_then(Value::as_str)
}

pub(crate) async fn start_review_core(
    sessions: &Mutex<HashMap<String, Arc<WorkspaceSession>>>,
    workspace_id: String,
    thread_id: String,
    target: Value,
    delivery: Option<String>,
) -> Result<Value, String> {
    let session = get_session_clone(sessions, &workspace_id).await?;
    let mut params = Map::new();
    params.insert("threadId".to_string(), json!(thread_id));
    params.insert("target".to_string(), target);
    if let Some(delivery) = delivery {
        params.insert("delivery".to_string(), json!(delivery));
    }
    session
        .send_request_for_workspace(&workspace_id, "review/start", Value::Object(params))
        .await
}

pub(crate) async fn model_list_core(
    sessions: &Mutex<HashMap<String, Arc<WorkspaceSession>>>,
    workspace_id: String,
) -> Result<Value, String> {
    let session = get_session_clone(sessions, &workspace_id).await?;
    session
        .send_request_for_workspace(&workspace_id, "model/list", json!({}))
        .await
}

pub(crate) async fn experimental_feature_list_core(
    sessions: &Mutex<HashMap<String, Arc<WorkspaceSession>>>,
    workspace_id: String,
    cursor: Option<String>,
    limit: Option<u32>,
) -> Result<Value, String> {
    let session = get_session_clone(sessions, &workspace_id).await?;
    let params = json!({ "cursor": cursor, "limit": limit });
    session
        .send_request_for_workspace(&workspace_id, "experimentalFeature/list", params)
        .await
}

pub(crate) async fn account_rate_limits_core(
    sessions: &Mutex<HashMap<String, Arc<WorkspaceSession>>>,
    workspace_id: String,
) -> Result<Value, String> {
    let session = get_session_clone(sessions, &workspace_id).await?;
    session
        .send_request_for_workspace(&workspace_id, "account/rateLimits/read", Value::Null)
        .await
}

pub(crate) async fn account_read_core(
    sessions: &Mutex<HashMap<String, Arc<WorkspaceSession>>>,
    workspaces: &Mutex<HashMap<String, WorkspaceEntry>>,
    workspace_id: String,
) -> Result<Value, String> {
    let session = {
        let sessions = sessions.lock().await;
        sessions.get(&workspace_id).cloned()
    };
    let response = if let Some(session) = session {
        session
            .send_request_for_workspace(&workspace_id, "account/read", Value::Null)
            .await
            .ok()
    } else {
        None
    };

    let (entry, parent_entry) = resolve_workspace_and_parent(workspaces, &workspace_id).await?;
    let codex_home = resolve_workspace_codex_home(&entry, parent_entry.as_ref())
        .or_else(resolve_default_codex_home);
    let fallback = read_auth_account(codex_home);

    Ok(build_account_response(response, fallback))
}

pub(crate) async fn codex_login_core(
    sessions: &Mutex<HashMap<String, Arc<WorkspaceSession>>>,
    codex_login_cancels: &Mutex<HashMap<String, CodexLoginCancelState>>,
    workspace_id: String,
) -> Result<Value, String> {
    let session = get_session_clone(sessions, &workspace_id).await?;
    let (cancel_tx, cancel_rx) = oneshot::channel::<()>();
    {
        let mut cancels = codex_login_cancels.lock().await;
        if let Some(existing) = cancels.remove(&workspace_id) {
            match existing {
                CodexLoginCancelState::PendingStart(tx) => {
                    let _ = tx.send(());
                }
                CodexLoginCancelState::LoginId(_) => {}
            }
        }
        cancels.insert(
            workspace_id.clone(),
            CodexLoginCancelState::PendingStart(cancel_tx),
        );
    }

    let start = Instant::now();
    let mut cancel_rx = cancel_rx;
    let workspace_for_request = workspace_id.clone();
    let mut login_request: Pin<Box<_>> = Box::pin(session.send_request_for_workspace(
        &workspace_for_request,
        "account/login/start",
        json!({ "type": "chatgpt" }),
    ));

    let response = loop {
        match cancel_rx.try_recv() {
            Ok(_) => {
                let mut cancels = codex_login_cancels.lock().await;
                cancels.remove(&workspace_id);
                return Err("Codex login canceled.".to_string());
            }
            Err(TryRecvError::Closed) => {
                let mut cancels = codex_login_cancels.lock().await;
                cancels.remove(&workspace_id);
                return Err("Codex login canceled.".to_string());
            }
            Err(TryRecvError::Empty) => {}
        }

        let elapsed = start.elapsed();
        if elapsed >= LOGIN_START_TIMEOUT {
            let mut cancels = codex_login_cancels.lock().await;
            cancels.remove(&workspace_id);
            return Err("Codex login start timed out.".to_string());
        }

        let tick = Duration::from_millis(150);
        let remaining = LOGIN_START_TIMEOUT.saturating_sub(elapsed);
        let wait_for = remaining.min(tick);

        match timeout(wait_for, &mut login_request).await {
            Ok(result) => break result?,
            Err(_elapsed) => continue,
        }
    };

    let payload = response.get("result").unwrap_or(&response);
    let login_id = payload
        .get("loginId")
        .or_else(|| payload.get("login_id"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| "missing login id in account/login/start response".to_string())?;
    let auth_url = payload
        .get("authUrl")
        .or_else(|| payload.get("auth_url"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| "missing auth url in account/login/start response".to_string())?;

    {
        let mut cancels = codex_login_cancels.lock().await;
        cancels.insert(
            workspace_id,
            CodexLoginCancelState::LoginId(login_id.clone()),
        );
    }

    Ok(json!({
        "loginId": login_id,
        "authUrl": auth_url,
        "raw": response,
    }))
}

pub(crate) async fn codex_login_cancel_core(
    sessions: &Mutex<HashMap<String, Arc<WorkspaceSession>>>,
    codex_login_cancels: &Mutex<HashMap<String, CodexLoginCancelState>>,
    workspace_id: String,
) -> Result<Value, String> {
    let cancel_state = {
        let mut cancels = codex_login_cancels.lock().await;
        cancels.remove(&workspace_id)
    };

    let Some(cancel_state) = cancel_state else {
        return Ok(json!({ "canceled": false }));
    };

    match cancel_state {
        CodexLoginCancelState::PendingStart(cancel_tx) => {
            let _ = cancel_tx.send(());
            return Ok(json!({
                "canceled": true,
                "status": "canceled",
            }));
        }
        CodexLoginCancelState::LoginId(login_id) => {
            let session = get_session_clone(sessions, &workspace_id).await?;
            let response = session
                .send_request_for_workspace(
                    &workspace_id,
                    "account/login/cancel",
                    json!({
                        "loginId": login_id,
                    }),
                )
                .await?;

            let payload = response.get("result").unwrap_or(&response);
            let status = payload
                .get("status")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let canceled = status.eq_ignore_ascii_case("canceled");

            Ok(json!({
                "canceled": canceled,
                "status": status,
                "raw": response,
            }))
        }
    }
}

pub(crate) async fn skills_list_core(
    sessions: &Mutex<HashMap<String, Arc<WorkspaceSession>>>,
    workspaces: &Mutex<HashMap<String, WorkspaceEntry>>,
    workspace_id: String,
) -> Result<Value, String> {
    let session = get_session_clone(sessions, &workspace_id).await?;
    let workspace_path = resolve_workspace_path_core(workspaces, &workspace_id).await?;

    // Codex can discover project-scoped skills from `<workspace>/.agents/skills`.
    // Some environments don't surface those reliably in ThreadFleet unless we
    // pass the default project skills path explicitly.
    let mut source_paths: Vec<String> = vec![];
    let project_skills_dir = Path::new(&workspace_path).join(".agents").join("skills");
    if project_skills_dir.is_dir() {
        if let Some(p) = project_skills_dir.to_str() {
            source_paths.push(p.to_string());
        }
    }

    let params = if source_paths.is_empty() {
        json!({ "cwd": workspace_path })
    } else {
        json!({ "cwd": workspace_path, "skillsPaths": source_paths })
    };

    let (mut response, native_error) = match session
        .send_request_for_workspace(&workspace_id, "skills/list", params)
        .await
    {
        Ok(response) => (response, None),
        Err(error) => (json!({ "skills": [] }), Some(error)),
    };

    let codex_home = resolve_codex_home_for_workspace_core(workspaces, &workspace_id).await?;
    let native_paths = workflow_registry_core::native_skill_paths(&response);
    let registry = workflow_registry_core::build_registry_snapshot(
        &codex_home,
        resolve_home_dir().as_deref(),
        Path::new(&workspace_path),
        &native_paths,
    );

    // Attach diagnostics for the UI (non-breaking: keep original response fields).
    if let Value::Object(ref mut obj) = response {
        obj.insert("sourcePaths".to_string(), json!(source_paths));
        obj.insert(
            "sourceErrors".to_string(),
            json!(native_error.into_iter().collect::<Vec<_>>()),
        );
        obj.insert("cmRegistry".to_string(), json!(registry));
    }

    Ok(response)
}

pub(crate) async fn apps_list_core(
    sessions: &Mutex<HashMap<String, Arc<WorkspaceSession>>>,
    workspace_id: String,
    cursor: Option<String>,
    limit: Option<u32>,
    thread_id: Option<String>,
) -> Result<Value, String> {
    let session = get_session_clone(sessions, &workspace_id).await?;
    let params = json!({ "cursor": cursor, "limit": limit, "threadId": thread_id });
    session
        .send_request_for_workspace(&workspace_id, "app/list", params)
        .await
}

pub(crate) async fn respond_to_server_request_core(
    sessions: &Mutex<HashMap<String, Arc<WorkspaceSession>>>,
    workspace_id: String,
    request_id: Value,
    result: Value,
) -> Result<(), String> {
    let session = get_session_clone(sessions, &workspace_id).await?;
    session.send_response(request_id, result).await
}

pub(crate) async fn remember_approval_rule_core(
    workspaces: &Mutex<HashMap<String, WorkspaceEntry>>,
    workspace_id: String,
    command: Vec<String>,
) -> Result<Value, String> {
    let command = command
        .into_iter()
        .map(|item| item.trim().to_string())
        .filter(|item| !item.is_empty())
        .collect::<Vec<_>>();
    if command.is_empty() {
        return Err("empty command".to_string());
    }

    let codex_home = resolve_codex_home_for_workspace_core(workspaces, &workspace_id).await?;
    let rules_path = rules::default_rules_path(&codex_home);
    rules::append_prefix_rule(&rules_path, &command)?;

    Ok(json!({
        "ok": true,
        "rulesPath": rules_path,
    }))
}

pub(crate) async fn get_config_model_core(
    workspaces: &Mutex<HashMap<String, WorkspaceEntry>>,
    workspace_id: String,
) -> Result<Value, String> {
    let codex_home = resolve_codex_home_for_workspace_core(workspaces, &workspace_id).await?;
    let model = codex_config::read_config_model(Some(codex_home))?;
    Ok(json!({ "model": model }))
}

pub(crate) async fn get_provider_status_core(
    workspaces: &Mutex<HashMap<String, WorkspaceEntry>>,
    settings: &AppSettings,
    workspace_id: String,
) -> Result<Value, String> {
    let codex_home = resolve_codex_home_for_workspace_core(workspaces, &workspace_id).await?;
    let active_profile = provider_profiles_core::effective_execution_profile(settings);
    let active_profile_base_url = active_profile
        .as_ref()
        .and_then(|profile| profile.base_url.as_deref());
    let status = codex_config::read_provider_status(
        Some(codex_home),
        active_profile_base_url,
        active_profile.is_some(),
    )?;
    serde_json::to_value(status).map_err(|err| err.to_string())
}

fn resolve_third_party_usage_credentials(
    settings: &AppSettings,
    document: &toml_edit::Document,
    default_api_key: Option<String>,
) -> Option<(String, String, String, Option<String>, Option<String>)> {
    let active_profile = provider_profiles_core::effective_usage_profile(settings);
    if let Some(profile) = active_profile {
        if profile.provider_kind.eq_ignore_ascii_case("openai") {
            return None;
        }
        return provider_profiles_core::resolve_profile_base_url(&profile).map(|base_url| {
            (
                base_url,
                profile.key.clone(),
                profile.usage_protocol.clone(),
                profile.new_api_access_token.clone(),
                profile.new_api_session_cookie.clone(),
            )
        });
    }

    let provider_name = config_toml_core::read_top_level_string(document, "model_provider");
    let base_url = provider_name.as_deref().and_then(|provider| {
        config_toml_core::read_nested_string(document, &["model_providers", provider, "base_url"])
    })?;
    if codex_config::is_official_openai_url(&base_url) {
        return None;
    }
    default_api_key.map(|api_key| (base_url, api_key, "auto".to_string(), None, None))
}

pub(crate) async fn workspace_third_party_key_usage_core(
    workspaces: &Mutex<HashMap<String, WorkspaceEntry>>,
    settings: &AppSettings,
    workspace_id: String,
    timezone: Option<String>,
    day_start_unix: Option<i64>,
) -> Result<Value, String> {
    let codex_home = resolve_codex_home_for_workspace_core(workspaces, &workspace_id).await?;
    let active_profile_selected =
        provider_profiles_core::effective_usage_profile(settings).is_some();
    let (document, default_api_key) = if active_profile_selected {
        (toml_edit::Document::new(), None)
    } else {
        let (_, document) = config_toml_core::load_global_config_document(&codex_home)?;
        (document, read_auth_api_key(&codex_home))
    };
    let credentials = resolve_third_party_usage_credentials(settings, &document, default_api_key);

    let Some((base_url, api_key, usage_protocol, new_api_access_token, new_api_session_cookie)) =
        credentials
    else {
        return Ok(Value::Null);
    };
    provider_profiles_core::third_party_key_usage_core(
        base_url,
        api_key,
        new_api_access_token,
        new_api_session_cookie,
        timezone,
        day_start_unix,
        Some(usage_protocol),
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{
        CodexCredential, CodexCredentialGroup, CodexKeyProfile, CodexProvider, CredentialSelection,
    };
    use serde_json::Value;
    use toml_edit::Document;

    #[test]
    fn thread_response_confirms_only_matching_terminal_turn() {
        let response = json!({
            "result": {
                "thread": {
                    "turns": [
                        { "id": "turn-old", "status": "completed" },
                        { "id": "turn-target", "status": "interrupted" }
                    ]
                }
            }
        });

        assert!(thread_response_confirms_terminal_turn(
            &response,
            "turn-target"
        ));
        assert!(!thread_response_confirms_terminal_turn(
            &response,
            "turn-missing"
        ));
    }

    #[test]
    fn thread_response_rejects_matching_in_progress_turn() {
        let response = json!({
            "result": {
                "thread": {
                    "turns": [{ "id": "turn-target", "status": "inProgress" }]
                }
            }
        });

        assert!(!thread_response_confirms_terminal_turn(
            &response,
            "turn-target"
        ));
    }

    #[test]
    fn rpc_error_message_reads_protocol_errors() {
        assert_eq!(
            rpc_error_message(&json!({ "error": { "message": "turn not found" } })),
            Some("turn not found")
        );
        assert_eq!(rpc_error_message(&json!({ "result": {} })), None);
    }

    #[test]
    fn normalize_strips_file_uri_prefix() {
        assert_eq!(
            normalize_file_path("file:///var/mobile/Containers/Data/photo.jpg"),
            "/var/mobile/Containers/Data/photo.jpg"
        );
    }

    fn provider_document(base_url: &str) -> Document {
        format!(
            r#"
model_provider = "custom"

[model_providers.custom]
base_url = "{base_url}"
"#,
        )
        .parse()
        .expect("provider config")
    }

    #[test]
    fn third_party_usage_credentials_use_default_codex_provider() {
        let credentials = resolve_third_party_usage_credentials(
            &AppSettings::default(),
            &provider_document("https://fcodex.top/v1"),
            Some("sk-default".to_string()),
        );

        assert_eq!(
            credentials,
            Some((
                "https://fcodex.top/v1".to_string(),
                "sk-default".to_string(),
                "auto".to_string(),
                None,
                None,
            ))
        );
    }

    #[test]
    fn third_party_usage_credentials_prefer_active_profile() {
        let mut settings = AppSettings::default();
        settings.codex_key_profiles = vec![CodexKeyProfile {
            id: "profile".to_string(),
            name: "Profile".to_string(),
            provider_kind: "deepseek".to_string(),
            usage_protocol: "auto".to_string(),
            new_api_access_token: Some("access-profile".to_string()),
            new_api_session_cookie: None,
            key_env_var: "OPENAI_API_KEY".to_string(),
            key: "sk-profile".to_string(),
            base_url_env_var: "OPENAI_BASE_URL".to_string(),
            base_url: Some("https://api.deepseek.com/v1".to_string()),
            model: None,
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
        settings.active_codex_key_profile_id = Some("profile".to_string());

        let credentials = resolve_third_party_usage_credentials(
            &settings,
            &provider_document("https://fcodex.top/v1"),
            Some("sk-default".to_string()),
        );

        assert_eq!(
            credentials,
            Some((
                "https://api.deepseek.com/v1".to_string(),
                "sk-profile".to_string(),
                "auto".to_string(),
                Some("access-profile".to_string()),
                None,
            ))
        );
    }

    #[test]
    fn third_party_usage_credentials_use_usage_override_without_changing_execution() {
        let mut settings = AppSettings::default();
        settings.codex_providers = vec![
            CodexProvider {
                id: "provider-execution".to_string(),
                name: "Execution".to_string(),
                provider_kind: "custom".to_string(),
                usage_protocol: "auto".to_string(),
                base_url_env_var: "OPENAI_BASE_URL".to_string(),
                base_url: Some("https://execution.example.com/v1".to_string()),
                model: None,
                context_window: None,
                max_output_tokens: None,
                use_gateway: false,
                transport_mode: "auto".to_string(),
                supports_thinking: false,
                supports_reasoning_effort: false,
                default_reasoning_effort: None,
                last_model_refresh_at_ms: None,
                cached_models: Vec::new(),
                groups: vec![CodexCredentialGroup {
                    id: "group-execution".to_string(),
                    name: "Execution".to_string(),
                    credentials: vec![CodexCredential {
                        id: "key-execution".to_string(),
                        name: "Execution".to_string(),
                        key: "execution-key".to_string(),
                        new_api_access_token: None,
                        new_api_session_cookie: None,
                        key_env_var: "OPENAI_API_KEY".to_string(),
                        function_tool_capability: None,
                    }],
                }],
            },
            CodexProvider {
                id: "provider-usage".to_string(),
                name: "Usage".to_string(),
                provider_kind: "custom".to_string(),
                usage_protocol: "new-api".to_string(),
                base_url_env_var: "OPENAI_BASE_URL".to_string(),
                base_url: Some("https://usage.example.com/v1".to_string()),
                model: None,
                context_window: None,
                max_output_tokens: None,
                use_gateway: false,
                transport_mode: "auto".to_string(),
                supports_thinking: false,
                supports_reasoning_effort: false,
                default_reasoning_effort: None,
                last_model_refresh_at_ms: None,
                cached_models: Vec::new(),
                groups: vec![CodexCredentialGroup {
                    id: "group-usage".to_string(),
                    name: "Usage".to_string(),
                    credentials: vec![CodexCredential {
                        id: "key-usage".to_string(),
                        name: "Usage".to_string(),
                        key: "usage-key".to_string(),
                        new_api_access_token: Some("usage-access-token".to_string()),
                        new_api_session_cookie: None,
                        key_env_var: "OPENAI_API_KEY".to_string(),
                        function_tool_capability: None,
                    }],
                }],
            },
        ];
        settings.execution_credential_selection = Some(CredentialSelection {
            provider_id: "provider-execution".to_string(),
            group_id: "group-execution".to_string(),
            credential_id: "key-execution".to_string(),
        });
        settings.usage_credential_selection = Some(CredentialSelection {
            provider_id: "provider-usage".to_string(),
            group_id: "group-usage".to_string(),
            credential_id: "key-usage".to_string(),
        });

        let credentials = resolve_third_party_usage_credentials(
            &settings,
            &provider_document("https://ignored.example.com/v1"),
            None,
        );

        assert_eq!(
            credentials,
            Some((
                "https://usage.example.com/v1".to_string(),
                "usage-key".to_string(),
                "new-api".to_string(),
                Some("usage-access-token".to_string()),
                None,
            ))
        );
    }

    #[test]
    fn third_party_usage_credentials_ignore_official_openai_provider() {
        let credentials = resolve_third_party_usage_credentials(
            &AppSettings::default(),
            &provider_document("https://api.openai.com/v1"),
            Some("sk-default".to_string()),
        );

        assert_eq!(credentials, None);
    }

    #[test]
    fn normalize_strips_file_localhost_prefix() {
        assert_eq!(
            normalize_file_path("file://localhost/Users/test/image.png"),
            "/Users/test/image.png"
        );
    }

    #[test]
    fn normalize_decodes_percent_encoding() {
        assert_eq!(
            normalize_file_path("file:///var/mobile/path%20with%20spaces/img.jpg"),
            "/var/mobile/path with spaces/img.jpg"
        );
    }

    #[test]
    fn normalize_plain_path_unchanged() {
        assert_eq!(
            normalize_file_path("/var/mobile/Containers/Data/photo.jpg"),
            "/var/mobile/Containers/Data/photo.jpg"
        );
    }

    #[test]
    fn normalize_plain_path_percent_sequences_unchanged() {
        assert_eq!(
            normalize_file_path("/tmp/report%20final.png"),
            "/tmp/report%20final.png"
        );
    }

    #[test]
    fn normalize_trims_whitespace() {
        assert_eq!(normalize_file_path("  /tmp/image.png  "), "/tmp/image.png");
    }

    #[test]
    fn read_image_data_url_core_rejects_file_uri_that_does_not_exist() {
        let result = read_image_as_data_url_core("file:///nonexistent/photo.png");
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(
            !err.contains("file://"),
            "error should reference normalized path, got: {err}"
        );
        assert!(err.contains("/nonexistent/photo.png"));
    }

    #[test]
    fn read_image_data_url_core_succeeds_with_file_uri_for_real_file() {
        let dir = std::env::temp_dir().join("codex_monitor_test");
        std::fs::create_dir_all(&dir).unwrap();
        let img_path = dir.join("test_photo.png");
        let png_bytes: &[u8] = &[
            0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48,
            0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00,
            0x00, 0x90, 0x77, 0x53, 0xDE, 0x00, 0x00, 0x00, 0x0C, 0x49, 0x44, 0x41, 0x54, 0x08,
            0xD7, 0x63, 0xF8, 0xCF, 0xC0, 0x00, 0x00, 0x00, 0x02, 0x00, 0x01, 0xE2, 0x21, 0xBC,
            0x33, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
        ];
        std::fs::write(&img_path, png_bytes).unwrap();

        let file_uri = format!("file://{}", img_path.display());
        let result = read_image_as_data_url_core(&file_uri);
        assert!(
            result.is_ok(),
            "file:// URI for real file should succeed, got: {:?}",
            result.err()
        );
        let data_url = result.unwrap();
        assert!(data_url.starts_with("data:image/png;base64,"));

        let space_dir = dir.join("path with spaces");
        std::fs::create_dir_all(&space_dir).unwrap();
        let space_img = space_dir.join("photo.png");
        std::fs::write(&space_img, png_bytes).unwrap();
        let encoded_uri = format!(
            "file://{}",
            space_img.display().to_string().replace(' ', "%20")
        );
        let result2 = read_image_as_data_url_core(&encoded_uri);
        assert!(
            result2.is_ok(),
            "percent-encoded file:// URI should succeed, got: {:?}",
            result2.err()
        );

        let percent_img = dir.join("report%20final.png");
        std::fs::write(&percent_img, png_bytes).unwrap();
        let plain_percent_path = percent_img.display().to_string();
        let result3 = read_image_as_data_url_core(&plain_percent_path);
        assert!(
            result3.is_ok(),
            "plain filesystem paths with percent sequences should not be decoded, got: {:?}",
            result3.err()
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn heif_paths_are_inlined_for_codex() {
        assert!(should_inline_image_path_for_codex("/tmp/photo.heic"));
        assert!(should_inline_image_path_for_codex("/tmp/photo.HEIF"));
        assert!(!should_inline_image_path_for_codex("/tmp/photo.png"));
    }

    #[test]
    fn thread_read_authority_is_added_without_changing_the_app_server_result() {
        let response = json!({
            "id": 7,
            "result": { "thread": { "id": "thread-1" } }
        });

        let annotated = annotate_thread_read_authority(response, "execution");

        assert_eq!(annotated["codexMonitorReadAuthority"], "execution");
        assert_eq!(annotated["result"]["thread"]["id"], "thread-1");
    }

    #[test]
    fn build_turn_input_items_inlines_text_data_attachments() {
        let input = build_turn_input_items(
            "read this".to_string(),
            Some(vec![
                "data:text/plain;name=notes.txt;base64,aGVsbG8gd29ybGQ=".to_string(),
            ]),
            None,
        )
        .expect("text data attachment should inline");

        assert_eq!(input[0]["type"], "text");
        assert_eq!(input[1]["type"], "text");
        let text = input[1]["text"].as_str().unwrap_or_default();
        assert!(text.contains("<attached_file name=\"notes.txt\""));
        assert!(text.contains("hello world"));
    }

    #[test]
    fn build_turn_input_items_inlines_text_file_paths() {
        let dir = std::env::temp_dir().join("codex_monitor_text_attachment_test");
        std::fs::create_dir_all(&dir).unwrap();
        let text_path = dir.join("notes.md");
        std::fs::write(&text_path, "# Notes\nhello").unwrap();

        let input = build_turn_input_items(
            String::new(),
            Some(vec![text_path.display().to_string()]),
            None,
        )
        .expect("text file attachment should inline");

        assert_eq!(input.len(), 1);
        assert_eq!(input[0]["type"], "text");
        let text = input[0]["text"].as_str().unwrap_or_default();
        assert!(text.contains("<attached_file name=\"notes.md\""));
        assert!(text.contains("# Notes\nhello"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn insert_optional_nullable_string_omits_missing_and_preserves_null() {
        let mut params = Map::new();

        insert_optional_nullable_string(&mut params, "serviceTier", None);
        assert!(!params.contains_key("serviceTier"));

        insert_optional_nullable_string(&mut params, "serviceTier", Some(None));
        assert_eq!(params.get("serviceTier"), Some(&Value::Null));

        insert_optional_nullable_string(&mut params, "serviceTier", Some(Some("fast".to_string())));
        assert_eq!(params.get("serviceTier"), Some(&json!("fast")));
    }

    #[test]
    fn insert_optional_non_null_value_forwards_additional_context() {
        let mut params = Map::new();
        insert_optional_non_null_value(
            &mut params,
            "additionalContext",
            Some(json!({
                "cm.workflow": {
                    "kind": "application",
                    "value": "workflow context"
                }
            })),
        );

        assert_eq!(
            params["additionalContext"]["cm.workflow"]["kind"],
            json!("application")
        );
        insert_optional_non_null_value(&mut params, "ignored", Some(Value::Null));
        assert!(!params.contains_key("ignored"));
    }

    #[test]
    fn thread_list_source_kinds_exclude_generic_subagent_and_keep_explicit_variants() {
        assert!(!THREAD_LIST_SOURCE_KINDS.contains(&"subAgent"));
        assert!(THREAD_LIST_SOURCE_KINDS.contains(&"subAgentReview"));
        assert!(THREAD_LIST_SOURCE_KINDS.contains(&"subAgentCompact"));
        assert!(THREAD_LIST_SOURCE_KINDS.contains(&"subAgentThreadSpawn"));
    }

    #[test]
    fn read_thread_params_request_turn_history() {
        let params = build_read_thread_params("thread-1".to_string());

        assert_eq!(params["threadId"], json!("thread-1"));
        assert_eq!(params["includeTurns"], json!(true));
        assert_eq!(
            build_read_thread_metadata_params("thread-1"),
            json!({ "threadId": "thread-1", "includeTurns": false })
        );
    }

    #[test]
    fn thread_history_pages_walk_backward_without_overlap() {
        let response = json!({
            "result": {
                "thread": {
                    "id": "thread-1",
                    "path": "D:/sessions/rollout-thread-1.jsonl",
                    "turns": [
                        { "id": "turn-1", "items": [
                            { "id": "item-1" },
                            { "id": "item-2" },
                            { "id": "item-3" }
                        ] },
                        { "id": "turn-2", "items": [
                            { "id": "item-4" },
                            { "id": "item-5" }
                        ] }
                    ]
                }
            }
        });

        let latest = paginate_thread_history_response(response.clone(), None, Some(2), None)
            .expect("latest page");
        let latest_ids = latest["result"]["thread"]["turns"]
            .as_array()
            .unwrap()
            .iter()
            .flat_map(|turn| turn["items"].as_array().unwrap())
            .map(|item| item["id"].as_str().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(latest_ids, vec!["item-4", "item-5"]);
        assert_eq!(latest["codexMonitorHistoryPage"]["hasMore"], json!(true));

        let cursor = latest["codexMonitorHistoryPage"]["nextCursor"]
            .as_str()
            .unwrap()
            .to_string();
        let older = paginate_thread_history_response(response, Some(cursor), Some(2), None)
            .expect("older page");
        let older_ids = older["result"]["thread"]["turns"]
            .as_array()
            .unwrap()
            .iter()
            .flat_map(|turn| turn["items"].as_array().unwrap())
            .map(|item| item["id"].as_str().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(older_ids, vec!["item-2", "item-3"]);
    }

    #[test]
    fn thread_history_page_enforces_byte_budget_after_one_item() {
        let response = json!({
            "result": { "thread": {
                "id": "thread-1",
                "turns": [{ "id": "turn-1", "items": [
                    { "id": "item-1", "text": "a".repeat(80) },
                    { "id": "item-2", "text": "b".repeat(80) }
                ] }]
            } }
        });

        let page = paginate_thread_history_response(response, None, Some(10), Some(100))
            .expect("bounded page");

        assert_eq!(page["codexMonitorHistoryPage"]["itemCount"], json!(1));
        assert_eq!(page["codexMonitorHistoryPage"]["hasMore"], json!(true));
    }

    #[test]
    fn initial_thread_history_page_preserves_latest_empty_turn_metadata() {
        let response = json!({
            "result": { "thread": {
                "id": "thread-1",
                "turns": [
                    { "id": "turn-1", "status": "completed", "items": [
                        { "id": "item-1" }
                    ] },
                    { "id": "turn-2", "status": "inProgress", "items": [] }
                ]
            } }
        });

        let page =
            paginate_thread_history_response(response, None, Some(1), None).expect("initial page");
        let turns = page["result"]["thread"]["turns"].as_array().unwrap();

        assert_eq!(turns.len(), 2);
        assert_eq!(turns[1]["id"], json!("turn-2"));
        assert_eq!(turns[1]["status"], json!("inProgress"));
        assert_eq!(turns[1]["items"], json!([]));
    }

    #[test]
    fn native_thread_history_page_resumes_inside_an_upstream_page() {
        let metadata = json!({
            "result": { "thread": {
                "id": "thread-1",
                "path": "D:/sessions/rollout-thread-1.jsonl"
            } }
        });
        let first_item = json!({ "type": "agentMessage", "id": "item-4", "text": "x".repeat(80) });
        let first_item_bytes = serde_json::to_vec(&first_item).unwrap().len();
        let items = json!({
            "result": {
                "data": [
                    { "turnId": "turn-2", "item": first_item },
                    { "turnId": "turn-2", "item": {
                        "type": "agentMessage", "id": "item-3", "text": "y".repeat(80)
                    } },
                    { "turnId": "turn-1", "item": {
                        "type": "userMessage", "id": "item-2", "content": []
                    } }
                ],
                "nextCursor": "upstream-older"
            }
        });
        let latest_turn = json!({
            "result": { "data": [{
                "id": "turn-2", "status": "completed", "items": []
            }] }
        });

        let first = paginate_native_thread_history_response(
            metadata.clone(),
            &items,
            &latest_turn,
            None,
            3,
            first_item_bytes,
        )
        .expect("first native page");
        let first_ids = first["result"]["thread"]["turns"]
            .as_array()
            .unwrap()
            .iter()
            .flat_map(|turn| turn["items"].as_array().unwrap())
            .map(|item| item["id"].as_str().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(first_ids, vec!["item-4"]);
        let cursor = first["codexMonitorHistoryPage"]["nextCursor"]
            .as_str()
            .unwrap();
        let cursor = decode_native_thread_history_cursor(cursor)
            .unwrap()
            .expect("native cursor");
        assert_eq!(cursor.upstream_cursor, None);
        assert_eq!(cursor.offset, 1);
        assert_eq!(cursor.page_limit, 3);
        assert!(cursor.boundary_item_hash.is_some());

        let shifted_items = json!({
            "result": {
                "data": [
                    { "turnId": "turn-3", "item": {
                        "type": "agentMessage", "id": "item-5", "text": "new"
                    } },
                    { "turnId": "turn-2", "item": {
                        "type": "agentMessage", "id": "item-4", "text": "x".repeat(80)
                    } },
                    { "turnId": "turn-2", "item": {
                        "type": "agentMessage", "id": "item-3", "text": "y".repeat(80)
                    } },
                    { "turnId": "turn-1", "item": {
                        "type": "userMessage", "id": "item-2", "content": []
                    } }
                ],
                "nextCursor": "upstream-older"
            }
        });

        let second = paginate_native_thread_history_response(
            metadata,
            &shifted_items,
            &latest_turn,
            Some(&cursor),
            1,
            THREAD_HISTORY_PAGE_MAX_BYTES,
        )
        .expect("second native page");
        let second_ids = second["result"]["thread"]["turns"]
            .as_array()
            .unwrap()
            .iter()
            .flat_map(|turn| turn["items"].as_array().unwrap())
            .map(|item| item["id"].as_str().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(second_ids, vec!["item-3"]);
    }

    #[test]
    fn native_thread_history_page_carries_the_upstream_cursor_forward() {
        let metadata = json!({
            "result": { "thread": { "id": "thread-1" } }
        });
        let items = json!({
            "result": {
                "data": [{ "turnId": "turn-1", "item": {
                    "type": "agentMessage", "id": "item-1", "text": "done"
                } }],
                "nextCursor": "upstream-older"
            }
        });

        let page = paginate_native_thread_history_response(
            metadata,
            &items,
            &json!({ "result": { "data": [] } }),
            None,
            1,
            THREAD_HISTORY_PAGE_MAX_BYTES,
        )
        .expect("native page");
        let cursor = page["codexMonitorHistoryPage"]["nextCursor"]
            .as_str()
            .unwrap();
        let cursor = decode_native_thread_history_cursor(cursor)
            .unwrap()
            .expect("native cursor");

        assert_eq!(cursor.upstream_cursor.as_deref(), Some("upstream-older"));
        assert_eq!(cursor.offset, 0);
        assert_eq!(cursor.boundary_item_hash, None);
    }

    #[test]
    fn native_thread_history_page_preserves_latest_empty_turn_metadata() {
        let page = paginate_native_thread_history_response(
            json!({ "result": { "thread": { "id": "thread-1" } } }),
            &json!({ "result": { "data": [{
                "turnId": "turn-1",
                "item": { "type": "agentMessage", "id": "item-1", "text": "done" }
            }], "nextCursor": null } }),
            &json!({ "result": { "data": [{
                "id": "turn-2", "status": "inProgress", "items": []
            }] } }),
            None,
            10,
            THREAD_HISTORY_PAGE_MAX_BYTES,
        )
        .expect("native page");
        let turns = page["result"]["thread"]["turns"].as_array().unwrap();

        assert_eq!(turns.len(), 2);
        assert_eq!(turns[1]["id"], json!("turn-2"));
        assert_eq!(turns[1]["status"], json!("inProgress"));
        assert_eq!(turns[1]["items"], json!([]));
    }

    #[test]
    fn native_history_page_detects_a_terminal_latest_turn_without_an_agent_message() {
        let page = paginate_native_thread_history_response(
            json!({ "result": { "thread": { "id": "thread-1" } } }),
            &json!({ "result": { "data": (0..50).map(|index| json!({
                "turnId": "turn-1",
                "item": {
                    "type": "dynamicToolCall",
                    "id": format!("tool-{index}"),
                    "tool": "exec"
                }
            })).collect::<Vec<_>>(), "nextCursor": null } }),
            &json!({ "result": { "data": [{
                "id": "turn-1", "status": "completed", "items": []
            }] } }),
            None,
            50,
            THREAD_HISTORY_PAGE_MAX_BYTES,
        )
        .expect("native page");

        assert!(native_history_page_misses_latest_terminal_agent_message(
            &page
        ));
    }

    #[test]
    fn native_history_page_detects_a_terminal_latest_turn_without_a_final_answer() {
        let page = paginate_native_thread_history_response(
            json!({ "result": { "thread": { "id": "thread-1" } } }),
            &json!({ "result": { "data": [{
                "turnId": "turn-1",
                "item": {
                    "type": "agentMessage",
                    "id": "commentary-1",
                    "phase": "commentary",
                    "text": "Still working"
                }
            }], "nextCursor": null } }),
            &json!({ "result": { "data": [{
                "id": "turn-1", "status": "completed", "items": []
            }] } }),
            None,
            50,
            THREAD_HISTORY_PAGE_MAX_BYTES,
        )
        .expect("native page");

        assert!(native_history_page_misses_latest_terminal_agent_message(
            &page
        ));
    }

    #[test]
    fn rollout_enrichment_restores_a_missing_final_answer() {
        let mut current_turn_id = None;
        let mut enrichment = RolloutThreadEnrichment::default();
        for line in [
            r#"{"type":"turn_context","payload":{"turn_id":"turn-1"}}"#,
            r#"{"timestamp":"2026-08-01T19:43:47.200Z","type":"response_item","payload":{"type":"message","id":"final-1","role":"assistant","phase":"final_answer","content":[{"type":"output_text","text":"Recovered final answer"}]}}"#,
        ] {
            collect_rollout_enrichment_line(line, &mut current_turn_id, &mut enrichment);
        }
        let mut response = json!({
            "result": {
                "thread": {
                    "turns": [{
                        "id": "turn-1",
                        "items": [{
                            "type": "dynamicToolCall",
                            "id": "tool-1",
                            "tool": "exec"
                        }]
                    }]
                }
            }
        });

        apply_rollout_enrichment(&mut response, &enrichment);

        let items = response["result"]["thread"]["turns"][0]["items"]
            .as_array()
            .expect("thread items");
        assert_eq!(
            items.last().and_then(|item| item.get("id")),
            Some(&json!("final-1"))
        );
        assert_eq!(
            items.last().and_then(|item| item.get("phase")),
            Some(&json!("final_answer"))
        );
        assert_eq!(
            items.last().and_then(|item| item.get("text")),
            Some(&json!("Recovered final answer"))
        );
    }

    #[test]
    fn rollout_enrichment_restores_missing_assistant_messages_without_duplicates() {
        let mut current_turn_id = None;
        let mut enrichment = RolloutThreadEnrichment::default();
        for line in [
            r#"{"type":"turn_context","payload":{"turn_id":"turn-1"}}"#,
            r#"{"timestamp":"2026-08-01T19:43:46.000Z","type":"response_item","payload":{"type":"message","id":"commentary-1","role":"assistant","phase":"commentary","content":[{"type":"output_text","text":"Checking"}]}}"#,
            r#"{"timestamp":"2026-08-01T19:43:47.000Z","type":"response_item","payload":{"type":"message","id":"final-1","role":"assistant","phase":"final_answer","content":[{"type":"output_text","text":"Recovered final answer"}]}}"#,
        ] {
            collect_rollout_enrichment_line(line, &mut current_turn_id, &mut enrichment);
        }
        let mut response = json!({
            "result": {
                "thread": {
                    "turns": [{
                        "id": "turn-1",
                        "items": [
                            { "type": "userMessage", "id": "user-1" },
                            {
                                "type": "agentMessage",
                                "id": "server-final",
                                "phase": "final_answer",
                                "text": "Recovered final answer"
                            }
                        ]
                    }]
                }
            }
        });

        apply_rollout_enrichment(&mut response, &enrichment);

        let items = response["result"]["thread"]["turns"][0]["items"]
            .as_array()
            .expect("thread items");
        assert_eq!(
            items
                .iter()
                .filter(|item| item.get("type") == Some(&json!("agentMessage")))
                .count(),
            2
        );
        assert_eq!(items[1]["id"], json!("commentary-1"));
        assert_eq!(items[2]["id"], json!("server-final"));
        assert_eq!(items[2]["phase"], json!("final_answer"));
    }

    #[test]
    fn legacy_history_page_keeps_the_latest_final_answer_after_many_tool_items() {
        let mut turn_items = (0..50)
            .map(|index| {
                json!({
                    "type": "dynamicToolCall",
                    "id": format!("tool-{index}"),
                    "tool": "exec"
                })
            })
            .collect::<Vec<_>>();
        turn_items.push(json!({
            "type": "agentMessage",
            "id": "final-1",
            "phase": "final_answer",
            "text": "Done"
        }));
        let response = json!({ "result": { "thread": {
            "id": "thread-1",
            "turns": [{
                "id": "turn-1",
                "status": "completed",
                "items": turn_items
            }]
        } } });

        let page =
            paginate_thread_history_response(response, None, Some(50), None).expect("latest page");
        let items = page["result"]["thread"]["turns"][0]["items"]
            .as_array()
            .expect("turn items");

        assert_eq!(items.len(), 50);
        assert_eq!(
            items.last().and_then(|item| item.get("id")),
            Some(&json!("final-1"))
        );
    }

    #[test]
    fn native_thread_history_page_rejects_a_cursor_from_another_thread() {
        let first = json!({ "result": { "thread": { "id": "thread-1" } } });
        let second = json!({ "result": { "thread": { "id": "thread-2" } } });
        let cursor = NativeThreadHistoryCursor {
            snapshot_id: thread_history_snapshot_id(&first),
            upstream_cursor: None,
            offset: 0,
            page_limit: 10,
            boundary_item_hash: None,
        };

        let error = paginate_native_thread_history_response(
            second,
            &json!({ "result": { "data": [] } }),
            &json!({ "result": { "data": [] } }),
            Some(&cursor),
            10,
            THREAD_HISTORY_PAGE_MAX_BYTES,
        )
        .expect_err("cross-thread native cursor must fail");

        assert!(error.contains("snapshot does not match"));
    }

    #[test]
    fn thread_history_page_rejects_a_cursor_from_another_thread() {
        let first = json!({
            "result": { "thread": {
                "id": "thread-1",
                "turns": [{ "items": [{ "id": "item-1" }, { "id": "item-2" }] }]
            } }
        });
        let second = json!({
            "result": { "thread": {
                "id": "thread-2",
                "turns": [{ "items": [{ "id": "item-1" }, { "id": "item-2" }] }]
            } }
        });
        let page = paginate_thread_history_response(first, None, Some(1), None).unwrap();
        let cursor = page["codexMonitorHistoryPage"]["nextCursor"]
            .as_str()
            .unwrap()
            .to_string();

        let error = paginate_thread_history_response(second, Some(cursor), Some(1), None)
            .expect_err("cross-thread cursor must fail");

        assert!(error.contains("snapshot does not match"));
    }

    #[test]
    fn active_provider_runtime_overrides_start_and_resume_provider() {
        let start = build_start_thread_params(
            "D:/workspace".to_string(),
            None,
            model_provider_override_for_runtime(Some("fingerprint")),
        );
        assert_eq!(start["modelProvider"], json!("codex_monitor"));

        assert_eq!(
            model_provider_override_for_runtime(Some("fingerprint")),
            Some("codex_monitor")
        );
        assert_eq!(model_provider_override_for_runtime(None), None);
    }

    #[test]
    fn rollout_message_timestamps_are_applied_to_matching_thread_items() {
        let mut current_turn_id = None;
        let mut enrichment = RolloutThreadEnrichment::default();
        for line in [
            r#"{"type":"turn_context","payload":{"turn_id":"turn-1"}}"#,
            r#"{"timestamp":"2026-07-18T12:00:00.000Z","type":"response_item","payload":{"type":"message","role":"user"}}"#,
            r#"{"timestamp":"2026-07-18T12:00:05.000Z","type":"response_item","payload":{"type":"reasoning"}}"#,
            r#"{"timestamp":"2026-07-18T12:00:10.000Z","type":"response_item","payload":{"type":"message","role":"assistant"}}"#,
            r#"{"timestamp":"2026-07-18T12:00:20.000Z","type":"response_item","payload":{"type":"message","role":"assistant"}}"#,
        ] {
            collect_rollout_enrichment_line(line, &mut current_turn_id, &mut enrichment);
        }
        let mut response = json!({
            "result": {
                "thread": {
                    "turns": [{
                        "id": "turn-1",
                        "items": [
                            { "type": "userMessage", "id": "item-1" },
                            { "type": "reasoning", "id": "item-2" },
                            { "type": "agentMessage", "id": "item-3" },
                            { "type": "agentMessage", "id": "item-4" }
                        ]
                    }]
                }
            }
        });

        apply_rollout_enrichment(&mut response, &enrichment);

        let items = response["result"]["thread"]["turns"][0]["items"]
            .as_array()
            .expect("thread items");
        assert_eq!(items[0]["createdAt"], json!("2026-07-18T12:00:00.000Z"));
        assert!(items[1].get("createdAt").is_none());
        assert_eq!(items[2]["createdAt"], json!("2026-07-18T12:00:10.000Z"));
        assert_eq!(items[3]["createdAt"], json!("2026-07-18T12:00:20.000Z"));
    }

    #[test]
    fn rollout_dynamic_tools_are_restored_in_sequence_without_duplicates() {
        let mut current_turn_id = None;
        let mut enrichment = RolloutThreadEnrichment::default();
        for line in [
            r#"{"type":"turn_context","payload":{"turn_id":"turn-1"}}"#,
            r#"{"timestamp":"2026-07-18T11:59:59.000Z","type":"response_item","payload":{"type":"message","role":"user"}}"#,
            r#"{"timestamp":"2026-07-18T12:00:00.000Z","type":"response_item","payload":{"type":"message","id":"message-1","role":"assistant"}}"#,
            r#"{"type":"response_item","payload":{"type":"custom_tool_call","id":"tool-1","status":"completed","call_id":"call-1","name":"exec","input":"const result = await tools.exec_command({ cmd: 'git status' });"}}"#,
            r#"{"type":"response_item","payload":{"type":"custom_tool_call_output","call_id":"call-1","output":[{"type":"input_text","text":"Script completed"}]}}"#,
            r#"{"type":"response_item","payload":{"type":"function_call","id":"wait-1","call_id":"call-2","name":"wait","arguments":"{\"cell_id\":\"cell-1\"}"}}"#,
            r#"{"type":"response_item","payload":{"type":"function_call_output","call_id":"call-2","output":[{"type":"input_text","text":"Finished"}]}}"#,
            r#"{"timestamp":"2026-07-18T12:00:10.000Z","type":"response_item","payload":{"type":"message","id":"message-2","role":"assistant"}}"#,
        ] {
            collect_rollout_enrichment_line(line, &mut current_turn_id, &mut enrichment);
        }
        let mut response = json!({
            "result": {
                "thread": {
                    "turns": [{
                        "id": "turn-1",
                        "items": [
                            { "type": "userMessage", "id": "item-0", "content": [] },
                            { "type": "agentMessage", "id": "item-1", "text": "Working" },
                            { "type": "dynamicToolCall", "id": "wait-1", "tool": "wait" },
                            { "type": "agentMessage", "id": "item-2", "text": "Done" }
                        ]
                    }]
                }
            }
        });

        apply_rollout_enrichment(&mut response, &enrichment);

        let items = response["result"]["thread"]["turns"][0]["items"]
            .as_array()
            .expect("thread items");
        assert_eq!(items.len(), 5);
        assert_eq!(items[0]["id"], json!("item-0"));
        assert_eq!(items[1]["id"], json!("item-1"));
        assert_eq!(items[2]["id"], json!("tool-1"));
        assert_eq!(items[2]["type"], json!("dynamicToolCall"));
        assert_eq!(items[2]["status"], json!("completed"));
        assert_eq!(
            items[2]["contentItems"][0]["text"],
            json!("Script completed")
        );
        assert_eq!(items[3]["id"], json!("wait-1"));
        assert_eq!(items[4]["id"], json!("item-2"));
    }

    #[test]
    fn thread_history_enrichment_reads_dynamic_tools_from_the_rollout_path() {
        let root = std::env::temp_dir().join(format!(
            "codex-monitor-thread-history-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("rollout-thread-1.jsonl");
        std::fs::write(
            &path,
            concat!(
                r#"{"type":"turn_context","payload":{"turn_id":"turn-1"}}"#,
                "\n",
                r#"{"type":"response_item","payload":{"type":"custom_tool_call","id":"tool-1","status":"completed","call_id":"call-1","name":"exec","input":"{\"cmd\":\"git status\"}"}}"#,
                "\n",
                r#"{"type":"response_item","payload":{"type":"custom_tool_call_output","call_id":"call-1","output":[{"type":"input_text","text":"clean"}]}}"#,
                "\n"
            ),
        )
        .unwrap();
        let mut response = json!({
            "result": {
                "thread": {
                    "path": path,
                    "turns": [{
                        "id": "turn-1",
                        "items": [
                            { "type": "userMessage", "id": "user-1", "content": [] },
                            { "type": "agentMessage", "id": "assistant-1", "text": "Done" }
                        ]
                    }]
                }
            }
        });
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();

        runtime.block_on(enrich_thread_history_from_rollout(&mut response));

        let items = response["result"]["thread"]["turns"][0]["items"]
            .as_array()
            .unwrap();
        assert_eq!(items.len(), 3);
        assert_eq!(items[1]["type"], json!("dynamicToolCall"));
        assert_eq!(items[1]["id"], json!("tool-1"));
        assert_eq!(items[1]["contentItems"][0]["text"], json!("clean"));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rollout_apply_patch_stats_are_computed_before_argument_truncation() {
        let input = [
            "await tools.apply_patch(`*** Begin Patch",
            "*** Update File: src/a.ts",
            "@@",
            "-old",
            "+new",
            "+added",
            "*** End Patch`);",
        ]
        .join("\n");

        assert_eq!(
            rollout_apply_patch_line_stats(Some(&input)),
            json!({ "additions": 2, "deletions": 1 })
        );
    }

    #[test]
    fn thread_start_token_efficiency_instructions_are_stable_and_opt_in() {
        let quality = build_start_thread_params("D:/workspace".to_string(), Some("quality"), None);
        let balanced =
            build_start_thread_params("D:/workspace".to_string(), Some("balanced"), None);
        let economy = build_start_thread_params("D:/workspace".to_string(), Some("economy"), None);

        assert!(quality.get("developerInstructions").is_none());
        assert_eq!(
            balanced["developerInstructions"],
            json!(BALANCED_TOKEN_EFFICIENCY_INSTRUCTIONS)
        );
        assert_eq!(
            economy["developerInstructions"],
            json!(ECONOMY_TOKEN_EFFICIENCY_INSTRUCTIONS)
        );
        assert_eq!(
            balanced,
            build_start_thread_params("D:/workspace".to_string(), Some("balanced"), None)
        );
    }

    #[test]
    fn thread_list_params_forward_archived_filter() {
        let params = build_thread_list_params(
            Some("cursor-1".to_string()),
            Some(50),
            Some("updated_at".to_string()),
            Some(true),
        );

        assert_eq!(params["cursor"], json!("cursor-1"));
        assert_eq!(params["limit"], json!(50));
        assert_eq!(params["sortKey"], json!("updated_at"));
        assert_eq!(params["archived"], json!(true));
        assert!(params["sourceKinds"]
            .as_array()
            .unwrap()
            .contains(&json!("cli")));
    }
}
