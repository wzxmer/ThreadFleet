use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde_json::{json, Map, Value};
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

const MAX_ROLLOUT_TOOL_ARGUMENT_CHARS: usize = 200_000;
const MAX_ROLLOUT_TOOL_OUTPUT_CHARS: usize = 20_000;

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
                    let item_type = match payload.get("role").and_then(Value::as_str) {
                        Some("user") => Some("userMessage"),
                        Some("assistant") => Some("agentMessage"),
                        _ => None,
                    };
                    if let Some(item_type) = item_type {
                        turn.sequence.push(RolloutSequenceItem::Anchor {
                            id: payload
                                .get("id")
                                .and_then(Value::as_str)
                                .map(str::to_string),
                            item_type,
                        });
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
    let active_profile = settings
        .active_codex_key_profile_id
        .as_deref()
        .and_then(|active_id| {
            settings
                .codex_key_profiles
                .iter()
                .find(|profile| profile.id == active_id)
        });
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
) -> Option<(String, String)> {
    let active_profile = settings
        .active_codex_key_profile_id
        .as_deref()
        .and_then(|active_id| {
            settings
                .codex_key_profiles
                .iter()
                .find(|profile| profile.id == active_id)
        });
    if let Some(profile) = active_profile {
        if profile.provider_kind.eq_ignore_ascii_case("openai") {
            return None;
        }
        return provider_profiles_core::resolve_profile_base_url(profile)
            .map(|base_url| (base_url, profile.key.clone()));
    }

    let provider_name = config_toml_core::read_top_level_string(document, "model_provider");
    let base_url = provider_name.as_deref().and_then(|provider| {
        config_toml_core::read_nested_string(document, &["model_providers", provider, "base_url"])
    })?;
    if codex_config::is_official_openai_url(&base_url) {
        return None;
    }
    default_api_key.map(|api_key| (base_url, api_key))
}

pub(crate) async fn workspace_third_party_key_usage_core(
    workspaces: &Mutex<HashMap<String, WorkspaceEntry>>,
    settings: &AppSettings,
    workspace_id: String,
    timezone: Option<String>,
) -> Result<Value, String> {
    let codex_home = resolve_codex_home_for_workspace_core(workspaces, &workspace_id).await?;
    let active_profile_selected =
        settings
            .active_codex_key_profile_id
            .as_deref()
            .is_some_and(|active_id| {
                settings
                    .codex_key_profiles
                    .iter()
                    .any(|profile| profile.id == active_id)
            });
    let (document, default_api_key) = if active_profile_selected {
        (toml_edit::Document::new(), None)
    } else {
        let (_, document) = config_toml_core::load_global_config_document(&codex_home)?;
        (document, read_auth_api_key(&codex_home))
    };
    let credentials = resolve_third_party_usage_credentials(settings, &document, default_api_key);

    let Some((base_url, api_key)) = credentials else {
        return Ok(Value::Null);
    };
    let usage_url = provider_profiles_core::build_provider_usage_url(&base_url)?.to_string();
    provider_profiles_core::third_party_key_usage_core(usage_url, api_key, timezone).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::CodexKeyProfile;
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
                "sk-default".to_string()
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
            key_env_var: "OPENAI_API_KEY".to_string(),
            key: "sk-profile".to_string(),
            base_url_env_var: "OPENAI_BASE_URL".to_string(),
            base_url: Some("https://api.deepseek.com/v1".to_string()),
            model: None,
            context_window: None,
            max_output_tokens: None,
            use_gateway: false,
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
                "sk-profile".to_string()
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
