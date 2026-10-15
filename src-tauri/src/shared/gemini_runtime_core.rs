//! Gemini ACP adapter. The app and daemon call the same runtime; Gemini owns
//! its native history and tool execution. Selected Gemini providers are passed
//! to child processes; native authentication remains available independently.
mod connection;
mod history;
mod launch;
pub(crate) use launch::LaunchConfig;

use crate::backend::events::{AppServerEvent, EventSink};
use crate::shared::cli_discovery_core::resolve_cli_path;
use base64::{
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
    Engine as _,
};
use connection::{AcpConnection, Emit, CONTROL_TIMEOUT, PROMPT_TIMEOUT};
use history::{make_thread, now, HistoryStore, StoredThread};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, Instant};
use tokio::sync::Mutex;

struct Session {
    workspace_id: String,
    thread_id: String,
    native_id: String,
    connection: Arc<AcpConnection>,
    prompt_capabilities: Value,
    runtime_fingerprint: String,
    control: Mutex<()>,
}

type SessionSlot = Arc<Mutex<Option<Arc<Session>>>>;

struct Inner {
    history: Arc<HistoryStore>,
    sessions: StdMutex<HashMap<String, SessionSlot>>,
    model_cache: Mutex<HashMap<String, (Instant, Value)>>,
}

impl Drop for Inner {
    fn drop(&mut self) {
        let Ok(handle) = tokio::runtime::Handle::try_current() else {
            return;
        };
        if let Ok(sessions) = self.sessions.lock() {
            for slot in sessions.values() {
                let slot = slot.clone();
                handle.spawn(async move {
                    if let Some(session) = slot.lock().await.take() {
                        session
                            .connection
                            .shutdown("TF Gemini runtime stopped")
                            .await;
                    }
                });
            }
        }
    }
}

#[derive(Clone)]
pub(crate) struct GeminiRuntime {
    inner: Arc<Inner>,
}

impl GeminiRuntime {
    pub(crate) fn new(data_dir: PathBuf) -> Self {
        Self {
            inner: Arc::new(Inner {
                history: Arc::new(HistoryStore::new(data_dir)),
                sessions: StdMutex::new(HashMap::new()),
                model_cache: Mutex::new(HashMap::new()),
            }),
        }
    }

    pub(crate) async fn request<E: EventSink>(
        &self,
        workspace_id: &str,
        workspace_path: &str,
        launch: impl Into<LaunchConfig>,
        operation: &str,
        params: Value,
        event_sink: E,
    ) -> Result<Value, String> {
        let launch = launch.into();
        if workspace_id.trim().is_empty() || workspace_path.trim().is_empty() {
            return Err("Gemini workspace ID and path are required".to_string());
        }
        let workspace = workspace_id.to_string();
        let emit: Emit = Arc::new(move |message| {
            event_sink.emit_app_server_event(AppServerEvent {
                workspace_id: workspace.clone(),
                message,
            })
        });
        match operation {
            "start" => {
                self.start(workspace_id, workspace_path, &launch, &params, emit)
                    .await
            }
            "resume" => {
                let thread_id = thread_id(&params)?;
                self.ensure_session(workspace_id, workspace_path, &launch, thread_id, emit)
                    .await?;
                let stored = self
                    .inner
                    .history
                    .get(workspace_id, workspace_path, thread_id)?;
                history_page(stored.thread, &params)
            }
            "send" => {
                self.send(workspace_id, workspace_path, &launch, &params, emit)
                    .await
            }
            "interrupt" => {
                let id = thread_id(&params)?;
                self.inner.history.get(workspace_id, workspace_path, id)?;
                if let Some(session) = self.running_session(id).await? {
                    session
                        .connection
                        .cancel(params.get("turnId").and_then(Value::as_str))
                        .await
                } else {
                    Ok(json!({}))
                }
            }
            "respond" => self.respond(workspace_id, workspace_path, &params).await,
            "list" => Ok(
                json!({"data":self.inner.history.list(workspace_id, workspace_path, params["archived"].as_bool().unwrap_or(false))?,"nextCursor":null}),
            ),
            "archive" | "unarchive" => {
                let id = thread_id(&params)?;
                self.inner.history.get(workspace_id, workspace_path, id)?;
                if let Some(session) = self.running_session(id).await? {
                    if session.connection.active_turn().await.is_some() {
                        return Err("Stop the Gemini turn before archiving the session".to_string());
                    }
                    session
                        .connection
                        .close("Gemini session archived in TF")
                        .await;
                }
                self.inner.history.update(id, true, |stored| {
                    stored.archived = operation == "archive";
                    stored.thread["updatedAt"] = json!(now());
                    Ok(())
                })?;
                emit(
                    json!({"method":if operation == "archive" {"thread/archived"} else {"thread/unarchived"},"params":{"threadId":id}}),
                );
                Ok(json!({}))
            }
            "rename" => {
                let id = thread_id(&params)?;
                self.inner.history.get(workspace_id, workspace_path, id)?;
                let name = params
                    .get("name")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|name| !name.is_empty())
                    .ok_or("Gemini session name is required")?;
                self.inner.history.update(id, true, |stored| {
                    stored.thread["name"] = json!(name);
                    stored.thread["updatedAt"] = json!(now());
                    Ok(())
                })?;
                emit(
                    json!({"method":"thread/name/updated","params":{"threadId":id,"threadName":name,"name":name}}),
                );
                Ok(json!({}))
            }
            "read" => history_page(
                self.inner
                    .history
                    .get(workspace_id, workspace_path, thread_id(&params)?)?
                    .thread,
                &params,
            ),
            "models" => {
                self.models(workspace_id, workspace_path, &launch, &params, emit)
                    .await
            }
            _ => Err(format!("Unsupported Gemini runtime operation: {operation}")),
        }
    }

    async fn connect(
        &self,
        cwd: &str,
        launch: &LaunchConfig,
        emit: Emit,
    ) -> Result<(Arc<AcpConnection>, Value), String> {
        let executable = resolve_cli_path("gemini", launch.bin.as_deref(), None, None)?;
        let connection =
            AcpConnection::spawn(&executable, cwd, launch, self.inner.history.clone(), emit)
                .await?;
        let initialized = connection.call("initialize", json!({
            "protocolVersion":1,
            "clientInfo":{"name":"threadfleet","title":"ThreadFleet","version":env!("CARGO_PKG_VERSION")},
            "clientCapabilities":{"fs":{"readTextFile":false,"writeTextFile":false},"terminal":false,"auth":{"terminal":false}},
        }), CONTROL_TIMEOUT).await;
        match initialized {
            Ok(initialized) if initialized["protocolVersion"].as_u64() == Some(1) => {
                Ok((connection, initialized))
            }
            Ok(_) => {
                connection
                    .close("Unsupported Gemini ACP protocol version")
                    .await;
                Err("Gemini CLI does not support ACP protocol version 1".to_string())
            }
            Err(error) => {
                connection.close(&error).await;
                Err(error)
            }
        }
    }

    async fn start(
        &self,
        workspace_id: &str,
        cwd: &str,
        launch: &LaunchConfig,
        params: &Value,
        emit: Emit,
    ) -> Result<Value, String> {
        let (connection, initialized) = self.connect(cwd, launch, emit.clone()).await?;
        let response = match connection
            .call(
                "session/new",
                json!({"cwd":cwd,"mcpServers":[]}),
                CONTROL_TIMEOUT,
            )
            .await
        {
            Ok(response) => response,
            Err(error) => {
                connection.close(&error).await;
                return Err(error);
            }
        };
        let native_id = match response
            .get("sessionId")
            .and_then(Value::as_str)
            .filter(|id| valid_native_id(id))
        {
            Some(id) => id.to_string(),
            None => {
                connection
                    .close("Gemini CLI returned an invalid session ID")
                    .await;
                return Err("Gemini CLI returned an invalid session ID".to_string());
            }
        };
        let thread_id = format!("gemini:{native_id}");
        let session = Arc::new(Session {
            workspace_id: workspace_id.to_string(),
            thread_id: thread_id.clone(),
            native_id,
            connection: connection.clone(),
            prompt_capabilities: initialized["agentCapabilities"]["promptCapabilities"].clone(),
            runtime_fingerprint: launch.fingerprint(),
            control: Mutex::new(()),
        });
        let mut stored = make_thread(
            workspace_id,
            cwd,
            &session.native_id,
            &response,
            params["name"].as_str().unwrap_or(""),
        );
        if let Err(error) = configure(&session, &mut stored, params).await {
            connection.close(&error).await;
            return Err(error);
        }
        if let Err(error) = self.inner.history.insert(stored.clone()) {
            connection.close(&error).await;
            return Err(error);
        }
        connection.bind(&session.native_id, &thread_id).await;
        let slot = self.slot(&thread_id)?;
        *slot.lock().await = Some(session);
        emit(json!({"method":"thread/started","params":{"thread":stored.thread}}));
        history_page(stored.thread, params)
    }

    fn slot(&self, thread_id: &str) -> Result<SessionSlot, String> {
        let mut sessions = self
            .inner
            .sessions
            .lock()
            .map_err(|_| "Gemini session lock is unavailable")?;
        Ok(sessions
            .entry(thread_id.to_string())
            .or_insert_with(|| Arc::new(Mutex::new(None)))
            .clone())
    }

    async fn running_session(&self, thread_id: &str) -> Result<Option<Arc<Session>>, String> {
        let slot = self
            .inner
            .sessions
            .lock()
            .map_err(|_| "Gemini session lock is unavailable")?
            .get(thread_id)
            .cloned();
        let Some(slot) = slot else { return Ok(None) };
        let session = slot
            .lock()
            .await
            .clone()
            .filter(|session| !session.connection.is_closed());
        Ok(session)
    }

    async fn ensure_session(
        &self,
        workspace_id: &str,
        cwd: &str,
        launch: &LaunchConfig,
        thread_id: &str,
        emit: Emit,
    ) -> Result<Arc<Session>, String> {
        let mut stored = self.inner.history.get(workspace_id, cwd, thread_id)?;
        if stored.archived {
            return Err("Gemini session is archived in TF".to_string());
        }
        let slot = self.slot(thread_id)?;
        let mut slot = slot.lock().await;
        if let Some(session) = slot
            .as_ref()
            .filter(|session| !session.connection.is_closed())
        {
            if session.runtime_fingerprint == launch.fingerprint()
                || session.connection.active_turn().await.is_some()
            {
                return Ok(session.clone());
            }
            session
                .connection
                .close("Gemini provider configuration changed")
                .await;
        }
        let (connection, initialized) = self.connect(cwd, launch, emit).await?;
        if initialized["agentCapabilities"]["loadSession"].as_bool() != Some(true) {
            connection
                .close("Gemini CLI does not support restoring sessions")
                .await;
            return Err("This Gemini CLI version cannot restore sessions (ACP loadSession is unavailable). Install a version with session/load support.".to_string());
        }
        connection.bind(&stored.native_id, thread_id).await;
        let response = match connection
            .call(
                "session/load",
                json!({"sessionId":stored.native_id,"cwd":cwd,"mcpServers":[]}),
                CONTROL_TIMEOUT,
            )
            .await
        {
            Ok(response) => response,
            Err(error) => {
                connection.close(&error).await;
                return Err(error);
            }
        };
        if response.get("models").is_some() {
            stored.models = response["models"].clone();
        }
        if response.get("modes").is_some() {
            stored.modes = response["modes"].clone();
        }
        let session = Arc::new(Session {
            workspace_id: workspace_id.to_string(),
            thread_id: thread_id.to_string(),
            native_id: stored.native_id.clone(),
            connection: connection.clone(),
            prompt_capabilities: initialized["agentCapabilities"]["promptCapabilities"].clone(),
            runtime_fingerprint: launch.fingerprint(),
            control: Mutex::new(()),
        });
        if let Err(error) = configure(&session, &mut stored, &json!({})).await {
            connection.close(&error).await;
            return Err(error);
        }
        if let Err(error) = self.inner.history.update(thread_id, true, |current| {
            current.models = stored.models;
            current.modes = stored.modes;
            current.thread["model"] = stored.thread["model"].clone();
            Ok(())
        }) {
            connection.close(&error).await;
            return Err(error);
        }
        *slot = Some(session.clone());
        Ok(session)
    }

    async fn send(
        &self,
        workspace_id: &str,
        cwd: &str,
        launch: &LaunchConfig,
        params: &Value,
        emit: Emit,
    ) -> Result<Value, String> {
        let thread_id = thread_id(params)?;
        let session = self
            .ensure_session(workspace_id, cwd, launch, thread_id, emit)
            .await?;
        let _control = session.control.lock().await;
        if session.connection.active_turn().await.is_some() {
            return Err(
                "Gemini session is already generating; stop it before sending another prompt"
                    .to_string(),
            );
        }
        let (prompt, user_content, text) =
            build_prompt(params, cwd, &session.prompt_capabilities).await?;
        let mut stored = self.inner.history.get(workspace_id, cwd, thread_id)?;
        configure(&session, &mut stored, params).await?;
        self.inner.history.update(thread_id, true, |current| {
            current.models = stored.models;
            current.modes = stored.modes;
            current.thread["model"] = stored.thread["model"].clone();
            Ok(())
        })?;
        let turn = session.connection.begin_turn(&text, user_content).await?;
        let turn_id = turn["id"]
            .as_str()
            .ok_or("Gemini turn ID is unavailable")?
            .to_string();
        let connection = session.connection.clone();
        let receiver = match connection.start_prompt(&turn_id, prompt).await {
            Ok(Some(receiver)) => receiver,
            Ok(None) => {
                connection
                    .finish_turn(&turn_id, Ok(json!({"stopReason":"cancelled"})))
                    .await;
                return Ok(json!({"turn":{"id":turn_id,"status":"interrupted"}}));
            }
            Err(error) => {
                connection.finish_turn(&turn_id, Err(error.clone())).await;
                return Err(error);
            }
        };
        tokio::spawn(async move {
            let response = connection
                .await_response(receiver, "session/prompt", PROMPT_TIMEOUT)
                .await;
            connection.finish_turn(&turn_id, response).await;
        });
        Ok(json!({"turn":turn}))
    }

    async fn respond(
        &self,
        workspace_id: &str,
        cwd: &str,
        params: &Value,
    ) -> Result<Value, String> {
        let id = params
            .get("requestId")
            .and_then(Value::as_str)
            .filter(|id| id.starts_with("gemini:"))
            .ok_or("Namespaced Gemini approval ID is required")?;
        let slots: Vec<SessionSlot> = self
            .inner
            .sessions
            .lock()
            .map_err(|_| "Gemini session lock is unavailable")?
            .values()
            .cloned()
            .collect();
        for slot in slots {
            let session = slot.lock().await.clone();
            if let Some(session) = session {
                if session.workspace_id == workspace_id && session.connection.has_approval(id).await
                {
                    self.inner
                        .history
                        .get(workspace_id, cwd, &session.thread_id)?;
                    if params
                        .get("threadId")
                        .and_then(Value::as_str)
                        .is_some_and(|id| id != session.thread_id)
                    {
                        return Err("Gemini approval targets a different session".to_string());
                    }
                    return session
                        .connection
                        .respond(id, params.get("result").unwrap_or(params))
                        .await;
                }
            }
        }
        Err("Gemini approval is not pending in this workspace".to_string())
    }

    async fn models(
        &self,
        workspace_id: &str,
        cwd: &str,
        launch: &LaunchConfig,
        params: &Value,
        emit: Emit,
    ) -> Result<Value, String> {
        if let Some(thread_id) = params.get("threadId").and_then(Value::as_str) {
            return Ok(self.inner.history.get(workspace_id, cwd, thread_id)?.models);
        }
        let key = format!("{workspace_id}\n{}", launch.fingerprint());
        if params["forceRefresh"].as_bool() != Some(true) {
            if let Some((checked, models)) = self.inner.model_cache.lock().await.get(&key) {
                if checked.elapsed() < Duration::from_secs(60) {
                    return Ok(models.clone());
                }
            }
        }
        let (connection, _) = self.connect(cwd, launch, emit).await?;
        let response = connection
            .call(
                "session/new",
                json!({"cwd":cwd,"mcpServers":[]}),
                CONTROL_TIMEOUT,
            )
            .await;
        connection.close("Gemini model discovery completed").await;
        let models = response?
            .get("models")
            .cloned()
            .unwrap_or_else(|| json!({"availableModels":[],"currentModelId":null}));
        self.inner
            .model_cache
            .lock()
            .await
            .insert(key, (Instant::now(), models.clone()));
        Ok(models)
    }

    pub(crate) async fn shutdown(&self) {
        let slots: Vec<SessionSlot> = self
            .inner
            .sessions
            .lock()
            .map(|sessions| sessions.values().cloned().collect())
            .unwrap_or_default();
        for slot in slots {
            if let Some(session) = slot.lock().await.take() {
                session
                    .connection
                    .shutdown("TF Gemini runtime stopped")
                    .await;
            }
        }
    }

    pub(crate) async fn shutdown_workspace(&self, workspace_id: &str) {
        let slots: Vec<SessionSlot> = self
            .inner
            .sessions
            .lock()
            .map(|sessions| sessions.values().cloned().collect())
            .unwrap_or_default();
        for slot in slots {
            let mut current = slot.lock().await;
            if current
                .as_ref()
                .is_some_and(|session| session.workspace_id == workspace_id)
            {
                if let Some(session) = current.take() {
                    session
                        .connection
                        .shutdown("TF Gemini workspace disconnected")
                        .await;
                }
            }
        }
    }
}

async fn configure(
    session: &Session,
    stored: &mut StoredThread,
    params: &Value,
) -> Result<(), String> {
    let mode = if params["accessMode"].as_str() == Some("read-only") {
        "plan"
    } else {
        "default"
    };
    let available = stored.modes["availableModes"]
        .as_array()
        .is_some_and(|modes| {
            modes
                .iter()
                .any(|available| available["id"].as_str() == Some(mode))
        });
    if !available {
        return Err(format!(
            "Gemini CLI does not advertise the required '{mode}' approval mode"
        ));
    }
    session
        .connection
        .call(
            "session/set_mode",
            json!({"sessionId":session.native_id,"modeId":mode}),
            CONTROL_TIMEOUT,
        )
        .await?;
    stored.modes["currentModeId"] = json!(mode);
    if let Some(model) = params
        .get("model")
        .and_then(Value::as_str)
        .filter(|model| !model.trim().is_empty())
    {
        let available = stored.models["availableModels"]
            .as_array()
            .is_some_and(|models| {
                models
                    .iter()
                    .any(|available| available["modelId"].as_str() == Some(model))
            });
        if !available {
            return Err(format!("Gemini CLI does not advertise model '{model}'"));
        }
        if stored.models["currentModelId"].as_str() != Some(model) {
            session
                .connection
                .call(
                    "session/set_model",
                    json!({"sessionId":session.native_id,"modelId":model}),
                    CONTROL_TIMEOUT,
                )
                .await?;
        }
        stored.models["currentModelId"] = json!(model);
    }
    stored.thread["model"] = stored.models["currentModelId"].clone();
    Ok(())
}

fn valid_native_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 256 && !id.chars().any(char::is_control)
}

fn thread_id(params: &Value) -> Result<&str, String> {
    params
        .get("threadId")
        .and_then(Value::as_str)
        .filter(|id| id.strip_prefix("gemini:").is_some_and(valid_native_id))
        .ok_or_else(|| "Namespaced Gemini thread ID is required".to_string())
}

async fn build_prompt(
    params: &Value,
    cwd: &str,
    capabilities: &Value,
) -> Result<(Vec<Value>, Vec<Value>, String), String> {
    let text = params
        .get("text")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let mut prompt = Vec::new();
    let mut user = Vec::new();
    if let Some(context) = params.get("artifactContext").and_then(Value::as_str) {
        prompt.push(json!({"type":"text","text":context}));
    }
    if !text.is_empty() {
        prompt.push(json!({"type":"text","text":text}));
        user.push(json!({"type":"text","text":text}));
    }
    for image in params
        .get("images")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        if capabilities["image"].as_bool() != Some(true) {
            return Err("This Gemini CLI version does not support image prompts".to_string());
        }
        let image = image
            .as_str()
            .ok_or("Gemini image must be a data URL or file path")?;
        let (mime, data) = if let Some(value) = image.strip_prefix("data:") {
            let (mime, data) = value
                .split_once(";base64,")
                .ok_or("Gemini images require a base64 data URL")?;
            if !matches!(
                mime,
                "image/png" | "image/jpeg" | "image/webp" | "image/gif"
            ) {
                return Err("Unsupported Gemini image MIME type".to_string());
            }
            let bytes = STANDARD
                .decode(data)
                .map_err(|_| "Invalid base64 image data")?;
            if bytes.len() > 8 * 1024 * 1024 {
                return Err("Gemini image exceeds 8 MiB".to_string());
            }
            user.push(json!({"type":"image","imageUrl":image}));
            (mime.to_string(), data.to_string())
        } else {
            let path = attachment_path(image, cwd);
            let metadata = tokio::fs::metadata(&path)
                .await
                .map_err(|error| format!("Cannot inspect Gemini image attachment: {error}"))?;
            if !metadata.is_file() || metadata.len() > 8 * 1024 * 1024 {
                return Err("Gemini image must be a regular file up to 8 MiB".to_string());
            }
            let mime = match path
                .extension()
                .and_then(|extension| extension.to_str())
                .map(str::to_ascii_lowercase)
                .as_deref()
            {
                Some("png") => "image/png",
                Some("jpg" | "jpeg") => "image/jpeg",
                Some("webp") => "image/webp",
                Some("gif") => "image/gif",
                _ => return Err("Unsupported Gemini image file type".to_string()),
            };
            let bytes = tokio::fs::read(&path)
                .await
                .map_err(|error| format!("Cannot read Gemini image attachment: {error}"))?;
            user.push(json!({"type":"localImage","path":path.to_string_lossy()}));
            (mime.to_string(), STANDARD.encode(bytes))
        };
        prompt.push(json!({"type":"image","mimeType":mime,"data":data}));
    }
    for file in params
        .get("files")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let path = file
            .as_str()
            .or_else(|| file.get("path").and_then(Value::as_str))
            .ok_or("Gemini file attachment path is required")?;
        let path = attachment_path(path, cwd);
        let metadata = tokio::fs::metadata(&path)
            .await
            .map_err(|error| format!("Cannot inspect Gemini file attachment: {error}"))?;
        if !metadata.is_file() {
            return Err("Gemini file attachment must be a regular file".to_string());
        }
        let name = path.file_name().unwrap_or_default().to_string_lossy();
        // Gemini's ACP resolver consumes the literal path after file:// and
        // applies its own outside-workspace read approval before reading.
        prompt.push(json!({"type":"resource_link","uri":format!("file://{}",path.to_string_lossy()),"name":name}));
        user.push(json!({"type":"text","text":format!("@{}",path.to_string_lossy())}));
    }
    if user.is_empty() {
        return Err("Gemini prompt is empty".to_string());
    }
    Ok((prompt, user, text))
}

fn attachment_path(value: &str, cwd: &str) -> PathBuf {
    let path = Path::new(value);
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        Path::new(cwd).join(path)
    }
}

fn history_page(mut thread: Value, params: &Value) -> Result<Value, String> {
    let id = thread["id"]
        .as_str()
        .ok_or("Gemini history thread ID is unavailable")?
        .to_string();
    let turns = thread["turns"].as_array().cloned().unwrap_or_default();
    let flattened: Vec<(usize, Value)> = turns
        .iter()
        .enumerate()
        .flat_map(|(turn_index, turn)| {
            turn["items"]
                .as_array()
                .into_iter()
                .flatten()
                .cloned()
                .map(move |item| (turn_index, item))
        })
        .collect();
    let before = if let Some(cursor) = params["cursor"]
        .as_str()
        .filter(|cursor| !cursor.is_empty())
    {
        let bytes = URL_SAFE_NO_PAD
            .decode(cursor)
            .map_err(|_| "Invalid Gemini history cursor")?;
        let cursor: Value =
            serde_json::from_slice(&bytes).map_err(|_| "Invalid Gemini history cursor")?;
        if cursor["threadId"].as_str() != Some(id.as_str()) {
            return Err("Gemini history cursor belongs to another session".to_string());
        }
        flattened
            .iter()
            .position(|(_, item)| item["id"] == cursor["beforeItemId"])
            .ok_or("Gemini history cursor is stale")?
    } else {
        flattened.len()
    };
    let item_limit = params["itemLimit"].as_u64().unwrap_or(200).clamp(1, 500) as usize;
    let byte_limit = params["byteLimit"]
        .as_u64()
        .unwrap_or(512 * 1024)
        .clamp(1024, 2 * 1024 * 1024) as usize;
    let mut start = before;
    let mut bytes = 0;
    while start > 0 && before - start < item_limit {
        let item_bytes = serde_json::to_vec(&flattened[start - 1].1)
            .map_err(|error| error.to_string())?
            .len();
        if start < before && bytes + item_bytes > byte_limit {
            break;
        }
        bytes += item_bytes;
        start -= 1;
    }
    let mut selected: Vec<Value> = Vec::new();
    for (index, item) in &flattened[start..before] {
        if selected.last().and_then(|turn| turn.get("id")) != turns[*index].get("id") {
            let mut turn = turns[*index].clone();
            turn["items"] = json!([]);
            selected.push(turn);
        }
        selected.last_mut().expect("selected turn was inserted")["items"]
            .as_array_mut()
            .expect("items was reset")
            .push(item.clone());
    }
    thread["turns"] = json!(selected);
    let cursor = if start > 0 {
        Some(
            URL_SAFE_NO_PAD.encode(
                serde_json::to_vec(&json!({"threadId":id,"beforeItemId":flattened[start].1["id"]}))
                    .map_err(|error| error.to_string())?,
            ),
        )
    } else {
        None
    };
    Ok(
        json!({"thread":thread,"codexMonitorHistoryPage":{"hasMore":start>0,"nextCursor":cursor,"itemCount":before-start,"byteCount":bytes}}),
    )
}

#[cfg(test)]
mod tests;
