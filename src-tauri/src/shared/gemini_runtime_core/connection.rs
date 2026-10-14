use super::history::{now, HistoryStore};
use super::launch::{LaunchConfig, SettingsFile};
use crate::shared::process_core::{kill_child_process_tree, tokio_command};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, Instant};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{oneshot, Mutex};

pub(super) type Emit = Arc<dyn Fn(Value) + Send + Sync>;
type Response = oneshot::Sender<Result<Value, String>>;
pub(super) type PendingResponse = oneshot::Receiver<Result<Value, String>>;
pub(super) const CONTROL_TIMEOUT: Duration = Duration::from_secs(90);
pub(super) const PROMPT_TIMEOUT: Duration = Duration::from_secs(30 * 60);
const MAX_FRAME_BYTES: usize = 16 * 1024 * 1024;

struct PendingApproval {
    native_id: Value,
    turn_id: String,
    options: Vec<Value>,
}

struct Turn {
    id: String,
    sequence: u64,
    message: Option<String>,
    thought: Option<String>,
    tools: HashMap<String, Value>,
    completed: HashSet<String>,
    cancelled: bool,
    last_saved: Instant,
}

#[derive(Default)]
struct Context {
    native_id: String,
    thread_id: String,
    active: Option<Turn>,
    approvals: HashMap<String, PendingApproval>,
}

/// Request IDs from each direction are independent. Incoming agent requests
/// must be checked before response IDs, even when both peers use numeric IDs.
pub(super) struct AcpConnection {
    stdin: Mutex<ChildStdin>,
    child: Mutex<Child>,
    pid: Option<u32>,
    pending: StdMutex<HashMap<u64, Response>>,
    next_id: AtomicU64,
    closed: AtomicBool,
    terminated: AtomicBool,
    stderr_auth_failure: AtomicBool,
    context: Mutex<Context>,
    history: Arc<HistoryStore>,
    emit: Emit,
    _settings_file: Option<SettingsFile>,
}

impl AcpConnection {
    pub async fn spawn(
        program: &Path,
        cwd: &str,
        launch: &LaunchConfig,
        history: Arc<HistoryStore>,
        emit: Emit,
    ) -> Result<Arc<Self>, String> {
        let mut args = vec![
            "--acp".to_string(),
            "--approval-mode".to_string(),
            "default".to_string(),
        ];
        if let Some(model) = launch.model() {
            args.extend(["--model".into(), model.into()]);
        }
        #[cfg(windows)]
        let mut command = if matches!(
            program
                .extension()
                .and_then(|value| value.to_str())
                .map(str::to_ascii_lowercase)
                .as_deref(),
            Some("cmd" | "bat")
        ) {
            let command_line = crate::shared::process_core::build_cmd_c_command(program, &args)?;
            let mut command = tokio_command("cmd.exe");
            command.args(["/D", "/S", "/C"]).raw_arg(command_line);
            command
        } else {
            let mut command = tokio_command(program);
            command.args(&args);
            command
        };
        #[cfg(not(windows))]
        let mut command = {
            let mut command = tokio_command(program);
            command.args(&args);
            command
        };
        if let Some(path_env) =
            crate::shared::cli_discovery_core::build_cli_path_env(Some(program), None)
        {
            command.env("PATH", path_env);
        }
        command.current_dir(cwd);
        let settings_file = launch.apply(&mut command)?;
        Self::spawn_command_with_settings(command, history, emit, settings_file).await
    }

    pub(super) async fn spawn_command(
        command: Command,
        history: Arc<HistoryStore>,
        emit: Emit,
    ) -> Result<Arc<Self>, String> {
        Self::spawn_command_with_settings(command, history, emit, None).await
    }

    async fn spawn_command_with_settings(
        mut command: Command,
        history: Arc<HistoryStore>,
        emit: Emit,
        settings_file: Option<SettingsFile>,
    ) -> Result<Arc<Self>, String> {
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.as_std_mut().process_group(0);
        }
        let mut child = command
            .spawn()
            .map_err(|error| format!("Cannot launch Gemini CLI: {error}"))?;
        let stdin = child
            .stdin
            .take()
            .ok_or("Gemini CLI stdin is unavailable")?;
        let stdout = child
            .stdout
            .take()
            .ok_or("Gemini CLI stdout is unavailable")?;
        let stderr = child
            .stderr
            .take()
            .ok_or("Gemini CLI stderr is unavailable")?;
        let connection = Arc::new(Self {
            pid: child.id(),
            stdin: Mutex::new(stdin),
            child: Mutex::new(child),
            pending: StdMutex::new(HashMap::new()),
            next_id: AtomicU64::new(1),
            closed: AtomicBool::new(false),
            terminated: AtomicBool::new(false),
            stderr_auth_failure: AtomicBool::new(false),
            context: Mutex::new(Context::default()),
            history,
            emit,
            _settings_file: settings_file,
        });
        let weak = Arc::downgrade(&connection);
        tokio::spawn(async move {
            let mut reader = BufReader::new(stdout);
            loop {
                let mut frame = Vec::new();
                let read = (&mut reader)
                    .take(MAX_FRAME_BYTES as u64 + 1)
                    .read_until(b'\n', &mut frame)
                    .await;
                let Some(connection) = weak.upgrade() else {
                    break;
                };
                match read {
                    Ok(0) => {
                        let reason = if connection.stderr_auth_failure.load(Ordering::Acquire) {
                            auth_required()
                        } else {
                            "Gemini CLI ACP process exited. Check Gemini CLI configuration and authentication, then resume the session.".to_string()
                        };
                        connection.close(&reason).await;
                        break;
                    }
                    Ok(_) if frame.len() > MAX_FRAME_BYTES => {
                        connection
                            .close("Gemini CLI sent an oversized ACP message")
                            .await;
                        break;
                    }
                    Ok(_) => {
                        if frame.iter().all(u8::is_ascii_whitespace) {
                            continue;
                        }
                        match serde_json::from_slice::<Value>(&frame) {
                            Ok(message) => {
                                if let Err(error) = connection.handle_message(message).await {
                                    connection.close(&error).await;
                                    break;
                                }
                            }
                            Err(_) => {
                                connection
                                    .close("Gemini CLI emitted invalid ACP JSON")
                                    .await;
                                break;
                            }
                        }
                    }
                    Err(error) => {
                        connection
                            .close(&format!("Gemini CLI ACP output failed: {error}"))
                            .await;
                        break;
                    }
                }
            }
        });
        let weak = Arc::downgrade(&connection);
        tokio::spawn(async move {
            let mut reader = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                let Some(connection) = weak.upgrade() else {
                    break;
                };
                let line = line.to_ascii_lowercase();
                if line.contains("authentication")
                    || line.contains("auth method")
                    || line.contains("api key")
                    || line.contains("re-authenticate")
                {
                    connection
                        .stderr_auth_failure
                        .store(true, Ordering::Release);
                }
                // CLI diagnostic output can include credentials; never persist
                // or fan it out as conversation content.
            }
        });
        Ok(connection)
    }

    pub fn is_closed(&self) -> bool {
        self.closed.load(Ordering::Acquire)
    }

    pub async fn bind(&self, native_id: &str, thread_id: &str) {
        let mut context = self.context.lock().await;
        context.native_id = native_id.to_string();
        context.thread_id = thread_id.to_string();
    }

    pub async fn call(
        self: &Arc<Self>,
        method: &str,
        params: Value,
        deadline: Duration,
    ) -> Result<Value, String> {
        let receiver = self.start_call(method, params).await?;
        self.await_response(receiver, method, deadline).await
    }

    async fn start_call(
        self: &Arc<Self>,
        method: &str,
        params: Value,
    ) -> Result<PendingResponse, String> {
        if self.is_closed() {
            return Err("Gemini CLI ACP process is no longer running".to_string());
        }
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (sender, receiver) = oneshot::channel();
        {
            let mut pending = self
                .pending
                .lock()
                .map_err(|_| "Gemini request lock is unavailable")?;
            if self.is_closed() {
                return Err("Gemini CLI ACP process is no longer running".to_string());
            }
            pending.insert(id, sender);
        }
        if let Err(error) = self
            .write(json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}))
            .await
        {
            self.close(&error).await;
            return Err(error);
        }
        Ok(receiver)
    }

    pub async fn start_prompt(
        self: &Arc<Self>,
        turn_id: &str,
        prompt: Vec<Value>,
    ) -> Result<Option<PendingResponse>, String> {
        // Serializing prompt writes and cancellation makes an immediate Stop
        // reliable even when the user acts before session/prompt is sent.
        let context = self.context.lock().await;
        let turn = context
            .active
            .as_ref()
            .filter(|turn| turn.id == turn_id)
            .ok_or("Gemini prompt targets a different turn")?;
        if turn.cancelled {
            return Ok(None);
        }
        let response = self
            .start_call(
                "session/prompt",
                json!({"sessionId":context.native_id,"prompt":prompt}),
            )
            .await?;
        Ok(Some(response))
    }

    pub async fn await_response(
        self: &Arc<Self>,
        receiver: PendingResponse,
        method: &str,
        deadline: Duration,
    ) -> Result<Value, String> {
        match tokio::time::timeout(deadline, receiver).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err("Gemini CLI ACP response channel closed".to_string()),
            Err(_) => {
                let error = format!("Gemini CLI ACP request timed out: {method}");
                self.close(&error).await;
                Err(error)
            }
        }
    }

    async fn write(&self, message: Value) -> Result<(), String> {
        if self.is_closed() {
            return Err("Gemini CLI ACP process is no longer running".to_string());
        }
        let mut bytes = serde_json::to_vec(&message).map_err(|error| error.to_string())?;
        if bytes.len() > MAX_FRAME_BYTES {
            return Err("Gemini prompt exceeds ACP message size limit".to_string());
        }
        bytes.push(b'\n');
        tokio::time::timeout(Duration::from_secs(15), async {
            let mut stdin = self.stdin.lock().await;
            stdin
                .write_all(&bytes)
                .await
                .map_err(|error| format!("Gemini CLI ACP input failed: {error}"))?;
            stdin
                .flush()
                .await
                .map_err(|error| format!("Gemini CLI ACP input failed: {error}"))
        })
        .await
        .map_err(|_| "Gemini CLI ACP input timed out".to_string())?
    }

    pub async fn close(&self, reason: &str) {
        if self.closed.swap(true, Ordering::AcqRel) {
            return;
        }
        if let Ok(mut pending) = self.pending.lock() {
            for (_, sender) in pending.drain() {
                let _ = sender.send(Err(reason.to_string()));
            }
        }
        let mut child = self.child.lock().await;
        #[cfg(unix)]
        if let Some(pid) = self.pid {
            unsafe {
                libc::kill(-(pid as i32), libc::SIGKILL);
            }
        }
        kill_child_process_tree(&mut child).await;
        let _ = tokio::time::timeout(Duration::from_secs(5), child.wait()).await;
        self.terminated.store(true, Ordering::Release);
    }

    pub async fn shutdown(&self, reason: &str) {
        let mut context = self.context.lock().await;
        let turn_id = context.active.as_mut().map(|turn| {
            turn.cancelled = true;
            turn.id.clone()
        });
        // Hold the turn guard until close sets the transport flag, preventing
        // a new prompt from slipping between the shutdown check and process
        // termination. close never waits for this context lock.
        self.close(reason).await;
        drop(context);
        if let Some(turn_id) = turn_id {
            self.finish_turn(&turn_id, Err(reason.to_string())).await;
        }
    }

    async fn handle_message(self: &Arc<Self>, message: Value) -> Result<(), String> {
        if message.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
            return Err("Gemini CLI sent a message with an unsupported ACP version".to_string());
        }
        if let Some(method) = message.get("method").and_then(Value::as_str) {
            let params = message.get("params").cloned().unwrap_or(Value::Null);
            if let Some(id) = message.get("id") {
                if method == "session/request_permission" {
                    return self.permission(id.clone(), params).await;
                }
                return self.write(json!({"jsonrpc":"2.0","id":id,"error":{"code":-32601,"message":"TF does not advertise this ACP client capability"}})).await;
            }
            if method == "session/update" {
                return self.update(params).await;
            }
            return Ok(());
        }
        let Some(id) = message.get("id").and_then(Value::as_u64) else {
            return Err("Gemini CLI sent an invalid ACP response ID".to_string());
        };
        let sender = self
            .pending
            .lock()
            .map_err(|_| "Gemini request lock is unavailable")?
            .remove(&id);
        if let Some(sender) = sender {
            let result = if let Some(error) = message.get("error") {
                let code = error.get("code").and_then(Value::as_i64).unwrap_or(0);
                let message = error
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("Gemini ACP request failed");
                if code == -32000
                    || message
                        .to_ascii_lowercase()
                        .contains("authentication required")
                {
                    Err(format!("{} {message}", auth_required()))
                } else {
                    Err(format!("Gemini ACP error ({code}): {message}"))
                }
            } else if let Some(result) = message.get("result") {
                Ok(result.clone())
            } else {
                Err("Gemini CLI sent an invalid ACP response".to_string())
            };
            let _ = sender.send(result);
        }
        Ok(())
    }

    fn event(&self, method: &str, params: Value) {
        (self.emit)(json!({"method":method,"params":params}));
    }

    pub async fn begin_turn(&self, text: &str, user_content: Vec<Value>) -> Result<Value, String> {
        let mut context = self.context.lock().await;
        if self.is_closed() {
            return Err("Gemini CLI ACP process is no longer running".to_string());
        }
        if context.active.is_some() {
            return Err(
                "Gemini session is already generating; stop it before sending another prompt"
                    .to_string(),
            );
        }
        let id = format!("gemini:turn:{}", uuid::Uuid::new_v4());
        let user = json!({"id":format!("{id}:user"),"type":"userMessage","content":user_content,"createdAt":now()});
        let turn = json!({"id":id,"status":"inProgress","items":[user],"startedAt":now()});
        self.history.update(&context.thread_id, true, |stored| {
            stored.thread["turns"]
                .as_array_mut()
                .ok_or("Invalid Gemini transcript")?
                .push(turn.clone());
            stored.thread["status"] = json!({"type":"active","activeFlags":[]});
            stored.thread["updatedAt"] = json!(now());
            if stored.thread["preview"].as_str().unwrap_or("").is_empty() {
                stored.thread["preview"] = json!(text.chars().take(180).collect::<String>());
            }
            Ok(())
        })?;
        context.active = Some(Turn {
            id: id.clone(),
            sequence: 0,
            message: None,
            thought: None,
            tools: HashMap::new(),
            completed: HashSet::new(),
            cancelled: false,
            last_saved: Instant::now(),
        });
        let thread_id = context.thread_id.clone();
        drop(context);
        self.event("turn/started", json!({"threadId":thread_id,"turn":turn}));
        self.event(
            "item/started",
            json!({"threadId":thread_id,"turnId":id,"item":user}),
        );
        self.event(
            "item/completed",
            json!({"threadId":thread_id,"turnId":id,"item":user}),
        );
        Ok(json!({"id":id,"status":"inProgress"}))
    }

    pub async fn active_turn(&self) -> Option<String> {
        self.context
            .lock()
            .await
            .active
            .as_ref()
            .map(|turn| turn.id.clone())
    }

    async fn update(&self, params: Value) -> Result<(), String> {
        let mut context = self.context.lock().await;
        // session/load streams all historical messages before returning. Those
        // messages must not become live turn items or duplicate saved history.
        if params.get("sessionId").and_then(Value::as_str) != Some(context.native_id.as_str()) {
            return Ok(());
        }
        let thread_id = context.thread_id.clone();
        let Some(turn) = context.active.as_mut() else {
            return Ok(());
        };
        let update = params
            .get("update")
            .ok_or("Gemini sent an invalid session update")?;
        let mut events = Vec::new();
        let mut persist = turn.last_saved.elapsed() >= Duration::from_millis(750);
        match update.get("sessionUpdate").and_then(Value::as_str) {
            Some(kind @ ("agent_message_chunk" | "agent_thought_chunk")) => {
                let Some(delta) = update.pointer("/content/text").and_then(Value::as_str) else {
                    return Ok(());
                };
                let reasoning = kind == "agent_thought_chunk";
                let existing = if reasoning {
                    turn.thought.clone()
                } else {
                    turn.message.clone()
                };
                let id = if let Some(id) = existing {
                    id
                } else {
                    turn.sequence += 1;
                    let id = format!(
                        "{}:{}:{}",
                        turn.id,
                        if reasoning { "thought" } else { "message" },
                        turn.sequence
                    );
                    let item = if reasoning {
                        json!({"id":id,"type":"reasoning","summary":"","content":"","createdAt":now()})
                    } else {
                        json!({"id":id,"type":"agentMessage","text":"","phase":"commentary","createdAt":now()})
                    };
                    self.history.update(&thread_id, false, |stored| {
                        turn_items(stored, &turn.id)?.push(item.clone());
                        Ok(())
                    })?;
                    events.push((
                        "item/started",
                        json!({"threadId":thread_id,"turnId":turn.id,"item":item}),
                    ));
                    if reasoning {
                        turn.thought = Some(id.clone());
                    } else {
                        turn.message = Some(id.clone());
                    }
                    id
                };
                self.history.update(&thread_id, persist, |stored| {
                    let item = turn_items(stored, &turn.id)?
                        .iter_mut()
                        .find(|item| item["id"].as_str() == Some(id.as_str()))
                        .ok_or("Gemini streamed to an unknown item")?;
                    let key = if reasoning { "content" } else { "text" };
                    let mut text = item[key].as_str().unwrap_or("").to_string();
                    text.push_str(delta);
                    item[key] = json!(text);
                    stored.thread["updatedAt"] = json!(now());
                    Ok(())
                })?;
                events.push((
                    if reasoning {
                        "item/reasoning/textDelta"
                    } else {
                        "item/agentMessage/delta"
                    },
                    json!({"threadId":thread_id,"turnId":turn.id,"itemId":id,"delta":delta}),
                ));
            }
            Some("tool_call" | "tool_call_update") => {
                let Some(id) = update.get("toolCallId").and_then(Value::as_str) else {
                    return Err("Gemini tool update is missing its ID".to_string());
                };
                for previous in [turn.message.take(), turn.thought.take()]
                    .into_iter()
                    .flatten()
                {
                    if turn.completed.insert(previous.clone()) {
                        let item = self.history.update(&thread_id, false, |stored| {
                            Ok(turn_items(stored, &turn.id)?
                                .iter()
                                .find(|item| item["id"].as_str() == Some(&previous))
                                .cloned())
                        })?;
                        if let Some(item) = item {
                            events.push((
                                "item/completed",
                                json!({"threadId":thread_id,"turnId":turn.id,"item":item}),
                            ));
                        }
                    }
                }
                let raw = turn
                    .tools
                    .entry(id.to_string())
                    .or_insert_with(|| json!({}));
                if let Some(object) = update.as_object() {
                    for (key, value) in object {
                        if !value.is_null() {
                            raw[key] = value.clone();
                        }
                    }
                }
                let item = tool_item(&turn.id, raw);
                let completed = matches!(
                    raw.get("status").and_then(Value::as_str),
                    Some("completed" | "failed")
                );
                self.history.update(&thread_id, true, |stored| {
                    let items = turn_items(stored, &turn.id)?;
                    if let Some(existing) = items
                        .iter_mut()
                        .find(|existing| existing["id"] == item["id"])
                    {
                        *existing = item.clone();
                    } else {
                        items.push(item.clone());
                    }
                    Ok(())
                })?;
                events.push((
                    if completed {
                        "item/completed"
                    } else {
                        "item/started"
                    },
                    json!({"threadId":thread_id,"turnId":turn.id,"item":item}),
                ));
                if completed {
                    turn.completed
                        .insert(item["id"].as_str().unwrap_or("").to_string());
                }
                persist = true;
            }
            Some("plan") => {
                let entries = update
                    .get("entries")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                let plan: Vec<Value> = entries
                    .iter()
                    .map(|entry| json!({"step":entry["content"],"status":entry["status"]}))
                    .collect();
                events.push((
                    "turn/plan/updated",
                    json!({"threadId":thread_id,"turnId":turn.id,"plan":plan}),
                ));
            }
            _ => {}
        }
        if persist {
            turn.last_saved = Instant::now();
        }
        drop(context);
        for (method, params) in events {
            self.event(method, params);
        }
        Ok(())
    }

    async fn permission(&self, native_request_id: Value, params: Value) -> Result<(), String> {
        let mut context = self.context.lock().await;
        if params.get("sessionId").and_then(Value::as_str) != Some(context.native_id.as_str())
            || context
                .active
                .as_ref()
                .map(|turn| turn.cancelled)
                .unwrap_or(true)
        {
            drop(context);
            return self.write(json!({"jsonrpc":"2.0","id":native_request_id,"result":{"outcome":{"outcome":"cancelled"}}})).await;
        }
        let thread_id = context.thread_id.clone();
        let turn_id = context
            .active
            .as_ref()
            .expect("active turn checked")
            .id
            .clone();
        let request_id = format!("{thread_id}:approval:{}", uuid::Uuid::new_v4());
        let options = params
            .get("options")
            .and_then(Value::as_array)
            .cloned()
            .ok_or("Gemini approval options are missing")?;
        let tool = params.get("toolCall").cloned().unwrap_or_else(|| json!({}));
        let tool_id = tool
            .get("toolCallId")
            .and_then(Value::as_str)
            .ok_or("Gemini approval tool ID is missing")?;
        let item = tool_item(&turn_id, &tool);
        context
            .active
            .as_mut()
            .expect("active turn checked")
            .tools
            .insert(tool_id.to_string(), tool.clone());
        self.history.update(&thread_id, true, |stored| {
            let items = turn_items(stored, &turn_id)?;
            if let Some(existing) = items
                .iter_mut()
                .find(|existing| existing["id"] == item["id"])
            {
                *existing = item.clone();
            } else {
                items.push(item.clone());
            }
            Ok(())
        })?;
        context.approvals.insert(
            request_id.clone(),
            PendingApproval {
                native_id: native_request_id,
                turn_id: turn_id.clone(),
                options: options.clone(),
            },
        );
        drop(context);
        self.event(
            "item/started",
            json!({"threadId":thread_id,"turnId":turn_id,"item":item}),
        );
        let method = if matches!(
            tool.get("kind").and_then(Value::as_str),
            Some("edit" | "delete" | "move")
        ) {
            "item/fileChange/requestApproval"
        } else {
            "item/commandExecution/requestApproval"
        };
        let item_id = format!(
            "{turn_id}:tool:{}",
            tool["toolCallId"].as_str().unwrap_or("permission")
        );
        (self.emit)(json!({"id":request_id,"method":method,"params":{
            "threadId":thread_id,"turnId":turn_id,"itemId":item_id,"engine":"gemini",
            "reason":tool["title"],"command":tool["title"],"geminiOptions":options,"geminiToolCall":tool,
        }}));
        Ok(())
    }

    pub async fn has_approval(&self, request_id: &str) -> bool {
        self.context.lock().await.approvals.contains_key(request_id)
    }

    pub async fn respond(&self, request_id: &str, result: &Value) -> Result<Value, String> {
        let mut context = self.context.lock().await;
        let approval = context
            .approvals
            .get(request_id)
            .ok_or("Gemini approval is no longer pending")?;
        let outcome = approval_outcome(&approval.options, result)?;
        let approval = context
            .approvals
            .remove(request_id)
            .expect("approval was checked");
        let thread_id = context.thread_id.clone();
        drop(context);
        let sent = self
            .write(json!({"jsonrpc":"2.0","id":approval.native_id,"result":{"outcome":outcome}}))
            .await;
        self.event(
            "serverRequest/resolved",
            json!({"threadId":thread_id,"turnId":approval.turn_id,"requestId":request_id}),
        );
        if let Err(error) = sent {
            self.close(&error).await;
            return Err(error);
        }
        Ok(json!({}))
    }

    pub async fn cancel(self: &Arc<Self>, expected_turn: Option<&str>) -> Result<Value, String> {
        let mut context = self.context.lock().await;
        let thread_id = context.thread_id.clone();
        let native_id = context.native_id.clone();
        let Some(turn) = context.active.as_mut() else {
            return Ok(json!({}));
        };
        if expected_turn.is_some_and(|expected| expected != turn.id) {
            return Err("Gemini interrupt targets a different turn".to_string());
        }
        turn.cancelled = true;
        let turn_id = turn.id.clone();
        let approvals: Vec<_> = context.approvals.drain().collect();
        drop(context);
        let mut input_error = None;
        for (request_id, approval) in approvals {
            self.event(
                "serverRequest/resolved",
                json!({"threadId":thread_id,"turnId":turn_id,"requestId":request_id}),
            );
            if input_error.is_none() {
                input_error = self.write(json!({"jsonrpc":"2.0","id":approval.native_id,"result":{"outcome":{"outcome":"cancelled"}}})).await.err();
            }
        }
        if let Some(error) = input_error {
            self.close(&error).await;
            return Err(error);
        }
        if let Err(error) = self
            .write(
                json!({"jsonrpc":"2.0","method":"session/cancel","params":{"sessionId":native_id}}),
            )
            .await
        {
            self.close(&error).await;
            return Err(error);
        }
        let weak = Arc::downgrade(self);
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs(10)).await;
            if let Some(connection) = weak.upgrade() {
                if connection.active_turn().await.as_deref() == Some(turn_id.as_str()) {
                    connection
                        .close("Gemini CLI did not acknowledge cancellation")
                        .await;
                }
            }
        });
        Ok(json!({}))
    }

    pub async fn finish_turn(&self, turn_id: &str, response: Result<Value, String>) {
        let mut context = self.context.lock().await;
        if context.active.as_ref().map(|turn| turn.id.as_str()) != Some(turn_id) {
            return;
        }
        let turn = context.active.take().expect("active turn was checked");
        let thread_id = context.thread_id.clone();
        let cancelled = turn.cancelled
            || response
                .as_ref()
                .ok()
                .and_then(|value| value["stopReason"].as_str())
                == Some("cancelled");
        let status = if cancelled {
            "interrupted"
        } else if response.is_err() {
            "failed"
        } else {
            "completed"
        };
        let error = response.as_ref().err().cloned().filter(|_| !cancelled);
        let finalized = self.history.update(&thread_id, true, |stored| {
            let turns = stored.thread["turns"]
                .as_array_mut()
                .ok_or("Invalid Gemini transcript")?;
            let stored_turn = turns
                .iter_mut()
                .find(|stored_turn| stored_turn["id"].as_str() == Some(turn_id))
                .ok_or("Gemini turn is missing from history")?;
            stored_turn["status"] = json!(status);
            stored_turn["completedAt"] = json!(now());
            if let Some(error) = &error {
                stored_turn["error"] = json!({"message":error});
            }
            if let Some(message) = &turn.message {
                if let Some(item) = stored_turn["items"].as_array_mut().and_then(|items| {
                    items
                        .iter_mut()
                        .find(|item| item["id"].as_str() == Some(message))
                }) {
                    item["phase"] = json!("final_answer");
                }
            }
            if let Some(items) = stored_turn["items"].as_array_mut() {
                for item in items {
                    if item["status"].as_str() == Some("inProgress") {
                        item["status"] = json!(if cancelled { "declined" } else { "failed" });
                    }
                }
            }
            let finalized = stored_turn.clone();
            stored.thread["updatedAt"] = json!(now());
            stored.thread["status"] = json!({"type":"idle"});
            Ok(finalized)
        });
        let approvals: Vec<_> = context.approvals.drain().collect();
        drop(context);
        for (request_id, approval) in approvals {
            let _ = self.write(json!({"jsonrpc":"2.0","id":approval.native_id,"result":{"outcome":{"outcome":"cancelled"}}})).await;
            self.event(
                "serverRequest/resolved",
                json!({"threadId":thread_id,"turnId":turn_id,"requestId":request_id}),
            );
        }
        match finalized {
            Ok(finalized) => {
                if let Some(items) = finalized["items"].as_array() {
                    for item in items {
                        if item["type"] != "userMessage"
                            && !turn.completed.contains(item["id"].as_str().unwrap_or(""))
                        {
                            self.event(
                                "item/completed",
                                json!({"threadId":thread_id,"turnId":turn_id,"item":item}),
                            );
                        }
                    }
                }
                if let Some(error) = error {
                    self.event("error", json!({"threadId":thread_id,"turnId":turn_id,"error":{"message":error},"willRetry":false}));
                }
                self.event(
                    "turn/completed",
                    json!({"threadId":thread_id,"turn":finalized}),
                );
            }
            Err(error) => {
                self.event("error", json!({"threadId":thread_id,"turnId":turn_id,"error":{"message":error},"willRetry":false}));
                self.event(
                    "turn/completed",
                    json!({"threadId":thread_id,"turn":{"id":turn_id,"status":"failed"}}),
                );
            }
        }
    }
}

impl Drop for AcpConnection {
    fn drop(&mut self) {
        if self.terminated.load(Ordering::Acquire) {
            return;
        }
        let Some(pid) = self.pid else { return };
        // Async cleanup cannot run after the Tokio runtime is gone. Retain a
        // final process-tree fallback so a Windows npm cmd wrapper cannot leave
        // its node child behind during application shutdown.
        #[cfg(windows)]
        {
            let _ = crate::shared::process_core::std_command("taskkill")
                .args(["/PID", &pid.to_string(), "/T", "/F"])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
        }
        #[cfg(unix)]
        unsafe {
            libc::kill(-(pid as i32), libc::SIGKILL);
        }
    }
}

fn turn_items<'a>(
    stored: &'a mut super::history::StoredThread,
    turn_id: &str,
) -> Result<&'a mut Vec<Value>, String> {
    stored
        .thread
        .get_mut("turns")
        .and_then(Value::as_array_mut)
        .and_then(|turns| {
            turns
                .iter_mut()
                .find(|turn| turn["id"].as_str() == Some(turn_id))
        })
        .and_then(|turn| turn.get_mut("items"))
        .and_then(Value::as_array_mut)
        .ok_or_else(|| "Gemini turn is missing from history".to_string())
}

fn tool_item(turn_id: &str, raw: &Value) -> Value {
    let id = format!(
        "{turn_id}:tool:{}",
        raw["toolCallId"].as_str().unwrap_or("unknown")
    );
    let status = match raw["status"].as_str().unwrap_or("pending") {
        "completed" => "completed",
        "failed" => "failed",
        _ => "inProgress",
    };
    let contents = raw["content"].as_array().cloned().unwrap_or_default();
    let output = contents
        .iter()
        .filter_map(|content| content.pointer("/content/text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("\n");
    match raw["kind"].as_str().unwrap_or("other") {
        "execute" => {
            json!({"id":id,"type":"commandExecution","command":raw["title"],"status":status,"aggregatedOutput":output})
        }
        "edit" | "delete" | "move" => {
            let changes: Vec<Value> = contents
                .iter()
                .filter(|content| content["type"] == "diff")
                .map(|content| {
                    let old = content["oldText"].as_str().unwrap_or("");
                    let new = content["newText"].as_str().unwrap_or("");
                    let diff = format!(
                        "--- {}\n+++ {}\n@@ -1,{} +1,{} @@\n{}{}",
                        content["path"].as_str().unwrap_or("file"),
                        content["path"].as_str().unwrap_or("file"),
                        old.lines().count(),
                        new.lines().count(),
                        old.lines()
                            .map(|line| format!("-{line}\n"))
                            .collect::<String>(),
                        new.lines()
                            .map(|line| format!("+{line}\n"))
                            .collect::<String>()
                    );
                    let kind = match content.pointer("/_meta/kind").and_then(Value::as_str) {
                        Some("add") => "add",
                        Some("delete") => "delete",
                        _ if raw["kind"] == "delete" => "delete",
                        _ if content["oldText"].is_null() => "add",
                        _ => "update",
                    };
                    json!({"path":content["path"],"kind":kind,"diff":diff})
                })
                .collect();
            json!({"id":id,"type":"fileChange","status":status,"changes":changes})
        }
        _ => {
            json!({"id":id,"type":"dynamicToolCall","namespace":"gemini","tool":raw["title"].as_str().unwrap_or("tool"),"arguments":raw.get("rawInput").cloned().unwrap_or(Value::Null),"status":status,"contentItems":[{"type":"inputText","text":output}]})
        }
    }
}

fn approval_outcome(options: &[Value], result: &Value) -> Result<Value, String> {
    let decision = result
        .get("decision")
        .and_then(Value::as_str)
        .or_else(|| result.as_str())
        .unwrap_or("");
    if matches!(decision, "cancel" | "cancelled") {
        return Ok(json!({"outcome":"cancelled"}));
    }
    let kind = match decision {
        "accept" | "approved" => "allow_once",
        "acceptForSession" | "approved_for_session" => "allow_always",
        "decline" | "denied" => "reject_once",
        _ => return Err("Unsupported Gemini approval decision".to_string()),
    };
    if let Some(option) = options.iter().find(|option| {
        option["kind"].as_str() == Some(kind)
            && (kind != "allow_always"
                || option["optionId"]
                    .as_str()
                    .is_some_and(|id| !id.contains("save")))
    }) {
        return Ok(json!({"outcome":"selected","optionId":option["optionId"]}));
    }
    if kind == "reject_once" {
        return Ok(json!({"outcome":"cancelled"}));
    }
    Err("Gemini CLI does not offer the requested approval option".to_string())
}

fn auth_required() -> String {
    "Gemini authentication required. Select Gemini (native API) in TF provider settings, then save and enable its key, or sign in using Gemini CLI and retry.".to_string()
}
