use std::collections::HashMap;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

#[cfg(desktop)]
use tauri::image::Image;
#[cfg(desktop)]
use tauri::menu::{CheckMenuItemBuilder, Menu, MenuEvent, MenuItemBuilder, PredefinedMenuItem};
#[cfg(desktop)]
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
#[cfg(desktop)]
use tauri::{Manager, Runtime};

#[cfg(desktop)]
const TRAY_ID: &str = "codex-monitor-tray";
#[cfg(desktop)]
const TRAY_OPEN_ID: &str = "tray_open";
#[cfg(desktop)]
const TRAY_HIDE_ID: &str = "tray_hide";
#[cfg(desktop)]
const TRAY_RESTART_ID: &str = "tray_restart";
#[cfg(desktop)]
const TRAY_CHECK_UPDATES_ID: &str = "tray_check_updates";
#[cfg(desktop)]
const TRAY_AUTOSTART_ID: &str = "tray_autostart";
#[cfg(desktop)]
const TRAY_QUIT_ID: &str = "tray_quit";
#[cfg(all(desktop, target_os = "macos"))]
const TRAY_ICON_BYTES: &[u8] = include_bytes!("../icons/tray-icon-template.png");
#[cfg(all(desktop, not(target_os = "macos")))]
const TRAY_ICON_BYTES: &[u8] = include_bytes!("../icons/tray-icon.png");
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TrayRecentThreadEntry {
    pub(crate) workspace_id: String,
    pub(crate) workspace_label: String,
    pub(crate) thread_id: String,
    pub(crate) thread_label: String,
    pub(crate) updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TraySessionUsage {
    pub(crate) session_label: String,
    pub(crate) weekly_label: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TrayLabels {
    pub(crate) open: String,
    pub(crate) hide: String,
    pub(crate) check_updates: String,
    pub(crate) launch_at_startup: String,
    pub(crate) restart: String,
    pub(crate) quit: String,
}

impl Default for TrayLabels {
    fn default() -> Self {
        Self {
            open: "Open ThreadFleet".into(),
            hide: "Hide Window".into(),
            check_updates: "Check for Updates...".into(),
            launch_at_startup: "Launch at Startup".into(),
            restart: "Restart".into(),
            quit: "Quit".into(),
        }
    }
}

#[derive(Default)]
pub(crate) struct TrayState {
    tray_threads: Mutex<Vec<TrayRecentThreadEntry>>,
    session_usage: Mutex<Option<TraySessionUsage>>,
    labels: Mutex<TrayLabels>,
}

#[tauri::command]
pub(crate) fn set_tray_recent_threads<R: tauri::Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, TrayState>,
    entries: Vec<TrayRecentThreadEntry>,
) -> Result<(), String> {
    let normalized = normalize_tray_threads(entries);
    {
        let mut tray_threads = state
            .tray_threads
            .lock()
            .map_err(|_| "failed to lock tray threads".to_string())?;
        if *tray_threads == normalized {
            return Ok(());
        }
        *tray_threads = normalized;
    }

    #[cfg(desktop)]
    update_tray_menu(&app, &state)?;

    Ok(())
}

#[tauri::command]
pub(crate) fn set_tray_session_usage<R: tauri::Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, TrayState>,
    usage: Option<TraySessionUsage>,
) -> Result<(), String> {
    let normalized = normalize_session_usage(usage);
    {
        let mut session_usage = state
            .session_usage
            .lock()
            .map_err(|_| "failed to lock tray session usage".to_string())?;
        if *session_usage == normalized {
            return Ok(());
        }
        *session_usage = normalized;
    }

    #[cfg(desktop)]
    update_tray_menu(&app, &state)?;

    Ok(())
}

#[cfg(desktop)]
pub(crate) fn initialize<R: Runtime>(
    app: &tauri::AppHandle<R>,
    state: &TrayState,
) -> tauri::Result<()> {
    let menu = build_tray_menu(app, state)?;
    #[cfg(target_os = "macos")]
    let builder = TrayIconBuilder::with_id(TRAY_ID)
        .menu(&menu)
        .tooltip("ThreadFleet")
        .show_menu_on_left_click(false)
        .icon(load_tray_icon()?)
        .icon_as_template(true)
        .on_tray_icon_event(handle_tray_icon_event::<R>)
        .on_menu_event(handle_tray_menu_event::<R>);

    #[cfg(not(target_os = "macos"))]
    let builder = TrayIconBuilder::with_id(TRAY_ID)
        .menu(&menu)
        .tooltip("ThreadFleet")
        .show_menu_on_left_click(false)
        .icon(load_tray_icon()?)
        .on_tray_icon_event(handle_tray_icon_event::<R>)
        .on_menu_event(handle_tray_menu_event::<R>);

    builder.build(app)?;
    Ok(())
}

#[tauri::command]
pub(crate) fn set_tray_labels<R: tauri::Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, TrayState>,
    labels: TrayLabels,
) -> Result<(), String> {
    let normalized = normalize_tray_labels(labels);
    {
        let mut current = state
            .labels
            .lock()
            .map_err(|_| "failed to lock tray labels".to_string())?;
        if *current == normalized {
            return Ok(());
        }
        *current = normalized;
    }

    #[cfg(desktop)]
    update_tray_menu(&app, &state)?;

    Ok(())
}

#[cfg(not(desktop))]
pub(crate) fn initialize<R: tauri::Runtime>(
    _app: &tauri::AppHandle<R>,
    _state: &TrayState,
) -> tauri::Result<()> {
    Ok(())
}

fn normalize_tray_threads(entries: Vec<TrayRecentThreadEntry>) -> Vec<TrayRecentThreadEntry> {
    let mut deduped = HashMap::<(String, String), TrayRecentThreadEntry>::new();
    for entry in entries.into_iter() {
        let workspace_id = entry.workspace_id.trim();
        let thread_id = entry.thread_id.trim();
        let thread_label = entry.thread_label.trim();
        let workspace_label = entry.workspace_label.trim();
        if workspace_id.is_empty()
            || thread_id.is_empty()
            || thread_label.is_empty()
            || workspace_label.is_empty()
        {
            continue;
        }
        let key = (workspace_id.to_string(), thread_id.to_string());
        let should_replace = deduped
            .get(&key)
            .map(|current| entry.updated_at > current.updated_at)
            .unwrap_or(true);
        if should_replace {
            deduped.insert(
                key,
                TrayRecentThreadEntry {
                    workspace_id: workspace_id.to_string(),
                    workspace_label: workspace_label.to_string(),
                    thread_id: thread_id.to_string(),
                    thread_label: thread_label.to_string(),
                    updated_at: entry.updated_at,
                },
            );
        }
    }

    let mut normalized: Vec<_> = deduped.into_values().collect();
    normalized.sort_by(|left, right| {
        right
            .updated_at
            .cmp(&left.updated_at)
            .then_with(|| left.thread_label.cmp(&right.thread_label))
            .then_with(|| left.workspace_label.cmp(&right.workspace_label))
    });
    normalized
}

fn normalize_session_usage(usage: Option<TraySessionUsage>) -> Option<TraySessionUsage> {
    let usage = usage?;
    let session_label = usage.session_label.trim();
    if session_label.is_empty() {
        return None;
    }
    let weekly_label = usage
        .weekly_label
        .as_ref()
        .map(|label| label.trim())
        .filter(|label| !label.is_empty())
        .map(ToString::to_string);

    Some(TraySessionUsage {
        session_label: session_label.to_string(),
        weekly_label,
    })
}

fn normalize_label(value: String, fallback: &str) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        fallback.to_string()
    } else {
        trimmed.to_string()
    }
}

fn normalize_tray_labels(labels: TrayLabels) -> TrayLabels {
    let fallback = TrayLabels::default();
    TrayLabels {
        open: normalize_label(labels.open, &fallback.open),
        hide: normalize_label(labels.hide, &fallback.hide),
        check_updates: normalize_label(labels.check_updates, &fallback.check_updates),
        launch_at_startup: normalize_label(labels.launch_at_startup, &fallback.launch_at_startup),
        restart: normalize_label(labels.restart, &fallback.restart),
        quit: normalize_label(labels.quit, &fallback.quit),
    }
}

#[cfg(desktop)]
fn update_tray_menu<R: Runtime>(
    app: &tauri::AppHandle<R>,
    state: &TrayState,
) -> Result<(), String> {
    let menu = build_tray_menu(app, state).map_err(|error| error.to_string())?;
    let tray = app
        .tray_by_id(TRAY_ID)
        .ok_or_else(|| "tray icon not initialized".to_string())?;
    tray.set_menu(Some(menu)).map_err(|error| error.to_string())
}

#[cfg(desktop)]
fn build_tray_menu<R: Runtime>(
    app: &tauri::AppHandle<R>,
    state: &TrayState,
) -> tauri::Result<Menu<R>> {
    let menu = Menu::new(app)?;
    let labels = state
        .labels
        .lock()
        .map(|labels| labels.clone())
        .unwrap_or_default();
    let autostart_enabled = crate::autostart::is_enabled_for_app(app).unwrap_or(false);
    let open_item = MenuItemBuilder::with_id(TRAY_OPEN_ID, &labels.open).build(app)?;
    menu.append(&open_item)?;
    let hide_item = MenuItemBuilder::with_id(TRAY_HIDE_ID, &labels.hide).build(app)?;
    menu.append(&hide_item)?;
    let window_separator = PredefinedMenuItem::separator(app)?;
    menu.append(&window_separator)?;
    let check_updates_item =
        MenuItemBuilder::with_id(TRAY_CHECK_UPDATES_ID, &labels.check_updates).build(app)?;
    menu.append(&check_updates_item)?;
    let autostart_item =
        CheckMenuItemBuilder::with_id(TRAY_AUTOSTART_ID, &labels.launch_at_startup)
            .checked(autostart_enabled)
            .build(app)?;
    menu.append(&autostart_item)?;
    let system_separator = PredefinedMenuItem::separator(app)?;
    menu.append(&system_separator)?;
    let restart_item = MenuItemBuilder::with_id(TRAY_RESTART_ID, &labels.restart).build(app)?;
    menu.append(&restart_item)?;
    let quit_item = MenuItemBuilder::with_id(TRAY_QUIT_ID, &labels.quit).build(app)?;
    menu.append(&quit_item)?;
    Ok(menu)
}

#[cfg(desktop)]
fn handle_tray_menu_event<R: Runtime>(app: &tauri::AppHandle<R>, event: MenuEvent) {
    match event.id().as_ref() {
        TRAY_OPEN_ID => show_main_window(app),
        TRAY_HIDE_ID => hide_main_window(app),
        TRAY_CHECK_UPDATES_ID => {
            let _ = app.emit("updater-check", ());
        }
        TRAY_AUTOSTART_ID => {
            let next_enabled = !crate::autostart::is_enabled_for_app(app).unwrap_or(false);
            if crate::autostart::set_enabled_for_app(app, next_enabled).is_ok() {
                if let Some(state) = app.try_state::<TrayState>() {
                    let _ = update_tray_menu(app, state.inner());
                }
            }
        }
        TRAY_RESTART_ID => app.request_restart(),
        TRAY_QUIT_ID => app.exit(0),
        _ => {}
    }
}

#[cfg(desktop)]
fn handle_tray_icon_event<R: Runtime>(tray: &tauri::tray::TrayIcon<R>, event: TrayIconEvent) {
    if matches!(
        event,
        TrayIconEvent::Click {
            button: MouseButton::Left,
            button_state: MouseButtonState::Up,
            ..
        }
    ) {
        toggle_main_window(&tray.app_handle());
    }
}

#[cfg(desktop)]
fn show_main_window<R: Runtime>(app: &tauri::AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

#[cfg(desktop)]
fn hide_main_window<R: Runtime>(app: &tauri::AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }
}

#[cfg(desktop)]
fn toggle_main_window<R: Runtime>(app: &tauri::AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let is_visible = window.is_visible().unwrap_or(false);
        if is_visible {
            let _ = window.hide();
        } else {
            let _ = window.show();
            let _ = window.unminimize();
            let _ = window.set_focus();
        }
    }
}

#[cfg(desktop)]
fn load_tray_icon() -> tauri::Result<Image<'static>> {
    Image::from_bytes(TRAY_ICON_BYTES).map(|image| image.to_owned())
}

#[cfg(test)]
mod tests {
    use super::{
        normalize_session_usage, normalize_tray_labels, normalize_tray_threads, TrayLabels,
        TrayRecentThreadEntry, TraySessionUsage,
    };

    fn recent_entry(
        workspace_id: &str,
        workspace_label: &str,
        thread_id: &str,
        thread_label: &str,
        updated_at: i64,
    ) -> TrayRecentThreadEntry {
        TrayRecentThreadEntry {
            workspace_id: workspace_id.to_string(),
            workspace_label: workspace_label.to_string(),
            thread_id: thread_id.to_string(),
            thread_label: thread_label.to_string(),
            updated_at,
        }
    }

    #[test]
    fn normalize_tray_threads_sorts_and_deduplicates_without_truncating() {
        let entries = vec![
            recent_entry("ws-1", "One", "t-1", "Alpha", 10),
            recent_entry("ws-2", "Two", "t-2", "Beta", 50),
            recent_entry("ws-1", "One", "t-1", "Alpha", 20),
            recent_entry(" ", "Two", "t-3", "Ignored", 30),
        ]
        .into_iter()
        .chain((0..12).map(|index| {
            recent_entry(
                "ws-extra",
                "Extra",
                &format!("t-extra-{index}"),
                &format!("Thread {index}"),
                index,
            )
        }))
        .collect();

        let normalized = normalize_tray_threads(entries);

        assert_eq!(normalized.len(), 14);
        assert_eq!(normalized[0].thread_id, "t-2");
        assert_eq!(normalized[1].thread_id, "t-1");
        assert_eq!(normalized[1].updated_at, 20);
        assert!(!normalized
            .iter()
            .any(|entry| entry.thread_label == "Ignored"));
    }

    #[test]
    fn normalize_session_usage_discards_blank_labels() {
        assert_eq!(normalize_session_usage(None), None);
        assert_eq!(
            normalize_session_usage(Some(TraySessionUsage {
                session_label: "   ".into(),
                weekly_label: None,
            })),
            None
        );
        assert_eq!(
            normalize_session_usage(Some(TraySessionUsage {
                session_label: " 12% used ".into(),
                weekly_label: Some(" 67% used ".into()),
            })),
            Some(TraySessionUsage {
                session_label: "12% used".into(),
                weekly_label: Some("67% used".into()),
            })
        );
    }

    #[test]
    fn normalize_tray_labels_uses_defaults_for_blank_values() {
        assert_eq!(
            normalize_tray_labels(TrayLabels {
                open: " 打开 ".into(),
                hide: " ".into(),
                check_updates: " 检查更新 ".into(),
                launch_at_startup: " ".into(),
                restart: " 重启 ".into(),
                quit: "退出".into(),
            }),
            TrayLabels {
                open: "打开".into(),
                hide: "Hide Window".into(),
                check_updates: "检查更新".into(),
                launch_at_startup: "Launch at Startup".into(),
                restart: "重启".into(),
                quit: "退出".into(),
            }
        );
    }
}
