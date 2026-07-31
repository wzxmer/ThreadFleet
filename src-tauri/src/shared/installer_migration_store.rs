use super::installer_migration_engine::MigrationManifest;
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::fmt;
use std::fs::{self, File, OpenOptions};
use std::io::{ErrorKind, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex as StdMutex, OnceLock};
use std::time::{Duration, SystemTime};

const MAX_MANIFEST_BYTES: u64 = 24 * 1024 * 1024;
const MAX_CLAIM_BYTES: u64 = 16 * 1024;
const MAX_MANIFEST_CANDIDATES: usize = 3;
const CLAIM_READ_ATTEMPTS: usize = 32;
const MAX_ATOMIC_DIRECTORY_ENTRIES: usize = 65_536;
const MAX_ORPHAN_TEMPS_PER_CREATE: usize = 64;
const ORPHAN_TEMP_STALE_AFTER: Duration = Duration::from_secs(10 * 60);
const TRANSACTION_LOCK_SCHEMA_VERSION: u32 = 1;

static ATOMIC_CREATE_MUTEX: OnceLock<StdMutex<()>> = OnceLock::new();
static MANIFEST_PUBLISH_MUTEX: OnceLock<StdMutex<()>> = OnceLock::new();

#[derive(Debug)]
pub(crate) enum MigrationStoreError {
    Invalid(String),
    Conflict(String),
    AlreadyExists(PathBuf),
    Io(String),
}

impl fmt::Display for MigrationStoreError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Invalid(message) => write!(formatter, "invalid migration store data: {message}"),
            Self::Conflict(message) => write!(formatter, "migration store conflict: {message}"),
            Self::AlreadyExists(path) => {
                write!(
                    formatter,
                    "migration store path already exists: {}",
                    path.display()
                )
            }
            Self::Io(message) => write!(formatter, "migration store I/O failure: {message}"),
        }
    }
}

impl std::error::Error for MigrationStoreError {}

type StoreResult<T> = Result<T, MigrationStoreError>;

#[derive(Debug, Clone)]
pub(crate) struct MigrationStore {
    root: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GrantClaim {
    grant_digest: String,
    intent_id: String,
    transaction_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TransactionLockRecord {
    #[serde(default)]
    pub(crate) schema_version: u32,
    pub(crate) transaction_id: String,
    pub(crate) owner_pid: u32,
    #[serde(default)]
    pub(crate) owner_process_started_at: u64,
}

#[derive(Debug)]
pub(crate) struct TransactionLockGuard {
    record: TransactionLockRecord,
    path: PathBuf,
    file: File,
}

impl TransactionLockGuard {
    pub(crate) fn record(&self) -> &TransactionLockRecord {
        &self.record
    }
}

#[derive(Debug)]
pub(crate) enum TransactionLockOutcome {
    Acquired(TransactionLockGuard),
    Existing(TransactionLockRecord),
    Busy,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ProcessIdentity {
    pid: u32,
    started_at: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ProcessOwnerState {
    MatchingAlive,
    MissingOrReused,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum CandidateKind {
    Backup,
    Temp,
    Primary,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AtomicCreateOutcome {
    Created,
    Existing,
}

#[derive(Debug, Clone)]
struct ManifestCandidate {
    kind: CandidateKind,
    manifest: MigrationManifest,
}

impl MigrationStore {
    pub(crate) fn new(root: PathBuf) -> StoreResult<Self> {
        if !root.is_absolute() {
            return Err(MigrationStoreError::Invalid(
                "store root must be absolute".into(),
            ));
        }
        validate_existing_directory_ancestors(&root)?;
        fs::create_dir_all(&root).map_err(io_error)?;
        validate_directory_ancestors(&root)?;
        let store = Self { root };
        for directory in [
            store.intents_root(),
            store.claims_root(),
            store.locks_root(),
            store.transactions_root(),
        ] {
            create_derived_directory(&directory)?;
        }
        Ok(store)
    }

    pub(crate) fn root(&self) -> &Path {
        &self.root
    }

    pub(crate) fn transaction_dir(&self, transaction_id: &str) -> StoreResult<PathBuf> {
        let path = self.transaction_path(transaction_id)?;
        create_derived_directory(&path)?;
        Ok(path)
    }

    pub(crate) fn transaction_path(&self, transaction_id: &str) -> StoreResult<PathBuf> {
        validate_uuid(transaction_id, "transaction ID")?;
        self.validate_store_root()?;
        let transactions_root = self.transactions_root();
        validate_directory(&transactions_root)?;
        Ok(transactions_root.join(transaction_id))
    }

    pub(crate) fn load_manifest(&self, intent_id: &str) -> StoreResult<Option<MigrationManifest>> {
        Ok(self
            .load_manifest_candidate(intent_id)?
            .map(|candidate| candidate.manifest))
    }

    pub(crate) fn persist_manifest(
        &self,
        manifest: &MigrationManifest,
        lock: &TransactionLockGuard,
    ) -> StoreResult<()> {
        let _guard = MANIFEST_PUBLISH_MUTEX
            .get_or_init(|| StdMutex::new(()))
            .lock()
            .map_err(|_| MigrationStoreError::Io("manifest publish mutex is poisoned".into()))?;
        validate_manifest(manifest)?;
        self.require_current_process_lock(&manifest.transaction_id, lock)?;
        let intent_dir = self.intent_dir(&manifest.intent_id, true)?;
        let mut current = self.load_manifest_candidate(&manifest.intent_id)?;

        if let Some(candidate) = current.as_ref() {
            if candidate.kind != CandidateKind::Primary {
                self.publish_manifest(
                    &intent_dir,
                    &candidate.manifest,
                    candidate.kind == CandidateKind::Temp,
                )?;
                current = Some(ManifestCandidate {
                    kind: CandidateKind::Primary,
                    manifest: candidate.manifest.clone(),
                });
            }
        }

        match current.as_ref().map(|candidate| &candidate.manifest) {
            None if manifest.journal_revision != 1 => {
                return Err(MigrationStoreError::Conflict(
                    "first manifest revision must be 1".into(),
                ));
            }
            Some(existing) if existing.transaction_id != manifest.transaction_id => {
                return Err(MigrationStoreError::Conflict(
                    "intent is already bound to another transaction".into(),
                ));
            }
            Some(existing) if existing.journal_revision == manifest.journal_revision => {
                if existing == manifest {
                    return Ok(());
                }
                return Err(MigrationStoreError::Conflict(
                    "same manifest revision has different content".into(),
                ));
            }
            Some(existing)
                if existing
                    .journal_revision
                    .checked_add(1)
                    .is_none_or(|next| next != manifest.journal_revision) =>
            {
                return Err(MigrationStoreError::Conflict(
                    "manifest revision is stale or non-contiguous".into(),
                ));
            }
            _ => {}
        }

        self.publish_manifest(&intent_dir, manifest, false)
    }

    pub(crate) fn claim_grant(
        &self,
        grant_digest: &str,
        intent_id: &str,
        transaction_id: &str,
    ) -> StoreResult<()> {
        validate_sha256(grant_digest, "grant digest")?;
        validate_uuid(intent_id, "intent ID")?;
        validate_uuid(transaction_id, "transaction ID")?;
        let claim = GrantClaim {
            grant_digest: grant_digest.into(),
            intent_id: intent_id.into(),
            transaction_id: transaction_id.into(),
        };
        self.validate_store_root()?;
        let claims_root = self.claims_root();
        validate_directory(&claims_root)?;
        let path = claims_root.join(format!("{grant_digest}.json"));
        let bytes = serialize_json_with_limit(&claim, MAX_CLAIM_BYTES, "grant claim")?;
        match atomic_create_record(&path, &bytes)? {
            AtomicCreateOutcome::Created => Ok(()),
            AtomicCreateOutcome::Existing => {
                let existing = read_json_with_retry::<GrantClaim>(&path, MAX_CLAIM_BYTES)?;
                validate_grant_claim(&existing)?;
                if existing == claim {
                    Ok(())
                } else {
                    Err(MigrationStoreError::Conflict(
                        "grant is already bound to another intent or transaction".into(),
                    ))
                }
            }
        }
    }

    pub(crate) fn acquire_transaction_lock(
        &self,
        transaction_id: &str,
    ) -> StoreResult<TransactionLockOutcome> {
        validate_uuid(transaction_id, "transaction ID")?;
        let owner = current_process_identity()?;
        let record = TransactionLockRecord {
            schema_version: TRANSACTION_LOCK_SCHEMA_VERSION,
            transaction_id: transaction_id.into(),
            owner_pid: owner.pid,
            owner_process_started_at: owner.started_at,
        };
        self.validate_store_root()?;
        let locks_root = self.locks_root();
        validate_directory(&locks_root)?;
        let path = locks_root.join(format!("{transaction_id}.lock"));
        let bytes = serialize_json_with_limit(&record, MAX_CLAIM_BYTES, "transaction lock")?;
        let _ = atomic_create_record(&path, &bytes)?;
        validate_transaction_lock_path(&path)?;

        match try_open_transaction_lock(&path)? {
            Some(mut file) => {
                validate_transaction_lock_path(&path)?;
                let backup = path.with_extension("lock.bak");
                let (existing, existing_bytes, recovered_from_backup) =
                    match read_transaction_lock_from_handle(&mut file, &path) {
                        Ok((record, bytes)) => (record, bytes, false),
                        Err(primary_error) => match read_transaction_lock_from_path(&backup) {
                            Ok((record, bytes)) => (record, bytes, true),
                            Err(_) => return Err(primary_error),
                        },
                    };
                validate_transaction_lock(&existing)?;
                if existing.transaction_id != transaction_id {
                    return Err(MigrationStoreError::Invalid(
                        "transaction lock identity does not match its file name".into(),
                    ));
                }

                if record_matches_process(&existing, owner) {
                    if recovered_from_backup {
                        write_transaction_lock_to_handle(&mut file, &existing)?;
                        remove_derived_file_if_exists(&backup)?;
                    }
                    return Ok(TransactionLockOutcome::Acquired(TransactionLockGuard {
                        record: existing,
                        path,
                        file,
                    }));
                }

                match observe_process_owner(&existing)? {
                    ProcessOwnerState::MatchingAlive | ProcessOwnerState::Unknown => {
                        if recovered_from_backup {
                            Err(MigrationStoreError::Conflict(
                                "transaction lock primary is corrupt while its recorded owner may still be alive"
                                    .into(),
                            ))
                        } else {
                            Ok(TransactionLockOutcome::Existing(existing))
                        }
                    }
                    ProcessOwnerState::MissingOrReused => {
                        remove_derived_file_if_exists(&backup)?;
                        match atomic_create_record(&backup, &existing_bytes)? {
                            AtomicCreateOutcome::Created => {}
                            AtomicCreateOutcome::Existing => {
                                return Err(MigrationStoreError::Conflict(
                                    "transaction lock backup could not be created exclusively"
                                        .into(),
                                ));
                            }
                        }
                        if let Err(error) = write_transaction_lock_to_handle(&mut file, &record) {
                            let _ = restore_transaction_lock_from_backup(&mut file, &path, &backup);
                            return Err(error);
                        }
                        remove_derived_file_if_exists(&backup)?;
                        Ok(TransactionLockOutcome::Acquired(TransactionLockGuard {
                            record,
                            path,
                            file,
                        }))
                    }
                }
            }
            None => Ok(TransactionLockOutcome::Busy),
        }
    }

    fn require_current_process_lock(
        &self,
        transaction_id: &str,
        lock: &TransactionLockGuard,
    ) -> StoreResult<()> {
        validate_uuid(transaction_id, "transaction ID")?;
        self.validate_store_root()?;
        let locks_root = self.locks_root();
        validate_directory(&locks_root)?;
        let path = locks_root.join(format!("{transaction_id}.lock"));
        let current = current_process_identity()?;
        if lock.path != path
            || lock.record.transaction_id != transaction_id
            || !record_matches_process(&lock.record, current)
        {
            return Err(MigrationStoreError::Conflict(
                "transaction lock guard is not owned by the current process".into(),
            ));
        }
        let record = read_transaction_lock_from_guard(&lock.file, &path)?;
        validate_transaction_lock(&record)?;
        if record != lock.record {
            return Err(MigrationStoreError::Conflict(
                "transaction lock record changed while its guard was held".into(),
            ));
        }
        Ok(())
    }

    fn load_manifest_candidate(&self, intent_id: &str) -> StoreResult<Option<ManifestCandidate>> {
        validate_uuid(intent_id, "intent ID")?;
        let Some(intent_dir) = self.intent_dir_if_exists(intent_id)? else {
            return Ok(None);
        };
        let mut candidates = Vec::new();
        let mut entry_count = 0usize;
        for entry in fs::read_dir(&intent_dir).map_err(io_error)? {
            let path = entry.map_err(io_error)?.path();
            entry_count += 1;
            if entry_count > MAX_MANIFEST_CANDIDATES {
                return Err(MigrationStoreError::Invalid(
                    "manifest candidate count exceeds the bounded journal topology".into(),
                ));
            }
            let (transaction_id, kind) = manifest_file_identity(&path)?;
            let bytes = read_regular_file(&path, MAX_MANIFEST_BYTES)?;
            let manifest = match serde_json::from_slice::<MigrationManifest>(&bytes) {
                Ok(manifest) => manifest,
                Err(_) => continue,
            };
            validate_manifest(&manifest)?;
            if manifest.intent_id != intent_id || manifest.transaction_id != transaction_id {
                return Err(MigrationStoreError::Invalid(
                    "manifest identity does not match its derived path".into(),
                ));
            }
            candidates.push(ManifestCandidate { kind, manifest });
        }
        if candidates.is_empty() {
            return if entry_count == 0 {
                Ok(None)
            } else {
                Err(MigrationStoreError::Invalid(
                    "manifest directory has no valid journal candidate".into(),
                ))
            };
        }
        let transaction_ids = candidates
            .iter()
            .map(|candidate| candidate.manifest.transaction_id.as_str())
            .collect::<BTreeSet<_>>();
        if transaction_ids.len() != 1 {
            return Err(MigrationStoreError::Conflict(
                "intent contains multiple transaction journals".into(),
            ));
        }
        for left in 0..candidates.len() {
            for right in (left + 1)..candidates.len() {
                if candidates[left].manifest.journal_revision
                    == candidates[right].manifest.journal_revision
                    && candidates[left].manifest != candidates[right].manifest
                {
                    return Err(MigrationStoreError::Conflict(
                        "manifest candidates at the same revision disagree".into(),
                    ));
                }
            }
        }
        validate_manifest_candidate_topology(&candidates)?;
        let latest_revision = candidates
            .iter()
            .map(|candidate| candidate.manifest.journal_revision)
            .max()
            .ok_or_else(|| MigrationStoreError::Invalid("empty candidate set".into()))?;
        let mut latest = candidates
            .into_iter()
            .filter(|candidate| candidate.manifest.journal_revision == latest_revision)
            .collect::<Vec<_>>();
        let expected = latest[0].manifest.clone();
        if latest
            .iter()
            .any(|candidate| candidate.manifest != expected)
        {
            return Err(MigrationStoreError::Conflict(
                "latest manifest candidates disagree".into(),
            ));
        }
        latest.sort_by_key(|candidate| candidate.kind);
        Ok(latest.pop())
    }

    fn publish_manifest(
        &self,
        intent_dir: &Path,
        manifest: &MigrationManifest,
        reuse_existing_temp: bool,
    ) -> StoreResult<()> {
        let primary = intent_dir.join(format!("{}.json", manifest.transaction_id));
        let temp = intent_dir.join(format!("{}.json.tmp", manifest.transaction_id));
        let backup = intent_dir.join(format!("{}.json.bak", manifest.transaction_id));
        if !reuse_existing_temp {
            remove_derived_file_if_exists(&temp)?;
            let bytes =
                serialize_json_with_limit(manifest, MAX_MANIFEST_BYTES, "migration manifest")?;
            write_new_synced(&temp, &bytes)?;
        } else {
            let temp_bytes = read_regular_file(&temp, MAX_MANIFEST_BYTES)?;
            let temp_manifest: MigrationManifest =
                serde_json::from_slice(&temp_bytes).map_err(json_error)?;
            validate_manifest(&temp_manifest)?;
            if temp_manifest != *manifest {
                return Err(MigrationStoreError::Conflict(
                    "temporary manifest changed before publish".into(),
                ));
            }
        }

        if primary.exists() {
            match read_regular_file(&primary, MAX_MANIFEST_BYTES)
                .and_then(|bytes| {
                    serde_json::from_slice::<MigrationManifest>(&bytes).map_err(json_error)
                })
                .and_then(|candidate| {
                    validate_manifest(&candidate)?;
                    Ok(candidate)
                }) {
                Ok(_) => {
                    remove_derived_file_if_exists(&backup)?;
                    fs::rename(&primary, &backup).map_err(io_error)?;
                }
                Err(MigrationStoreError::Invalid(_)) => {
                    remove_derived_file_if_exists(&primary)?;
                }
                Err(error) => return Err(error),
            }
        }
        fs::rename(&temp, &primary).map_err(io_error)?;
        sync_directory_if_supported(intent_dir)
    }

    fn intent_dir(&self, intent_id: &str, create: bool) -> StoreResult<PathBuf> {
        validate_uuid(intent_id, "intent ID")?;
        self.validate_store_root()?;
        let intents_root = self.intents_root();
        validate_directory(&intents_root)?;
        let path = intents_root.join(intent_id);
        if create {
            create_derived_directory(&path)?;
        } else {
            validate_directory(&path)?;
        }
        Ok(path)
    }

    fn intent_dir_if_exists(&self, intent_id: &str) -> StoreResult<Option<PathBuf>> {
        self.validate_store_root()?;
        let intents_root = self.intents_root();
        validate_directory(&intents_root)?;
        let path = intents_root.join(intent_id);
        match fs::symlink_metadata(&path) {
            Ok(_) => {
                validate_directory(&path)?;
                Ok(Some(path))
            }
            Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
            Err(error) => Err(io_error(error)),
        }
    }

    fn intents_root(&self) -> PathBuf {
        self.root.join("intents")
    }

    fn claims_root(&self) -> PathBuf {
        self.root.join("claims")
    }

    fn locks_root(&self) -> PathBuf {
        self.root.join("locks")
    }

    fn transactions_root(&self) -> PathBuf {
        self.root.join("transactions")
    }

    fn validate_store_root(&self) -> StoreResult<()> {
        validate_directory_ancestors(&self.root)
    }
}

fn validate_manifest(manifest: &MigrationManifest) -> StoreResult<()> {
    manifest.validate().map_err(|error| {
        MigrationStoreError::Invalid(format!("manifest validation failed: {error:?}"))
    })?;
    if manifest.journal_revision == 0 {
        return Err(MigrationStoreError::Invalid(
            "manifest revision is zero".into(),
        ));
    }
    if manifest.journal_revision == u64::MAX {
        return Err(MigrationStoreError::Invalid(
            "manifest revision reached the forbidden maximum".into(),
        ));
    }
    validate_uuid(&manifest.intent_id, "intent ID")?;
    validate_uuid(&manifest.transaction_id, "transaction ID")
}

fn validate_manifest_candidate_topology(candidates: &[ManifestCandidate]) -> StoreResult<()> {
    let revision = |kind| {
        candidates
            .iter()
            .find(|candidate| candidate.kind == kind)
            .map(|candidate| candidate.manifest.journal_revision)
    };
    let backup = revision(CandidateKind::Backup);
    let primary = revision(CandidateKind::Primary);
    let temp = revision(CandidateKind::Temp);
    let next = |value: u64| value.checked_add(1);

    let valid = match (backup, primary, temp) {
        (None, Some(1), None) | (None, None, Some(1)) => true,
        (Some(backup), Some(primary), None) => next(backup) == Some(primary),
        (None, Some(primary), Some(temp)) => next(primary) == Some(temp),
        (Some(backup), None, Some(temp)) => next(backup) == Some(temp),
        (Some(backup), Some(primary), Some(temp)) => {
            next(backup) == Some(primary) && next(primary) == Some(temp)
        }
        _ => false,
    };
    if !valid {
        return Err(MigrationStoreError::Invalid(
            "manifest revision topology is not explainable by atomic publish".into(),
        ));
    }
    Ok(())
}

fn validate_grant_claim(claim: &GrantClaim) -> StoreResult<()> {
    validate_sha256(&claim.grant_digest, "grant digest")?;
    validate_uuid(&claim.intent_id, "intent ID")?;
    validate_uuid(&claim.transaction_id, "transaction ID")
}

fn validate_transaction_lock(record: &TransactionLockRecord) -> StoreResult<()> {
    validate_uuid(&record.transaction_id, "transaction ID")?;
    if record.owner_pid == 0 {
        return Err(MigrationStoreError::Invalid(
            "transaction lock owner PID is zero".into(),
        ));
    }
    match (record.schema_version, record.owner_process_started_at) {
        (0, 0) => {}
        (TRANSACTION_LOCK_SCHEMA_VERSION, started_at) if started_at > 0 => {}
        _ => {
            return Err(MigrationStoreError::Invalid(
                "transaction lock process identity is invalid".into(),
            ))
        }
    }
    Ok(())
}

fn record_matches_process(record: &TransactionLockRecord, process: ProcessIdentity) -> bool {
    record.schema_version == TRANSACTION_LOCK_SCHEMA_VERSION
        && record.owner_pid == process.pid
        && record.owner_process_started_at == process.started_at
}

fn try_open_transaction_lock(path: &Path) -> StoreResult<Option<File>> {
    let mut options = OpenOptions::new();
    options.read(true).write(true);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::FILE_SHARE_READ;
        options.share_mode(FILE_SHARE_READ);
    }
    let file = match options.open(path) {
        Ok(file) => file,
        Err(error) if is_transaction_lock_busy_error(&error) => return Ok(None),
        Err(error) => return Err(io_error(error)),
    };
    match file.try_lock() {
        Ok(()) => Ok(Some(file)),
        Err(std::fs::TryLockError::WouldBlock) => Ok(None),
        Err(std::fs::TryLockError::Error(error)) => Err(io_error(error)),
    }
}

fn validate_transaction_lock_path(path: &Path) -> StoreResult<()> {
    let metadata = fs::symlink_metadata(path).map_err(io_error)?;
    validate_file_metadata(path, &metadata, MAX_CLAIM_BYTES)
}

fn is_transaction_lock_busy_error(error: &std::io::Error) -> bool {
    if matches!(
        error.kind(),
        ErrorKind::PermissionDenied | ErrorKind::WouldBlock
    ) {
        return true;
    }
    #[cfg(target_os = "windows")]
    {
        return matches!(error.raw_os_error(), Some(32) | Some(33));
    }
    #[cfg(not(target_os = "windows"))]
    false
}

fn read_transaction_lock_from_handle(
    file: &mut File,
    path: &Path,
) -> StoreResult<(TransactionLockRecord, Vec<u8>)> {
    validate_transaction_lock_path(path)?;
    let metadata = file.metadata().map_err(io_error)?;
    validate_file_metadata(path, &metadata, MAX_CLAIM_BYTES)?;
    file.seek(SeekFrom::Start(0)).map_err(io_error)?;
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take(MAX_CLAIM_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(io_error)?;
    if bytes.len() as u64 != metadata.len() || bytes.len() as u64 > MAX_CLAIM_BYTES {
        return Err(MigrationStoreError::Invalid(
            "transaction lock changed while its lease was acquired".into(),
        ));
    }
    let record = serde_json::from_slice(&bytes).map_err(json_error)?;
    Ok((record, bytes))
}

fn read_transaction_lock_from_path(path: &Path) -> StoreResult<(TransactionLockRecord, Vec<u8>)> {
    let bytes = read_regular_file(path, MAX_CLAIM_BYTES)?;
    let record = serde_json::from_slice(&bytes).map_err(json_error)?;
    validate_transaction_lock(&record)?;
    Ok((record, bytes))
}

fn read_transaction_lock_from_guard(
    file: &File,
    path: &Path,
) -> StoreResult<TransactionLockRecord> {
    validate_transaction_lock_path(path)?;
    let metadata = file.metadata().map_err(io_error)?;
    validate_file_metadata(path, &metadata, MAX_CLAIM_BYTES)?;
    let mut bytes = vec![0; metadata.len() as usize];
    let mut offset = 0usize;
    while offset < bytes.len() {
        let read = read_file_at(file, &mut bytes[offset..], offset as u64)?;
        if read == 0 {
            return Err(MigrationStoreError::Invalid(
                "transaction lock ended before its recorded size".into(),
            ));
        }
        offset += read;
    }
    let record = serde_json::from_slice(&bytes).map_err(json_error)?;
    validate_transaction_lock(&record)?;
    Ok(record)
}

#[cfg(target_os = "windows")]
fn read_file_at(file: &File, bytes: &mut [u8], offset: u64) -> StoreResult<usize> {
    use std::os::windows::fs::FileExt;
    file.seek_read(bytes, offset).map_err(io_error)
}

#[cfg(not(target_os = "windows"))]
fn read_file_at(file: &File, bytes: &mut [u8], offset: u64) -> StoreResult<usize> {
    use std::os::unix::fs::FileExt;
    file.read_at(bytes, offset).map_err(io_error)
}

fn write_transaction_lock_to_handle(
    file: &mut File,
    record: &TransactionLockRecord,
) -> StoreResult<()> {
    validate_transaction_lock(record)?;
    let bytes = serialize_json_with_limit(record, MAX_CLAIM_BYTES, "transaction lock")?;
    file.seek(SeekFrom::Start(0)).map_err(io_error)?;
    file.set_len(0).map_err(io_error)?;
    file.write_all(&bytes).map_err(io_error)?;
    file.flush().map_err(io_error)?;
    file.sync_all().map_err(io_error)
}

fn restore_transaction_lock_from_backup(
    file: &mut File,
    lock_path: &Path,
    backup_path: &Path,
) -> StoreResult<()> {
    let bytes = read_regular_file(backup_path, MAX_CLAIM_BYTES)?;
    let record: TransactionLockRecord = serde_json::from_slice(&bytes).map_err(json_error)?;
    validate_transaction_lock(&record)?;
    file.seek(SeekFrom::Start(0)).map_err(io_error)?;
    file.set_len(0).map_err(io_error)?;
    file.write_all(&bytes).map_err(io_error)?;
    file.flush().map_err(io_error)?;
    file.sync_all().map_err(io_error)?;
    remove_derived_file_if_exists(backup_path)?;
    sync_directory_if_supported(
        lock_path
            .parent()
            .ok_or_else(|| MigrationStoreError::Invalid("lock has no parent directory".into()))?,
    )
}

#[cfg(target_os = "windows")]
fn current_process_identity() -> StoreResult<ProcessIdentity> {
    use windows_sys::Win32::System::Threading::GetCurrentProcess;

    let pid = std::process::id();
    let started_at = process_start_time(unsafe { GetCurrentProcess() })?;
    Ok(ProcessIdentity { pid, started_at })
}

#[cfg(target_os = "windows")]
fn observe_process_owner(record: &TransactionLockRecord) -> StoreResult<ProcessOwnerState> {
    use windows_sys::Win32::Foundation::{
        CloseHandle, ERROR_ACCESS_DENIED, ERROR_INVALID_PARAMETER, WAIT_OBJECT_0, WAIT_TIMEOUT,
    };
    use windows_sys::Win32::Storage::FileSystem::SYNCHRONIZE;
    use windows_sys::Win32::System::Threading::{
        OpenProcess, WaitForSingleObject, PROCESS_QUERY_LIMITED_INFORMATION,
    };

    let handle = unsafe {
        OpenProcess(
            PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE,
            0,
            record.owner_pid,
        )
    };
    if handle.is_null() {
        let code = std::io::Error::last_os_error().raw_os_error().unwrap_or(0) as u32;
        return Ok(match code {
            ERROR_INVALID_PARAMETER => ProcessOwnerState::MissingOrReused,
            ERROR_ACCESS_DENIED => ProcessOwnerState::Unknown,
            _ => ProcessOwnerState::Unknown,
        });
    }

    let wait = unsafe { WaitForSingleObject(handle, 0) };
    let started_at = process_start_time(handle);
    unsafe { CloseHandle(handle) };
    match wait {
        WAIT_OBJECT_0 => Ok(ProcessOwnerState::MissingOrReused),
        WAIT_TIMEOUT => {
            let started_at = started_at?;
            if record.schema_version == TRANSACTION_LOCK_SCHEMA_VERSION
                && record.owner_process_started_at != started_at
            {
                Ok(ProcessOwnerState::MissingOrReused)
            } else if record.schema_version == TRANSACTION_LOCK_SCHEMA_VERSION {
                Ok(ProcessOwnerState::MatchingAlive)
            } else {
                Ok(ProcessOwnerState::Unknown)
            }
        }
        _ => Ok(ProcessOwnerState::Unknown),
    }
}

#[cfg(target_os = "windows")]
fn process_start_time(handle: windows_sys::Win32::Foundation::HANDLE) -> StoreResult<u64> {
    use windows_sys::Win32::Foundation::FILETIME;
    use windows_sys::Win32::System::Threading::GetProcessTimes;

    let mut created = FILETIME {
        dwLowDateTime: 0,
        dwHighDateTime: 0,
    };
    let mut exited = created;
    let mut kernel = created;
    let mut user = created;
    if unsafe { GetProcessTimes(handle, &mut created, &mut exited, &mut kernel, &mut user) } == 0 {
        return Err(io_error(std::io::Error::last_os_error()));
    }
    let value = ((created.dwHighDateTime as u64) << 32) | created.dwLowDateTime as u64;
    if value == 0 {
        return Err(MigrationStoreError::Invalid(
            "process creation time is zero".into(),
        ));
    }
    Ok(value)
}

#[cfg(not(target_os = "windows"))]
fn current_process_identity() -> StoreResult<ProcessIdentity> {
    static PROCESS_STARTED_AT: OnceLock<u64> = OnceLock::new();
    let started_at = *PROCESS_STARTED_AT.get_or_init(|| {
        SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .map(|duration| duration.as_nanos() as u64)
            .unwrap_or(1)
            .max(1)
    });
    Ok(ProcessIdentity {
        pid: std::process::id(),
        started_at,
    })
}

#[cfg(not(target_os = "windows"))]
fn observe_process_owner(record: &TransactionLockRecord) -> StoreResult<ProcessOwnerState> {
    if record.owner_pid > i32::MAX as u32 {
        return Ok(ProcessOwnerState::MissingOrReused);
    }
    let result = unsafe { libc::kill(record.owner_pid as i32, 0) };
    if result == 0 {
        Ok(ProcessOwnerState::Unknown)
    } else if std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH) {
        Ok(ProcessOwnerState::MissingOrReused)
    } else {
        Ok(ProcessOwnerState::Unknown)
    }
}

fn manifest_file_identity(path: &Path) -> StoreResult<(String, CandidateKind)> {
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| MigrationStoreError::Invalid("manifest file name is not UTF-8".into()))?;
    let (transaction_id, kind) = if let Some(value) = name.strip_suffix(".json.tmp") {
        (value, CandidateKind::Temp)
    } else if let Some(value) = name.strip_suffix(".json.bak") {
        (value, CandidateKind::Backup)
    } else if let Some(value) = name.strip_suffix(".json") {
        (value, CandidateKind::Primary)
    } else {
        return Err(MigrationStoreError::Invalid(
            "manifest file has an unsupported name".into(),
        ));
    };
    validate_uuid(transaction_id, "manifest transaction ID")?;
    Ok((transaction_id.into(), kind))
}

fn validate_uuid(value: &str, label: &str) -> StoreResult<()> {
    let parsed = uuid::Uuid::parse_str(value)
        .map_err(|_| MigrationStoreError::Invalid(format!("invalid {label}")))?;
    if parsed.hyphenated().to_string() != value {
        return Err(MigrationStoreError::Invalid(format!("invalid {label}")));
    }
    Ok(())
}

fn validate_sha256(value: &str, label: &str) -> StoreResult<()> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(MigrationStoreError::Invalid(format!("invalid {label}")));
    }
    Ok(())
}

fn serialize_json_with_limit<T: Serialize>(
    value: &T,
    max_bytes: u64,
    label: &str,
) -> StoreResult<Vec<u8>> {
    let bytes = serde_json::to_vec(value).map_err(json_error)?;
    if bytes.is_empty() || bytes.len() as u64 > max_bytes {
        return Err(MigrationStoreError::Invalid(format!(
            "serialized {label} is outside the allowed size"
        )));
    }
    Ok(bytes)
}

fn atomic_create_record(path: &Path, bytes: &[u8]) -> StoreResult<AtomicCreateOutcome> {
    let _guard = ATOMIC_CREATE_MUTEX
        .get_or_init(|| StdMutex::new(()))
        .lock()
        .map_err(|_| MigrationStoreError::Io("atomic record mutex is poisoned".into()))?;
    let parent = path
        .parent()
        .ok_or_else(|| MigrationStoreError::Invalid("record has no parent directory".into()))?;
    validate_directory(parent)?;
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| MigrationStoreError::Invalid("record file name is not UTF-8".into()))?;
    cleanup_orphan_record_temps(parent, file_name)?;
    let temp = parent.join(format!(
        ".{file_name}.{}.tmp",
        uuid::Uuid::new_v4().hyphenated()
    ));
    write_new_synced(&temp, bytes)?;
    match fs::hard_link(&temp, path) {
        Ok(()) => {
            sync_directory_if_supported(parent)?;
            remove_derived_file_if_exists(&temp)?;
            sync_directory_if_supported(parent)?;
            Ok(AtomicCreateOutcome::Created)
        }
        Err(error) if error.kind() == ErrorKind::AlreadyExists => {
            remove_derived_file_if_exists(&temp)?;
            sync_directory_if_supported(parent)?;
            Ok(AtomicCreateOutcome::Existing)
        }
        Err(error) => {
            let _ = remove_derived_file_if_exists(&temp);
            Err(io_error(error))
        }
    }
}

fn cleanup_orphan_record_temps(parent: &Path, final_name: &str) -> StoreResult<()> {
    validate_directory(parent)?;
    let mut scanned = 0usize;
    let mut removed = 0usize;
    for entry in fs::read_dir(parent).map_err(io_error)? {
        scanned = scanned.checked_add(1).ok_or_else(|| {
            MigrationStoreError::Conflict("directory entry count overflow".into())
        })?;
        if scanned > MAX_ATOMIC_DIRECTORY_ENTRIES {
            return Err(MigrationStoreError::Conflict(
                "atomic record directory exceeds the bounded scan limit".into(),
            ));
        }
        let path = entry.map_err(io_error)?.path();
        let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
            continue;
        };
        if !is_exact_orphan_temp_name(name, final_name) {
            continue;
        }
        let metadata = fs::symlink_metadata(&path).map_err(io_error)?;
        if !metadata.is_file() || metadata.file_type().is_symlink() || is_reparse_point(&metadata) {
            return Err(MigrationStoreError::Invalid(format!(
                "orphan temp candidate is not a regular non-reparse file: {}",
                path.display()
            )));
        }
        if !orphan_temp_is_stale(&metadata, SystemTime::now())? {
            continue;
        }
        if removed >= MAX_ORPHAN_TEMPS_PER_CREATE {
            return Err(MigrationStoreError::Conflict(
                "orphan temp cleanup limit reached; retry to continue bounded cleanup".into(),
            ));
        }
        remove_derived_file_if_exists(&path)?;
        removed += 1;
    }
    Ok(())
}

fn is_exact_orphan_temp_name(name: &str, final_name: &str) -> bool {
    let prefix = format!(".{final_name}.");
    let Some(uuid) = name
        .strip_prefix(&prefix)
        .and_then(|value| value.strip_suffix(".tmp"))
    else {
        return false;
    };
    uuid::Uuid::parse_str(uuid).is_ok_and(|parsed| parsed.hyphenated().to_string() == uuid)
}

fn orphan_temp_is_stale(metadata: &fs::Metadata, now: SystemTime) -> StoreResult<bool> {
    let modified = metadata.modified().map_err(io_error)?;
    Ok(now
        .duration_since(modified)
        .is_ok_and(|age| age >= ORPHAN_TEMP_STALE_AFTER))
}

fn create_derived_directory(path: &Path) -> StoreResult<()> {
    match fs::create_dir(path) {
        Ok(()) => sync_directory_if_supported(
            path.parent()
                .ok_or_else(|| MigrationStoreError::Invalid("directory has no parent".into()))?,
        )?,
        Err(error) if error.kind() == ErrorKind::AlreadyExists => {}
        Err(error) => return Err(io_error(error)),
    }
    validate_directory(path)
}

fn validate_directory(path: &Path) -> StoreResult<()> {
    let metadata = fs::symlink_metadata(path).map_err(io_error)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() || is_reparse_point(&metadata) {
        return Err(MigrationStoreError::Invalid(format!(
            "directory is not a regular non-reparse directory: {}",
            path.display()
        )));
    }
    Ok(())
}

fn validate_existing_directory_ancestors(path: &Path) -> StoreResult<()> {
    let mut ancestors = path.ancestors().collect::<Vec<_>>();
    ancestors.reverse();
    for ancestor in ancestors {
        match fs::symlink_metadata(ancestor) {
            Ok(metadata) => {
                if !metadata.is_dir()
                    || metadata.file_type().is_symlink()
                    || is_reparse_point(&metadata)
                {
                    return Err(MigrationStoreError::Invalid(format!(
                        "store ancestor is not a regular non-reparse directory: {}",
                        ancestor.display()
                    )));
                }
            }
            Err(error) if error.kind() == ErrorKind::NotFound => {}
            Err(error) => return Err(io_error(error)),
        }
    }
    Ok(())
}

fn validate_directory_ancestors(path: &Path) -> StoreResult<()> {
    validate_existing_directory_ancestors(path)?;
    validate_directory(path)
}

fn read_regular_file(path: &Path, max_bytes: u64) -> StoreResult<Vec<u8>> {
    let parent = path
        .parent()
        .ok_or_else(|| MigrationStoreError::Invalid("file has no parent directory".into()))?;
    validate_directory(parent)?;
    let before = fs::symlink_metadata(path).map_err(io_error)?;
    validate_file_metadata(path, &before, max_bytes)?;
    let bytes = fs::read(path).map_err(io_error)?;
    let after = fs::symlink_metadata(path).map_err(io_error)?;
    validate_file_metadata(path, &after, max_bytes)?;
    if before.len() != after.len() || bytes.len() as u64 != after.len() {
        return Err(MigrationStoreError::Invalid(format!(
            "file changed while being read: {}",
            path.display()
        )));
    }
    Ok(bytes)
}

fn validate_file_metadata(path: &Path, metadata: &fs::Metadata, max_bytes: u64) -> StoreResult<()> {
    if !metadata.is_file() || metadata.file_type().is_symlink() || is_reparse_point(metadata) {
        return Err(MigrationStoreError::Invalid(format!(
            "path is not a regular non-reparse file: {}",
            path.display()
        )));
    }
    if metadata.len() == 0 || metadata.len() > max_bytes {
        return Err(MigrationStoreError::Invalid(format!(
            "file size is outside the allowed range: {}",
            path.display()
        )));
    }
    Ok(())
}

fn write_new_synced(path: &Path, bytes: &[u8]) -> StoreResult<()> {
    let parent = path
        .parent()
        .ok_or_else(|| MigrationStoreError::Invalid("file has no parent directory".into()))?;
    validate_directory(parent)?;
    let mut file = match OpenOptions::new().write(true).create_new(true).open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == ErrorKind::AlreadyExists => {
            return Err(MigrationStoreError::AlreadyExists(path.to_path_buf()))
        }
        Err(error) => return Err(io_error(error)),
    };
    file.write_all(bytes).map_err(io_error)?;
    file.flush().map_err(io_error)?;
    file.sync_all().map_err(io_error)
}

fn read_json_with_retry<T>(path: &Path, max_bytes: u64) -> StoreResult<T>
where
    T: for<'de> Deserialize<'de>,
{
    let mut last_error = None;
    for _ in 0..CLAIM_READ_ATTEMPTS {
        match read_regular_file(path, max_bytes)
            .and_then(|bytes| serde_json::from_slice(&bytes).map_err(json_error))
        {
            Ok(value) => return Ok(value),
            Err(error) => {
                last_error = Some(error);
                std::thread::sleep(std::time::Duration::from_millis(1));
            }
        }
    }
    Err(last_error
        .unwrap_or_else(|| MigrationStoreError::Invalid("durable record could not be read".into())))
}

fn remove_derived_file_if_exists(path: &Path) -> StoreResult<()> {
    let parent = path
        .parent()
        .ok_or_else(|| MigrationStoreError::Invalid("file has no parent directory".into()))?;
    validate_directory(parent)?;
    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            if !metadata.is_file()
                || metadata.file_type().is_symlink()
                || is_reparse_point(&metadata)
            {
                return Err(MigrationStoreError::Invalid(format!(
                    "refusing to replace a non-regular derived file: {}",
                    path.display()
                )));
            }
            fs::remove_file(path).map_err(io_error)
        }
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
        Err(error) => Err(io_error(error)),
    }
}

fn sync_directory_if_supported(path: impl AsRef<Path>) -> StoreResult<()> {
    let path = path.as_ref();
    validate_directory(path)?;
    let Ok(directory) = File::open(path) else {
        return Ok(());
    };
    directory.sync_all().map_err(io_error)
}

#[cfg(target_os = "windows")]
fn is_reparse_point(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    metadata.file_attributes() & 0x400 != 0
}

#[cfg(not(target_os = "windows"))]
fn is_reparse_point(_metadata: &fs::Metadata) -> bool {
    false
}

fn io_error(error: std::io::Error) -> MigrationStoreError {
    MigrationStoreError::Io(error.to_string())
}

fn json_error(error: serde_json::Error) -> MigrationStoreError {
    MigrationStoreError::Invalid(error.to_string())
}

#[cfg(test)]
mod tests {
    use super::super::installer_migration_core::InstallerFamily;
    use super::super::installer_migration_engine::{
        ExactSourceMetadata, MigrationPhase, NsisSourceSnapshot, ObservedOwnership,
        SourceMetadataKind, SourceRootSnapshot, TargetInstallerSnapshot,
        INSTALLER_MIGRATION_ENGINE_SCHEMA_VERSION,
    };
    use super::*;
    use sha2::{Digest, Sha256};
    use std::sync::{Arc, Barrier};

    const INTENT_ID: &str = "11111111-1111-4111-8111-111111111111";
    const TRANSACTION_ID: &str = "22222222-2222-4222-8222-222222222222";
    const OTHER_TRANSACTION_ID: &str = "33333333-3333-4333-8333-333333333333";
    const HASH: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const GRANT: &str = "1123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    fn temp_root(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "codex-monitor-migration-store-{label}-{}",
            uuid::Uuid::new_v4()
        ))
    }

    fn store(label: &str) -> MigrationStore {
        MigrationStore::new(temp_root(label)).unwrap()
    }

    fn acquire_current_process_lock(store: &MigrationStore) -> TransactionLockGuard {
        let outcome = store.acquire_transaction_lock(TRANSACTION_ID).unwrap();
        let guard = match outcome {
            TransactionLockOutcome::Acquired(guard) => guard,
            TransactionLockOutcome::Existing(record) => {
                panic!("fresh transaction lock unexpectedly exists: {record:?}")
            }
            TransactionLockOutcome::Busy => panic!("fresh transaction lock is busy"),
        };
        assert_eq!(guard.record().owner_pid, std::process::id());
        assert!(guard.record().owner_process_started_at > 0);
        guard
    }

    fn manifest(revision: u64) -> MigrationManifest {
        let snapshot = b"registry snapshot".to_vec();
        MigrationManifest {
            schema_version: INSTALLER_MIGRATION_ENGINE_SCHEMA_VERSION,
            journal_revision: revision,
            transaction_id: TRANSACTION_ID.into(),
            intent_id: INTENT_ID.into(),
            intent_digest: HASH.into(),
            grant_digest: GRANT.into(),
            grant_consumed: false,
            phase: MigrationPhase::Prepared,
            source: NsisSourceSnapshot {
                ownership: ObservedOwnership::PureNsis,
                root: SourceRootSnapshot {
                    source_path: r"C:\Apps\ThreadFleet".into(),
                    backup_path: r"C:\Migration\source".into(),
                    tree_sha256: HASH.into(),
                },
                metadata: vec![ExactSourceMetadata {
                    kind: SourceMetadataKind::NsisUninstallRegistration,
                    locator: "hkcu32".into(),
                    snapshot_sha256: format!("{:x}", Sha256::digest(&snapshot)),
                    snapshot,
                }],
            },
            target: TargetInstallerSnapshot {
                family: InstallerFamily::Msi,
                artifact_path: r"C:\Migration\target.msi".into(),
                artifact_size: 42,
                artifact_sha256: HASH.into(),
                version: "0.7.91".into(),
                product_code: "{AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE}".into(),
                expected_install_root: r"C:\Apps\ThreadFleet".into(),
                expected_executable_sha256: HASH.into(),
            },
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
        }
    }

    fn write_candidate(store: &MigrationStore, value: &MigrationManifest, suffix: &str) {
        let intent_dir = store.intent_dir(INTENT_ID, true).unwrap();
        fs::write(
            intent_dir.join(format!("{}{suffix}", value.transaction_id)),
            serde_json::to_vec(value).unwrap(),
        )
        .unwrap();
    }

    fn mark_file_stale(path: &Path) {
        let modified = SystemTime::now()
            .checked_sub(ORPHAN_TEMP_STALE_AFTER + Duration::from_secs(1))
            .unwrap();
        let file = OpenOptions::new().write(true).open(path).unwrap();
        file.set_times(std::fs::FileTimes::new().set_modified(modified))
            .unwrap();
    }

    fn orphan_name(final_name: &str) -> String {
        format!(".{final_name}.{}.tmp", uuid::Uuid::new_v4().hyphenated())
    }

    #[test]
    fn persists_contiguous_revisions_and_rejects_stale_or_skipped_updates() {
        let store = store("revision");
        let lock = acquire_current_process_lock(&store);
        let first = manifest(1);
        store.persist_manifest(&first, &lock).unwrap();
        assert_eq!(store.load_manifest(INTENT_ID).unwrap(), Some(first.clone()));
        store.persist_manifest(&first, &lock).unwrap();

        assert!(store.persist_manifest(&manifest(3), &lock).is_err());
        let second = manifest(2);
        store.persist_manifest(&second, &lock).unwrap();
        assert_eq!(store.load_manifest(INTENT_ID).unwrap(), Some(second));
        assert!(store.persist_manifest(&first, &lock).is_err());
    }

    #[test]
    fn rejects_isolated_temp_when_primary_is_torn() {
        let store = store("torn-primary");
        let lock = acquire_current_process_lock(&store);
        store.persist_manifest(&manifest(1), &lock).unwrap();
        let primary = store
            .intent_dir(INTENT_ID, false)
            .unwrap()
            .join(format!("{TRANSACTION_ID}.json"));
        fs::write(primary, b"{").unwrap();
        write_candidate(&store, &manifest(2), ".json.tmp");

        assert!(matches!(
            store.load_manifest(INTENT_ID),
            Err(MigrationStoreError::Invalid(message))
                if message.contains("topology")
        ));
    }

    #[test]
    fn selects_latest_backup_and_rejects_same_revision_conflicts() {
        let store = store("backup-conflict");
        write_candidate(&store, &manifest(1), ".json.bak");
        write_candidate(&store, &manifest(2), ".json");
        assert_eq!(
            store
                .load_manifest(INTENT_ID)
                .unwrap()
                .unwrap()
                .journal_revision,
            2
        );

        let mut conflict = manifest(2);
        conflict.last_error = Some("different".into());
        write_candidate(&store, &conflict, ".json.tmp");
        assert!(matches!(
            store.load_manifest(INTENT_ID),
            Err(MigrationStoreError::Conflict(_))
        ));
    }

    #[test]
    fn manifest_persist_requires_current_process_transaction_lock() {
        let owning_store = store("owning-lock");
        let lock = acquire_current_process_lock(&owning_store);
        let different_store = store("different-lock-root");
        assert!(matches!(
            different_store.persist_manifest(&manifest(1), &lock),
            Err(MigrationStoreError::Conflict(message))
                if message.contains("transaction lock guard")
        ));
    }

    #[test]
    fn concurrent_manifest_persist_allows_one_revision_writer() {
        let store = Arc::new(store("manifest-race"));
        let lock = Arc::new(acquire_current_process_lock(&store));
        store.persist_manifest(&manifest(1), &lock).unwrap();

        let barrier = Arc::new(Barrier::new(3));
        let handles = ["first", "second"].map(|message| {
            let store = Arc::clone(&store);
            let lock = Arc::clone(&lock);
            let barrier = Arc::clone(&barrier);
            std::thread::spawn(move || {
                let mut next = manifest(2);
                next.last_error = Some(message.into());
                barrier.wait();
                store.persist_manifest(&next, &lock)
            })
        });
        barrier.wait();
        let results = handles.map(|handle| handle.join().unwrap());

        assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
        assert_eq!(
            results
                .iter()
                .filter(|result| matches!(result, Err(MigrationStoreError::Conflict(_))))
                .count(),
            1
        );
        assert_eq!(
            store
                .load_manifest(INTENT_ID)
                .unwrap()
                .unwrap()
                .journal_revision,
            2
        );
    }

    #[test]
    fn rejects_fourth_manifest_candidate_before_reading_payload() {
        let store = store("candidate-limit");
        let intent_dir = store.intent_dir(INTENT_ID, true).unwrap();
        for transaction_id in [
            TRANSACTION_ID,
            OTHER_TRANSACTION_ID,
            "44444444-4444-4444-8444-444444444444",
            "55555555-5555-4555-8555-555555555555",
        ] {
            fs::write(intent_dir.join(format!("{transaction_id}.json")), b"{").unwrap();
        }

        assert!(matches!(
            store.load_manifest(INTENT_ID),
            Err(MigrationStoreError::Invalid(message))
                if message.contains("candidate count")
        ));
    }

    #[test]
    fn accepts_only_atomic_publish_revision_topologies() {
        for (label, candidates, expected_revision) in [
            ("primary-one", vec![(1, ".json")], 1),
            ("temp-one", vec![(1, ".json.tmp")], 1),
            ("backup-primary", vec![(1, ".json.bak"), (2, ".json")], 2),
            ("primary-temp", vec![(1, ".json"), (2, ".json.tmp")], 2),
            ("backup-temp", vec![(1, ".json.bak"), (2, ".json.tmp")], 2),
            (
                "backup-primary-temp",
                vec![(1, ".json.bak"), (2, ".json"), (3, ".json.tmp")],
                3,
            ),
        ] {
            let store = store(label);
            for (revision, suffix) in candidates {
                write_candidate(&store, &manifest(revision), suffix);
            }
            assert_eq!(
                store
                    .load_manifest(INTENT_ID)
                    .unwrap()
                    .unwrap()
                    .journal_revision,
                expected_revision
            );
        }

        for (label, candidates) in [
            ("isolated-high", vec![(2, ".json")]),
            ("revision-gap", vec![(1, ".json"), (3, ".json.tmp")]),
            ("reversed", vec![(2, ".json.bak"), (1, ".json")]),
            ("max-revision", vec![(u64::MAX, ".json")]),
        ] {
            let store = store(label);
            for (revision, suffix) in candidates {
                write_candidate(&store, &manifest(revision), suffix);
            }
            assert!(matches!(
                store.load_manifest(INTENT_ID),
                Err(MigrationStoreError::Invalid(message))
                    if message.contains("topology") || message.contains("maximum")
            ));
        }
    }

    #[test]
    fn rejects_tampered_names_and_manifest_identity() {
        let name_store = store("tampered-name");
        let intent_dir = name_store.intent_dir(INTENT_ID, true).unwrap();
        fs::write(intent_dir.join("not-a-uuid.json"), b"{}").unwrap();
        assert!(matches!(
            name_store.load_manifest(INTENT_ID),
            Err(MigrationStoreError::Invalid(_))
        ));

        let content_store = store("tampered-content");
        let mut changed = manifest(1);
        changed.intent_id = "44444444-4444-4444-8444-444444444444".into();
        write_candidate(&content_store, &changed, ".json");
        assert!(matches!(
            content_store.load_manifest(INTENT_ID),
            Err(MigrationStoreError::Invalid(_))
        ));
    }

    #[test]
    fn grant_claim_is_idempotent_for_one_tuple_and_rejects_replay() {
        let store = store("grant");
        store.claim_grant(GRANT, INTENT_ID, TRANSACTION_ID).unwrap();
        store.claim_grant(GRANT, INTENT_ID, TRANSACTION_ID).unwrap();
        assert!(matches!(
            store.claim_grant(GRANT, INTENT_ID, OTHER_TRANSACTION_ID),
            Err(MigrationStoreError::Conflict(_))
        ));
    }

    #[test]
    fn serialized_size_helper_rejects_oversize_manifest() {
        assert!(matches!(
            serialize_json_with_limit(&manifest(1), 1, "test manifest"),
            Err(MigrationStoreError::Invalid(_))
        ));
    }

    #[test]
    fn orphan_torn_claim_temp_does_not_poison_final_claim() {
        let store = store("orphan-claim-temp");
        let final_name = format!("{GRANT}.json");
        let orphan = store.claims_root().join(orphan_name(&final_name));
        fs::write(&orphan, b"{").unwrap();
        mark_file_stale(&orphan);
        let fresh = store.claims_root().join(orphan_name(&final_name));
        fs::write(&fresh, b"fresh").unwrap();
        let wrong_final = store
            .claims_root()
            .join(orphan_name("different-final.json"));
        fs::write(&wrong_final, b"wrong final").unwrap();
        let noncanonical = store
            .claims_root()
            .join(format!(".{final_name}.not-a-uuid.tmp"));
        fs::write(&noncanonical, b"bad name").unwrap();

        store.claim_grant(GRANT, INTENT_ID, TRANSACTION_ID).unwrap();
        store.claim_grant(GRANT, INTENT_ID, TRANSACTION_ID).unwrap();
        assert!(!orphan.exists());
        assert!(fresh.exists());
        assert!(wrong_final.exists());
        assert!(noncanonical.exists());
    }

    #[test]
    fn orphan_cleanup_limit_converges_across_retries() {
        let store = store("orphan-cleanup-limit");
        let final_name = format!("{GRANT}.json");
        for _ in 0..=MAX_ORPHAN_TEMPS_PER_CREATE {
            let path = store.claims_root().join(orphan_name(&final_name));
            fs::write(&path, b"{").unwrap();
            mark_file_stale(&path);
        }

        assert!(matches!(
            store.claim_grant(GRANT, INTENT_ID, TRANSACTION_ID),
            Err(MigrationStoreError::Conflict(_))
        ));
        store.claim_grant(GRANT, INTENT_ID, TRANSACTION_ID).unwrap();
        let remaining = fs::read_dir(store.claims_root())
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| {
                entry
                    .file_name()
                    .to_str()
                    .is_some_and(|name| is_exact_orphan_temp_name(name, &final_name))
            })
            .count();
        assert_eq!(remaining, 0);
    }

    #[test]
    fn concurrent_create_new_allows_one_grant_owner() {
        let store = Arc::new(store("grant-race"));
        let barrier = Arc::new(Barrier::new(3));
        let handles = [TRANSACTION_ID, OTHER_TRANSACTION_ID].map(|transaction_id| {
            let store = Arc::clone(&store);
            let barrier = Arc::clone(&barrier);
            std::thread::spawn(move || {
                barrier.wait();
                store.claim_grant(GRANT, INTENT_ID, transaction_id)
            })
        });
        barrier.wait();
        let results = handles.map(|handle| handle.join().unwrap());
        assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
        assert_eq!(
            results
                .iter()
                .filter(|result| matches!(result, Err(MigrationStoreError::Conflict(_))))
                .count(),
            1
        );
    }

    #[test]
    fn transaction_lock_holds_lease_and_reacquires_after_drop() {
        let store = store("lock");
        let guard = match store.acquire_transaction_lock(TRANSACTION_ID).unwrap() {
            TransactionLockOutcome::Acquired(guard) => guard,
            TransactionLockOutcome::Existing(record) => {
                panic!("fresh transaction lock unexpectedly exists: {record:?}")
            }
            TransactionLockOutcome::Busy => panic!("fresh transaction lock is busy"),
        };
        assert!(matches!(
            store.acquire_transaction_lock(TRANSACTION_ID).unwrap(),
            TransactionLockOutcome::Busy
        ));
        drop(guard);
        assert!(matches!(
            store.acquire_transaction_lock(TRANSACTION_ID).unwrap(),
            TransactionLockOutcome::Acquired(_)
        ));
    }

    #[test]
    fn legacy_live_owner_without_creation_time_fails_closed() {
        let store = store("legacy-live-lock");
        let path = store.locks_root().join(format!("{TRANSACTION_ID}.lock"));
        fs::write(
            path,
            serde_json::to_vec(&TransactionLockRecord {
                schema_version: 0,
                transaction_id: TRANSACTION_ID.into(),
                owner_pid: std::process::id(),
                owner_process_started_at: 0,
            })
            .unwrap(),
        )
        .unwrap();

        assert!(matches!(
            store.acquire_transaction_lock(TRANSACTION_ID).unwrap(),
            TransactionLockOutcome::Existing(record)
                if record.schema_version == 0
        ));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn reused_pid_creation_time_is_safely_taken_over() {
        let store = store("reused-pid-lock");
        let path = store.locks_root().join(format!("{TRANSACTION_ID}.lock"));
        let current = current_process_identity().unwrap();
        fs::write(
            &path,
            serde_json::to_vec(&TransactionLockRecord {
                schema_version: TRANSACTION_LOCK_SCHEMA_VERSION,
                transaction_id: TRANSACTION_ID.into(),
                owner_pid: current.pid,
                owner_process_started_at: current.started_at + 1,
            })
            .unwrap(),
        )
        .unwrap();

        let guard = match store.acquire_transaction_lock(TRANSACTION_ID).unwrap() {
            TransactionLockOutcome::Acquired(guard) => guard,
            TransactionLockOutcome::Existing(record) => {
                panic!("reused PID was not taken over: {record:?}")
            }
            TransactionLockOutcome::Busy => panic!("reused PID lock is unexpectedly busy"),
        };
        assert!(record_matches_process(guard.record(), current));
        assert!(!path.with_extension("lock.bak").exists());
    }

    #[test]
    fn torn_stale_lock_recovers_from_backup_before_takeover() {
        let store = store("torn-stale-lock");
        let path = store.locks_root().join(format!("{TRANSACTION_ID}.lock"));
        let backup = path.with_extension("lock.bak");
        let stale = TransactionLockRecord {
            schema_version: 0,
            transaction_id: TRANSACTION_ID.into(),
            owner_pid: u32::MAX,
            owner_process_started_at: 0,
        };
        fs::write(&path, b"{").unwrap();
        fs::write(&backup, serde_json::to_vec(&stale).unwrap()).unwrap();

        let guard = match store.acquire_transaction_lock(TRANSACTION_ID).unwrap() {
            TransactionLockOutcome::Acquired(guard) => guard,
            TransactionLockOutcome::Existing(record) => {
                panic!("stale backup owner was not taken over: {record:?}")
            }
            TransactionLockOutcome::Busy => panic!("stale backup lock is unexpectedly busy"),
        };
        assert_eq!(
            guard.record().schema_version,
            TRANSACTION_LOCK_SCHEMA_VERSION
        );
        assert!(!backup.exists());
    }

    #[test]
    fn existing_transaction_lock_must_match_requested_identity() {
        let store = store("lock-identity");
        let path = store.locks_root().join(format!("{TRANSACTION_ID}.lock"));
        fs::write(
            path,
            serde_json::to_vec(&TransactionLockRecord {
                schema_version: 0,
                transaction_id: OTHER_TRANSACTION_ID.into(),
                owner_pid: 41,
                owner_process_started_at: 0,
            })
            .unwrap(),
        )
        .unwrap();

        assert!(matches!(
            store.acquire_transaction_lock(TRANSACTION_ID),
            Err(MigrationStoreError::Invalid(_))
        ));
    }

    #[test]
    fn paths_are_uuid_derived_and_root_must_be_absolute() {
        assert!(MigrationStore::new(PathBuf::from("relative")).is_err());
        let store = store("paths");
        assert!(store.transaction_dir("not-a-uuid").is_err());
        assert!(store
            .transaction_dir(TRANSACTION_ID)
            .unwrap()
            .starts_with(store.root()));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn rejects_reparse_transaction_lock_without_touching_target() {
        use std::os::windows::fs::symlink_file;

        let store = store("lock-reparse");
        let target = temp_root("lock-reparse-target");
        let original = b"external target";
        fs::write(&target, original).unwrap();
        let lock = store.locks_root().join(format!("{TRANSACTION_ID}.lock"));
        if symlink_file(&target, &lock).is_ok() {
            assert!(matches!(
                store.acquire_transaction_lock(TRANSACTION_ID),
                Err(MigrationStoreError::Invalid(_))
            ));
            assert_eq!(fs::read(target).unwrap(), original);
        }
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn rejects_reparse_store_root() {
        use std::os::windows::fs::symlink_dir;

        let target = temp_root("reparse-target");
        fs::create_dir_all(&target).unwrap();
        let link = temp_root("reparse-link");
        if symlink_dir(&target, &link).is_ok() {
            assert!(MigrationStore::new(link).is_err());
        }
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn rejects_existing_reparse_ancestor_before_creating_store_root() {
        use std::os::windows::fs::symlink_dir;

        let target = temp_root("ancestor-target");
        fs::create_dir_all(&target).unwrap();
        let link = temp_root("ancestor-link");
        if symlink_dir(&target, &link).is_ok() {
            assert!(MigrationStore::new(link.join("store")).is_err());
            assert!(!target.join("store").exists());
        }
    }
}
