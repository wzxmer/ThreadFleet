//! Local Windows storage relocation. Stable aliases preserve history and other clients.
use std::path::{Path, PathBuf};
use std::process::Stdio;

use serde::{Deserialize, Serialize};

use crate::types::AppSettings;

const WORKER: &str = include_str!("../../resources/storage-migration.ps1");

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StorageLocation {
    pub(crate) kind: String,
    pub(crate) alias: PathBuf,
    pub(crate) source: PathBuf,
    pub(crate) destination: PathBuf,
    pub(crate) backup: PathBuf,
    pub(crate) was_link: bool,
    #[serde(default)]
    pub(crate) switched: bool,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StoragePlan {
    pub(crate) version: u32,
    pub(crate) id: String,
    pub(crate) root: PathBuf,
    pub(crate) status: String,
    pub(crate) error: Option<String>,
    pub(crate) locations: Vec<StorageLocation>,
    #[serde(default)]
    pub(crate) backups_cleaned: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StorageStatus {
    pub(crate) supported: bool,
    pub(crate) control_path: PathBuf,
    pub(crate) plan: Option<StoragePlan>,
    pub(crate) locations: Vec<StorageLocation>,
    pub(crate) maintenance: MaintenancePolicy,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct MaintenancePolicy {
    pub(crate) enabled: bool,
    pub(crate) retention_days: u32,
    pub(crate) cache_roots: Vec<PathBuf>,
    pub(crate) artifact_roots: Vec<PathBuf>,
    pub(crate) last_run: Option<String>,
    pub(crate) removed_files: u64,
    pub(crate) removed_bytes: u64,
    pub(crate) error: Option<String>,
    pub(crate) status: String,
}

impl Default for MaintenancePolicy {
    fn default() -> Self {
        Self {
            enabled: false,
            retention_days: 30,
            cache_roots: Vec::new(),
            artifact_roots: Vec::new(),
            last_run: None,
            removed_files: 0,
            removed_bytes: 0,
            error: None,
            status: "idle".into(),
        }
    }
}

pub(crate) fn read_maintenance(control: &Path) -> Result<MaintenancePolicy, String> {
    let mut policy: MaintenancePolicy = match std::fs::read(control.join("maintenance.json")) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| e.to_string())?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => MaintenancePolicy::default(),
        Err(e) => return Err(e.to_string()),
    };
    if let Ok(bytes) = std::fs::read(control.join("maintenance-result.json")) {
        let result: MaintenancePolicy =
            serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
        policy.last_run = result.last_run;
        policy.removed_files = result.removed_files;
        policy.removed_bytes = result.removed_bytes;
        policy.status = result.status;
        policy.error = result.error;
    }
    Ok(policy)
}

pub(crate) fn path_within(child: &Path, parent: &Path) -> bool {
    #[cfg(windows)]
    {
        PathBuf::from(child.to_string_lossy().to_lowercase())
            .starts_with(PathBuf::from(parent.to_string_lossy().to_lowercase()))
    }
    #[cfg(not(windows))]
    {
        child.starts_with(parent)
    }
}

fn is_reparse(path: &Path) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        std::fs::symlink_metadata(path).is_ok_and(|m| m.file_attributes() & 0x400 != 0)
    }
    #[cfg(not(windows))]
    {
        std::fs::symlink_metadata(path).is_ok_and(|m| m.is_symlink())
    }
}

pub(crate) fn control_dir() -> Result<PathBuf, String> {
    std::env::var_os("LOCALAPPDATA")
        .map(|p| PathBuf::from(p).join("ThreadFleet").join("storage-control"))
        .ok_or_else(|| "Local application data directory is unavailable".into())
}

pub(crate) fn read_plan(control: &Path) -> Result<Option<StoragePlan>, String> {
    let path = control.join("plan.json");
    match std::fs::read(&path) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(|e| e.to_string()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

pub(crate) fn build_locations(
    settings: &AppSettings,
    data_dir: &Path,
    local_dir: &Path,
    home: &Path,
    root: &Path,
    id: &str,
) -> Result<Vec<StorageLocation>, String> {
    let mut roots = vec![
        ("app-data".to_string(), data_dir.to_path_buf()),
        ("app-cache".to_string(), local_dir.to_path_buf()),
        ("codex".to_string(), home.join(".codex")),
        ("gemini".to_string(), home.join(".gemini")),
    ];
    if let Some(path) = crate::codex::home::resolve_settings_codex_home(settings) {
        roots.push(("codex-custom".into(), path));
    }
    if let Some(path) = settings.artifact_root.as_deref() {
        roots.push(("artifacts-custom".into(), PathBuf::from(path)));
    }
    let mut locations: Vec<StorageLocation> = Vec::new();
    for (kind, alias) in roots {
        // Skip children already covered by a parent (e.g. default artifacts).
        if locations
            .iter()
            .any(|entry| path_within(&alias, &entry.alias))
        {
            continue;
        }
        if locations
            .iter()
            .any(|entry| path_within(&entry.alias, &alias))
        {
            return Err(
                "Storage locations overlap; choose independent data directories first".into(),
            );
        }
        if !alias.is_absolute() {
            return Err("Storage source must be an absolute path".into());
        }
        let source = if alias.exists() {
            let canonical = std::fs::canonicalize(&alias).map_err(|e| e.to_string())?;
            PathBuf::from(crate::utils::normalize_windows_namespace_path(
                &canonical.to_string_lossy(),
            ))
        } else {
            alias.clone()
        };
        let was_link = is_reparse(&alias);
        if locations
            .iter()
            .any(|entry| path_within(&source, &entry.source) || path_within(&entry.source, &source))
        {
            return Err("Physical storage sources overlap".into());
        }
        locations.push(StorageLocation {
            kind: kind.clone(),
            backup: alias.with_file_name(format!(
                "{}.tf-backup-{id}",
                alias
                    .file_name()
                    .ok_or("Invalid storage source")?
                    .to_string_lossy()
            )),
            alias,
            source,
            destination: root.join(kind),
            was_link,
            switched: false,
        });
    }
    Ok(locations)
}

pub(crate) fn validate_target(
    root: &Path,
    locations: &[StorageLocation],
    control: &Path,
) -> Result<(), String> {
    if !root.is_absolute()
        || root.parent().is_none()
        || path_within(root, control)
        || path_within(control, root)
        || root
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err("Choose a dedicated absolute data directory".into());
    }
    // Resolve existing ancestors to reject a target reached through a junction.
    let mut ancestor = root;
    while !ancestor.exists() {
        ancestor = ancestor.parent().ok_or("Target drive is unavailable")?;
    }
    let physical = std::fs::canonicalize(ancestor).map_err(|e| e.to_string())?;
    let physical = PathBuf::from(crate::utils::normalize_windows_namespace_path(
        &physical.to_string_lossy(),
    ))
    .join(root.strip_prefix(ancestor).map_err(|e| e.to_string())?);
    for location in locations {
        for path in [&location.alias, &location.source] {
            if path_within(control, path) || path_within(path, control) {
                return Err("Storage sources must not overlap migration controls".into());
            }
            if path_within(&physical, path) || path_within(path, &physical) {
                return Err(
                    "The new directory must not contain or be inside an existing storage location"
                        .into(),
                );
            }
        }
    }
    if root.exists()
        && (!root.is_dir()
            || std::fs::read_dir(root)
                .map_err(|e| e.to_string())?
                .next()
                .is_some())
    {
        return Err("Choose an empty directory; existing files will not be merged".into());
    }
    Ok(())
}

pub(crate) fn write_plan(control: &Path, plan: &StoragePlan) -> Result<(), String> {
    write_json(control, "plan.json", plan)
}

pub(crate) fn write_json(control: &Path, name: &str, value: &impl Serialize) -> Result<(), String> {
    std::fs::create_dir_all(control).map_err(|e| e.to_string())?;
    let path = control.join(name);
    let temporary = control.join(format!("plan-{}.tmp", uuid::Uuid::new_v4()));
    std::fs::write(
        &temporary,
        serde_json::to_vec_pretty(value).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::{
            MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
        };
        let from: Vec<u16> = temporary.as_os_str().encode_wide().chain(Some(0)).collect();
        let to: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        if unsafe {
            MoveFileExW(
                from.as_ptr(),
                to.as_ptr(),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
        } == 0
        {
            return Err(std::io::Error::last_os_error().to_string());
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        std::fs::rename(temporary, path).map_err(|e| e.to_string())
    }
}

pub(crate) fn spawn_worker(control: &Path, mode: &str) -> Result<(), String> {
    if !cfg!(target_os = "windows") {
        return Err("Storage relocation currently requires Windows".into());
    }
    std::fs::create_dir_all(control).map_err(|e| e.to_string())?;
    if mode != "Maintenance" {
        // A worker waiting for clients already owns this lock. Avoid another
        // UAC prompt when TF is reopened before all clients have exited.
        let mut options = std::fs::OpenOptions::new();
        options.read(true).write(true).create(true).truncate(false);
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            options.share_mode(0);
        }
        match options.open(control.join("migration-worker.lock")) {
            Ok(file) => drop(file),
            Err(error) if matches!(error.raw_os_error(), Some(32 | 33)) => return Ok(()),
            Err(error) => return Err(error.to_string()),
        }
    }
    use sha2::{Digest, Sha256};
    let revision = format!("{:x}", Sha256::digest(WORKER.as_bytes()));
    let script = control.join(format!("storage-{}.ps1", &revision[..16]));
    // UTF-8 BOM keeps Windows PowerShell 5.1 Unicode paths intact.
    if !script.exists() {
        std::fs::write(&script, format!("\u{feff}{WORKER}")).map_err(|e| e.to_string())?;
    }
    let shell = std::env::var_os("SystemRoot")
        .map(PathBuf::from)
        .ok_or("Windows directory unavailable")?
        .join("System32/WindowsPowerShell/v1.0/powershell.exe");
    #[cfg(windows)]
    if mode == "Migrate" {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::UI::Shell::ShellExecuteW;
        use windows_sys::Win32::UI::WindowsAndMessaging::SW_HIDE;
        // Admin-owned junctions work for clients enforcing Windows redirection
        // trust. Never disable that protection or silently create unreadable links.
        let wide =
            |value: &std::ffi::OsStr| value.encode_wide().chain(Some(0)).collect::<Vec<u16>>();
        let arguments = format!(
            "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File \"{}\" -ControlDir \"{}\" -Mode Migrate",
            script.display(), control.display()
        );
        let verb = wide(std::ffi::OsStr::new("runas"));
        let executable = wide(shell.as_os_str());
        let parameters = wide(std::ffi::OsStr::new(&arguments));
        let result = unsafe {
            ShellExecuteW(
                std::ptr::null_mut(),
                verb.as_ptr(),
                executable.as_ptr(),
                parameters.as_ptr(),
                std::ptr::null(),
                SW_HIDE,
            )
        } as isize;
        if result <= 32 {
            return Err(format!(
                "Windows administrator confirmation was cancelled or unavailable (code {result})"
            ));
        }
        return Ok(());
    }
    crate::shared::process_core::std_command(shell)
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
        ])
        .arg(script)
        .arg("-ControlDir")
        .arg(control)
        .arg("-Mode")
        .arg(mode)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_overlapping_nonempty_and_relative_targets() {
        let temp = std::env::temp_dir().join(format!("tf-storage-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&temp).unwrap();
        let locations = build_locations(
            &AppSettings::default(),
            &temp.join("data"),
            &temp.join("cache"),
            &temp.join("home"),
            &temp.join("new"),
            "test",
        )
        .unwrap();
        assert!(
            validate_target(&temp.join("data/child"), &locations, &temp.join("control")).is_err()
        );
        assert!(validate_target(&temp, &locations, &temp.join("control")).is_err());
        assert!(validate_target(Path::new("relative"), &locations, &temp.join("control")).is_err());
        assert!(validate_target(&temp.join("new"), &locations, &temp.join("control")).is_ok());
        std::fs::remove_dir_all(temp).unwrap();
    }

    #[test]
    fn custom_artifacts_inside_app_data_are_already_covered() {
        let temp = std::env::temp_dir().join(format!("tf-storage-{}", uuid::Uuid::new_v4()));
        let mut settings = AppSettings::default();
        settings.codex_home = Some(temp.join("home/.codex").to_string_lossy().into());
        settings.artifact_root = Some(temp.join("data/artifacts").to_string_lossy().into());
        let locations = build_locations(
            &settings,
            &temp.join("data"),
            &temp.join("cache"),
            &temp.join("home"),
            &temp.join("new"),
            "test",
        )
        .unwrap();
        assert_eq!(locations.len(), 4);
        assert!(locations
            .iter()
            .all(|entry| entry.destination.starts_with(temp.join("new"))));
    }

    #[test]
    fn maintenance_config_and_results_do_not_overwrite_each_other() {
        let temp = std::env::temp_dir().join(format!("tf-storage-{}", uuid::Uuid::new_v4()));
        let policy = MaintenancePolicy {
            enabled: true,
            retention_days: 60,
            ..Default::default()
        };
        write_json(&temp, "maintenance.json", &policy).unwrap();
        let result = MaintenancePolicy {
            last_run: Some("2026-10-19T00:00:00Z".into()),
            removed_bytes: 1234,
            ..Default::default()
        };
        write_json(&temp, "maintenance-result.json", &result).unwrap();
        let merged = read_maintenance(&temp).unwrap();
        assert!(merged.enabled);
        assert_eq!(merged.retention_days, 60);
        assert_eq!(merged.removed_bytes, 1234);
        assert_eq!(merged.last_run, result.last_run);
        write_json(&temp, "maintenance.json", &MaintenancePolicy::default()).unwrap();
        assert!(!read_maintenance(&temp).unwrap().enabled);
        assert_eq!(read_maintenance(&temp).unwrap().removed_bytes, 1234);
        std::fs::remove_dir_all(temp).unwrap();
    }

    #[test]
    fn default_maintenance_is_opt_in_and_paths_match_without_case_on_windows() {
        assert!(!MaintenancePolicy::default().enabled);
        assert!(!path_within(Path::new("/a/backup"), Path::new("/a/back")));
        #[cfg(windows)]
        assert!(path_within(
            Path::new(r"C:\Users\Data\child"),
            Path::new(r"c:\users\data")
        ));
    }
}
