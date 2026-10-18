//! Desktop-local storage settings. Remote hosts retain their own directory policy.
use std::path::PathBuf;
use tauri::{Manager, State};
use tokio::sync::Mutex;

use crate::shared::storage_migration_core::{self as core, StoragePlan, StorageStatus};
use crate::state::AppState;

static CONTROL_GATE: Mutex<()> = Mutex::const_new(());

pub(crate) fn show_startup_error(error: &str) {
    eprintln!("ThreadFleet storage startup blocked: {error}");
    #[cfg(windows)]
    {
        use windows_sys::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONERROR, MB_OK};
        let message: Vec<u16> = format!("ThreadFleet 数据目录暂不可用 / Storage unavailable\n\n{error}\n\n迁移控制目录 / Details: %LOCALAPPDATA%\\ThreadFleet\\storage-control").encode_utf16().chain(Some(0)).collect();
        let title: Vec<u16> = "ThreadFleet".encode_utf16().chain(Some(0)).collect();
        unsafe {
            MessageBoxW(
                std::ptr::null_mut(),
                message.as_ptr(),
                title.as_ptr(),
                MB_OK | MB_ICONERROR,
            );
        }
    }
}

fn locations(
    settings: &crate::types::AppSettings,
    app: &tauri::AppHandle,
    root: &std::path::Path,
    id: &str,
) -> Result<Vec<core::StorageLocation>, String> {
    core::build_locations(
        settings,
        &app.path().app_data_dir().map_err(|e| e.to_string())?,
        &app.path().app_local_data_dir().map_err(|e| e.to_string())?,
        &PathBuf::from(std::env::var_os("USERPROFILE").ok_or("User profile unavailable")?),
        root,
        id,
    )
}

#[tauri::command]
pub(crate) async fn get_storage_status(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<StorageStatus, String> {
    if !cfg!(target_os = "windows") {
        return Ok(StorageStatus {
            supported: false,
            control_path: PathBuf::new(),
            plan: None,
            locations: Vec::new(),
            maintenance: Default::default(),
        });
    }
    let settings = state.app_settings.lock().await.clone();
    let control = core::control_dir()?;
    let plan = core::read_plan(&control)?;
    let root = plan
        .as_ref()
        .map(|p| p.root.clone())
        .unwrap_or_else(|| PathBuf::from(r"D:\ThreadFleetData"));
    Ok(StorageStatus {
        supported: true,
        locations: locations(&settings, &app, &root, "preview")?,
        maintenance: core::read_maintenance(&control)?,
        control_path: control,
        plan,
    })
}

#[tauri::command]
pub(crate) async fn set_storage_maintenance(
    enabled: bool,
    retention_days: u32,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let _gate = CONTROL_GATE.lock().await;
    if !cfg!(target_os = "windows") {
        return Err("Cache maintenance currently requires Windows".into());
    }
    if !(7..=365).contains(&retention_days) {
        return Err("Retention must be between 7 and 365 days".into());
    }
    let control = core::control_dir()?;
    let settings = state.app_settings.lock().await.clone();
    let local = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
    let data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let artifact = crate::shared::artifact_storage_core::artifact_root(
        &settings,
        &data.join("settings.json"),
    )?;
    let policy = core::MaintenancePolicy {
        enabled,
        retention_days,
        cache_roots: ["Cache", "Code Cache", "GPUCache"]
            .iter()
            .map(|name| local.join("EBWebView/Default").join(name))
            .collect(),
        artifact_roots: vec![artifact],
        ..Default::default()
    };
    core::write_json(&control, "maintenance.json", &policy)?;
    core::spawn_worker(&control, "Maintenance")
}

#[tauri::command]
pub(crate) async fn manage_storage(
    action: String,
    root: Option<String>,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let _gate = CONTROL_GATE.lock().await;
    if !cfg!(target_os = "windows") {
        return Err("Storage migration currently requires Windows".into());
    }
    let control = core::control_dir()?;
    let previous = core::read_plan(&control)?;
    if action == "cancel" {
        if let Some(mut plan) = previous.clone().filter(|p| p.status == "failed") {
            if plan
                .locations
                .iter()
                .any(|entry| entry.switched || entry.backup.exists())
            {
                return Err("Restore the original data paths before cancelling".into());
            }
            plan.status = "cancelled".into();
            plan.error = None;
            return core::write_plan(&control, &plan);
        }
        if !previous
            .as_ref()
            .is_some_and(|p| matches!(p.status.as_str(), "queued" | "cleanup-queued"))
        {
            return Err("Only a waiting migration can be cancelled".into());
        }
        return std::fs::write(control.join("cancel"), b"cancel").map_err(|e| e.to_string());
    }
    if action == "cleanup" {
        if !previous
            .as_ref()
            .is_some_and(|p| p.status == "ready" && !p.backups_cleaned)
        {
            return Err("No old copies are available for cleanup".into());
        }
        let _ = std::fs::remove_file(control.join("cancel"));
        return core::spawn_worker(&control, "Cleanup");
    }
    if action == "retry" {
        if !previous.as_ref().is_some_and(|p| p.status == "failed") {
            return Err("No failed migration can be retried".into());
        }
        let _ = std::fs::remove_file(control.join("cancel"));
        return core::spawn_worker(&control, "Migrate");
    }
    if action != "schedule" {
        return Err("Unknown storage operation".into());
    }
    if previous.as_ref().is_some_and(|p| {
        !matches!(p.status.as_str(), "cancelled") && !(p.status == "ready" && p.backups_cleaned)
    }) {
        return Err("Finish, cancel, or clean up the existing migration first".into());
    }
    let root = PathBuf::from(root.ok_or("Data directory is required")?.trim());
    let id = uuid::Uuid::new_v4().to_string();
    let settings = state.app_settings.lock().await.clone();
    let locations = locations(&settings, &app, &root, &id)?;
    core::validate_target(&root, &locations, &control)?;
    let plan = StoragePlan {
        version: 1,
        id,
        root,
        status: "queued".into(),
        error: None,
        locations,
        backups_cleaned: false,
    };
    let _ = std::fs::remove_file(control.join("cancel"));
    core::write_plan(&control, &plan)?;
    if let Err(error) = core::spawn_worker(&control, "Migrate") {
        let mut failed = plan;
        failed.status = "failed".into();
        failed.error = Some(error.clone());
        core::write_plan(&control, &failed)?;
        return Err(error);
    }
    Ok(())
}

/// Do not open databases/WebView while the offline worker switches aliases.
pub(crate) fn startup_barrier() -> Result<(), String> {
    if !cfg!(target_os = "windows") {
        return Ok(());
    }
    let control = core::control_dir()?;
    let starting = control.join(format!("starting-{}", std::process::id()));
    struct Starting {
        path: std::path::PathBuf,
        file: Option<std::fs::File>,
    }
    impl Drop for Starting {
        fn drop(&mut self) {
            self.file.take();
            let _ = std::fs::remove_file(&self.path);
        }
    }
    let mut marker = None;
    let began = std::time::Instant::now();
    loop {
        if began.elapsed() > std::time::Duration::from_secs(3600) {
            return Err("Storage work is still in progress. Keep Agent clients closed and check the storage-control status before reopening ThreadFleet.".into());
        }
        let plan = core::read_plan(&control)?;
        let maintenance = core::read_maintenance(&control)?;
        let status = plan.as_ref().map(|p| p.status.as_str()).unwrap_or("idle");
        let maintenance_running = maintenance.status == "cleaning";
        let status =
            if maintenance_running && matches!(status, "idle" | "ready" | "failed" | "cancelled") {
                "cache-cleaning"
            } else {
                status
            };
        match status {
            "copying" | "switching" | "cleaning" | "recovering" | "cache-cleaning" => {
                if marker.is_none() {
                    #[cfg(windows)]
                    use std::os::windows::fs::OpenOptionsExt;
                    let mut options = std::fs::OpenOptions::new();
                    options.write(true).create(true).truncate(true);
                    #[cfg(windows)]
                    options.share_mode(0);
                    let file = options.open(&starting).map_err(|e| e.to_string())?;
                    marker = Some(Starting {
                        path: starting.clone(),
                        file: Some(file),
                    });
                    core::spawn_worker(
                        &control,
                        match status {
                            "cleaning" => "Cleanup",
                            "cache-cleaning" => "Maintenance",
                            _ => "Migrate",
                        },
                    )?;
                }
                std::thread::sleep(std::time::Duration::from_millis(500));
            }
            "recovery-required" => {
                return Err(plan.and_then(|p| p.error).unwrap_or_else(|| {
                    "Storage migration requires recovery; original copies are preserved".into()
                }))
            }
            "queued" | "cleanup-queued" if marker.is_some() => {
                std::thread::sleep(std::time::Duration::from_millis(500))
            }
            "queued" => {
                core::spawn_worker(&control, "Migrate")?;
                return Ok(());
            }
            "cleanup-queued" => {
                core::spawn_worker(&control, "Cleanup")?;
                return Ok(());
            }
            _ => {
                if maintenance.enabled {
                    core::spawn_worker(&control, "Maintenance")?;
                }
                return Ok(());
            }
        }
    }
}
