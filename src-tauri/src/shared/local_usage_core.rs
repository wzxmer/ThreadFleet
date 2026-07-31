use chrono::{DateTime, Datelike, Duration, Local, TimeZone, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::sync::Mutex;

use crate::codex::home::{resolve_default_codex_home, resolve_workspace_codex_home};
use crate::types::{
    LocalUsageDay, LocalUsageModel, LocalUsageSnapshot, LocalUsageSource, LocalUsageTotals,
    WorkspaceEntry,
};

#[derive(Default, Clone, Copy, Serialize, Deserialize)]
struct DailyTotals {
    input: i64,
    cached: i64,
    output: i64,
    agent_ms: i64,
    agent_runs: i64,
}

#[derive(Default, Clone, Copy)]
struct UsageTotals {
    input: i64,
    cached: i64,
    output: i64,
}

#[derive(Default, Serialize, Deserialize)]
struct LocalUsageIndex {
    version: u32,
    files: HashMap<String, CachedUsageFile>,
}

#[derive(Clone, Serialize, Deserialize)]
struct CachedUsageFile {
    modified_ms: i64,
    len: u64,
    cwd: Option<String>,
    daily: HashMap<String, DailyTotals>,
    model_totals: HashMap<String, i64>,
    source_totals: HashMap<String, i64>,
}

struct UsageFileScan {
    cache: CachedUsageFile,
    rolling_hour_tokens: i64,
}

#[derive(Clone, Copy)]
struct UsageFileMetadata {
    modified_ms: i64,
    len: u64,
}

const MAX_ACTIVITY_GAP_MS: i64 = 2 * 60 * 1000;
const ONE_HOUR_MS: i64 = 60 * 60 * 1000;
const LOCAL_USAGE_INDEX_VERSION: u32 = 1;
const LOCAL_USAGE_INDEX_FILE: &str = "local-usage-index-v1.json";

pub(crate) async fn local_usage_snapshot_core(
    workspaces: &Mutex<HashMap<String, WorkspaceEntry>>,
    data_dir: Option<PathBuf>,
    days: Option<u32>,
    workspace_path: Option<String>,
) -> Result<LocalUsageSnapshot, String> {
    let requested_days = days.unwrap_or(30).clamp(1, 90);
    let month_days = Local::now().day().max(1);
    let days = requested_days.max(month_days);
    let workspace_path = workspace_path.and_then(|value| {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(PathBuf::from(trimmed))
        }
    });
    let sessions_roots = {
        let workspaces = workspaces.lock().await;
        resolve_sessions_roots(&workspaces, workspace_path.as_deref())
    };
    let snapshot = tokio::task::spawn_blocking(move || {
        if let Some(data_dir) = data_dir {
            scan_local_usage_with_index(
                days,
                workspace_path.as_deref(),
                &sessions_roots,
                &data_dir.join(LOCAL_USAGE_INDEX_FILE),
            )
        } else {
            scan_local_usage(days, workspace_path.as_deref(), &sessions_roots)
        }
    })
    .await
    .map_err(|err| err.to_string())??;
    Ok(snapshot)
}

pub(crate) async fn thread_token_usage_core(
    workspaces: &Mutex<HashMap<String, WorkspaceEntry>>,
    workspace_id: String,
    thread_id: String,
) -> Option<Value> {
    let thread_id = thread_id.trim().to_string();
    if thread_id.is_empty() {
        return None;
    }
    let (workspace_path, sessions_roots) = {
        let workspaces = workspaces.lock().await;
        let workspace = workspaces.get(&workspace_id)?;
        let workspace_path = PathBuf::from(&workspace.path);
        let roots = resolve_sessions_roots(&workspaces, Some(&workspace_path));
        (workspace_path, roots)
    };
    tokio::task::spawn_blocking(move || {
        scan_thread_token_usage(&sessions_roots, &workspace_path, &thread_id)
    })
    .await
    .ok()
    .flatten()
}

fn scan_local_usage(
    days: u32,
    workspace_path: Option<&Path>,
    sessions_roots: &[PathBuf],
) -> Result<LocalUsageSnapshot, String> {
    let updated_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;

    let day_keys = make_day_keys(days);
    let mut daily: HashMap<String, DailyTotals> = day_keys
        .iter()
        .map(|key| (key.clone(), DailyTotals::default()))
        .collect();
    let mut model_totals: HashMap<String, i64> = HashMap::new();
    let mut source_totals: HashMap<String, i64> = HashMap::new();
    let mut rolling_hour_tokens = 0;
    let rolling_hour_start_ms = updated_at - ONE_HOUR_MS;

    if sessions_roots.is_empty() {
        return Ok(build_snapshot(
            updated_at,
            day_keys,
            daily,
            HashMap::new(),
            HashMap::new(),
            rolling_hour_tokens,
        ));
    }

    for root in sessions_roots {
        scan_usage_directory(
            root,
            &mut daily,
            &mut model_totals,
            &mut source_totals,
            &mut rolling_hour_tokens,
            rolling_hour_start_ms,
            workspace_path,
        )?;
        for day_key in &day_keys {
            let day_dir = day_dir_for_key(root, day_key);
            scan_usage_directory(
                &day_dir,
                &mut daily,
                &mut model_totals,
                &mut source_totals,
                &mut rolling_hour_tokens,
                rolling_hour_start_ms,
                workspace_path,
            )?;
        }
    }

    Ok(build_snapshot(
        updated_at,
        day_keys,
        daily,
        model_totals,
        source_totals,
        rolling_hour_tokens,
    ))
}

fn scan_local_usage_with_index(
    days: u32,
    workspace_path: Option<&Path>,
    sessions_roots: &[PathBuf],
    index_path: &Path,
) -> Result<LocalUsageSnapshot, String> {
    let updated_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;
    scan_local_usage_with_index_at(days, workspace_path, sessions_roots, index_path, updated_at)
}

fn scan_local_usage_with_index_at(
    days: u32,
    workspace_path: Option<&Path>,
    sessions_roots: &[PathBuf],
    index_path: &Path,
    updated_at: i64,
) -> Result<LocalUsageSnapshot, String> {
    let day_keys = make_day_keys(days);
    let mut daily: HashMap<String, DailyTotals> = day_keys
        .iter()
        .map(|key| (key.clone(), DailyTotals::default()))
        .collect();
    let mut model_totals: HashMap<String, i64> = HashMap::new();
    let mut source_totals: HashMap<String, i64> = HashMap::new();
    let mut rolling_hour_tokens = 0;
    let rolling_hour_start_ms = updated_at - ONE_HOUR_MS;

    if sessions_roots.is_empty() {
        return Ok(build_snapshot(
            updated_at,
            day_keys,
            daily,
            HashMap::new(),
            HashMap::new(),
            rolling_hour_tokens,
        ));
    }

    let cached_index = read_local_usage_index(index_path);
    let mut next_index = LocalUsageIndex {
        version: LOCAL_USAGE_INDEX_VERSION,
        files: HashMap::new(),
    };

    for path in collect_usage_files(days, sessions_roots) {
        let Some(metadata) = usage_file_metadata(&path) else {
            continue;
        };
        let cache_key = usage_file_cache_key(&path);
        let cached = cached_index.files.get(&cache_key);
        let use_cached = cached.is_some_and(|entry| {
            entry.modified_ms == metadata.modified_ms
                && entry.len == metadata.len
                && metadata.modified_ms < rolling_hour_start_ms
        });

        if use_cached {
            let entry = cached.expect("checked cached entry").clone();
            if cached_file_matches_workspace(&entry, workspace_path) {
                apply_cached_usage_file(&entry, &mut daily, &mut model_totals, &mut source_totals);
            }
            next_index.files.insert(cache_key, entry);
            continue;
        }

        let scan = scan_file_for_index(&path, rolling_hour_start_ms, metadata)?;
        if cached_file_matches_workspace(&scan.cache, workspace_path) {
            apply_cached_usage_file(
                &scan.cache,
                &mut daily,
                &mut model_totals,
                &mut source_totals,
            );
            rolling_hour_tokens += scan.rolling_hour_tokens;
        }
        next_index.files.insert(cache_key, scan.cache);
    }

    write_local_usage_index(index_path, &next_index);

    Ok(build_snapshot(
        updated_at,
        day_keys,
        daily,
        model_totals,
        source_totals,
        rolling_hour_tokens,
    ))
}

fn collect_usage_files(days: u32, sessions_roots: &[PathBuf]) -> Vec<PathBuf> {
    let day_keys = make_day_keys(days);
    let mut files = Vec::new();
    let mut seen = HashSet::new();

    for root in sessions_roots {
        collect_usage_files_in_directory(root, &mut files, &mut seen);
        for day_key in &day_keys {
            collect_usage_files_in_directory(
                &day_dir_for_key(root, day_key),
                &mut files,
                &mut seen,
            );
        }
    }

    files
}

fn collect_usage_files_in_directory(
    directory: &Path,
    files: &mut Vec<PathBuf>,
    seen: &mut HashSet<PathBuf>,
) {
    let Ok(entries) = std::fs::read_dir(directory) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|ext| ext.to_str()) != Some("jsonl") {
            continue;
        }
        if seen.insert(path.clone()) {
            files.push(path);
        }
    }
}

fn usage_file_metadata(path: &Path) -> Option<UsageFileMetadata> {
    let metadata = std::fs::metadata(path).ok()?;
    let modified_ms = metadata
        .modified()
        .ok()
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or_default();
    Some(UsageFileMetadata {
        modified_ms,
        len: metadata.len(),
    })
}

fn usage_file_cache_key(path: &Path) -> String {
    path.to_string_lossy().to_string()
}

fn read_local_usage_index(path: &Path) -> LocalUsageIndex {
    let Ok(data) = std::fs::read_to_string(path) else {
        return LocalUsageIndex::default();
    };
    let Ok(index) = serde_json::from_str::<LocalUsageIndex>(&data) else {
        return LocalUsageIndex::default();
    };
    if index.version == LOCAL_USAGE_INDEX_VERSION {
        index
    } else {
        LocalUsageIndex::default()
    }
}

fn write_local_usage_index(path: &Path, index: &LocalUsageIndex) {
    let Some(parent) = path.parent() else {
        return;
    };
    if std::fs::create_dir_all(parent).is_err() {
        return;
    }
    let Ok(data) = serde_json::to_string(index) else {
        return;
    };
    let _ = std::fs::write(path, data);
}

fn cached_file_matches_workspace(entry: &CachedUsageFile, workspace_path: Option<&Path>) -> bool {
    match workspace_path {
        Some(workspace_path) => entry
            .cwd
            .as_deref()
            .is_some_and(|cwd| path_matches_workspace(cwd, workspace_path)),
        None => true,
    }
}

fn apply_cached_usage_file(
    entry: &CachedUsageFile,
    daily: &mut HashMap<String, DailyTotals>,
    model_totals: &mut HashMap<String, i64>,
    source_totals: &mut HashMap<String, i64>,
) {
    for (day_key, totals) in &entry.daily {
        let Some(target) = daily.get_mut(day_key) else {
            continue;
        };
        target.input += totals.input;
        target.cached += totals.cached;
        target.output += totals.output;
        target.agent_ms += totals.agent_ms;
        target.agent_runs += totals.agent_runs;
    }
    for (model, tokens) in &entry.model_totals {
        *model_totals.entry(model.clone()).or_insert(0) += tokens;
    }
    for (source, tokens) in &entry.source_totals {
        *source_totals.entry(source.clone()).or_insert(0) += tokens;
    }
}

fn scan_file_for_index(
    path: &Path,
    rolling_hour_start_ms: i64,
    metadata: UsageFileMetadata,
) -> Result<UsageFileScan, String> {
    let day_keys = make_day_keys(90);
    let mut daily: HashMap<String, DailyTotals> = day_keys
        .iter()
        .map(|key| (key.clone(), DailyTotals::default()))
        .collect();
    let mut model_totals = HashMap::new();
    let mut source_totals = HashMap::new();
    let mut rolling_hour_tokens = 0;
    let mut cwd = None;

    scan_file_with_sources(
        path,
        &mut daily,
        &mut model_totals,
        &mut source_totals,
        &mut rolling_hour_tokens,
        rolling_hour_start_ms,
        None,
        Some(&mut cwd),
    )?;

    Ok(UsageFileScan {
        cache: CachedUsageFile {
            modified_ms: metadata.modified_ms,
            len: metadata.len,
            cwd,
            daily,
            model_totals,
            source_totals,
        },
        rolling_hour_tokens,
    })
}

fn build_snapshot(
    updated_at: i64,
    day_keys: Vec<String>,
    daily: HashMap<String, DailyTotals>,
    model_totals: HashMap<String, i64>,
    source_totals: HashMap<String, i64>,
    rolling_hour_tokens: i64,
) -> LocalUsageSnapshot {
    let mut days: Vec<LocalUsageDay> = Vec::with_capacity(day_keys.len());
    let mut total_tokens = 0;
    let month_start = Local::now().date_naive().with_day(1).unwrap_or_default();
    let mut month_tokens = 0;

    for day_key in &day_keys {
        let totals = daily.get(day_key).copied().unwrap_or_default();
        let total = totals.input + totals.output;
        total_tokens += total;
        if chrono::NaiveDate::parse_from_str(day_key, "%Y-%m-%d")
            .is_ok_and(|day| day >= month_start)
        {
            month_tokens += total;
        }
        days.push(LocalUsageDay {
            day: day_key.clone(),
            input_tokens: totals.input,
            cached_input_tokens: totals.cached,
            output_tokens: totals.output,
            total_tokens: total,
            agent_time_ms: totals.agent_ms,
            agent_runs: totals.agent_runs,
        });
    }

    let last7 = days.iter().rev().take(7).cloned().collect::<Vec<_>>();
    let last7_tokens: i64 = last7.iter().map(|day| day.total_tokens).sum();
    let last7_input: i64 = last7.iter().map(|day| day.input_tokens).sum();
    let last7_cached: i64 = last7.iter().map(|day| day.cached_input_tokens).sum();
    let last30_tokens: i64 = days.iter().rev().take(30).map(|day| day.total_tokens).sum();

    let average_daily_tokens = if last7.is_empty() {
        0
    } else {
        ((last7_tokens as f64) / (last7.len() as f64)).round() as i64
    };

    let cache_hit_rate_percent = if last7_input > 0 {
        ((last7_cached as f64) / (last7_input as f64) * 1000.0).round() / 10.0
    } else {
        0.0
    };

    let peak = days
        .iter()
        .max_by_key(|day| day.total_tokens)
        .filter(|day| day.total_tokens > 0);
    let peak_day = peak.map(|day| day.day.clone());
    let peak_day_tokens = peak.map(|day| day.total_tokens).unwrap_or(0);

    let mut top_models: Vec<LocalUsageModel> = model_totals
        .into_iter()
        .filter(|(model, tokens)| model != "unknown" && *tokens > 0)
        .map(|(model, tokens)| LocalUsageModel {
            model,
            tokens,
            share_percent: if total_tokens > 0 {
                ((tokens as f64) / (total_tokens as f64) * 1000.0).round() / 10.0
            } else {
                0.0
            },
        })
        .collect();
    top_models.sort_by(|a, b| b.tokens.cmp(&a.tokens));
    top_models.truncate(4);

    let mut top_sources: Vec<LocalUsageSource> = source_totals
        .into_iter()
        .filter(|(_, tokens)| *tokens > 0)
        .map(|(source, tokens)| LocalUsageSource {
            source,
            tokens,
            share_percent: if total_tokens > 0 {
                ((tokens as f64) / (total_tokens as f64) * 1000.0).round() / 10.0
            } else {
                0.0
            },
        })
        .collect();
    top_sources.sort_by(|a, b| b.tokens.cmp(&a.tokens));
    top_sources.truncate(4);

    LocalUsageSnapshot {
        updated_at,
        days,
        totals: LocalUsageTotals {
            last_hour_tokens: rolling_hour_tokens,
            last7_days_tokens: last7_tokens,
            last30_days_tokens: last30_tokens,
            month_tokens,
            average_daily_tokens,
            cache_hit_rate_percent,
            peak_day,
            peak_day_tokens,
        },
        top_models,
        top_sources,
    }
}

fn scan_usage_directory(
    directory: &Path,
    daily: &mut HashMap<String, DailyTotals>,
    model_totals: &mut HashMap<String, i64>,
    source_totals: &mut HashMap<String, i64>,
    rolling_hour_tokens: &mut i64,
    rolling_hour_start_ms: i64,
    workspace_path: Option<&Path>,
) -> Result<(), String> {
    let entries = match std::fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(_) => return Ok(()),
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|ext| ext.to_str()) != Some("jsonl") {
            continue;
        }
        scan_file_with_sources(
            &path,
            daily,
            model_totals,
            source_totals,
            rolling_hour_tokens,
            rolling_hour_start_ms,
            workspace_path,
            None,
        )?;
    }
    Ok(())
}

#[cfg(test)]
fn scan_file(
    path: &Path,
    daily: &mut HashMap<String, DailyTotals>,
    model_totals: &mut HashMap<String, i64>,
    rolling_hour_tokens: &mut i64,
    rolling_hour_start_ms: i64,
    workspace_path: Option<&Path>,
) -> Result<(), String> {
    scan_file_with_sources(
        path,
        daily,
        model_totals,
        &mut HashMap::new(),
        rolling_hour_tokens,
        rolling_hour_start_ms,
        workspace_path,
        None,
    )
}

fn scan_file_with_sources(
    path: &Path,
    daily: &mut HashMap<String, DailyTotals>,
    model_totals: &mut HashMap<String, i64>,
    source_totals: &mut HashMap<String, i64>,
    rolling_hour_tokens: &mut i64,
    rolling_hour_start_ms: i64,
    workspace_path: Option<&Path>,
    mut observed_cwd: Option<&mut Option<String>>,
) -> Result<(), String> {
    let file = match File::open(path) {
        Ok(file) => file,
        Err(_) => {
            return Ok(());
        }
    };
    let reader = BufReader::new(file);
    let mut previous_totals: Option<UsageTotals> = None;
    let mut current_model: Option<String> = None;
    let mut current_source = "unknown".to_string();
    let mut last_activity_ms: Option<i64> = None;
    let mut seen_runs: HashSet<i64> = HashSet::new();
    let mut match_known = workspace_path.is_none();
    let mut matches_workspace = workspace_path.is_none();

    for line in reader.lines() {
        let line = match line {
            Ok(line) => line,
            Err(_) => continue,
        };
        if line.len() > 512_000 {
            continue;
        }

        let value = match serde_json::from_str::<Value>(&line) {
            Ok(value) => value,
            Err(_) => continue,
        };
        let entry_type = value
            .get("type")
            .and_then(|value| value.as_str())
            .unwrap_or("");

        if entry_type == "session_meta" || entry_type == "turn_context" {
            if let Some(cwd) = extract_cwd(&value) {
                if let Some(cwd_slot) = observed_cwd.as_deref_mut() {
                    if cwd_slot.is_none() {
                        *cwd_slot = Some(cwd.clone());
                    }
                }
                if let Some(filter) = workspace_path {
                    matches_workspace = path_matches_workspace(&cwd, filter);
                    match_known = true;
                    if !matches_workspace {
                        break;
                    }
                }
            }
        }

        if entry_type == "session_meta" {
            if let Some(source) = value
                .get("model_provider")
                .and_then(Value::as_str)
                .or_else(|| {
                    value
                        .get("payload")
                        .and_then(|payload| payload.get("model_provider"))
                        .and_then(Value::as_str)
                })
                .filter(|source| !source.trim().is_empty())
            {
                current_source = source.to_string();
            }
        }

        if entry_type == "turn_context" {
            if let Some(model) = extract_model_from_turn_context(&value) {
                current_model = Some(model);
            }
            continue;
        }

        if entry_type == "session_meta" {
            continue;
        }

        if !matches_workspace {
            if match_known {
                break;
            }
            continue;
        }

        if !match_known {
            continue;
        }

        if entry_type == "event_msg" || entry_type.is_empty() {
            let payload = value.get("payload").and_then(|value| value.as_object());
            let payload_type = payload
                .and_then(|payload| payload.get("type"))
                .and_then(|value| value.as_str());

            if payload_type == Some("agent_message") {
                if let Some(timestamp_ms) = read_timestamp_ms(&value) {
                    if seen_runs.insert(timestamp_ms) {
                        if let Some(day_key) = day_key_for_timestamp_ms(timestamp_ms) {
                            if let Some(entry) = daily.get_mut(&day_key) {
                                entry.agent_runs += 1;
                            }
                        }
                    }
                    track_activity(daily, &mut last_activity_ms, timestamp_ms);
                }
                continue;
            }

            if payload_type == Some("agent_reasoning") {
                if let Some(timestamp_ms) = read_timestamp_ms(&value) {
                    track_activity(daily, &mut last_activity_ms, timestamp_ms);
                }
                continue;
            }

            if payload_type != Some("token_count") {
                continue;
            }

            let info = payload
                .and_then(|payload| payload.get("info"))
                .and_then(|v| v.as_object());
            let (input, cached, output, used_total) = if let Some(info) = info {
                if let Some(total) = find_usage_map(info, &["total_token_usage", "totalTokenUsage"])
                {
                    (
                        read_i64(total, &["input_tokens", "inputTokens"]),
                        read_i64(
                            total,
                            &[
                                "cached_input_tokens",
                                "cache_read_input_tokens",
                                "cachedInputTokens",
                                "cacheReadInputTokens",
                            ],
                        ),
                        read_i64(total, &["output_tokens", "outputTokens"]),
                        true,
                    )
                } else if let Some(last) =
                    find_usage_map(info, &["last_token_usage", "lastTokenUsage"])
                {
                    (
                        read_i64(last, &["input_tokens", "inputTokens"]),
                        read_i64(
                            last,
                            &[
                                "cached_input_tokens",
                                "cache_read_input_tokens",
                                "cachedInputTokens",
                                "cacheReadInputTokens",
                            ],
                        ),
                        read_i64(last, &["output_tokens", "outputTokens"]),
                        false,
                    )
                } else {
                    continue;
                }
            } else {
                continue;
            };

            let mut delta = UsageTotals {
                input,
                cached,
                output,
            };

            if used_total {
                let prev = previous_totals.unwrap_or_default();
                delta = UsageTotals {
                    input: (input - prev.input).max(0),
                    cached: (cached - prev.cached).max(0),
                    output: (output - prev.output).max(0),
                };
                previous_totals = Some(UsageTotals {
                    input,
                    cached,
                    output,
                });
            } else {
                // Some streams emit `last_token_usage` deltas between `total_token_usage` snapshots.
                // Treat those as already-counted to avoid double-counting when the next total arrives.
                let mut next = previous_totals.unwrap_or_default();
                next.input += delta.input;
                next.cached += delta.cached;
                next.output += delta.output;
                previous_totals = Some(next);
            }

            if delta.input == 0 && delta.cached == 0 && delta.output == 0 {
                continue;
            }

            let timestamp_ms = read_timestamp_ms(&value);
            if let Some(day_key) = timestamp_ms.and_then(|ms| day_key_for_timestamp_ms(ms)) {
                if let Some(entry) = daily.get_mut(&day_key) {
                    let cached = delta.cached.min(delta.input);
                    entry.input += delta.input;
                    entry.cached += cached;
                    entry.output += delta.output;
                    if timestamp_ms.is_some_and(|ms| ms >= rolling_hour_start_ms) {
                        *rolling_hour_tokens += delta.input + delta.output;
                    }

                    let model = current_model
                        .clone()
                        .or_else(|| extract_model_from_token_count(&value))
                        .unwrap_or_else(|| "unknown".to_string());
                    *model_totals.entry(model).or_insert(0) += delta.input + delta.output;
                    *source_totals.entry(current_source.clone()).or_insert(0) +=
                        delta.input + delta.output;
                }
            }

            if let Some(timestamp_ms) = timestamp_ms {
                track_activity(daily, &mut last_activity_ms, timestamp_ms);
            }
            continue;
        }

        if entry_type == "response_item" {
            let payload = value.get("payload").and_then(|value| value.as_object());
            let payload_type = payload
                .and_then(|payload| payload.get("type"))
                .and_then(|value| value.as_str());
            let role = payload
                .and_then(|payload| payload.get("role"))
                .and_then(|value| value.as_str())
                .unwrap_or("");

            if role == "assistant" {
                if let Some(timestamp_ms) = read_timestamp_ms(&value) {
                    if seen_runs.insert(timestamp_ms) {
                        if let Some(day_key) = day_key_for_timestamp_ms(timestamp_ms) {
                            if let Some(entry) = daily.get_mut(&day_key) {
                                entry.agent_runs += 1;
                            }
                        }
                    }
                    track_activity(daily, &mut last_activity_ms, timestamp_ms);
                }
            } else if payload_type != Some("message") {
                if let Some(timestamp_ms) = read_timestamp_ms(&value) {
                    track_activity(daily, &mut last_activity_ms, timestamp_ms);
                }
            }
        }
    }

    Ok(())
}

fn scan_thread_token_usage(
    sessions_roots: &[PathBuf],
    workspace_path: &Path,
    thread_id: &str,
) -> Option<Value> {
    let mut latest: Option<(i64, Value)> = None;
    for root in sessions_roots {
        let Ok(years) = std::fs::read_dir(root) else {
            continue;
        };
        for year in years.flatten() {
            let year_path = year.path();
            if year_path.extension().and_then(|ext| ext.to_str()) == Some("jsonl") {
                update_latest_thread_token_usage(
                    &mut latest,
                    &year_path,
                    workspace_path,
                    thread_id,
                );
                continue;
            }
            let Ok(months) = std::fs::read_dir(year_path) else {
                continue;
            };
            for month in months.flatten() {
                let Ok(days) = std::fs::read_dir(month.path()) else {
                    continue;
                };
                for day in days.flatten() {
                    let Ok(files) = std::fs::read_dir(day.path()) else {
                        continue;
                    };
                    for file in files.flatten() {
                        let path = file.path();
                        update_latest_thread_token_usage(
                            &mut latest,
                            &path,
                            workspace_path,
                            thread_id,
                        );
                    }
                }
            }
        }
    }
    latest.map(|(_, usage)| usage)
}

fn update_latest_thread_token_usage(
    latest: &mut Option<(i64, Value)>,
    path: &Path,
    workspace_path: &Path,
    thread_id: &str,
) {
    if path.extension().and_then(|ext| ext.to_str()) != Some("jsonl") {
        return;
    }
    let Some((observed_at_ms, usage)) =
        read_thread_token_usage_file_with_timestamp(path, workspace_path, thread_id)
    else {
        return;
    };
    if latest
        .as_ref()
        .is_none_or(|(latest_at_ms, _)| observed_at_ms >= *latest_at_ms)
    {
        *latest = Some((observed_at_ms, usage));
    }
}

#[cfg(test)]
fn read_thread_token_usage_file(
    path: &Path,
    workspace_path: &Path,
    thread_id: &str,
) -> Option<Value> {
    read_thread_token_usage_file_with_timestamp(path, workspace_path, thread_id)
        .map(|(_, usage)| usage)
}

fn read_thread_token_usage_file_with_timestamp(
    path: &Path,
    workspace_path: &Path,
    thread_id: &str,
) -> Option<(i64, Value)> {
    let file = File::open(path).ok()?;
    let reader = BufReader::new(file);
    let mut owns_thread = false;
    let mut owns_workspace = false;
    let mut total: Option<serde_json::Map<String, Value>> = None;
    let mut last: Option<serde_json::Map<String, Value>> = None;
    let mut model_context_window: Option<Value> = None;
    let mut latest_token_timestamp_ms: Option<i64> = None;

    for line in reader.lines().map_while(Result::ok) {
        if line.len() > 512_000 {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let entry_type = value.get("type").and_then(Value::as_str).unwrap_or("");
        if entry_type == "session_meta" {
            let Some(payload) = value.get("payload").and_then(Value::as_object) else {
                continue;
            };
            let id = payload
                .get("id")
                .or_else(|| payload.get("session_id"))
                .and_then(Value::as_str);
            owns_thread = id == Some(thread_id);
            owns_workspace = payload
                .get("cwd")
                .and_then(Value::as_str)
                .is_some_and(|cwd| path_matches_workspace(cwd, workspace_path));
            if !owns_thread || !owns_workspace {
                return None;
            }
            continue;
        }
        if !owns_thread || !owns_workspace || entry_type != "event_msg" {
            continue;
        }
        let Some(payload) = value.get("payload").and_then(Value::as_object) else {
            continue;
        };
        if payload.get("type").and_then(Value::as_str) != Some("token_count") {
            continue;
        }
        let Some(info) = payload.get("info").and_then(Value::as_object) else {
            continue;
        };
        let mut has_usage_snapshot = false;
        if let Some(map) = find_usage_map(info, &["total_token_usage", "totalTokenUsage"]) {
            total = Some(map.clone());
            has_usage_snapshot = true;
        }
        if let Some(map) = find_usage_map(info, &["last_token_usage", "lastTokenUsage"]) {
            last = Some(map.clone());
            has_usage_snapshot = true;
        }
        model_context_window = info
            .get("model_context_window")
            .or_else(|| info.get("modelContextWindow"))
            .cloned()
            .or(model_context_window);
        if has_usage_snapshot {
            if let Some(timestamp_ms) = read_timestamp_ms(&value) {
                latest_token_timestamp_ms = Some(
                    latest_token_timestamp_ms
                        .map_or(timestamp_ms, |current| current.max(timestamp_ms)),
                );
            }
        }
    }

    let last = last?;
    let mut usage = serde_json::Map::new();
    usage.insert("last".to_string(), Value::Object(last));
    if let Some(total) = total {
        usage.insert("total".to_string(), Value::Object(total));
    }
    if let Some(window) = model_context_window {
        usage.insert("model_context_window".to_string(), window);
    }
    Some((
        latest_token_timestamp_ms.unwrap_or_default(),
        Value::Object(usage),
    ))
}

fn extract_model_from_turn_context(value: &Value) -> Option<String> {
    let payload = value.get("payload").and_then(|value| value.as_object())?;
    if let Some(model) = payload.get("model").and_then(|value| value.as_str()) {
        return Some(model.to_string());
    }
    let info = payload.get("info").and_then(|value| value.as_object())?;
    info.get("model")
        .and_then(|value| value.as_str())
        .map(|value| value.to_string())
}

fn extract_model_from_token_count(value: &Value) -> Option<String> {
    let payload = value.get("payload").and_then(|value| value.as_object())?;
    let info = payload.get("info").and_then(|value| value.as_object());
    let model = info
        .and_then(|info| {
            info.get("model")
                .or_else(|| info.get("model_name"))
                .and_then(|value| value.as_str())
        })
        .or_else(|| payload.get("model").and_then(|value| value.as_str()))
        .or_else(|| value.get("model").and_then(|value| value.as_str()));
    model.map(|value| value.to_string())
}

fn find_usage_map<'a>(
    info: &'a serde_json::Map<String, Value>,
    keys: &[&str],
) -> Option<&'a serde_json::Map<String, Value>> {
    keys.iter()
        .find_map(|key| info.get(*key).and_then(|value| value.as_object()))
}

fn read_i64(map: &serde_json::Map<String, Value>, keys: &[&str]) -> i64 {
    keys.iter()
        .find_map(|key| map.get(*key))
        .and_then(|value| {
            value
                .as_i64()
                .or_else(|| value.as_f64().map(|value| value as i64))
        })
        .unwrap_or(0)
}

fn read_timestamp_ms(value: &Value) -> Option<i64> {
    let raw = value.get("timestamp")?;
    if let Some(text) = raw.as_str() {
        return DateTime::parse_from_rfc3339(text)
            .map(|value| value.timestamp_millis())
            .ok();
    }
    let numeric = raw
        .as_i64()
        .or_else(|| raw.as_f64().map(|value| value as i64))?;
    if numeric > 0 && numeric < 1_000_000_000_000 {
        return Some(numeric * 1000);
    }
    Some(numeric)
}

fn track_activity(
    daily: &mut HashMap<String, DailyTotals>,
    last_activity_ms: &mut Option<i64>,
    timestamp_ms: i64,
) {
    if let Some(prev_ms) = *last_activity_ms {
        let delta = timestamp_ms - prev_ms;
        if delta > 0 && delta <= MAX_ACTIVITY_GAP_MS {
            if let Some(day_key) = day_key_for_timestamp_ms(timestamp_ms) {
                if let Some(entry) = daily.get_mut(&day_key) {
                    entry.agent_ms += delta;
                }
            }
        }
    }
    *last_activity_ms = Some(timestamp_ms);
}

fn day_key_for_timestamp_ms(timestamp_ms: i64) -> Option<String> {
    let utc = Utc.timestamp_millis_opt(timestamp_ms).single()?;
    Some(utc.with_timezone(&Local).format("%Y-%m-%d").to_string())
}

fn extract_cwd(value: &Value) -> Option<String> {
    value
        .get("payload")
        .and_then(|payload| payload.get("cwd"))
        .and_then(|cwd| cwd.as_str())
        .map(|cwd| cwd.to_string())
}

fn path_matches_workspace(cwd: &str, workspace_path: &Path) -> bool {
    let cwd_path = Path::new(cwd);
    cwd_path == workspace_path || cwd_path.starts_with(workspace_path)
}

fn make_day_keys(days: u32) -> Vec<String> {
    let today = Local::now().date_naive();
    (0..days)
        .rev()
        .map(|offset| {
            let day = today - Duration::days(offset as i64);
            day.format("%Y-%m-%d").to_string()
        })
        .collect()
}

fn resolve_codex_sessions_roots(codex_home_override: Option<PathBuf>) -> Vec<PathBuf> {
    codex_home_override
        .or_else(resolve_default_codex_home)
        .map(|home| vec![home.join("sessions"), home.join("archived_sessions")])
        .unwrap_or_default()
}

fn resolve_sessions_roots(
    workspaces: &HashMap<String, WorkspaceEntry>,
    workspace_path: Option<&Path>,
) -> Vec<PathBuf> {
    if let Some(workspace_path) = workspace_path {
        let codex_home_override =
            resolve_workspace_codex_home_for_path(workspaces, Some(workspace_path));
        return resolve_codex_sessions_roots(codex_home_override);
    }

    let mut roots = Vec::new();
    let mut seen = HashSet::new();

    for root in resolve_codex_sessions_roots(None) {
        if seen.insert(root.clone()) {
            roots.push(root);
        }
    }

    for entry in workspaces.values() {
        let parent_entry = entry
            .parent_id
            .as_ref()
            .and_then(|parent_id| workspaces.get(parent_id));
        let Some(codex_home) = resolve_workspace_codex_home(entry, parent_entry) else {
            continue;
        };
        for root in resolve_codex_sessions_roots(Some(codex_home)) {
            if seen.insert(root.clone()) {
                roots.push(root);
            }
        }
    }

    roots
}

fn resolve_workspace_codex_home_for_path(
    workspaces: &HashMap<String, crate::types::WorkspaceEntry>,
    workspace_path: Option<&Path>,
) -> Option<PathBuf> {
    let workspace_path = workspace_path?;
    let entry = workspaces
        .values()
        .filter(|entry| {
            let entry_path = Path::new(&entry.path);
            workspace_path == entry_path || workspace_path.starts_with(entry_path)
        })
        .max_by_key(|entry| entry.path.len())?;

    let parent_entry = entry
        .parent_id
        .as_ref()
        .and_then(|parent_id| workspaces.get(parent_id));

    resolve_workspace_codex_home(entry, parent_entry)
}

fn day_dir_for_key(root: &Path, day_key: &str) -> PathBuf {
    let mut parts = day_key.split('-');
    let year = parts.next().unwrap_or("1970");
    let month = parts.next().unwrap_or("01");
    let day = parts.next().unwrap_or("01");
    root.join(year).join(month).join(day)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{WorkspaceKind, WorkspaceSettings};
    use chrono::NaiveDateTime;
    use std::io::Write;
    use std::path::Path;
    use std::{fs, path::PathBuf};
    use uuid::Uuid;

    fn write_temp_jsonl(lines: &[&str]) -> PathBuf {
        let mut path = std::env::temp_dir();
        path.push(format!(
            "codexmonitor-local-usage-test-{}.jsonl",
            Uuid::new_v4()
        ));
        let mut file = File::create(&path).expect("create temp jsonl");
        for line in lines {
            writeln!(file, "{line}").expect("write jsonl line");
        }
        path
    }

    fn make_temp_sessions_root() -> PathBuf {
        let mut root = std::env::temp_dir();
        root.push(format!("codexmonitor-local-usage-root-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).expect("create temp root");
        root
    }

    fn write_session_file(root: &Path, day_key: &str, lines: &[String]) -> PathBuf {
        let day_dir = day_dir_for_key(root, day_key);
        fs::create_dir_all(&day_dir).expect("create day dir");
        let path = day_dir.join(format!("usage-{}.jsonl", Uuid::new_v4()));
        let mut file = File::create(&path).expect("create session jsonl");
        for line in lines {
            writeln!(file, "{line}").expect("write jsonl line");
        }
        path
    }

    #[test]
    fn scan_file_does_not_double_count_last_and_total_usage() {
        let day_key = "2026-01-19";
        let path = write_temp_jsonl(&[
            r#"{"timestamp":"2026-01-19T12:00:00.000Z","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":10,"cached_input_tokens":0,"output_tokens":5}}}}"#,
            r#"{"timestamp":"2026-01-19T12:00:01.000Z","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":10,"cached_input_tokens":0,"output_tokens":5}}}}"#,
        ]);

        let mut daily: HashMap<String, DailyTotals> = HashMap::new();
        daily.insert(day_key.to_string(), DailyTotals::default());
        let mut model_totals: HashMap<String, i64> = HashMap::new();
        let mut rolling_hour_tokens = 0;
        scan_file(
            &path,
            &mut daily,
            &mut model_totals,
            &mut rolling_hour_tokens,
            0,
            None,
        )
        .expect("scan file");

        let totals = daily.get(day_key).copied().unwrap_or_default();
        assert_eq!(totals.input, 10);
        assert_eq!(totals.output, 5);
    }

    #[test]
    fn scan_local_usage_includes_flat_archived_sessions() {
        let codex_home = make_temp_sessions_root();
        let archived_root = codex_home.join("archived_sessions");
        fs::create_dir_all(&archived_root).expect("create archived root");
        let archived_path = archived_root.join("rollout-thread-archived.jsonl");
        let mut archived_file = File::create(&archived_path).expect("create archived session");
        writeln!(
            archived_file,
            "{}",
            r#"{"type":"session_meta","payload":{"id":"thread-archived","cwd":"/repo","model_provider":"provider-archived"}}"#
        )
        .expect("write archived metadata");
        writeln!(
            archived_file,
            "{}",
            format!(
                r#"{{"timestamp":"{}","type":"event_msg","payload":{{"type":"token_count","info":{{"last_token_usage":{{"input_tokens":40,"output_tokens":10}}}}}}}}"#,
                Utc::now().to_rfc3339()
            )
        )
        .expect("write archived token usage");

        let snapshot =
            scan_local_usage(30, None, &[archived_root]).expect("scan archived local usage");

        assert_eq!(snapshot.totals.last30_days_tokens, 50);
        assert_eq!(snapshot.top_sources.len(), 1);
        assert_eq!(snapshot.top_sources[0].source, "provider-archived");
        assert_eq!(snapshot.top_sources[0].tokens, 50);

        let _ = fs::remove_file(archived_path);
        let _ = fs::remove_dir_all(codex_home);
    }

    #[test]
    fn build_snapshot_limits_last30_total_to_thirty_days() {
        let day_keys = make_day_keys(31);
        let daily = day_keys
            .iter()
            .map(|day| {
                (
                    day.clone(),
                    DailyTotals {
                        input: 1,
                        ..DailyTotals::default()
                    },
                )
            })
            .collect();

        let snapshot = build_snapshot(0, day_keys, daily, HashMap::new(), HashMap::new(), 0);

        assert_eq!(snapshot.days.len(), 31);
        assert_eq!(snapshot.totals.last30_days_tokens, 30);
    }

    #[test]
    fn thread_usage_requires_matching_session_and_workspace() {
        let path = write_temp_jsonl(&[
            r#"{"type":"session_meta","payload":{"id":"thread-usage","cwd":"/repo"}}"#,
            r#"{"type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":10,"output_tokens":5},"total_token_usage":{"input_tokens":100,"output_tokens":50},"model_context_window":1000}}}"#,
        ]);

        let usage = read_thread_token_usage_file(&path, Path::new("/repo"), "thread-usage")
            .expect("matching usage");
        assert_eq!(usage["last"]["input_tokens"], 10);
        assert_eq!(usage["total"]["output_tokens"], 50);
        assert_eq!(usage["model_context_window"], 1000);
        assert!(read_thread_token_usage_file(&path, Path::new("/other"), "thread-usage").is_none());
        assert!(read_thread_token_usage_file(&path, Path::new("/repo"), "other-thread").is_none());

        let _ = fs::remove_file(path);
    }

    #[test]
    fn thread_usage_prefers_latest_snapshot_across_session_roots() {
        let codex_home = make_temp_sessions_root();
        let active_root = codex_home.join("sessions");
        let archived_root = codex_home.join("archived_sessions");
        let active_path = write_session_file(
            &active_root,
            "2026-01-20",
            &[
                r#"{"type":"session_meta","payload":{"id":"thread-duplicate","cwd":"/repo"}}"#.to_string(),
                r#"{"timestamp":"2026-01-20T11:00:00.000Z","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":10,"output_tokens":5},"model_context_window":1000}}}"#.to_string(),
            ],
        );
        fs::create_dir_all(&archived_root).expect("create archived root");
        let archived_path = archived_root.join("rollout-2026-01-20-thread-duplicate.jsonl");
        let mut archived_file = File::create(&archived_path).expect("create archived session");
        writeln!(
            archived_file,
            "{}",
            r#"{"type":"session_meta","payload":{"id":"thread-duplicate","cwd":"/repo"}}"#
        )
        .expect("write archived metadata");
        writeln!(
            archived_file,
            "{}",
            r#"{"timestamp":"2026-01-20T12:00:00.000Z","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":20,"output_tokens":5},"model_context_window":1000}}}"#
        )
        .expect("write archived token usage");

        let usage = scan_thread_token_usage(
            &[active_root.clone(), archived_root.clone()],
            Path::new("/repo"),
            "thread-duplicate",
        )
        .expect("latest usage snapshot");
        assert_eq!(usage["last"]["input_tokens"], 20);

        let _ = fs::remove_file(active_path);
        let _ = fs::remove_file(archived_path);
        let _ = fs::remove_dir_all(codex_home);
    }

    #[test]
    fn scan_file_counts_last_deltas_before_total_snapshot_once() {
        let day_key = "2026-01-19";
        let path = write_temp_jsonl(&[
            r#"{"timestamp":"2026-01-19T12:00:00.000Z","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":10,"cached_input_tokens":0,"output_tokens":5}}}}"#,
            r#"{"timestamp":"2026-01-19T12:00:01.000Z","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":20,"cached_input_tokens":0,"output_tokens":10}}}}"#,
        ]);

        let mut daily: HashMap<String, DailyTotals> = HashMap::new();
        daily.insert(day_key.to_string(), DailyTotals::default());
        let mut model_totals: HashMap<String, i64> = HashMap::new();
        let mut rolling_hour_tokens = 0;
        scan_file(
            &path,
            &mut daily,
            &mut model_totals,
            &mut rolling_hour_tokens,
            0,
            None,
        )
        .expect("scan file");

        let totals = daily.get(day_key).copied().unwrap_or_default();
        assert_eq!(totals.input, 20);
        assert_eq!(totals.output, 10);
    }

    #[test]
    fn scan_file_does_not_double_count_last_between_total_snapshots() {
        let day_key = "2026-01-19";
        let path = write_temp_jsonl(&[
            r#"{"timestamp":"2026-01-19T12:00:00.000Z","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":10,"cached_input_tokens":0,"output_tokens":5}}}}"#,
            r#"{"timestamp":"2026-01-19T12:00:01.000Z","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":2,"cached_input_tokens":0,"output_tokens":1}}}}"#,
            r#"{"timestamp":"2026-01-19T12:00:02.000Z","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":12,"cached_input_tokens":0,"output_tokens":6}}}}"#,
        ]);

        let mut daily: HashMap<String, DailyTotals> = HashMap::new();
        daily.insert(day_key.to_string(), DailyTotals::default());
        let mut model_totals: HashMap<String, i64> = HashMap::new();
        let mut rolling_hour_tokens = 0;
        scan_file(
            &path,
            &mut daily,
            &mut model_totals,
            &mut rolling_hour_tokens,
            0,
            None,
        )
        .expect("scan file");

        let totals = daily.get(day_key).copied().unwrap_or_default();
        assert_eq!(totals.input, 12);
        assert_eq!(totals.output, 6);
    }

    #[test]
    fn scan_file_tracks_tokens_in_recent_hour() {
        let day_key = "2026-01-19";
        let path = write_temp_jsonl(&[
            r#"{"timestamp":"2026-01-19T11:00:00.000Z","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":10,"cached_input_tokens":0,"output_tokens":5}}}}"#,
            r#"{"timestamp":"2026-01-19T12:00:00.000Z","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":20,"cached_input_tokens":0,"output_tokens":10}}}}"#,
        ]);

        let mut daily: HashMap<String, DailyTotals> = HashMap::new();
        daily.insert(day_key.to_string(), DailyTotals::default());
        let mut model_totals: HashMap<String, i64> = HashMap::new();
        let mut rolling_hour_tokens = 0;
        let rolling_hour_start_ms = DateTime::parse_from_rfc3339("2026-01-19T11:30:00.000Z")
            .expect("parse timestamp")
            .timestamp_millis();
        scan_file(
            &path,
            &mut daily,
            &mut model_totals,
            &mut rolling_hour_tokens,
            rolling_hour_start_ms,
            None,
        )
        .expect("scan file");

        let totals = daily.get(day_key).copied().unwrap_or_default();
        assert_eq!(totals.input, 30);
        assert_eq!(totals.output, 15);
        assert_eq!(rolling_hour_tokens, 30);
    }

    #[test]
    fn scan_file_tracks_agent_time_from_activity() {
        let day_key = "2026-01-19";
        let path = write_temp_jsonl(&[
            r#"{"timestamp":"2026-01-19T12:00:00.000Z","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":1,"cached_input_tokens":0,"output_tokens":1}}}}"#,
            r#"{"timestamp":"2026-01-19T12:00:05.000Z","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":2,"cached_input_tokens":0,"output_tokens":2}}}}"#,
        ]);

        let mut daily: HashMap<String, DailyTotals> = HashMap::new();
        daily.insert(day_key.to_string(), DailyTotals::default());
        let mut model_totals: HashMap<String, i64> = HashMap::new();
        let mut rolling_hour_tokens = 0;
        scan_file(
            &path,
            &mut daily,
            &mut model_totals,
            &mut rolling_hour_tokens,
            0,
            None,
        )
        .expect("scan file");

        let totals = daily.get(day_key).copied().unwrap_or_default();
        assert_eq!(totals.agent_ms, 5_000);
    }

    #[test]
    fn scan_file_counts_runs_from_assistant_messages() {
        let day_key = "2026-01-19";
        let path = write_temp_jsonl(&[
            r#"{"timestamp":"2026-01-19T12:00:05.000Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"a"}]}}"#,
            r#"{"timestamp":"2026-01-19T12:00:10.000Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"b"}]}}"#,
        ]);

        let mut daily: HashMap<String, DailyTotals> = HashMap::new();
        daily.insert(day_key.to_string(), DailyTotals::default());
        let mut model_totals: HashMap<String, i64> = HashMap::new();
        let mut rolling_hour_tokens = 0;
        scan_file(
            &path,
            &mut daily,
            &mut model_totals,
            &mut rolling_hour_tokens,
            0,
            None,
        )
        .expect("scan file");

        let totals = daily.get(day_key).copied().unwrap_or_default();
        assert_eq!(totals.agent_runs, 2);
    }

    #[test]
    fn scan_file_ignores_large_gaps_between_activity() {
        let day_key = "2026-01-19";
        let path = write_temp_jsonl(&[
            r#"{"timestamp":"2026-01-19T12:00:00.000Z","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":1,"cached_input_tokens":0,"output_tokens":1}}}}"#,
            r#"{"timestamp":"2026-01-19T12:10:00.000Z","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":2,"cached_input_tokens":0,"output_tokens":2}}}}"#,
            r#"{"timestamp":"2026-01-19T12:10:10.000Z","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":3,"cached_input_tokens":0,"output_tokens":3}}}}"#,
        ]);

        let mut daily: HashMap<String, DailyTotals> = HashMap::new();
        daily.insert(day_key.to_string(), DailyTotals::default());
        let mut model_totals: HashMap<String, i64> = HashMap::new();
        let mut rolling_hour_tokens = 0;
        scan_file(
            &path,
            &mut daily,
            &mut model_totals,
            &mut rolling_hour_tokens,
            0,
            None,
        )
        .expect("scan file");

        let totals = daily.get(day_key).copied().unwrap_or_default();
        assert_eq!(totals.agent_ms, 10_000);
    }

    #[test]
    fn scan_file_skips_workspace_mismatch() {
        let day_key = "2026-01-19";
        let path = write_temp_jsonl(&[
            r#"{"timestamp":"2026-01-19T12:00:00.000Z","type":"session_meta","payload":{"cwd":"/tmp/project-alpha"}}"#,
            r#"{"timestamp":"2026-01-19T12:00:10.000Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"ok"}]}}"#,
            r#"{"timestamp":"2026-01-19T12:00:12.000Z","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":10,"cached_input_tokens":0,"output_tokens":5}}}}"#,
        ]);

        let mut daily: HashMap<String, DailyTotals> = HashMap::new();
        daily.insert(day_key.to_string(), DailyTotals::default());
        let mut model_totals: HashMap<String, i64> = HashMap::new();
        let mut rolling_hour_tokens = 0;
        scan_file(
            &path,
            &mut daily,
            &mut model_totals,
            &mut rolling_hour_tokens,
            0,
            Some(Path::new("/tmp/other-project")),
        )
        .expect("scan file");

        let totals = daily.get(day_key).copied().unwrap_or_default();
        assert_eq!(totals.agent_ms, 0);
        assert_eq!(totals.input, 0);
    }

    #[test]
    fn scan_local_usage_aggregates_multiple_session_roots() {
        let day_keys = make_day_keys(2);
        let day_key = day_keys
            .last()
            .cloned()
            .unwrap_or_else(|| Local::now().format("%Y-%m-%d").to_string());
        let naive =
            NaiveDateTime::parse_from_str(&format!("{day_key} 12:00:00"), "%Y-%m-%d %H:%M:%S")
                .expect("timestamp");
        let timestamp_ms = Local
            .from_local_datetime(&naive)
            .single()
            .expect("timestamp")
            .timestamp_millis();

        let root_a = make_temp_sessions_root();
        let root_b = make_temp_sessions_root();

        let line_a = format!(
            r#"{{"timestamp":{timestamp_ms},"payload":{{"type":"token_count","info":{{"total_token_usage":{{"input_tokens":5,"cached_input_tokens":0,"output_tokens":2}}}}}}}}"#
        );
        let line_b = format!(
            r#"{{"timestamp":{timestamp_ms},"payload":{{"type":"token_count","info":{{"total_token_usage":{{"input_tokens":3,"cached_input_tokens":0,"output_tokens":1}}}}}}}}"#
        );

        write_session_file(&root_a, &day_key, &[line_a]);
        write_session_file(&root_b, &day_key, &[line_b]);

        let snapshot = scan_local_usage(2, None, &[root_a, root_b]).expect("scan usage");
        let day = snapshot
            .days
            .iter()
            .find(|entry| entry.day == day_key)
            .expect("day entry");

        assert_eq!(day.input_tokens, 8);
        assert_eq!(day.output_tokens, 3);
        assert_eq!(snapshot.totals.last30_days_tokens, 11);
    }

    #[test]
    fn indexed_scan_uses_unchanged_old_file_cache_and_workspace_filter() {
        let root = make_temp_sessions_root();
        let day_key = make_day_keys(1)
            .pop()
            .unwrap_or_else(|| Local::now().format("%Y-%m-%d").to_string());
        let path = root.join("rollout-cached.jsonl");
        let mut file = File::create(&path).expect("create session");
        writeln!(
            file,
            "{}",
            r#"{"type":"session_meta","payload":{"id":"thread-cached","cwd":"/repo","model_provider":"provider-live"}}"#
        )
        .expect("write metadata");
        writeln!(
            file,
            "{}",
            format!(
                r#"{{"timestamp":"{}","type":"event_msg","payload":{{"type":"token_count","info":{{"last_token_usage":{{"input_tokens":10,"output_tokens":5}}}}}}}}"#,
                Utc::now().to_rfc3339()
            )
        )
        .expect("write usage");
        drop(file);

        let metadata = usage_file_metadata(&path).expect("metadata");
        let index_path = root.join("index.json");
        let mut daily = HashMap::new();
        daily.insert(
            day_key,
            DailyTotals {
                input: 90,
                output: 9,
                ..DailyTotals::default()
            },
        );
        let mut files = HashMap::new();
        files.insert(
            usage_file_cache_key(&path),
            CachedUsageFile {
                modified_ms: metadata.modified_ms,
                len: metadata.len,
                cwd: Some("/repo".to_string()),
                daily,
                model_totals: HashMap::new(),
                source_totals: HashMap::new(),
            },
        );
        write_local_usage_index(
            &index_path,
            &LocalUsageIndex {
                version: LOCAL_USAGE_INDEX_VERSION,
                files,
            },
        );

        let updated_at = metadata.modified_ms + ONE_HOUR_MS + 1;
        let all_snapshot =
            scan_local_usage_with_index_at(1, None, &[root.clone()], &index_path, updated_at)
                .expect("scan all");
        assert_eq!(all_snapshot.totals.last30_days_tokens, 99);

        let workspace_snapshot = scan_local_usage_with_index_at(
            1,
            Some(Path::new("/repo")),
            &[root.clone()],
            &index_path,
            updated_at,
        )
        .expect("scan workspace");
        assert_eq!(workspace_snapshot.totals.last30_days_tokens, 99);

        let other_workspace_snapshot = scan_local_usage_with_index_at(
            1,
            Some(Path::new("/other")),
            &[root.clone()],
            &index_path,
            updated_at,
        )
        .expect("scan other workspace");
        assert_eq!(other_workspace_snapshot.totals.last30_days_tokens, 0);

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn resolve_sessions_roots_uses_single_default_root() {
        let mut workspaces = HashMap::new();
        let entry_a = WorkspaceEntry {
            id: "a".to_string(),
            name: "A".to_string(),
            path: "/tmp/project-a".to_string(),
            kind: WorkspaceKind::Main,
            parent_id: None,
            worktree: None,
            settings: WorkspaceSettings::default(),
        };
        let entry_b = WorkspaceEntry {
            id: "b".to_string(),
            name: "B".to_string(),
            path: "/tmp/project-b".to_string(),
            kind: WorkspaceKind::Main,
            parent_id: None,
            worktree: None,
            settings: WorkspaceSettings::default(),
        };
        workspaces.insert(entry_a.id.clone(), entry_a.clone());
        workspaces.insert(entry_b.id.clone(), entry_b.clone());

        let roots = resolve_sessions_roots(&workspaces, None);
        let expected = resolve_codex_sessions_roots(None);
        assert_eq!(roots, expected);
    }
}
