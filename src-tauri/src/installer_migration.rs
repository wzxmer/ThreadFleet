use crate::shared::installer_migration_service::{
    execute_installer_migration, installer_migration_capability, InstallerMigrationCapability,
    InstallerMigrationExecutionResult, InstallerMigrationPreparationInput,
    InstallerMigrationPreparationResult, InstallerMigrationRecoveryStatus,
};

#[tauri::command]
pub(crate) fn windows_installer_migration_capability() -> InstallerMigrationCapability {
    installer_migration_capability()
}

#[tauri::command]
pub(crate) async fn windows_installer_migration_recovery_status(
    app_handle: tauri::AppHandle,
) -> Result<InstallerMigrationRecoveryStatus, String> {
    use tauri::Manager;

    let data_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|_| "Installer migration storage is unavailable.".to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        crate::shared::installer_migration_service::installer_migration_recovery_status(&data_dir)
    })
    .await
    .map_err(|_| "Installer migration recovery check failed.".to_string())?
}

#[tauri::command]
pub(crate) async fn prepare_windows_installer_migration(
    state: tauri::State<'_, crate::state::AppState>,
    input: InstallerMigrationPreparationInput,
) -> Result<InstallerMigrationPreparationResult, String> {
    let _guard = state.windows_installer_migration.lock().await;
    #[cfg(target_os = "windows")]
    {
        let preflight = tauri::async_runtime::spawn_blocking(move || {
            crate::shared::installer_migration_service::prepare_experimental_installer_migration(
                input,
            )
        })
        .await
        .map_err(|_| "Installer migration preflight task failed.".to_string())?
        .map_err(|_| "Installer migration preflight was rejected.".to_string())?;
        let mut authorization = state.windows_installer_migration_authorization.lock().await;
        Ok(authorization.authorize(preflight))
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = input;
        Err("Windows installer migration is unavailable on this platform.".into())
    }
}

#[tauri::command]
pub(crate) async fn execute_windows_installer_migration(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, crate::state::AppState>,
) -> Result<InstallerMigrationExecutionResult, String> {
    use tauri::Manager;

    let _guard = state.windows_installer_migration.lock().await;
    let pending_request = {
        let mut authorization = state.windows_installer_migration_authorization.lock().await;
        authorization.take_for_execution()
    };
    let data_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|_| "Installer migration storage is unavailable.".to_string())?;
    let request = match pending_request {
        Some(request) => request,
        None => {
            crate::shared::installer_migration_service::load_trusted_installer_migration_recovery(
                &data_dir,
            )?
            .ok_or_else(|| "No trusted installer migration authorization is pending.".to_string())?
        }
    };
    let result = tauri::async_runtime::spawn_blocking(move || {
        execute_installer_migration(&data_dir, request)
    })
    .await
    .map_err(|_| "installer migration worker task failed".to_string())?;
    state
        .windows_installer_migration_authorization
        .lock()
        .await
        .finish(&result);
    Ok(result)
}
