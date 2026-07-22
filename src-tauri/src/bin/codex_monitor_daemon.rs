#[allow(dead_code)]
#[path = "../backend/mod.rs"]
mod backend;
#[path = "../codex/args.rs"]
mod codex_args;
#[path = "../codex/config.rs"]
mod codex_config;
#[path = "../codex/home.rs"]
mod codex_home;
#[path = "../files/io.rs"]
mod file_io;
#[path = "../files/ops.rs"]
mod file_ops;
#[path = "../files/policy.rs"]
mod file_policy;
#[path = "../git_utils.rs"]
mod git_utils;
#[path = "codex_monitor_daemon/rpc.rs"]
mod rpc;
#[path = "../rules.rs"]
mod rules;
#[path = "../shared/mod.rs"]
mod shared;
#[path = "../storage.rs"]
mod storage;
#[path = "codex_monitor_daemon/transport.rs"]
mod transport;
#[allow(dead_code)]
#[path = "../types.rs"]
mod types;
#[path = "../utils.rs"]
mod utils;
#[path = "../workspaces/macos.rs"]
mod workspace_macos;
#[path = "../workspaces/settings.rs"]
mod workspace_settings;

// Provide feature-style module paths for shared cores when compiled in the daemon.
mod codex {
    pub(crate) mod args {
        pub(crate) use crate::codex_args::*;
    }
    pub(crate) mod config {
        pub(crate) use crate::codex_config::*;
    }
    pub(crate) mod home {
        pub(crate) use crate::codex_home::*;
    }
}

mod files {
    pub(crate) mod io {
        pub(crate) use crate::file_io::*;
    }
    pub(crate) mod ops {
        pub(crate) use crate::file_ops::*;
    }
    pub(crate) mod policy {
        pub(crate) use crate::file_policy::*;
    }
}

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::env;
use std::fs::File;
use std::io::Read;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;

use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{broadcast, mpsc, Mutex, Semaphore};

use backend::app_server::{
    spawn_history_workspace_session, spawn_workspace_session, WorkspaceSession,
};
use backend::events::{AppServerEvent, EventSink, TerminalExit, TerminalOutput};
use shared::codex_core::CodexLoginCancelState;
use shared::process_core::kill_child_process_tree;
use shared::prompts_core::{self, CustomPromptEntry};
use shared::session_manager_core::runtime::{
    active_execution_runtime_for_thread, SessionSourceRuntimePool, SourceRuntimePurpose,
    SourceThreadRuntimeBinding, SourceThreadRuntimeBindings,
};
use shared::session_manager_core::service::SessionManagerRuntime;
use shared::{
    agents_config_core, codex_aux_core, codex_core, files_core, git_core, git_ui_core,
    knowledge_adapter_core, local_usage_core, provider_profiles_core, settings_core,
    workflow_gate_adapter_core, workflow_preflight_core, workspaces_core, worktree_core,
};
use storage::{read_settings, read_workspaces};
use types::{
    AppSettings, GitCommitDiff, GitFileDiff, GitHubIssuesResponse, GitHubPullRequestComment,
    GitHubPullRequestDiff, GitHubPullRequestsResponse, GitLogResponse, LocalUsageSnapshot,
    SessionSource, WorkspaceEntry, WorkspaceInfo, WorkspaceSettings, WorktreeSetupStatus,
};
use workspace_settings::apply_workspace_settings_update;

const DEFAULT_LISTEN_ADDR: &str = "127.0.0.1:4732";
const MAX_IN_FLIGHT_RPC_PER_CONNECTION: usize = 32;
const DAEMON_NAME: &str = "codex-monitor-daemon";

fn spawn_with_client(
    event_sink: DaemonEventSink,
    client_version: String,
    app_settings: &Mutex<AppSettings>,
    entry: WorkspaceEntry,
    default_bin: Option<String>,
    codex_args: Option<String>,
    codex_home: Option<PathBuf>,
) -> impl std::future::Future<Output = Result<Arc<WorkspaceSession>, String>> + '_ {
    async move {
        let settings = app_settings.lock().await.clone();
        spawn_with_client_settings(
            event_sink,
            client_version,
            entry,
            default_bin,
            codex_args,
            codex_home,
            settings,
        )
        .await
    }
}

fn spawn_with_client_settings(
    event_sink: DaemonEventSink,
    client_version: String,
    entry: WorkspaceEntry,
    default_bin: Option<String>,
    codex_args: Option<String>,
    codex_home: Option<PathBuf>,
    settings: AppSettings,
) -> impl std::future::Future<Output = Result<Arc<WorkspaceSession>, String>> {
    async move {
        let runtime_env =
            provider_profiles_core::active_codex_key_runtime(&settings, codex_args).await?;
        spawn_workspace_session(
            entry,
            default_bin,
            runtime_env.codex_args,
            runtime_env.comparison_codex_args,
            runtime_env.env,
            runtime_env.provider_runtime_fingerprint,
            runtime_env.gateway_shutdown,
            codex_home,
            client_version,
            event_sink,
        )
        .await
    }
}

#[derive(Clone)]
struct DaemonEventSink {
    tx: broadcast::Sender<DaemonEvent>,
}

#[derive(Clone)]
enum DaemonEvent {
    AppServer(AppServerEvent),
    #[allow(dead_code)]
    TerminalOutput(TerminalOutput),
    #[allow(dead_code)]
    TerminalExit(TerminalExit),
}

impl EventSink for DaemonEventSink {
    fn emit_app_server_event(&self, event: AppServerEvent) {
        let _ = self.tx.send(DaemonEvent::AppServer(event));
    }

    fn emit_terminal_output(&self, event: TerminalOutput) {
        let _ = self.tx.send(DaemonEvent::TerminalOutput(event));
    }

    fn emit_terminal_exit(&self, event: TerminalExit) {
        let _ = self.tx.send(DaemonEvent::TerminalExit(event));
    }
}

struct DaemonConfig {
    listen: SocketAddr,
    token: Option<String>,
    data_dir: PathBuf,
}

struct DaemonState {
    data_dir: PathBuf,
    workspaces: Mutex<HashMap<String, WorkspaceEntry>>,
    sessions: Mutex<HashMap<String, Arc<WorkspaceSession>>>,
    storage_path: PathBuf,
    settings_path: PathBuf,
    app_settings: Mutex<AppSettings>,
    event_sink: DaemonEventSink,
    codex_login_cancels: Mutex<HashMap<String, CodexLoginCancelState>>,
    session_manager: SessionManagerRuntime,
    session_source_runtimes: SessionSourceRuntimePool,
    source_thread_runtimes: SourceThreadRuntimeBindings,
    daemon_binary_path: Option<String>,
    task_coordination_ledger: tokio::sync::Mutex<
        Option<crate::shared::task_coordination_core::ledger::CoordinationLedger>,
    >,
    turn_execution_summaries:
        tokio::sync::Mutex<crate::shared::turn_execution_summary_core::TurnExecutionSummarySidecar>,
    execution_bindings:
        tokio::sync::Mutex<crate::shared::execution_binding_core::ExecutionBindingSidecar>,
}

#[derive(Serialize, Deserialize)]
struct WorkspaceFileResponse {
    content: String,
    truncated: bool,
}

impl DaemonState {
    async fn turn_execution_summary_scope(
        &self,
        workspace_id: &str,
        thread_id: &str,
    ) -> Result<(String, String), String> {
        let source_id = if let Some(binding) = self
            .source_thread_runtimes
            .get(workspace_id, thread_id)
            .await
        {
            binding.source.id
        } else {
            let settings = self.app_settings.lock().await.clone();
            let codex_home =
                codex_home::resolve_settings_codex_home(&settings).ok_or_else(|| {
                    "Unable to resolve CODEX_HOME for turn execution summary".to_string()
                })?;
            crate::shared::turn_execution_summary_core::source_id_for_codex_home(&codex_home)
        };
        Ok((
            source_id,
            crate::shared::turn_execution_summary_core::runtime_id_for_data_dir(&self.data_dir),
        ))
    }

    async fn source_runtime_for_workspace(
        &self,
        source: &SessionSource,
        entry: WorkspaceEntry,
        default_codex_bin: Option<String>,
        codex_args: Option<String>,
        client_version: String,
    ) -> Result<Arc<WorkspaceSession>, String> {
        self.session_source_runtimes.close_idle().await;
        let workspace_context = entry.path.clone();
        self.session_source_runtimes
            .get_or_spawn_workspace_session_for_source(
                source,
                &workspace_context,
                move |codex_home| {
                    spawn_with_client(
                        self.event_sink.clone(),
                        client_version,
                        &self.app_settings,
                        entry,
                        default_codex_bin,
                        codex_args,
                        Some(codex_home),
                    )
                },
            )
            .await
    }

    async fn history_runtime_for_workspace(
        &self,
        source: SessionSource,
        entry: WorkspaceEntry,
    ) -> Result<Arc<WorkspaceSession>, String> {
        let (default_codex_bin, codex_args) = {
            let settings = self.app_settings.lock().await;
            (
                settings.codex_bin.clone(),
                codex_args::resolve_workspace_codex_args(&entry, None, Some(&settings)),
            )
        };
        self.session_source_runtimes.close_idle().await;
        let workspace_context = entry.path.clone();
        let event_sink = self.event_sink.clone();
        self.session_source_runtimes
            .get_or_spawn_workspace_session_for_source_purpose(
                &source,
                &workspace_context,
                SourceRuntimePurpose::History,
                move |codex_home| {
                    spawn_history_workspace_session(
                        entry,
                        default_codex_bin,
                        codex_args,
                        codex_home,
                        env!("CARGO_PKG_VERSION").to_string(),
                        event_sink,
                    )
                },
            )
            .await
    }

    async fn current_history_source_and_workspace(
        &self,
        workspace_id: &str,
    ) -> Result<(SessionSource, WorkspaceEntry), String> {
        let entry = self
            .workspaces
            .lock()
            .await
            .get(workspace_id)
            .cloned()
            .ok_or_else(|| "Workspace not found".to_string())?;
        let codex_home = {
            let settings = self.app_settings.lock().await;
            codex_home::resolve_settings_codex_home(&settings)
                .ok_or_else(|| "Unable to resolve CODEX_HOME for session history".to_string())?
        };
        let source =
            shared::session_manager_core::sources::session_source_for_codex_home(&codex_home)?;
        Ok((source, entry))
    }

    async fn history_runtime_for_workspace_id(
        &self,
        workspace_id: &str,
    ) -> Result<Arc<WorkspaceSession>, String> {
        let (source, entry) = self
            .current_history_source_and_workspace(workspace_id)
            .await?;
        self.history_runtime_for_workspace(source, entry).await
    }

    async fn history_runtime_for_thread(
        &self,
        workspace_id: &str,
        thread_id: &str,
    ) -> Result<Arc<WorkspaceSession>, String> {
        if let Some(binding) = self
            .source_thread_runtimes
            .get(workspace_id, thread_id)
            .await
        {
            return self
                .history_runtime_for_workspace(binding.source, binding.workspace)
                .await;
        }
        self.history_runtime_for_workspace_id(workspace_id).await
    }

    async fn source_runtime_for_bound_thread(
        &self,
        workspace_id: &str,
        thread_id: &str,
    ) -> Result<Option<Arc<WorkspaceSession>>, String> {
        let Some(binding) = self
            .source_thread_runtimes
            .get(workspace_id, thread_id)
            .await
        else {
            return Ok(None);
        };
        let (default_codex_bin, codex_args) = {
            let settings = self.app_settings.lock().await;
            (
                settings.codex_bin.clone(),
                codex_args::resolve_workspace_codex_args(&binding.workspace, None, Some(&settings)),
            )
        };
        self.session_source_runtimes.close_idle().await;
        let workspace_context = binding.workspace.path.clone();
        let event_sink = self.event_sink.clone();
        let app_settings = &self.app_settings;
        let workspace = binding.workspace.clone();
        let client_version = binding
            .client_version
            .unwrap_or_else(|| env!("CARGO_PKG_VERSION").to_string());
        let (runtime, spawned) = self
            .session_source_runtimes
            .get_or_spawn_workspace_session_for_source_with_status(
                &binding.source,
                &workspace_context,
                move |codex_home| {
                    spawn_with_client(
                        event_sink,
                        client_version,
                        app_settings,
                        workspace,
                        default_codex_bin,
                        codex_args,
                        Some(codex_home),
                    )
                },
            )
            .await?;
        runtime
            .register_workspace_with_path(&binding.workspace.id, Some(&binding.workspace.path))
            .await;
        if spawned {
            codex_core::resume_thread_with_session_core(
                &runtime,
                workspace_id.to_string(),
                thread_id.to_string(),
            )
            .await?;
        }
        Ok(Some(runtime))
    }

    async fn source_runtime_for_bound_workspace(
        &self,
        workspace_id: &str,
    ) -> Result<Option<Arc<WorkspaceSession>>, String> {
        let Some((thread_id, _)) = self
            .source_thread_runtimes
            .unique_for_workspace(workspace_id)
            .await
        else {
            return Ok(None);
        };
        self.source_runtime_for_bound_thread(workspace_id, &thread_id)
            .await
    }

    fn load(config: &DaemonConfig, event_sink: DaemonEventSink) -> Self {
        let storage_path = config.data_dir.join("workspaces.json");
        let settings_path = config.data_dir.join("settings.json");
        let workspaces = read_workspaces(&storage_path).unwrap_or_default();
        let app_settings = read_settings(&settings_path).unwrap_or_default();
        if let Err(error) =
            agents_config_core::remove_legacy_native_markdown_import_flag_for_settings(
                &app_settings,
            )
        {
            eprintln!("DaemonState::load: failed to remove legacy agent import marker: {error}");
        }
        let daemon_binary_path = std::env::current_exe()
            .ok()
            .and_then(|path| path.to_str().map(str::to_string));
        Self {
            data_dir: config.data_dir.clone(),
            workspaces: Mutex::new(workspaces),
            sessions: Mutex::new(HashMap::new()),
            storage_path,
            settings_path,
            app_settings: Mutex::new(app_settings),
            event_sink,
            codex_login_cancels: Mutex::new(HashMap::new()),
            session_manager: SessionManagerRuntime::with_storage_dir(&config.data_dir),
            session_source_runtimes: SessionSourceRuntimePool::for_workspace_sessions(),
            source_thread_runtimes: SourceThreadRuntimeBindings::default(),
            daemon_binary_path,
            task_coordination_ledger: tokio::sync::Mutex::new(Some(Default::default())),
            turn_execution_summaries: tokio::sync::Mutex::new(
                crate::shared::turn_execution_summary_core::TurnExecutionSummarySidecar::for_data_dir(&config.data_dir),
            ),
            execution_bindings: tokio::sync::Mutex::new(
                crate::shared::execution_binding_core::ExecutionBindingSidecar::for_data_dir(&config.data_dir),
            ),
        }
    }

    fn daemon_info(&self) -> Value {
        json!({
            "name": DAEMON_NAME,
            "version": env!("CARGO_PKG_VERSION"),
            "pid": std::process::id(),
            "mode": "tcp",
            "binaryPath": self.daemon_binary_path,
        })
    }

    async fn sync_workspaces_from_storage(&self) {
        let stored = match read_workspaces(&self.storage_path) {
            Ok(stored) => stored,
            Err(err) => {
                eprintln!(
                    "daemon: failed to read workspaces from {}: {err}",
                    self.storage_path.display()
                );
                return;
            }
        };
        let workspace_ids: HashSet<String> = stored.keys().cloned().collect();
        {
            let mut workspaces = self.workspaces.lock().await;
            *workspaces = stored;
        }

        let stale_sessions: Vec<(String, Arc<WorkspaceSession>)> = {
            let mut sessions = self.sessions.lock().await;
            sessions
                .keys()
                .filter(|id| !workspace_ids.contains(*id))
                .cloned()
                .collect::<Vec<_>>()
                .into_iter()
                .filter_map(|workspace_id| {
                    sessions
                        .remove(&workspace_id)
                        .map(|session| (workspace_id, session))
                })
                .collect()
        };

        for (workspace_id, session) in stale_sessions {
            let mut child = session.child.lock().await;
            kill_child_process_tree(&mut child).await;
            eprintln!("daemon: pruned stale session for removed workspace {workspace_id}");
        }
    }

    async fn list_workspaces(&self) -> Vec<WorkspaceInfo> {
        self.sync_workspaces_from_storage().await;
        workspaces_core::list_workspaces_core(&self.workspaces, &self.sessions).await
    }

    async fn is_workspace_path_dir(&self, path: String) -> bool {
        workspaces_core::is_workspace_path_dir_core(&path)
    }

    async fn add_workspace(
        &self,
        path: String,
        client_version: String,
    ) -> Result<WorkspaceInfo, String> {
        let client_version = client_version.clone();
        workspaces_core::add_workspace_core(
            path,
            &self.workspaces,
            &self.sessions,
            &self.app_settings,
            &self.storage_path,
            move |entry, default_bin, codex_args, codex_home| {
                spawn_with_client(
                    self.event_sink.clone(),
                    client_version.clone(),
                    &self.app_settings,
                    entry,
                    default_bin,
                    codex_args,
                    codex_home,
                )
            },
        )
        .await
    }

    async fn add_workspace_from_git_url(
        &self,
        url: String,
        destination_path: String,
        target_folder_name: Option<String>,
        client_version: String,
    ) -> Result<WorkspaceInfo, String> {
        let client_version = client_version.clone();
        workspaces_core::add_workspace_from_git_url_core(
            url,
            destination_path,
            target_folder_name,
            &self.workspaces,
            &self.sessions,
            &self.app_settings,
            &self.storage_path,
            move |entry, default_bin, codex_args, codex_home| {
                spawn_with_client(
                    self.event_sink.clone(),
                    client_version.clone(),
                    &self.app_settings,
                    entry,
                    default_bin,
                    codex_args,
                    codex_home,
                )
            },
        )
        .await
    }

    async fn add_worktree(
        &self,
        parent_id: String,
        branch: String,
        name: Option<String>,
        copy_agents_md: bool,
        client_version: String,
    ) -> Result<WorkspaceInfo, String> {
        let client_version = client_version.clone();
        workspaces_core::add_worktree_core(
            parent_id,
            branch,
            name,
            copy_agents_md,
            &self.data_dir,
            &self.workspaces,
            &self.sessions,
            &self.app_settings,
            &self.storage_path,
            |value| worktree_core::sanitize_worktree_name(value),
            |root, name| worktree_core::unique_worktree_path_strict(root, name),
            |root, branch_name| {
                let root = root.clone();
                let branch_name = branch_name.to_string();
                async move { git_core::git_branch_exists(&root, &branch_name).await }
            },
            Some(|root: &PathBuf, branch_name: &str| {
                let root = root.clone();
                let branch_name = branch_name.to_string();
                async move { git_core::git_find_remote_tracking_branch_local(&root, &branch_name).await }
            }),
            |root, args| {
                workspaces_core::run_git_command_unit(root, args, git_core::run_git_command_owned)
            },
            move |entry, default_bin, codex_args, codex_home| {
                spawn_with_client(
                    self.event_sink.clone(),
                    client_version.clone(),
                    &self.app_settings,
                    entry,
                    default_bin,
                    codex_args,
                    codex_home,
                )
            },
        )
        .await
    }

    async fn worktree_setup_status(
        &self,
        workspace_id: String,
    ) -> Result<WorktreeSetupStatus, String> {
        workspaces_core::worktree_setup_status_core(&self.workspaces, &workspace_id, &self.data_dir)
            .await
    }

    async fn worktree_setup_mark_ran(&self, workspace_id: String) -> Result<(), String> {
        workspaces_core::worktree_setup_mark_ran_core(
            &self.workspaces,
            &workspace_id,
            &self.data_dir,
        )
        .await
    }

    async fn remove_workspace(&self, id: String) -> Result<(), String> {
        workspaces_core::remove_workspace_core(
            id,
            &self.workspaces,
            &self.sessions,
            &self.storage_path,
            |root, args| {
                workspaces_core::run_git_command_unit(root, args, git_core::run_git_command_owned)
            },
            |error| git_core::is_missing_worktree_error(error),
            |path| {
                std::fs::remove_dir_all(path)
                    .map_err(|err| format!("Failed to remove worktree folder: {err}"))
            },
            true,
            true,
        )
        .await
    }

    async fn remove_worktree(&self, id: String) -> Result<(), String> {
        workspaces_core::remove_worktree_core(
            id,
            &self.workspaces,
            &self.sessions,
            &self.storage_path,
            |root, args| {
                workspaces_core::run_git_command_unit(root, args, git_core::run_git_command_owned)
            },
            |error| git_core::is_missing_worktree_error(error),
            |path| {
                std::fs::remove_dir_all(path)
                    .map_err(|err| format!("Failed to remove worktree folder: {err}"))
            },
        )
        .await
    }

    async fn rename_worktree(
        &self,
        id: String,
        branch: String,
        client_version: String,
    ) -> Result<WorkspaceInfo, String> {
        let client_version = client_version.clone();
        workspaces_core::rename_worktree_core(
            id,
            branch,
            &self.data_dir,
            &self.workspaces,
            &self.sessions,
            &self.app_settings,
            &self.storage_path,
            |entry| Ok(PathBuf::from(entry.path.clone())),
            |root, name| {
                let root = root.clone();
                let name = name.to_string();
                async move {
                    git_core::unique_branch_name_live(&root, &name, None)
                        .await
                        .map(|(branch_name, _was_suffixed)| branch_name)
                }
            },
            |value| worktree_core::sanitize_worktree_name(value),
            |root, name, current| {
                worktree_core::unique_worktree_path_for_rename(root, name, current)
            },
            |root, args| {
                workspaces_core::run_git_command_unit(root, args, git_core::run_git_command_owned)
            },
            move |entry, default_bin, codex_args, codex_home| {
                spawn_with_client(
                    self.event_sink.clone(),
                    client_version.clone(),
                    &self.app_settings,
                    entry,
                    default_bin,
                    codex_args,
                    codex_home,
                )
            },
        )
        .await
    }

    async fn rename_worktree_upstream(
        &self,
        id: String,
        old_branch: String,
        new_branch: String,
    ) -> Result<(), String> {
        workspaces_core::rename_worktree_upstream_core(
            id,
            old_branch,
            new_branch,
            &self.workspaces,
            |entry| Ok(PathBuf::from(entry.path.clone())),
            |root, branch_name| {
                let root = root.clone();
                let branch_name = branch_name.to_string();
                async move { git_core::git_branch_exists(&root, &branch_name).await }
            },
            |root, branch_name| {
                let root = root.clone();
                let branch_name = branch_name.to_string();
                async move { git_core::git_find_remote_for_branch_live(&root, &branch_name).await }
            },
            |root, remote| {
                let root = root.clone();
                let remote = remote.to_string();
                async move { git_core::git_remote_exists(&root, &remote).await }
            },
            |root, remote, branch_name| {
                let root = root.clone();
                let remote = remote.to_string();
                let branch_name = branch_name.to_string();
                async move {
                    git_core::git_remote_branch_exists_live(&root, &remote, &branch_name).await
                }
            },
            |root, args| {
                workspaces_core::run_git_command_unit(root, args, git_core::run_git_command_owned)
            },
        )
        .await
    }

    async fn update_workspace_settings(
        &self,
        id: String,
        settings: WorkspaceSettings,
        client_version: String,
    ) -> Result<WorkspaceInfo, String> {
        let client_version = client_version.clone();
        workspaces_core::update_workspace_settings_core(
            id,
            settings,
            &self.workspaces,
            &self.sessions,
            &self.app_settings,
            &self.storage_path,
            |workspaces, workspace_id, next_settings| {
                apply_workspace_settings_update(workspaces, workspace_id, next_settings)
            },
            move |entry, default_bin, codex_args, codex_home| {
                spawn_with_client(
                    self.event_sink.clone(),
                    client_version.clone(),
                    &self.app_settings,
                    entry,
                    default_bin,
                    codex_args,
                    codex_home,
                )
            },
        )
        .await
    }

    async fn connect_workspace(&self, id: String, client_version: String) -> Result<(), String> {
        let client_version = client_version.clone();
        workspaces_core::connect_workspace_core(
            id,
            &self.workspaces,
            &self.sessions,
            &self.app_settings,
            move |entry, default_bin, codex_args, codex_home| {
                spawn_with_client(
                    self.event_sink.clone(),
                    client_version.clone(),
                    &self.app_settings,
                    entry,
                    default_bin,
                    codex_args,
                    codex_home,
                )
            },
        )
        .await
    }

    async fn set_workspace_runtime_codex_args(
        &self,
        workspace_id: String,
        codex_args: Option<String>,
        client_version: String,
    ) -> Result<workspaces_core::WorkspaceRuntimeCodexArgsResult, String> {
        workspaces_core::set_workspace_runtime_codex_args_with_source_runtimes_core(
            workspace_id,
            codex_args,
            &self.workspaces,
            &self.sessions,
            &self.app_settings,
            &self.session_source_runtimes,
            move |entry, default_bin, next_args, codex_home, settings| {
                spawn_with_client_settings(
                    self.event_sink.clone(),
                    client_version.clone(),
                    entry,
                    default_bin,
                    next_args,
                    codex_home,
                    settings,
                )
            },
        )
        .await
    }

    async fn get_app_settings(&self) -> AppSettings {
        settings_core::get_app_settings_core(&self.app_settings, &self.settings_path).await
    }

    async fn update_app_settings(&self, settings: AppSettings) -> Result<AppSettings, String> {
        let updated = settings_core::update_app_settings_core(
            settings,
            &self.app_settings,
            &self.settings_path,
        )
        .await?;
        if let Err(error) =
            agents_config_core::remove_legacy_native_markdown_import_flag_for_settings(&updated)
        {
            eprintln!("DaemonState::update_app_settings: failed to remove legacy agent import marker: {error}");
        }
        Ok(updated)
    }

    async fn list_session_sources(&self) -> Vec<types::SessionSource> {
        settings_core::get_app_settings_core(&self.app_settings, &self.settings_path).await;
        shared::session_manager_core::service::list_session_sources_core(&self.app_settings).await
    }

    async fn update_session_source(
        &self,
        request: types::SessionSourceUpdateRequest,
    ) -> Result<Vec<types::SessionSource>, String> {
        shared::session_manager_core::service::update_session_source_core(
            request,
            &self.app_settings,
            &self.settings_path,
        )
        .await
    }

    async fn scan_managed_sessions(
        &self,
        request: types::SessionScanRequest,
    ) -> Result<types::SessionScanSummary, String> {
        settings_core::get_app_settings_core(&self.app_settings, &self.settings_path).await;
        shared::session_manager_core::service::scan_managed_sessions_core(
            request,
            &self.app_settings,
            &self.session_manager,
        )
        .await
    }

    async fn verify_session_threads(
        &self,
        request: types::VerifySessionThreadsRequest,
    ) -> Result<types::VerifySessionThreadsResponse, String> {
        settings_core::get_app_settings_core(&self.app_settings, &self.settings_path).await;
        shared::session_manager_core::service::verify_session_threads_core(
            request,
            &self.app_settings,
            &self.session_manager,
        )
        .await
    }

    async fn fetch_managed_sessions_page(
        &self,
        request: types::ManagedSessionPageRequest,
    ) -> Result<types::ManagedSessionPage, String> {
        shared::session_manager_core::service::fetch_managed_sessions_page_core(
            request,
            &self.session_manager,
        )
        .await
    }

    async fn fetch_managed_session_preview(
        &self,
        request: types::ManagedSessionPreviewRequest,
    ) -> Result<types::ManagedSessionPreviewResponse, String> {
        settings_core::get_app_settings_core(&self.app_settings, &self.settings_path).await;
        shared::session_manager_core::service::fetch_managed_session_preview_core(
            request,
            &self.app_settings,
            &self.session_manager,
        )
        .await
    }

    async fn search_managed_sessions(
        &self,
        request: types::SessionSearchRequest,
    ) -> Result<types::SessionSearchProgress, String> {
        shared::session_manager_core::service::search_managed_sessions_core(
            request,
            &self.session_manager,
        )
        .await
    }
    async fn fetch_session_search_results(
        &self,
        request_id: String,
    ) -> Result<types::SessionSearchResponse, String> {
        shared::session_manager_core::service::fetch_session_search_results_core(
            request_id,
            &self.session_manager,
        )
    }
    async fn cancel_session_task(&self, request_id: String) -> Result<(), String> {
        shared::session_manager_core::service::cancel_session_task_core(
            request_id,
            &self.session_manager,
        )
        .await
    }

    async fn resume_managed_session(
        &self,
        request: types::ResumeManagedSessionRequest,
        client_version: String,
    ) -> Result<types::ResumeManagedSessionResponse, String> {
        settings_core::get_app_settings_core(&self.app_settings, &self.settings_path).await;
        let (source, managed) =
            shared::session_manager_core::service::resolve_managed_session_core(
                &request.source_id,
                &request.thread_id,
                &self.app_settings,
                &self.session_manager,
            )
            .await?;
        let cwd = managed
            .cwd
            .as_deref()
            .ok_or_else(|| "Managed session has no project path".to_string())?;
        let normalized = workspaces_core::normalize_workspace_path_input(cwd);
        let path = workspaces_core::workspace_path_to_string(&normalized);
        let existing = self
            .workspaces
            .lock()
            .await
            .values()
            .find(|entry| entry.path.eq_ignore_ascii_case(&path))
            .cloned();
        let is_new = existing.is_none();
        let entry = existing.unwrap_or_else(|| WorkspaceEntry {
            id: uuid::Uuid::new_v4().to_string(),
            name: normalized
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("Workspace")
                .to_string(),
            path,
            kind: types::WorkspaceKind::Main,
            parent_id: None,
            worktree: None,
            settings: WorkspaceSettings::default(),
        });
        let (default_codex_bin, codex_args) = {
            let settings = self.app_settings.lock().await;
            (
                settings.codex_bin.clone(),
                codex_args::resolve_workspace_codex_args(&entry, None, Some(&settings)),
            )
        };
        let runtime = self
            .source_runtime_for_workspace(
                &source,
                entry.clone(),
                default_codex_bin,
                codex_args,
                client_version.clone(),
            )
            .await?;
        runtime
            .register_workspace_with_path(&entry.id, Some(&entry.path))
            .await;
        codex_core::resume_thread_with_session_core(
            &runtime,
            entry.id.clone(),
            managed.thread_id.clone(),
        )
        .await?;
        self.source_thread_runtimes
            .bind(
                &entry.id,
                &managed.thread_id,
                SourceThreadRuntimeBinding {
                    source: source.clone(),
                    workspace: entry.clone(),
                    client_version: Some(client_version),
                },
            )
            .await;
        if is_new {
            let mut workspaces = self.workspaces.lock().await;
            workspaces.insert(entry.id.clone(), entry.clone());
            let list = workspaces.values().cloned().collect::<Vec<_>>();
            if let Err(error) = storage::write_workspaces(&self.storage_path, &list) {
                workspaces.remove(&entry.id);
                self.source_thread_runtimes
                    .remove(&entry.id, &managed.thread_id)
                    .await;
                return Err(error);
            }
        }
        Ok(types::ResumeManagedSessionResponse {
            workspace: WorkspaceInfo {
                id: entry.id,
                name: entry.name,
                path: entry.path,
                connected: true,
                kind: entry.kind,
                parent_id: entry.parent_id,
                worktree: entry.worktree,
                settings: entry.settings,
            },
            thread_id: managed.thread_id,
            source_id: source.id,
            source_name: source.name,
        })
    }

    async fn archive_managed_sessions(
        &self,
        request: types::ArchiveManagedSessionsRequest,
        client_version: String,
    ) -> Result<types::ArchiveManagedSessionsResponse, String> {
        settings_core::get_app_settings_core(&self.app_settings, &self.settings_path).await;
        shared::session_manager_core::service::archive_managed_sessions_core(
            request,
            &self.app_settings,
            &self.session_manager,
            |source, managed| {
                let client_version = client_version.clone();
                async move {
                    let workspace_context = managed
                        .cwd
                        .as_deref()
                        .filter(|cwd| std::path::Path::new(cwd).is_dir())
                        .unwrap_or(&source.codex_home_path);
                    let normalized =
                        workspaces_core::normalize_workspace_path_input(workspace_context);
                    if !normalized.is_dir() {
                        return Err("Managed session project path is unavailable".to_string());
                    }
                    let path = workspaces_core::workspace_path_to_string(&normalized);
                    let entry = self
                        .workspaces
                        .lock()
                        .await
                        .values()
                        .find(|entry| entry.path.eq_ignore_ascii_case(&path))
                        .cloned()
                        .unwrap_or_else(|| WorkspaceEntry {
                            id: uuid::Uuid::new_v4().to_string(),
                            name: normalized
                                .file_name()
                                .and_then(|name| name.to_str())
                                .unwrap_or("Workspace")
                                .to_string(),
                            path,
                            kind: types::WorkspaceKind::Main,
                            parent_id: None,
                            worktree: None,
                            settings: WorkspaceSettings::default(),
                        });
                    let (default_codex_bin, codex_args) = {
                        let settings = self.app_settings.lock().await;
                        (
                            settings.codex_bin.clone(),
                            codex_args::resolve_workspace_codex_args(&entry, None, Some(&settings)),
                        )
                    };
                    let runtime = self
                        .source_runtime_for_workspace(
                            &source,
                            entry.clone(),
                            default_codex_bin,
                            codex_args,
                            client_version,
                        )
                        .await?;
                    runtime
                        .register_workspace_with_path(&entry.id, Some(&entry.path))
                        .await;
                    runtime
                        .send_request_for_workspace(
                            &entry.id,
                            "thread/archive",
                            json!({ "threadId": managed.thread_id }),
                        )
                        .await?;
                    self.source_thread_runtimes
                        .remove_for_source_thread(&source.id, &managed.thread_id)
                        .await;
                    Ok(())
                }
            },
        )
        .await
    }

    async fn permanently_delete_managed_session(
        &self,
        request: types::PermanentlyDeleteManagedSessionRequest,
    ) -> Result<types::PermanentlyDeleteManagedSessionResponse, String> {
        settings_core::get_app_settings_core(&self.app_settings, &self.settings_path).await;
        shared::session_manager_core::service::permanently_delete_managed_session_core(
            request,
            &self.app_settings,
            &self.session_manager,
        )
        .await
    }

    async fn preview_managed_session_cleanup(
        &self,
        request: types::ManagedSessionCleanupRequest,
    ) -> Result<types::ManagedSessionCleanupPreview, String> {
        settings_core::get_app_settings_core(&self.app_settings, &self.settings_path).await;
        shared::session_manager_core::service::preview_managed_session_cleanup_core(
            request,
            &self.app_settings,
            &self.session_manager,
        )
        .await
    }

    async fn cleanup_managed_sessions_now(
        &self,
        request: types::ManagedSessionCleanupRequest,
    ) -> Result<types::ManagedSessionCleanupResponse, String> {
        settings_core::get_app_settings_core(&self.app_settings, &self.settings_path).await;
        shared::session_manager_core::service::cleanup_managed_sessions_now_core(
            request,
            &self.app_settings,
            &self.session_manager,
        )
        .await
    }

    async fn run_managed_session_cleanup_scheduler(
        &self,
        request: types::ManagedSessionCleanupSchedulerRequest,
    ) -> Result<types::ManagedSessionCleanupSchedulerResponse, String> {
        settings_core::get_app_settings_core(&self.app_settings, &self.settings_path).await;
        let sessions = self
            .sessions
            .lock()
            .await
            .values()
            .cloned()
            .collect::<Vec<_>>();
        let mut running_thread_ids = Vec::new();
        for session in sessions {
            running_thread_ids.extend(session.active_turns.lock().await.keys().cloned());
        }
        shared::session_manager_core::service::run_managed_session_cleanup_scheduler_core(
            request,
            running_thread_ids,
            &self.app_settings,
            &self.session_manager,
        )
        .await
    }

    async fn prepare_managed_session_derivation(
        &self,
        request: types::PrepareManagedSessionDerivationRequest,
    ) -> Result<types::ManagedSessionDerivationPreview, String> {
        settings_core::get_app_settings_core(&self.app_settings, &self.settings_path).await;
        shared::session_manager_core::service::prepare_managed_session_derivation_core(
            request,
            &self.app_settings,
            &self.session_manager,
        )
        .await
    }

    async fn set_codex_feature_flag(
        &self,
        feature_key: String,
        enabled: bool,
    ) -> Result<(), String> {
        let settings = self.app_settings.lock().await.clone();
        codex_config::write_feature_enabled(&settings, feature_key.as_str(), enabled)
    }

    async fn get_agents_settings(&self) -> Result<agents_config_core::AgentsSettingsDto, String> {
        let settings = self.app_settings.lock().await.clone();
        agents_config_core::get_agents_settings_core(settings.native_agent_markdown_import_enabled)
    }

    async fn set_agents_core_settings(
        &self,
        input: agents_config_core::SetAgentsCoreInput,
    ) -> Result<agents_config_core::AgentsSettingsDto, String> {
        let settings = self.app_settings.lock().await.clone();
        agents_config_core::set_agents_core_settings_core(
            input,
            settings.native_agent_markdown_import_enabled,
        )
    }

    async fn create_agent(
        &self,
        input: agents_config_core::CreateAgentInput,
    ) -> Result<agents_config_core::AgentsSettingsDto, String> {
        let settings = self.app_settings.lock().await.clone();
        agents_config_core::create_agent_core(input, settings.native_agent_markdown_import_enabled)
    }

    async fn update_agent(
        &self,
        input: agents_config_core::UpdateAgentInput,
    ) -> Result<agents_config_core::AgentsSettingsDto, String> {
        let settings = self.app_settings.lock().await.clone();
        agents_config_core::update_agent_core(input, settings.native_agent_markdown_import_enabled)
    }

    async fn delete_agent(
        &self,
        input: agents_config_core::DeleteAgentInput,
    ) -> Result<agents_config_core::AgentsSettingsDto, String> {
        let settings = self.app_settings.lock().await.clone();
        agents_config_core::delete_agent_core(input, settings.native_agent_markdown_import_enabled)
    }

    async fn read_agent_config_toml(&self, agent_name: String) -> Result<String, String> {
        agents_config_core::read_agent_config_toml_core(agent_name.as_str())
    }

    async fn write_agent_config_toml(
        &self,
        agent_name: String,
        content: String,
    ) -> Result<(), String> {
        agents_config_core::write_agent_config_toml_core(agent_name.as_str(), content.as_str())
    }

    async fn list_workspace_files(&self, workspace_id: String) -> Result<Vec<String>, String> {
        workspaces_core::list_workspace_files_core(&self.workspaces, &workspace_id).await
    }

    async fn read_workspace_file(
        &self,
        workspace_id: String,
        path: String,
    ) -> Result<WorkspaceFileResponse, String> {
        workspaces_core::read_workspace_file_core(
            &self.workspaces,
            &workspace_id,
            &path,
            |root, rel_path| read_workspace_file_inner(root, rel_path),
        )
        .await
    }

    async fn file_read(
        &self,
        scope: file_policy::FileScope,
        kind: file_policy::FileKind,
        workspace_id: Option<String>,
    ) -> Result<file_io::TextFileResponse, String> {
        files_core::file_read_core(
            &self.workspaces,
            &self.app_settings,
            scope,
            kind,
            workspace_id,
        )
        .await
    }

    async fn file_write(
        &self,
        scope: file_policy::FileScope,
        kind: file_policy::FileKind,
        workspace_id: Option<String>,
        content: String,
    ) -> Result<(), String> {
        files_core::file_write_core(
            &self.workspaces,
            &self.app_settings,
            scope,
            kind,
            workspace_id,
            content,
        )
        .await
    }

    async fn start_thread(
        &self,
        workspace_id: String,
        token_efficiency_mode: Option<String>,
    ) -> Result<Value, String> {
        codex_core::start_thread_core(
            &self.sessions,
            &self.workspaces,
            workspace_id,
            token_efficiency_mode,
        )
        .await
    }

    async fn resume_thread(
        &self,
        workspace_id: String,
        thread_id: String,
    ) -> Result<Value, String> {
        if let Some(session) = self
            .source_runtime_for_bound_thread(&workspace_id, &thread_id)
            .await?
        {
            return codex_core::resume_thread_with_session_core(&session, workspace_id, thread_id)
                .await;
        }
        codex_core::resume_thread_core(&self.sessions, workspace_id, thread_id).await
    }

    async fn get_thread_token_usage(
        &self,
        workspace_id: String,
        thread_id: String,
    ) -> Result<Value, String> {
        Ok(
            local_usage_core::thread_token_usage_core(&self.workspaces, workspace_id, thread_id)
                .await
                .unwrap_or(Value::Null),
        )
    }

    async fn read_thread(&self, workspace_id: String, thread_id: String) -> Result<Value, String> {
        let active_session = active_execution_runtime_for_thread(
            &self.sessions,
            &self.session_source_runtimes,
            &self.source_thread_runtimes,
            &workspace_id,
            &thread_id,
        )
        .await;
        if let Some(session) = active_session {
            let response =
                codex_core::read_thread_with_session_core(&session, workspace_id, thread_id)
                    .await?;
            return Ok(codex_core::annotate_thread_read_authority(
                response,
                "execution",
            ));
        }

        let session = self
            .history_runtime_for_thread(&workspace_id, &thread_id)
            .await?;
        let response =
            codex_core::read_thread_with_session_core(&session, workspace_id, thread_id).await?;
        Ok(codex_core::annotate_thread_read_authority(
            response,
            "history-no-active-execution",
        ))
    }

    async fn turn_execution_summary_get(
        &self,
        mut query: crate::shared::turn_execution_summary_core::TurnExecutionSummaryQuery,
    ) -> Result<Vec<crate::shared::turn_execution_summary_core::TurnExecutionSummary>, String> {
        let (source_id, runtime_id) = self
            .turn_execution_summary_scope(&query.workspace_id, &query.thread_id)
            .await?;
        query.source_id = source_id;
        query.runtime_id = runtime_id;
        self.turn_execution_summaries.lock().await.get(&query)
    }

    async fn turn_execution_summary_upsert(
        &self,
        mut input: crate::shared::turn_execution_summary_core::TurnExecutionSummaryUpsert,
    ) -> Result<crate::shared::turn_execution_summary_core::TurnExecutionSummary, String> {
        let (source_id, runtime_id) = self
            .turn_execution_summary_scope(&input.summary.workspace_id, &input.summary.thread_id)
            .await?;
        input.source_id = source_id;
        input.runtime_id = runtime_id;
        self.turn_execution_summaries.lock().await.upsert(input)
    }

    async fn execution_binding_register(
        &self,
        mut input: crate::shared::execution_binding_core::ExecutionBindingRegisterRequest,
    ) -> Result<crate::shared::execution_binding_core::ExecutionBindingRecord, String> {
        let (source_id, runtime_id) = self
            .turn_execution_summary_scope(&input.workspace_id, &input.parent_thread_id)
            .await?;
        input.source_id = source_id;
        input.runtime_id = runtime_id;
        self.execution_bindings.lock().await.register(input)
    }

    async fn execution_binding_observe(
        &self,
        mut input: crate::shared::execution_binding_core::ExecutionBindingObserveRequest,
    ) -> Result<crate::shared::execution_binding_core::ExecutionBindingRecord, String> {
        let (source_id, runtime_id) = self
            .turn_execution_summary_scope(&input.workspace_id, &input.parent_thread_id)
            .await?;
        input.source_id = source_id;
        input.runtime_id = runtime_id;
        self.execution_bindings.lock().await.observe(input)
    }

    async fn execution_binding_list(
        &self,
        mut query: crate::shared::execution_binding_core::ExecutionBindingQuery,
    ) -> Result<Vec<crate::shared::execution_binding_core::ExecutionBindingRecord>, String> {
        let (source_id, runtime_id) = self
            .turn_execution_summary_scope(&query.workspace_id, &query.parent_thread_id)
            .await?;
        query.source_id = source_id;
        query.runtime_id = runtime_id;
        self.execution_bindings.lock().await.list(&query)
    }

    async fn thread_live_subscribe(
        &self,
        workspace_id: String,
        thread_id: String,
    ) -> Result<Value, String> {
        if self
            .source_runtime_for_bound_thread(&workspace_id, &thread_id)
            .await?
            .is_none()
        {
            codex_core::thread_live_subscribe_core(
                &self.sessions,
                workspace_id.clone(),
                thread_id.clone(),
            )
            .await?;
        }
        let subscription_id = format!("{}:{}", workspace_id, thread_id);
        self.event_sink.emit_app_server_event(AppServerEvent {
            workspace_id: workspace_id.clone(),
            message: json!({
                "method": "thread/live_attached",
                "params": {
                    "workspaceId": workspace_id,
                    "threadId": thread_id,
                    "subscriptionId": subscription_id,
                }
            }),
        });
        Ok(json!({
            "subscriptionId": subscription_id,
            "state": "live",
        }))
    }

    async fn thread_live_unsubscribe(
        &self,
        workspace_id: String,
        thread_id: String,
    ) -> Result<Value, String> {
        if self
            .source_runtime_for_bound_thread(&workspace_id, &thread_id)
            .await?
            .is_none()
        {
            codex_core::thread_live_unsubscribe_core(
                &self.sessions,
                workspace_id.clone(),
                thread_id.clone(),
            )
            .await?;
        }
        self.event_sink.emit_app_server_event(AppServerEvent {
            workspace_id: workspace_id.clone(),
            message: json!({
                "method": "thread/live_detached",
                "params": {
                    "workspaceId": workspace_id,
                    "threadId": thread_id,
                    "reason": "manual",
                }
            }),
        });
        Ok(json!({ "ok": true }))
    }

    async fn fork_thread(&self, workspace_id: String, thread_id: String) -> Result<Value, String> {
        if let Some(session) = self
            .source_runtime_for_bound_thread(&workspace_id, &thread_id)
            .await?
        {
            return session
                .send_request_for_workspace(
                    &workspace_id,
                    "thread/fork",
                    json!({ "threadId": thread_id }),
                )
                .await;
        }
        codex_core::fork_thread_core(&self.sessions, workspace_id, thread_id).await
    }

    async fn rollback_thread(
        &self,
        workspace_id: String,
        thread_id: String,
        num_turns: u32,
    ) -> Result<Value, String> {
        if let Some(session) = self
            .source_runtime_for_bound_thread(&workspace_id, &thread_id)
            .await?
        {
            return session
                .send_request_for_workspace(
                    &workspace_id,
                    "thread/rollback",
                    json!({ "threadId": thread_id, "numTurns": num_turns }),
                )
                .await;
        }
        codex_core::rollback_thread_core(&self.sessions, workspace_id, thread_id, num_turns).await
    }

    async fn list_threads(
        &self,
        workspace_id: String,
        cursor: Option<String>,
        limit: Option<u32>,
        sort_key: Option<String>,
        archived: Option<bool>,
    ) -> Result<Value, String> {
        let session = self.history_runtime_for_workspace_id(&workspace_id).await?;
        codex_core::list_threads_with_session_core(
            &session,
            workspace_id,
            cursor,
            limit,
            sort_key,
            archived,
        )
        .await
    }

    async fn list_mcp_server_status(
        &self,
        workspace_id: String,
        cursor: Option<String>,
        limit: Option<u32>,
    ) -> Result<Value, String> {
        codex_core::list_mcp_server_status_core(&self.sessions, workspace_id, cursor, limit).await
    }

    async fn archive_thread(
        &self,
        workspace_id: String,
        thread_id: String,
    ) -> Result<Value, String> {
        if let Some(session) = self
            .source_runtime_for_bound_thread(&workspace_id, &thread_id)
            .await?
        {
            let result = session
                .send_request_for_workspace(
                    &workspace_id,
                    "thread/archive",
                    json!({ "threadId": thread_id }),
                )
                .await;
            if result.is_ok() {
                self.source_thread_runtimes
                    .remove(&workspace_id, &thread_id)
                    .await;
            }
            return result;
        }
        codex_core::archive_thread_core(&self.sessions, workspace_id, thread_id).await
    }

    async fn compact_thread(
        &self,
        workspace_id: String,
        thread_id: String,
    ) -> Result<Value, String> {
        if let Some(session) = self
            .source_runtime_for_bound_thread(&workspace_id, &thread_id)
            .await?
        {
            return session
                .send_request_for_workspace(
                    &workspace_id,
                    "thread/compact/start",
                    json!({ "threadId": thread_id }),
                )
                .await;
        }
        codex_core::compact_thread_core(&self.sessions, workspace_id, thread_id).await
    }

    async fn set_thread_name(
        &self,
        workspace_id: String,
        thread_id: String,
        name: String,
    ) -> Result<Value, String> {
        if let Some(session) = self
            .source_runtime_for_bound_thread(&workspace_id, &thread_id)
            .await?
        {
            return session
                .send_request_for_workspace(
                    &workspace_id,
                    "thread/name/set",
                    json!({ "threadId": thread_id, "name": name }),
                )
                .await;
        }
        codex_core::set_thread_name_core(&self.sessions, workspace_id, thread_id, name).await
    }

    async fn send_user_message(
        &self,
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
        let _runtime_switch_guard = workspaces_core::provider_runtime_switch_gate().read().await;
        if let Some(session) = self
            .source_runtime_for_bound_thread(&workspace_id, &thread_id)
            .await?
        {
            return codex_core::send_user_message_with_session_core(
                &session,
                &self.workspaces,
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
            .await;
        }
        codex_core::send_user_message_core(
            &self.sessions,
            &self.workspaces,
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

    async fn turn_steer(
        &self,
        workspace_id: String,
        thread_id: String,
        turn_id: String,
        text: String,
        images: Option<Vec<String>>,
        app_mentions: Option<Vec<Value>>,
        additional_context: Option<Value>,
    ) -> Result<Value, String> {
        if let Some(session) = self
            .source_runtime_for_bound_thread(&workspace_id, &thread_id)
            .await?
        {
            return codex_core::turn_steer_with_session_core(
                &session,
                workspace_id,
                thread_id,
                turn_id,
                text,
                images,
                app_mentions,
                additional_context,
            )
            .await;
        }
        codex_core::turn_steer_core(
            &self.sessions,
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

    async fn turn_interrupt(
        &self,
        workspace_id: String,
        thread_id: String,
        turn_id: String,
    ) -> Result<Value, String> {
        if let Some(session) = self
            .source_runtime_for_bound_thread(&workspace_id, &thread_id)
            .await?
        {
            return codex_core::turn_interrupt_with_session_core(
                &session,
                workspace_id,
                thread_id,
                turn_id,
            )
            .await;
        }
        codex_core::turn_interrupt_core(&self.sessions, workspace_id, thread_id, turn_id).await
    }

    async fn start_review(
        &self,
        workspace_id: String,
        thread_id: String,
        target: Value,
        delivery: Option<String>,
    ) -> Result<Value, String> {
        if let Some(session) = self
            .source_runtime_for_bound_thread(&workspace_id, &thread_id)
            .await?
        {
            let mut params = serde_json::Map::new();
            params.insert("threadId".to_string(), json!(thread_id));
            params.insert("target".to_string(), target);
            params.insert("delivery".to_string(), json!(delivery));
            return session
                .send_request_for_workspace(&workspace_id, "review/start", Value::Object(params))
                .await;
        }
        codex_core::start_review_core(&self.sessions, workspace_id, thread_id, target, delivery)
            .await
    }

    async fn model_list(&self, workspace_id: String) -> Result<Value, String> {
        codex_core::model_list_core(&self.sessions, workspace_id).await
    }

    async fn experimental_feature_list(
        &self,
        workspace_id: String,
        cursor: Option<String>,
        limit: Option<u32>,
    ) -> Result<Value, String> {
        codex_core::experimental_feature_list_core(&self.sessions, workspace_id, cursor, limit)
            .await
    }

    async fn collaboration_mode_list(&self, workspace_id: String) -> Result<Value, String> {
        codex_core::collaboration_mode_list_core(&self.sessions, workspace_id).await
    }

    async fn account_rate_limits(&self, workspace_id: String) -> Result<Value, String> {
        codex_core::account_rate_limits_core(&self.sessions, workspace_id).await
    }

    async fn account_read(&self, workspace_id: String) -> Result<Value, String> {
        codex_core::account_read_core(&self.sessions, &self.workspaces, workspace_id).await
    }

    async fn codex_login(&self, workspace_id: String) -> Result<Value, String> {
        codex_core::codex_login_core(&self.sessions, &self.codex_login_cancels, workspace_id).await
    }

    async fn codex_login_cancel(&self, workspace_id: String) -> Result<Value, String> {
        codex_core::codex_login_cancel_core(&self.sessions, &self.codex_login_cancels, workspace_id)
            .await
    }

    async fn skills_list(&self, workspace_id: String) -> Result<Value, String> {
        codex_core::skills_list_core(&self.sessions, &self.workspaces, workspace_id).await
    }

    async fn workflow_preflight_preview(
        &self,
        workspace_id: String,
        task: String,
        mode: Option<String>,
        provider_kind: String,
        model: Option<String>,
        workflow_id: Option<String>,
    ) -> Result<Value, String> {
        workflow_preflight_core::workflow_preflight_preview_core(
            &self.workspaces,
            workspace_id,
            task,
            mode,
            provider_kind,
            model,
            workflow_id,
        )
        .await
    }

    async fn workflow_gate_status(
        &self,
        workspace_id: String,
        workflow_id: String,
    ) -> Result<Value, String> {
        workflow_gate_adapter_core::workflow_gate_status_core(
            &self.workspaces,
            workspace_id,
            workflow_id,
        )
        .await
    }

    async fn knowledge_status(&self) -> Result<Value, String> {
        knowledge_adapter_core::knowledge_status_core().await
    }

    async fn knowledge_query(
        &self,
        query: String,
        project_id: Option<String>,
    ) -> Result<Value, String> {
        knowledge_adapter_core::knowledge_query_core(query, project_id).await
    }

    async fn knowledge_intake_capture(
        &self,
        input: knowledge_adapter_core::KnowledgeIntakeCaptureRequest,
    ) -> Result<Value, String> {
        knowledge_adapter_core::knowledge_intake_capture_core(input).await
    }

    async fn knowledge_task_init(
        &self,
        input: knowledge_adapter_core::KnowledgeTaskInitRequest,
    ) -> Result<Value, String> {
        knowledge_adapter_core::knowledge_task_init_core(input).await
    }

    async fn apps_list(
        &self,
        workspace_id: String,
        cursor: Option<String>,
        limit: Option<u32>,
        thread_id: Option<String>,
    ) -> Result<Value, String> {
        codex_core::apps_list_core(&self.sessions, workspace_id, cursor, limit, thread_id).await
    }

    async fn respond_to_server_request(
        &self,
        workspace_id: String,
        request_id: Value,
        result: Value,
    ) -> Result<Value, String> {
        if let Some(session) = self
            .source_runtime_for_bound_workspace(&workspace_id)
            .await?
        {
            session.send_response(request_id, result).await?;
            return Ok(json!({ "ok": true }));
        }
        codex_core::respond_to_server_request_core(
            &self.sessions,
            workspace_id,
            request_id,
            result,
        )
        .await?;
        Ok(json!({ "ok": true }))
    }

    async fn remember_approval_rule(
        &self,
        workspace_id: String,
        command: Vec<String>,
    ) -> Result<Value, String> {
        codex_core::remember_approval_rule_core(&self.workspaces, workspace_id, command).await
    }

    async fn get_config_model(&self, workspace_id: String) -> Result<Value, String> {
        codex_core::get_config_model_core(&self.workspaces, workspace_id).await
    }

    async fn get_provider_status(&self, workspace_id: String) -> Result<Value, String> {
        let settings = self.app_settings.lock().await.clone();
        codex_core::get_provider_status_core(&self.workspaces, &settings, workspace_id).await
    }

    async fn workspace_third_party_key_usage(
        &self,
        workspace_id: String,
        timezone: Option<String>,
    ) -> Result<Value, String> {
        let settings = self.app_settings.lock().await.clone();
        codex_core::workspace_third_party_key_usage_core(
            &self.workspaces,
            &settings,
            workspace_id,
            timezone,
        )
        .await
    }

    async fn add_clone(
        &self,
        source_workspace_id: String,
        copies_folder: String,
        copy_name: String,
        client_version: String,
    ) -> Result<WorkspaceInfo, String> {
        workspaces_core::add_clone_core(
            source_workspace_id,
            copy_name,
            copies_folder,
            &self.workspaces,
            &self.sessions,
            &self.app_settings,
            &self.storage_path,
            |entry, default_bin, codex_args, codex_home| {
                spawn_with_client(
                    self.event_sink.clone(),
                    client_version.clone(),
                    &self.app_settings,
                    entry,
                    default_bin,
                    codex_args,
                    codex_home,
                )
            },
        )
        .await
    }

    async fn apply_worktree_changes(&self, workspace_id: String) -> Result<(), String> {
        workspaces_core::apply_worktree_changes_core(&self.workspaces, workspace_id).await
    }

    async fn open_workspace_in(
        &self,
        path: String,
        app: Option<String>,
        args: Vec<String>,
        command: Option<String>,
        line: Option<u32>,
        column: Option<u32>,
    ) -> Result<(), String> {
        workspaces_core::open_workspace_in_core(path, app, args, command, line, column).await
    }

    async fn get_open_app_icon(&self, app_name: String) -> Result<Option<String>, String> {
        #[cfg(target_os = "macos")]
        {
            return workspaces_core::get_open_app_icon_core(app_name, |name| {
                workspace_macos::get_open_app_icon_inner(name)
            })
            .await;
        }

        #[cfg(not(target_os = "macos"))]
        {
            workspaces_core::get_open_app_icon_core(app_name, |_name| None).await
        }
    }

    async fn get_git_status(&self, workspace_id: String) -> Result<Value, String> {
        git_ui_core::get_git_status_core(&self.workspaces, workspace_id).await
    }

    async fn init_git_repo(
        &self,
        workspace_id: String,
        branch: String,
        force: bool,
    ) -> Result<Value, String> {
        git_ui_core::init_git_repo_core(&self.workspaces, workspace_id, branch, force).await
    }

    async fn create_github_repo(
        &self,
        workspace_id: String,
        repo: String,
        visibility: String,
        branch: Option<String>,
    ) -> Result<Value, String> {
        git_ui_core::create_github_repo_core(
            &self.workspaces,
            workspace_id,
            repo,
            visibility,
            branch,
        )
        .await
    }

    async fn list_git_roots(
        &self,
        workspace_id: String,
        depth: Option<usize>,
    ) -> Result<Vec<String>, String> {
        git_ui_core::list_git_roots_core(&self.workspaces, workspace_id, depth).await
    }

    async fn get_git_diffs(&self, workspace_id: String) -> Result<Vec<GitFileDiff>, String> {
        git_ui_core::get_git_diffs_core(&self.workspaces, &self.app_settings, workspace_id).await
    }

    async fn get_git_log(
        &self,
        workspace_id: String,
        limit: Option<usize>,
    ) -> Result<GitLogResponse, String> {
        git_ui_core::get_git_log_core(&self.workspaces, workspace_id, limit).await
    }

    async fn get_git_commit_diff(
        &self,
        workspace_id: String,
        sha: String,
    ) -> Result<Vec<GitCommitDiff>, String> {
        git_ui_core::get_git_commit_diff_core(
            &self.workspaces,
            &self.app_settings,
            workspace_id,
            sha,
        )
        .await
    }

    async fn get_git_remote(&self, workspace_id: String) -> Result<Option<String>, String> {
        git_ui_core::get_git_remote_core(&self.workspaces, workspace_id).await
    }

    async fn stage_git_file(&self, workspace_id: String, path: String) -> Result<(), String> {
        git_ui_core::stage_git_file_core(&self.workspaces, workspace_id, path).await
    }

    async fn stage_git_all(&self, workspace_id: String) -> Result<(), String> {
        git_ui_core::stage_git_all_core(&self.workspaces, workspace_id).await
    }

    async fn unstage_git_file(&self, workspace_id: String, path: String) -> Result<(), String> {
        git_ui_core::unstage_git_file_core(&self.workspaces, workspace_id, path).await
    }

    async fn revert_git_file(&self, workspace_id: String, path: String) -> Result<(), String> {
        git_ui_core::revert_git_file_core(&self.workspaces, workspace_id, path).await
    }

    async fn revert_git_all(&self, workspace_id: String) -> Result<(), String> {
        git_ui_core::revert_git_all_core(&self.workspaces, workspace_id).await
    }

    async fn commit_git(&self, workspace_id: String, message: String) -> Result<(), String> {
        git_ui_core::commit_git_core(&self.workspaces, workspace_id, message).await
    }

    async fn push_git(&self, workspace_id: String) -> Result<(), String> {
        git_ui_core::push_git_core(&self.workspaces, workspace_id).await
    }

    async fn pull_git(&self, workspace_id: String) -> Result<(), String> {
        git_ui_core::pull_git_core(&self.workspaces, workspace_id).await
    }

    async fn fetch_git(&self, workspace_id: String) -> Result<(), String> {
        git_ui_core::fetch_git_core(&self.workspaces, workspace_id).await
    }

    async fn sync_git(&self, workspace_id: String) -> Result<(), String> {
        git_ui_core::sync_git_core(&self.workspaces, workspace_id).await
    }

    async fn get_github_issues(
        &self,
        workspace_id: String,
    ) -> Result<GitHubIssuesResponse, String> {
        git_ui_core::get_github_issues_core(&self.workspaces, workspace_id).await
    }

    async fn get_github_pull_requests(
        &self,
        workspace_id: String,
    ) -> Result<GitHubPullRequestsResponse, String> {
        git_ui_core::get_github_pull_requests_core(&self.workspaces, workspace_id).await
    }

    async fn get_github_pull_request_diff(
        &self,
        workspace_id: String,
        pr_number: u64,
    ) -> Result<Vec<GitHubPullRequestDiff>, String> {
        git_ui_core::get_github_pull_request_diff_core(&self.workspaces, workspace_id, pr_number)
            .await
    }

    async fn get_github_pull_request_comments(
        &self,
        workspace_id: String,
        pr_number: u64,
    ) -> Result<Vec<GitHubPullRequestComment>, String> {
        git_ui_core::get_github_pull_request_comments_core(
            &self.workspaces,
            workspace_id,
            pr_number,
        )
        .await
    }

    async fn checkout_github_pull_request(
        &self,
        workspace_id: String,
        pr_number: u64,
    ) -> Result<(), String> {
        git_ui_core::checkout_github_pull_request_core(&self.workspaces, workspace_id, pr_number)
            .await
    }

    async fn list_git_branches(&self, workspace_id: String) -> Result<Value, String> {
        git_ui_core::list_git_branches_core(&self.workspaces, workspace_id).await
    }

    async fn checkout_git_branch(&self, workspace_id: String, name: String) -> Result<(), String> {
        git_ui_core::checkout_git_branch_core(&self.workspaces, workspace_id, name).await
    }

    async fn create_git_branch(&self, workspace_id: String, name: String) -> Result<(), String> {
        git_ui_core::create_git_branch_core(&self.workspaces, workspace_id, name).await
    }

    async fn prompts_list(&self, workspace_id: String) -> Result<Vec<CustomPromptEntry>, String> {
        prompts_core::prompts_list_core(&self.workspaces, &self.settings_path, workspace_id).await
    }

    async fn prompts_workspace_dir(&self, workspace_id: String) -> Result<String, String> {
        prompts_core::prompts_workspace_dir_core(
            &self.workspaces,
            &self.settings_path,
            workspace_id,
        )
        .await
    }

    async fn prompts_global_dir(&self, workspace_id: String) -> Result<String, String> {
        prompts_core::prompts_global_dir_core(&self.workspaces, workspace_id).await
    }

    async fn prompts_create(
        &self,
        workspace_id: String,
        scope: String,
        name: String,
        description: Option<String>,
        argument_hint: Option<String>,
        content: String,
    ) -> Result<CustomPromptEntry, String> {
        prompts_core::prompts_create_core(
            &self.workspaces,
            &self.settings_path,
            workspace_id,
            scope,
            name,
            description,
            argument_hint,
            content,
        )
        .await
    }

    async fn prompts_update(
        &self,
        workspace_id: String,
        path: String,
        name: String,
        description: Option<String>,
        argument_hint: Option<String>,
        content: String,
    ) -> Result<CustomPromptEntry, String> {
        prompts_core::prompts_update_core(
            &self.workspaces,
            &self.settings_path,
            workspace_id,
            path,
            name,
            description,
            argument_hint,
            content,
        )
        .await
    }

    async fn prompts_delete(&self, workspace_id: String, path: String) -> Result<(), String> {
        prompts_core::prompts_delete_core(&self.workspaces, &self.settings_path, workspace_id, path)
            .await
    }

    async fn prompts_move(
        &self,
        workspace_id: String,
        path: String,
        scope: String,
    ) -> Result<CustomPromptEntry, String> {
        prompts_core::prompts_move_core(
            &self.workspaces,
            &self.settings_path,
            workspace_id,
            path,
            scope,
        )
        .await
    }

    async fn codex_doctor(
        &self,
        codex_bin: Option<String>,
        codex_args: Option<String>,
    ) -> Result<Value, String> {
        codex_aux_core::codex_doctor_core(&self.app_settings, codex_bin, codex_args).await
    }

    async fn generate_commit_message(
        &self,
        workspace_id: String,
        commit_message_model_id: Option<String>,
    ) -> Result<String, String> {
        let repo_root = git_ui_core::resolve_repo_root_for_workspace_core(
            &self.workspaces,
            workspace_id.clone(),
        )
        .await?;
        let diff = git_ui_core::collect_workspace_diff_core(&repo_root)?;
        let commit_message_prompt = {
            let settings = self.app_settings.lock().await;
            settings.commit_message_prompt.clone()
        };
        codex_aux_core::generate_commit_message_core(
            &self.sessions,
            &self.workspaces,
            workspace_id,
            &diff,
            &commit_message_prompt,
            commit_message_model_id.as_deref(),
            |workspace_id, thread_id| {
                emit_background_thread_hide(&self.event_sink, workspace_id, thread_id);
            },
        )
        .await
    }

    async fn generate_run_metadata(
        &self,
        workspace_id: String,
        prompt: String,
    ) -> Result<Value, String> {
        codex_aux_core::generate_run_metadata_core(
            &self.sessions,
            &self.workspaces,
            workspace_id,
            &prompt,
            |workspace_id, thread_id| {
                emit_background_thread_hide(&self.event_sink, workspace_id, thread_id);
            },
        )
        .await
    }

    async fn generate_agent_description(
        &self,
        workspace_id: String,
        description: String,
    ) -> Result<codex_aux_core::GeneratedAgentConfiguration, String> {
        codex_aux_core::generate_agent_description_core(
            &self.sessions,
            &self.workspaces,
            workspace_id,
            &description,
            |workspace_id, thread_id| {
                emit_background_thread_hide(&self.event_sink, workspace_id, thread_id);
            },
        )
        .await
    }

    async fn local_usage_snapshot(
        &self,
        days: Option<u32>,
        workspace_path: Option<String>,
    ) -> Result<LocalUsageSnapshot, String> {
        local_usage_core::local_usage_snapshot_core(&self.workspaces, days, workspace_path).await
    }

    async fn menu_set_accelerators(&self, _updates: Vec<Value>) -> Result<(), String> {
        // Daemon has no native menu runtime; treat as no-op for remote parity.
        Ok(())
    }

    async fn is_macos_debug_build(&self) -> bool {
        cfg!(all(target_os = "macos", debug_assertions))
    }

    async fn send_notification_fallback(&self, title: String, body: String) -> Result<(), String> {
        send_notification_fallback_inner(title, body)
    }
}

fn emit_background_thread_hide(event_sink: &DaemonEventSink, workspace_id: &str, thread_id: &str) {
    event_sink.emit_app_server_event(AppServerEvent {
        workspace_id: workspace_id.to_string(),
        message: json!({
            "method": "codex/backgroundThread",
            "params": {
                "threadId": thread_id,
                "action": "hide"
            }
        }),
    });
}

fn send_notification_fallback_inner(title: String, body: String) -> Result<(), String> {
    #[cfg(all(target_os = "macos", debug_assertions))]
    {
        let escape = |value: &str| value.replace('\\', "\\\\").replace('"', "\\\"");
        let script = format!(
            "display notification \"{}\" with title \"{}\"",
            escape(&body),
            escape(&title)
        );

        let status = std::process::Command::new("/usr/bin/osascript")
            .arg("-e")
            .arg(script)
            .status()
            .map_err(|error| format!("Failed to run osascript: {error}"))?;

        if status.success() {
            return Ok(());
        }
        return Err(format!("osascript exited with status: {status}"));
    }

    #[cfg(not(all(target_os = "macos", debug_assertions)))]
    {
        let _ = (title, body);
        Err("Notification fallback is only available on macOS debug builds.".to_string())
    }
}

const MAX_WORKSPACE_FILE_BYTES: u64 = 400_000;

fn read_workspace_file_inner(
    root: &PathBuf,
    relative_path: &str,
) -> Result<WorkspaceFileResponse, String> {
    let canonical_root = root
        .canonicalize()
        .map_err(|err| format!("Failed to resolve workspace root: {err}"))?;
    let candidate = canonical_root.join(relative_path);
    let canonical_path = candidate
        .canonicalize()
        .map_err(|err| format!("Failed to open file: {err}"))?;
    if !canonical_path.starts_with(&canonical_root) {
        return Err("Invalid file path".to_string());
    }
    let metadata = std::fs::metadata(&canonical_path)
        .map_err(|err| format!("Failed to read file metadata: {err}"))?;
    if !metadata.is_file() {
        return Err("Path is not a file".to_string());
    }

    let file = File::open(&canonical_path).map_err(|err| format!("Failed to open file: {err}"))?;
    let mut buffer = Vec::new();
    file.take(MAX_WORKSPACE_FILE_BYTES + 1)
        .read_to_end(&mut buffer)
        .map_err(|err| format!("Failed to read file: {err}"))?;

    let truncated = buffer.len() > MAX_WORKSPACE_FILE_BYTES as usize;
    if truncated {
        buffer.truncate(MAX_WORKSPACE_FILE_BYTES as usize);
    }

    let content = String::from_utf8(buffer).map_err(|_| "File is not valid UTF-8".to_string())?;
    Ok(WorkspaceFileResponse { content, truncated })
}

fn default_data_dir() -> PathBuf {
    if let Ok(xdg) = env::var("XDG_DATA_HOME") {
        let trimmed = xdg.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed).join("codex-monitor-daemon");
        }
    }
    let home = env::var("HOME").unwrap_or_else(|_| ".".to_string());
    PathBuf::from(home)
        .join(".local")
        .join("share")
        .join("codex-monitor-daemon")
}

fn usage() -> String {
    format!(
        "\
USAGE:\n  codex-monitor-daemon [--listen <addr>] [--data-dir <path>] [--token <token> | --insecure-no-auth]\n\n\
OPTIONS:\n  --listen <addr>          Bind address (default: {DEFAULT_LISTEN_ADDR})\n  --data-dir <path>        Data dir holding workspaces.json/settings.json\n  --token <token>          Shared token required by TCP clients\n  --insecure-no-auth       Disable TCP auth (dev only)\n  -h, --help               Show this help\n"
    )
}

fn parse_args() -> Result<DaemonConfig, String> {
    let mut listen = DEFAULT_LISTEN_ADDR
        .parse::<SocketAddr>()
        .map_err(|err| err.to_string())?;
    let mut token = env::var("CODEX_MONITOR_DAEMON_TOKEN")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let mut insecure_no_auth = false;
    let mut data_dir: Option<PathBuf> = None;

    let mut args = env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "-h" | "--help" => {
                print!("{}", usage());
                std::process::exit(0);
            }
            "--listen" => {
                let value = args.next().ok_or("--listen requires a value")?;
                listen = value.parse::<SocketAddr>().map_err(|err| err.to_string())?;
            }
            "--token" => {
                let value = args.next().ok_or("--token requires a value")?;
                let trimmed = value.trim();
                if trimmed.is_empty() {
                    return Err("--token requires a non-empty value".to_string());
                }
                token = Some(trimmed.to_string());
            }
            "--data-dir" => {
                let value = args.next().ok_or("--data-dir requires a value")?;
                let trimmed = value.trim();
                if trimmed.is_empty() {
                    return Err("--data-dir requires a non-empty value".to_string());
                }
                data_dir = Some(PathBuf::from(trimmed));
            }
            "--insecure-no-auth" => {
                insecure_no_auth = true;
                token = None;
            }
            _ => return Err(format!("Unknown argument: {arg}")),
        }
    }

    if token.is_none() && !insecure_no_auth {
        return Err(
            "Missing --token (or set CODEX_MONITOR_DAEMON_TOKEN). Use --insecure-no-auth for local dev only."
                .to_string(),
        );
    }

    Ok(DaemonConfig {
        listen,
        token,
        data_dir: data_dir.unwrap_or_else(default_data_dir),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shared::process_core::kill_child_process_tree;
    use crate::storage::write_workspaces;
    use crate::types::WorkspaceKind;
    use serde_json::json;
    use std::future::Future;
    use std::path::PathBuf;
    use std::process::Stdio;
    use std::sync::Arc;
    use std::time::{Duration, SystemTime, UNIX_EPOCH};
    use tokio::process::Command;

    static CODEX_HOME_ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    struct CodexHomeEnvGuard(Option<std::ffi::OsString>);

    impl CodexHomeEnvGuard {
        fn set(path: &std::path::Path) -> Self {
            let previous = std::env::var_os("CODEX_HOME");
            std::env::set_var("CODEX_HOME", path);
            Self(previous)
        }
    }

    impl Drop for CodexHomeEnvGuard {
        fn drop(&mut self) {
            match self.0.take() {
                Some(value) => std::env::set_var("CODEX_HOME", value),
                None => std::env::remove_var("CODEX_HOME"),
            }
        }
    }

    fn run_async_test<F>(future: F)
    where
        F: Future<Output = ()>,
    {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime")
            .block_on(future);
    }

    fn make_temp_dir(prefix: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "codex-monitor-{prefix}-{}-{unique}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    fn test_state(data_dir: &std::path::Path) -> DaemonState {
        let (tx, _rx) = broadcast::channel::<DaemonEvent>(32);
        DaemonState {
            data_dir: data_dir.to_path_buf(),
            workspaces: Mutex::new(HashMap::new()),
            sessions: Mutex::new(HashMap::new()),
            storage_path: data_dir.join("workspaces.json"),
            settings_path: data_dir.join("settings.json"),
            app_settings: Mutex::new(AppSettings::default()),
            event_sink: DaemonEventSink { tx },
            codex_login_cancels: Mutex::new(HashMap::new()),
            session_manager: SessionManagerRuntime::with_storage_dir(data_dir),
            session_source_runtimes: SessionSourceRuntimePool::for_workspace_sessions(),
            source_thread_runtimes: SourceThreadRuntimeBindings::default(),
            daemon_binary_path: Some("/tmp/codex-monitor-daemon".to_string()),
            task_coordination_ledger: tokio::sync::Mutex::new(Some(Default::default())),
            turn_execution_summaries: tokio::sync::Mutex::new(
                crate::shared::turn_execution_summary_core::TurnExecutionSummarySidecar::for_data_dir(data_dir),
            ),
            execution_bindings: tokio::sync::Mutex::new(
                crate::shared::execution_binding_core::ExecutionBindingSidecar::for_data_dir(data_dir),
            ),
        }
    }

    async fn insert_workspace(state: &DaemonState, workspace_id: &str, workspace_path: &str) {
        let entry = WorkspaceEntry {
            id: workspace_id.to_string(),
            name: "Workspace".to_string(),
            path: workspace_path.to_string(),
            kind: WorkspaceKind::Main,
            parent_id: None,
            worktree: None,
            settings: WorkspaceSettings {
                ..WorkspaceSettings::default()
            },
        };
        state
            .workspaces
            .lock()
            .await
            .insert(workspace_id.to_string(), entry);
    }

    fn make_workspace_entry(workspace_id: &str, workspace_path: &str) -> WorkspaceEntry {
        WorkspaceEntry {
            id: workspace_id.to_string(),
            name: workspace_id.to_string(),
            path: workspace_path.to_string(),
            kind: WorkspaceKind::Main,
            parent_id: None,
            worktree: None,
            settings: WorkspaceSettings::default(),
        }
    }

    fn make_session(entry: WorkspaceEntry) -> Arc<WorkspaceSession> {
        let owner_workspace_id = entry.id;
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
            owner_workspace_id,
        ))
    }

    #[test]
    fn rpc_add_clone_uses_workspace_core_validation() {
        run_async_test(async {
            let tmp = make_temp_dir("rpc-add-clone");
            let state = test_state(&tmp);

            let err = rpc::handle_rpc_request(
                &state,
                "add_clone",
                json!({
                    "sourceWorkspaceId": "source",
                    "copiesFolder": tmp.to_string_lossy().to_string(),
                    "copyName": "   "
                }),
                "daemon-test".to_string(),
            )
            .await
            .expect_err("expected validation error");

            assert_eq!(err, "Copy name is required.");
            let _ = std::fs::remove_dir_all(&tmp);
        });
    }

    #[test]
    fn rpc_prompts_list_reads_workspace_prompts() {
        run_async_test(async {
            let tmp = make_temp_dir("rpc-prompts-list");
            let workspace_id = "ws-prompts";
            let workspace_dir = tmp.join("workspace");
            std::fs::create_dir_all(&workspace_dir).expect("create workspace dir");

            let state = test_state(&tmp);
            insert_workspace(&state, workspace_id, &workspace_dir.to_string_lossy()).await;

            let prompts_dir = tmp.join("workspaces").join(workspace_id).join("prompts");
            std::fs::create_dir_all(&prompts_dir).expect("create prompts dir");
            std::fs::write(prompts_dir.join("review.md"), "Prompt body").expect("write prompt");

            let result = rpc::handle_rpc_request(
                &state,
                "prompts_list",
                json!({ "workspaceId": workspace_id }),
                "daemon-test".to_string(),
            )
            .await
            .expect("prompts_list should succeed");

            let prompts = result.as_array().expect("array result");
            assert!(
                prompts.iter().any(|entry| {
                    entry
                        .get("name")
                        .and_then(Value::as_str)
                        .is_some_and(|name| name == "review")
                }),
                "expected prompts_list to include workspace prompt"
            );
            let _ = std::fs::remove_dir_all(&tmp);
        });
    }

    #[test]
    fn rpc_local_usage_snapshot_returns_snapshot_shape() {
        run_async_test(async {
            let tmp = make_temp_dir("rpc-local-usage");
            let state = test_state(&tmp);

            let result = rpc::handle_rpc_request(
                &state,
                "local_usage_snapshot",
                json!({ "days": 7 }),
                "daemon-test".to_string(),
            )
            .await
            .expect("local_usage_snapshot should succeed");

            assert!(result.get("days").and_then(Value::as_array).is_some());
            assert!(result.get("totals").is_some());
            let _ = std::fs::remove_dir_all(&tmp);
        });
    }

    #[test]
    fn rpc_turn_execution_summary_roundtrips_and_isolates_compound_key() {
        run_async_test(async {
            let tmp = make_temp_dir("turn-execution-summary-rpc");
            let state = test_state(&tmp);
            let summary = json!({
                "schemaVersion": 1, "executionId": "execution-a", "workspaceId": "workspace-a",
                "threadId": "thread-a", "turnId": "turn-a", "turnChain": ["turn-a"],
                "status": "completed", "startedAtMs": 10, "endedAtMs": 20,
                "workingDurationMs": 10, "addedLines": 4, "deletedLines": 1,
                "diffRevision": 1, "recordRevision": 2, "updatedAtMs": 20
            });
            let stored = rpc::handle_rpc_request(
                &state,
                "turn_execution_summary_upsert",
                json!({ "input": { "summary": summary } }),
                "daemon-test".to_string(),
            )
            .await
            .expect("upsert summary");
            assert_eq!(stored["executionId"], "execution-a");
            let visible = rpc::handle_rpc_request(
                &state,
                "turn_execution_summary_get",
                json!({ "input": { "workspaceId": "workspace-a", "threadId": "thread-a" } }),
                "daemon-test".to_string(),
            )
            .await
            .expect("get matching summary");
            assert_eq!(visible.as_array().map(Vec::len), Some(1));
            let isolated = rpc::handle_rpc_request(
                &state,
                "turn_execution_summary_get",
                json!({ "input": { "workspaceId": "workspace-b", "threadId": "thread-a" } }),
                "daemon-test".to_string(),
            )
            .await
            .expect("get isolated summary");
            assert_eq!(isolated.as_array().map(Vec::len), Some(0));
            let _ = std::fs::remove_dir_all(tmp);
        });
    }

    #[test]
    fn rpc_execution_binding_matches_actual_first_and_survives_reload() {
        run_async_test(async {
            let tmp = make_temp_dir("execution-binding-rpc");
            let now_ms = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("time")
                .as_millis() as u64;
            {
                let state = test_state(&tmp);
                let observed = rpc::handle_rpc_request(
                    &state,
                    "execution_binding_observe",
                    json!({
                        "input": {
                            "workspaceId": "workspace-a",
                            "parentThreadId": "parent-a",
                            "collabToolCallId": "call-a",
                            "senderThreadId": "parent-a",
                            "receiverThreadIds": ["child-a"],
                            "actual": {
                                "modelId": "gpt-5.6-luna",
                                "reasoningEffort": "low"
                            },
                            "observedAtMs": now_ms
                        }
                    }),
                    "daemon-test".to_string(),
                )
                .await
                .expect("observe actual binding");
                assert_eq!(observed["status"], "awaiting_expected");

                let registered = rpc::handle_rpc_request(
                    &state,
                    "execution_binding_register",
                    json!({
                        "input": {
                            "workspaceId": "workspace-a",
                            "parentThreadId": "parent-a",
                            "collabToolCallId": "call-a",
                            "activePlanRevision": 2,
                            "approvedPlan": {
                                "planId": "plan-routing",
                                "planRevision": 2,
                                "planHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                                "approvalReceiptId": "receipt-plan-routing",
                                "nodeId": "node-transform",
                                "taskFingerprint": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
                            },
                            "expected": {
                                "modelId": "gpt-5.6-luna",
                                "reasoningEffort": "low"
                            },
                            "provider": {
                                "activeProviderId": "openai",
                                "selectedProviderId": "openai",
                                "selectedModelId": "gpt-5.6-luna",
                                "selectedReasoningEffort": "low",
                                "models": [{
                                    "providerId": "openai",
                                    "modelId": "gpt-5.6-luna",
                                    "verified": true,
                                    "supportedReasoningEfforts": ["low", "medium"]
                                }]
                            },
                            "registeredAtMs": now_ms + 1,
                            "expiresAtMs": now_ms + 60_001
                        }
                    }),
                    "daemon-test".to_string(),
                )
                .await
                .expect("register expected binding");
                assert_eq!(registered["status"], "matched");
            }

            let reloaded = test_state(&tmp);
            let records = rpc::handle_rpc_request(
                &reloaded,
                "execution_binding_list",
                json!({
                    "input": {
                        "workspaceId": "workspace-a",
                        "parentThreadId": "parent-a",
                        "collabToolCallId": "call-a"
                    }
                }),
                "daemon-test".to_string(),
            )
            .await
            .expect("reload execution binding");
            assert_eq!(records.as_array().map(Vec::len), Some(1));
            assert_eq!(records[0]["status"], "matched");
            assert_eq!(records[0]["receiverThreadIds"][0], "child-a");
            let _ = std::fs::remove_dir_all(tmp);
        });
    }

    #[test]
    fn rpc_shadow_router_returns_read_only_advice_contract() {
        run_async_test(async {
            let tmp = make_temp_dir("shadow-router-rpc");
            let state = test_state(&tmp);
            let result = rpc::handle_rpc_request(
                &state,
                "execution_router_shadow_preview",
                json!({
                    "input": {
                        "task": {
                            "complexity": "low",
                            "risk": "low",
                            "parallelizable": false,
                            "requiresWrite": false
                        },
                        "provider": {
                            "activeProviderId": "provider-a",
                            "selectedProviderId": "provider-a",
                            "selectedModelId": "model-a",
                            "selectedReasoningEffort": "high",
                            "models": [{
                                "providerId": "provider-a",
                                "modelId": "model-a",
                                "verified": true,
                                "supportedReasoningEfforts": ["high"]
                            }]
                        },
                        "runtime": {
                            "activeSlots": 0,
                            "depth": 0,
                            "rootTokensUsed": 0,
                            "subtaskTokensEstimate": 1000,
                            "elapsedMs": 0,
                            "retryCount": 0,
                            "fallbackCount": 0
                        },
                        "coordination": null
                    }
                }),
                "daemon-test".to_string(),
            )
            .await
            .expect("shadow router preview");

            assert_eq!(result["recommendation"], "direct");
            assert!(result["reasonCodes"].is_array());
            assert_eq!(result.as_object().map(|object| object.len()), Some(2));
            let _ = std::fs::remove_dir_all(tmp);
        });
    }

    #[test]
    fn rpc_shadow_router_audits_approved_binding_without_dispatch() {
        run_async_test(async {
            let tmp = make_temp_dir("shadow-router-binding-rpc");
            let state = test_state(&tmp);
            let result = rpc::handle_rpc_request(
                &state,
                "execution_router_shadow_preview",
                json!({
                    "input": {
                        "task": {
                            "complexity": "low",
                            "risk": "low",
                            "parallelizable": false,
                            "requiresWrite": false
                        },
                        "provider": {
                            "activeProviderId": "openai",
                            "selectedProviderId": "openai",
                            "selectedModelId": "gpt-5.6-luna",
                            "selectedReasoningEffort": "low",
                            "models": [{
                                "providerId": "openai",
                                "modelId": "gpt-5.6-luna",
                                "verified": true,
                                "supportedReasoningEfforts": ["low", "medium"]
                            }]
                        },
                        "runtime": {
                            "activeSlots": 0,
                            "depth": 0,
                            "rootTokensUsed": 0,
                            "subtaskTokensEstimate": 1000,
                            "elapsedMs": 0,
                            "retryCount": 0,
                            "fallbackCount": 0
                        },
                        "coordination": null,
                        "binding": {
                            "approvedPlan": {
                                "planId": "plan-routing",
                                "planRevision": 2,
                                "planHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                                "approvalReceiptId": "receipt-plan-routing",
                                "nodeId": "node-transform",
                                "taskFingerprint": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
                            },
                            "expected": {
                                "modelId": "gpt-5.6-luna",
                                "reasoningEffort": "low"
                            },
                            "actual": {
                                "modelId": "gpt-5.6-luna",
                                "reasoningEffort": "low"
                            }
                        }
                    }
                }),
                "daemon-test".to_string(),
            )
            .await
            .expect("shadow binding audit");

            assert_eq!(result["recommendation"], "direct");
            assert_eq!(result["bindingAudit"]["status"], "matched");
            assert_eq!(
                result["bindingAudit"]["expected"]["modelId"],
                "gpt-5.6-luna"
            );
            let _ = std::fs::remove_dir_all(tmp);
        });
    }

    #[test]
    fn rpc_get_thread_token_usage_restores_local_snapshot() {
        let _env_lock = CODEX_HOME_ENV_LOCK.lock().expect("lock CODEX_HOME");
        let tmp = make_temp_dir("resume-thread-token-usage");
        let codex_home = tmp.join("codex-home");
        let _codex_home_guard = CodexHomeEnvGuard::set(&codex_home);

        run_async_test(async {
            let workspace_id = "ws-resume-usage";
            let thread_id = "thread-resume-usage";
            let workspace_dir = tmp.join("workspace");
            std::fs::create_dir_all(&workspace_dir).expect("create workspace dir");

            let session_dir = codex_home.join("sessions/2026/07/15");
            std::fs::create_dir_all(&session_dir).expect("create session dir");
            let jsonl = [
                json!({
                    "type": "session_meta",
                    "payload": {
                        "id": thread_id,
                        "cwd": workspace_dir.to_string_lossy()
                    }
                })
                .to_string(),
                json!({
                    "type": "event_msg",
                    "payload": {
                        "type": "token_count",
                        "info": {
                            "last_token_usage": {
                                "input_tokens": 12,
                                "output_tokens": 3
                            },
                            "total_token_usage": {
                                "input_tokens": 120,
                                "output_tokens": 30
                            },
                            "model_context_window": 200000
                        }
                    }
                })
                .to_string(),
            ]
            .join("\n");
            std::fs::write(session_dir.join("session.jsonl"), format!("{jsonl}\n"))
                .expect("write session jsonl");

            let state = test_state(&tmp);
            insert_workspace(&state, workspace_id, &workspace_dir.to_string_lossy()).await;
            let response = rpc::handle_rpc_request(
                &state,
                "get_thread_token_usage",
                json!({ "workspaceId": workspace_id, "threadId": thread_id }),
                "daemon-test".to_string(),
            )
            .await
            .expect("get thread token usage");

            assert_eq!(response["last"]["input_tokens"], 12);
            assert_eq!(response["total"]["output_tokens"], 30);
            assert_eq!(response["model_context_window"], 200000);
        });

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn rpc_daemon_info_reports_identity() {
        run_async_test(async {
            let tmp = make_temp_dir("rpc-daemon-info");
            let state = test_state(&tmp);

            let result = rpc::handle_rpc_request(
                &state,
                "daemon_info",
                json!({}),
                "daemon-test".to_string(),
            )
            .await
            .expect("daemon_info should succeed");

            assert_eq!(
                result.get("name").and_then(Value::as_str),
                Some(DAEMON_NAME)
            );
            assert_eq!(result.get("mode").and_then(Value::as_str), Some("tcp"));
            assert_eq!(
                result.get("version").and_then(Value::as_str),
                Some(env!("CARGO_PKG_VERSION"))
            );
            let _ = std::fs::remove_dir_all(&tmp);
        });
    }
    #[test]
    fn list_workspaces_syncs_from_storage_file() {
        run_async_test(async {
            let tmp = make_temp_dir("list-workspaces-sync");
            let state = test_state(&tmp);

            let persisted = vec![WorkspaceEntry {
                id: "ws-sync".to_string(),
                name: "Synced Workspace".to_string(),
                path: tmp.join("workspace").to_string_lossy().to_string(),
                kind: WorkspaceKind::Main,
                parent_id: None,
                worktree: None,
                settings: WorkspaceSettings::default(),
            }];
            write_workspaces(&state.storage_path, &persisted).expect("write workspaces");

            let listed = state.list_workspaces().await;
            assert!(
                listed.iter().any(|workspace| workspace.id == "ws-sync"),
                "expected daemon list_workspaces to include workspace added on disk"
            );

            let _ = std::fs::remove_dir_all(&tmp);
        });
    }

    #[test]
    fn list_workspaces_sync_prunes_stale_sessions() {
        run_async_test(async {
            let tmp = make_temp_dir("list-workspaces-sync-prune");
            let state = test_state(&tmp);
            let keep_path = tmp.join("workspace-keep");
            let stale_path = tmp.join("workspace-stale");

            let persisted = vec![make_workspace_entry(
                "ws-keep",
                &keep_path.to_string_lossy(),
            )];
            write_workspaces(&state.storage_path, &persisted).expect("write workspaces");

            let keep_session = make_session(make_workspace_entry(
                "ws-keep",
                &keep_path.to_string_lossy(),
            ));
            let stale_session = make_session(make_workspace_entry(
                "ws-stale",
                &stale_path.to_string_lossy(),
            ));
            {
                let mut sessions = state.sessions.lock().await;
                sessions.insert("ws-keep".to_string(), keep_session);
                sessions.insert("ws-stale".to_string(), stale_session.clone());
            }

            let listed = state.list_workspaces().await;
            assert!(
                listed.iter().any(|workspace| workspace.id == "ws-keep"),
                "expected daemon list_workspaces to include persisted workspace"
            );

            {
                let sessions = state.sessions.lock().await;
                assert!(
                    sessions.contains_key("ws-keep"),
                    "expected connected persisted workspace session to remain"
                );
                assert!(
                    !sessions.contains_key("ws-stale"),
                    "expected stale session to be removed"
                );
            }

            let stale_session_exited = tokio::time::timeout(Duration::from_secs(2), async {
                loop {
                    let exited = stale_session
                        .child
                        .lock()
                        .await
                        .try_wait()
                        .expect("query stale session child");
                    if exited.is_some() {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(25)).await;
                }
            })
            .await
            .is_ok();
            assert!(
                stale_session_exited,
                "expected stale session child process to terminate"
            );

            if let Some(keep_session) = state.sessions.lock().await.remove("ws-keep") {
                let mut child = keep_session.child.lock().await;
                kill_child_process_tree(&mut child).await;
            }

            if stale_session
                .child
                .lock()
                .await
                .try_wait()
                .expect("query stale session child")
                .is_none()
            {
                let mut child = stale_session.child.lock().await;
                kill_child_process_tree(&mut child).await;
            }

            let _ = std::fs::remove_dir_all(&tmp);
        });
    }
}

fn main() {
    let config = match parse_args() {
        Ok(config) => config,
        Err(err) => {
            eprintln!("{err}\n\n{}", usage());
            std::process::exit(2);
        }
    };

    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("failed to build tokio runtime");

    runtime.block_on(async move {
        let (events_tx, _events_rx) = broadcast::channel::<DaemonEvent>(2048);
        let event_sink = DaemonEventSink {
            tx: events_tx.clone(),
        };
        let state = Arc::new(DaemonState::load(&config, event_sink));
        let config = Arc::new(config);

        let listener = match TcpListener::bind(config.listen).await {
            Ok(listener) => listener,
            Err(err) => {
                eprintln!("failed to bind {}: {err}", config.listen);
                std::process::exit(2);
            }
        };
        eprintln!(
            "codex-monitor-daemon listening on {} (data dir: {})",
            config.listen,
            state
                .storage_path
                .parent()
                .unwrap_or(&state.storage_path)
                .display()
        );

        loop {
            match listener.accept().await {
                Ok((socket, _addr)) => {
                    let config = Arc::clone(&config);
                    let state = Arc::clone(&state);
                    let events = events_tx.clone();
                    tokio::spawn(async move {
                        transport::handle_client(socket, config, state, events).await;
                    });
                }
                Err(_) => continue,
            }
        }
    });
}
