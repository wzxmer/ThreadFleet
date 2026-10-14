use std::collections::HashSet;
use std::env;
use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use futures_util::{stream, StreamExt};
use tokio::io::AsyncReadExt;

use crate::shared::process_core::{kill_child_process_tree, tokio_command};
use crate::types::AgentCliCandidate;

const APP_IDENTIFIER: &str = "com.dimillian.codexmonitor";
const MAX_INSTALL_DIRECTORIES: usize = 64;
const MAX_DISCOVERED_CLIS: usize = 48;
const VERSION_PROBE_PARALLELISM: usize = 4;
const VERSION_PROBE_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_VERSION_OUTPUT_BYTES: u64 = 64 * 1024;

fn validate_engine(engine: &str) -> Result<&str, String> {
    match engine {
        "codex" | "gemini" => Ok(engine),
        _ => Err(format!("Unsupported agent engine: {engine}")),
    }
}

/// Matches Tauri's application data directory without requiring an AppHandle.
pub(crate) fn default_managed_root() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    let root = env::var_os("APPDATA").map(PathBuf::from);
    #[cfg(target_os = "macos")]
    let root = env::var_os("HOME")
        .map(PathBuf::from)
        .map(|home| home.join("Library/Application Support"));
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    let root = env::var_os("XDG_DATA_HOME")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(|| env::var_os("HOME").map(|home| PathBuf::from(home).join(".local/share")));
    root.map(|root| root.join(APP_IDENTIFIER).join("managed-codex"))
}

fn home_directory() -> Option<PathBuf> {
    env::var_os(if cfg!(target_os = "windows") {
        "USERPROFILE"
    } else {
        "HOME"
    })
    .or_else(|| env::var_os("HOME"))
    .map(PathBuf::from)
}

fn install_subdirectories(root: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(root) else {
        return Vec::new();
    };
    let mut directories: Vec<PathBuf> = entries
        .filter_map(Result::ok)
        .take(MAX_INSTALL_DIRECTORIES)
        .map(|entry| entry.path())
        .filter(|path| path.is_dir())
        .filter(|path| {
            !path
                .file_name()
                .is_some_and(|name| name.to_string_lossy().starts_with('.'))
        })
        .collect();
    directories.sort_by(|left, right| {
        let version = |path: &Path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .and_then(|name| semver::Version::parse(name.trim_start_matches('v')).ok())
        };
        version(right)
            .cmp(&version(left))
            .then_with(|| left.cmp(right))
    });
    directories
}

fn search_directories(path_env: Option<&OsStr>) -> Vec<PathBuf> {
    let inherited_path = env::var_os("PATH");
    let mut directories: Vec<PathBuf> = path_env
        .or(inherited_path.as_deref())
        .map(|value| {
            env::split_paths(value)
                .filter(|path| !path.as_os_str().is_empty())
                .collect()
        })
        .unwrap_or_default();

    for variable in ["NPM_CONFIG_PREFIX", "npm_config_prefix", "VOLTA_HOME"] {
        if let Some(root) = env::var_os(variable).filter(|root| !root.is_empty()) {
            let root = PathBuf::from(root);
            directories.push(root.join("bin"));
            directories.push(root);
        }
    }

    if let Some(home) = home_directory() {
        directories.extend([
            home.join(".local/bin"),
            home.join(".npm-global/bin"),
            home.join(".npm-global"),
            home.join("npm-global/bin"),
            home.join("npm-global"),
            home.join(".volta/bin"),
            home.join(".cargo/bin"),
            home.join(".bun/bin"),
            home.join(".local/share/mise/shims"),
        ]);
        directories.extend(
            install_subdirectories(&home.join(".nvm/versions/node"))
                .into_iter()
                .map(|root| root.join("bin")),
        );
        directories.extend(
            install_subdirectories(&home.join(".local/share/fnm/node-versions"))
                .into_iter()
                .map(|root| root.join("installation/bin")),
        );
        #[cfg(target_os = "windows")]
        directories.push(home.join("scoop/shims"));
    }

    #[cfg(target_os = "windows")]
    {
        if let Some(app_data) = env::var_os("APPDATA") {
            directories.push(PathBuf::from(app_data).join("npm"));
        }
        if let Some(local_data) = env::var_os("LOCALAPPDATA") {
            let root = PathBuf::from(local_data);
            directories.extend([root.join("Volta/bin"), root.join("Microsoft/WindowsApps")]);
            directories.extend(
                install_subdirectories(&root.join("fnm/node-versions"))
                    .into_iter()
                    .map(|root| root.join("installation")),
            );
        }
        for variable in ["ProgramFiles", "ProgramFiles(x86)"] {
            if let Some(program_files) = env::var_os(variable) {
                directories.push(PathBuf::from(program_files).join("nodejs"));
            }
        }
        if let Some(nvm_home) = env::var_os("NVM_HOME") {
            directories.extend(install_subdirectories(Path::new(&nvm_home)));
        }
        if let Some(program_data) = env::var_os("PROGRAMDATA") {
            directories.push(PathBuf::from(program_data).join("chocolatey/bin"));
        }
    }
    #[cfg(not(target_os = "windows"))]
    directories.extend(
        ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"]
            .into_iter()
            .map(PathBuf::from),
    );

    let mut seen = HashSet::new();
    directories.retain(|path| seen.insert(path_key(path)));
    directories
}

fn runtime_path_from_directories(
    selected: Option<&Path>,
    directories: &[PathBuf],
) -> Option<OsString> {
    let mut process_directories = Vec::new();
    if let Some(parent) = selected
        .and_then(Path::parent)
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        process_directories.push(parent.to_path_buf());
    }
    process_directories.extend(directories.iter().cloned());
    let mut seen = HashSet::new();
    process_directories.retain(|path| seen.insert(path_key(path)));
    if process_directories.is_empty() {
        return None;
    }
    env::join_paths(process_directories).ok()
}

/// Keeps CLI discovery, version probes, and real launches on the same Node/tool search path.
/// A selected installation's directory takes precedence over inherited Node versions.
pub(crate) fn build_cli_path_env(
    selected: Option<&Path>,
    path_env: Option<&OsStr>,
) -> Option<OsString> {
    runtime_path_from_directories(selected, &search_directories(path_env))
}

fn path_key(path: &Path) -> String {
    let path = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let key = path.to_string_lossy().into_owned();
    if cfg!(target_os = "windows") {
        key.to_lowercase()
    } else {
        key
    }
}

fn is_executable_file(path: &Path) -> bool {
    let Ok(metadata) = std::fs::metadata(path) else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        matches!(
            path.extension()
                .and_then(|extension| extension.to_str())
                .map(str::to_ascii_lowercase)
                .as_deref(),
            Some("exe" | "cmd" | "bat" | "com")
        )
    }
}

fn directory_executable(root: &Path, program: &str) -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    let names: Vec<String> = if Path::new(program).extension().is_some() {
        vec![program.to_string()]
    } else {
        ["exe", "cmd", "bat", "com"]
            .into_iter()
            .map(|extension| format!("{program}.{extension}"))
            .collect()
    };
    #[cfg(not(target_os = "windows"))]
    let names = vec![program.to_string()];
    names
        .into_iter()
        .map(|name| root.join(name))
        .find(|path| is_executable_file(path))
}

fn managed_directories(root: Option<&Path>) -> Vec<PathBuf> {
    let Some(root) = root else {
        return Vec::new();
    };
    let mut directories = vec![root.to_path_buf(), root.join("bin")];
    for installation in install_subdirectories(root) {
        directories.extend([installation.join("bin"), installation]);
    }
    directories
}

fn candidate_paths(
    engine: &str,
    directories: &[PathBuf],
    managed_root: Option<&Path>,
) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    let mut seen = HashSet::new();
    let managed = if engine == "codex" {
        managed_directories(managed_root)
    } else {
        Vec::new()
    };
    for directory in directories.iter().chain(managed.iter()) {
        if let Some(path) = directory_executable(directory, engine) {
            if seen.insert(path_key(&path)) {
                candidates.push(path);
            }
        }
        if candidates.len() >= MAX_DISCOVERED_CLIS {
            break;
        }
    }
    // Managed installs may already appear in PATH. Prefer a local install regardless of PATH order.
    candidates.sort_by(|left, right| {
        let left_managed = is_managed_path(left, managed_root);
        let right_managed = is_managed_path(right, managed_root);
        left_managed.cmp(&right_managed).then_with(|| {
            if left_managed && right_managed {
                managed_version(right, managed_root).cmp(&managed_version(left, managed_root))
            } else {
                std::cmp::Ordering::Equal
            }
        })
    });
    candidates
}

fn managed_version(path: &Path, managed_root: Option<&Path>) -> Option<semver::Version> {
    let root = managed_root?;
    let path = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let root = std::fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
    let relative = path.strip_prefix(root).ok()?;
    let directory = relative.components().next()?.as_os_str().to_str()?;
    semver::Version::parse(directory.trim_start_matches('v')).ok()
}

fn is_managed_path(path: &Path, managed_root: Option<&Path>) -> bool {
    let Some(root) = managed_root else {
        return false;
    };
    let path = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let root = std::fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
    path.starts_with(root)
}

fn configured_path(configured: &str, directories: &[PathBuf]) -> Result<PathBuf, String> {
    let trimmed = configured.trim();
    let unquoted = trimmed
        .strip_prefix('"')
        .and_then(|value| value.strip_suffix('"'))
        .unwrap_or(trimmed);
    let expanded = if let Some(relative) = unquoted
        .strip_prefix("~/")
        .or_else(|| unquoted.strip_prefix("~\\"))
    {
        home_directory().map(|home| home.join(relative))
    } else {
        None
    };
    let path = expanded.unwrap_or_else(|| PathBuf::from(unquoted));
    if path.components().count() > 1 || path.is_absolute() {
        if is_executable_file(&path) {
            return Ok(path);
        }
        #[cfg(target_os = "windows")]
        if path.extension().is_none() {
            if let Some(found) = path.parent().and_then(|parent| {
                path.file_name()
                    .and_then(|name| name.to_str())
                    .and_then(|name| directory_executable(parent, name))
            }) {
                return Ok(found);
            }
        }
    } else if let Some(found) = directories
        .iter()
        .find_map(|root| directory_executable(root, unquoted))
    {
        return Ok(found);
    }
    Err(format!(
        "Configured CLI is not an executable file: {configured}"
    ))
}

fn resolve_from_directories(
    engine: &str,
    configured: Option<&str>,
    directories: &[PathBuf],
    managed_root: Option<&Path>,
) -> Result<PathBuf, String> {
    if let Some(configured) = configured.filter(|value| !value.trim().is_empty()) {
        return configured_path(configured, directories);
    }
    candidate_paths(engine, directories, managed_root)
        .into_iter()
        .next()
        .ok_or_else(|| {
            format!(
                "{engine} CLI was not found. Install it or select its executable path in settings."
            )
        })
}

/// Resolves an explicit path or chooses a system install before a managed Codex fallback.
/// This function never starts a process or installs a package.
pub(crate) fn resolve_cli_path(
    engine: &str,
    configured: Option<&str>,
    path_env: Option<&OsStr>,
    managed_root: Option<&Path>,
) -> Result<PathBuf, String> {
    validate_engine(engine)?;
    let default_root = default_managed_root();
    let managed_root = managed_root.or(default_root.as_deref());
    resolve_from_directories(
        engine,
        configured,
        &search_directories(path_env),
        managed_root,
    )
}

fn version_command(path: &Path) -> Result<tokio::process::Command, String> {
    #[cfg(target_os = "windows")]
    if path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            extension.eq_ignore_ascii_case("cmd") || extension.eq_ignore_ascii_case("bat")
        })
    {
        let line = crate::shared::process_core::build_cmd_c_command(path, &["--version".into()])?;
        let mut command = tokio_command("cmd");
        command.args(["/D", "/S", "/C"]);
        command.raw_arg(line);
        return Ok(command);
    }
    let mut command = tokio_command(path);
    command.arg("--version");
    Ok(command)
}

fn parse_version(output: &str) -> Option<String> {
    let parse_token = |token: &str| {
        let token = token.trim_matches(|character: char| {
            !character.is_ascii_alphanumeric() && !matches!(character, '.' | '-' | '+')
        });
        semver::Version::parse(token.trim_start_matches('v'))
            .ok()
            .map(|version| version.to_string())
    };
    // Gemini prints a bare version; ignore unrelated versions in startup warnings.
    if let Some(version) = output.lines().find_map(|line| parse_token(line.trim())) {
        return Some(version);
    }
    output.lines().find_map(|line| {
        let line = line.trim();
        let first = line
            .split_whitespace()
            .next()?
            .trim_end_matches(':')
            .to_ascii_lowercase();
        if matches!(
            first.as_str(),
            "codex" | "codex-cli" | "gemini" | "gemini-cli" | "version"
        ) {
            line.split_whitespace().find_map(parse_token)
        } else {
            None
        }
    })
}

async fn probe_version(path: &Path, directories: &[PathBuf]) -> Result<String, String> {
    let mut command = version_command(path)?;
    if let Some(path_env) = runtime_path_from_directories(Some(path), directories) {
        command.env("PATH", path_env);
    }
    command.stdin(Stdio::null());
    command.stdout(Stdio::piped());
    command.stderr(Stdio::piped());
    command.kill_on_drop(true);
    let mut child = command.spawn().map_err(|error| error.to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or("CLI version probe has no stdout.")?;
    let stderr = child
        .stderr
        .take()
        .ok_or("CLI version probe has no stderr.")?;
    let probe = async {
        let mut stdout = stdout.take(MAX_VERSION_OUTPUT_BYTES);
        let mut stderr = stderr.take(MAX_VERSION_OUTPUT_BYTES);
        let mut stdout_bytes = Vec::new();
        let mut stderr_bytes = Vec::new();
        let (status, stdout_result, stderr_result) = futures_util::future::join3(
            child.wait(),
            stdout.read_to_end(&mut stdout_bytes),
            stderr.read_to_end(&mut stderr_bytes),
        )
        .await;
        let status = status.map_err(|error| error.to_string())?;
        stdout_result.map_err(|error| error.to_string())?;
        stderr_result.map_err(|error| error.to_string())?;
        if !status.success() {
            return Err(format!("CLI version command failed ({status})."));
        }
        let stdout = String::from_utf8_lossy(&stdout_bytes);
        let stderr = String::from_utf8_lossy(&stderr_bytes);
        parse_version(&stdout)
            .or_else(|| parse_version(&stderr))
            .ok_or_else(|| "CLI version command did not return a valid version.".to_string())
    };
    match tokio::time::timeout(VERSION_PROBE_TIMEOUT, probe).await {
        Ok(result) => result,
        Err(_) => {
            kill_child_process_tree(&mut child).await;
            Err("CLI version check timed out.".to_string())
        }
    }
}

pub(crate) async fn discover_agent_clis(
    engine: &str,
    configured: Option<&str>,
    managed_root: Option<&Path>,
) -> Result<Vec<AgentCliCandidate>, String> {
    validate_engine(engine)?;
    let default_root = default_managed_root();
    let managed_root = managed_root.or(default_root.as_deref());
    let directories = search_directories(None);
    let mut paths = candidate_paths(engine, &directories, managed_root);
    let mut missing_custom = None;
    if let Some(configured) = configured.filter(|value| !value.trim().is_empty()) {
        match configured_path(configured, &directories) {
            Ok(path)
                if !paths
                    .iter()
                    .any(|existing| path_key(existing) == path_key(&path)) =>
            {
                paths.push(path);
            }
            Err(error) => {
                missing_custom = Some(AgentCliCandidate {
                    engine: engine.to_string(),
                    path: configured.trim().to_string(),
                    version: None,
                    source: "custom".to_string(),
                    runnable: false,
                    error: Some(error),
                });
            }
            _ => {}
        }
    }
    let mut results: Vec<(usize, AgentCliCandidate)> = stream::iter(paths.into_iter().enumerate())
        .map(|(index, path)| {
            let source = if is_managed_path(&path, managed_root) {
                "managed"
            } else if directories.iter().any(|root| {
                path.parent()
                    .is_some_and(|parent| path_key(root) == path_key(parent))
            }) {
                "system"
            } else {
                "custom"
            };
            let directories = &directories;
            async move {
                let result = probe_version(&path, directories).await;
                let runnable = result.is_ok();
                let (version, error) = match result {
                    Ok(version) => (Some(version), None),
                    Err(error) => (None, Some(error)),
                };
                (
                    index,
                    AgentCliCandidate {
                        engine: engine.to_string(),
                        path: path.to_string_lossy().into_owned(),
                        version,
                        source: source.to_string(),
                        runnable,
                        error,
                    },
                )
            }
        })
        .buffer_unordered(VERSION_PROBE_PARALLELISM)
        .collect()
        .await;
    results.sort_by_key(|(index, _)| *index);
    let mut candidates: Vec<AgentCliCandidate> = results
        .into_iter()
        .map(|(_, candidate)| candidate)
        .collect();
    if let Some(candidate) = missing_custom {
        candidates.push(candidate);
    }
    Ok(candidates)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new() -> Self {
            let path = env::temp_dir().join(format!(
                "threadfleet-cli-discovery-{}",
                uuid::Uuid::new_v4()
            ));
            std::fs::create_dir_all(&path).unwrap();
            Self(path)
        }

        fn executable(&self, directory: &str, program: &str) -> PathBuf {
            let path = self.0.join(directory).join(program);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, b"cli").unwrap();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
            }
            path
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn program_name(engine: &str) -> String {
        if cfg!(windows) {
            format!("{engine}.exe")
        } else {
            engine.to_string()
        }
    }

    #[test]
    fn automatic_selection_prefers_system_even_when_managed_is_first_in_path() {
        let root = TestDirectory::new();
        let managed = root.executable("managed-codex/0.162.1/bin", &program_name("codex"));
        let system = root.executable("npm", &program_name("codex"));
        let directories = vec![
            managed.parent().unwrap().into(),
            system.parent().unwrap().into(),
        ];
        let managed_root = root.0.join("managed-codex");
        assert_eq!(
            resolve_from_directories("codex", None, &directories, Some(&managed_root)).unwrap(),
            system
        );
        assert_eq!(
            resolve_from_directories("codex", managed.to_str(), &directories, Some(&managed_root))
                .unwrap(),
            managed
        );
    }

    #[test]
    fn explicit_missing_path_reports_error_without_silent_fallback() {
        let root = TestDirectory::new();
        let system = root.executable("npm", &program_name("codex"));
        let directories = vec![system.parent().unwrap().into()];
        let missing = root.0.join(program_name("codex-missing"));
        assert!(resolve_from_directories("codex", missing.to_str(), &directories, None).is_err());
    }

    #[test]
    fn duplicate_directories_return_one_candidate() {
        let root = TestDirectory::new();
        let executable = root.executable("npm", &program_name("gemini"));
        let directory = executable.parent().unwrap().to_path_buf();
        assert_eq!(
            candidate_paths("gemini", &[directory.clone(), directory], None),
            vec![executable]
        );
    }

    #[test]
    fn runtime_path_prioritizes_selected_install_and_preserves_inherited_order() {
        let root = TestDirectory::new();
        let selected = root.executable("selected-node/bin", &program_name("codex"));
        let first = root.0.join("inherited-one");
        let second = root.0.join("inherited-two");
        let directories = vec![
            first.clone(),
            second.clone(),
            selected.parent().unwrap().into(),
            first.clone(),
        ];
        let path_env = runtime_path_from_directories(Some(&selected), &directories).unwrap();
        assert_eq!(
            env::split_paths(&path_env).collect::<Vec<_>>(),
            vec![selected.parent().unwrap().into(), first, second]
        );
    }

    #[test]
    fn public_runtime_path_preserves_supplied_path_before_known_install_directories() {
        let root = TestDirectory::new();
        let selected = root.executable("selected/bin", &program_name("gemini"));
        let first = root.0.join("custom-path-one");
        let second = root.0.join("custom-path-two");
        let inherited = env::join_paths([first.clone(), second.clone()]).unwrap();
        let path_env = build_cli_path_env(Some(&selected), Some(&inherited)).unwrap();
        let actual: Vec<PathBuf> = env::split_paths(&path_env).collect();
        assert_eq!(
            &actual[..3],
            &[selected.parent().unwrap().into(), first, second]
        );
    }

    #[test]
    fn managed_fallback_prefers_newest_version_and_ignores_staging() {
        let root = TestDirectory::new();
        let old = root.executable("managed-codex/0.158.0/bin", &program_name("codex"));
        let latest = root.executable("managed-codex/0.162.1/bin", &program_name("codex"));
        root.executable("managed-codex/.install-staging/bin", &program_name("codex"));
        assert_eq!(
            resolve_from_directories("codex", None, &[], Some(&root.0.join("managed-codex")))
                .unwrap(),
            latest
        );
        assert_eq!(
            resolve_from_directories(
                "codex",
                None,
                &[old.parent().unwrap().into()],
                Some(&root.0.join("managed-codex"))
            )
            .unwrap(),
            latest
        );
    }

    #[test]
    fn no_installation_returns_actionable_error_and_gemini_ignores_codex_managed_root() {
        let root = TestDirectory::new();
        root.executable("managed-codex/0.162.1/bin", &program_name("codex"));
        let error =
            resolve_from_directories("gemini", None, &[], Some(&root.0.join("managed-codex")))
                .unwrap_err();
        assert!(error.contains("Install it or select"));
        assert!(validate_engine("claude").is_err());
    }

    #[test]
    fn parses_codex_and_gemini_versions_without_confusing_warning_text() {
        assert_eq!(parse_version("codex-cli 0.162.1\n"), Some("0.162.1".into()));
        assert_eq!(
            parse_version("Warning: setting ignored\n0.30.0-preview.1\n"),
            Some("0.30.0-preview.1".into())
        );
        assert_eq!(
            parse_version("Warning: Node 20.0.0 is deprecated\n0.30.0\n"),
            Some("0.30.0".into())
        );
        assert_eq!(parse_version("not installed"), None);
    }

    #[test]
    fn version_probe_runs_executable_or_cmd_wrapper_from_path_with_spaces() {
        let root = TestDirectory::new();
        let program = if cfg!(windows) { "codex.cmd" } else { "codex" };
        let executable = root.executable("CLI install", program);
        let content = if cfg!(windows) {
            "@echo off\r\necho codex-cli 0.162.1\r\n"
        } else {
            "#!/bin/sh\nprintf 'codex-cli 0.162.1\\n'\n"
        };
        std::fs::write(&executable, content).unwrap();
        let version = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(probe_version(&executable, &search_directories(None)))
            .unwrap();
        assert_eq!(version, "0.162.1");
    }

    #[cfg(windows)]
    #[test]
    fn prefers_native_executable_and_excludes_powershell_wrappers() {
        let root = TestDirectory::new();
        let executable = root.executable("npm", "codex.exe");
        root.executable("npm", "codex.cmd");
        root.executable("npm", "codex.ps1");
        root.executable("powershell-only", "gemini.ps1");
        assert_eq!(
            candidate_paths("codex", &[root.0.join("npm")], None),
            vec![executable]
        );
        assert!(candidate_paths("gemini", &[root.0.join("powershell-only")], None).is_empty());
    }
}
