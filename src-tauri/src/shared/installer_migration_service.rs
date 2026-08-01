use super::installer_migration_core::{
    InstallerFamily, InstallerScope, InstallerUiMode, MigrationContinuation, MigrationIntent,
    MigrationTarget, INSTALLER_MIGRATION_SCHEMA_VERSION, MAX_MIGRATION_LIFETIME_MS,
};
#[cfg(target_os = "windows")]
use super::installer_migration_engine::{
    MigrationEngineError, MigrationOutcome, TargetInstallerSnapshot,
};
#[cfg(target_os = "windows")]
use super::installer_migration_windows::NsisSourcePreflightSnapshot;
use serde::{Deserialize, Serialize};
#[cfg(target_os = "windows")]
use sha2::{Digest, Sha256};
use std::path::Path;
#[cfg(target_os = "windows")]
use std::{fs, io::Write};

// A build feature alone must never bypass the isolated installer validation gate.
const INSTALLER_MIGRATION_RUNTIME_VALIDATED: bool = false;
const EXPERIMENTAL_PREPARATION_LIFETIME_MS: u64 = 10 * 60 * 1_000;
#[cfg(target_os = "windows")]
const TRUSTED_AUTHORIZATION_SCHEMA_VERSION: u32 = 1;
#[cfg(target_os = "windows")]
const MAX_TRUSTED_AUTHORIZATION_BYTES: u64 = 64 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct InstallerMigrationPreparationInput {
    pub(crate) version: String,
    pub(crate) artifact_path: String,
    pub(crate) artifact_size: u64,
    pub(crate) artifact_sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct InstallerMigrationInitiator {
    pub(crate) process_id: u32,
    pub(crate) user_sid: String,
    pub(crate) session_id: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct InstallerMigrationExecutionRequest {
    pub(crate) intent: MigrationIntent,
    pub(crate) continuation: MigrationContinuation,
    pub(crate) expected_one_time_grant: String,
}

#[cfg(target_os = "windows")]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TrustedInstallerMigrationAuthorization {
    schema_version: u32,
    request: InstallerMigrationExecutionRequest,
}

#[cfg(target_os = "windows")]
#[derive(Debug, Clone, PartialEq, Eq)]
struct TrustedInstallerMigrationRecoveryBinding {
    intent_id: String,
    intent_digest: String,
    grant_digest: String,
    target_family: InstallerFamily,
    artifact_path: String,
    artifact_size: u64,
    artifact_sha256: String,
    version: String,
}

#[cfg(target_os = "windows")]
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct InstallerMigrationPreflight {
    pub(crate) request: InstallerMigrationExecutionRequest,
    pub(crate) source: NsisSourcePreflightSnapshot,
    pub(crate) target: TargetInstallerSnapshot,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct InstallerMigrationPreparationResult {
    pub(crate) target_version: String,
    pub(crate) expires_at_unix_ms: u64,
    pub(crate) source_metadata_items: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct InstallerMigrationRecoveryStatus {
    pub(crate) recovery_required: bool,
    pub(crate) target_version: Option<String>,
}

#[derive(Debug, Default)]
pub(crate) struct InstallerMigrationAuthorizationState {
    pending: Option<InstallerMigrationExecutionRequest>,
    recovery: Option<InstallerMigrationExecutionRequest>,
}

impl InstallerMigrationAuthorizationState {
    #[cfg(target_os = "windows")]
    pub(crate) fn authorize(
        &mut self,
        preflight: InstallerMigrationPreflight,
    ) -> InstallerMigrationPreparationResult {
        let result = InstallerMigrationPreparationResult {
            target_version: preflight.request.intent.target.version.clone(),
            expires_at_unix_ms: preflight.request.intent.expires_at_unix_ms,
            source_metadata_items: preflight.source.metadata.len(),
        };
        self.pending = Some(preflight.request);
        self.recovery = None;
        result
    }

    pub(crate) fn take_for_execution(&mut self) -> Option<InstallerMigrationExecutionRequest> {
        if let Some(request) = self.pending.take() {
            self.recovery = Some(request.clone());
            return Some(request);
        }
        self.recovery.clone()
    }

    pub(crate) fn finish(&mut self, result: &InstallerMigrationExecutionResult) {
        if !matches!(
            result.status,
            InstallerMigrationExecutionStatus::Interrupted
                | InstallerMigrationExecutionStatus::RollbackFailed
        ) {
            self.recovery = None;
        }
    }
}

#[cfg(target_os = "windows")]
pub(crate) fn prepare_experimental_installer_migration(
    input: InstallerMigrationPreparationInput,
) -> Result<InstallerMigrationPreflight, String> {
    use super::installer_migration_windows::{
        capture_native_installer_migration_identity, current_native_installer_migration_time,
        preflight_installer_migration,
    };

    let native = capture_native_installer_migration_identity()
        .map_err(|error| format!("installer migration initiator rejected: {}", error.message))?;
    let now_unix_ms = current_native_installer_migration_time()
        .map_err(|error| format!("installer migration clock rejected: {}", error.message))?;
    let request = build_experimental_installer_migration_request(
        input,
        InstallerMigrationInitiator {
            process_id: native.process_id,
            user_sid: native.user_sid,
            session_id: native.session_id,
        },
        now_unix_ms,
    )?;
    let (source, target) = preflight_installer_migration(&request.intent)
        .map_err(|error| format!("installer migration preflight rejected: {}", error.message))?;
    Ok(InstallerMigrationPreflight {
        request,
        source,
        target,
    })
}

pub(crate) fn build_experimental_installer_migration_request(
    input: InstallerMigrationPreparationInput,
    initiator: InstallerMigrationInitiator,
    now_unix_ms: u64,
) -> Result<InstallerMigrationExecutionRequest, String> {
    let expires_at_unix_ms = now_unix_ms
        .checked_add(EXPERIMENTAL_PREPARATION_LIFETIME_MS)
        .ok_or_else(|| "installer migration preparation timestamp overflowed".to_string())?;
    debug_assert!(EXPERIMENTAL_PREPARATION_LIFETIME_MS <= MAX_MIGRATION_LIFETIME_MS);

    let intent_id = uuid::Uuid::new_v4().hyphenated().to_string();
    let intent = MigrationIntent {
        schema_version: INSTALLER_MIGRATION_SCHEMA_VERSION,
        intent_id: intent_id.clone(),
        nonce: uuid::Uuid::new_v4().hyphenated().to_string(),
        created_at_unix_ms: now_unix_ms,
        expires_at_unix_ms,
        adapter_family: InstallerFamily::Msi,
        target: MigrationTarget {
            family: InstallerFamily::Msi,
            version: input.version,
            artifact_path: input.artifact_path,
            artifact_size: input.artifact_size,
            artifact_sha256: input.artifact_sha256,
        },
        scope: InstallerScope::PerMachine,
        ui_mode: InstallerUiMode::Interactive,
        parent_pid: initiator.process_id,
        original_user_sid: initiator.user_sid,
        original_session_id: initiator.session_id,
    };
    intent
        .validate(now_unix_ms)
        .map_err(|error| format!("invalid installer migration preparation: {error:?}"))?;

    let expected_one_time_grant = uuid::Uuid::new_v4().hyphenated().to_string();
    let continuation = MigrationContinuation {
        schema_version: INSTALLER_MIGRATION_SCHEMA_VERSION,
        continuation_id: uuid::Uuid::new_v4().hyphenated().to_string(),
        intent_id,
        intent_digest: intent
            .digest()
            .map_err(|error| format!("failed to bind installer migration intent: {error:?}"))?,
        target_family: InstallerFamily::Msi,
        target_artifact_sha256: intent.target.artifact_sha256.clone(),
        one_time_grant: expected_one_time_grant.clone(),
        created_at_unix_ms: now_unix_ms,
        expires_at_unix_ms,
    };
    continuation
        .validate_for_intent(&intent, &expected_one_time_grant, now_unix_ms)
        .map_err(|error| format!("invalid installer migration continuation: {error:?}"))?;

    Ok(InstallerMigrationExecutionRequest {
        intent,
        continuation,
        expected_one_time_grant,
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum InstallerMigrationExecutionStatus {
    Completed,
    RolledBack,
    Blocked,
    Interrupted,
    Invalid,
    Failed,
    RollbackFailed,
    Unsupported,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum InstallerMigrationDiagnosticCode {
    Completed,
    RolledBack,
    ContractRejected,
    ManifestRejected,
    OwnershipBlocked,
    BackendFailure,
    Interrupted,
    MigrationFailed,
    RollbackFailed,
    RuntimeDisabled,
    UnsupportedPlatform,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct InstallerMigrationExecutionResult {
    pub(crate) status: InstallerMigrationExecutionStatus,
    pub(crate) diagnostic_code: InstallerMigrationDiagnosticCode,
    pub(crate) transaction_id: Option<String>,
    pub(crate) reboot_required: bool,
    pub(crate) message: Option<String>,
}

impl InstallerMigrationExecutionResult {
    #[cfg(target_os = "windows")]
    fn engine_result(result: Result<MigrationOutcome, MigrationEngineError>) -> Self {
        match result {
            Ok(MigrationOutcome::Completed {
                transaction_id,
                reboot_required,
            }) => Self {
                status: InstallerMigrationExecutionStatus::Completed,
                diagnostic_code: InstallerMigrationDiagnosticCode::Completed,
                transaction_id: Some(transaction_id),
                reboot_required,
                message: None,
            },
            Ok(MigrationOutcome::RolledBack { transaction_id }) => Self {
                status: InstallerMigrationExecutionStatus::RolledBack,
                diagnostic_code: InstallerMigrationDiagnosticCode::RolledBack,
                transaction_id: Some(transaction_id),
                reboot_required: false,
                message: None,
            },
            Err(error) => {
                let (status, diagnostic_code) = match error {
                    MigrationEngineError::Contract(_) => (
                        InstallerMigrationExecutionStatus::Invalid,
                        InstallerMigrationDiagnosticCode::ContractRejected,
                    ),
                    MigrationEngineError::InvalidManifest(_) => (
                        InstallerMigrationExecutionStatus::Invalid,
                        InstallerMigrationDiagnosticCode::ManifestRejected,
                    ),
                    MigrationEngineError::Blocked(_) => (
                        InstallerMigrationExecutionStatus::Blocked,
                        InstallerMigrationDiagnosticCode::OwnershipBlocked,
                    ),
                    MigrationEngineError::Interrupted(_) => (
                        InstallerMigrationExecutionStatus::Interrupted,
                        InstallerMigrationDiagnosticCode::Interrupted,
                    ),
                    MigrationEngineError::Backend(_) => (
                        InstallerMigrationExecutionStatus::Failed,
                        InstallerMigrationDiagnosticCode::BackendFailure,
                    ),
                    MigrationEngineError::FailedAndRolledBack(_) => (
                        InstallerMigrationExecutionStatus::Failed,
                        InstallerMigrationDiagnosticCode::MigrationFailed,
                    ),
                    MigrationEngineError::RollbackFailed { .. } => (
                        InstallerMigrationExecutionStatus::RollbackFailed,
                        InstallerMigrationDiagnosticCode::RollbackFailed,
                    ),
                };
                Self {
                    status,
                    diagnostic_code,
                    transaction_id: None,
                    reboot_required: false,
                    message: Some(public_diagnostic_message(diagnostic_code).into()),
                }
            }
        }
    }

    pub(crate) fn unsupported(message: impl Into<String>) -> Self {
        Self {
            status: InstallerMigrationExecutionStatus::Unsupported,
            diagnostic_code: InstallerMigrationDiagnosticCode::UnsupportedPlatform,
            transaction_id: None,
            reboot_required: false,
            message: Some(message.into()),
        }
    }
}

fn public_diagnostic_message(code: InstallerMigrationDiagnosticCode) -> &'static str {
    match code {
        InstallerMigrationDiagnosticCode::Completed => "Installer migration completed.",
        InstallerMigrationDiagnosticCode::RolledBack => {
            "Installer migration rolled back to the previous state."
        }
        InstallerMigrationDiagnosticCode::ContractRejected => {
            "Installer migration authorization was rejected."
        }
        InstallerMigrationDiagnosticCode::ManifestRejected => {
            "Installer migration recovery state was rejected."
        }
        InstallerMigrationDiagnosticCode::OwnershipBlocked => {
            "Installer ownership is not eligible for safe migration."
        }
        InstallerMigrationDiagnosticCode::BackendFailure => {
            "Installer migration failed during system validation."
        }
        InstallerMigrationDiagnosticCode::Interrupted => {
            "Installer migration was interrupted and requires recovery."
        }
        InstallerMigrationDiagnosticCode::MigrationFailed => {
            "Installer migration failed and the previous state was restored."
        }
        InstallerMigrationDiagnosticCode::RollbackFailed => {
            "Installer migration rollback requires manual recovery."
        }
        InstallerMigrationDiagnosticCode::RuntimeDisabled => {
            "Installer migration is disabled until isolated Windows validation passes."
        }
        InstallerMigrationDiagnosticCode::UnsupportedPlatform => {
            "Installer migration is unavailable on this platform."
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct InstallerMigrationCapability {
    pub(crate) platform_supported: bool,
    pub(crate) runtime_enabled: bool,
    pub(crate) remote_execution_allowed: bool,
    pub(crate) reason: Option<String>,
}

pub(crate) fn installer_migration_capability() -> InstallerMigrationCapability {
    let platform_supported = cfg!(target_os = "windows");
    let runtime_enabled = platform_supported
        && cfg!(feature = "installer-migration-runtime")
        && INSTALLER_MIGRATION_RUNTIME_VALIDATED;
    InstallerMigrationCapability {
        platform_supported,
        runtime_enabled,
        remote_execution_allowed: false,
        reason: (!runtime_enabled).then(|| {
            if platform_supported {
                "Installer migration remains disabled until the isolated Windows validation matrix passes."
            } else {
                "Windows installer migration is unavailable on this platform."
            }
            .into()
        }),
    }
}

#[cfg(target_os = "windows")]
pub(crate) fn execute_installer_migration(
    data_dir: &Path,
    request: InstallerMigrationExecutionRequest,
) -> InstallerMigrationExecutionResult {
    use super::installer_migration_engine::MigrationEngine;
    use super::installer_migration_windows::WindowsMigrationBackend;

    if !installer_migration_capability().runtime_enabled {
        return InstallerMigrationExecutionResult {
            status: InstallerMigrationExecutionStatus::Blocked,
            diagnostic_code: InstallerMigrationDiagnosticCode::RuntimeDisabled,
            transaction_id: None,
            reboot_required: false,
            message: installer_migration_capability().reason,
        };
    }
    let store_root = data_dir.join("installer-migration");
    if persist_trusted_authorization(&store_root, &request).is_err() {
        return InstallerMigrationExecutionResult {
            status: InstallerMigrationExecutionStatus::Invalid,
            diagnostic_code: InstallerMigrationDiagnosticCode::ContractRejected,
            transaction_id: None,
            reboot_required: false,
            message: Some(
                public_diagnostic_message(InstallerMigrationDiagnosticCode::ContractRejected)
                    .into(),
            ),
        };
    }
    let backend = match WindowsMigrationBackend::native(store_root) {
        Ok(backend) => backend,
        Err(_) => {
            let _ = clear_trusted_authorization(data_dir);
            return InstallerMigrationExecutionResult {
                status: InstallerMigrationExecutionStatus::Failed,
                diagnostic_code: InstallerMigrationDiagnosticCode::BackendFailure,
                transaction_id: None,
                reboot_required: false,
                message: Some(
                    public_diagnostic_message(InstallerMigrationDiagnosticCode::BackendFailure)
                        .into(),
                ),
            };
        }
    };
    let mut engine = MigrationEngine::new(backend);
    let result = InstallerMigrationExecutionResult::engine_result(engine.execute(
        &request.intent,
        &request.continuation,
        &request.expected_one_time_grant,
    ));
    if !matches!(
        result.status,
        InstallerMigrationExecutionStatus::Interrupted
            | InstallerMigrationExecutionStatus::RollbackFailed
    ) {
        let _ = clear_trusted_authorization(data_dir);
    }
    result
}

#[cfg(target_os = "windows")]
pub(crate) fn load_trusted_installer_migration_recovery(
    data_dir: &Path,
) -> Result<Option<InstallerMigrationExecutionRequest>, String> {
    use super::installer_migration_store::MigrationStore;

    let store_root = data_dir.join("installer-migration");
    let path = trusted_authorization_path(&store_root);
    let Some(record) = read_trusted_authorization(&path)? else {
        return Ok(None);
    };
    let store = MigrationStore::new(store_root)
        .map_err(|_| "Trusted installer migration recovery state was rejected.".to_string())?;
    let manifest = store
        .load_manifest(&record.request.intent.intent_id)
        .map_err(|_| "Trusted installer migration recovery state was rejected.".to_string())?
        .ok_or_else(|| "Trusted installer migration recovery manifest is missing.".to_string())?;
    let intent_digest = record
        .request
        .intent
        .digest()
        .map_err(|_| "Trusted installer migration recovery intent was rejected.".to_string())?;
    let grant_digest = digest_public_bytes(record.request.continuation.one_time_grant.as_bytes());
    let binding = TrustedInstallerMigrationRecoveryBinding {
        intent_id: manifest.intent_id,
        intent_digest: manifest.intent_digest,
        grant_digest: manifest.grant_digest,
        target_family: manifest.target.family,
        artifact_path: manifest.target.artifact_path,
        artifact_size: manifest.target.artifact_size,
        artifact_sha256: manifest.target.artifact_sha256,
        version: manifest.target.version,
    };
    if !trusted_recovery_binding_matches(&binding, &record.request, &intent_digest, &grant_digest) {
        return Err("Trusted installer migration recovery binding was rejected.".into());
    }
    Ok(Some(record.request))
}

pub(crate) fn installer_migration_recovery_status(
    data_dir: &Path,
) -> Result<InstallerMigrationRecoveryStatus, String> {
    let request = load_trusted_installer_migration_recovery(data_dir)?;
    Ok(InstallerMigrationRecoveryStatus {
        recovery_required: request.is_some(),
        target_version: request.map(|value| value.intent.target.version),
    })
}

#[cfg(target_os = "windows")]
fn trusted_recovery_binding_matches(
    binding: &TrustedInstallerMigrationRecoveryBinding,
    request: &InstallerMigrationExecutionRequest,
    intent_digest: &str,
    grant_digest: &str,
) -> bool {
    let target = &request.intent.target;
    binding.intent_id == request.intent.intent_id
        && binding.intent_digest == intent_digest
        && binding.grant_digest == grant_digest
        && binding.target_family == target.family
        && binding.artifact_path == target.artifact_path
        && binding.artifact_size == target.artifact_size
        && binding.artifact_sha256 == target.artifact_sha256
        && binding.version == target.version
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn load_trusted_installer_migration_recovery(
    _data_dir: &Path,
) -> Result<Option<InstallerMigrationExecutionRequest>, String> {
    Ok(None)
}

#[cfg(target_os = "windows")]
fn trusted_authorization_path(store_root: &Path) -> std::path::PathBuf {
    store_root.join("trusted-authorization.json")
}

#[cfg(target_os = "windows")]
fn persist_trusted_authorization(
    store_root: &Path,
    request: &InstallerMigrationExecutionRequest,
) -> Result<(), String> {
    super::installer_migration_store::MigrationStore::new(store_root.to_path_buf()).map_err(
        |_| "Failed to initialize trusted installer migration authorization.".to_string(),
    )?;
    let path = trusted_authorization_path(store_root);
    if let Some(existing) = read_trusted_authorization(&path)? {
        return if existing.request == *request {
            Ok(())
        } else {
            Err("Another trusted installer migration authorization is active.".into())
        };
    }
    let record = TrustedInstallerMigrationAuthorization {
        schema_version: TRUSTED_AUTHORIZATION_SCHEMA_VERSION,
        request: request.clone(),
    };
    let bytes = serde_json::to_vec(&record)
        .map_err(|_| "Failed to encode trusted installer migration authorization.".to_string())?;
    if bytes.len() as u64 > MAX_TRUSTED_AUTHORIZATION_BYTES {
        return Err("Trusted installer migration authorization is too large.".into());
    }
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(|_| "Failed to persist trusted installer migration authorization.".to_string())?;
    file.write_all(&bytes)
        .and_then(|_| file.sync_all())
        .map_err(|_| "Failed to persist trusted installer migration authorization.".to_string())
}

#[cfg(target_os = "windows")]
fn read_trusted_authorization(
    path: &Path,
) -> Result<Option<TrustedInstallerMigrationAuthorization>, String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("Trusted installer migration authorization is unreadable.".into()),
    };
    if !metadata.file_type().is_file()
        || metadata.file_type().is_symlink()
        || metadata.len() == 0
        || metadata.len() > MAX_TRUSTED_AUTHORIZATION_BYTES
    {
        return Err("Trusted installer migration authorization was rejected.".into());
    }
    let bytes = fs::read(path)
        .map_err(|_| "Trusted installer migration authorization is unreadable.".to_string())?;
    let record: TrustedInstallerMigrationAuthorization = serde_json::from_slice(&bytes)
        .map_err(|_| "Trusted installer migration authorization was rejected.".to_string())?;
    if record.schema_version != TRUSTED_AUTHORIZATION_SCHEMA_VERSION {
        return Err("Trusted installer migration authorization schema was rejected.".into());
    }
    Ok(Some(record))
}

#[cfg(target_os = "windows")]
fn clear_trusted_authorization(data_dir: &Path) -> Result<(), String> {
    let path = trusted_authorization_path(&data_dir.join("installer-migration"));
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err("Failed to clear trusted installer migration authorization.".into()),
    }
}

#[cfg(target_os = "windows")]
fn digest_public_bytes(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn execute_installer_migration(
    _data_dir: &Path,
    _request: InstallerMigrationExecutionRequest,
) -> InstallerMigrationExecutionResult {
    InstallerMigrationExecutionResult::unsupported(
        "Windows installer migration is only available in the Windows desktop app.",
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn preparation_input() -> InstallerMigrationPreparationInput {
        InstallerMigrationPreparationInput {
            version: "1.2.3".into(),
            artifact_path: r"C:\staging\ThreadFleet.msi".into(),
            artifact_size: 10,
            artifact_sha256: "a".repeat(64),
        }
    }

    fn initiator() -> InstallerMigrationInitiator {
        InstallerMigrationInitiator {
            process_id: 42,
            user_sid: "S-1-5-21-1000".into(),
            session_id: 1,
        }
    }

    #[cfg(target_os = "windows")]
    fn execution_request() -> InstallerMigrationExecutionRequest {
        use crate::shared::installer_migration_core::{
            InstallerFamily, InstallerScope, InstallerUiMode, MigrationTarget,
        };

        InstallerMigrationExecutionRequest {
            intent: MigrationIntent {
                schema_version: 1,
                intent_id: "11111111-1111-4111-8111-111111111111".into(),
                nonce: "22222222-2222-4222-8222-222222222222".into(),
                created_at_unix_ms: 1,
                expires_at_unix_ms: 2,
                adapter_family: InstallerFamily::Msi,
                target: MigrationTarget {
                    family: InstallerFamily::Msi,
                    version: "1.0.0".into(),
                    artifact_path: r"C:\staging\ThreadFleet.msi".into(),
                    artifact_size: 10,
                    artifact_sha256: "a".repeat(64),
                },
                scope: InstallerScope::PerMachine,
                ui_mode: InstallerUiMode::Interactive,
                parent_pid: 42,
                original_user_sid: "S-1-5-21-1000".into(),
                original_session_id: 1,
            },
            continuation: MigrationContinuation {
                schema_version: 1,
                continuation_id: "33333333-3333-4333-8333-333333333333".into(),
                intent_id: "11111111-1111-4111-8111-111111111111".into(),
                intent_digest: "b".repeat(64),
                target_family: InstallerFamily::Msi,
                target_artifact_sha256: "a".repeat(64),
                one_time_grant: "44444444-4444-4444-8444-444444444444".into(),
                created_at_unix_ms: 1,
                expires_at_unix_ms: 2,
            },
            expected_one_time_grant: "44444444-4444-4444-8444-444444444444".into(),
        }
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn maps_engine_outcomes_without_exposing_backend_capabilities() {
        let completed =
            InstallerMigrationExecutionResult::engine_result(Ok(MigrationOutcome::Completed {
                transaction_id: "11111111-1111-4111-8111-111111111111".into(),
                reboot_required: true,
            }));
        assert_eq!(
            completed.status,
            InstallerMigrationExecutionStatus::Completed
        );
        assert!(completed.reboot_required);
        assert_eq!(
            completed.diagnostic_code,
            InstallerMigrationDiagnosticCode::Completed
        );

        let interrupted = InstallerMigrationExecutionResult::engine_result(Err(
            MigrationEngineError::Interrupted("resume required".into()),
        ));
        assert_eq!(
            interrupted.status,
            InstallerMigrationExecutionStatus::Interrupted
        );
        assert_eq!(
            interrupted.message.as_deref(),
            Some("Installer migration was interrupted and requires recovery.")
        );
        assert_eq!(
            interrupted.diagnostic_code,
            InstallerMigrationDiagnosticCode::Interrupted
        );
    }

    #[test]
    fn request_rejects_unknown_authority_fields() {
        let json = serde_json::json!({
            "intent": {},
            "continuation": {},
            "expectedOneTimeGrant": "grant",
            "command": "cmd.exe"
        });
        assert!(serde_json::from_value::<InstallerMigrationExecutionRequest>(json).is_err());
    }

    #[test]
    fn preparation_input_rejects_caller_supplied_authority() {
        let json = serde_json::json!({
            "version": "1.2.3",
            "artifactPath": r"C:\staging\ThreadFleet.msi",
            "artifactSize": 10,
            "artifactSha256": "a".repeat(64),
            "originalUserSid": "S-1-5-21-attacker"
        });

        assert!(serde_json::from_value::<InstallerMigrationPreparationInput>(json).is_err());
    }

    #[test]
    fn backend_generated_experimental_request_owns_all_authority_fields() {
        let now = 1_700_000_000_000;
        let request =
            build_experimental_installer_migration_request(preparation_input(), initiator(), now)
                .expect("backend-generated preparation should be valid");

        assert_eq!(request.intent.adapter_family, InstallerFamily::Msi);
        assert_eq!(request.intent.target.family, InstallerFamily::Msi);
        assert_eq!(request.intent.scope, InstallerScope::PerMachine);
        assert_eq!(request.intent.ui_mode, InstallerUiMode::Interactive);
        assert_eq!(request.intent.parent_pid, 42);
        assert_eq!(request.intent.original_user_sid, "S-1-5-21-1000");
        assert_eq!(request.intent.original_session_id, 1);
        assert_eq!(
            request.intent.expires_at_unix_ms - request.intent.created_at_unix_ms,
            EXPERIMENTAL_PREPARATION_LIFETIME_MS
        );
        assert_eq!(request.continuation.intent_id, request.intent.intent_id);
        assert_eq!(
            request.continuation.intent_digest,
            request.intent.digest().unwrap()
        );
        assert_eq!(
            request.continuation.one_time_grant,
            request.expected_one_time_grant
        );
    }

    #[test]
    fn backend_generated_request_rejects_invalid_artifact_or_initiator() {
        let mut input = preparation_input();
        input.artifact_path = r"C:\staging\ThreadFleet.exe".into();
        assert!(build_experimental_installer_migration_request(
            input,
            initiator(),
            1_700_000_000_000,
        )
        .is_err());

        let mut invalid_initiator = initiator();
        invalid_initiator.process_id = 0;
        assert!(build_experimental_installer_migration_request(
            preparation_input(),
            invalid_initiator,
            1_700_000_000_000,
        )
        .is_err());
    }

    #[test]
    fn production_runtime_gate_is_closed_by_default() {
        let capability = installer_migration_capability();
        assert_eq!(capability.platform_supported, cfg!(target_os = "windows"));
        assert!(!capability.remote_execution_allowed);
        assert!(!capability.runtime_enabled);
        assert!(capability.reason.is_some());
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn trusted_authorization_is_consumed_and_only_interrupted_work_can_resume() {
        let request = execution_request();
        let mut authorization = InstallerMigrationAuthorizationState {
            pending: Some(request.clone()),
            recovery: None,
        };

        assert_eq!(authorization.take_for_execution(), Some(request.clone()));
        assert_eq!(authorization.take_for_execution(), Some(request.clone()));

        authorization.finish(&InstallerMigrationExecutionResult {
            status: InstallerMigrationExecutionStatus::Completed,
            diagnostic_code: InstallerMigrationDiagnosticCode::Completed,
            transaction_id: None,
            reboot_required: false,
            message: None,
        });
        assert_eq!(authorization.take_for_execution(), None);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn restart_recovery_rejects_authorization_without_an_exact_manifest() {
        let data_dir = std::env::temp_dir().join(format!(
            "threadfleet-migration-authorization-{}",
            uuid::Uuid::new_v4()
        ));
        let store_root = data_dir.join("installer-migration");
        let request = execution_request();
        persist_trusted_authorization(&store_root, &request).unwrap();
        assert_eq!(
            read_trusted_authorization(&trusted_authorization_path(&store_root))
                .unwrap()
                .unwrap()
                .request,
            request
        );

        let error = load_trusted_installer_migration_recovery(&data_dir).unwrap_err();
        assert!(error.contains("manifest is missing"));

        clear_trusted_authorization(&data_dir).unwrap();
        std::fs::remove_dir_all(data_dir).unwrap();
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn restart_recovery_binding_rejects_every_authority_or_target_mismatch() {
        let request = execution_request();
        let intent_digest = request.intent.digest().unwrap();
        let grant_digest = digest_public_bytes(request.continuation.one_time_grant.as_bytes());
        let target = &request.intent.target;
        let binding = TrustedInstallerMigrationRecoveryBinding {
            intent_id: request.intent.intent_id.clone(),
            intent_digest: intent_digest.clone(),
            grant_digest: grant_digest.clone(),
            target_family: target.family,
            artifact_path: target.artifact_path.clone(),
            artifact_size: target.artifact_size,
            artifact_sha256: target.artifact_sha256.clone(),
            version: target.version.clone(),
        };
        assert!(trusted_recovery_binding_matches(
            &binding,
            &request,
            &intent_digest,
            &grant_digest,
        ));

        let mutations: [fn(&mut TrustedInstallerMigrationRecoveryBinding); 8] = [
            |value| value.intent_id = "99999999-9999-4999-8999-999999999999".into(),
            |value| value.intent_digest = "9".repeat(64),
            |value| value.grant_digest = "8".repeat(64),
            |value| value.target_family = InstallerFamily::Nsis,
            |value| value.artifact_path = r"C:\staging\other.msi".into(),
            |value| value.artifact_size += 1,
            |value| value.artifact_sha256 = "7".repeat(64),
            |value| value.version = "9.9.9".into(),
        ];
        for mutate in mutations {
            let mut changed = binding.clone();
            mutate(&mut changed);
            assert!(!trusted_recovery_binding_matches(
                &changed,
                &request,
                &intent_digest,
                &grant_digest,
            ));
        }
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn closed_validation_gate_blocks_before_creating_migration_state() {
        let data_dir = std::env::temp_dir().join(format!(
            "threadfleet-disabled-installer-migration-{}",
            uuid::Uuid::new_v4()
        ));
        assert!(!data_dir.exists());

        let result = execute_installer_migration(&data_dir, execution_request());

        assert_eq!(result.status, InstallerMigrationExecutionStatus::Blocked);
        assert_eq!(
            result.diagnostic_code,
            InstallerMigrationDiagnosticCode::RuntimeDisabled
        );
        assert!(!data_dir.exists());
    }
}
