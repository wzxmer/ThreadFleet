use std::collections::HashMap;
use std::future::Future;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use tokio::sync::Mutex;

use crate::backend::app_server::WorkspaceSession;
use crate::types::{SessionSource, WorkspaceEntry};

use super::types::source_identity_key;

pub(crate) const DEFAULT_SOURCE_RUNTIME_IDLE_TIMEOUT: Duration = Duration::from_secs(10 * 60);

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub(crate) struct SourceRuntimeKey {
    pub(crate) source_identity: String,
    pub(crate) workspace_context: String,
    pub(crate) purpose: SourceRuntimePurpose,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) enum SourceRuntimePurpose {
    Execution,
    History,
}

impl SourceRuntimeKey {
    #[cfg(test)]
    pub(crate) fn new(source_path: &str, workspace_context: &str) -> Result<Self, String> {
        Self::for_purpose(
            source_path,
            workspace_context,
            SourceRuntimePurpose::Execution,
        )
    }

    pub(crate) fn for_purpose(
        source_path: &str,
        workspace_context: &str,
        purpose: SourceRuntimePurpose,
    ) -> Result<Self, String> {
        let source_identity = source_identity_key(source_path);
        if source_identity.is_empty() {
            return Err("Session source path is required".to_string());
        }
        let workspace_context = source_identity_key(workspace_context);
        if workspace_context.is_empty() {
            return Err("Session runtime workspace context is required".to_string());
        }
        Ok(Self {
            source_identity,
            workspace_context,
            purpose,
        })
    }
}

#[derive(Debug)]
struct RuntimeEntry<T> {
    runtime: Arc<T>,
    last_activity: Instant,
}

#[derive(Debug)]
pub(crate) struct SourceRuntimePool<T> {
    entries: Mutex<HashMap<SourceRuntimeKey, RuntimeEntry<T>>>,
    spawn_lock: Mutex<()>,
    idle_timeout: Duration,
    max_idle_strong_count: usize,
}

pub(crate) type SessionSourceRuntimePool = SourceRuntimePool<WorkspaceSession>;

pub(crate) async fn active_execution_runtime_for_thread(
    sessions: &Mutex<HashMap<String, Arc<WorkspaceSession>>>,
    source_runtimes: &SessionSourceRuntimePool,
    source_thread_runtimes: &SourceThreadRuntimeBindings,
    workspace_id: &str,
    thread_id: &str,
) -> Option<Arc<WorkspaceSession>> {
    let primary_session = sessions.lock().await.get(workspace_id).cloned();
    if let Some(session) = primary_session {
        if session.has_active_turn(thread_id).await {
            return Some(session);
        }
    }
    let binding = source_thread_runtimes.get(workspace_id, thread_id).await?;
    let key = SourceRuntimeKey::for_purpose(
        &binding.source.codex_home_path,
        &binding.workspace.path,
        SourceRuntimePurpose::Execution,
    )
    .ok()?;
    let session = source_runtimes.get(&key).await?;
    session.has_active_turn(thread_id).await.then_some(session)
}

#[derive(Default)]
pub(crate) struct SourceThreadRuntimeBindings {
    entries: Mutex<HashMap<(String, String), SourceThreadRuntimeBinding>>,
}

#[derive(Clone)]
pub(crate) struct SourceThreadRuntimeBinding {
    pub(crate) source: SessionSource,
    pub(crate) workspace: WorkspaceEntry,
    pub(crate) client_version: Option<String>,
}

impl SourceThreadRuntimeBindings {
    pub(crate) async fn bind(
        &self,
        workspace_id: &str,
        thread_id: &str,
        binding: SourceThreadRuntimeBinding,
    ) {
        self.entries
            .lock()
            .await
            .insert((workspace_id.to_string(), thread_id.to_string()), binding);
    }

    pub(crate) async fn get(
        &self,
        workspace_id: &str,
        thread_id: &str,
    ) -> Option<SourceThreadRuntimeBinding> {
        self.entries
            .lock()
            .await
            .get(&(workspace_id.to_string(), thread_id.to_string()))
            .cloned()
    }

    pub(crate) async fn remove(&self, workspace_id: &str, thread_id: &str) {
        self.entries
            .lock()
            .await
            .remove(&(workspace_id.to_string(), thread_id.to_string()));
    }

    pub(crate) async fn remove_for_source_thread(&self, source_id: &str, thread_id: &str) {
        self.entries
            .lock()
            .await
            .retain(|(_, candidate_thread_id), binding| {
                binding.source.id != source_id || candidate_thread_id != thread_id
            });
    }

    pub(crate) async fn unique_for_workspace(
        &self,
        workspace_id: &str,
    ) -> Option<(String, SourceThreadRuntimeBinding)> {
        let entries = self.entries.lock().await;
        let mut matches = entries
            .iter()
            .filter(|((candidate_workspace_id, _), _)| candidate_workspace_id == workspace_id)
            .map(|((_, thread_id), binding)| (thread_id.clone(), binding.clone()));
        let first = matches.next()?;
        for candidate in matches {
            if source_identity_key(&candidate.1.source.codex_home_path)
                != source_identity_key(&first.1.source.codex_home_path)
                || source_identity_key(&candidate.1.workspace.path)
                    != source_identity_key(&first.1.workspace.path)
            {
                return None;
            }
        }
        Some(first)
    }
}

impl<T> Default for SourceRuntimePool<T> {
    fn default() -> Self {
        Self::new(DEFAULT_SOURCE_RUNTIME_IDLE_TIMEOUT)
    }
}

impl<T> SourceRuntimePool<T> {
    pub(crate) fn new(idle_timeout: Duration) -> Self {
        Self::new_with_max_idle_strong_count(idle_timeout, 1)
    }

    fn new_with_max_idle_strong_count(
        idle_timeout: Duration,
        max_idle_strong_count: usize,
    ) -> Self {
        Self {
            entries: Mutex::new(HashMap::new()),
            spawn_lock: Mutex::new(()),
            idle_timeout,
            max_idle_strong_count,
        }
    }

    pub(crate) async fn get(&self, key: &SourceRuntimeKey) -> Option<Arc<T>> {
        let mut entries = self.entries.lock().await;
        let entry = entries.get_mut(key)?;
        entry.last_activity = Instant::now();
        Some(Arc::clone(&entry.runtime))
    }

    pub(crate) async fn get_or_spawn<F, Fut>(
        &self,
        key: SourceRuntimeKey,
        spawn: F,
    ) -> Result<Arc<T>, String>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<Arc<T>, String>>,
    {
        if let Some(runtime) = self.get(&key).await {
            return Ok(runtime);
        }
        let _spawn_guard = self.spawn_lock.lock().await;
        if let Some(runtime) = self.get(&key).await {
            return Ok(runtime);
        }
        let runtime = spawn().await?;
        self.entries.lock().await.insert(
            key,
            RuntimeEntry {
                runtime: Arc::clone(&runtime),
                last_activity: Instant::now(),
            },
        );
        Ok(runtime)
    }

    pub(crate) async fn touch(&self, key: &SourceRuntimeKey) -> bool {
        let mut entries = self.entries.lock().await;
        let Some(entry) = entries.get_mut(key) else {
            return false;
        };
        entry.last_activity = Instant::now();
        true
    }

    pub(crate) async fn remove(&self, key: &SourceRuntimeKey) -> Option<Arc<T>> {
        self.entries
            .lock()
            .await
            .remove(key)
            .map(|entry| entry.runtime)
    }

    pub(crate) async fn take_idle(&self) -> Vec<Arc<T>> {
        self.take_idle_at(Instant::now()).await
    }

    pub(crate) async fn take_all(&self) -> Vec<Arc<T>> {
        let _spawn_guard = self.spawn_lock.lock().await;
        self.entries
            .lock()
            .await
            .drain()
            .map(|(_, entry)| entry.runtime)
            .collect()
    }

    async fn take_idle_at(&self, now: Instant) -> Vec<Arc<T>> {
        let mut entries = self.entries.lock().await;
        let idle_keys = entries
            .iter()
            .filter(|(_, entry)| {
                now.saturating_duration_since(entry.last_activity) >= self.idle_timeout
                    && Arc::strong_count(&entry.runtime) <= self.max_idle_strong_count
            })
            .map(|(key, _)| key.clone())
            .collect::<Vec<_>>();
        idle_keys
            .into_iter()
            .filter_map(|key| entries.remove(&key).map(|entry| entry.runtime))
            .collect()
    }

    #[cfg(test)]
    async fn len(&self) -> usize {
        self.entries.lock().await.len()
    }
}

impl SourceRuntimePool<WorkspaceSession> {
    pub(crate) fn for_workspace_sessions() -> Self {
        Self::new_with_max_idle_strong_count(DEFAULT_SOURCE_RUNTIME_IDLE_TIMEOUT, 2)
    }

    pub(crate) async fn close_idle(&self) {
        for session in self.take_idle().await {
            session.shutdown().await;
        }
    }

    pub(crate) async fn sessions_snapshot(&self) -> Vec<Arc<WorkspaceSession>> {
        self.entries
            .lock()
            .await
            .values()
            .map(|entry| Arc::clone(&entry.runtime))
            .collect()
    }

    pub(crate) async fn sessions_snapshot_for_purpose(
        &self,
        purpose: SourceRuntimePurpose,
    ) -> Vec<Arc<WorkspaceSession>> {
        self.entries
            .lock()
            .await
            .iter()
            .filter(|(key, _)| key.purpose == purpose)
            .map(|(_, entry)| Arc::clone(&entry.runtime))
            .collect()
    }

    #[allow(dead_code)]
    pub(crate) async fn close_all(&self) {
        for session in self.take_all().await {
            session.shutdown().await;
        }
    }

    pub(crate) async fn get_or_spawn_workspace_session_for_source<F, Fut>(
        &self,
        source: &SessionSource,
        workspace_context: &str,
        spawn: F,
    ) -> Result<Arc<WorkspaceSession>, String>
    where
        F: FnOnce(PathBuf) -> Fut,
        Fut: Future<Output = Result<Arc<WorkspaceSession>, String>>,
    {
        self.get_or_spawn_workspace_session_for_source_with_status(source, workspace_context, spawn)
            .await
            .map(|(runtime, _)| runtime)
    }

    pub(crate) async fn get_or_spawn_workspace_session_for_source_with_status<F, Fut>(
        &self,
        source: &SessionSource,
        workspace_context: &str,
        spawn: F,
    ) -> Result<(Arc<WorkspaceSession>, bool), String>
    where
        F: FnOnce(PathBuf) -> Fut,
        Fut: Future<Output = Result<Arc<WorkspaceSession>, String>>,
    {
        self.get_or_spawn_workspace_session_for_source_purpose_with_status(
            source,
            workspace_context,
            SourceRuntimePurpose::Execution,
            spawn,
        )
        .await
    }

    pub(crate) async fn get_or_spawn_workspace_session_for_source_purpose<F, Fut>(
        &self,
        source: &SessionSource,
        workspace_context: &str,
        purpose: SourceRuntimePurpose,
        spawn: F,
    ) -> Result<Arc<WorkspaceSession>, String>
    where
        F: FnOnce(PathBuf) -> Fut,
        Fut: Future<Output = Result<Arc<WorkspaceSession>, String>>,
    {
        self.get_or_spawn_workspace_session_for_source_purpose_with_status(
            source,
            workspace_context,
            purpose,
            spawn,
        )
        .await
        .map(|(runtime, _)| runtime)
    }

    async fn get_or_spawn_workspace_session_for_source_purpose_with_status<F, Fut>(
        &self,
        source: &SessionSource,
        workspace_context: &str,
        purpose: SourceRuntimePurpose,
        spawn: F,
    ) -> Result<(Arc<WorkspaceSession>, bool), String>
    where
        F: FnOnce(PathBuf) -> Fut,
        Fut: Future<Output = Result<Arc<WorkspaceSession>, String>>,
    {
        let key =
            SourceRuntimeKey::for_purpose(&source.codex_home_path, workspace_context, purpose)?;
        if let Some(runtime) = self.get(&key).await {
            if runtime.is_process_alive().await {
                return Ok((runtime, false));
            }
            self.remove_and_close(&key).await;
        }
        let codex_home = PathBuf::from(&source.codex_home_path);
        self.get_or_spawn(key, || spawn(codex_home))
            .await
            .map(|runtime| (runtime, true))
    }

    pub(crate) async fn remove_and_close(&self, key: &SourceRuntimeKey) {
        if let Some(session) = self.remove(key).await {
            session.shutdown().await;
        }
    }
}

#[cfg(test)]
mod tests {
    use std::path::Path;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use super::*;

    fn source(id: &str, codex_home_path: &str) -> SessionSource {
        SessionSource {
            id: id.to_string(),
            name: id.to_string(),
            codex_home_path: codex_home_path.to_string(),
            enabled: true,
            is_current: false,
            is_default: false,
            discovered_at: 0,
            last_scan_at: None,
            status: crate::types::SessionSourceStatus::Ready,
            error: None,
        }
    }

    #[cfg(windows)]
    #[test]
    fn normalizes_source_and_workspace_identity() {
        let left = SourceRuntimeKey::new(r"C:\Users\Test\.codex\", r"D:\Project\Alpha\.").unwrap();
        let right = SourceRuntimeKey::new(r"c:/users/test/.codex", r"d:/project/alpha").unwrap();
        assert_eq!(left, right);
        assert_ne!(
            left,
            SourceRuntimeKey::new(r"C:\Users\Test\other", r"D:\Project\Alpha").unwrap()
        );
    }

    #[test]
    fn reuses_exact_key_and_keeps_sources_isolated() {
        let executor = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        executor.block_on(async {
            let pool = SourceRuntimePool::<usize>::new(Duration::from_secs(60));
            let spawns = AtomicUsize::new(0);
            let key = SourceRuntimeKey::new(r"C:\A", r"D:\Project").unwrap();
            let first = pool
                .get_or_spawn(key.clone(), || async {
                    spawns.fetch_add(1, Ordering::SeqCst);
                    Ok(Arc::new(1))
                })
                .await
                .unwrap();
            let second = pool
                .get_or_spawn(key, || async {
                    spawns.fetch_add(1, Ordering::SeqCst);
                    Ok(Arc::new(2))
                })
                .await
                .unwrap();
            assert!(Arc::ptr_eq(&first, &second));
            assert_eq!(spawns.load(Ordering::SeqCst), 1);

            let other = pool
                .get_or_spawn(
                    SourceRuntimeKey::new(r"C:\B", r"D:\Project").unwrap(),
                    || async { Ok(Arc::new(3)) },
                )
                .await
                .unwrap();
            assert!(!Arc::ptr_eq(&first, &other));
        });
    }

    #[cfg(not(windows))]
    #[test]
    fn normalizes_unix_source_and_workspace_identity() {
        let left =
            SourceRuntimeKey::new("/Users/test/.codex/", "/Users/test/Project/Alpha/.").unwrap();
        let right =
            SourceRuntimeKey::new("/Users/test/.codex", "/Users/test/Project/Alpha").unwrap();

        assert_eq!(left, right);
        assert_ne!(
            left,
            SourceRuntimeKey::new("/Users/test/.CODEX", "/Users/test/Project/Alpha").unwrap()
        );
    }

    #[test]
    fn keeps_history_and_execution_runtimes_isolated() {
        let executor = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        executor.block_on(async {
            let pool = SourceRuntimePool::<usize>::new(Duration::from_secs(60));
            let execution_key = SourceRuntimeKey::new(r"C:\A", r"D:\Project").unwrap();
            let history_key = SourceRuntimeKey::for_purpose(
                r"C:\A",
                r"D:\Project",
                SourceRuntimePurpose::History,
            )
            .unwrap();

            let execution = pool
                .get_or_spawn(execution_key, || async { Ok(Arc::new(1)) })
                .await
                .unwrap();
            let history = pool
                .get_or_spawn(history_key, || async { Ok(Arc::new(2)) })
                .await
                .unwrap();

            assert!(!Arc::ptr_eq(&execution, &history));
            assert_eq!(*execution, 1);
            assert_eq!(*history, 2);
        });
    }

    #[test]
    fn only_reclaims_idle_unborrowed_runtimes() {
        let executor = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        executor.block_on(async {
            let pool = SourceRuntimePool::<usize>::new(Duration::ZERO);
            let key = SourceRuntimeKey::new(r"C:\A", r"D:\Project").unwrap();
            let borrowed = pool
                .get_or_spawn(key, || async { Ok(Arc::new(1)) })
                .await
                .unwrap();
            assert!(pool.take_idle().await.is_empty());
            drop(borrowed);
            assert_eq!(pool.take_idle().await.len(), 1);
            assert_eq!(pool.len().await, 0);
        });
    }

    #[test]
    fn supports_one_runtime_owned_background_handle() {
        let executor = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        executor.block_on(async {
            let pool =
                SourceRuntimePool::<usize>::new_with_max_idle_strong_count(Duration::ZERO, 2);
            let key = SourceRuntimeKey::new(r"C:\A", r"D:\Project").unwrap();
            let runtime = pool
                .get_or_spawn(key, || async { Ok(Arc::new(1)) })
                .await
                .unwrap();
            let background_handle = Arc::clone(&runtime);
            assert!(pool.take_idle().await.is_empty());
            drop(runtime);
            assert_eq!(pool.take_idle().await.len(), 1);
            drop(background_handle);
        });
    }

    #[test]
    fn take_all_atomically_drains_borrowed_runtimes() {
        let executor = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        executor.block_on(async {
            let pool = SourceRuntimePool::<usize>::new(Duration::from_secs(60));
            let first = pool
                .get_or_spawn(
                    SourceRuntimeKey::new(r"C:\A", r"D:\Project\One").unwrap(),
                    || async { Ok(Arc::new(1)) },
                )
                .await
                .unwrap();
            let second = pool
                .get_or_spawn(
                    SourceRuntimeKey::new(r"C:\B", r"D:\Project\Two").unwrap(),
                    || async { Ok(Arc::new(2)) },
                )
                .await
                .unwrap();

            let drained = pool.take_all().await;

            assert_eq!(drained.len(), 2);
            assert!(drained.iter().any(|runtime| Arc::ptr_eq(runtime, &first)));
            assert!(drained.iter().any(|runtime| Arc::ptr_eq(runtime, &second)));
            assert_eq!(pool.len().await, 0);
            assert!(pool.take_all().await.is_empty());
        });
    }

    #[test]
    fn source_spawn_receives_exact_codex_home_without_global_fallback() {
        let executor = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        executor.block_on(async {
            let pool = SourceRuntimePool::<PathBuf>::default();
            let selected_source = source("source-a", r"C:\Users\Test\alternate-codex");
            let codex_home = PathBuf::from(&selected_source.codex_home_path);
            let key = SourceRuntimeKey::new(&selected_source.codex_home_path, r"D:\Project\Alpha")
                .unwrap();
            let runtime = pool
                .get_or_spawn(key, || async move { Ok(Arc::new(codex_home)) })
                .await
                .unwrap();

            assert_eq!(
                runtime.as_path(),
                Path::new(&selected_source.codex_home_path)
            );
        });
    }

    #[test]
    fn thread_bindings_store_metadata_without_holding_runtime_handles() {
        let executor = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        executor.block_on(async {
            let bindings = SourceThreadRuntimeBindings::default();
            let binding = SourceThreadRuntimeBinding {
                source: source("source-a", r"C:\A"),
                workspace: WorkspaceEntry {
                    id: "ws-a".to_string(),
                    name: "A".to_string(),
                    path: r"D:\Project\A".to_string(),
                    kind: crate::types::WorkspaceKind::Main,
                    parent_id: None,
                    worktree: None,
                    settings: crate::types::WorkspaceSettings::default(),
                },
                client_version: None,
            };
            bindings.bind("ws-a", "thread-a", binding).await;
            let stored = bindings.get("ws-a", "thread-a").await.unwrap();
            assert_eq!(stored.source.id, "source-a");
            assert_eq!(stored.workspace.id, "ws-a");
        });
    }

    #[test]
    fn workspace_binding_allows_multiple_threads_only_for_the_same_source_runtime() {
        let executor = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        executor.block_on(async {
            let bindings = SourceThreadRuntimeBindings::default();
            let workspace = WorkspaceEntry {
                id: "ws-a".to_string(),
                name: "A".to_string(),
                path: r"D:\Project\A".to_string(),
                kind: crate::types::WorkspaceKind::Main,
                parent_id: None,
                worktree: None,
                settings: crate::types::WorkspaceSettings::default(),
            };
            for thread_id in ["thread-a", "thread-b"] {
                bindings
                    .bind(
                        "ws-a",
                        thread_id,
                        SourceThreadRuntimeBinding {
                            source: source("source-a", r"C:\A"),
                            workspace: workspace.clone(),
                            client_version: None,
                        },
                    )
                    .await;
            }
            assert!(bindings.unique_for_workspace("ws-a").await.is_some());
            bindings
                .bind(
                    "ws-a",
                    "thread-c",
                    SourceThreadRuntimeBinding {
                        source: source("source-b", r"C:\B"),
                        workspace,
                        client_version: None,
                    },
                )
                .await;
            assert!(bindings.unique_for_workspace("ws-a").await.is_none());
        });
    }
}
