use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashSet, VecDeque};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Clone, Serialize, Deserialize)]
pub(super) struct StoredThread {
    pub workspace_id: String,
    pub workspace_path: String,
    pub native_id: String,
    pub archived: bool,
    pub thread: Value,
    pub models: Value,
    pub modes: Value,
}

#[derive(Clone, Serialize, Deserialize)]
struct Document {
    version: u32,
    threads: BTreeMap<String, StoredThread>,
    #[serde(skip)]
    loaded: HashSet<String>,
    #[serde(skip)]
    cache_order: VecDeque<String>,
}

impl Default for Document {
    fn default() -> Self {
        Self {
            version: 2,
            threads: BTreeMap::new(),
            loaded: HashSet::new(),
            cache_order: VecDeque::new(),
        }
    }
}

/// TF owns only this index. Gemini's native configuration, authentication, and
/// session files remain under Gemini CLI's control.
pub(super) struct HistoryStore {
    path: PathBuf,
    document: Mutex<Option<Document>>,
}

impl HistoryStore {
    pub fn new(data_dir: PathBuf) -> Self {
        Self {
            path: data_dir.join("gemini-runtime").join("threads.json"),
            document: Mutex::new(None),
        }
    }

    fn with_document<T>(
        &self,
        f: impl FnOnce(&mut Document) -> Result<T, String>,
    ) -> Result<T, String> {
        let mut document = self
            .document
            .lock()
            .map_err(|_| "Gemini history lock is unavailable".to_string())?;
        if document.is_none() {
            let mut loaded = match fs::read(&self.path) {
                Ok(bytes) => serde_json::from_slice::<Document>(&bytes)
                    .map_err(|error| format!("Cannot read TF Gemini history: {error}"))?,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => Document::default(),
                Err(error) => return Err(format!("Cannot read TF Gemini history: {error}")),
            };
            if loaded.version != 2 {
                return Err("Unsupported TF Gemini history version".to_string());
            }
            // A process cannot survive an application restart. Preserve partial
            // output, but never restore a stale generating indicator.
            for (id, stored) in &mut loaded.threads {
                if id != &format!("gemini:{}", stored.native_id)
                    || stored.thread.get("id").and_then(Value::as_str) != Some(id.as_str())
                {
                    return Err("Invalid TF Gemini history ownership".to_string());
                }
                stored.thread["status"] = json!({"type":"idle"});
            }
            *document = Some(loaded);
        }
        let document = document.as_mut().expect("history was loaded");
        let result = f(document);
        // Only metadata stays resident for the entire library. Generating
        // sessions are pinned; at most eight idle transcripts are cached.
        while document.loaded.len() > 8 {
            let candidate = document
                .cache_order
                .iter()
                .find(|id| {
                    document.threads.get(*id).is_some_and(|stored| {
                        stored
                            .thread
                            .pointer("/status/type")
                            .and_then(Value::as_str)
                            != Some("active")
                    })
                })
                .cloned();
            let Some(id) = candidate else { break };
            if let Some(stored) = document.threads.get_mut(&id) {
                if let Some(thread) = stored.thread.as_object_mut() {
                    thread.remove("turns");
                }
            }
            document.loaded.remove(&id);
            document.cache_order.retain(|cached| cached != &id);
        }
        result
    }

    pub fn get(
        &self,
        workspace_id: &str,
        workspace_path: &str,
        thread_id: &str,
    ) -> Result<StoredThread, String> {
        self.with_document(|document| {
            let stored = document
                .threads
                .get(thread_id)
                .ok_or("Gemini session is not in TF history")?;
            validate_workspace(stored, workspace_id, workspace_path)?;
            self.load_thread(document, thread_id)?;
            Ok(document
                .threads
                .get(thread_id)
                .expect("thread was loaded")
                .clone())
        })
    }

    pub fn list(
        &self,
        workspace_id: &str,
        workspace_path: &str,
        archived: bool,
    ) -> Result<Vec<Value>, String> {
        self.with_document(|document| {
            let mut threads: Vec<Value> = document
                .threads
                .values()
                .filter(|stored| stored.workspace_id == workspace_id && stored.archived == archived)
                .filter(|stored| same_path(&stored.workspace_path, workspace_path))
                .map(|stored| thread_summary(&stored.thread))
                .collect();
            threads.sort_by_key(|thread| {
                std::cmp::Reverse(thread.get("updatedAt").and_then(Value::as_i64).unwrap_or(0))
            });
            Ok(threads)
        })
    }

    pub fn insert(&self, stored: StoredThread) -> Result<(), String> {
        self.with_document(|document| {
            let id = format!("gemini:{}", stored.native_id);
            if document.threads.contains_key(&id) {
                return Err("Gemini CLI returned an existing session ID".to_string());
            }
            document.threads.insert(id.clone(), stored);
            document.loaded.insert(id.clone());
            document.cache_order.push_back(id.clone());
            if let Err(error) = self.save(document, &id) {
                document.threads.remove(&id);
                document.loaded.remove(&id);
                document.cache_order.retain(|cached| cached != &id);
                return Err(error);
            }
            Ok(())
        })
    }

    pub fn update<T>(
        &self,
        thread_id: &str,
        persist: bool,
        f: impl FnOnce(&mut StoredThread) -> Result<T, String>,
    ) -> Result<T, String> {
        self.with_document(|document| {
            self.load_thread(document, thread_id)?;
            let thread = document
                .threads
                .get_mut(thread_id)
                .ok_or("Gemini session is not in TF history")?;
            let result = f(thread)?;
            if persist {
                self.save(document, thread_id)?;
            }
            Ok(result)
        })
    }

    fn thread_path(&self, thread_id: &str) -> PathBuf {
        let digest = Sha256::digest(thread_id.as_bytes());
        let name: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
        self.path
            .with_file_name("sessions")
            .join(format!("{name}.json"))
    }

    fn load_thread(&self, document: &mut Document, thread_id: &str) -> Result<(), String> {
        if !document.threads.contains_key(thread_id) {
            return Err("Gemini session is not in TF history".to_string());
        }
        if !document.loaded.contains(thread_id) {
            let bytes = fs::read(self.thread_path(thread_id))
                .map_err(|error| format!("Cannot read TF Gemini transcript: {error}"))?;
            let mut stored: StoredThread = serde_json::from_slice(&bytes)
                .map_err(|error| format!("Cannot read TF Gemini transcript: {error}"))?;
            let expected = document
                .threads
                .get(thread_id)
                .expect("thread ownership was checked");
            if stored.native_id != expected.native_id
                || stored.workspace_id != expected.workspace_id
                || !same_path(&stored.workspace_path, &expected.workspace_path)
                || stored.thread["id"].as_str() != Some(thread_id)
            {
                return Err("Invalid TF Gemini transcript ownership".to_string());
            }
            if let Some(turns) = stored.thread.get_mut("turns").and_then(Value::as_array_mut) {
                for turn in turns {
                    if turn.get("status").and_then(Value::as_str) == Some("inProgress") {
                        turn["status"] = json!("interrupted");
                        turn["completedAt"] = json!(now());
                        if let Some(items) = turn.get_mut("items").and_then(Value::as_array_mut) {
                            for item in items {
                                if item.get("status").and_then(Value::as_str) == Some("inProgress")
                                {
                                    item["status"] = json!("declined");
                                }
                            }
                        }
                    }
                }
            }
            stored.thread["status"] = json!({"type":"idle"});
            document.threads.insert(thread_id.to_string(), stored);
            document.loaded.insert(thread_id.to_string());
        }
        document.cache_order.retain(|cached| cached != thread_id);
        document.cache_order.push_back(thread_id.to_string());
        Ok(())
    }

    fn save(&self, document: &Document, thread_id: &str) -> Result<(), String> {
        let stored = document
            .threads
            .get(thread_id)
            .ok_or("Gemini transcript is unavailable")?;
        let bytes = serde_json::to_vec(stored).map_err(|error| error.to_string())?;
        self.write_file(&self.thread_path(thread_id), &bytes)?;
        let index = Document {
            version: document.version,
            threads: document
                .threads
                .iter()
                .map(|(id, stored)| {
                    (
                        id.clone(),
                        StoredThread {
                            workspace_id: stored.workspace_id.clone(),
                            workspace_path: stored.workspace_path.clone(),
                            native_id: stored.native_id.clone(),
                            archived: stored.archived,
                            thread: thread_summary(&stored.thread),
                            models: stored.models.clone(),
                            modes: stored.modes.clone(),
                        },
                    )
                })
                .collect(),
            loaded: HashSet::new(),
            cache_order: VecDeque::new(),
        };
        let bytes = serde_json::to_vec(&index).map_err(|error| error.to_string())?;
        self.write_file(&self.path, &bytes)
    }

    fn write_file(&self, path: &Path, bytes: &[u8]) -> Result<(), String> {
        let directory = path.parent().ok_or("Invalid TF Gemini history path")?;
        fs::create_dir_all(directory)
            .map_err(|error| format!("Cannot save TF Gemini history: {error}"))?;
        let temporary = directory.join(format!("threads-{}.tmp", uuid::Uuid::new_v4()));
        let result = (|| {
            let mut file = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temporary)
                .map_err(|error| error.to_string())?;
            file.write_all(bytes).map_err(|error| error.to_string())?;
            file.sync_all().map_err(|error| error.to_string())?;
            drop(file);
            replace_file(&temporary, path).map_err(|error| error.to_string())
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temporary);
        }
        result.map_err(|error| format!("Cannot save TF Gemini history: {error}"))
    }
}

fn thread_summary(thread: &Value) -> Value {
    Value::Object(
        thread
            .as_object()
            .into_iter()
            .flatten()
            .filter(|(key, _)| key.as_str() != "turns")
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect(),
    )
}

fn replace_file(source: &Path, target: &Path) -> std::io::Result<()> {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::{
            MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
        };
        let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
        let target: Vec<u16> = target.as_os_str().encode_wide().chain(Some(0)).collect();
        if unsafe {
            MoveFileExW(
                source.as_ptr(),
                target.as_ptr(),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
        } == 0
        {
            return Err(std::io::Error::last_os_error());
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        fs::rename(source, target)
    }
}

fn validate_workspace(
    stored: &StoredThread,
    workspace_id: &str,
    workspace_path: &str,
) -> Result<(), String> {
    if stored.workspace_id != workspace_id || !same_path(&stored.workspace_path, workspace_path) {
        return Err("Gemini session belongs to a different workspace".to_string());
    }
    Ok(())
}

fn same_path(left: &str, right: &str) -> bool {
    let left = fs::canonicalize(left).unwrap_or_else(|_| PathBuf::from(left));
    let right = fs::canonicalize(right).unwrap_or_else(|_| PathBuf::from(right));
    #[cfg(windows)]
    {
        left.to_string_lossy()
            .eq_ignore_ascii_case(&right.to_string_lossy())
    }
    #[cfg(not(windows))]
    {
        left == right
    }
}

pub(super) fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

pub(super) fn make_thread(
    workspace_id: &str,
    cwd: &str,
    native_id: &str,
    response: &Value,
    name: &str,
) -> StoredThread {
    StoredThread {
        workspace_id: workspace_id.to_string(),
        workspace_path: cwd.to_string(),
        native_id: native_id.to_string(),
        archived: false,
        thread: json!({
            "id":format!("gemini:{native_id}"), "engine":"gemini", "cwd":cwd,
            "name":name, "preview":"", "createdAt":now(), "updatedAt":now(),
            "modelProvider":"google", "model":response.pointer("/models/currentModelId"),
            "status":{"type":"idle"}, "turns":[], "ephemeral":false,
        }),
        models: response
            .get("models")
            .cloned()
            .unwrap_or_else(|| json!({"availableModels":[],"currentModelId":null})),
        modes: response
            .get("modes")
            .cloned()
            .unwrap_or_else(|| json!({"availableModes":[],"currentModeId":null})),
    }
}
