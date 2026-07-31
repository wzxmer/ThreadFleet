use super::installer_migration_core::{
    InstallerFamily, InstallerUiMode, MigrationContinuation, MigrationIntent, MigrationTarget,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;

pub(crate) const INSTALLER_MIGRATION_ENGINE_SCHEMA_VERSION: u32 = 1;
const REBOOT_REQUIRED_EXIT_CODE: i32 = 3010;
const MAX_SOURCE_METADATA_ITEMS: usize = 64;
const MAX_METADATA_SNAPSHOT_BYTES: usize = 1024 * 1024;
const MAX_TOTAL_METADATA_SNAPSHOT_BYTES: usize = 4 * 1024 * 1024;
const MAX_MANIFEST_TEXT_BYTES: usize = 32 * 1024;
const MAX_ERROR_MESSAGE_BYTES: usize = 16 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ObservedOwnership {
    PureNsis,
    PureMsi,
    Mixed,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum SourceMetadataKind {
    NsisUninstallRegistration,
    VendorRegistration,
    Shortcut,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ExactSourceMetadata {
    pub(crate) kind: SourceMetadataKind,
    pub(crate) locator: String,
    pub(crate) snapshot: Vec<u8>,
    pub(crate) snapshot_sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SourceRootSnapshot {
    pub(crate) source_path: String,
    pub(crate) backup_path: String,
    pub(crate) tree_sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct NsisSourceSnapshot {
    pub(crate) ownership: ObservedOwnership,
    pub(crate) root: SourceRootSnapshot,
    pub(crate) metadata: Vec<ExactSourceMetadata>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TargetInstallerSnapshot {
    pub(crate) family: InstallerFamily,
    pub(crate) artifact_path: String,
    pub(crate) artifact_size: u64,
    pub(crate) artifact_sha256: String,
    pub(crate) version: String,
    pub(crate) product_code: String,
    pub(crate) expected_install_root: String,
    pub(crate) expected_executable_sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PostInstallObservation {
    pub(crate) ownership: ObservedOwnership,
    pub(crate) product_code: Option<String>,
    pub(crate) version: Option<String>,
    pub(crate) install_root: Option<String>,
    pub(crate) executable_sha256: Option<String>,
    pub(crate) source_metadata_present: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct InstallerExit {
    pub(crate) code: i32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum MigrationPhase {
    Prepared,
    GrantConsumptionPending,
    GrantConsumed,
    SourceDetachPending,
    SourceDetached,
    MetadataRemovalPending,
    MetadataRemoved,
    TargetInstallPending,
    TargetInstallReturned,
    Completed,
    RollbackTargetPending,
    RollbackTargetCompleted,
    RollbackMetadataPending,
    RollbackMetadataCompleted,
    RollbackRootPending,
    RolledBack,
    RollbackFailed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct MigrationManifest {
    pub(crate) schema_version: u32,
    pub(crate) journal_revision: u64,
    pub(crate) transaction_id: String,
    pub(crate) intent_id: String,
    pub(crate) intent_digest: String,
    pub(crate) grant_digest: String,
    pub(crate) grant_consumed: bool,
    pub(crate) phase: MigrationPhase,
    pub(crate) source: NsisSourceSnapshot,
    pub(crate) target: TargetInstallerSnapshot,
    pub(crate) pending_metadata_index: Option<usize>,
    pub(crate) removed_metadata_count: usize,
    pub(crate) restored_metadata_count: usize,
    pub(crate) source_detached: bool,
    pub(crate) source_root_restored: bool,
    pub(crate) target_install_attempted: bool,
    pub(crate) target_exit_code: Option<i32>,
    pub(crate) target_rollback_completed: bool,
    pub(crate) reboot_required: bool,
    pub(crate) last_error: Option<String>,
}

impl MigrationManifest {
    pub(crate) fn validate(&self) -> Result<(), MigrationEngineError> {
        if self.schema_version != INSTALLER_MIGRATION_ENGINE_SCHEMA_VERSION {
            return Err(MigrationEngineError::InvalidManifest(
                "unsupported migration manifest schema".into(),
            ));
        }
        validate_uuid(&self.transaction_id, "transactionId")?;
        validate_uuid(&self.intent_id, "intentId")?;
        validate_sha256(&self.intent_digest, "intentDigest")?;
        validate_sha256(&self.grant_digest, "grantDigest")?;
        validate_source_snapshot(&self.source)?;
        validate_target_snapshot(&self.target)?;
        if self
            .last_error
            .as_ref()
            .is_some_and(|message| message.len() > MAX_ERROR_MESSAGE_BYTES)
        {
            return Err(MigrationEngineError::InvalidManifest(
                "migration error text exceeds the size limit".into(),
            ));
        }

        if self.removed_metadata_count > self.source.metadata.len()
            || self.restored_metadata_count > self.removed_metadata_count
        {
            return Err(MigrationEngineError::InvalidManifest(
                "migration metadata progress is out of bounds".into(),
            ));
        }
        if let Some(index) = self.pending_metadata_index {
            if index >= self.source.metadata.len() {
                return Err(MigrationEngineError::InvalidManifest(
                    "pending metadata index is out of bounds".into(),
                ));
            }
        }
        match self.phase {
            MigrationPhase::MetadataRemovalPending
                if self.pending_metadata_index != Some(self.removed_metadata_count)
                    || self.removed_metadata_count >= self.source.metadata.len() =>
            {
                return Err(MigrationEngineError::InvalidManifest(
                    "forward metadata progress is not contiguous".into(),
                ));
            }
            MigrationPhase::RollbackMetadataPending
                if self.restored_metadata_count >= self.removed_metadata_count
                    || self.pending_metadata_index
                        != Some(self.removed_metadata_count - self.restored_metadata_count - 1) =>
            {
                return Err(MigrationEngineError::InvalidManifest(
                    "rollback metadata progress is not contiguous".into(),
                ));
            }
            MigrationPhase::MetadataRemovalPending | MigrationPhase::RollbackMetadataPending => {}
            _ if self.pending_metadata_index.is_some() => {
                return Err(MigrationEngineError::InvalidManifest(
                    "metadata index exists outside a pending metadata mutation".into(),
                ));
            }
            _ => {}
        }
        if self.source_root_restored && !self.source_detached {
            return Err(MigrationEngineError::InvalidManifest(
                "source root cannot be restored before it is detached".into(),
            ));
        }
        if self.target_exit_code.is_some() && !self.target_install_attempted {
            return Err(MigrationEngineError::InvalidManifest(
                "target exit code exists without an install attempt".into(),
            ));
        }
        if self.reboot_required && self.target_exit_code != Some(REBOOT_REQUIRED_EXIT_CODE) {
            return Err(MigrationEngineError::InvalidManifest(
                "reboot state does not match the installer exit code".into(),
            ));
        }
        if matches!(
            self.phase,
            MigrationPhase::Prepared
                | MigrationPhase::GrantConsumptionPending
                | MigrationPhase::GrantConsumed
                | MigrationPhase::SourceDetachPending
                | MigrationPhase::SourceDetached
                | MigrationPhase::MetadataRemovalPending
                | MigrationPhase::MetadataRemoved
                | MigrationPhase::TargetInstallPending
                | MigrationPhase::TargetInstallReturned
                | MigrationPhase::Completed
        ) && (self.restored_metadata_count != 0
            || self.source_root_restored
            || self.target_rollback_completed)
        {
            return Err(MigrationEngineError::InvalidManifest(
                "forward migration contains rollback progress".into(),
            ));
        }
        if self.phase == MigrationPhase::Completed
            && (!self.grant_consumed
                || !self.source_detached
                || self.removed_metadata_count != self.source.metadata.len()
                || !self.target_install_attempted
                || !is_success_exit(self.target_exit_code)
                || self.target_rollback_completed
                || self.restored_metadata_count != 0
                || self.source_root_restored)
        {
            return Err(MigrationEngineError::InvalidManifest(
                "completed migration manifest is internally inconsistent".into(),
            ));
        }
        match self.phase {
            MigrationPhase::Prepared | MigrationPhase::GrantConsumptionPending
                if self.grant_consumed
                    || self.source_detached
                    || self.removed_metadata_count != 0
                    || self.target_install_attempted =>
            {
                return Err(MigrationEngineError::InvalidManifest(
                    "prepared migration manifest already contains progress".into(),
                ));
            }
            MigrationPhase::GrantConsumed | MigrationPhase::SourceDetachPending
                if !self.grant_consumed
                    || self.source_detached
                    || self.removed_metadata_count != 0
                    || self.target_install_attempted =>
            {
                return Err(MigrationEngineError::InvalidManifest(
                    "migration advanced without consuming its grant".into(),
                ));
            }
            MigrationPhase::SourceDetached | MigrationPhase::MetadataRemovalPending
                if !self.grant_consumed
                    || !self.source_detached
                    || self.target_install_attempted =>
            {
                return Err(MigrationEngineError::InvalidManifest(
                    "metadata mutation advanced before source detachment".into(),
                ));
            }
            MigrationPhase::MetadataRemoved
                if !self.grant_consumed
                    || !self.source_detached
                    || self.removed_metadata_count != self.source.metadata.len()
                    || self.pending_metadata_index.is_some()
                    || self.target_install_attempted =>
            {
                return Err(MigrationEngineError::InvalidManifest(
                    "metadata-removed manifest is internally inconsistent".into(),
                ));
            }
            MigrationPhase::TargetInstallPending
                if !self.grant_consumed
                    || !self.source_detached
                    || self.removed_metadata_count != self.source.metadata.len()
                    || self.pending_metadata_index.is_some() =>
            {
                return Err(MigrationEngineError::InvalidManifest(
                    "target install advanced before metadata removal completed".into(),
                ));
            }
            MigrationPhase::TargetInstallPending if !self.target_install_attempted => {
                return Err(MigrationEngineError::InvalidManifest(
                    "target install is pending without a durable attempt marker".into(),
                ));
            }
            MigrationPhase::TargetInstallPending if self.target_exit_code.is_some() => {
                return Err(MigrationEngineError::InvalidManifest(
                    "target install is pending with a durable result".into(),
                ));
            }
            MigrationPhase::TargetInstallReturned | MigrationPhase::Completed
                if !self.grant_consumed
                    || !self.source_detached
                    || self.removed_metadata_count != self.source.metadata.len()
                    || self.pending_metadata_index.is_some()
                    || !self.target_install_attempted
                    || self.target_exit_code.is_none() =>
            {
                return Err(MigrationEngineError::InvalidManifest(
                    "target install returned without a durable result".into(),
                ));
            }
            _ => {}
        }
        if self.phase == MigrationPhase::RolledBack
            && (self.restored_metadata_count != self.removed_metadata_count
                || (self.source_detached && !self.source_root_restored)
                || (self.target_install_attempted && !self.target_rollback_completed))
        {
            return Err(MigrationEngineError::InvalidManifest(
                "rolled-back migration manifest is internally inconsistent".into(),
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum MigrationOutcome {
    Completed {
        transaction_id: String,
        reboot_required: bool,
    },
    RolledBack {
        transaction_id: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum MigrationEngineError {
    Contract(String),
    Blocked(String),
    InvalidManifest(String),
    Backend(String),
    Interrupted(String),
    FailedAndRolledBack(String),
    RollbackFailed { cause: String, rollback: String },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct MigrationBackendError {
    pub(crate) interrupted: bool,
    pub(crate) message: String,
}

impl MigrationBackendError {
    pub(crate) fn failure(message: impl Into<String>) -> Self {
        Self {
            interrupted: false,
            message: message.into(),
        }
    }

    pub(crate) fn interrupted(message: impl Into<String>) -> Self {
        Self {
            interrupted: true,
            message: message.into(),
        }
    }
}

/// Backend capabilities stay narrow so the engine cannot invoke an old NSIS
/// uninstaller or recursively delete an arbitrary directory.
///
/// Mutation methods must be idempotent for the same transaction and snapshot.
/// A non-interrupted error guarantees no mutation. An interrupted error may be
/// returned after mutation, so retry must reconcile and converge without
/// launching a second installer or duplicating ownership metadata.
pub(crate) trait MigrationBackend {
    fn now_unix_ms(&self) -> u64;
    /// Acquire and retain the exact transaction lease before any snapshot is
    /// allowed to derive a backup path or any journal revision is published.
    fn begin_transaction(&mut self, transaction_id: &str) -> Result<(), MigrationBackendError>;
    fn load_manifest(
        &mut self,
        intent_id: &str,
    ) -> Result<Option<MigrationManifest>, MigrationBackendError>;
    fn persist_manifest(
        &mut self,
        manifest: &MigrationManifest,
    ) -> Result<(), MigrationBackendError>;
    fn claim_continuation_grant(
        &mut self,
        grant_digest: &str,
        intent_id: &str,
        transaction_id: &str,
    ) -> Result<(), MigrationBackendError>;
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
    /// Treat journal progress as untrusted. Accept only live states compatible
    /// with the durable phase, including either side of a pending mutation.
    fn validate_manifest_recovery_state(
        &mut self,
        manifest: &MigrationManifest,
    ) -> Result<(), MigrationBackendError>;
    fn detach_source_root(
        &mut self,
        transaction_id: &str,
        source: &SourceRootSnapshot,
    ) -> Result<(), MigrationBackendError>;
    fn verify_source_detached(
        &mut self,
        manifest: &MigrationManifest,
    ) -> Result<bool, MigrationBackendError>;
    fn remove_exact_source_metadata(
        &mut self,
        transaction_id: &str,
        metadata: &ExactSourceMetadata,
    ) -> Result<(), MigrationBackendError>;
    fn install_target_msi(
        &mut self,
        transaction_id: &str,
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
        target: &TargetInstallerSnapshot,
    ) -> Result<(), MigrationBackendError>;
    fn restore_exact_source_metadata(
        &mut self,
        transaction_id: &str,
        metadata: &ExactSourceMetadata,
    ) -> Result<(), MigrationBackendError>;
    fn restore_source_root(
        &mut self,
        transaction_id: &str,
        source: &SourceRootSnapshot,
    ) -> Result<(), MigrationBackendError>;
    fn verify_source_restored(
        &mut self,
        manifest: &MigrationManifest,
    ) -> Result<bool, MigrationBackendError>;
}

pub(crate) struct MigrationEngine<B> {
    backend: B,
}

impl<B: MigrationBackend> MigrationEngine<B> {
    pub(crate) fn new(backend: B) -> Self {
        Self { backend }
    }

    pub(crate) fn into_backend(self) -> B {
        self.backend
    }

    pub(crate) fn execute(
        &mut self,
        intent: &MigrationIntent,
        continuation: &MigrationContinuation,
        expected_one_time_grant: &str,
    ) -> Result<MigrationOutcome, MigrationEngineError> {
        intent
            .validate_for_recovery()
            .map_err(|error| MigrationEngineError::Contract(format!("{error:?}")))?;
        continuation
            .validate_for_intent_recovery(intent, expected_one_time_grant)
            .map_err(|error| MigrationEngineError::Contract(format!("{error:?}")))?;
        if intent.target.family != InstallerFamily::Msi {
            return Err(MigrationEngineError::Blocked(
                "M2a supports only NSIS to MSI migration".into(),
            ));
        }

        let intent_digest = intent
            .digest()
            .map_err(|error| MigrationEngineError::Contract(format!("{error:?}")))?;
        let grant_digest = digest_bytes(continuation.one_time_grant.as_bytes());
        let mut manifest = match self
            .backend
            .load_manifest(&intent.intent_id)
            .map_err(map_backend_read_error)?
        {
            Some(manifest) => {
                manifest.validate()?;
                if manifest.intent_digest != intent_digest
                    || manifest.grant_digest != grant_digest
                    || manifest.intent_id != intent.intent_id
                {
                    return Err(MigrationEngineError::InvalidManifest(
                        "migration manifest is not bound to this intent and grant".into(),
                    ));
                }
                self.backend
                    .begin_transaction(&manifest.transaction_id)
                    .map_err(map_backend_read_error)?;
                self.backend
                    .validate_manifest_scope(&manifest)
                    .map_err(map_backend_read_error)?;
                self.backend
                    .validate_manifest_recovery_state(&manifest)
                    .map_err(map_backend_read_error)?;
                manifest
            }
            None => {
                continuation
                    .validate_for_intent(
                        intent,
                        expected_one_time_grant,
                        self.backend.now_unix_ms(),
                    )
                    .map_err(|error| MigrationEngineError::Contract(format!("{error:?}")))?;
                self.prepare_manifest(intent, &intent_digest, &grant_digest)?
            }
        };

        self.drive(intent.ui_mode, &mut manifest)
    }

    fn prepare_manifest(
        &mut self,
        intent: &MigrationIntent,
        intent_digest: &str,
        grant_digest: &str,
    ) -> Result<MigrationManifest, MigrationEngineError> {
        let transaction_id = uuid::Uuid::new_v4().hyphenated().to_string();
        self.backend
            .begin_transaction(&transaction_id)
            .map_err(map_backend_read_error)?;
        let source = self
            .backend
            .observe_nsis_source(intent, &transaction_id)
            .map_err(map_backend_read_error)?;
        validate_source_snapshot(&source)?;
        if source.ownership != ObservedOwnership::PureNsis {
            return Err(MigrationEngineError::Blocked(
                "source ownership is not uniquely NSIS".into(),
            ));
        }
        let target = self
            .backend
            .inspect_target_installer(&intent.target, &source)
            .map_err(map_backend_read_error)?;
        validate_target_snapshot(&target)?;
        validate_target_binding(&intent.target, &source, &target)?;

        let mut manifest = MigrationManifest {
            schema_version: INSTALLER_MIGRATION_ENGINE_SCHEMA_VERSION,
            journal_revision: 0,
            transaction_id,
            intent_id: intent.intent_id.clone(),
            intent_digest: intent_digest.into(),
            grant_digest: grant_digest.into(),
            grant_consumed: false,
            phase: MigrationPhase::Prepared,
            source,
            target,
            pending_metadata_index: None,
            removed_metadata_count: 0,
            restored_metadata_count: 0,
            source_detached: false,
            source_root_restored: false,
            target_install_attempted: false,
            target_exit_code: None,
            target_rollback_completed: false,
            reboot_required: false,
            last_error: None,
        };
        manifest.validate()?;
        self.persist(&mut manifest)?;
        Ok(manifest)
    }

    fn drive(
        &mut self,
        ui_mode: InstallerUiMode,
        manifest: &mut MigrationManifest,
    ) -> Result<MigrationOutcome, MigrationEngineError> {
        loop {
            manifest.validate()?;
            match manifest.phase {
                MigrationPhase::Prepared => {
                    manifest.phase = MigrationPhase::GrantConsumptionPending;
                    self.persist(manifest)?;
                }
                MigrationPhase::GrantConsumptionPending => {
                    if let Err(error) = self.backend.claim_continuation_grant(
                        &manifest.grant_digest,
                        &manifest.intent_id,
                        &manifest.transaction_id,
                    ) {
                        return self.forward_mutation_failed(manifest, error);
                    }
                    manifest.grant_consumed = true;
                    manifest.phase = MigrationPhase::GrantConsumed;
                    self.persist(manifest)?;
                }
                MigrationPhase::GrantConsumed => {
                    manifest.phase = MigrationPhase::SourceDetachPending;
                    self.persist(manifest)?;
                }
                MigrationPhase::SourceDetachPending => {
                    if let Err(error) = self
                        .backend
                        .detach_source_root(&manifest.transaction_id, &manifest.source.root)
                    {
                        return self.forward_mutation_failed(manifest, error);
                    }
                    manifest.source_detached = true;
                    manifest.phase = MigrationPhase::SourceDetached;
                    self.persist(manifest)?;
                }
                MigrationPhase::SourceDetached => {
                    if manifest.removed_metadata_count == 0 {
                        match self.backend.verify_source_detached(manifest) {
                            Ok(true) => {}
                            Ok(false) => {
                                return self.fail_and_rollback(
                                    manifest,
                                    "source root backup postcondition failed".into(),
                                )
                            }
                            Err(error) if error.interrupted => {
                                return Err(MigrationEngineError::Interrupted(error.message))
                            }
                            Err(error) => return self.fail_and_rollback(manifest, error.message),
                        }
                    }
                    if manifest.removed_metadata_count < manifest.source.metadata.len() {
                        manifest.pending_metadata_index = Some(manifest.removed_metadata_count);
                        manifest.phase = MigrationPhase::MetadataRemovalPending;
                    } else {
                        manifest.phase = MigrationPhase::MetadataRemoved;
                    }
                    self.persist(manifest)?;
                }
                MigrationPhase::MetadataRemovalPending => {
                    let index = manifest.pending_metadata_index.ok_or_else(|| {
                        MigrationEngineError::InvalidManifest(
                            "metadata removal is pending without an index".into(),
                        )
                    })?;
                    let metadata = &manifest.source.metadata[index];
                    if let Err(error) = self
                        .backend
                        .remove_exact_source_metadata(&manifest.transaction_id, metadata)
                    {
                        return self.forward_mutation_failed(manifest, error);
                    }
                    manifest.removed_metadata_count = index + 1;
                    manifest.pending_metadata_index = None;
                    manifest.phase = MigrationPhase::SourceDetached;
                    self.persist(manifest)?;
                }
                MigrationPhase::MetadataRemoved => {
                    manifest.target_install_attempted = true;
                    manifest.phase = MigrationPhase::TargetInstallPending;
                    self.persist(manifest)?;
                }
                MigrationPhase::TargetInstallPending => {
                    let exit = match self.backend.install_target_msi(
                        &manifest.transaction_id,
                        &manifest.target,
                        ui_mode,
                    ) {
                        Ok(exit) => exit,
                        Err(error) => return self.forward_mutation_failed(manifest, error),
                    };
                    manifest.target_exit_code = Some(exit.code);
                    manifest.reboot_required = exit.code == REBOOT_REQUIRED_EXIT_CODE;
                    manifest.phase = MigrationPhase::TargetInstallReturned;
                    self.persist(manifest)?;
                }
                MigrationPhase::TargetInstallReturned => {
                    if !is_success_exit(manifest.target_exit_code) {
                        return self.fail_and_rollback(
                            manifest,
                            format!(
                                "target MSI returned exit code {}",
                                manifest.target_exit_code.unwrap_or(-1)
                            ),
                        );
                    }
                    let observation = match self.backend.observe_post_install(manifest) {
                        Ok(observation) => observation,
                        Err(error) if error.interrupted => {
                            return Err(MigrationEngineError::Interrupted(error.message))
                        }
                        Err(error) => {
                            return self.fail_and_rollback(manifest, error.message);
                        }
                    };
                    if let Err(error) = verify_post_install(manifest, &observation) {
                        return self.fail_and_rollback(manifest, error);
                    }
                    manifest.phase = MigrationPhase::Completed;
                    manifest.last_error = None;
                    self.persist(manifest)?;
                }
                MigrationPhase::Completed => {
                    let observation = match self.backend.observe_post_install(manifest) {
                        Ok(observation) => observation,
                        Err(error) if error.interrupted => {
                            return Err(MigrationEngineError::Interrupted(error.message))
                        }
                        Err(error) => return Err(MigrationEngineError::Backend(error.message)),
                    };
                    if let Err(error) = verify_post_install(manifest, &observation) {
                        return Err(MigrationEngineError::Blocked(format!(
                            "completed migration postcondition failed: {error}"
                        )));
                    }
                    return Ok(MigrationOutcome::Completed {
                        transaction_id: manifest.transaction_id.clone(),
                        reboot_required: manifest.reboot_required,
                    });
                }
                MigrationPhase::RolledBack => {
                    match self.backend.verify_source_restored(manifest) {
                        Ok(true) => {}
                        Ok(false) => {
                            return self.mark_rollback_failed(
                                manifest,
                                "rolled-back migration recovery",
                                "source restoration postcondition failed".into(),
                            )
                        }
                        Err(error) if error.interrupted => {
                            return Err(MigrationEngineError::Interrupted(error.message))
                        }
                        Err(error) => {
                            return self.mark_rollback_failed(
                                manifest,
                                "rolled-back migration recovery",
                                error.message,
                            )
                        }
                    }
                    return Ok(MigrationOutcome::RolledBack {
                        transaction_id: manifest.transaction_id.clone(),
                    });
                }
                MigrationPhase::RollbackTargetPending
                | MigrationPhase::RollbackTargetCompleted
                | MigrationPhase::RollbackMetadataPending
                | MigrationPhase::RollbackMetadataCompleted
                | MigrationPhase::RollbackRootPending
                | MigrationPhase::RollbackFailed => return self.drive_rollback(manifest, None),
            }
        }
    }

    fn forward_mutation_failed(
        &mut self,
        manifest: &mut MigrationManifest,
        error: MigrationBackendError,
    ) -> Result<MigrationOutcome, MigrationEngineError> {
        if error.interrupted {
            Err(MigrationEngineError::Interrupted(error.message))
        } else {
            self.fail_and_rollback(manifest, error.message)
        }
    }

    fn fail_and_rollback(
        &mut self,
        manifest: &mut MigrationManifest,
        cause: String,
    ) -> Result<MigrationOutcome, MigrationEngineError> {
        manifest.pending_metadata_index = None;
        manifest.last_error = Some(bounded_manifest_error(cause.clone()));
        match self.drive_rollback(manifest, Some(cause.clone())) {
            Ok(MigrationOutcome::RolledBack { .. }) => {
                Err(MigrationEngineError::FailedAndRolledBack(cause))
            }
            Ok(MigrationOutcome::Completed { .. }) => unreachable!("rollback completed forward"),
            Err(MigrationEngineError::Interrupted(message)) => {
                Err(MigrationEngineError::Interrupted(message))
            }
            Err(MigrationEngineError::RollbackFailed { rollback, .. }) => {
                Err(MigrationEngineError::RollbackFailed { cause, rollback })
            }
            Err(other) => Err(MigrationEngineError::RollbackFailed {
                cause,
                rollback: format!("{other:?}"),
            }),
        }
    }

    fn drive_rollback(
        &mut self,
        manifest: &mut MigrationManifest,
        cause: Option<String>,
    ) -> Result<MigrationOutcome, MigrationEngineError> {
        let cause = cause
            .or_else(|| manifest.last_error.clone())
            .unwrap_or_else(|| "interrupted migration recovery".into());
        loop {
            if manifest.target_install_attempted && !manifest.target_rollback_completed {
                manifest.phase = MigrationPhase::RollbackTargetPending;
                self.persist(manifest)?;
                if let Err(error) = self
                    .backend
                    .rollback_exact_target_msi(&manifest.transaction_id, &manifest.target)
                {
                    return self.rollback_mutation_failed(manifest, &cause, error);
                }
                manifest.target_rollback_completed = true;
                manifest.phase = MigrationPhase::RollbackTargetCompleted;
                self.persist(manifest)?;
                continue;
            }

            if manifest.restored_metadata_count < manifest.removed_metadata_count {
                let index = manifest.removed_metadata_count - manifest.restored_metadata_count - 1;
                manifest.pending_metadata_index = Some(index);
                manifest.phase = MigrationPhase::RollbackMetadataPending;
                self.persist(manifest)?;
                if let Err(error) = self.backend.restore_exact_source_metadata(
                    &manifest.transaction_id,
                    &manifest.source.metadata[index],
                ) {
                    return self.rollback_mutation_failed(manifest, &cause, error);
                }
                manifest.restored_metadata_count += 1;
                manifest.pending_metadata_index = None;
                manifest.phase = MigrationPhase::RollbackTargetCompleted;
                self.persist(manifest)?;
                continue;
            }
            manifest.phase = MigrationPhase::RollbackMetadataCompleted;
            self.persist(manifest)?;

            if manifest.source_detached && !manifest.source_root_restored {
                manifest.phase = MigrationPhase::RollbackRootPending;
                self.persist(manifest)?;
                if let Err(error) = self
                    .backend
                    .restore_source_root(&manifest.transaction_id, &manifest.source.root)
                {
                    return self.rollback_mutation_failed(manifest, &cause, error);
                }
                manifest.source_root_restored = true;
                self.persist(manifest)?;
            }

            match self.backend.verify_source_restored(manifest) {
                Ok(true) => {}
                Ok(false) => {
                    return self.mark_rollback_failed(
                        manifest,
                        &cause,
                        "source restoration postcondition failed".into(),
                    )
                }
                Err(error) if error.interrupted => {
                    return Err(MigrationEngineError::Interrupted(error.message))
                }
                Err(error) => return self.mark_rollback_failed(manifest, &cause, error.message),
            }
            manifest.phase = MigrationPhase::RolledBack;
            self.persist(manifest)?;
            return Ok(MigrationOutcome::RolledBack {
                transaction_id: manifest.transaction_id.clone(),
            });
        }
    }

    fn rollback_mutation_failed(
        &mut self,
        manifest: &mut MigrationManifest,
        cause: &str,
        error: MigrationBackendError,
    ) -> Result<MigrationOutcome, MigrationEngineError> {
        if error.interrupted {
            Err(MigrationEngineError::Interrupted(error.message))
        } else {
            self.mark_rollback_failed(manifest, cause, error.message)
        }
    }

    fn mark_rollback_failed(
        &mut self,
        manifest: &mut MigrationManifest,
        cause: &str,
        rollback: String,
    ) -> Result<MigrationOutcome, MigrationEngineError> {
        manifest.phase = MigrationPhase::RollbackFailed;
        manifest.pending_metadata_index = None;
        manifest.last_error = Some(bounded_manifest_error(format!(
            "{cause}; rollback: {rollback}"
        )));
        let _ = self.persist(manifest);
        Err(MigrationEngineError::RollbackFailed {
            cause: cause.into(),
            rollback,
        })
    }

    fn persist(&mut self, manifest: &mut MigrationManifest) -> Result<(), MigrationEngineError> {
        manifest.journal_revision = manifest.journal_revision.checked_add(1).ok_or_else(|| {
            MigrationEngineError::InvalidManifest("journal revision overflow".into())
        })?;
        manifest.validate()?;
        self.backend
            .persist_manifest(manifest)
            .map_err(|error| MigrationEngineError::Interrupted(error.message))
    }
}

fn map_backend_read_error(error: MigrationBackendError) -> MigrationEngineError {
    if error.interrupted {
        MigrationEngineError::Interrupted(error.message)
    } else {
        MigrationEngineError::Backend(error.message)
    }
}

fn bounded_manifest_error(mut message: String) -> String {
    if message.len() <= MAX_ERROR_MESSAGE_BYTES {
        return message;
    }
    let mut boundary = MAX_ERROR_MESSAGE_BYTES;
    while !message.is_char_boundary(boundary) {
        boundary -= 1;
    }
    message.truncate(boundary);
    message
}

fn validate_source_snapshot(source: &NsisSourceSnapshot) -> Result<(), MigrationEngineError> {
    if source.ownership != ObservedOwnership::PureNsis {
        return Err(MigrationEngineError::Blocked(
            "source ownership is not pure NSIS".into(),
        ));
    }
    if source.root.source_path.is_empty()
        || source.root.backup_path.is_empty()
        || source.root.source_path.len() > MAX_MANIFEST_TEXT_BYTES
        || source.root.backup_path.len() > MAX_MANIFEST_TEXT_BYTES
        || source.root.source_path == source.root.backup_path
    {
        return Err(MigrationEngineError::InvalidManifest(
            "source root paths are invalid".into(),
        ));
    }
    validate_sha256(&source.root.tree_sha256, "sourceTreeSha256")?;
    if source.metadata.is_empty()
        || source.metadata.len() > MAX_SOURCE_METADATA_ITEMS
        || !source
            .metadata
            .iter()
            .any(|item| item.kind == SourceMetadataKind::NsisUninstallRegistration)
    {
        return Err(MigrationEngineError::InvalidManifest(
            "source metadata lacks an NSIS uninstall registration".into(),
        ));
    }
    let mut locators = BTreeSet::new();
    let mut total_snapshot_bytes = 0usize;
    for metadata in &source.metadata {
        if metadata.locator.is_empty()
            || metadata.locator.len() > 32_767
            || metadata.snapshot.is_empty()
            || metadata.snapshot.len() > MAX_METADATA_SNAPSHOT_BYTES
            || !locators.insert(metadata.locator.as_str())
        {
            return Err(MigrationEngineError::InvalidManifest(
                "source metadata locator or snapshot is invalid".into(),
            ));
        }
        total_snapshot_bytes = total_snapshot_bytes
            .checked_add(metadata.snapshot.len())
            .ok_or_else(|| {
                MigrationEngineError::InvalidManifest(
                    "source metadata snapshot size overflowed".into(),
                )
            })?;
        if total_snapshot_bytes > MAX_TOTAL_METADATA_SNAPSHOT_BYTES {
            return Err(MigrationEngineError::InvalidManifest(
                "source metadata snapshots exceed the total size limit".into(),
            ));
        }
        validate_sha256(&metadata.snapshot_sha256, "metadataSnapshotSha256")?;
        if digest_bytes(&metadata.snapshot) != metadata.snapshot_sha256 {
            return Err(MigrationEngineError::InvalidManifest(
                "source metadata snapshot digest mismatch".into(),
            ));
        }
    }
    Ok(())
}

fn validate_target_snapshot(target: &TargetInstallerSnapshot) -> Result<(), MigrationEngineError> {
    if target.family != InstallerFamily::Msi
        || target.artifact_path.is_empty()
        || target.artifact_path.len() > MAX_MANIFEST_TEXT_BYTES
        || target.artifact_size == 0
        || target.version.is_empty()
        || target.version.len() > MAX_MANIFEST_TEXT_BYTES
        || target.product_code.is_empty()
        || target.product_code.len() > MAX_MANIFEST_TEXT_BYTES
        || target.expected_install_root.is_empty()
        || target.expected_install_root.len() > MAX_MANIFEST_TEXT_BYTES
    {
        return Err(MigrationEngineError::InvalidManifest(
            "target installer snapshot is incomplete".into(),
        ));
    }
    validate_sha256(&target.artifact_sha256, "targetArtifactSha256")?;
    validate_sha256(&target.expected_executable_sha256, "targetExecutableSha256")?;
    Ok(())
}

fn validate_target_binding(
    requested: &MigrationTarget,
    source: &NsisSourceSnapshot,
    actual: &TargetInstallerSnapshot,
) -> Result<(), MigrationEngineError> {
    if requested.family != actual.family
        || requested.artifact_path != actual.artifact_path
        || requested.artifact_size != actual.artifact_size
        || requested.artifact_sha256 != actual.artifact_sha256
        || requested.version != actual.version
        || source.root.source_path != actual.expected_install_root
    {
        return Err(MigrationEngineError::Blocked(
            "target installer does not match the migration intent and source root".into(),
        ));
    }
    Ok(())
}

fn verify_post_install(
    manifest: &MigrationManifest,
    observation: &PostInstallObservation,
) -> Result<(), String> {
    if observation.ownership != ObservedOwnership::PureMsi
        || observation.product_code.as_deref() != Some(manifest.target.product_code.as_str())
        || observation.version.as_deref() != Some(manifest.target.version.as_str())
        || observation.install_root.as_deref()
            != Some(manifest.target.expected_install_root.as_str())
        || observation.executable_sha256.as_deref()
            != Some(manifest.target.expected_executable_sha256.as_str())
        || observation.source_metadata_present
    {
        return Err("target MSI postcondition is not uniquely satisfied".into());
    }
    Ok(())
}

fn is_success_exit(code: Option<i32>) -> bool {
    matches!(code, Some(0 | REBOOT_REQUIRED_EXIT_CODE))
}

fn validate_uuid(value: &str, label: &str) -> Result<(), MigrationEngineError> {
    let parsed = uuid::Uuid::parse_str(value)
        .map_err(|_| MigrationEngineError::InvalidManifest(format!("invalid {label}")))?;
    if parsed.hyphenated().to_string() != value {
        return Err(MigrationEngineError::InvalidManifest(format!(
            "invalid {label}"
        )));
    }
    Ok(())
}

fn validate_sha256(value: &str, label: &str) -> Result<(), MigrationEngineError> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(MigrationEngineError::InvalidManifest(format!(
            "invalid {label}"
        )));
    }
    Ok(())
}

fn digest_bytes(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shared::installer_migration_core::{
        InstallerScope, MigrationContinuation, MigrationTarget, INSTALLER_MIGRATION_SCHEMA_VERSION,
    };
    use std::collections::{BTreeMap, HashMap};

    const NOW: u64 = 1_750_000_000_000;
    const INTENT_ID: &str = "11111111-1111-4111-8111-111111111111";
    const CONTINUATION_ID: &str = "22222222-2222-4222-8222-222222222222";
    const NONCE: &str = "33333333-3333-4333-8333-333333333333";
    const GRANT: &str = "44444444-4444-4444-8444-444444444444";
    const OTHER_GRANT: &str = "55555555-5555-4555-8555-555555555555";
    const ARTIFACT_HASH: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const TREE_HASH: &str = "1123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const EXE_HASH: &str = "2123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    #[derive(Clone)]
    struct FakeBackend {
        now: u64,
        source: NsisSourceSnapshot,
        target: TargetInstallerSnapshot,
        manifests: HashMap<String, MigrationManifest>,
        claims: HashMap<String, (String, String)>,
        source_attached: bool,
        metadata_present: Vec<bool>,
        target_installed: bool,
        install_exit_code: i32,
        post_invalid: bool,
        fail_before: Option<(&'static str, usize)>,
        interrupt_after: Option<(&'static str, usize)>,
        calls: BTreeMap<&'static str, usize>,
    }

    impl FakeBackend {
        fn healthy() -> Self {
            let metadata = [
                (SourceMetadataKind::NsisUninstallRegistration, "hkcu32"),
                (SourceMetadataKind::NsisUninstallRegistration, "hkcu64"),
                (SourceMetadataKind::VendorRegistration, "vendor"),
                (SourceMetadataKind::Shortcut, "shortcut"),
            ]
            .into_iter()
            .map(|(kind, locator)| {
                let snapshot = format!("snapshot-{locator}").into_bytes();
                ExactSourceMetadata {
                    kind,
                    locator: locator.into(),
                    snapshot_sha256: digest_bytes(&snapshot),
                    snapshot,
                }
            })
            .collect::<Vec<_>>();
            let source = NsisSourceSnapshot {
                ownership: ObservedOwnership::PureNsis,
                root: SourceRootSnapshot {
                    source_path: r"C:\Apps\ThreadFleet".into(),
                    backup_path: r"C:\Migration\tx\source".into(),
                    tree_sha256: TREE_HASH.into(),
                },
                metadata,
            };
            let target = TargetInstallerSnapshot {
                family: InstallerFamily::Msi,
                artifact_path: r"C:\Migration\target.msi".into(),
                artifact_size: 42,
                artifact_sha256: ARTIFACT_HASH.into(),
                version: "0.7.91".into(),
                product_code: "{AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE}".into(),
                expected_install_root: source.root.source_path.clone(),
                expected_executable_sha256: EXE_HASH.into(),
            };
            Self {
                now: NOW,
                metadata_present: vec![true; source.metadata.len()],
                source,
                target,
                manifests: HashMap::new(),
                claims: HashMap::new(),
                source_attached: true,
                target_installed: false,
                install_exit_code: 0,
                post_invalid: false,
                fail_before: None,
                interrupt_after: None,
                calls: BTreeMap::new(),
            }
        }

        fn fail(mut self, name: &'static str, call: usize) -> Self {
            self.fail_before = Some((name, call));
            self
        }

        fn interrupt(mut self, name: &'static str, call: usize) -> Self {
            self.interrupt_after = Some((name, call));
            self
        }

        fn before(&mut self, name: &'static str) -> Result<usize, MigrationBackendError> {
            let call = self.calls.entry(name).or_default();
            *call += 1;
            if self.fail_before == Some((name, *call)) {
                return Err(MigrationBackendError::failure(format!(
                    "injected {name} failure"
                )));
            }
            Ok(*call)
        }

        fn after(&self, name: &'static str, call: usize) -> Result<(), MigrationBackendError> {
            if self.interrupt_after == Some((name, call)) {
                Err(MigrationBackendError::interrupted(format!(
                    "injected crash after {name}"
                )))
            } else {
                Ok(())
            }
        }

        fn fully_restored(&self) -> bool {
            self.source_attached
                && self.metadata_present.iter().all(|present| *present)
                && !self.target_installed
        }
    }

    impl MigrationBackend for FakeBackend {
        fn now_unix_ms(&self) -> u64 {
            self.now
        }

        fn begin_transaction(&mut self, transaction_id: &str) -> Result<(), MigrationBackendError> {
            validate_uuid(transaction_id, "transactionId")
                .map_err(|error| MigrationBackendError::failure(format!("{error:?}")))
        }

        fn load_manifest(
            &mut self,
            intent_id: &str,
        ) -> Result<Option<MigrationManifest>, MigrationBackendError> {
            Ok(self.manifests.get(intent_id).cloned())
        }

        fn persist_manifest(
            &mut self,
            manifest: &MigrationManifest,
        ) -> Result<(), MigrationBackendError> {
            let call = self.before("persist")?;
            self.manifests
                .insert(manifest.intent_id.clone(), manifest.clone());
            self.after("persist", call)
        }

        fn claim_continuation_grant(
            &mut self,
            grant_digest: &str,
            intent_id: &str,
            transaction_id: &str,
        ) -> Result<(), MigrationBackendError> {
            let call = self.before("claim_grant")?;
            match self.claims.get(grant_digest) {
                Some(owner) if owner != &(intent_id.into(), transaction_id.into()) => {
                    return Err(MigrationBackendError::failure("grant already consumed"))
                }
                Some(_) => {}
                None => {
                    self.claims.insert(
                        grant_digest.into(),
                        (intent_id.into(), transaction_id.into()),
                    );
                }
            }
            self.after("claim_grant", call)
        }

        fn observe_nsis_source(
            &mut self,
            _intent: &MigrationIntent,
            _transaction_id: &str,
        ) -> Result<NsisSourceSnapshot, MigrationBackendError> {
            Ok(self.source.clone())
        }

        fn inspect_target_installer(
            &mut self,
            _target: &MigrationTarget,
            _source: &NsisSourceSnapshot,
        ) -> Result<TargetInstallerSnapshot, MigrationBackendError> {
            Ok(self.target.clone())
        }

        fn validate_manifest_scope(
            &mut self,
            manifest: &MigrationManifest,
        ) -> Result<(), MigrationBackendError> {
            if manifest.source != self.source || manifest.target != self.target {
                return Err(MigrationBackendError::failure("manifest scope drifted"));
            }
            Ok(())
        }

        fn validate_manifest_recovery_state(
            &mut self,
            manifest: &MigrationManifest,
        ) -> Result<(), MigrationBackendError> {
            let actual_removed_count = self
                .metadata_present
                .iter()
                .take_while(|present| !**present)
                .count();
            let metadata_is_contiguous = self
                .metadata_present
                .iter()
                .skip(actual_removed_count)
                .all(|present| *present);
            let forward_metadata_matches =
                metadata_is_contiguous && actual_removed_count == manifest.removed_metadata_count;
            let rollback_remaining = manifest
                .removed_metadata_count
                .saturating_sub(manifest.restored_metadata_count);
            let rollback_metadata_matches =
                metadata_is_contiguous && actual_removed_count == rollback_remaining;
            let source_matches_detach_progress =
                self.source_attached != manifest.source_detached || manifest.source_root_restored;

            let valid = match manifest.phase {
                MigrationPhase::Prepared
                | MigrationPhase::GrantConsumptionPending
                | MigrationPhase::GrantConsumed => {
                    self.source_attached && actual_removed_count == 0 && !self.target_installed
                }
                MigrationPhase::SourceDetachPending => {
                    actual_removed_count == 0 && !self.target_installed
                }
                MigrationPhase::SourceDetached => {
                    !self.source_attached && forward_metadata_matches && !self.target_installed
                }
                MigrationPhase::MetadataRemovalPending => {
                    !self.source_attached
                        && metadata_is_contiguous
                        && matches!(
                            actual_removed_count,
                            count if count == manifest.removed_metadata_count
                                || count == manifest.removed_metadata_count + 1
                        )
                        && !self.target_installed
                }
                MigrationPhase::MetadataRemoved => {
                    !self.source_attached
                        && actual_removed_count == manifest.source.metadata.len()
                        && !self.target_installed
                }
                MigrationPhase::TargetInstallPending => {
                    !self.source_attached && actual_removed_count == manifest.source.metadata.len()
                }
                MigrationPhase::TargetInstallReturned => {
                    !self.source_attached
                        && actual_removed_count == manifest.source.metadata.len()
                        && self.target_installed == is_success_exit(manifest.target_exit_code)
                }
                MigrationPhase::Completed => {
                    !self.source_attached && actual_removed_count == manifest.source.metadata.len()
                }
                MigrationPhase::RollbackTargetPending => {
                    source_matches_detach_progress && forward_metadata_matches
                }
                MigrationPhase::RollbackTargetCompleted => {
                    source_matches_detach_progress
                        && forward_metadata_matches
                        && !self.target_installed
                }
                MigrationPhase::RollbackMetadataPending => {
                    source_matches_detach_progress
                        && metadata_is_contiguous
                        && matches!(
                            actual_removed_count,
                            count if count == rollback_remaining
                                || count + 1 == rollback_remaining
                        )
                        && !self.target_installed
                }
                MigrationPhase::RollbackMetadataCompleted => {
                    source_matches_detach_progress
                        && actual_removed_count == 0
                        && !self.target_installed
                }
                MigrationPhase::RollbackRootPending => {
                    actual_removed_count == 0 && !self.target_installed
                }
                MigrationPhase::RolledBack => true,
                MigrationPhase::RollbackFailed => rollback_metadata_matches,
            };
            if !valid {
                return Err(MigrationBackendError::failure(
                    "manifest progress does not match live recovery state",
                ));
            }
            Ok(())
        }

        fn detach_source_root(
            &mut self,
            _transaction_id: &str,
            source: &SourceRootSnapshot,
        ) -> Result<(), MigrationBackendError> {
            let call = self.before("detach_root")?;
            if source != &self.source.root {
                return Err(MigrationBackendError::failure("wrong source root"));
            }
            self.source_attached = false;
            self.after("detach_root", call)
        }

        fn remove_exact_source_metadata(
            &mut self,
            _transaction_id: &str,
            metadata: &ExactSourceMetadata,
        ) -> Result<(), MigrationBackendError> {
            let call = self.before("remove_metadata")?;
            let index = self
                .source
                .metadata
                .iter()
                .position(|candidate| candidate == metadata)
                .ok_or_else(|| MigrationBackendError::failure("unknown metadata"))?;
            self.metadata_present[index] = false;
            self.after("remove_metadata", call)
        }

        fn verify_source_detached(
            &mut self,
            manifest: &MigrationManifest,
        ) -> Result<bool, MigrationBackendError> {
            Ok(!self.source_attached
                && manifest.source.root == self.source.root
                && manifest.source.root.tree_sha256 == TREE_HASH)
        }

        fn install_target_msi(
            &mut self,
            _transaction_id: &str,
            target: &TargetInstallerSnapshot,
            _ui_mode: InstallerUiMode,
        ) -> Result<InstallerExit, MigrationBackendError> {
            let call = self.before("install_target")?;
            if target != &self.target {
                return Err(MigrationBackendError::failure("wrong target"));
            }
            if matches!(self.install_exit_code, 0 | REBOOT_REQUIRED_EXIT_CODE) {
                self.target_installed = true;
            }
            self.after("install_target", call)?;
            Ok(InstallerExit {
                code: self.install_exit_code,
            })
        }

        fn observe_post_install(
            &mut self,
            _manifest: &MigrationManifest,
        ) -> Result<PostInstallObservation, MigrationBackendError> {
            self.before("observe_post_install")?;
            if self.post_invalid {
                return Ok(PostInstallObservation {
                    ownership: ObservedOwnership::Mixed,
                    product_code: Some(self.target.product_code.clone()),
                    version: Some(self.target.version.clone()),
                    install_root: Some(self.target.expected_install_root.clone()),
                    executable_sha256: Some(self.target.expected_executable_sha256.clone()),
                    source_metadata_present: true,
                });
            }
            Ok(PostInstallObservation {
                ownership: if self.target_installed {
                    ObservedOwnership::PureMsi
                } else {
                    ObservedOwnership::Unknown
                },
                product_code: self
                    .target_installed
                    .then(|| self.target.product_code.clone()),
                version: self.target_installed.then(|| self.target.version.clone()),
                install_root: self
                    .target_installed
                    .then(|| self.target.expected_install_root.clone()),
                executable_sha256: self
                    .target_installed
                    .then(|| self.target.expected_executable_sha256.clone()),
                source_metadata_present: self.metadata_present.iter().any(|present| *present),
            })
        }

        fn rollback_exact_target_msi(
            &mut self,
            _transaction_id: &str,
            target: &TargetInstallerSnapshot,
        ) -> Result<(), MigrationBackendError> {
            let call = self.before("rollback_target")?;
            if target.product_code != self.target.product_code {
                return Err(MigrationBackendError::failure("wrong product code"));
            }
            self.target_installed = false;
            self.after("rollback_target", call)
        }

        fn restore_exact_source_metadata(
            &mut self,
            _transaction_id: &str,
            metadata: &ExactSourceMetadata,
        ) -> Result<(), MigrationBackendError> {
            let call = self.before("restore_metadata")?;
            let index = self
                .source
                .metadata
                .iter()
                .position(|candidate| candidate == metadata)
                .ok_or_else(|| MigrationBackendError::failure("unknown metadata"))?;
            self.metadata_present[index] = true;
            self.after("restore_metadata", call)
        }

        fn restore_source_root(
            &mut self,
            _transaction_id: &str,
            source: &SourceRootSnapshot,
        ) -> Result<(), MigrationBackendError> {
            let call = self.before("restore_root")?;
            if source != &self.source.root {
                return Err(MigrationBackendError::failure("wrong source root"));
            }
            self.source_attached = true;
            self.after("restore_root", call)
        }

        fn verify_source_restored(
            &mut self,
            _manifest: &MigrationManifest,
        ) -> Result<bool, MigrationBackendError> {
            Ok(self.fully_restored())
        }
    }

    fn intent_with_id(intent_id: &str) -> MigrationIntent {
        MigrationIntent {
            schema_version: INSTALLER_MIGRATION_SCHEMA_VERSION,
            intent_id: intent_id.into(),
            nonce: NONCE.into(),
            created_at_unix_ms: NOW - 1_000,
            expires_at_unix_ms: NOW + 60_000,
            adapter_family: InstallerFamily::Msi,
            target: MigrationTarget {
                family: InstallerFamily::Msi,
                version: "0.7.91".into(),
                artifact_path: r"C:\Migration\target.msi".into(),
                artifact_size: 42,
                artifact_sha256: ARTIFACT_HASH.into(),
            },
            scope: InstallerScope::PerMachine,
            ui_mode: InstallerUiMode::Interactive,
            parent_pid: 42,
            original_user_sid: "S-1-5-21-1000".into(),
            original_session_id: 1,
        }
    }

    fn continuation(intent: &MigrationIntent, grant: &str) -> MigrationContinuation {
        MigrationContinuation {
            schema_version: INSTALLER_MIGRATION_SCHEMA_VERSION,
            continuation_id: CONTINUATION_ID.into(),
            intent_id: intent.intent_id.clone(),
            intent_digest: intent.digest().unwrap(),
            target_family: InstallerFamily::Msi,
            target_artifact_sha256: ARTIFACT_HASH.into(),
            one_time_grant: grant.into(),
            created_at_unix_ms: NOW,
            expires_at_unix_ms: NOW + 30_000,
        }
    }

    fn run(backend: FakeBackend) -> (Result<MigrationOutcome, MigrationEngineError>, FakeBackend) {
        let intent = intent_with_id(INTENT_ID);
        let continuation = continuation(&intent, GRANT);
        let mut engine = MigrationEngine::new(backend);
        let result = engine.execute(&intent, &continuation, GRANT);
        (result, engine.into_backend())
    }

    #[test]
    fn completes_on_success_and_reboot_required_exit_codes() {
        for (exit_code, reboot_required) in [(0, false), (REBOOT_REQUIRED_EXIT_CODE, true)] {
            let mut backend = FakeBackend::healthy();
            backend.install_exit_code = exit_code;
            let (result, backend) = run(backend);
            assert!(matches!(
                result,
                Ok(MigrationOutcome::Completed {
                    reboot_required: actual,
                    ..
                }) if actual == reboot_required
            ));
            assert!(!backend.source_attached);
            assert!(backend.metadata_present.iter().all(|present| !*present));
            assert!(backend.target_installed);
            assert_eq!(backend.claims.len(), 1);
        }
    }

    #[test]
    fn every_forward_mutation_failure_rolls_back_without_source_loss() {
        for (name, call) in [
            ("claim_grant", 1),
            ("detach_root", 1),
            ("remove_metadata", 1),
            ("remove_metadata", 3),
            ("install_target", 1),
        ] {
            let (result, backend) = run(FakeBackend::healthy().fail(name, call));
            assert!(
                matches!(result, Err(MigrationEngineError::FailedAndRolledBack(_))),
                "{name} {call}: {result:?}"
            );
            assert!(backend.fully_restored(), "{name} {call}");
        }
    }

    #[test]
    fn wal_persist_failure_prevents_the_following_mutation() {
        let (result, backend) = run(FakeBackend::healthy().fail("persist", 2));
        assert!(matches!(result, Err(MigrationEngineError::Interrupted(_))));
        assert!(backend.claims.is_empty());
        assert!(backend.fully_restored());
    }

    #[test]
    fn persist_failure_after_a_mutation_keeps_the_transaction_resumable() {
        let intent = intent_with_id(INTENT_ID);
        let continuation = continuation(&intent, GRANT);

        for persist_call in [3, 5, 7, 14] {
            let mut engine =
                MigrationEngine::new(FakeBackend::healthy().fail("persist", persist_call));
            assert!(matches!(
                engine.execute(&intent, &continuation, GRANT),
                Err(MigrationEngineError::Interrupted(_))
            ));

            let mut resumed = MigrationEngine::new(engine.into_backend());
            assert!(matches!(
                resumed.execute(&intent, &continuation, GRANT),
                Ok(MigrationOutcome::Completed { .. })
            ));
        }
    }

    #[test]
    fn crash_after_source_detach_resumes_idempotently() {
        let intent = intent_with_id(INTENT_ID);
        let continuation = continuation(&intent, GRANT);
        let mut engine = MigrationEngine::new(FakeBackend::healthy().interrupt("detach_root", 1));
        assert!(matches!(
            engine.execute(&intent, &continuation, GRANT),
            Err(MigrationEngineError::Interrupted(_))
        ));
        let mut backend = engine.into_backend();
        assert!(!backend.source_attached);
        backend.interrupt_after = None;

        let mut resumed = MigrationEngine::new(backend);
        assert!(matches!(
            resumed.execute(&intent, &continuation, GRANT),
            Ok(MigrationOutcome::Completed { .. })
        ));
        assert!(resumed.into_backend().target_installed);
    }

    #[test]
    fn expiry_blocks_fresh_start_but_not_bound_crash_recovery() {
        let intent = intent_with_id(INTENT_ID);
        let continuation = continuation(&intent, GRANT);
        let mut interrupted =
            MigrationEngine::new(FakeBackend::healthy().interrupt("detach_root", 1));
        assert!(matches!(
            interrupted.execute(&intent, &continuation, GRANT),
            Err(MigrationEngineError::Interrupted(_))
        ));
        let mut backend = interrupted.into_backend();
        backend.interrupt_after = None;
        backend.now = intent.expires_at_unix_ms + 1;
        let mut resumed = MigrationEngine::new(backend);
        assert!(matches!(
            resumed.execute(&intent, &continuation, GRANT),
            Ok(MigrationOutcome::Completed { .. })
        ));

        let mut fresh_backend = FakeBackend::healthy();
        fresh_backend.now = intent.expires_at_unix_ms + 1;
        let mut fresh = MigrationEngine::new(fresh_backend);
        assert!(matches!(
            fresh.execute(&intent, &continuation, GRANT),
            Err(MigrationEngineError::Contract(_))
        ));
        assert!(fresh.into_backend().manifests.is_empty());
    }

    #[test]
    fn crash_after_target_install_resumes_without_duplicate_effect() {
        let intent = intent_with_id(INTENT_ID);
        let continuation = continuation(&intent, GRANT);
        let mut engine =
            MigrationEngine::new(FakeBackend::healthy().interrupt("install_target", 1));
        assert!(matches!(
            engine.execute(&intent, &continuation, GRANT),
            Err(MigrationEngineError::Interrupted(_))
        ));
        let mut backend = engine.into_backend();
        assert!(backend.target_installed);
        backend.interrupt_after = None;

        let mut resumed = MigrationEngine::new(backend);
        assert!(matches!(
            resumed.execute(&intent, &continuation, GRANT),
            Ok(MigrationOutcome::Completed { .. })
        ));
        assert_eq!(resumed.into_backend().calls["install_target"], 2);
    }

    #[test]
    fn crash_during_rollback_resumes_reverse_compensation() {
        let intent = intent_with_id(INTENT_ID);
        let continuation = continuation(&intent, GRANT);
        let mut backend = FakeBackend::healthy().interrupt("rollback_target", 1);
        backend.post_invalid = true;
        let mut engine = MigrationEngine::new(backend);
        assert!(matches!(
            engine.execute(&intent, &continuation, GRANT),
            Err(MigrationEngineError::Interrupted(_))
        ));
        let mut backend = engine.into_backend();
        assert!(!backend.target_installed);
        backend.interrupt_after = None;

        let mut resumed = MigrationEngine::new(backend);
        assert!(matches!(
            resumed.execute(&intent, &continuation, GRANT),
            Ok(MigrationOutcome::RolledBack { .. })
        ));
        assert!(resumed.into_backend().fully_restored());
    }

    #[test]
    fn continuation_grant_is_durably_one_time() {
        let first_intent = intent_with_id(INTENT_ID);
        let first_continuation = continuation(&first_intent, GRANT);
        let mut first = MigrationEngine::new(FakeBackend::healthy().interrupt("claim_grant", 1));
        assert!(matches!(
            first.execute(&first_intent, &first_continuation, GRANT),
            Err(MigrationEngineError::Interrupted(_))
        ));
        let mut backend = first.into_backend();
        backend.interrupt_after = None;

        let second_id = "66666666-6666-4666-8666-666666666666";
        let second_intent = intent_with_id(second_id);
        let second_continuation = continuation(&second_intent, GRANT);
        let mut second = MigrationEngine::new(backend);
        assert!(matches!(
            second.execute(&second_intent, &second_continuation, GRANT),
            Err(MigrationEngineError::FailedAndRolledBack(_))
        ));
        assert_eq!(second.into_backend().claims.len(), 1);

        let mut backend = FakeBackend::healthy();
        let mut first = MigrationEngine::new(backend.clone());
        assert!(matches!(
            first.execute(&first_intent, &first_continuation, GRANT),
            Ok(MigrationOutcome::Completed { .. })
        ));
        backend = first.into_backend();
        backend.manifests.clear();
        backend.source = FakeBackend::healthy().source;
        backend.source_attached = true;
        backend.metadata_present.fill(true);
        backend.target_installed = false;
        let detach_calls = *backend.calls.get("detach_root").unwrap_or(&0);
        let mut replay = MigrationEngine::new(backend);
        assert!(matches!(
            replay.execute(&first_intent, &first_continuation, GRANT),
            Err(MigrationEngineError::FailedAndRolledBack(_))
        ));
        assert_eq!(
            *replay.into_backend().calls.get("detach_root").unwrap_or(&0),
            detach_calls
        );
    }

    #[test]
    fn tampered_grant_and_manifest_fail_before_new_mutation() {
        let intent = intent_with_id(INTENT_ID);
        let continuation = continuation(&intent, GRANT);
        let mut engine = MigrationEngine::new(FakeBackend::healthy());
        assert!(matches!(
            engine.execute(&intent, &continuation, OTHER_GRANT),
            Err(MigrationEngineError::Contract(_))
        ));
        assert!(engine.into_backend().manifests.is_empty());

        let mut engine = MigrationEngine::new(FakeBackend::healthy().interrupt("detach_root", 1));
        assert!(matches!(
            engine.execute(&intent, &continuation, GRANT),
            Err(MigrationEngineError::Interrupted(_))
        ));
        let mut backend = engine.into_backend();
        backend.interrupt_after = None;
        backend
            .manifests
            .get_mut(INTENT_ID)
            .unwrap()
            .source
            .root
            .backup_path = r"C:\Other\escaped".into();
        let calls = backend.calls.clone();
        let mut resumed = MigrationEngine::new(backend);
        assert!(matches!(
            resumed.execute(&intent, &continuation, GRANT),
            Err(MigrationEngineError::Backend(_))
        ));
        assert_eq!(resumed.into_backend().calls, calls);
    }

    #[test]
    fn tampered_manifest_cannot_skip_metadata_progress() {
        let intent = intent_with_id(INTENT_ID);
        let continuation = continuation(&intent, GRANT);
        let mut engine = MigrationEngine::new(FakeBackend::healthy().interrupt("detach_root", 1));
        assert!(matches!(
            engine.execute(&intent, &continuation, GRANT),
            Err(MigrationEngineError::Interrupted(_))
        ));
        let mut backend = engine.into_backend();
        backend.interrupt_after = None;
        let manifest = backend.manifests.get_mut(INTENT_ID).unwrap();
        manifest.source_detached = true;
        manifest.phase = MigrationPhase::MetadataRemovalPending;
        manifest.pending_metadata_index = Some(2);
        let calls = backend.calls.clone();

        let mut resumed = MigrationEngine::new(backend);
        assert!(matches!(
            resumed.execute(&intent, &continuation, GRANT),
            Err(MigrationEngineError::InvalidManifest(_))
        ));
        assert_eq!(resumed.into_backend().calls, calls);
    }

    #[test]
    fn internally_consistent_forged_progress_must_match_live_recovery_state() {
        let intent = intent_with_id(INTENT_ID);
        let continuation = continuation(&intent, GRANT);
        let mut engine = MigrationEngine::new(FakeBackend::healthy().interrupt("persist", 1));
        assert!(matches!(
            engine.execute(&intent, &continuation, GRANT),
            Err(MigrationEngineError::Interrupted(_))
        ));
        let mut backend = engine.into_backend();
        backend.interrupt_after = None;
        let manifest = backend.manifests.get_mut(INTENT_ID).unwrap();
        manifest.grant_consumed = true;
        manifest.source_detached = true;
        manifest.removed_metadata_count = manifest.source.metadata.len();
        manifest.phase = MigrationPhase::MetadataRemoved;
        manifest.validate().unwrap();
        let mut rollback_tamper = manifest.clone();
        rollback_tamper.target_rollback_completed = true;
        assert!(matches!(
            rollback_tamper.validate(),
            Err(MigrationEngineError::InvalidManifest(_))
        ));
        let calls = backend.calls.clone();

        let mut resumed = MigrationEngine::new(backend);
        assert!(matches!(
            resumed.execute(&intent, &continuation, GRANT),
            Err(MigrationEngineError::Backend(_))
        ));
        assert_eq!(resumed.into_backend().calls, calls);
    }

    #[test]
    fn persisted_error_text_is_bounded_on_utf8_boundary() {
        let message = "界".repeat(MAX_ERROR_MESSAGE_BYTES);
        let bounded = bounded_manifest_error(message);
        assert!(bounded.len() <= MAX_ERROR_MESSAGE_BYTES);
        assert!(std::str::from_utf8(bounded.as_bytes()).is_ok());
    }

    #[test]
    fn source_metadata_total_size_is_bounded() {
        let mut source = FakeBackend::healthy().source;
        source.metadata = (0..5)
            .map(|index| {
                let snapshot = vec![index as u8; MAX_METADATA_SNAPSHOT_BYTES];
                ExactSourceMetadata {
                    kind: SourceMetadataKind::NsisUninstallRegistration,
                    locator: format!("hkcu-{index}"),
                    snapshot_sha256: digest_bytes(&snapshot),
                    snapshot,
                }
            })
            .collect();
        assert!(matches!(
            validate_source_snapshot(&source),
            Err(MigrationEngineError::InvalidManifest(_))
        ));
    }

    #[test]
    fn terminal_manifests_reverify_live_system_postconditions() {
        let intent = intent_with_id(INTENT_ID);
        let continuation = continuation(&intent, GRANT);
        let mut completed = MigrationEngine::new(FakeBackend::healthy());
        assert!(matches!(
            completed.execute(&intent, &continuation, GRANT),
            Ok(MigrationOutcome::Completed { .. })
        ));
        let mut backend = completed.into_backend();
        let next_observation = backend
            .calls
            .get("observe_post_install")
            .copied()
            .unwrap_or_default()
            + 1;
        let mut observation_error = MigrationEngine::new(
            backend
                .clone()
                .fail("observe_post_install", next_observation),
        );
        let observation_result = observation_error.execute(&intent, &continuation, GRANT);
        assert!(
            matches!(observation_result, Err(MigrationEngineError::Backend(_))),
            "unexpected observation result: {observation_result:?}"
        );
        let observation_error_backend = observation_error.into_backend();
        assert!(!observation_error_backend.source_attached);
        assert!(observation_error_backend
            .metadata_present
            .iter()
            .all(|present| !present));
        assert!(observation_error_backend.target_installed);
        assert_eq!(observation_error_backend.calls.get("rollback_target"), None);
        assert_eq!(
            observation_error_backend.calls.get("restore_metadata"),
            None
        );
        assert_eq!(observation_error_backend.calls.get("restore_root"), None);

        backend.target_installed = false;
        let mut resumed = MigrationEngine::new(backend);
        assert!(matches!(
            resumed.execute(&intent, &continuation, GRANT),
            Err(MigrationEngineError::Blocked(_))
        ));
        let backend = resumed.into_backend();
        assert!(!backend.source_attached);
        assert!(backend.metadata_present.iter().all(|present| !present));
        assert!(!backend.target_installed);
        assert_eq!(backend.calls.get("rollback_target"), None);
        assert_eq!(backend.calls.get("restore_metadata"), None);
        assert_eq!(backend.calls.get("restore_root"), None);
        let manifest = backend.manifests.get(INTENT_ID).unwrap();
        assert_eq!(manifest.phase, MigrationPhase::Completed);
        assert!(!manifest.target_rollback_completed);
        assert_eq!(manifest.restored_metadata_count, 0);
        assert!(!manifest.source_root_restored);

        let mut failing_backend = FakeBackend::healthy();
        failing_backend.post_invalid = true;
        let mut rolled_back = MigrationEngine::new(failing_backend);
        assert!(matches!(
            rolled_back.execute(&intent, &continuation, GRANT),
            Err(MigrationEngineError::FailedAndRolledBack(_))
        ));
        let mut backend = rolled_back.into_backend();
        backend.source_attached = false;
        let mut resumed = MigrationEngine::new(backend);
        assert!(matches!(
            resumed.execute(&intent, &continuation, GRANT),
            Err(MigrationEngineError::RollbackFailed { .. })
        ));
    }

    #[test]
    fn postcondition_and_non_success_exit_roll_back() {
        let mut invalid_post = FakeBackend::healthy();
        invalid_post.post_invalid = true;
        let (result, backend) = run(invalid_post);
        assert!(matches!(
            result,
            Err(MigrationEngineError::FailedAndRolledBack(_))
        ));
        assert!(backend.fully_restored());

        let mut failed_installer = FakeBackend::healthy();
        failed_installer.install_exit_code = 1603;
        let (result, backend) = run(failed_installer);
        assert!(matches!(
            result,
            Err(MigrationEngineError::FailedAndRolledBack(_))
        ));
        assert!(backend.fully_restored());
    }

    #[test]
    fn rollback_failures_remain_visible_and_resumable() {
        for name in ["rollback_target", "restore_metadata", "restore_root"] {
            let mut backend = FakeBackend::healthy().fail(name, 1);
            backend.post_invalid = true;
            let (result, backend) = run(backend);
            assert!(
                matches!(result, Err(MigrationEngineError::RollbackFailed { .. })),
                "{name}: {result:?}"
            );
            assert_eq!(
                backend.manifests[INTENT_ID].phase,
                MigrationPhase::RollbackFailed
            );
        }
    }

    #[test]
    fn unknown_and_mixed_source_ownership_fail_closed() {
        for ownership in [ObservedOwnership::Unknown, ObservedOwnership::Mixed] {
            let mut backend = FakeBackend::healthy();
            backend.source.ownership = ownership;
            let (result, backend) = run(backend);
            assert!(matches!(result, Err(MigrationEngineError::Blocked(_))));
            assert!(backend.manifests.is_empty());
            assert!(backend.fully_restored());
        }
    }
}
