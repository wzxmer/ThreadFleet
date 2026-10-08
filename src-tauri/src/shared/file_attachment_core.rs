use base64::prelude::*;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use uuid::Uuid;

use super::attachment_storage_core::{
    attachments_root, session_attachment_dir, validate_session_attachment_cleanup,
};
use super::codex_core::normalize_file_path;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub(crate) enum FileAttachmentSource {
    Path {
        path: String,
    },
    Stored {
        path: String,
    },
    Data {
        name: String,
        #[serde(rename = "base64Data")]
        base64_data: String,
    },
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StageFileAttachmentRequest {
    pub(crate) workspace_id: String,
    pub(crate) thread_id: String,
    pub(crate) source: FileAttachmentSource,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StagedFileAttachment {
    pub(crate) name: String,
    pub(crate) path: String,
    pub(crate) byte_length: u64,
}

fn open_path(path: &str) -> Result<(String, fs::File), String> {
    let path = PathBuf::from(normalize_file_path(path));
    let file =
        fs::File::open(&path).map_err(|error| format!("Failed to open attachment: {error}"))?;
    let metadata = file
        .metadata()
        .map_err(|error| format!("Failed to inspect attachment: {error}"))?;
    if !metadata.is_file() {
        return Err("Attachment must be a regular file".to_string());
    }
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("file");
    Ok((safe_file_name(name), file))
}

fn safe_file_name(name: &str) -> String {
    let name = name.rsplit(['/', '\\']).next().unwrap_or("file");
    let name: String = name
        .chars()
        .map(|character| {
            if character.is_control() || "<>:\"|?*".contains(character) {
                '_'
            } else {
                character
            }
        })
        .collect();
    let mut name = name
        .trim_start_matches(' ')
        .trim_end_matches([' ', '.'])
        .to_string();
    if name.is_empty() {
        return "file".to_string();
    }
    let (stem, extension) = name.rsplit_once('.').unwrap_or((&name, ""));
    let upper_stem = stem.to_ascii_uppercase();
    let extension = extension.to_string();
    if matches!(upper_stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (upper_stem.len() == 4
            && (upper_stem.starts_with("COM") || upper_stem.starts_with("LPT"))
            && matches!(upper_stem.as_bytes()[3], b'1'..=b'9'))
    {
        name.insert(0, '_');
    }
    if name.len() > 180 {
        let suffix = if extension.len() <= 16 && !extension.is_empty() {
            format!(".{extension}")
        } else {
            String::new()
        };
        let mut stem = name.strip_suffix(&suffix).unwrap_or(&name).to_string();
        while stem.len() + suffix.len() > 180 {
            stem.pop();
        }
        name = format!("{stem}{suffix}");
    }
    name
}

fn validate_stored_source(codex_home: &Path, source: &FileAttachmentSource) -> Result<(), String> {
    if let FileAttachmentSource::Stored { path } = source {
        let path = fs::canonicalize(normalize_file_path(path))
            .map_err(|error| format!("Saved attachment is unavailable: {error}"))?;
        let root = fs::canonicalize(attachments_root(codex_home).join("sessions"))
            .map_err(|error| format!("Attachment storage is unavailable: {error}"))?;
        if !path.starts_with(root) {
            return Err("Saved attachment is outside session storage".to_string());
        }
    }
    Ok(())
}

pub(crate) fn file_attachment_source_for_remote(
    source: FileAttachmentSource,
) -> Result<FileAttachmentSource, String> {
    if let FileAttachmentSource::Path { path } = source {
        let (name, mut file) = open_path(&path)?;
        let mut encoder = base64::write::EncoderWriter::new(Vec::new(), &BASE64_STANDARD);
        std::io::copy(&mut file, &mut encoder)
            .map_err(|error| format!("Failed to read attachment for upload: {error}"))?;
        let encoded = encoder
            .finish()
            .map_err(|error| format!("Failed to encode attachment for upload: {error}"))?;
        Ok(FileAttachmentSource::Data {
            name,
            base64_data: String::from_utf8(encoded).map_err(|error| error.to_string())?,
        })
    } else {
        Ok(source)
    }
}

pub(crate) fn stage_file_attachment_core(
    codex_home: &Path,
    request: StageFileAttachmentRequest,
) -> Result<StagedFileAttachment, String> {
    if request.workspace_id.trim().is_empty() {
        return Err("Workspace is required".to_string());
    }
    validate_stored_source(codex_home, &request.source)?;
    let directory = session_attachment_dir(codex_home, &request.thread_id)?;
    match request.source {
        FileAttachmentSource::Path { path } | FileAttachmentSource::Stored { path } => {
            let (name, mut file) = open_path(&path)?;
            stage_file_reader(codex_home, &request.thread_id, &directory, name, &mut file)
        }
        FileAttachmentSource::Data { name, base64_data } => {
            let mut reader =
                base64::read::DecoderReader::new(base64_data.as_bytes(), &BASE64_STANDARD);
            stage_file_reader(
                codex_home,
                &request.thread_id,
                &directory,
                safe_file_name(&name),
                &mut reader,
            )
        }
    }
}

fn copy_and_hash(
    reader: &mut impl Read,
    writer: &mut impl Write,
) -> std::io::Result<(String, u64)> {
    let mut hasher = Sha256::new();
    let mut byte_length = 0;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let length = match reader.read(&mut buffer) {
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            result => result?,
        };
        if length == 0 {
            break;
        }
        writer.write_all(&buffer[..length])?;
        hasher.update(&buffer[..length]);
        byte_length += length as u64;
    }
    Ok((format!("{:x}", hasher.finalize()), byte_length))
}

fn stage_file_reader(
    codex_home: &Path,
    thread_id: &str,
    directory: &Path,
    name: String,
    reader: &mut impl Read,
) -> Result<StagedFileAttachment, String> {
    fs::create_dir_all(&directory)
        .map_err(|error| format!("Failed to create attachment directory: {error}"))?;
    validate_session_attachment_cleanup(codex_home, thread_id)?;
    let session_directory = fs::canonicalize(directory)
        .map_err(|error| format!("Failed to resolve session attachment directory: {error}"))?;
    let temp = directory.join(format!(".{}.part", Uuid::new_v4()));
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)
            .map_err(|error| format!("Failed to create attachment snapshot: {error}"))?;
        // Hash the bytes actually saved, without loading the original file into memory.
        let (digest, byte_length) = copy_and_hash(reader, &mut file)
            .map_err(|error| format!("Failed to store attachment: {error}"))?;
        file.sync_all()
            .map_err(|error| format!("Failed to write attachment snapshot: {error}"))?;
        drop(file);
        let directory = directory.join(&digest);
        fs::create_dir_all(&directory)
            .map_err(|error| format!("Failed to create attachment directory: {error}"))?;
        let resolved_directory = fs::canonicalize(&directory)
            .map_err(|error| format!("Failed to resolve attachment directory: {error}"))?;
        if !resolved_directory.starts_with(&session_directory) {
            return Err("Attachment snapshot is outside session storage".to_string());
        }
        let path = directory.join(&name);
        if !snapshot_matches(&path, &digest, byte_length)? {
            if let Err(error) = fs::rename(&temp, &path) {
                if !snapshot_matches(&path, &digest, byte_length)? {
                    return Err(format!("Failed to finalize attachment snapshot: {error}"));
                }
            }
        }
        Ok(StagedFileAttachment {
            name,
            path: path.to_string_lossy().to_string(),
            byte_length,
        })
    })();
    let _ = fs::remove_file(&temp);
    result
}

fn snapshot_matches(path: &Path, digest: &str, byte_length: u64) -> Result<bool, String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(format!("Failed to inspect saved attachment: {error}")),
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("Saved attachment must be a regular file".to_string());
    }
    let mut file = fs::File::open(path)
        .map_err(|error| format!("Failed to open saved attachment: {error}"))?;
    let (existing_digest, existing_length) = copy_and_hash(&mut file, &mut std::io::sink())
        .map_err(|error| format!("Failed to read saved attachment: {error}"))?;
    if existing_length != byte_length || existing_digest != digest {
        return Err("Saved attachment content does not match its snapshot".to_string());
    }
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Seek, SeekFrom};

    fn temp_home() -> PathBuf {
        let path = std::env::temp_dir().join(format!("file-attachment-{}", Uuid::new_v4()));
        fs::create_dir_all(&path).unwrap();
        path
    }

    fn request(thread: &str, source: FileAttachmentSource) -> StageFileAttachmentRequest {
        StageFileAttachmentRequest {
            workspace_id: "workspace-1".to_string(),
            thread_id: thread.to_string(),
            source,
        }
    }

    #[test]
    fn file_attachments_preserve_original_bytes_and_remote_uploads() {
        let home = temp_home();
        let source = home.join("slides.pptx");
        let bytes = b"PK\x03\x04\x00\xfforiginal presentation";
        fs::write(&source, bytes).unwrap();
        let path_source = FileAttachmentSource::Path {
            path: source.to_string_lossy().to_string(),
        };
        let local =
            stage_file_attachment_core(&home, request("thread-a", path_source.clone())).unwrap();
        let upload = file_attachment_source_for_remote(path_source).unwrap();
        let remote = stage_file_attachment_core(&home, request("thread-b", upload)).unwrap();
        assert_eq!(local.name, "slides.pptx");
        assert_eq!(local.byte_length, bytes.len() as u64);
        assert_eq!(fs::read(&local.path).unwrap(), bytes);
        assert_eq!(fs::read(&remote.path).unwrap(), bytes);
        assert_ne!(local.path, remote.path);
        fs::remove_file(&source).unwrap();
        assert_eq!(fs::read(&local.path).unwrap(), bytes);
        validate_session_attachment_cleanup(&home, "thread-a")
            .unwrap()
            .delete()
            .unwrap();
        assert!(!Path::new(&local.path).exists());
        assert!(Path::new(&remote.path).exists());
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn file_attachments_reuse_snapshots_without_overwriting_same_named_files() {
        let home = temp_home();
        let make_source = |bytes: &[u8]| FileAttachmentSource::Data {
            name: "report.pdf".to_string(),
            base64_data: BASE64_STANDARD.encode(bytes),
        };
        let first =
            stage_file_attachment_core(&home, request("thread-a", make_source(b"first"))).unwrap();
        let retry =
            stage_file_attachment_core(&home, request("thread-a", make_source(b"first"))).unwrap();
        let second =
            stage_file_attachment_core(&home, request("thread-a", make_source(b"second"))).unwrap();
        assert_eq!(first.path, retry.path);
        assert_ne!(first.path, second.path);
        assert_eq!(fs::read(&first.path).unwrap(), b"first");
        let copied = stage_file_attachment_core(
            &home,
            request(
                "thread-b",
                FileAttachmentSource::Stored {
                    path: first.path.clone(),
                },
            ),
        )
        .unwrap();
        assert_eq!(fs::read(&copied.path).unwrap(), b"first");
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn file_attachments_accept_files_larger_than_the_former_limit_locally_and_remotely() {
        let home = temp_home();
        let source = home.join("large.custom");
        let byte_length = 32 * 1024 * 1024 + 123;
        let mut file = fs::File::create(&source).unwrap();
        file.set_len(byte_length).unwrap();
        file.seek(SeekFrom::End(-4)).unwrap();
        file.write_all(b"\xffend").unwrap();
        drop(file);
        let path_source = FileAttachmentSource::Path {
            path: source.to_string_lossy().to_string(),
        };
        let local =
            stage_file_attachment_core(&home, request("thread-a", path_source.clone())).unwrap();
        let upload = file_attachment_source_for_remote(path_source).unwrap();
        let remote = stage_file_attachment_core(&home, request("thread-b", upload)).unwrap();
        let (digest, length) =
            copy_and_hash(&mut fs::File::open(&source).unwrap(), &mut std::io::sink()).unwrap();
        assert_eq!(length, byte_length);
        for staged in [local, remote] {
            assert_eq!(staged.byte_length, byte_length);
            assert!(snapshot_matches(Path::new(&staged.path), &digest, byte_length).unwrap());
        }
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn file_attachments_accept_unknown_formats_extensionless_and_empty_files() {
        let home = temp_home();
        for (name, bytes) in [
            ("unknown.custom", b"\x00\xff\xfe".as_slice()),
            ("extensionless", b"\x00\xff\xfe".as_slice()),
            ("empty", b"".as_slice()),
        ] {
            let staged = stage_file_attachment_core(
                &home,
                request(
                    "thread-a",
                    FileAttachmentSource::Data {
                        name: name.to_string(),
                        base64_data: BASE64_STANDARD.encode(bytes),
                    },
                ),
            )
            .unwrap();
            assert_eq!(staged.name, name);
            assert_eq!(fs::read(&staged.path).unwrap(), bytes);
        }
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn file_attachments_reject_missing_and_invalid_sources_without_partial_snapshots() {
        let home = temp_home();
        let outside = home.join("outside.pptx");
        fs::write(&outside, b"original").unwrap();
        for source in [
            FileAttachmentSource::Path {
                path: home.to_string_lossy().to_string(),
            },
            FileAttachmentSource::Path {
                path: home.join("missing.pdf").to_string_lossy().to_string(),
            },
            FileAttachmentSource::Data {
                name: "report.pdf".to_string(),
                base64_data: format!("{}!", "AAAA".repeat(100_000)),
            },
            FileAttachmentSource::Stored {
                path: outside.to_string_lossy().to_string(),
            },
        ] {
            assert!(stage_file_attachment_core(&home, request("thread-a", source)).is_err());
        }
        let directory = session_attachment_dir(&home, "thread-a").unwrap();
        assert_eq!(fs::read_dir(directory).unwrap().count(), 0);
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn file_attachments_do_not_overwrite_a_damaged_existing_snapshot() {
        let home = temp_home();
        let source = FileAttachmentSource::Data {
            name: "report.pdf".to_string(),
            base64_data: BASE64_STANDARD.encode(b"original"),
        };
        let staged =
            stage_file_attachment_core(&home, request("thread-a", source.clone())).unwrap();
        fs::write(&staged.path, b"changed").unwrap();
        let error = stage_file_attachment_core(&home, request("thread-a", source)).unwrap_err();
        assert!(error.contains("content does not match"));
        assert_eq!(fs::read(&staged.path).unwrap(), b"changed");
        let session = session_attachment_dir(&home, "thread-a").unwrap();
        assert!(fs::read_dir(session).unwrap().all(|entry| entry
            .unwrap()
            .file_type()
            .unwrap()
            .is_dir()));
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn file_attachments_keep_uploaded_names_inside_session_storage() {
        let home = temp_home();
        let staged = stage_file_attachment_core(
            &home,
            request(
                "thread-a",
                FileAttachmentSource::Data {
                    name: "../../outside/slides.pptx".to_string(),
                    base64_data: BASE64_STANDARD.encode(b"slides"),
                },
            ),
        )
        .unwrap();
        assert_eq!(staged.name, "slides.pptx");
        assert!(
            Path::new(&staged.path).starts_with(session_attachment_dir(&home, "thread-a").unwrap())
        );
        assert_eq!(safe_file_name("NUL.pdf"), "_NUL.pdf");
        assert_eq!(safe_file_name(".gitignore"), ".gitignore");
        assert_eq!(
            safe_file_name("\u{62a5}\u{544a} & notes.pdf"),
            "\u{62a5}\u{544a} & notes.pdf"
        );
        assert!(safe_file_name(&format!("{}.pptx", "x".repeat(300))).ends_with(".pptx"));
        let _ = fs::remove_dir_all(home);
    }
}
