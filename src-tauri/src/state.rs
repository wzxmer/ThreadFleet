use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{AppHandle, Manager};
use tokio::process::Child;
use tokio::sync::Mutex;

use crate::dictation::DictationState;
use crate::shared::agents_config_core;
use crate::shared::codex_core::CodexLoginCancelState;
use crate::shared::installer_migration_service::InstallerMigrationAuthorizationState;
use crate::shared::session_manager_core::runtime::{
    SessionSourceRuntimePool, SourceThreadRuntimeBindings,
};
use crate::shared::session_manager_core::service::SessionManagerRuntime;
use crate::storage::{read_settings, read_workspaces};
use crate::types::{AppSettings, TcpDaemonState, TcpDaemonStatus, WorkspaceEntry};

pub(crate) struct TcpDaemonRuntime {
    pub(crate) child: Option<Child>,
    pub(crate) status: TcpDaemonStatus,
}

impl Default for TcpDaemonRuntime {
    fn default() -> Self {
        Self {
            child: None,
            status: TcpDaemonStatus {
                state: TcpDaemonState::Stopped,
                pid: None,
                started_at_ms: None,
                last_error: None,
                listen_addr: None,
            },
        }
    }
}

pub(crate) struct AppState {
    pub(crate) workspaces: Mutex<HashMap<String, WorkspaceEntry>>,
    pub(crate) sessions: Mutex<HashMap<String, Arc<crate::codex::WorkspaceSession>>>,
    pub(crate) terminal_sessions: Mutex<HashMap<String, Arc<crate::terminal::TerminalSession>>>,
    pub(crate) remote_backend: Mutex<Option<crate::remote_backend::RemoteBackend>>,
    pub(crate) storage_path: PathBuf,
    pub(crate) settings_path: PathBuf,
    pub(crate) app_settings: Mutex<AppSettings>,
    pub(crate) dictation: Mutex<DictationState>,
    pub(crate) codex_login_cancels: Mutex<HashMap<String, CodexLoginCancelState>>,
    pub(crate) session_manager: SessionManagerRuntime,
    pub(crate) session_source_runtimes: SessionSourceRuntimePool,
    pub(crate) source_thread_runtimes: SourceThreadRuntimeBindings,
    pub(crate) tcp_daemon: Mutex<TcpDaemonRuntime>,
    pub(crate) task_coordination_ledger: tokio::sync::Mutex<
        Option<crate::shared::task_coordination_core::ledger::CoordinationLedger>,
    >,
    pub(crate) turn_execution_summaries:
        tokio::sync::Mutex<crate::shared::turn_execution_summary_core::TurnExecutionSummarySidecar>,
    pub(crate) execution_bindings:
        tokio::sync::Mutex<crate::shared::execution_binding_core::ExecutionBindingSidecar>,
    pub(crate) windows_installer_repair: Mutex<()>,
    pub(crate) windows_installer_migration: Mutex<()>,
    pub(crate) windows_installer_migration_authorization:
        Mutex<InstallerMigrationAuthorizationState>,
}

impl AppState {
    pub(crate) fn load(app: &AppHandle) -> Self {
        let data_dir = app
            .path()
            .app_data_dir()
            .unwrap_or_else(|_| std::env::current_dir().unwrap_or_else(|_| ".".into()));
        let storage_path = data_dir.join("workspaces.json");
        let settings_path = data_dir.join("settings.json");
        let workspaces = read_workspaces(&storage_path).unwrap_or_default();
        let app_settings = read_settings(&settings_path).unwrap_or_default();
        if let Err(error) =
            agents_config_core::remove_legacy_native_markdown_import_flag_for_settings(
                &app_settings,
            )
        {
            eprintln!("AppState::load: failed to remove legacy agent import marker: {error}");
        }
        Self {
            workspaces: Mutex::new(workspaces),
            sessions: Mutex::new(HashMap::new()),
            terminal_sessions: Mutex::new(HashMap::new()),
            remote_backend: Mutex::new(None),
            storage_path,
            settings_path,
            app_settings: Mutex::new(app_settings),
            dictation: Mutex::new(DictationState::default()),
            codex_login_cancels: Mutex::new(HashMap::new()),
            session_manager: SessionManagerRuntime::with_storage_dir(&data_dir),
            session_source_runtimes: SessionSourceRuntimePool::for_workspace_sessions(),
            source_thread_runtimes: SourceThreadRuntimeBindings::default(),
            tcp_daemon: Mutex::new(TcpDaemonRuntime::default()),
            task_coordination_ledger: tokio::sync::Mutex::new(Some(Default::default())),
            turn_execution_summaries: tokio::sync::Mutex::new(
                crate::shared::turn_execution_summary_core::TurnExecutionSummarySidecar::for_data_dir(&data_dir),
            ),
            execution_bindings: tokio::sync::Mutex::new(
                crate::shared::execution_binding_core::ExecutionBindingSidecar::for_data_dir(&data_dir),
            ),
            windows_installer_repair: Mutex::new(()),
            windows_installer_migration: Mutex::new(()),
            windows_installer_migration_authorization:
                Mutex::new(InstallerMigrationAuthorizationState::default()),
        }
    }
}
