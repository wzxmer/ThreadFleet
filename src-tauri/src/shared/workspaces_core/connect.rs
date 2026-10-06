use std::collections::HashMap;
use std::future::Future;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::OnceLock;

use tokio::sync::Mutex;

use crate::backend::app_server::WorkspaceSession;
use crate::codex::args::resolve_workspace_codex_args;
use crate::codex::home::resolve_settings_codex_home;
use crate::shared::process_core::kill_child_process_tree;
use crate::types::{AppSettings, WorkspaceEntry, WorkspaceKind, WorkspaceSettings};

use super::helpers::resolve_entry_and_parent;

static CONNECT_WORKSPACE_SPAWN_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
const LOCAL_CODEX_WORKSPACE_ID: &str = "__local_codex_sessions__";
const LOCAL_CODEX_WORKSPACE_NAME: &str = "本机 Codex 历史会话";

pub(super) fn workspace_session_spawn_lock() -> &'static Mutex<()> {
    CONNECT_WORKSPACE_SPAWN_LOCK.get_or_init(|| Mutex::new(()))
}

async fn session_process_is_alive(session: &Arc<WorkspaceSession>) -> bool {
    session.is_process_alive().await
}

async fn remove_session_references(
    sessions: &Mutex<HashMap<String, Arc<WorkspaceSession>>>,
    session: &Arc<WorkspaceSession>,
) {
    let mut sessions = sessions.lock().await;
    sessions.retain(|_, candidate| !Arc::ptr_eq(candidate, session));
}

pub(super) async fn take_live_shared_session(
    sessions: &Mutex<HashMap<String, Arc<WorkspaceSession>>>,
    codex_bin: Option<&str>,
) -> Option<Arc<WorkspaceSession>> {
    let candidates = sessions.lock().await.values().cloned().collect::<Vec<_>>();
    for existing_session in candidates {
        if session_process_is_alive(&existing_session).await {
            if existing_session.uses_codex_bin(codex_bin) {
                return Some(existing_session);
            }
            continue;
        }
        remove_session_references(sessions, &existing_session).await;
    }
    None
}

fn local_codex_workspace_entry() -> WorkspaceEntry {
    let path = crate::codex::home::resolve_home_dir()
        .or_else(|| std::env::current_dir().ok())
        .unwrap_or_else(|| ".".into())
        .to_string_lossy()
        .to_string();
    WorkspaceEntry {
        id: LOCAL_CODEX_WORKSPACE_ID.to_string(),
        name: LOCAL_CODEX_WORKSPACE_NAME.to_string(),
        path,
        kind: WorkspaceKind::Main,
        parent_id: None,
        worktree: None,
        settings: WorkspaceSettings::default(),
    }
}

async fn resolve_connect_entry(
    workspaces: &Mutex<HashMap<String, WorkspaceEntry>>,
    workspace_id: &str,
) -> Result<(WorkspaceEntry, Option<WorkspaceEntry>), String> {
    match resolve_entry_and_parent(workspaces, workspace_id).await {
        Ok(result) => Ok(result),
        Err(_) if workspace_id == LOCAL_CODEX_WORKSPACE_ID => {
            Ok((local_codex_workspace_entry(), None))
        }
        Err(error) => Err(error),
    }
}

pub(crate) async fn connect_workspace_core<F, Fut>(
    workspace_id: String,
    workspaces: &Mutex<HashMap<String, WorkspaceEntry>>,
    sessions: &Mutex<HashMap<String, Arc<WorkspaceSession>>>,
    app_settings: &Mutex<AppSettings>,
    spawn_session: F,
) -> Result<(), String>
where
    F: Fn(WorkspaceEntry, Option<String>, Option<String>, Option<PathBuf>) -> Fut,
    Fut: Future<Output = Result<Arc<WorkspaceSession>, String>>,
{
    let (entry, parent_entry) = resolve_connect_entry(workspaces, &workspace_id).await?;
    let _spawn_guard = workspace_session_spawn_lock().lock().await;
    if let Some(existing_for_entry) = {
        let sessions = sessions.lock().await;
        sessions.get(&entry.id).cloned()
    } {
        if session_process_is_alive(&existing_for_entry).await {
            return Ok(());
        }
        remove_session_references(sessions, &existing_for_entry).await;
    }
    let (default_bin, codex_args, codex_home) = {
        let settings = app_settings.lock().await;
        (
            settings.codex_bin.clone(),
            resolve_workspace_codex_args(&entry, parent_entry.as_ref(), Some(&settings)),
            resolve_settings_codex_home(&settings),
        )
    };
    if let Some(existing_session) = take_live_shared_session(sessions, default_bin.as_deref()).await
    {
        existing_session
            .register_workspace_with_path(&entry.id, Some(&entry.path))
            .await;
        sessions
            .lock()
            .await
            .insert(entry.id.clone(), existing_session);
        return Ok(());
    }
    let session = spawn_session(entry.clone(), default_bin, codex_args, codex_home).await?;
    session
        .register_workspace_with_path(&entry.id, Some(&entry.path))
        .await;
    sessions.lock().await.insert(entry.id, session);
    Ok(())
}

pub(super) async fn kill_session_by_id(
    sessions: &Mutex<HashMap<String, Arc<WorkspaceSession>>>,
    id: &str,
) {
    let (removed, still_referenced) = {
        let mut sessions = sessions.lock().await;
        let removed = sessions.remove(id);
        let still_referenced = removed.as_ref().is_some_and(|session| {
            sessions
                .values()
                .any(|candidate| Arc::ptr_eq(candidate, session))
        });
        (removed, still_referenced)
    };
    if let Some(session) = removed {
        session.unregister_workspace(id).await;
        if still_referenced {
            return;
        }
        let mut child = session.child.lock().await;
        kill_child_process_tree(&mut child).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::collections::HashMap;
    use std::process::Stdio;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    use tokio::process::Command;
    use tokio::sync::Mutex;

    use crate::types::{WorkspaceKind, WorkspaceSettings};

    fn make_workspace_entry(id: &str) -> WorkspaceEntry {
        WorkspaceEntry {
            id: id.to_string(),
            name: id.to_string(),
            path: "/tmp".to_string(),
            kind: WorkspaceKind::Main,
            parent_id: None,
            worktree: None,
            settings: WorkspaceSettings::default(),
        }
    }

    fn make_session(_entry: WorkspaceEntry) -> Arc<WorkspaceSession> {
        let mut cmd = if cfg!(windows) {
            let mut cmd = Command::new("cmd");
            cmd.args(["/C", "more"]);
            cmd
        } else {
            let mut cmd = Command::new("sh");
            cmd.args(["-c", "cat"]);
            cmd
        };

        cmd.stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null());

        let mut child = cmd.spawn().expect("spawn dummy child");
        let stdin = child.stdin.take().expect("dummy child stdin");

        Arc::new(WorkspaceSession::test_new(
            None,
            None,
            child,
            stdin,
            "test-owner".to_string(),
        ))
    }

    #[test]
    fn connect_workspace_is_noop_when_already_connected() {
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let entry = make_workspace_entry("ws-1");
            let workspaces = Mutex::new(HashMap::from([(entry.id.clone(), entry.clone())]));
            let sessions = Mutex::new(HashMap::from([(
                entry.id.clone(),
                make_session(entry.clone()),
            )]));
            let app_settings = Mutex::new(AppSettings::default());
            let spawn_calls = Arc::new(AtomicUsize::new(0));
            let spawn_calls_ref = spawn_calls.clone();

            connect_workspace_core(
                entry.id.clone(),
                &workspaces,
                &sessions,
                &app_settings,
                move |_entry, _default_bin, _codex_args, _codex_home| {
                    let spawn_calls_ref = spawn_calls_ref.clone();
                    async move {
                        spawn_calls_ref.fetch_add(1, Ordering::SeqCst);
                        Err("should not spawn".to_string())
                    }
                },
            )
            .await
            .expect("connect should be noop");

            assert_eq!(spawn_calls.load(Ordering::SeqCst), 0);
            kill_session_by_id(&sessions, &entry.id).await;
        });
    }

    #[test]
    fn new_connections_do_not_reuse_previous_managed_cli() {
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let entry = make_workspace_entry("old");
            let old = make_session(entry);
            let sessions = Mutex::new(HashMap::from([("old".into(), old.clone())]));
            assert!(take_live_shared_session(&sessions, Some("new/codex.exe"))
                .await
                .is_none());
            assert!(old.is_process_alive().await);
            old.shutdown().await;
        });
    }

    #[test]
    fn connect_workspace_spawns_when_not_connected() {
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let entry = make_workspace_entry("ws-2");
            let workspaces = Mutex::new(HashMap::from([(entry.id.clone(), entry.clone())]));
            let sessions = Mutex::new(HashMap::<String, Arc<WorkspaceSession>>::new());
            let app_settings = Mutex::new(AppSettings::default());
            let spawn_calls = Arc::new(AtomicUsize::new(0));
            let spawn_calls_ref = spawn_calls.clone();
            let entry_for_spawn = entry.clone();

            connect_workspace_core(
                entry.id.clone(),
                &workspaces,
                &sessions,
                &app_settings,
                move |_entry, _default_bin, _codex_args, _codex_home| {
                    let spawn_calls_ref = spawn_calls_ref.clone();
                    let entry_for_spawn = entry_for_spawn.clone();
                    async move {
                        spawn_calls_ref.fetch_add(1, Ordering::SeqCst);
                        Ok(make_session(entry_for_spawn))
                    }
                },
            )
            .await
            .expect("connect should spawn");

            assert_eq!(spawn_calls.load(Ordering::SeqCst), 1);
            assert!(sessions.lock().await.contains_key(&entry.id));
            kill_session_by_id(&sessions, &entry.id).await;
        });
    }

    #[test]
    fn connect_workspace_respawns_when_existing_session_output_closed() {
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let entry = make_workspace_entry("ws-dead");
            let stale_session = make_session(entry.clone());
            stale_session.mark_output_closed();
            let workspaces = Mutex::new(HashMap::from([(entry.id.clone(), entry.clone())]));
            let sessions = Mutex::new(HashMap::from([(entry.id.clone(), stale_session)]));
            let app_settings = Mutex::new(AppSettings::default());
            let spawn_calls = Arc::new(AtomicUsize::new(0));
            let spawn_calls_ref = spawn_calls.clone();
            let entry_for_spawn = entry.clone();

            connect_workspace_core(
                entry.id.clone(),
                &workspaces,
                &sessions,
                &app_settings,
                move |_entry, _default_bin, _codex_args, _codex_home| {
                    let spawn_calls_ref = spawn_calls_ref.clone();
                    let entry_for_spawn = entry_for_spawn.clone();
                    async move {
                        spawn_calls_ref.fetch_add(1, Ordering::SeqCst);
                        Ok(make_session(entry_for_spawn))
                    }
                },
            )
            .await
            .expect("dead session should respawn");

            assert_eq!(spawn_calls.load(Ordering::SeqCst), 1);
            kill_session_by_id(&sessions, &entry.id).await;
        });
    }

    #[test]
    fn connect_local_codex_workspace_spawns_without_workspace_entry() {
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let workspaces = Mutex::new(HashMap::<String, WorkspaceEntry>::new());
            let sessions = Mutex::new(HashMap::<String, Arc<WorkspaceSession>>::new());
            let app_settings = Mutex::new(AppSettings::default());
            let spawn_calls = Arc::new(AtomicUsize::new(0));
            let spawn_calls_ref = spawn_calls.clone();

            connect_workspace_core(
                LOCAL_CODEX_WORKSPACE_ID.to_string(),
                &workspaces,
                &sessions,
                &app_settings,
                move |entry, _default_bin, _codex_args, _codex_home| {
                    let spawn_calls_ref = spawn_calls_ref.clone();
                    async move {
                        spawn_calls_ref.fetch_add(1, Ordering::SeqCst);
                        Ok(make_session(entry))
                    }
                },
            )
            .await
            .expect("local codex history workspace should spawn");

            assert_eq!(spawn_calls.load(Ordering::SeqCst), 1);
            assert!(sessions.lock().await.contains_key(LOCAL_CODEX_WORKSPACE_ID));
            kill_session_by_id(&sessions, LOCAL_CODEX_WORKSPACE_ID).await;
        });
    }
}
