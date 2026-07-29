#[cfg(desktop)]
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::Manager;
#[cfg(desktop)]
use tauri::RunEvent;
#[cfg(desktop)]
use tauri::WindowEvent;

mod autostart;
mod backend;
mod codex;
mod daemon_binary;
mod dictation;
mod event_sink;
mod files;
mod fonts;
mod git;
mod git_utils;
mod local_usage;
#[cfg(desktop)]
mod menu;
#[cfg(not(desktop))]
#[path = "menu_mobile.rs"]
mod menu;
mod notifications;
mod prompts;
mod remote_backend;
mod rules;
mod session_manager;
mod settings;
mod shared;
mod state;
mod storage;
mod tailscale;
#[cfg(desktop)]
mod terminal;
#[cfg(not(desktop))]
#[path = "terminal_mobile.rs"]
mod terminal;
mod tray;
mod types;
mod updater;
mod utils;
mod window;
mod windows_installer;
mod workspaces;

#[cfg(desktop)]
static EXIT_CLEANUP_IN_PROGRESS: AtomicBool = AtomicBool::new(false);

#[cfg(desktop)]
fn keep_daemon_running_after_close(app_handle: &tauri::AppHandle) -> bool {
    let state = app_handle.state::<state::AppState>();
    tauri::async_runtime::block_on(async {
        state
            .app_settings
            .lock()
            .await
            .keep_daemon_running_after_app_close
    })
}

#[cfg(target_os = "macos")]
fn show_main_window(app_handle: &tauri::AppHandle) {
    if let Some(window) = app_handle.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

#[cfg(desktop)]
async fn stop_managed_daemons_for_exit(app_handle: tauri::AppHandle) {
    let state = app_handle.state::<state::AppState>();
    let _ = tailscale::tailscale_daemon_stop(state).await;
}

#[tauri::command]
fn is_mobile_runtime() -> bool {
    cfg!(any(target_os = "ios", target_os = "android"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(target_os = "linux")]
    {
        // Avoid WebKit compositing issues on NVIDIA Linux setups (GBM buffer errors).
        if std::env::var_os("__NV_PRIME_RENDER_OFFLOAD").is_none() {
            std::env::set_var("__NV_PRIME_RENDER_OFFLOAD", "1");
        }
        let is_wayland = std::env::var("XDG_SESSION_TYPE")
            .map(|session| session.eq_ignore_ascii_case("wayland"))
            .unwrap_or(false)
            || std::env::var_os("WAYLAND_DISPLAY").is_some();
        let has_nvidia = std::path::Path::new("/proc/driver/nvidia/version").exists();
        if is_wayland && has_nvidia && std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none()
        {
            std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
        }
        let is_x11 = !is_wayland && std::env::var_os("DISPLAY").is_some();
        // Work around sporadic blank WebKitGTK renders on X11 by disabling compositing mode.
        // Keep Wayland untouched because this can interfere with input behavior on some setups.
        if is_x11 && std::env::var_os("WEBKIT_DISABLE_COMPOSITING_MODE").is_none() {
            std::env::set_var("WEBKIT_DISABLE_COMPOSITING_MODE", "1");
        }
    }

    #[cfg(desktop)]
    let builder = tauri::Builder::default()
        .manage(menu::MenuItemRegistry::<tauri::Wry>::default())
        .manage(tray::TrayState::default())
        .on_menu_event(menu::handle_menu_event)
        .enable_macos_default_menu(false)
        .menu(menu::build_menu);

    #[cfg(not(desktop))]
    let builder = tauri::Builder::default();

    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_autostart::init(
        tauri_plugin_autostart::MacosLauncher::LaunchAgent,
        None,
    ));

    let builder = builder
        .on_window_event(|window, event| {
            if window.label() != "main" {
                return;
            }
            #[cfg(desktop)]
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .setup(|app| {
            let state = state::AppState::load(&app.handle());
            {
                let settings = state
                    .app_settings
                    .try_lock()
                    .expect("new app settings lock must be available");
                files::attachments::allow_attachment_asset_scope(&app.handle(), &settings)?;
            }
            app.manage(state);
            #[cfg(desktop)]
            {
                let tray_state = app.state::<tray::TrayState>();
                tray::initialize(&app.handle(), tray_state.inner())?;
            }
            #[cfg(target_os = "windows")]
            {
                if let Some(main_window) = app.get_webview_window("main") {
                    let _ = main_window.set_decorations(false);
                    // Keep menu accelerators wired while suppressing a visible native menu bar.
                    let _ = main_window.hide_menu();
                }
            }
            #[cfg(desktop)]
            {
                let app_handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    let state = app_handle.state::<state::AppState>();
                    files::attachments::cleanup_attachment_storage(state.inner()).await;
                });
            }
            #[cfg(desktop)]
            {
                let app_handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    let state = app_handle.state::<state::AppState>();
                    let settings = state.app_settings.lock().await.clone();
                    if matches!(
                        settings.remote_backend_provider,
                        crate::types::RemoteBackendProvider::Tcp
                    ) {
                        if matches!(settings.backend_mode, crate::types::BackendMode::Remote) {
                            // Remote mode: ensure daemon is up and version-current.
                            let state = app_handle.state::<state::AppState>();
                            let _ = tailscale::tailscale_daemon_start(state).await;
                        } else {
                            // Local mode: only enforce version if daemon is already running.
                            let state = app_handle.state::<state::AppState>();
                            if let Ok(status) = tailscale::tailscale_daemon_status(state).await {
                                if matches!(status.state, crate::types::TcpDaemonState::Running) {
                                    let state = app_handle.state::<state::AppState>();
                                    let _ = tailscale::tailscale_daemon_start(state).await;
                                }
                            }
                        }
                    }
                });
            }
            #[cfg(target_os = "ios")]
            {
                if let Some(main_webview) = app.get_webview_window("main") {
                    let _ = window::configure_ios_webview_edge_to_edge(&main_webview);
                }
            }
            #[cfg(desktop)]
            {
                app.handle()
                    .plugin(tauri_plugin_updater::Builder::new().build())?;
            }
            Ok(())
        });

    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_window_state::Builder::default().build());

    let app = builder
        .plugin(tauri_plugin_liquid_glass::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![
            settings::get_app_settings,
            settings::update_app_settings,
            session_manager::list_session_sources,
            session_manager::update_session_source,
            session_manager::scan_managed_sessions,
            session_manager::verify_session_threads,
            session_manager::fetch_managed_sessions_page,
            session_manager::fetch_managed_session_preview,
            session_manager::search_managed_sessions,
            session_manager::fetch_session_search_results,
            session_manager::cancel_session_task,
            session_manager::resume_managed_session,
            session_manager::archive_managed_sessions,
            session_manager::permanently_delete_managed_session,
            session_manager::preview_managed_session_cleanup,
            session_manager::cleanup_managed_sessions_now,
            session_manager::run_managed_session_cleanup_scheduler,
            session_manager::prepare_managed_session_derivation,
            settings::get_codex_config_path,
            settings::get_codex_status,
            settings::get_codex_sync_diagnostics,
            files::file_read,
            files::file_write,
            files::read_image_as_data_url,
            files::save_composer_images,
            files::promote_composer_images,
            files::create_message_reference,
            files::create_content_reference,
            files::write_text_file,
            fonts::list_system_fonts,
            codex::get_config_model,
            codex::get_provider_status,
            codex::provider_model_list,
            codex::third_party_key_usage,
            codex::workspace_third_party_key_usage,
            menu::menu_set_accelerators,
            menu::menu_set_labels,
            autostart::app_autostart_is_enabled,
            autostart::app_autostart_set_enabled,
            tray::set_tray_recent_threads,
            tray::set_tray_labels,
            tray::set_tray_session_usage,
            codex::codex_doctor,
            codex::codex_update,
            workspaces::list_workspaces,
            workspaces::is_workspace_path_dir,
            workspaces::add_workspace,
            workspaces::add_workspace_from_git_url,
            workspaces::add_clone,
            workspaces::add_worktree,
            workspaces::worktree_setup_status,
            workspaces::worktree_setup_mark_ran,
            workspaces::remove_workspace,
            workspaces::remove_worktree,
            workspaces::rename_worktree,
            workspaces::rename_worktree_upstream,
            workspaces::apply_worktree_changes,
            workspaces::update_workspace_settings,
            workspaces::set_workspace_runtime_codex_args,
            codex::start_thread,
            codex::send_user_message,
            codex::turn_steer,
            codex::turn_interrupt,
            codex::start_review,
            codex::respond_to_server_request,
            codex::remember_approval_rule,
            codex::generate_commit_message,
            codex::generate_run_metadata,
            codex::generate_agent_description,
            codex::turn_execution_summary_get,
            codex::turn_execution_summary_upsert,
            codex::execution_binding_register,
            codex::execution_binding_observe,
            codex::execution_binding_list,
            codex::resume_thread,
            codex::get_thread_token_usage,
            codex::read_thread,
            codex::read_thread_page,
            codex::thread_live_subscribe,
            codex::thread_live_unsubscribe,
            codex::fork_thread,
            codex::rollback_thread,
            codex::list_threads,
            codex::list_mcp_server_status,
            codex::computer_control_status,
            codex::computer_control_preflight,
            codex::archive_thread,
            codex::compact_thread,
            codex::set_thread_name,
            codex::collaboration_mode_list,
            workspaces::connect_workspace,
            git::get_git_status,
            git::init_git_repo,
            git::create_github_repo,
            git::list_git_roots,
            git::get_git_diffs,
            git::get_git_log,
            git::get_git_commit_diff,
            git::get_git_remote,
            git::stage_git_file,
            git::stage_git_all,
            git::unstage_git_file,
            git::revert_git_file,
            git::revert_git_all,
            git::commit_git,
            git::push_git,
            git::pull_git,
            git::fetch_git,
            git::sync_git,
            git::get_github_issues,
            git::get_github_pull_requests,
            git::get_github_pull_request_diff,
            git::get_github_pull_request_comments,
            git::checkout_github_pull_request,
            workspaces::list_workspace_files,
            workspaces::read_workspace_file,
            workspaces::open_workspace_in,
            workspaces::get_open_app_icon,
            git::list_git_branches,
            git::checkout_git_branch,
            git::create_git_branch,
            codex::model_list,
            codex::experimental_feature_list,
            codex::set_codex_feature_flag,
            codex::get_agents_settings,
            codex::set_agents_core_settings,
            codex::create_agent,
            codex::update_agent,
            codex::delete_agent,
            codex::read_agent_config_toml,
            codex::write_agent_config_toml,
            codex::account_rate_limits,
            codex::account_read,
            codex::codex_login,
            codex::codex_login_cancel,
            codex::skills_list,
            codex::workflow_preflight_preview,
            codex::workflow_gate_status,
            codex::knowledge_status,
            codex::knowledge_query,
            codex::knowledge_intake_capture,
            codex::knowledge_task_init,
            codex::execution_router_shadow_preview,
            codex::apps_list,
            codex::task_coordination_list_groups,
            codex::task_coordination_create_group,
            codex::task_coordination_acquire_claim,
            codex::task_coordination_release_claim,
            codex::task_coordination_heartbeat,
            codex::task_coordination_detect_candidates,
            codex::detect_python,
            prompts::prompts_list,
            prompts::prompts_create,
            prompts::prompts_update,
            prompts::prompts_delete,
            prompts::prompts_move,
            prompts::prompts_workspace_dir,
            prompts::prompts_global_dir,
            terminal::terminal_open,
            terminal::terminal_write,
            terminal::terminal_resize,
            terminal::terminal_close,
            terminal::terminal_open_external,
            terminal::get_system_terminal_font,
            dictation::dictation_model_status,
            dictation::dictation_download_model,
            dictation::dictation_cancel_download,
            dictation::dictation_remove_model,
            dictation::dictation_start,
            dictation::dictation_request_permission,
            dictation::dictation_stop,
            dictation::dictation_cancel,
            local_usage::local_usage_snapshot,
            updater::cleanup_downloaded_release_assets,
            updater::download_and_open_release_asset,
            updater::install_managed_codex,
            updater::managed_codex_platform,
            updater::release_platform,
            updater::windows_installer_kind,
            windows_installer::preview_windows_installer_repair,
            windows_installer::recover_windows_installer_repair,
            windows_installer::apply_windows_installer_repair,
            windows_installer::rollback_windows_installer_repair,
            notifications::is_macos_debug_build,
            notifications::app_build_type,
            notifications::send_notification_fallback,
            tailscale::tailscale_status,
            tailscale::tailscale_daemon_command_preview,
            tailscale::tailscale_daemon_start,
            tailscale::tailscale_daemon_stop,
            tailscale::tailscale_daemon_status,
            is_mobile_runtime
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application");

    app.run(|app_handle, event| {
        #[cfg(desktop)]
        if let RunEvent::ExitRequested { api, .. } = event {
            if !EXIT_CLEANUP_IN_PROGRESS.load(Ordering::SeqCst)
                && !keep_daemon_running_after_close(app_handle)
            {
                api.prevent_exit();
                EXIT_CLEANUP_IN_PROGRESS.store(true, Ordering::SeqCst);
                let app_handle = app_handle.clone();
                tauri::async_runtime::spawn(async move {
                    stop_managed_daemons_for_exit(app_handle.clone()).await;
                    app_handle.exit(0);
                });
            }
            return;
        }

        #[cfg(target_os = "macos")]
        if let RunEvent::Reopen { .. } = event {
            show_main_window(app_handle);
        }
    });
}
