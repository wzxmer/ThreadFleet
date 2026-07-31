use super::installer_migration_core::{
    InstallerFamily, InstallerUiMode, MigrationIntent, MigrationTarget,
};
use super::installer_migration_engine::{
    ExactSourceMetadata, InstallerExit, MigrationBackend, MigrationBackendError, MigrationManifest,
    MigrationPhase, NsisSourceSnapshot, ObservedOwnership, PostInstallObservation,
    SourceMetadataKind, SourceRootSnapshot, TargetInstallerSnapshot,
};
use super::installer_migration_store::{
    MigrationStore, MigrationStoreError, TransactionLockGuard, TransactionLockOutcome,
};
use cab::Cabinet;
use msi::{Package, Select};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::ffi::{OsStr, OsString};
use std::fs::{self, File, OpenOptions};
use std::io::{Cursor, Read, Write};
use std::os::windows::ffi::{OsStrExt, OsStringExt};
use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};
use windows::core::{Interface, PCWSTR};
use windows::Win32::Foundation::RPC_E_CHANGED_MODE;
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoUninitialize, IPersistFile, CLSCTX_INPROC_SERVER,
    COINIT_APARTMENTTHREADED, STGM_READ,
};
use windows::Win32::UI::Shell::{IShellLinkW, ShellLink, SLGP_RAWPATH};
use windows_sys::Win32::Foundation::{
    CloseHandle, GetLastError, ERROR_INSUFFICIENT_BUFFER, ERROR_INVALID_PARAMETER, FILETIME,
    HANDLE, WAIT_OBJECT_0, WAIT_TIMEOUT,
};
use windows_sys::Win32::Security::{
    GetSidIdentifierAuthority, GetSidSubAuthority, GetSidSubAuthorityCount, GetTokenInformation,
    IsValidSid, TokenUser, TOKEN_QUERY, TOKEN_USER,
};
use windows_sys::Win32::Storage::FileSystem::SYNCHRONIZE;
use windows_sys::Win32::System::RemoteDesktop::ProcessIdToSessionId;
use windows_sys::Win32::System::Threading::{
    GetCurrentProcess, GetExitCodeProcess, GetProcessTimes, OpenProcess, OpenProcessToken,
    WaitForSingleObject, PROCESS_QUERY_LIMITED_INFORMATION,
};
use winreg::{
    enums::{
        HKEY_LOCAL_MACHINE, HKEY_USERS, KEY_READ, KEY_WOW64_32KEY, KEY_WOW64_64KEY, KEY_WRITE,
    },
    RegKey, RegValue,
};

const PRODUCT_NAMES: [&str; 2] = ["ThreadFleet", "Codex Monitor"];
const EXECUTABLE_NAMES: [&str; 2] = ["threadfleet.exe", "codex-monitor.exe"];
const UNINSTALL_ROOT: &str = r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall";
const PROFILE_LIST_ROOT: &str = r"SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList";
const REPARSE_POINT_ATTRIBUTE: u32 = 0x400;
const MAX_TREE_ENTRIES: usize = 65_536;
const MAX_TREE_BYTES: u64 = 4 * 1024 * 1024 * 1024;
const MAX_SHORTCUT_BYTES: u64 = 1024 * 1024;
const MAX_REGISTRY_VALUES: usize = 4_096;
const MAX_REGISTRY_VALUE_BYTES: usize = 1024 * 1024;
const MAX_MSI_STREAM_BYTES: u64 = 1024 * 1024 * 1024;
const INSTALL_RECEIPT_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
enum RegistryView {
    Registry32,
    Registry64,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
enum MetadataLocator {
    UserRegistry {
        sid: String,
        view: RegistryView,
        key_path: String,
    },
    Shortcut {
        sid: String,
        path: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RawRegistryValue {
    value_type: u32,
    bytes: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RegistrySnapshot {
    sid: String,
    view: RegistryView,
    key_path: String,
    values: BTreeMap<String, RawRegistryValue>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ShortcutSnapshot {
    sid: String,
    path: String,
    target: String,
    bytes: Vec<u8>,
}

#[derive(Debug, Clone)]
struct InstallerRecord {
    sid: Option<String>,
    view: RegistryView,
    key_path: String,
    family: ObservedOwnership,
    display_version: Option<String>,
    install_location: Option<String>,
    uninstall_string: Option<String>,
    product_code: Option<String>,
    registry: RegistrySnapshot,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ExactPresence {
    Present,
    Absent,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct InstallReceipt {
    schema_version: u32,
    transaction_id: String,
    artifact_sha256: String,
    product_code: String,
    operation: InstallOperation,
    launched: bool,
    process_id: Option<u32>,
    process_created_at_filetime: Option<u64>,
    exit_code: Option<i32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ExactProcessState {
    Running,
    Exited(Option<i32>),
    MissingOrReused,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
enum InstallOperation {
    Install,
    Rollback,
}

pub(crate) struct WindowsMigrationBackend<S = NativeWindowsMigrationSystem> {
    store: MigrationStore,
    system: S,
    transaction_lock: Option<TransactionLockGuard>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct NativeInstallerMigrationIdentity {
    pub(crate) process_id: u32,
    pub(crate) user_sid: String,
    pub(crate) session_id: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct NsisSourcePreflightSnapshot {
    pub(crate) ownership: ObservedOwnership,
    pub(crate) source_path: String,
    pub(crate) tree_sha256: String,
    pub(crate) metadata: Vec<ExactSourceMetadata>,
}

pub(crate) fn capture_native_installer_migration_identity(
) -> Result<NativeInstallerMigrationIdentity, MigrationBackendError> {
    let process_id = std::process::id();
    let mut session_id = 0u32;
    if unsafe { ProcessIdToSessionId(process_id, &mut session_id) } == 0 {
        return Err(last_windows_error(
            "failed to resolve installer migration process session",
        ));
    }

    let mut token = std::ptr::null_mut();
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
        return Err(last_windows_error(
            "failed to open installer migration process token",
        ));
    }
    let token = TokenHandle(token);
    let user_sid = token_user_sid(token.0)?;

    Ok(NativeInstallerMigrationIdentity {
        process_id,
        user_sid,
        session_id,
    })
}

pub(crate) fn current_native_installer_migration_time() -> Result<u64, MigrationBackendError> {
    let value = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| failure("system clock is before the Unix epoch"))?
        .as_millis();
    u64::try_from(value).map_err(|_| failure("system clock value is too large"))
}

pub(crate) fn preflight_installer_migration(
    intent: &MigrationIntent,
) -> Result<(NsisSourcePreflightSnapshot, TargetInstallerSnapshot), MigrationBackendError> {
    let mut system = NativeWindowsMigrationSystem;
    preflight_installer_migration_with(&mut system, intent)
}

trait ReadOnlyInstallerMigrationPreflight {
    fn observe_source(
        &mut self,
        intent: &MigrationIntent,
    ) -> Result<NsisSourcePreflightSnapshot, MigrationBackendError>;
    fn inspect_target(
        &mut self,
        target: &MigrationTarget,
        source: &NsisSourcePreflightSnapshot,
    ) -> Result<TargetInstallerSnapshot, MigrationBackendError>;
}

impl ReadOnlyInstallerMigrationPreflight for NativeWindowsMigrationSystem {
    fn observe_source(
        &mut self,
        intent: &MigrationIntent,
    ) -> Result<NsisSourcePreflightSnapshot, MigrationBackendError> {
        observe_nsis_source_read_only(intent)
    }

    fn inspect_target(
        &mut self,
        target: &MigrationTarget,
        source: &NsisSourcePreflightSnapshot,
    ) -> Result<TargetInstallerSnapshot, MigrationBackendError> {
        inspect_target_installer_for_root(target, &source.source_path)
    }
}

fn preflight_installer_migration_with<S: ReadOnlyInstallerMigrationPreflight>(
    system: &mut S,
    intent: &MigrationIntent,
) -> Result<(NsisSourcePreflightSnapshot, TargetInstallerSnapshot), MigrationBackendError> {
    let source = system.observe_source(intent)?;
    if source.ownership != ObservedOwnership::PureNsis {
        return Err(failure(
            "experimental installer migration requires pure NSIS ownership",
        ));
    }
    let target = system.inspect_target(&intent.target, &source)?;
    Ok((source, target))
}

impl WindowsMigrationBackend<NativeWindowsMigrationSystem> {
    pub(crate) fn native(store_root: PathBuf) -> Result<Self, String> {
        let store = MigrationStore::new(store_root).map_err(|error| error.to_string())?;
        Ok(Self::new(store, NativeWindowsMigrationSystem))
    }
}

impl<S> WindowsMigrationBackend<S> {
    fn new(store: MigrationStore, system: S) -> Self {
        Self {
            store,
            system,
            transaction_lock: None,
        }
    }

    fn require_transaction(&self, transaction_id: &str) -> Result<(), MigrationBackendError> {
        match self.transaction_lock.as_ref() {
            Some(lock) if lock.record().transaction_id == transaction_id => Ok(()),
            Some(_) => Err(MigrationBackendError::failure(
                "backend already holds a different transaction lease",
            )),
            None => Err(MigrationBackendError::failure(
                "backend mutation requires a transaction lease",
            )),
        }
    }

    fn transaction_path(&self, transaction_id: &str) -> Result<PathBuf, MigrationBackendError> {
        self.store
            .transaction_path(transaction_id)
            .map_err(store_error)
    }
}

trait WindowsMigrationSystem {
    fn now_unix_ms(&self) -> Result<u64, MigrationBackendError>;
    fn observe_nsis_source(
        &mut self,
        intent: &MigrationIntent,
        transaction_id: &str,
    ) -> Result<NsisSourceSnapshot, MigrationBackendError>;
    fn inspect_target_installer(
        &mut self,
        target: &MigrationTarget,
        source: &NsisSourceSnapshot,
    ) -> Result<TargetInstallerSnapshot, MigrationBackendError>;
    fn validate_manifest_scope(
        &mut self,
        manifest: &MigrationManifest,
    ) -> Result<(), MigrationBackendError>;
    fn validate_manifest_recovery_state(
        &mut self,
        manifest: &MigrationManifest,
    ) -> Result<(), MigrationBackendError>;
    fn detach_source_root(
        &mut self,
        source: &SourceRootSnapshot,
    ) -> Result<(), MigrationBackendError>;
    fn verify_source_detached(
        &mut self,
        manifest: &MigrationManifest,
    ) -> Result<bool, MigrationBackendError>;
    fn remove_exact_source_metadata(
        &mut self,
        metadata: &ExactSourceMetadata,
    ) -> Result<(), MigrationBackendError>;
    fn install_target_msi(
        &mut self,
        transaction_id: &str,
        transaction_path: &Path,
        target: &TargetInstallerSnapshot,
        ui_mode: InstallerUiMode,
    ) -> Result<InstallerExit, MigrationBackendError>;
    fn observe_post_install(
        &mut self,
        manifest: &MigrationManifest,
    ) -> Result<PostInstallObservation, MigrationBackendError>;
    fn rollback_exact_target_msi(
        &mut self,
        transaction_id: &str,
        transaction_path: &Path,
        target: &TargetInstallerSnapshot,
    ) -> Result<(), MigrationBackendError>;
    fn restore_exact_source_metadata(
        &mut self,
        metadata: &ExactSourceMetadata,
    ) -> Result<(), MigrationBackendError>;
    fn restore_source_root(
        &mut self,
        source: &SourceRootSnapshot,
    ) -> Result<(), MigrationBackendError>;
    fn verify_source_restored(
        &mut self,
        manifest: &MigrationManifest,
    ) -> Result<bool, MigrationBackendError>;
}

impl<S: WindowsMigrationSystem> MigrationBackend for WindowsMigrationBackend<S> {
    fn now_unix_ms(&self) -> u64 {
        self.system.now_unix_ms().unwrap_or(0)
    }

    fn begin_transaction(&mut self, transaction_id: &str) -> Result<(), MigrationBackendError> {
        if let Some(lock) = self.transaction_lock.as_ref() {
            return if lock.record().transaction_id == transaction_id {
                Ok(())
            } else {
                Err(MigrationBackendError::failure(
                    "backend already holds a different transaction lease",
                ))
            };
        }
        self.transaction_lock = Some(
            match self
                .store
                .acquire_transaction_lock(transaction_id)
                .map_err(store_error)?
            {
                TransactionLockOutcome::Acquired(lock) => lock,
                TransactionLockOutcome::Existing(_) | TransactionLockOutcome::Busy => {
                    return Err(MigrationBackendError::failure(
                        "installer migration transaction is already owned by another process",
                    ))
                }
            },
        );
        Ok(())
    }

    fn load_manifest(
        &mut self,
        intent_id: &str,
    ) -> Result<Option<MigrationManifest>, MigrationBackendError> {
        self.store.load_manifest(intent_id).map_err(store_error)
    }

    fn persist_manifest(
        &mut self,
        manifest: &MigrationManifest,
    ) -> Result<(), MigrationBackendError> {
        self.require_transaction(&manifest.transaction_id)?;
        self.store
            .persist_manifest(
                manifest,
                self.transaction_lock
                    .as_ref()
                    .expect("transaction was checked above"),
            )
            .map_err(store_error)
    }

    fn claim_continuation_grant(
        &mut self,
        grant_digest: &str,
        intent_id: &str,
        transaction_id: &str,
    ) -> Result<(), MigrationBackendError> {
        self.require_transaction(transaction_id)?;
        self.store
            .claim_grant(grant_digest, intent_id, transaction_id)
            .map_err(store_error)
    }

    fn observe_nsis_source(
        &mut self,
        intent: &MigrationIntent,
        transaction_id: &str,
    ) -> Result<NsisSourceSnapshot, MigrationBackendError> {
        self.require_transaction(transaction_id)?;
        self.system.observe_nsis_source(intent, transaction_id)
    }

    fn inspect_target_installer(
        &mut self,
        target: &MigrationTarget,
        source: &NsisSourceSnapshot,
    ) -> Result<TargetInstallerSnapshot, MigrationBackendError> {
        self.system.inspect_target_installer(target, source)
    }

    fn validate_manifest_scope(
        &mut self,
        manifest: &MigrationManifest,
    ) -> Result<(), MigrationBackendError> {
        self.require_transaction(&manifest.transaction_id)?;
        self.system.validate_manifest_scope(manifest)
    }

    fn validate_manifest_recovery_state(
        &mut self,
        manifest: &MigrationManifest,
    ) -> Result<(), MigrationBackendError> {
        self.system.validate_manifest_recovery_state(manifest)
    }

    fn detach_source_root(
        &mut self,
        transaction_id: &str,
        source: &SourceRootSnapshot,
    ) -> Result<(), MigrationBackendError> {
        self.require_transaction(transaction_id)?;
        self.system.detach_source_root(source)
    }

    fn verify_source_detached(
        &mut self,
        manifest: &MigrationManifest,
    ) -> Result<bool, MigrationBackendError> {
        self.system.verify_source_detached(manifest)
    }

    fn remove_exact_source_metadata(
        &mut self,
        transaction_id: &str,
        metadata: &ExactSourceMetadata,
    ) -> Result<(), MigrationBackendError> {
        self.require_transaction(transaction_id)?;
        self.system.remove_exact_source_metadata(metadata)
    }

    fn install_target_msi(
        &mut self,
        transaction_id: &str,
        target: &TargetInstallerSnapshot,
        ui_mode: InstallerUiMode,
    ) -> Result<InstallerExit, MigrationBackendError> {
        self.require_transaction(transaction_id)?;
        let transaction_path = self.transaction_path(transaction_id)?;
        self.system
            .install_target_msi(transaction_id, &transaction_path, target, ui_mode)
    }

    fn observe_post_install(
        &mut self,
        manifest: &MigrationManifest,
    ) -> Result<PostInstallObservation, MigrationBackendError> {
        self.system.observe_post_install(manifest)
    }

    fn rollback_exact_target_msi(
        &mut self,
        transaction_id: &str,
        target: &TargetInstallerSnapshot,
    ) -> Result<(), MigrationBackendError> {
        self.require_transaction(transaction_id)?;
        let transaction_path = self.transaction_path(transaction_id)?;
        self.system
            .rollback_exact_target_msi(transaction_id, &transaction_path, target)
    }

    fn restore_exact_source_metadata(
        &mut self,
        transaction_id: &str,
        metadata: &ExactSourceMetadata,
    ) -> Result<(), MigrationBackendError> {
        self.require_transaction(transaction_id)?;
        self.system.restore_exact_source_metadata(metadata)
    }

    fn restore_source_root(
        &mut self,
        transaction_id: &str,
        source: &SourceRootSnapshot,
    ) -> Result<(), MigrationBackendError> {
        self.require_transaction(transaction_id)?;
        self.system.restore_source_root(source)
    }

    fn verify_source_restored(
        &mut self,
        manifest: &MigrationManifest,
    ) -> Result<bool, MigrationBackendError> {
        self.system.verify_source_restored(manifest)
    }
}

fn store_error(error: MigrationStoreError) -> MigrationBackendError {
    MigrationBackendError::failure(error.to_string())
}

pub(crate) struct NativeWindowsMigrationSystem;

impl WindowsMigrationSystem for NativeWindowsMigrationSystem {
    fn now_unix_ms(&self) -> Result<u64, MigrationBackendError> {
        current_native_installer_migration_time()
    }

    fn observe_nsis_source(
        &mut self,
        intent: &MigrationIntent,
        transaction_id: &str,
    ) -> Result<NsisSourceSnapshot, MigrationBackendError> {
        validate_uuid(transaction_id, "transaction ID")?;
        let observed = observe_nsis_source_read_only(intent)?;
        if observed.ownership != ObservedOwnership::PureNsis {
            return Ok(NsisSourceSnapshot {
                ownership: observed.ownership,
                root: empty_root_snapshot(),
                metadata: Vec::new(),
            });
        }
        let source_root = PathBuf::from(&observed.source_path);
        let backup_path = derived_source_backup_path(&source_root, transaction_id)?;
        Ok(NsisSourceSnapshot {
            ownership: observed.ownership,
            root: SourceRootSnapshot {
                source_path: observed.source_path,
                backup_path: path_text(&backup_path)?,
                tree_sha256: observed.tree_sha256,
            },
            metadata: observed.metadata,
        })
    }

    fn inspect_target_installer(
        &mut self,
        target: &MigrationTarget,
        source: &NsisSourceSnapshot,
    ) -> Result<TargetInstallerSnapshot, MigrationBackendError> {
        inspect_target_installer_for_root(target, &source.root.source_path)
    }

    fn validate_manifest_scope(
        &mut self,
        manifest: &MigrationManifest,
    ) -> Result<(), MigrationBackendError> {
        validate_uuid(&manifest.transaction_id, "transaction ID")?;
        let source = PathBuf::from(&manifest.source.root.source_path);
        let expected_backup = derived_source_backup_path(&source, &manifest.transaction_id)?;
        if normalize_path(&expected_backup)
            != normalize_path(Path::new(&manifest.source.root.backup_path))
        {
            return Err(failure(
                "source backup path is not derived from this transaction",
            ));
        }
        validate_source_root_scope(&source)?;
        validate_product_code(&manifest.target.product_code)?;
        let target_path = PathBuf::from(&manifest.target.artifact_path);
        validate_absolute_normal_path(&target_path, "target MSI")?;
        if matches!(
            manifest.phase,
            MigrationPhase::Prepared
                | MigrationPhase::GrantConsumptionPending
                | MigrationPhase::GrantConsumed
                | MigrationPhase::SourceDetachPending
                | MigrationPhase::SourceDetached
                | MigrationPhase::MetadataRemovalPending
                | MigrationPhase::MetadataRemoved
                | MigrationPhase::TargetInstallPending
        ) {
            validate_regular_file(&target_path, Some(manifest.target.artifact_size))?;
            if hash_file(&target_path)? != manifest.target.artifact_sha256 {
                return Err(failure(
                    "target MSI changed after the manifest was prepared",
                ));
            }
            verify_authenticode(&target_path)?;
        }
        for metadata in &manifest.source.metadata {
            validate_metadata_scope(metadata)?;
            if metadata.kind == SourceMetadataKind::Shortcut {
                let shortcut: ShortcutSnapshot = serde_json::from_slice(&metadata.snapshot)
                    .map_err(|error| failure(format!("invalid shortcut snapshot: {error}")))?;
                validate_shortcut_target(Path::new(&shortcut.target), &source)?;
            }
        }
        Ok(())
    }

    fn validate_manifest_recovery_state(
        &mut self,
        manifest: &MigrationManifest,
    ) -> Result<(), MigrationBackendError> {
        let source_attached = root_matches(
            Path::new(&manifest.source.root.source_path),
            &manifest.source.root.tree_sha256,
        )?;
        let source_detached = root_matches(
            Path::new(&manifest.source.root.backup_path),
            &manifest.source.root.tree_sha256,
        )?;
        if source_attached && source_detached {
            return Err(failure("source root and backup both exist"));
        }
        let mut presence = Vec::with_capacity(manifest.source.metadata.len());
        for item in &manifest.source.metadata {
            presence.push(metadata_presence(item)? == ExactPresence::Present);
        }
        let removed = presence.iter().take_while(|present| !**present).count();
        if presence.iter().skip(removed).any(|present| !*present) {
            return Err(failure("exact source metadata progress is not contiguous"));
        }
        let target_installed = match observe_exact_target(&manifest.target)? {
            Some(record) if observation_matches_target(&record, &manifest.target) => true,
            Some(_) => return Err(failure("target MSI product registration drifted")),
            None => false,
        };
        let rollback_remaining = manifest
            .removed_metadata_count
            .saturating_sub(manifest.restored_metadata_count);
        let valid = match manifest.phase {
            MigrationPhase::Prepared
            | MigrationPhase::GrantConsumptionPending
            | MigrationPhase::GrantConsumed => {
                source_attached && !source_detached && removed == 0 && !target_installed
            }
            MigrationPhase::SourceDetachPending => {
                (source_attached ^ source_detached) && removed == 0 && !target_installed
            }
            MigrationPhase::SourceDetached => {
                !source_attached
                    && source_detached
                    && removed == manifest.removed_metadata_count
                    && !target_installed
            }
            MigrationPhase::MetadataRemovalPending => {
                !source_attached
                    && source_detached
                    && matches!(removed, value if value == manifest.removed_metadata_count || value == manifest.removed_metadata_count + 1)
                    && !target_installed
            }
            MigrationPhase::MetadataRemoved => {
                !source_attached
                    && source_detached
                    && removed == manifest.source.metadata.len()
                    && !target_installed
            }
            MigrationPhase::TargetInstallPending => {
                !source_attached && source_detached && removed == manifest.source.metadata.len()
            }
            MigrationPhase::TargetInstallReturned => {
                !source_attached
                    && source_detached
                    && removed == manifest.source.metadata.len()
                    && target_installed == matches!(manifest.target_exit_code, Some(0 | 3010))
            }
            MigrationPhase::Completed => {
                !source_attached
                    && source_detached
                    && removed == manifest.source.metadata.len()
                    && target_installed
            }
            MigrationPhase::RollbackTargetPending => {
                (source_attached ^ source_detached) && removed == manifest.removed_metadata_count
            }
            MigrationPhase::RollbackTargetCompleted => {
                (source_attached ^ source_detached)
                    && removed == manifest.removed_metadata_count
                    && !target_installed
            }
            MigrationPhase::RollbackMetadataPending => {
                (source_attached ^ source_detached)
                    && matches!(removed, value if value == rollback_remaining || value + 1 == rollback_remaining)
                    && !target_installed
            }
            MigrationPhase::RollbackMetadataCompleted => {
                (source_attached ^ source_detached) && removed == 0 && !target_installed
            }
            MigrationPhase::RollbackRootPending => removed == 0 && !target_installed,
            MigrationPhase::RolledBack => source_attached && !source_detached && removed == 0,
            MigrationPhase::RollbackFailed => removed == rollback_remaining,
        };
        if valid {
            Ok(())
        } else {
            Err(failure(
                "manifest progress does not match the live Windows installer state",
            ))
        }
    }

    fn detach_source_root(
        &mut self,
        source: &SourceRootSnapshot,
    ) -> Result<(), MigrationBackendError> {
        move_exact_tree(
            Path::new(&source.source_path),
            Path::new(&source.backup_path),
            &source.tree_sha256,
        )
    }

    fn verify_source_detached(
        &mut self,
        manifest: &MigrationManifest,
    ) -> Result<bool, MigrationBackendError> {
        Ok(!Path::new(&manifest.source.root.source_path).exists()
            && root_matches(
                Path::new(&manifest.source.root.backup_path),
                &manifest.source.root.tree_sha256,
            )?)
    }

    fn remove_exact_source_metadata(
        &mut self,
        metadata: &ExactSourceMetadata,
    ) -> Result<(), MigrationBackendError> {
        remove_metadata(metadata)
    }

    fn install_target_msi(
        &mut self,
        transaction_id: &str,
        transaction_path: &Path,
        target: &TargetInstallerSnapshot,
        ui_mode: InstallerUiMode,
    ) -> Result<InstallerExit, MigrationBackendError> {
        if let Some(observation) = observe_exact_target(target)? {
            if observation_matches_target(&observation, target) {
                return Ok(InstallerExit { code: 0 });
            }
            return Err(failure("target MSI product registration drifted"));
        }
        run_exact_msiexec(
            transaction_id,
            transaction_path,
            target,
            InstallOperation::Install,
            ui_mode,
        )
        .map(|code| InstallerExit { code })
    }

    fn observe_post_install(
        &mut self,
        manifest: &MigrationManifest,
    ) -> Result<PostInstallObservation, MigrationBackendError> {
        let exact = observe_exact_target(&manifest.target)?;
        let records = scan_product_records_from_all_users()?;
        let source_metadata_present = manifest
            .source
            .metadata
            .iter()
            .map(metadata_presence)
            .collect::<Result<Vec<_>, _>>()?
            .contains(&ExactPresence::Present);
        let ownership = classify_records(&records);
        let executable_hash = exact
            .as_ref()
            .and_then(|record| record.install_location.as_ref())
            .and_then(|root| find_main_executable(Path::new(root)).ok())
            .flatten()
            .map(|path| hash_file(&path))
            .transpose()?;
        Ok(PostInstallObservation {
            ownership,
            product_code: exact
                .as_ref()
                .and_then(|record| record.product_code.clone()),
            version: exact
                .as_ref()
                .and_then(|record| record.display_version.clone()),
            install_root: exact
                .as_ref()
                .and_then(|record| record.install_location.clone()),
            executable_sha256: executable_hash,
            source_metadata_present,
        })
    }

    fn rollback_exact_target_msi(
        &mut self,
        transaction_id: &str,
        transaction_path: &Path,
        target: &TargetInstallerSnapshot,
    ) -> Result<(), MigrationBackendError> {
        if observe_exact_target(target)?.is_none() {
            return Ok(());
        }
        let code = run_exact_msiexec(
            transaction_id,
            transaction_path,
            target,
            InstallOperation::Rollback,
            InstallerUiMode::Silent,
        )?;
        if !matches!(code, 0 | 1605 | 3010) {
            return Err(failure(format!(
                "exact MSI rollback returned exit code {code}"
            )));
        }
        if observe_exact_target(target)?.is_some() {
            return Err(failure(
                "exact MSI product remains registered after rollback",
            ));
        }
        Ok(())
    }

    fn restore_exact_source_metadata(
        &mut self,
        metadata: &ExactSourceMetadata,
    ) -> Result<(), MigrationBackendError> {
        restore_metadata(metadata)
    }

    fn restore_source_root(
        &mut self,
        source: &SourceRootSnapshot,
    ) -> Result<(), MigrationBackendError> {
        move_exact_tree(
            Path::new(&source.backup_path),
            Path::new(&source.source_path),
            &source.tree_sha256,
        )
    }

    fn verify_source_restored(
        &mut self,
        manifest: &MigrationManifest,
    ) -> Result<bool, MigrationBackendError> {
        if !root_matches(
            Path::new(&manifest.source.root.source_path),
            &manifest.source.root.tree_sha256,
        )? || Path::new(&manifest.source.root.backup_path).exists()
            || observe_exact_target(&manifest.target)?.is_some()
        {
            return Ok(false);
        }
        for metadata in &manifest.source.metadata {
            if metadata_presence(metadata)? != ExactPresence::Present {
                return Ok(false);
            }
        }
        Ok(true)
    }
}

fn failure(message: impl Into<String>) -> MigrationBackendError {
    MigrationBackendError::failure(message)
}

fn last_windows_error(context: &str) -> MigrationBackendError {
    let code = unsafe { GetLastError() };
    failure(format!("{context}: Windows error {code}"))
}

struct TokenHandle(HANDLE);

impl Drop for TokenHandle {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
}

fn token_user_sid(token: HANDLE) -> Result<String, MigrationBackendError> {
    let mut required = 0u32;
    if unsafe { GetTokenInformation(token, TokenUser, std::ptr::null_mut(), 0, &mut required) } != 0
        || required < std::mem::size_of::<TOKEN_USER>() as u32
        || unsafe { GetLastError() } != ERROR_INSUFFICIENT_BUFFER
    {
        return Err(last_windows_error(
            "failed to size installer migration token identity",
        ));
    }

    let word_size = std::mem::size_of::<usize>();
    let word_count = (required as usize).div_ceil(word_size);
    let mut buffer = vec![0usize; word_count];
    if unsafe {
        GetTokenInformation(
            token,
            TokenUser,
            buffer.as_mut_ptr().cast(),
            required,
            &mut required,
        )
    } == 0
    {
        return Err(last_windows_error(
            "failed to read installer migration token identity",
        ));
    }
    let token_user = unsafe { &*buffer.as_ptr().cast::<TOKEN_USER>() };
    sid_to_canonical_string(token_user.User.Sid)
}

fn sid_to_canonical_string(
    sid: windows_sys::Win32::Security::PSID,
) -> Result<String, MigrationBackendError> {
    if sid.is_null() || unsafe { IsValidSid(sid) } == 0 {
        return Err(failure("installer migration token SID is invalid"));
    }
    let authority = unsafe { GetSidIdentifierAuthority(sid) };
    let sub_authority_count = unsafe { GetSidSubAuthorityCount(sid) };
    if authority.is_null() || sub_authority_count.is_null() {
        return Err(failure("installer migration token SID cannot be inspected"));
    }
    let authority_value = unsafe { (*authority).Value }
        .into_iter()
        .fold(0u64, |value, byte| (value << 8) | u64::from(byte));
    let count = usize::from(unsafe { *sub_authority_count });
    if count == 0 || count > 15 {
        return Err(failure(
            "installer migration token SID has an invalid authority count",
        ));
    }
    let mut text = format!("S-1-{authority_value}");
    for index in 0..count {
        let value = unsafe { GetSidSubAuthority(sid, index as u32) };
        if value.is_null() {
            return Err(failure(
                "installer migration token SID authority cannot be inspected",
            ));
        }
        text.push_str(&format!("-{}", unsafe { *value }));
    }
    if !sid_is_canonical(&text) {
        return Err(failure("installer migration token SID is not canonical"));
    }
    Ok(text)
}

fn empty_root_snapshot() -> SourceRootSnapshot {
    SourceRootSnapshot {
        source_path: String::new(),
        backup_path: String::new(),
        tree_sha256: String::new(),
    }
}

fn observe_nsis_source_read_only(
    intent: &MigrationIntent,
) -> Result<NsisSourcePreflightSnapshot, MigrationBackendError> {
    let records = scan_product_records_from_all_users()?;
    let ownership = classify_records(&records);
    if ownership != ObservedOwnership::PureNsis {
        return Ok(NsisSourcePreflightSnapshot {
            ownership,
            source_path: String::new(),
            tree_sha256: String::new(),
            metadata: Vec::new(),
        });
    }
    let nsis = records
        .iter()
        .filter(|record| record.family == ObservedOwnership::PureNsis)
        .collect::<Vec<_>>();
    validate_pure_nsis_records(&nsis, &intent.original_user_sid)?;
    let source_root = unique_source_root(&nsis)?;
    validate_source_root_path(&source_root)?;
    let tree_sha256 = hash_directory_tree(&source_root)?;
    let mut metadata = nsis
        .iter()
        .map(|record| registry_metadata(record))
        .collect::<Result<Vec<_>, _>>()?;
    metadata.extend(snapshot_shortcuts(&intent.original_user_sid, &source_root)?);
    metadata.sort_by(|left, right| left.locator.cmp(&right.locator));
    Ok(NsisSourcePreflightSnapshot {
        ownership,
        source_path: path_text(&source_root)?,
        tree_sha256,
        metadata,
    })
}

fn scan_product_records_from_all_users() -> Result<Vec<InstallerRecord>, MigrationBackendError> {
    let users = RegKey::predef(HKEY_USERS);
    let mut records = Vec::new();
    for sid in users.enum_keys() {
        let sid =
            sid.map_err(|error| failure(format!("failed to enumerate user hives: {error}")))?;
        if sid_is_canonical(&sid) {
            records.extend(scan_user_product_records(&sid)?);
        }
    }
    records.extend(scan_machine_product_records()?);
    records.sort_by(|left, right| {
        (&left.sid, left.view, &left.key_path).cmp(&(&right.sid, right.view, &right.key_path))
    });
    Ok(records)
}

fn scan_user_product_records(sid: &str) -> Result<Vec<InstallerRecord>, MigrationBackendError> {
    if !sid_is_canonical(sid) {
        return Err(failure("user SID is not canonical"));
    }
    let users = RegKey::predef(HKEY_USERS);
    let key_path = format!(r"{sid}\{UNINSTALL_ROOT}");
    let mut records = Vec::new();
    for view in [RegistryView::Registry32, RegistryView::Registry64] {
        records.extend(scan_uninstall_view(&users, Some(sid), &key_path, view)?);
    }
    Ok(records)
}

fn scan_machine_product_records() -> Result<Vec<InstallerRecord>, MigrationBackendError> {
    let machine = RegKey::predef(HKEY_LOCAL_MACHINE);
    let mut records = Vec::new();
    for view in [RegistryView::Registry32, RegistryView::Registry64] {
        records.extend(scan_uninstall_view(&machine, None, UNINSTALL_ROOT, view)?);
    }
    Ok(records)
}

fn scan_uninstall_view(
    root: &RegKey,
    sid: Option<&str>,
    root_path: &str,
    view: RegistryView,
) -> Result<Vec<InstallerRecord>, MigrationBackendError> {
    let uninstall = match root.open_subkey_with_flags(root_path, KEY_READ | view_flag(view)) {
        Ok(key) => key,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => {
            return Err(failure(format!(
                "failed to open uninstall registry view: {error}"
            )))
        }
    };
    let mut records = Vec::new();
    for subkey in uninstall.enum_keys() {
        let subkey = subkey
            .map_err(|error| failure(format!("failed to enumerate uninstall keys: {error}")))?;
        let key = uninstall
            .open_subkey_with_flags(&subkey, KEY_READ | view_flag(view))
            .map_err(|error| failure(format!("failed to open uninstall record: {error}")))?;
        let display_name = key.get_value::<String, _>("DisplayName").ok();
        if !display_name
            .as_deref()
            .is_some_and(|name| PRODUCT_NAMES.contains(&name))
        {
            continue;
        }
        if key.enum_keys().next().is_some() {
            return Err(failure("installer registration contains subkeys"));
        }
        let values = snapshot_registry_values(&key)?;
        let uninstall_string = key.get_value::<String, _>("UninstallString").ok();
        let windows_installer = key.get_value::<u32, _>("WindowsInstaller").ok();
        let family = if windows_installer == Some(1) && is_product_code(&subkey) {
            ObservedOwnership::PureMsi
        } else if uninstall_string
            .as_deref()
            .and_then(parse_strict_uninstall_path)
            .is_some()
        {
            ObservedOwnership::PureNsis
        } else {
            ObservedOwnership::Unknown
        };
        let relative_key_path = format!(r"{UNINSTALL_ROOT}\{subkey}");
        records.push(InstallerRecord {
            sid: sid.map(str::to_owned),
            view,
            key_path: relative_key_path.clone(),
            family,
            display_version: key.get_value("DisplayVersion").ok(),
            install_location: key.get_value("InstallLocation").ok(),
            uninstall_string,
            product_code: (family == ObservedOwnership::PureMsi).then_some(subkey),
            registry: RegistrySnapshot {
                sid: sid.unwrap_or("").into(),
                view,
                key_path: relative_key_path,
                values,
            },
        });
    }
    Ok(records)
}

fn snapshot_registry_values(
    key: &RegKey,
) -> Result<BTreeMap<String, RawRegistryValue>, MigrationBackendError> {
    let mut values = BTreeMap::new();
    for value in key.enum_values() {
        if values.len() >= MAX_REGISTRY_VALUES {
            return Err(failure("installer registry snapshot has too many values"));
        }
        let (name, value) = value.map_err(|error| {
            failure(format!("failed to read installer registry value: {error}"))
        })?;
        if value.bytes.len() > MAX_REGISTRY_VALUE_BYTES {
            return Err(failure("installer registry value exceeds the size limit"));
        }
        values.insert(
            name,
            RawRegistryValue {
                value_type: value.vtype as u32,
                bytes: value.bytes,
            },
        );
    }
    Ok(values)
}

fn classify_records(records: &[InstallerRecord]) -> ObservedOwnership {
    if records.is_empty()
        || records
            .iter()
            .any(|record| record.family == ObservedOwnership::Unknown)
    {
        return ObservedOwnership::Unknown;
    }
    let has_nsis = records
        .iter()
        .any(|record| record.family == ObservedOwnership::PureNsis);
    let has_msi = records
        .iter()
        .any(|record| record.family == ObservedOwnership::PureMsi);
    match (has_nsis, has_msi) {
        (true, false) => ObservedOwnership::PureNsis,
        (false, true) => ObservedOwnership::PureMsi,
        (true, true) => ObservedOwnership::Mixed,
        (false, false) => ObservedOwnership::Unknown,
    }
}

fn validate_pure_nsis_records(
    records: &[&InstallerRecord],
    initiating_sid: &str,
) -> Result<(), MigrationBackendError> {
    if records.is_empty()
        || records
            .iter()
            .any(|record| record.sid.as_deref() != Some(initiating_sid))
    {
        return Err(failure(
            "NSIS ownership is not bound to the initiating user SID",
        ));
    }
    if records
        .iter()
        .skip(1)
        .any(|record| !records_equivalent_ignoring_view(records[0], record))
    {
        return Err(failure("NSIS ownership has divergent registry records"));
    }
    Ok(())
}

fn unique_source_root(records: &[&InstallerRecord]) -> Result<PathBuf, MigrationBackendError> {
    let mut roots = BTreeSet::new();
    for record in records {
        let from_location = record
            .install_location
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .map(PathBuf::from);
        let from_uninstaller = record
            .uninstall_string
            .as_deref()
            .and_then(parse_strict_uninstall_path)
            .and_then(|path| path.parent().map(Path::to_path_buf));
        let root = match (from_location, from_uninstaller) {
            (Some(location), Some(uninstaller))
                if normalize_path(&location) == normalize_path(&uninstaller) =>
            {
                location
            }
            (None, Some(uninstaller)) => uninstaller,
            _ => {
                return Err(failure(
                    "NSIS install root evidence is missing or inconsistent",
                ))
            }
        };
        roots.insert(normalize_path(&root));
    }
    if roots.len() != 1 {
        return Err(failure(
            "NSIS registrations do not identify one source root",
        ));
    }
    Ok(PathBuf::from(
        roots.into_iter().next().expect("one root was checked"),
    ))
}

fn registry_metadata(
    record: &InstallerRecord,
) -> Result<ExactSourceMetadata, MigrationBackendError> {
    let sid = record
        .sid
        .as_ref()
        .ok_or_else(|| failure("NSIS registration is not in the initiating user hive"))?;
    let locator = MetadataLocator::UserRegistry {
        sid: sid.clone(),
        view: record.view,
        key_path: record.key_path.clone(),
    };
    exact_metadata(
        SourceMetadataKind::NsisUninstallRegistration,
        &locator,
        &record.registry,
    )
}

fn snapshot_shortcuts(
    sid: &str,
    source_root: &Path,
) -> Result<Vec<ExactSourceMetadata>, MigrationBackendError> {
    let profile = profile_path_for_sid(sid)?;
    let roots = [
        profile.join(r"AppData\Roaming\Microsoft\Windows\Start Menu\Programs"),
        profile.join("Desktop"),
    ];
    let mut snapshots = Vec::new();
    for root in roots {
        for name in ["ThreadFleet.lnk", "Codex Monitor.lnk"] {
            let path = root.join(name);
            let metadata = match fs::symlink_metadata(&path) {
                Ok(metadata) => metadata,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(error) => return Err(failure(format!("failed to inspect shortcut: {error}"))),
            };
            validate_regular_metadata(&metadata, Some(MAX_SHORTCUT_BYTES))?;
            validate_shortcut_path_in_profile(&path, &profile)?;
            let bytes = fs::read(&path)
                .map_err(|error| failure(format!("failed to read shortcut: {error}")))?;
            let target = read_shell_link_target(&path)?;
            validate_shortcut_target(&target, source_root)?;
            let final_metadata = fs::symlink_metadata(&path)
                .map_err(|error| failure(format!("failed to re-inspect shortcut: {error}")))?;
            validate_regular_metadata(&final_metadata, Some(MAX_SHORTCUT_BYTES))?;
            if fs::read(&path)
                .map_err(|error| failure(format!("failed to re-read shortcut: {error}")))?
                != bytes
            {
                return Err(failure("shortcut changed while it was being inspected"));
            }
            let locator = MetadataLocator::Shortcut {
                sid: sid.into(),
                path: path_text(&path)?,
            };
            let snapshot = ShortcutSnapshot {
                sid: sid.into(),
                path: path_text(&path)?,
                target: path_text(&target)?,
                bytes,
            };
            snapshots.push(exact_metadata(
                SourceMetadataKind::Shortcut,
                &locator,
                &snapshot,
            )?);
        }
    }
    Ok(snapshots)
}

struct ComInitialization(bool);

impl ComInitialization {
    fn current_thread() -> Result<Self, MigrationBackendError> {
        let status = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
        if status.is_ok() {
            Ok(Self(true))
        } else if status == RPC_E_CHANGED_MODE {
            Ok(Self(false))
        } else {
            Err(failure(format!(
                "failed to initialize COM for Shell Link inspection: {status:?}"
            )))
        }
    }
}

impl Drop for ComInitialization {
    fn drop(&mut self) {
        if self.0 {
            unsafe { CoUninitialize() };
        }
    }
}

fn read_shell_link_target(path: &Path) -> Result<PathBuf, MigrationBackendError> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| failure(format!("failed to inspect Shell Link: {error}")))?;
    validate_regular_metadata(&metadata, Some(MAX_SHORTCUT_BYTES))?;
    let _com = ComInitialization::current_thread()?;
    let link: IShellLinkW = unsafe {
        CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)
            .map_err(|error| failure(format!("failed to create Shell Link reader: {error}")))?
    };
    let persist: IPersistFile = link
        .cast()
        .map_err(|error| failure(format!("failed to access Shell Link persistence: {error}")))?;
    let path_wide = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    unsafe { persist.Load(PCWSTR(path_wide.as_ptr()), STGM_READ) }
        .map_err(|error| failure(format!("failed to load Shell Link: {error}")))?;
    let mut target = vec![0u16; 32_768];
    unsafe { link.GetPath(&mut target, std::ptr::null_mut(), SLGP_RAWPATH.0 as u32) }
        .map_err(|error| failure(format!("failed to resolve Shell Link target: {error}")))?;
    let length = target
        .iter()
        .position(|value| *value == 0)
        .unwrap_or(target.len());
    if length == 0 {
        return Err(failure("Shell Link target is empty"));
    }
    Ok(PathBuf::from(OsString::from_wide(&target[..length])))
}

fn profile_path_for_sid(sid: &str) -> Result<PathBuf, MigrationBackendError> {
    if !sid_is_canonical(sid) {
        return Err(failure("user SID is not canonical"));
    }
    let machine = RegKey::predef(HKEY_LOCAL_MACHINE);
    let key = machine
        .open_subkey_with_flags(format!(r"{PROFILE_LIST_ROOT}\{sid}"), KEY_READ)
        .map_err(|error| {
            failure(format!(
                "failed to resolve initiating user profile: {error}"
            ))
        })?;
    let raw: String = key.get_value("ProfileImagePath").map_err(|error| {
        failure(format!(
            "failed to read initiating user profile path: {error}"
        ))
    })?;
    let expanded = expand_profile_path(&raw)?;
    validate_absolute_normal_path(&expanded, "user profile")?;
    Ok(expanded)
}

fn expand_profile_path(raw: &str) -> Result<PathBuf, MigrationBackendError> {
    let system_drive = std::env::var("SystemDrive").unwrap_or_else(|_| "C:".into());
    let expanded = raw
        .replace("%SystemDrive%", &system_drive)
        .replace("%SYSTEMDRIVE%", &system_drive);
    if expanded.contains('%') {
        return Err(failure(
            "user profile path contains an unsupported environment variable",
        ));
    }
    Ok(PathBuf::from(expanded))
}

fn exact_metadata<T: Serialize>(
    kind: SourceMetadataKind,
    locator: &MetadataLocator,
    snapshot: &T,
) -> Result<ExactSourceMetadata, MigrationBackendError> {
    let locator = serde_json::to_string(locator)
        .map_err(|error| failure(format!("failed to serialize metadata locator: {error}")))?;
    let snapshot = serde_json::to_vec(snapshot)
        .map_err(|error| failure(format!("failed to serialize metadata snapshot: {error}")))?;
    Ok(ExactSourceMetadata {
        kind,
        locator,
        snapshot_sha256: digest_bytes(&snapshot),
        snapshot,
    })
}

fn validate_metadata_scope(metadata: &ExactSourceMetadata) -> Result<(), MigrationBackendError> {
    if digest_bytes(&metadata.snapshot) != metadata.snapshot_sha256 {
        return Err(failure("exact metadata snapshot digest is invalid"));
    }
    let locator: MetadataLocator = serde_json::from_str(&metadata.locator)
        .map_err(|error| failure(format!("invalid exact metadata locator: {error}")))?;
    match (metadata.kind, locator) {
        (
            SourceMetadataKind::NsisUninstallRegistration,
            MetadataLocator::UserRegistry { sid, key_path, .. },
        ) => {
            if !sid_is_canonical(&sid) || !is_exact_uninstall_key(&key_path) {
                return Err(failure(
                    "NSIS registry locator is outside the exact uninstall root",
                ));
            }
            let snapshot: RegistrySnapshot = serde_json::from_slice(&metadata.snapshot)
                .map_err(|error| failure(format!("invalid registry snapshot: {error}")))?;
            if snapshot.sid != sid || snapshot.key_path != key_path {
                return Err(failure("registry locator and snapshot identity differ"));
            }
        }
        (SourceMetadataKind::Shortcut, MetadataLocator::Shortcut { sid, path }) => {
            let snapshot: ShortcutSnapshot = serde_json::from_slice(&metadata.snapshot)
                .map_err(|error| failure(format!("invalid shortcut snapshot: {error}")))?;
            if snapshot.sid != sid
                || snapshot.path != path
                || snapshot.target.is_empty()
                || snapshot.bytes.is_empty()
                || snapshot.bytes.len() as u64 > MAX_SHORTCUT_BYTES
            {
                return Err(failure("shortcut locator and snapshot are invalid"));
            }
            validate_shortcut_path_for_sid(Path::new(&path), &sid)?;
            validate_absolute_normal_path(Path::new(&snapshot.target), "shortcut target")?;
        }
        _ => {
            return Err(failure(
                "metadata kind does not match its structured locator",
            ))
        }
    }
    Ok(())
}

fn metadata_presence(
    metadata: &ExactSourceMetadata,
) -> Result<ExactPresence, MigrationBackendError> {
    validate_metadata_scope(metadata)?;
    let locator: MetadataLocator = serde_json::from_str(&metadata.locator)
        .map_err(|error| failure(format!("invalid exact metadata locator: {error}")))?;
    match locator {
        MetadataLocator::UserRegistry {
            sid,
            view,
            key_path,
        } => {
            let expected: RegistrySnapshot = serde_json::from_slice(&metadata.snapshot)
                .map_err(|error| failure(format!("invalid registry snapshot: {error}")))?;
            match read_exact_user_registry(&sid, view, &key_path)? {
                None => Ok(ExactPresence::Absent),
                Some(actual) if actual == expected => Ok(ExactPresence::Present),
                Some(_) => Err(failure("exact installer registry metadata drifted")),
            }
        }
        MetadataLocator::Shortcut { path, .. } => {
            let expected: ShortcutSnapshot = serde_json::from_slice(&metadata.snapshot)
                .map_err(|error| failure(format!("invalid shortcut snapshot: {error}")))?;
            let path = Path::new(&path);
            match fs::symlink_metadata(path) {
                Ok(actual) => {
                    validate_regular_metadata(&actual, Some(MAX_SHORTCUT_BYTES))?;
                    let bytes = fs::read(path).map_err(|error| {
                        failure(format!("failed to read exact shortcut: {error}"))
                    })?;
                    if bytes == expected.bytes {
                        Ok(ExactPresence::Present)
                    } else {
                        Err(failure("exact shortcut metadata drifted"))
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    Ok(ExactPresence::Absent)
                }
                Err(error) => Err(failure(format!(
                    "failed to inspect exact shortcut: {error}"
                ))),
            }
        }
    }
}

fn remove_metadata(metadata: &ExactSourceMetadata) -> Result<(), MigrationBackendError> {
    match metadata_presence(metadata)? {
        ExactPresence::Absent => return Ok(()),
        ExactPresence::Present => {}
    }
    let locator: MetadataLocator = serde_json::from_str(&metadata.locator)
        .map_err(|error| failure(format!("invalid exact metadata locator: {error}")))?;
    match locator {
        MetadataLocator::UserRegistry {
            sid,
            view,
            key_path,
        } => {
            let users = RegKey::predef(HKEY_USERS);
            let full_path = format!(r"{sid}\{key_path}");
            users
                .delete_subkey_with_flags(&full_path, view_flag(view))
                .map_err(|error| {
                    failure(format!("failed to remove exact NSIS registration: {error}"))
                })?;
        }
        MetadataLocator::Shortcut { path, .. } => {
            fs::remove_file(&path).map_err(|error| {
                failure(format!("failed to remove exact NSIS shortcut: {error}"))
            })?;
        }
    }
    if metadata_presence(metadata)? != ExactPresence::Absent {
        return Err(failure("exact source metadata remains after removal"));
    }
    Ok(())
}

fn restore_metadata(metadata: &ExactSourceMetadata) -> Result<(), MigrationBackendError> {
    match metadata_presence(metadata)? {
        ExactPresence::Present => return Ok(()),
        ExactPresence::Absent => {}
    }
    let locator: MetadataLocator = serde_json::from_str(&metadata.locator)
        .map_err(|error| failure(format!("invalid exact metadata locator: {error}")))?;
    match locator {
        MetadataLocator::UserRegistry {
            sid,
            view,
            key_path,
        } => {
            let snapshot: RegistrySnapshot = serde_json::from_slice(&metadata.snapshot)
                .map_err(|error| failure(format!("invalid registry snapshot: {error}")))?;
            let users = RegKey::predef(HKEY_USERS);
            let full_path = format!(r"{sid}\{key_path}");
            let (key, disposition) = users
                .create_subkey_with_flags(&full_path, KEY_WRITE | view_flag(view))
                .map_err(|error| {
                    failure(format!(
                        "failed to restore exact NSIS registration: {error}"
                    ))
                })?;
            if disposition != winreg::enums::RegDisposition::REG_CREATED_NEW_KEY {
                return Err(failure(
                    "exact NSIS registration appeared during restoration",
                ));
            }
            for (name, value) in snapshot.values {
                let raw = RegValue {
                    vtype: registry_type(value.value_type)?,
                    bytes: value.bytes,
                };
                if let Err(error) = key.set_raw_value(name, &raw) {
                    drop(key);
                    let _ = users.delete_subkey_with_flags(&full_path, view_flag(view));
                    return Err(failure(format!(
                        "failed to restore exact NSIS value: {error}"
                    )));
                }
            }
        }
        MetadataLocator::Shortcut { path, .. } => {
            let snapshot: ShortcutSnapshot = serde_json::from_slice(&metadata.snapshot)
                .map_err(|error| failure(format!("invalid shortcut snapshot: {error}")))?;
            let parent = Path::new(&path)
                .parent()
                .ok_or_else(|| failure("shortcut has no parent directory"))?;
            validate_existing_directory(parent)?;
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&path)
                .map_err(|error| {
                    failure(format!("failed to restore exact NSIS shortcut: {error}"))
                })?;
            file.write_all(&snapshot.bytes)
                .and_then(|_| file.sync_all())
                .map_err(|error| {
                    failure(format!("failed to persist exact NSIS shortcut: {error}"))
                })?;
        }
    }
    if metadata_presence(metadata)? != ExactPresence::Present {
        return Err(failure("exact source metadata was not restored"));
    }
    Ok(())
}

fn read_exact_user_registry(
    sid: &str,
    view: RegistryView,
    key_path: &str,
) -> Result<Option<RegistrySnapshot>, MigrationBackendError> {
    if !sid_is_canonical(sid) || !is_exact_uninstall_key(key_path) {
        return Err(failure(
            "exact registry locator is outside the allowed scope",
        ));
    }
    let users = RegKey::predef(HKEY_USERS);
    let full_path = format!(r"{sid}\{key_path}");
    let key = match users.open_subkey_with_flags(&full_path, KEY_READ | view_flag(view)) {
        Ok(key) => key,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(failure(format!(
                "failed to inspect exact registry metadata: {error}"
            )))
        }
    };
    if key.enum_keys().next().is_some() {
        return Err(failure(
            "exact registry metadata contains unexpected subkeys",
        ));
    }
    Ok(Some(RegistrySnapshot {
        sid: sid.into(),
        view,
        key_path: key_path.into(),
        values: snapshot_registry_values(&key)?,
    }))
}

fn is_exact_uninstall_key(key_path: &str) -> bool {
    let Some(name) = key_path.strip_prefix(&format!(r"{UNINSTALL_ROOT}\")) else {
        return false;
    };
    !name.is_empty() && !name.contains(['\\', '/']) && name.trim() == name
}

fn validate_shortcut_path_for_sid(path: &Path, sid: &str) -> Result<(), MigrationBackendError> {
    if !sid_is_canonical(sid) {
        return Err(failure("shortcut SID is not canonical"));
    }
    let profile = profile_path_for_sid(sid)?;
    validate_shortcut_path_in_profile(path, &profile)
}

fn validate_shortcut_path_in_profile(
    path: &Path,
    profile: &Path,
) -> Result<(), MigrationBackendError> {
    validate_absolute_normal_path(path, "shortcut")?;
    validate_absolute_normal_path(profile, "user profile")?;
    let name = path
        .file_name()
        .and_then(OsStr::to_str)
        .ok_or_else(|| failure("shortcut name is not valid Unicode"))?;
    if !["ThreadFleet.lnk", "Codex Monitor.lnk"].contains(&name) {
        return Err(failure("shortcut name is outside the allowed product set"));
    }
    let allowed = [
        profile
            .join(r"AppData\Roaming\Microsoft\Windows\Start Menu\Programs")
            .join(name),
        profile.join("Desktop").join(name),
    ];
    if !allowed
        .iter()
        .any(|candidate| normalize_path(candidate) == normalize_path(path))
    {
        return Err(failure(
            "shortcut path is outside the initiating user's allowed shell directories",
        ));
    }
    Ok(())
}

fn validate_shortcut_target(
    target: &Path,
    source_root: &Path,
) -> Result<(), MigrationBackendError> {
    validate_absolute_normal_path(target, "shortcut target")?;
    validate_absolute_normal_path(source_root, "source root")?;
    let name = target
        .file_name()
        .and_then(OsStr::to_str)
        .ok_or_else(|| failure("shortcut target name is not valid Unicode"))?;
    if !EXECUTABLE_NAMES
        .iter()
        .any(|expected| name.eq_ignore_ascii_case(expected))
        || target
            .parent()
            .is_none_or(|parent| normalize_path(parent) != normalize_path(source_root))
    {
        return Err(failure(
            "Shell Link target is not an expected executable directly in the source root",
        ));
    }
    Ok(())
}

fn derived_source_backup_path(
    source: &Path,
    transaction_id: &str,
) -> Result<PathBuf, MigrationBackendError> {
    validate_uuid(transaction_id, "transaction ID")?;
    validate_absolute_normal_path(source, "source root")?;
    let parent = source
        .parent()
        .ok_or_else(|| failure("source root has no parent directory"))?;
    Ok(parent
        .join(".threadfleet-installer-migration")
        .join(transaction_id)
        .join("source-root"))
}

fn validate_source_root_path(path: &Path) -> Result<(), MigrationBackendError> {
    validate_source_root_scope(path)?;
    validate_existing_directory(path)?;
    if find_main_executable(path)?.is_none() {
        return Err(failure(
            "source root does not contain the expected application executable",
        ));
    }
    Ok(())
}

fn validate_source_root_scope(path: &Path) -> Result<(), MigrationBackendError> {
    validate_absolute_normal_path(path, "source root")?;
    if path.parent().is_none() || path.parent().and_then(Path::parent).is_none() {
        return Err(failure("source root is too broad"));
    }
    Ok(())
}

fn validate_absolute_normal_path(path: &Path, label: &str) -> Result<(), MigrationBackendError> {
    if !path.is_absolute() {
        return Err(failure(format!("{label} path must be absolute")));
    }
    let mut components = path.components();
    match components.next() {
        Some(Component::Prefix(prefix)) if !prefix.kind().is_verbatim() => {}
        _ => {
            return Err(failure(format!(
                "{label} path uses an unsupported namespace"
            )))
        }
    }
    if !matches!(components.next(), Some(Component::RootDir))
        || components.any(|component| matches!(component, Component::ParentDir | Component::CurDir))
    {
        return Err(failure(format!("{label} path is not canonical")));
    }
    let text = path
        .to_str()
        .ok_or_else(|| failure(format!("{label} path is not valid Unicode")))?;
    if text.contains(':') && text[2..].contains(':') {
        return Err(failure(format!(
            "{label} path contains an NTFS alternate stream"
        )));
    }
    Ok(())
}

fn validate_existing_directory(path: &Path) -> Result<(), MigrationBackendError> {
    validate_absolute_normal_path(path, "directory")?;
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| failure(format!("failed to inspect directory: {error}")))?;
    if !metadata.is_dir()
        || metadata.file_type().is_symlink()
        || metadata.file_attributes() & REPARSE_POINT_ATTRIBUTE != 0
    {
        return Err(failure("directory is not a normal non-reparse directory"));
    }
    Ok(())
}

fn validate_regular_file(
    path: &Path,
    expected_size: Option<u64>,
) -> Result<(), MigrationBackendError> {
    validate_absolute_normal_path(path, "file")?;
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| failure(format!("failed to inspect file: {error}")))?;
    validate_regular_metadata(&metadata, None)?;
    if expected_size.is_some_and(|size| size != metadata.len()) {
        return Err(failure("file size does not match the expected value"));
    }
    Ok(())
}

fn validate_regular_metadata(
    metadata: &fs::Metadata,
    max_size: Option<u64>,
) -> Result<(), MigrationBackendError> {
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || metadata.file_attributes() & REPARSE_POINT_ATTRIBUTE != 0
    {
        return Err(failure("path is not a normal non-reparse file"));
    }
    if max_size.is_some_and(|max| metadata.len() > max) {
        return Err(failure("file exceeds the allowed size"));
    }
    Ok(())
}

fn hash_directory_tree(root: &Path) -> Result<String, MigrationBackendError> {
    validate_existing_directory(root)?;
    let mut entries = Vec::new();
    collect_tree_entries(root, root, &mut entries)?;
    entries.sort_by(|left, right| normalize_path(&left.0).cmp(&normalize_path(&right.0)));
    let mut total_bytes = 0u64;
    let mut hasher = Sha256::new();
    hasher.update(b"threadfleet-installer-source-tree/v1\0");
    for (relative, is_dir, size, digest) in entries {
        total_bytes = total_bytes
            .checked_add(size)
            .ok_or_else(|| failure("source tree size overflowed"))?;
        if total_bytes > MAX_TREE_BYTES {
            return Err(failure("source tree exceeds the size limit"));
        }
        let relative = relative
            .to_str()
            .ok_or_else(|| failure("source tree path is not valid Unicode"))?;
        hasher.update(if is_dir { b"d\0" } else { b"f\0" });
        hasher.update(relative.replace('\\', "/").as_bytes());
        hasher.update([0]);
        hasher.update(size.to_le_bytes());
        if let Some(digest) = digest {
            hasher.update(digest.as_bytes());
        }
        hasher.update([0]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn collect_tree_entries(
    root: &Path,
    directory: &Path,
    entries: &mut Vec<(PathBuf, bool, u64, Option<String>)>,
) -> Result<(), MigrationBackendError> {
    validate_existing_directory(directory)?;
    let mut children = fs::read_dir(directory)
        .map_err(|error| failure(format!("failed to enumerate source tree: {error}")))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| failure(format!("failed to enumerate source tree: {error}")))?;
    children.sort_by_key(|entry| entry.file_name().to_string_lossy().to_ascii_lowercase());
    for child in children {
        if entries.len() >= MAX_TREE_ENTRIES {
            return Err(failure("source tree entry count exceeds the limit"));
        }
        let path = child.path();
        let metadata = fs::symlink_metadata(&path)
            .map_err(|error| failure(format!("failed to inspect source tree entry: {error}")))?;
        if metadata.file_type().is_symlink()
            || metadata.file_attributes() & REPARSE_POINT_ATTRIBUTE != 0
        {
            return Err(failure("source tree contains a symlink or reparse point"));
        }
        let relative = path
            .strip_prefix(root)
            .map_err(|_| failure("source tree entry escaped its root"))?
            .to_path_buf();
        if metadata.is_dir() {
            entries.push((relative, true, 0, None));
            collect_tree_entries(root, &path, entries)?;
        } else if metadata.is_file() {
            entries.push((relative, false, metadata.len(), Some(hash_file(&path)?)));
        } else {
            return Err(failure("source tree contains an unsupported entry type"));
        }
    }
    Ok(())
}

fn root_matches(path: &Path, expected_hash: &str) -> Result<bool, MigrationBackendError> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(hash_directory_tree(path)? == expected_hash),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(failure(format!(
            "failed to inspect source root state: {error}"
        ))),
    }
}

fn move_exact_tree(
    source: &Path,
    destination: &Path,
    expected_hash: &str,
) -> Result<(), MigrationBackendError> {
    validate_absolute_normal_path(source, "source tree")?;
    validate_absolute_normal_path(destination, "destination tree")?;
    ensure_same_volume(source, destination)?;
    let source_present = root_matches(source, expected_hash)?;
    let destination_present = root_matches(destination, expected_hash)?;
    match (source_present, destination_present) {
        (false, true) => return Ok(()),
        (true, false) => {}
        (true, true) => return Err(failure("both exact tree locations exist")),
        (false, false) => return Err(failure("neither exact tree location exists")),
    }
    let parent = destination
        .parent()
        .ok_or_else(|| failure("destination tree has no parent"))?;
    create_non_reparse_directory_chain(parent)?;
    fs::rename(source, destination).map_err(|error| {
        MigrationBackendError::interrupted(format!("exact source tree rename failed: {error}"))
    })?;
    if source.exists() || !root_matches(destination, expected_hash)? {
        return Err(MigrationBackendError::interrupted(
            "exact source tree rename postcondition failed",
        ));
    }
    Ok(())
}

fn create_non_reparse_directory_chain(path: &Path) -> Result<(), MigrationBackendError> {
    validate_absolute_normal_path(path, "derived backup directory")?;
    fs::create_dir_all(path).map_err(|error| {
        failure(format!(
            "failed to create derived backup directory: {error}"
        ))
    })?;
    let mut current = PathBuf::new();
    for component in path.components() {
        current.push(component.as_os_str());
        if current.parent().is_none() {
            continue;
        }
        let metadata = fs::symlink_metadata(&current)
            .map_err(|error| failure(format!("failed to verify backup directory: {error}")))?;
        if metadata.file_type().is_symlink()
            || metadata.file_attributes() & REPARSE_POINT_ATTRIBUTE != 0
        {
            return Err(failure("derived backup directory contains a reparse point"));
        }
    }
    Ok(())
}

fn ensure_same_volume(left: &Path, right: &Path) -> Result<(), MigrationBackendError> {
    if left.components().next() != right.components().next() {
        return Err(failure("source backup must remain on the source volume"));
    }
    Ok(())
}

fn find_main_executable(root: &Path) -> Result<Option<PathBuf>, MigrationBackendError> {
    for name in EXECUTABLE_NAMES {
        let path = root.join(name);
        match fs::symlink_metadata(&path) {
            Ok(metadata) => {
                validate_regular_metadata(&metadata, None)?;
                return Ok(Some(path));
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(failure(format!(
                    "failed to inspect application executable: {error}"
                )))
            }
        }
    }
    Ok(None)
}

fn hash_file(path: &Path) -> Result<String, MigrationBackendError> {
    let mut file = File::open(path)
        .map_err(|error| failure(format!("failed to open file for hashing: {error}")))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let count = file
            .read(&mut buffer)
            .map_err(|error| failure(format!("failed to hash file: {error}")))?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn path_text(path: &Path) -> Result<String, MigrationBackendError> {
    path.to_str()
        .map(str::to_owned)
        .ok_or_else(|| failure("Windows path is not valid Unicode"))
}

fn normalize_path(path: &Path) -> String {
    path.to_string_lossy()
        .replace('/', "\\")
        .trim_end_matches('\\')
        .to_ascii_lowercase()
}

fn digest_bytes(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

struct InspectedMsi {
    product_code: String,
    version: String,
    executable_sha256: String,
}

fn inspect_target_installer_for_root(
    target: &MigrationTarget,
    expected_install_root: &str,
) -> Result<TargetInstallerSnapshot, MigrationBackendError> {
    if target.family != InstallerFamily::Msi {
        return Err(failure("Windows migration target must be an MSI"));
    }
    let artifact_path = PathBuf::from(&target.artifact_path);
    validate_regular_file(&artifact_path, Some(target.artifact_size))?;
    if hash_file(&artifact_path)? != target.artifact_sha256 {
        return Err(failure("target MSI SHA-256 does not match the intent"));
    }
    verify_authenticode(&artifact_path)?;
    let inspected = inspect_msi_payload(&artifact_path)?;
    bind_inspected_target(target, expected_install_root, inspected)
}

fn bind_inspected_target(
    target: &MigrationTarget,
    expected_install_root: &str,
    inspected: InspectedMsi,
) -> Result<TargetInstallerSnapshot, MigrationBackendError> {
    validate_product_code(&inspected.product_code)?;
    if inspected.version != target.version {
        return Err(failure(
            "target MSI ProductVersion does not match the intent",
        ));
    }
    if inspected.executable_sha256.len() != 64
        || !inspected
            .executable_sha256
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(failure("target MSI executable payload digest is invalid"));
    }
    Ok(TargetInstallerSnapshot {
        family: InstallerFamily::Msi,
        artifact_path: target.artifact_path.clone(),
        artifact_size: target.artifact_size,
        artifact_sha256: target.artifact_sha256.clone(),
        version: inspected.version,
        product_code: inspected.product_code,
        expected_install_root: expected_install_root.into(),
        expected_executable_sha256: inspected.executable_sha256,
    })
}

fn inspect_msi_payload(path: &Path) -> Result<InspectedMsi, MigrationBackendError> {
    let mut package = msi::open(path)
        .map_err(|error| failure(format!("failed to open target MSI database: {error}")))?;
    let properties = read_msi_properties(&mut package)?;
    let product_code = properties
        .get("ProductCode")
        .cloned()
        .ok_or_else(|| failure("target MSI has no ProductCode"))?;
    validate_product_code(&product_code)?;
    let version = properties
        .get("ProductVersion")
        .cloned()
        .ok_or_else(|| failure("target MSI has no ProductVersion"))?;
    let (file_key, long_name) = find_msi_main_file(&mut package)?;
    let cabinet_stream = find_embedded_cabinet_stream(&mut package)?;
    let mut stream = package
        .read_stream(&cabinet_stream)
        .map_err(|error| failure(format!("failed to open embedded MSI cabinet: {error}")))?;
    let mut cabinet_bytes = Vec::new();
    stream
        .by_ref()
        .take(MAX_MSI_STREAM_BYTES + 1)
        .read_to_end(&mut cabinet_bytes)
        .map_err(|error| failure(format!("failed to read embedded MSI cabinet: {error}")))?;
    if cabinet_bytes.len() as u64 > MAX_MSI_STREAM_BYTES {
        return Err(failure("embedded MSI cabinet exceeds the size limit"));
    }
    let mut cabinet = Cabinet::new(Cursor::new(cabinet_bytes))
        .map_err(|error| failure(format!("failed to parse embedded MSI cabinet: {error}")))?;
    let entry_name = find_cabinet_entry(&cabinet, &file_key, &long_name)?;
    let mut executable = cabinet
        .read_file(&entry_name)
        .map_err(|error| failure(format!("failed to read MSI executable payload: {error}")))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let count = executable
            .read(&mut buffer)
            .map_err(|error| failure(format!("failed to hash MSI executable payload: {error}")))?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }
    Ok(InspectedMsi {
        product_code: product_code.to_ascii_uppercase(),
        version,
        executable_sha256: format!("{:x}", hasher.finalize()),
    })
}

fn read_msi_properties(
    package: &mut Package<File>,
) -> Result<BTreeMap<String, String>, MigrationBackendError> {
    let rows = package
        .select_rows(Select::table("Property").columns(&["Property", "Value"]))
        .map_err(|error| failure(format!("failed to query target MSI properties: {error}")))?;
    let mut properties = BTreeMap::new();
    for row in rows {
        let name = row["Property"]
            .as_str()
            .ok_or_else(|| failure("target MSI property name is not text"))?;
        let value = row["Value"]
            .as_str()
            .ok_or_else(|| failure("target MSI property value is not text"))?;
        properties.insert(name.into(), value.into());
    }
    Ok(properties)
}

fn find_msi_main_file(
    package: &mut Package<File>,
) -> Result<(String, String), MigrationBackendError> {
    let rows = package
        .select_rows(Select::table("File").columns(&["File", "FileName"]))
        .map_err(|error| failure(format!("failed to query target MSI File table: {error}")))?;
    let mut matches = Vec::new();
    for row in rows {
        let key = row["File"]
            .as_str()
            .ok_or_else(|| failure("target MSI file key is not text"))?;
        let file_name = row["FileName"]
            .as_str()
            .ok_or_else(|| failure("target MSI file name is not text"))?;
        let long_name = file_name
            .rsplit_once('|')
            .map_or(file_name, |(_, long)| long);
        if key == "Path"
            || EXECUTABLE_NAMES
                .iter()
                .any(|expected| long_name.eq_ignore_ascii_case(expected))
        {
            matches.push((key.to_string(), long_name.to_string()));
        }
    }
    matches.sort();
    matches.dedup();
    if matches.len() != 1 {
        return Err(failure(
            "target MSI does not contain one unambiguous main executable",
        ));
    }
    Ok(matches.remove(0))
}

fn find_embedded_cabinet_stream(
    package: &mut Package<File>,
) -> Result<String, MigrationBackendError> {
    let rows = package
        .select_rows(Select::table("Media").columns(&["Cabinet"]))
        .map_err(|error| failure(format!("failed to query target MSI Media table: {error}")))?;
    let mut cabinets = Vec::new();
    for row in rows {
        if let Some(value) = row["Cabinet"]
            .as_str()
            .and_then(|value| value.strip_prefix('#'))
        {
            cabinets.push(value.to_string());
        }
    }
    cabinets.sort();
    cabinets.dedup();
    if cabinets.len() != 1 || !package.has_stream(&cabinets[0]) {
        return Err(failure("target MSI must contain one embedded cabinet"));
    }
    Ok(cabinets.remove(0))
}

fn find_cabinet_entry(
    cabinet: &Cabinet<Cursor<Vec<u8>>>,
    file_key: &str,
    long_name: &str,
) -> Result<String, MigrationBackendError> {
    let matches = cabinet
        .folder_entries()
        .flat_map(|folder| folder.file_entries())
        .filter(|entry| {
            entry.name().eq_ignore_ascii_case(file_key)
                || entry.name().eq_ignore_ascii_case(long_name)
        })
        .map(|entry| entry.name().to_string())
        .collect::<BTreeSet<_>>();
    if matches.len() != 1 {
        return Err(failure(
            "embedded MSI cabinet has no unambiguous main executable entry",
        ));
    }
    Ok(matches
        .into_iter()
        .next()
        .expect("one cabinet entry was checked"))
}

fn verify_authenticode(path: &Path) -> Result<(), MigrationBackendError> {
    use windows_sys::Win32::Security::WinTrust::{
        WinVerifyTrust, WINTRUST_ACTION_GENERIC_VERIFY_V2, WINTRUST_DATA, WINTRUST_DATA_0,
        WINTRUST_FILE_INFO, WTD_CHOICE_FILE, WTD_REVOKE_WHOLECHAIN, WTD_STATEACTION_CLOSE,
        WTD_STATEACTION_VERIFY, WTD_UI_NONE,
    };

    let path_wide = path
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let mut file_info = WINTRUST_FILE_INFO {
        cbStruct: std::mem::size_of::<WINTRUST_FILE_INFO>() as u32,
        pcwszFilePath: path_wide.as_ptr(),
        hFile: std::ptr::null_mut(),
        pgKnownSubject: std::ptr::null_mut(),
    };
    let mut data: WINTRUST_DATA = unsafe { std::mem::zeroed() };
    data.cbStruct = std::mem::size_of::<WINTRUST_DATA>() as u32;
    data.dwUIChoice = WTD_UI_NONE;
    data.fdwRevocationChecks = WTD_REVOKE_WHOLECHAIN;
    data.dwUnionChoice = WTD_CHOICE_FILE;
    data.Anonymous = WINTRUST_DATA_0 {
        pFile: &mut file_info,
    };
    data.dwStateAction = WTD_STATEACTION_VERIFY;
    let mut action = WINTRUST_ACTION_GENERIC_VERIFY_V2;
    let status = unsafe {
        WinVerifyTrust(
            std::ptr::null_mut(),
            &mut action,
            (&mut data as *mut WINTRUST_DATA).cast(),
        )
    };
    data.dwStateAction = WTD_STATEACTION_CLOSE;
    let _ = unsafe {
        WinVerifyTrust(
            std::ptr::null_mut(),
            &mut action,
            (&mut data as *mut WINTRUST_DATA).cast(),
        )
    };
    if status == 0 {
        Ok(())
    } else {
        Err(failure(format!(
            "target MSI Authenticode verification failed with status 0x{:08x}",
            status as u32
        )))
    }
}

fn run_exact_msiexec(
    transaction_id: &str,
    transaction_path: &Path,
    target: &TargetInstallerSnapshot,
    operation: InstallOperation,
    ui_mode: InstallerUiMode,
) -> Result<i32, MigrationBackendError> {
    validate_uuid(transaction_id, "transaction ID")?;
    validate_product_code(&target.product_code)?;
    validate_regular_file(Path::new(&target.artifact_path), Some(target.artifact_size))?;
    if hash_file(Path::new(&target.artifact_path))? != target.artifact_sha256 {
        return Err(failure("target MSI changed before execution"));
    }
    verify_authenticode(Path::new(&target.artifact_path))?;
    create_non_reparse_directory_chain(transaction_path)?;
    let receipt_path = transaction_path.join(match operation {
        InstallOperation::Install => "install-receipt.json",
        InstallOperation::Rollback => "rollback-receipt.json",
    });
    let (mut receipt, is_new) = match load_install_receipt(&receipt_path)? {
        Some(mut receipt) => {
            validate_install_receipt(&receipt, transaction_id, target, operation)?;
            if let Some(code) = receipt.exit_code {
                return Ok(code);
            }
            if receipt.launched {
                return reconcile_pending_install_receipt(&receipt_path, &mut receipt, target);
            }
            (receipt, false)
        }
        None => (
            InstallReceipt {
                schema_version: INSTALL_RECEIPT_SCHEMA_VERSION,
                transaction_id: transaction_id.into(),
                artifact_sha256: target.artifact_sha256.clone(),
                product_code: target.product_code.clone(),
                operation,
                launched: false,
                process_id: None,
                process_created_at_filetime: None,
                exit_code: None,
            },
            true,
        ),
    };
    persist_install_receipt(&receipt_path, &receipt, is_new)?;

    let system_root = std::env::var_os("SystemRoot")
        .map(PathBuf::from)
        .ok_or_else(|| failure("SystemRoot is unavailable"))?;
    let executable = system_root.join(r"System32\msiexec.exe");
    validate_regular_file(&executable, None)?;
    let mut command = Command::new(executable);
    match operation {
        InstallOperation::Install => {
            command.arg("/i").arg(&target.artifact_path);
            match ui_mode {
                InstallerUiMode::Interactive => {}
                InstallerUiMode::Passive => {
                    command.arg("/passive");
                }
                InstallerUiMode::Silent => {
                    command.arg("/qn");
                }
            }
            command
                .arg(format!("INSTALLDIR={}", target.expected_install_root))
                .arg("REBOOT=ReallySuppress");
        }
        InstallOperation::Rollback => {
            command
                .arg("/x")
                .arg(&target.product_code)
                .arg("/qn")
                .arg("REBOOT=ReallySuppress");
        }
    }
    // Commit the one-shot launch before creating the process. A crash in the
    // following window may require operator recovery, but cannot duplicate MSI.
    receipt.launched = true;
    persist_install_receipt(&receipt_path, &receipt, false)?;
    let mut child = command
        .spawn()
        .map_err(|error| failure(format!("failed to launch exact msiexec operation: {error}")))?;
    let process_id = child.id();
    receipt.process_id = Some(process_id);
    receipt.process_created_at_filetime = Some(process_created_at_filetime(process_id)?);
    persist_install_receipt(&receipt_path, &receipt, false).map_err(|error| {
        MigrationBackendError::interrupted(format!(
            "msiexec launched but its receipt could not be persisted: {}",
            error.message
        ))
    })?;
    let status = child.wait().map_err(|error| {
        MigrationBackendError::interrupted(format!(
            "failed while waiting for exact msiexec: {error}"
        ))
    })?;
    let code = status.code().unwrap_or(1603);
    receipt.exit_code = Some(code);
    persist_install_receipt(&receipt_path, &receipt, false).map_err(|error| {
        MigrationBackendError::interrupted(format!(
            "msiexec returned but its exit result could not be persisted: {}",
            error.message
        ))
    })?;
    Ok(code)
}

fn reconcile_pending_install_receipt(
    receipt_path: &Path,
    receipt: &mut InstallReceipt,
    target: &TargetInstallerSnapshot,
) -> Result<i32, MigrationBackendError> {
    let (Some(process_id), Some(created_at)) =
        (receipt.process_id, receipt.process_created_at_filetime)
    else {
        let completed = exact_operation_postcondition(target, receipt.operation)?;
        if completed {
            receipt.exit_code = Some(0);
            persist_install_receipt(receipt_path, receipt, false)?;
            return Ok(0);
        }
        return Err(MigrationBackendError::interrupted(
            "msiexec launch was committed before its process identity became durable; refusing duplicate execution",
        ));
    };
    let process_state = inspect_exact_process(process_id, created_at)?;
    if process_state == ExactProcessState::Running {
        return Err(MigrationBackendError::interrupted(
            "the exact msiexec process is still running; refusing duplicate execution",
        ));
    }
    let completed = exact_operation_postcondition(target, receipt.operation)?;
    let code = reconciled_exit_code(process_state, completed);
    receipt.exit_code = Some(code);
    persist_install_receipt(receipt_path, receipt, false)?;
    Ok(code)
}

fn exact_operation_postcondition(
    target: &TargetInstallerSnapshot,
    operation: InstallOperation,
) -> Result<bool, MigrationBackendError> {
    let observed = observe_exact_target(target)?;
    match (operation, observed) {
        (InstallOperation::Install, Some(record))
            if observation_matches_target(&record, target) =>
        {
            Ok(true)
        }
        (InstallOperation::Install, Some(_)) => {
            Err(failure("target MSI product registration drifted"))
        }
        (InstallOperation::Install, None) => Ok(false),
        (InstallOperation::Rollback, None) => Ok(true),
        (InstallOperation::Rollback, Some(_)) => Ok(false),
    }
}

fn reconciled_exit_code(process_state: ExactProcessState, completed: bool) -> i32 {
    if completed {
        return 0;
    }
    match process_state {
        ExactProcessState::Exited(Some(code)) if !matches!(code, 0 | 3010) => code,
        ExactProcessState::Exited(_) | ExactProcessState::MissingOrReused => 1603,
        ExactProcessState::Running => 1603,
    }
}

struct ProcessHandle(HANDLE);

impl Drop for ProcessHandle {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.0);
        }
    }
}

fn open_process_for_reconciliation(
    process_id: u32,
) -> Result<Option<ProcessHandle>, MigrationBackendError> {
    let handle = unsafe {
        OpenProcess(
            PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE,
            0,
            process_id,
        )
    };
    if !handle.is_null() {
        return Ok(Some(ProcessHandle(handle)));
    }
    let error = std::io::Error::last_os_error();
    if error.raw_os_error() == Some(ERROR_INVALID_PARAMETER as i32) {
        Ok(None)
    } else {
        Err(MigrationBackendError::interrupted(format!(
            "failed to inspect the committed msiexec process: {error}"
        )))
    }
}

fn read_process_created_at(handle: HANDLE) -> Result<u64, MigrationBackendError> {
    let mut creation = FILETIME {
        dwLowDateTime: 0,
        dwHighDateTime: 0,
    };
    let mut exit = creation;
    let mut kernel = creation;
    let mut user = creation;
    if unsafe { GetProcessTimes(handle, &mut creation, &mut exit, &mut kernel, &mut user) } == 0 {
        return Err(MigrationBackendError::interrupted(format!(
            "failed to read the committed msiexec process identity: {}",
            std::io::Error::last_os_error()
        )));
    }
    Ok(((creation.dwHighDateTime as u64) << 32) | creation.dwLowDateTime as u64)
}

fn process_created_at_filetime(process_id: u32) -> Result<u64, MigrationBackendError> {
    let handle = open_process_for_reconciliation(process_id)?.ok_or_else(|| {
        MigrationBackendError::interrupted(
            "msiexec exited before its process identity could be persisted",
        )
    })?;
    read_process_created_at(handle.0)
}

fn inspect_exact_process(
    process_id: u32,
    expected_created_at: u64,
) -> Result<ExactProcessState, MigrationBackendError> {
    let Some(handle) = open_process_for_reconciliation(process_id)? else {
        return Ok(ExactProcessState::MissingOrReused);
    };
    if read_process_created_at(handle.0)? != expected_created_at {
        return Ok(ExactProcessState::MissingOrReused);
    }
    match unsafe { WaitForSingleObject(handle.0, 0) } {
        WAIT_TIMEOUT => Ok(ExactProcessState::Running),
        WAIT_OBJECT_0 => {
            let mut exit_code = 0u32;
            if unsafe { GetExitCodeProcess(handle.0, &mut exit_code) } == 0 {
                return Err(MigrationBackendError::interrupted(format!(
                    "failed to read the committed msiexec exit code: {}",
                    std::io::Error::last_os_error()
                )));
            }
            Ok(ExactProcessState::Exited(Some(exit_code as i32)))
        }
        result => Err(MigrationBackendError::interrupted(format!(
            "failed to determine committed msiexec process state: wait result {result}"
        ))),
    }
}

fn load_install_receipt(path: &Path) -> Result<Option<InstallReceipt>, MigrationBackendError> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(failure(format!(
                "failed to inspect install receipt: {error}"
            )))
        }
    };
    validate_regular_metadata(&metadata, Some(16 * 1024))?;
    let bytes = fs::read(path)
        .map_err(|error| failure(format!("failed to read install receipt: {error}")))?;
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|error| failure(format!("invalid install receipt: {error}")))
}

fn persist_install_receipt(
    path: &Path,
    receipt: &InstallReceipt,
    create_new: bool,
) -> Result<(), MigrationBackendError> {
    let bytes = serde_json::to_vec(receipt)
        .map_err(|error| failure(format!("failed to serialize install receipt: {error}")))?;
    let mut options = OpenOptions::new();
    options.write(true).custom_flags(0x0020_0000);
    if create_new {
        options.create_new(true);
    }
    let mut file = options
        .open(path)
        .map_err(|error| failure(format!("failed to open install receipt: {error}")))?;
    let metadata = file
        .metadata()
        .map_err(|error| failure(format!("failed to inspect install receipt handle: {error}")))?;
    validate_regular_metadata(&metadata, Some(16 * 1024))?;
    file.set_len(0)
        .map_err(|error| failure(format!("failed to truncate install receipt: {error}")))?;
    file.write_all(&bytes)
        .and_then(|_| file.sync_all())
        .map_err(|error| failure(format!("failed to persist install receipt: {error}")))
}

fn validate_install_receipt(
    receipt: &InstallReceipt,
    transaction_id: &str,
    target: &TargetInstallerSnapshot,
    operation: InstallOperation,
) -> Result<(), MigrationBackendError> {
    if receipt.schema_version != INSTALL_RECEIPT_SCHEMA_VERSION
        || receipt.transaction_id != transaction_id
        || receipt.artifact_sha256 != target.artifact_sha256
        || receipt.product_code != target.product_code
        || receipt.operation != operation
        || receipt.exit_code.is_some() && !receipt.launched
        || receipt.process_id.is_some() && !receipt.launched
        || receipt.process_created_at_filetime.is_some() && !receipt.launched
        || receipt.process_id.is_some() != receipt.process_created_at_filetime.is_some()
    {
        return Err(failure(
            "install receipt is not bound to the exact operation",
        ));
    }
    Ok(())
}

fn observe_exact_target(
    target: &TargetInstallerSnapshot,
) -> Result<Option<InstallerRecord>, MigrationBackendError> {
    validate_product_code(&target.product_code)?;
    let records = scan_machine_product_records()?;
    let matches = records
        .into_iter()
        .filter(|record| {
            record
                .product_code
                .as_deref()
                .is_some_and(|code| code.eq_ignore_ascii_case(&target.product_code))
        })
        .collect::<Vec<_>>();
    if matches.is_empty() {
        return Ok(None);
    }
    if matches
        .iter()
        .any(|record| !records_equivalent_ignoring_view(&matches[0], record))
    {
        return Err(failure("target MSI product has divergent registry views"));
    }
    Ok(matches.into_iter().next())
}

fn observation_matches_target(record: &InstallerRecord, target: &TargetInstallerSnapshot) -> bool {
    record.family == ObservedOwnership::PureMsi
        && record
            .product_code
            .as_deref()
            .is_some_and(|code| code.eq_ignore_ascii_case(&target.product_code))
        && record.display_version.as_deref() == Some(target.version.as_str())
        && record.install_location.as_deref().is_some_and(|root| {
            normalize_path(Path::new(root))
                == normalize_path(Path::new(&target.expected_install_root))
        })
}

fn records_equivalent_ignoring_view(left: &InstallerRecord, right: &InstallerRecord) -> bool {
    left.sid == right.sid
        && left.key_path == right.key_path
        && left.family == right.family
        && left.display_version == right.display_version
        && left.install_location == right.install_location
        && left.uninstall_string == right.uninstall_string
        && left.product_code == right.product_code
        && left.registry.values == right.registry.values
}

fn parse_strict_uninstall_path(value: &str) -> Option<PathBuf> {
    let trimmed = value.trim();
    let path = if trimmed.starts_with('"') && trimmed.ends_with('"') && trimmed.len() >= 2 {
        &trimmed[1..trimmed.len() - 1]
    } else if !trimmed.contains('"') && !trimmed.contains(" /") {
        trimmed
    } else {
        return None;
    };
    let path = PathBuf::from(path);
    if !path.is_absolute()
        || !path
            .file_name()
            .is_some_and(|name| name.to_string_lossy().eq_ignore_ascii_case("uninstall.exe"))
    {
        return None;
    }
    Some(path)
}

fn sid_is_canonical(value: &str) -> bool {
    let mut parts = value.split('-');
    parts.next() == Some("S")
        && parts.next() == Some("1")
        && parts.clone().count() >= 2
        && parts.all(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit()))
}

fn validate_uuid(value: &str, label: &str) -> Result<(), MigrationBackendError> {
    let parsed = uuid::Uuid::parse_str(value).map_err(|_| failure(format!("invalid {label}")))?;
    if parsed.hyphenated().to_string() != value {
        return Err(failure(format!("invalid {label}")));
    }
    Ok(())
}

fn is_product_code(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 38
        && bytes[0] == b'{'
        && bytes[37] == b'}'
        && [9, 14, 19, 24].iter().all(|index| bytes[*index] == b'-')
        && bytes[1..37]
            .iter()
            .enumerate()
            .all(|(index, byte)| [8, 13, 18, 23].contains(&index) || byte.is_ascii_hexdigit())
}

fn validate_product_code(value: &str) -> Result<(), MigrationBackendError> {
    if !is_product_code(value) || value != value.to_ascii_uppercase() {
        return Err(failure("MSI ProductCode is not canonical"));
    }
    Ok(())
}

fn view_flag(view: RegistryView) -> u32 {
    match view {
        RegistryView::Registry32 => KEY_WOW64_32KEY,
        RegistryView::Registry64 => KEY_WOW64_64KEY,
    }
}

fn registry_type(value: u32) -> Result<winreg::enums::RegType, MigrationBackendError> {
    use winreg::enums::{
        REG_BINARY, REG_DWORD, REG_DWORD_BIG_ENDIAN, REG_EXPAND_SZ, REG_FULL_RESOURCE_DESCRIPTOR,
        REG_LINK, REG_MULTI_SZ, REG_NONE, REG_QWORD, REG_RESOURCE_LIST,
        REG_RESOURCE_REQUIREMENTS_LIST, REG_SZ,
    };
    match value {
        0 => Ok(REG_NONE),
        1 => Ok(REG_SZ),
        2 => Ok(REG_EXPAND_SZ),
        3 => Ok(REG_BINARY),
        4 => Ok(REG_DWORD),
        5 => Ok(REG_DWORD_BIG_ENDIAN),
        6 => Ok(REG_LINK),
        7 => Ok(REG_MULTI_SZ),
        8 => Ok(REG_RESOURCE_LIST),
        9 => Ok(REG_FULL_RESOURCE_DESCRIPTOR),
        10 => Ok(REG_RESOURCE_REQUIREMENTS_LIST),
        11 => Ok(REG_QWORD),
        _ => Err(failure(
            "registry snapshot contains an unsupported value type",
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shared::installer_migration_core::{
        InstallerScope, INSTALLER_MIGRATION_SCHEMA_VERSION,
    };
    use std::sync::atomic::{AtomicU64, Ordering};

    const TRANSACTION_ID: &str = "11111111-1111-4111-8111-111111111111";
    const OTHER_TRANSACTION_ID: &str = "22222222-2222-4222-8222-222222222222";
    static NEXT_TEMP: AtomicU64 = AtomicU64::new(0);

    fn temp_root(label: &str) -> PathBuf {
        let id = NEXT_TEMP.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!(
            "threadfleet-installer-migration-windows-{label}-{}-{id}",
            std::process::id()
        ))
    }

    fn preflight_intent() -> MigrationIntent {
        MigrationIntent {
            schema_version: INSTALLER_MIGRATION_SCHEMA_VERSION,
            intent_id: TRANSACTION_ID.into(),
            nonce: OTHER_TRANSACTION_ID.into(),
            created_at_unix_ms: 1_700_000_000_000,
            expires_at_unix_ms: 1_700_000_600_000,
            adapter_family: InstallerFamily::Msi,
            target: MigrationTarget {
                family: InstallerFamily::Msi,
                version: "1.2.3".into(),
                artifact_path: r"C:\staging\ThreadFleet.msi".into(),
                artifact_size: 8,
                artifact_sha256: "1".repeat(64),
            },
            scope: InstallerScope::PerMachine,
            ui_mode: InstallerUiMode::Interactive,
            parent_pid: 42,
            original_user_sid: "S-1-5-21-1000".into(),
            original_session_id: 1,
        }
    }

    fn preflight_source(ownership: ObservedOwnership) -> NsisSourcePreflightSnapshot {
        NsisSourcePreflightSnapshot {
            ownership,
            source_path: r"C:\Users\Test\AppData\Local\ThreadFleet".into(),
            tree_sha256: "2".repeat(64),
            metadata: Vec::new(),
        }
    }

    fn preflight_target() -> TargetInstallerSnapshot {
        TargetInstallerSnapshot {
            family: InstallerFamily::Msi,
            artifact_path: r"C:\staging\ThreadFleet.msi".into(),
            artifact_size: 8,
            artifact_sha256: "1".repeat(64),
            version: "1.2.3".into(),
            product_code: "{AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE}".into(),
            expected_install_root: r"C:\Users\Test\AppData\Local\ThreadFleet".into(),
            expected_executable_sha256: "3".repeat(64),
        }
    }

    fn nsis_record(view: RegistryView) -> InstallerRecord {
        InstallerRecord {
            sid: Some("S-1-5-21-1000".into()),
            view,
            key_path: format!(r"{UNINSTALL_ROOT}\ThreadFleet"),
            family: ObservedOwnership::PureNsis,
            display_version: Some("1.2.3".into()),
            install_location: Some(r"C:\Users\Test\AppData\Local\ThreadFleet".into()),
            uninstall_string: Some(r"C:\Users\Test\AppData\Local\ThreadFleet\uninstall.exe".into()),
            product_code: None,
            registry: RegistrySnapshot {
                sid: "S-1-5-21-1000".into(),
                view,
                key_path: format!(r"{UNINSTALL_ROOT}\ThreadFleet"),
                values: BTreeMap::new(),
            },
        }
    }

    struct FakeReadOnlyPreflight {
        ownership: ObservedOwnership,
        target_error: Option<&'static str>,
        inspect_calls: usize,
    }

    impl ReadOnlyInstallerMigrationPreflight for FakeReadOnlyPreflight {
        fn observe_source(
            &mut self,
            _intent: &MigrationIntent,
        ) -> Result<NsisSourcePreflightSnapshot, MigrationBackendError> {
            Ok(preflight_source(self.ownership))
        }

        fn inspect_target(
            &mut self,
            _target: &MigrationTarget,
            _source: &NsisSourcePreflightSnapshot,
        ) -> Result<TargetInstallerSnapshot, MigrationBackendError> {
            self.inspect_calls += 1;
            match self.target_error {
                Some(message) => Err(failure(message)),
                None => Ok(preflight_target()),
            }
        }
    }

    #[test]
    fn native_identity_comes_from_the_process_token_and_session() {
        let identity = capture_native_installer_migration_identity().unwrap();
        assert_eq!(identity.process_id, std::process::id());
        assert!(sid_is_canonical(&identity.user_sid));

        let mut expected_session = u32::MAX;
        assert_ne!(
            unsafe { ProcessIdToSessionId(std::process::id(), &mut expected_session) },
            0
        );
        assert_eq!(identity.session_id, expected_session);
    }

    #[test]
    fn preflight_blocks_non_pure_ownership_before_artifact_inspection() {
        for ownership in [
            ObservedOwnership::Mixed,
            ObservedOwnership::Unknown,
            ObservedOwnership::PureMsi,
        ] {
            let mut system = FakeReadOnlyPreflight {
                ownership,
                target_error: None,
                inspect_calls: 0,
            };
            let error =
                preflight_installer_migration_with(&mut system, &preflight_intent()).unwrap_err();
            assert!(error.message.contains("pure NSIS ownership"));
            assert_eq!(system.inspect_calls, 0);
        }
    }

    #[test]
    fn pure_nsis_preflight_requires_equivalent_registry_views() {
        let registry32 = nsis_record(RegistryView::Registry32);
        let mut registry64 = nsis_record(RegistryView::Registry64);
        validate_pure_nsis_records(&[&registry32, &registry64], "S-1-5-21-1000").unwrap();

        registry64.display_version = Some("9.9.9".into());
        let error =
            validate_pure_nsis_records(&[&registry32, &registry64], "S-1-5-21-1000").unwrap_err();
        assert!(error.message.contains("divergent registry records"));
    }

    #[test]
    fn preflight_propagates_artifact_identity_failures_without_a_mutation_surface() {
        for message in [
            "target MSI SHA-256 does not match the intent",
            "target MSI Authenticode verification failed",
            "target MSI ProductVersion does not match the intent",
        ] {
            let mut system = FakeReadOnlyPreflight {
                ownership: ObservedOwnership::PureNsis,
                target_error: Some(message),
                inspect_calls: 0,
            };
            let error =
                preflight_installer_migration_with(&mut system, &preflight_intent()).unwrap_err();
            assert_eq!(error.message, message);
            assert_eq!(system.inspect_calls, 1);
        }
    }

    #[test]
    fn native_target_inspection_rejects_hash_and_authenticode_mismatches() {
        let root = temp_root("preflight-artifact");
        fs::create_dir_all(&root).unwrap();
        let artifact = root.join("ThreadFleet.msi");
        let bytes = b"unsigned test MSI";
        fs::write(&artifact, bytes).unwrap();
        let source = preflight_source(ObservedOwnership::PureNsis);
        let mut target = preflight_intent().target;
        target.artifact_path = path_text(&artifact).unwrap();
        target.artifact_size = bytes.len() as u64;
        target.artifact_sha256 = "0".repeat(64);
        let hash_error =
            inspect_target_installer_for_root(&target, &source.source_path).unwrap_err();
        assert!(hash_error.message.contains("SHA-256"));

        target.artifact_sha256 = digest_bytes(bytes);
        let signature_error =
            inspect_target_installer_for_root(&target, &source.source_path).unwrap_err();
        assert!(signature_error.message.contains("Authenticode"));
    }

    #[test]
    fn inspected_msi_binding_rejects_version_product_code_and_payload_mismatch() {
        let target = preflight_intent().target;
        let source = preflight_source(ObservedOwnership::PureNsis);
        let valid = InspectedMsi {
            product_code: "{AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE}".into(),
            version: target.version.clone(),
            executable_sha256: "3".repeat(64),
        };
        assert!(bind_inspected_target(&target, &source.source_path, valid).is_ok());

        let wrong_version = InspectedMsi {
            product_code: "{AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE}".into(),
            version: "9.9.9".into(),
            executable_sha256: "3".repeat(64),
        };
        assert!(
            bind_inspected_target(&target, &source.source_path, wrong_version)
                .unwrap_err()
                .message
                .contains("ProductVersion")
        );

        let wrong_product_code = InspectedMsi {
            product_code: "{aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee}".into(),
            version: target.version.clone(),
            executable_sha256: "3".repeat(64),
        };
        assert!(
            bind_inspected_target(&target, &source.source_path, wrong_product_code)
                .unwrap_err()
                .message
                .contains("ProductCode")
        );

        let wrong_payload_digest = InspectedMsi {
            product_code: "{AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE}".into(),
            version: target.version.clone(),
            executable_sha256: "not-a-digest".into(),
        };
        assert!(
            bind_inspected_target(&target, &source.source_path, wrong_payload_digest)
                .unwrap_err()
                .message
                .contains("payload digest")
        );
    }

    #[test]
    fn backup_path_is_transaction_derived_and_stays_on_source_volume() {
        let source = PathBuf::from(r"C:\Users\Test\AppData\Local\ThreadFleet");
        assert_eq!(
            derived_source_backup_path(&source, TRANSACTION_ID).unwrap(),
            PathBuf::from(format!(
                r"C:\Users\Test\AppData\Local\.threadfleet-installer-migration\{TRANSACTION_ID}\source-root"
            ))
        );
        assert!(derived_source_backup_path(&source, "not-a-uuid").is_err());
        assert!(validate_source_root_scope(&source).is_ok());
        assert!(validate_source_root_path(&source).is_err());
    }

    #[test]
    fn exact_tree_detach_and_restore_are_idempotent_and_hash_bound() {
        let root = temp_root("tree");
        let source = root.join("source");
        let destination = root.join("backup").join(TRANSACTION_ID).join("source-root");
        fs::create_dir_all(source.join("nested")).unwrap();
        fs::write(source.join("threadfleet.exe"), b"exe").unwrap();
        fs::write(source.join("nested").join("data.bin"), b"data").unwrap();
        let digest = hash_directory_tree(&source).unwrap();

        move_exact_tree(&source, &destination, &digest).unwrap();
        move_exact_tree(&source, &destination, &digest).unwrap();
        assert!(!source.exists());
        assert!(destination.exists());

        move_exact_tree(&destination, &source, &digest).unwrap();
        move_exact_tree(&destination, &source, &digest).unwrap();
        assert!(source.exists());
        assert!(!destination.exists());
        assert_eq!(hash_directory_tree(&source).unwrap(), digest);

        fs::write(source.join("nested").join("data.bin"), b"changed").unwrap();
        assert!(move_exact_tree(&source, &destination, &digest).is_err());
    }

    #[test]
    fn shell_link_reader_returns_the_persisted_target() {
        let root = temp_root("shell-link");
        fs::create_dir_all(&root).unwrap();
        let target = root.join("threadfleet.exe");
        fs::write(&target, b"test executable").unwrap();
        let shortcut = root.join("ThreadFleet.lnk");
        let _com = ComInitialization::current_thread().unwrap();
        let link: IShellLinkW =
            unsafe { CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER) }.unwrap();
        let target_wide = target
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect::<Vec<_>>();
        unsafe { link.SetPath(PCWSTR(target_wide.as_ptr())) }.unwrap();
        let persist: IPersistFile = link.cast().unwrap();
        let shortcut_wide = shortcut
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect::<Vec<_>>();
        unsafe { persist.Save(PCWSTR(shortcut_wide.as_ptr()), true) }.unwrap();
        drop(persist);
        drop(link);

        assert_eq!(
            normalize_path(&read_shell_link_target(&shortcut).unwrap()),
            normalize_path(&target)
        );
        validate_shortcut_target(&target, &root).unwrap();
        assert!(validate_shortcut_target(&root.join("other.exe"), &root).is_err());
        assert!(
            validate_shortcut_target(&root.join("nested").join("threadfleet.exe"), &root).is_err()
        );
    }

    #[test]
    fn shortcut_scope_is_bound_to_the_exact_profile_shell_directories() {
        let profile = PathBuf::from(r"C:\Users\Test");
        assert!(validate_shortcut_path_in_profile(
            &profile.join(r"Desktop\ThreadFleet.lnk"),
            &profile
        )
        .is_ok());
        assert!(validate_shortcut_path_in_profile(
            &profile
                .join(r"AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Codex Monitor.lnk"),
            &profile
        )
        .is_ok());
        assert!(validate_shortcut_path_in_profile(
            &PathBuf::from(r"C:\Users\Other\Desktop\ThreadFleet.lnk"),
            &profile
        )
        .is_err());
    }

    #[test]
    fn pending_msiexec_reconciliation_requires_the_exact_postcondition() {
        assert_eq!(
            reconciled_exit_code(ExactProcessState::Exited(Some(0)), false),
            1603
        );
        assert_eq!(
            reconciled_exit_code(ExactProcessState::Exited(Some(1602)), false),
            1602
        );
        assert_eq!(
            reconciled_exit_code(ExactProcessState::MissingOrReused, false),
            1603
        );
        assert_eq!(
            reconciled_exit_code(ExactProcessState::Exited(Some(1603)), true),
            0
        );
    }

    #[test]
    fn process_identity_uses_pid_and_creation_time() {
        let process_id = std::process::id();
        let created_at = process_created_at_filetime(process_id).unwrap();
        assert_eq!(
            inspect_exact_process(process_id, created_at).unwrap(),
            ExactProcessState::Running
        );
        assert_eq!(
            inspect_exact_process(process_id, created_at.wrapping_add(1)).unwrap(),
            ExactProcessState::MissingOrReused
        );
    }

    #[test]
    fn structured_metadata_rejects_kind_and_locator_spoofing() {
        let snapshot = RegistrySnapshot {
            sid: "S-1-5-21-1".into(),
            view: RegistryView::Registry64,
            key_path: format!(r"{UNINSTALL_ROOT}\ThreadFleet"),
            values: BTreeMap::new(),
        };
        let valid = exact_metadata(
            SourceMetadataKind::NsisUninstallRegistration,
            &MetadataLocator::UserRegistry {
                sid: snapshot.sid.clone(),
                view: snapshot.view,
                key_path: snapshot.key_path.clone(),
            },
            &snapshot,
        )
        .unwrap();
        validate_metadata_scope(&valid).unwrap();

        let mut wrong_kind = valid.clone();
        wrong_kind.kind = SourceMetadataKind::Shortcut;
        assert!(validate_metadata_scope(&wrong_kind).is_err());

        let mut wrong_digest = valid;
        wrong_digest.snapshot_sha256 = "0".repeat(64);
        assert!(validate_metadata_scope(&wrong_digest).is_err());
    }

    #[test]
    fn install_receipt_binding_prevents_cross_transaction_replay() {
        let target = TargetInstallerSnapshot {
            family: InstallerFamily::Msi,
            artifact_path: r"C:\staging\ThreadFleet.msi".into(),
            artifact_size: 10,
            artifact_sha256: "1".repeat(64),
            version: "1.2.3".into(),
            product_code: "{AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE}".into(),
            expected_install_root: r"C:\Program Files\ThreadFleet".into(),
            expected_executable_sha256: "2".repeat(64),
        };
        let receipt = InstallReceipt {
            schema_version: INSTALL_RECEIPT_SCHEMA_VERSION,
            transaction_id: TRANSACTION_ID.into(),
            artifact_sha256: target.artifact_sha256.clone(),
            product_code: target.product_code.clone(),
            operation: InstallOperation::Install,
            launched: true,
            process_id: Some(42),
            process_created_at_filetime: Some(123),
            exit_code: Some(0),
        };
        validate_install_receipt(&receipt, TRANSACTION_ID, &target, InstallOperation::Install)
            .unwrap();
        assert!(validate_install_receipt(
            &receipt,
            OTHER_TRANSACTION_ID,
            &target,
            InstallOperation::Install,
        )
        .is_err());
        assert!(validate_install_receipt(
            &receipt,
            TRANSACTION_ID,
            &target,
            InstallOperation::Rollback,
        )
        .is_err());
    }

    #[test]
    fn receipt_update_rejects_reparse_without_touching_its_target() {
        use std::os::windows::fs::symlink_file;

        let root = temp_root("receipt-reparse");
        fs::create_dir_all(&root).unwrap();
        let target = root.join("external.json");
        let original = b"external";
        fs::write(&target, original).unwrap();
        let receipt_path = root.join("install-receipt.json");
        if symlink_file(&target, &receipt_path).is_ok() {
            let receipt = InstallReceipt {
                schema_version: INSTALL_RECEIPT_SCHEMA_VERSION,
                transaction_id: TRANSACTION_ID.into(),
                artifact_sha256: "1".repeat(64),
                product_code: "{AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE}".into(),
                operation: InstallOperation::Install,
                launched: true,
                process_id: None,
                process_created_at_filetime: None,
                exit_code: None,
            };
            assert!(persist_install_receipt(&receipt_path, &receipt, false).is_err());
            assert_eq!(fs::read(target).unwrap(), original);
        }
    }

    #[test]
    fn store_adapter_retains_one_cross_process_transaction_lease() {
        let root = temp_root("lease");
        let store = MigrationStore::new(root.clone()).unwrap();
        let mut first = WindowsMigrationBackend::new(store.clone(), NativeWindowsMigrationSystem);
        let mut second = WindowsMigrationBackend::new(store, NativeWindowsMigrationSystem);
        first.begin_transaction(TRANSACTION_ID).unwrap();
        first.begin_transaction(TRANSACTION_ID).unwrap();
        assert!(second.begin_transaction(TRANSACTION_ID).is_err());
        assert!(first.begin_transaction(OTHER_TRANSACTION_ID).is_err());
    }
}
