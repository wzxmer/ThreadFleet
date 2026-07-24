use futures_util::{future, StreamExt};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::OnceLock;
use std::time::Duration;
use tokio::sync::Mutex;

use crate::shared::provider_gateway_core::{
    start_provider_gateway, ProviderGatewayConfig, ProviderGatewayShutdown,
};
use crate::types::AppSettings;

pub(crate) struct CodexKeyRuntime {
    pub(crate) env: Vec<(String, String)>,
    pub(crate) codex_args: Option<String>,
    pub(crate) comparison_codex_args: Option<String>,
    pub(crate) provider_runtime_fingerprint: Option<String>,
    pub(crate) gateway_shutdown: Option<ProviderGatewayShutdown>,
}

pub(crate) const CODEX_MONITOR_PROVIDER_ID: &str = "codex_monitor";
const CODEX_MONITOR_PROVIDER_KEY_ENV: &str = "CODEX_MONITOR_PROVIDER_KEY";
const MAX_PROVIDER_USAGE_RESPONSE_BYTES: usize = 4 * 1024 * 1024;
const NEW_API_LOG_LIMIT: usize = 1_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ProviderUsageProtocol {
    Auto,
    Sub2,
    NewApi,
    Disabled,
}

#[derive(Clone, Copy, Debug)]
struct ProviderUsageDetection {
    protocol: ProviderUsageProtocol,
}

static PROVIDER_USAGE_DETECTIONS: OnceLock<Mutex<HashMap<String, ProviderUsageDetection>>> =
    OnceLock::new();

fn provider_usage_detections() -> &'static Mutex<HashMap<String, ProviderUsageDetection>> {
    PROVIDER_USAGE_DETECTIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn parse_provider_usage_protocol(value: Option<&str>) -> Result<ProviderUsageProtocol, String> {
    match value.unwrap_or("auto").trim().to_ascii_lowercase().as_str() {
        "" | "auto" => Ok(ProviderUsageProtocol::Auto),
        "sub2" => Ok(ProviderUsageProtocol::Sub2),
        "new-api" | "new_api" | "newapi" => Ok(ProviderUsageProtocol::NewApi),
        "disabled" => Ok(ProviderUsageProtocol::Disabled),
        _ => Err("Unsupported third-party provider usage protocol".to_string()),
    }
}

fn normalize_http_url(
    raw_url: &str,
    invalid_message: &str,
    scheme_message: &str,
) -> Result<reqwest::Url, String> {
    let trimmed = raw_url.trim();
    let normalized = if trimmed.contains("://") {
        trimmed.to_string()
    } else {
        format!("https://{trimmed}")
    };
    let url = reqwest::Url::parse(&normalized).map_err(|_| invalid_message.to_string())?;
    if url.scheme() != "https" && url.scheme() != "http" {
        return Err(scheme_message.to_string());
    }
    Ok(url)
}

fn append_url_path_segment(mut url: reqwest::Url, segment: &str) -> reqwest::Url {
    let base_path = url.path().trim_end_matches('/');
    let base_path = if base_path.is_empty() {
        "/v1"
    } else {
        base_path
    };
    url.set_path(&format!("{base_path}/{segment}"));
    url
}

pub(crate) fn build_provider_usage_url(base_url: &str) -> Result<reqwest::Url, String> {
    let mut parsed_base_url = normalize_http_url(
        base_url,
        "Invalid third-party provider base URL",
        "Third-party provider base URL must use HTTP or HTTPS",
    )?;
    if parsed_base_url
        .path()
        .trim_end_matches('/')
        .ends_with("/usage")
    {
        parsed_base_url.set_query(None);
        parsed_base_url.set_fragment(None);
        return Ok(parsed_base_url);
    }
    let mut usage_url = append_url_path_segment(parsed_base_url, "usage");
    usage_url.set_query(None);
    usage_url.set_fragment(None);
    Ok(usage_url)
}

fn build_new_api_url(base_url: &str, endpoint: &str) -> Result<reqwest::Url, String> {
    let mut url = normalize_http_url(
        base_url,
        "Invalid third-party provider base URL",
        "Third-party provider base URL must use HTTP or HTTPS",
    )?;
    let mut base_path = url.path().trim_end_matches('/').to_string();
    if base_path.ends_with("/usage") {
        base_path.truncate(base_path.len() - "/usage".len());
    }
    if base_path.ends_with("/v1") {
        base_path.truncate(base_path.len() - "/v1".len());
    }
    let endpoint = endpoint.trim_start_matches('/');
    url.set_path(&format!("{base_path}/api/{endpoint}"));
    url.set_query(None);
    url.set_fragment(None);
    Ok(url)
}

fn provider_usage_cache_key(base_url: &str) -> Result<String, String> {
    build_new_api_url(base_url, "status").map(|url| url.to_string())
}

pub(crate) fn build_provider_models_url(base_url: &str) -> Result<reqwest::Url, String> {
    let parsed_base_url = normalize_http_url(
        base_url,
        "Invalid provider base URL",
        "Provider base URL must use HTTP or HTTPS",
    )?;
    let mut models_url = append_url_path_segment(parsed_base_url, "models");
    models_url.set_query(None);
    models_url.set_fragment(None);
    Ok(models_url)
}

fn merge_provider_model_payloads(payloads: Vec<Value>) -> Value {
    let mut merged = Vec::<Value>::new();
    let mut model_indexes = HashMap::<String, usize>::new();

    for payload in payloads {
        let Some(models) = payload.get("data").and_then(Value::as_array) else {
            continue;
        };
        for model in models {
            let Some(id) = model
                .get("id")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|id| !id.is_empty())
            else {
                continue;
            };
            if let Some(index) = model_indexes.get(id).copied() {
                let Some(existing) = merged[index].as_object_mut() else {
                    continue;
                };
                let Some(update) = model.as_object() else {
                    continue;
                };
                for (key, value) in update {
                    if !value.is_null() {
                        existing.insert(key.clone(), value.clone());
                    }
                }
                continue;
            }
            model_indexes.insert(id.to_string(), merged.len());
            merged.push(model.clone());
        }
    }

    serde_json::json!({ "data": merged })
}

pub(crate) async fn provider_model_list_core(
    base_url: String,
    api_key: String,
) -> Result<Value, String> {
    let base_url = base_url.trim();
    let api_key = api_key.trim();
    if base_url.is_empty() || api_key.is_empty() {
        return Err("Provider base URL and key are required".to_string());
    }

    let models_url = build_provider_models_url(base_url)?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(6))
        .build()
        .map_err(|_| "Failed to initialize provider model client".to_string())?;
    let mut successful_payloads = Vec::new();
    let mut last_error = None;
    for attempt in 0..3 {
        let response = client
            .get(models_url.clone())
            .header(reqwest::header::ACCEPT, "application/json")
            .header(reqwest::header::CACHE_CONTROL, "no-cache")
            .header(
                reqwest::header::USER_AGENT,
                concat!("ThreadFleet/", env!("CARGO_PKG_VERSION")),
            )
            .bearer_auth(api_key)
            .send()
            .await;

        match response {
            Ok(response) if response.status().is_success() => match response.text().await {
                Ok(body) => match serde_json::from_str::<Value>(&body) {
                    Ok(payload) => successful_payloads.push(payload),
                    Err(_) => {
                        last_error = Some("Failed to parse provider model response".to_string())
                    }
                },
                Err(_) => last_error = Some("Failed to read provider model response".to_string()),
            },
            Ok(response) if response.status() == reqwest::StatusCode::UNAUTHORIZED => {
                last_error = Some("Provider API key was rejected (HTTP 401)".to_string())
            }
            Ok(response) => {
                last_error = Some(format!(
                    "Provider model list request was rejected (HTTP {})",
                    response.status().as_u16()
                ))
            }
            Err(_) => last_error = Some("Failed to fetch provider models".to_string()),
        }

        if attempt < 2 {
            tokio::time::sleep(Duration::from_millis(150)).await;
        }
    }

    if successful_payloads.is_empty() {
        return Err(last_error.unwrap_or_else(|| "Failed to fetch provider models".to_string()));
    }
    Ok(merge_provider_model_payloads(successful_payloads))
}

async fn read_provider_usage_json(
    response: reqwest::Response,
    failure_message: &str,
) -> Result<Value, String> {
    if !response.status().is_success() {
        return Err(failure_message.to_string());
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_PROVIDER_USAGE_RESPONSE_BYTES as u64)
    {
        return Err("Third-party key usage response is too large".to_string());
    }
    let mut body = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk =
            chunk.map_err(|_| "Failed to read third-party key usage response".to_string())?;
        if body.len().saturating_add(chunk.len()) > MAX_PROVIDER_USAGE_RESPONSE_BYTES {
            return Err("Third-party key usage response is too large".to_string());
        }
        body.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&body)
        .map_err(|_| "Failed to parse third-party key usage response".to_string())
}

async fn get_provider_usage_json(
    client: &reqwest::Client,
    url: reqwest::Url,
    api_key: Option<&str>,
) -> Result<Value, String> {
    let mut request = client.get(url);
    if let Some(api_key) = api_key {
        request = request.bearer_auth(api_key);
    }
    let response = request
        .send()
        .await
        .map_err(|_| "Failed to fetch third-party key usage".to_string())?;
    read_provider_usage_json(response, "Third-party key usage request was rejected").await
}

fn parse_usage_number(value: Option<&Value>) -> Option<f64> {
    match value? {
        Value::Number(number) => number.as_f64().filter(|value| value.is_finite()),
        Value::String(value) => value
            .trim()
            .replace(['$', ',', ' '], "")
            .parse::<f64>()
            .ok()
            .filter(|value| value.is_finite()),
        _ => None,
    }
}

fn normalized_usage_snapshot(
    source: &str,
    balance_usd: Option<f64>,
    today_cost_usd: Option<f64>,
    total_cost_usd: Option<f64>,
    average_latency_ms: Option<f64>,
    is_unlimited: bool,
    is_partial: bool,
) -> Value {
    let spend_period = if today_cost_usd.is_some() {
        Some("today")
    } else if total_cost_usd.is_some() {
        Some("total")
    } else {
        None
    };
    json!({
        "source": source,
        "balanceUsd": balance_usd,
        "todayCostUsd": today_cost_usd,
        "totalCostUsd": total_cost_usd,
        "spendPeriod": spend_period,
        "averageLatencyMs": average_latency_ms,
        "isUnlimited": is_unlimited,
        "isPartial": is_partial,
    })
}

fn normalize_sub2_usage_payload(payload: &Value) -> Value {
    let balance_usd = parse_usage_number(payload.get("balance"))
        .or_else(|| parse_usage_number(payload.get("remaining")));
    let today_cost_usd = parse_usage_number(
        payload
            .get("usage")
            .and_then(|usage| usage.get("today"))
            .and_then(|today| today.get("actual_cost")),
    )
    .or_else(|| {
        parse_usage_number(
            payload
                .get("subscription")
                .and_then(|subscription| subscription.get("daily_usage_usd")),
        )
    });
    let average_latency_ms = parse_usage_number(
        payload
            .get("usage")
            .and_then(|usage| usage.get("average_duration_ms")),
    );
    if balance_usd.is_none() && today_cost_usd.is_none() && average_latency_ms.is_none() {
        return Value::Null;
    }
    normalized_usage_snapshot(
        "sub2",
        balance_usd,
        today_cost_usd,
        None,
        average_latency_ms,
        false,
        false,
    )
}

fn new_api_quota_per_unit(payload: &Value) -> Option<f64> {
    parse_usage_number(
        payload
            .get("data")
            .and_then(|data| data.get("quota_per_unit")),
    )
    .filter(|value| *value > 0.0)
}

#[derive(Debug, PartialEq)]
struct NewApiLogSummary {
    today_cost_usd: Option<f64>,
    average_latency_ms: Option<f64>,
    complete: bool,
}

fn summarize_new_api_logs(
    payload: Option<&Value>,
    day_start_unix: Option<i64>,
    quota_per_unit: f64,
) -> NewApiLogSummary {
    let Some(day_start_unix) = day_start_unix else {
        return NewApiLogSummary {
            today_cost_usd: None,
            average_latency_ms: None,
            complete: false,
        };
    };
    let Some(logs) = payload
        .and_then(|payload| payload.get("data"))
        .and_then(Value::as_array)
    else {
        return NewApiLogSummary {
            today_cost_usd: None,
            average_latency_ms: None,
            complete: false,
        };
    };

    let oldest_timestamp = logs
        .iter()
        .filter_map(|log| parse_usage_number(log.get("created_at")))
        .map(|timestamp| timestamp as i64)
        .min();
    let complete = logs.len() < NEW_API_LOG_LIMIT
        || oldest_timestamp.is_some_and(|timestamp| timestamp < day_start_unix);
    if !complete {
        return NewApiLogSummary {
            today_cost_usd: None,
            average_latency_ms: None,
            complete: false,
        };
    }

    let mut today_quota = 0.0;
    let mut total_latency_ms = 0.0;
    let mut latency_count = 0_u64;
    for log in logs {
        let log_type = parse_usage_number(log.get("type")).unwrap_or_default() as i64;
        let created_at = parse_usage_number(log.get("created_at")).unwrap_or_default() as i64;
        if log_type != 2 || created_at < day_start_unix {
            continue;
        }
        today_quota += parse_usage_number(log.get("quota")).unwrap_or_default();
        if let Some(use_time_seconds) = parse_usage_number(log.get("use_time")) {
            total_latency_ms += use_time_seconds.max(0.0) * 1_000.0;
            latency_count += 1;
        }
    }
    NewApiLogSummary {
        today_cost_usd: Some(today_quota / quota_per_unit),
        average_latency_ms: (latency_count > 0).then_some(total_latency_ms / latency_count as f64),
        complete: true,
    }
}

fn normalize_new_api_usage_payload(
    usage_payload: &Value,
    log_payload: Option<&Value>,
    day_start_unix: Option<i64>,
    quota_per_unit: f64,
) -> Result<Value, String> {
    let data = usage_payload
        .get("data")
        .ok_or_else(|| "Failed to parse New API key usage response".to_string())?;
    let total_available = parse_usage_number(data.get("total_available"));
    let total_used = parse_usage_number(data.get("total_used"));
    let is_unlimited = data
        .get("unlimited_quota")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if total_available.is_none() && total_used.is_none() && !is_unlimited {
        return Err("Failed to parse New API key usage response".to_string());
    }
    let log_summary = summarize_new_api_logs(log_payload, day_start_unix, quota_per_unit);
    Ok(normalized_usage_snapshot(
        "new-api",
        (!is_unlimited)
            .then(|| total_available.map(|value| value / quota_per_unit))
            .flatten(),
        log_summary.today_cost_usd,
        total_used.map(|value| value / quota_per_unit),
        log_summary.average_latency_ms,
        is_unlimited,
        !log_summary.complete,
    ))
}

async fn fetch_sub2_usage(
    client: &reqwest::Client,
    base_url: &str,
    api_key: &str,
    timezone: Option<&str>,
) -> Result<Value, String> {
    let mut usage_url = build_provider_usage_url(base_url)?;
    usage_url
        .query_pairs_mut()
        .append_pair("period", "today")
        .append_pair("days", "30")
        .append_pair("timezone", timezone.unwrap_or("UTC"));
    let payload = get_provider_usage_json(client, usage_url, Some(api_key)).await?;
    let normalized = normalize_sub2_usage_payload(&payload);
    if normalized.is_null() {
        return Err("Failed to parse third-party key usage response".to_string());
    }
    Ok(normalized)
}

async fn fetch_new_api_usage(
    client: &reqwest::Client,
    base_url: &str,
    api_key: &str,
    day_start_unix: Option<i64>,
    known_quota_per_unit: Option<f64>,
) -> Result<Value, String> {
    let quota_per_unit = if let Some(quota_per_unit) = known_quota_per_unit {
        quota_per_unit
    } else {
        let status =
            get_provider_usage_json(client, build_new_api_url(base_url, "status")?, None).await?;
        new_api_quota_per_unit(&status)
            .ok_or_else(|| "Failed to read New API quota unit".to_string())?
    };
    let usage_url = build_new_api_url(base_url, "usage/token/")?;
    let logs_url = build_new_api_url(base_url, "log/token")?;
    let (usage_result, logs_result) = future::join(
        get_provider_usage_json(client, usage_url, Some(api_key)),
        get_provider_usage_json(client, logs_url, Some(api_key)),
    )
    .await;
    let usage_payload = usage_result?;
    normalize_new_api_usage_payload(
        &usage_payload,
        logs_result.as_ref().ok(),
        day_start_unix,
        quota_per_unit,
    )
}

pub(crate) async fn third_party_key_usage_core(
    base_url: String,
    api_key: String,
    timezone: Option<String>,
    day_start_unix: Option<i64>,
    usage_protocol: Option<String>,
) -> Result<Value, String> {
    let protocol = parse_provider_usage_protocol(usage_protocol.as_deref())?;
    if protocol == ProviderUsageProtocol::Disabled {
        return Ok(Value::Null);
    }
    let base_url = base_url.trim();
    let api_key = api_key.trim();
    if base_url.is_empty() || api_key.is_empty() {
        return Err("Third-party provider base URL and key are required".to_string());
    }

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "Failed to initialize third-party key usage client".to_string())?;
    match protocol {
        ProviderUsageProtocol::Sub2 => {
            fetch_sub2_usage(&client, base_url, api_key, timezone.as_deref()).await
        }
        ProviderUsageProtocol::NewApi => {
            fetch_new_api_usage(&client, base_url, api_key, day_start_unix, None).await
        }
        ProviderUsageProtocol::Disabled => Ok(Value::Null),
        ProviderUsageProtocol::Auto => {
            let cache_key = provider_usage_cache_key(base_url)?;
            if let Some(detection) = provider_usage_detections()
                .lock()
                .await
                .get(&cache_key)
                .copied()
            {
                return match detection.protocol {
                    ProviderUsageProtocol::NewApi => {
                        fetch_new_api_usage(&client, base_url, api_key, day_start_unix, None).await
                    }
                    ProviderUsageProtocol::Sub2 => {
                        fetch_sub2_usage(&client, base_url, api_key, timezone.as_deref()).await
                    }
                    _ => unreachable!(),
                };
            }

            let status_payload =
                get_provider_usage_json(&client, build_new_api_url(base_url, "status")?, None)
                    .await
                    .ok();
            if let Some(quota_per_unit) = status_payload.as_ref().and_then(new_api_quota_per_unit) {
                let result = fetch_new_api_usage(
                    &client,
                    base_url,
                    api_key,
                    day_start_unix,
                    Some(quota_per_unit),
                )
                .await;
                if result.is_ok() {
                    provider_usage_detections().lock().await.insert(
                        cache_key,
                        ProviderUsageDetection {
                            protocol: ProviderUsageProtocol::NewApi,
                        },
                    );
                }
                return result;
            }

            let result = fetch_sub2_usage(&client, base_url, api_key, timezone.as_deref()).await;
            if result.is_ok() {
                provider_usage_detections().lock().await.insert(
                    cache_key,
                    ProviderUsageDetection {
                        protocol: ProviderUsageProtocol::Sub2,
                    },
                );
            }
            result
        }
    }
}

pub(crate) async fn active_codex_key_runtime(
    settings: &AppSettings,
    codex_args: Option<String>,
) -> Result<CodexKeyRuntime, String> {
    let Some(active_id) = settings
        .active_codex_key_profile_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return Ok(CodexKeyRuntime {
            env: Vec::new(),
            codex_args,
            comparison_codex_args: None,
            provider_runtime_fingerprint: None,
            gateway_shutdown: None,
        });
    };
    let Some(profile) = settings
        .codex_key_profiles
        .iter()
        .find(|profile| profile.id == active_id)
    else {
        return Ok(CodexKeyRuntime {
            env: Vec::new(),
            codex_args,
            comparison_codex_args: None,
            provider_runtime_fingerprint: None,
            gateway_shutdown: None,
        });
    };
    let key = profile.key.trim();
    if key.is_empty() {
        return Ok(CodexKeyRuntime {
            env: Vec::new(),
            codex_args,
            comparison_codex_args: None,
            provider_runtime_fingerprint: None,
            gateway_shutdown: None,
        });
    }
    let provider_runtime_fingerprint = Some(profile_runtime_fingerprint(profile));
    let base_url = resolve_profile_base_url(profile);
    let comparison_codex_args =
        merge_profile_codex_args(codex_args.clone(), profile, base_url.as_deref())?;
    let use_gateway = profile_uses_gateway(profile);
    if use_gateway && base_url.is_none() {
        return Err("Gateway profiles require a provider base URL".to_string());
    }
    if use_gateway {
        let base_url = base_url.as_deref().unwrap_or_default();
        let gateway = start_provider_gateway(ProviderGatewayConfig {
            upstream_base_url: base_url.to_string(),
            upstream_api_key: key.to_string(),
            max_output_tokens: profile.max_output_tokens,
            supports_thinking: profile.supports_thinking || profile.supports_reasoning_effort,
            supports_reasoning_effort: profile.supports_reasoning_effort,
        })
        .await?;
        let codex_args =
            merge_profile_codex_args(codex_args, profile, Some(gateway.base_url.as_str()))?;
        return Ok(CodexKeyRuntime {
            env: vec![(
                CODEX_MONITOR_PROVIDER_KEY_ENV.to_string(),
                gateway.access_token,
            )],
            codex_args,
            comparison_codex_args: Some(comparison_codex_args.unwrap_or_default()),
            provider_runtime_fingerprint,
            gateway_shutdown: Some(gateway.shutdown),
        });
    }
    let codex_args = merge_profile_codex_args(codex_args, profile, base_url.as_deref())?;
    let mut env = vec![(CODEX_MONITOR_PROVIDER_KEY_ENV.to_string(), key.to_string())];
    let legacy_key_env = profile.key_env_var.trim();
    if !legacy_key_env.is_empty() && legacy_key_env != CODEX_MONITOR_PROVIDER_KEY_ENV {
        env.push((legacy_key_env.to_string(), key.to_string()));
    }
    if let Some(base_url) = base_url {
        env.push(("OPENAI_BASE_URL".to_string(), base_url.clone()));
        let legacy_base_url_env = profile.base_url_env_var.trim();
        if !legacy_base_url_env.is_empty() && legacy_base_url_env != "OPENAI_BASE_URL" {
            env.push((legacy_base_url_env.to_string(), base_url));
        }
    }
    Ok(CodexKeyRuntime {
        env,
        codex_args,
        comparison_codex_args: Some(comparison_codex_args.unwrap_or_default()),
        provider_runtime_fingerprint,
        gateway_shutdown: None,
    })
}

pub(crate) fn active_profile_runtime_fingerprint(settings: &AppSettings) -> Option<String> {
    let active_id = settings
        .active_codex_key_profile_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())?;
    let profile = settings
        .codex_key_profiles
        .iter()
        .find(|profile| profile.id == active_id && !profile.key.trim().is_empty())?;
    Some(profile_runtime_fingerprint(profile))
}

pub(crate) fn active_profile_codex_args(
    settings: &AppSettings,
    codex_args: Option<String>,
) -> Result<Option<String>, String> {
    let Some(active_id) = settings
        .active_codex_key_profile_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return Ok(codex_args);
    };
    let Some(profile) = settings
        .codex_key_profiles
        .iter()
        .find(|profile| profile.id == active_id && !profile.key.trim().is_empty())
    else {
        return Ok(codex_args);
    };
    merge_profile_codex_args(
        codex_args,
        profile,
        resolve_profile_base_url(profile).as_deref(),
    )
}

pub(crate) fn resolve_profile_base_url(profile: &crate::types::CodexKeyProfile) -> Option<String> {
    profile
        .base_url
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or_else(
            || match profile.provider_kind.trim().to_ascii_lowercase().as_str() {
                "openai" => Some("https://api.openai.com/v1".to_string()),
                "deepseek" => Some("https://api.deepseek.com/v1".to_string()),
                "openrouter" => Some("https://openrouter.ai/api/v1".to_string()),
                "opencode" => Some("https://opencode.ai/zen/go/v1".to_string()),
                _ => None,
            },
        )
}

pub(crate) fn profile_uses_gateway(profile: &crate::types::CodexKeyProfile) -> bool {
    profile.use_gateway
        || profile
            .provider_kind
            .trim()
            .eq_ignore_ascii_case("opencode")
}

fn profile_runtime_fingerprint(profile: &crate::types::CodexKeyProfile) -> String {
    fn update_field(hasher: &mut Sha256, value: &str) {
        hasher.update(value.len().to_le_bytes());
        hasher.update(value.as_bytes());
    }

    let mut hasher = Sha256::new();
    update_field(&mut hasher, profile.id.trim());
    update_field(&mut hasher, profile.provider_kind.trim());
    update_field(&mut hasher, profile.key_env_var.trim());
    update_field(&mut hasher, profile.key.trim());
    update_field(&mut hasher, profile.base_url_env_var.trim());
    update_field(
        &mut hasher,
        resolve_profile_base_url(profile)
            .as_deref()
            .unwrap_or_default(),
    );
    update_field(
        &mut hasher,
        profile.model.as_deref().map(str::trim).unwrap_or_default(),
    );
    update_field(
        &mut hasher,
        &profile.context_window.unwrap_or_default().to_string(),
    );
    update_field(
        &mut hasher,
        &profile.max_output_tokens.unwrap_or_default().to_string(),
    );
    update_field(
        &mut hasher,
        if profile_uses_gateway(profile) {
            "1"
        } else {
            "0"
        },
    );
    update_field(
        &mut hasher,
        if profile.supports_thinking || profile.supports_reasoning_effort {
            "1"
        } else {
            "0"
        },
    );
    update_field(
        &mut hasher,
        if profile.supports_reasoning_effort {
            "1"
        } else {
            "0"
        },
    );
    format!("{:x}", hasher.finalize())
}

fn merge_profile_codex_args(
    codex_args: Option<String>,
    profile: &crate::types::CodexKeyProfile,
    runtime_base_url: Option<&str>,
) -> Result<Option<String>, String> {
    let mut args = crate::codex::args::parse_codex_args(codex_args.as_deref())?;
    let model = profile
        .model
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if profile
        .provider_kind
        .trim()
        .eq_ignore_ascii_case("opencode")
        && model.is_none()
    {
        return Err("OpenCode profiles require an explicit model".to_string());
    }
    let runtime_base_url = runtime_base_url
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Provider profiles require a provider base URL".to_string())?;
    for value in [
        format!("model_provider={CODEX_MONITOR_PROVIDER_ID}"),
        format!("model_providers.{CODEX_MONITOR_PROVIDER_ID}.name=ThreadFleet"),
        format!("model_providers.{CODEX_MONITOR_PROVIDER_ID}.base_url={runtime_base_url}"),
        format!(
            "model_providers.{CODEX_MONITOR_PROVIDER_ID}.env_key={CODEX_MONITOR_PROVIDER_KEY_ENV}"
        ),
        format!("model_providers.{CODEX_MONITOR_PROVIDER_ID}.wire_api=responses"),
        format!("model_providers.{CODEX_MONITOR_PROVIDER_ID}.requires_openai_auth=false"),
        format!("model_providers.{CODEX_MONITOR_PROVIDER_ID}.supports_websockets=false"),
    ] {
        args.push("-c".to_string());
        args.push(value);
    }
    if let Some(model) = model {
        args.push("-c".to_string());
        args.push(format!("model={model}"));
    }
    if let Some(context_window) = profile.context_window.filter(|value| *value > 0) {
        args.push("-c".to_string());
        args.push(format!("model_context_window={context_window}"));
    }
    if args.is_empty() {
        Ok(None)
    } else {
        Ok(Some(shell_words::join(args)))
    }
}

#[cfg(test)]
mod tests {
    use super::{
        active_codex_key_runtime, build_new_api_url, build_provider_models_url,
        build_provider_usage_url, merge_provider_model_payloads, normalize_new_api_usage_payload,
        normalize_sub2_usage_payload, summarize_new_api_logs,
    };
    use crate::codex::args::parse_codex_args;
    use crate::types::{AppSettings, CodexKeyProfile};

    #[test]
    fn provider_models_url_preserves_explicit_api_path() {
        let url = build_provider_models_url("https://openrouter.ai/api/v1/")
            .expect("models url")
            .to_string();

        assert_eq!(url, "https://openrouter.ai/api/v1/models");
    }

    #[test]
    fn provider_models_url_defaults_bare_host_to_v1() {
        let url = build_provider_models_url("api.deepseek.com")
            .expect("models url")
            .to_string();

        assert_eq!(url, "https://api.deepseek.com/v1/models");
    }

    #[test]
    fn provider_model_payloads_merge_partial_results_by_id() {
        let merged = merge_provider_model_payloads(vec![
            serde_json::json!({
                "data": [
                    { "id": "model-a", "name": "Model A", "context_window": 128000 }
                ]
            }),
            serde_json::json!({
                "data": [
                    {
                        "id": "model-a",
                        "name": "Model A refreshed",
                        "supported_reasoning_efforts": ["high", "xhigh"],
                        "default_reasoning_effort": "xhigh"
                    },
                    { "id": "model-b", "name": "Model B" }
                ]
            }),
        ]);

        assert_eq!(
            merged,
            serde_json::json!({
                "data": [
                    {
                        "id": "model-a",
                        "name": "Model A refreshed",
                        "context_window": 128000,
                        "supported_reasoning_efforts": ["high", "xhigh"],
                        "default_reasoning_effort": "xhigh"
                    },
                    { "id": "model-b", "name": "Model B" }
                ]
            })
        );
    }

    #[test]
    fn provider_usage_url_preserves_explicit_api_path() {
        let url = build_provider_usage_url("https://fcodex.top/v1/")
            .expect("usage url")
            .to_string();

        assert_eq!(url, "https://fcodex.top/v1/usage");
    }

    #[test]
    fn provider_usage_url_keeps_legacy_explicit_usage_path() {
        let url = build_provider_usage_url("https://fcodex.top/v1/usage")
            .expect("usage url")
            .to_string();

        assert_eq!(url, "https://fcodex.top/v1/usage");
    }

    #[test]
    fn new_api_urls_replace_openai_v1_path_with_dashboard_api_path() {
        assert_eq!(
            build_new_api_url("https://nihao.dog/v1", "usage/token/")
                .expect("new api usage url")
                .to_string(),
            "https://nihao.dog/api/usage/token/"
        );
        assert_eq!(
            build_new_api_url("https://example.com/prefix/v1/usage", "status")
                .expect("new api status url")
                .to_string(),
            "https://example.com/prefix/api/status"
        );
    }

    #[test]
    fn sub2_payload_normalizes_to_shared_usage_snapshot() {
        let payload = serde_json::json!({
            "remaining": "$12.50",
            "usage": {
                "today": { "actual_cost": "0.125" },
                "average_duration_ms": 842
            }
        });

        assert_eq!(
            normalize_sub2_usage_payload(&payload),
            serde_json::json!({
                "source": "sub2",
                "balanceUsd": 12.5,
                "todayCostUsd": 0.125,
                "totalCostUsd": null,
                "spendPeriod": "today",
                "averageLatencyMs": 842.0,
                "isUnlimited": false,
                "isPartial": false,
            })
        );
    }

    #[test]
    fn new_api_payload_maps_quota_units_and_complete_today_logs() {
        let usage = serde_json::json!({
            "data": {
                "total_available": 1_250_000,
                "total_used": 250_000,
                "unlimited_quota": false
            }
        });
        let logs = serde_json::json!({
            "data": [
                { "type": 2, "created_at": 200, "quota": 50_000, "use_time": 2 },
                { "type": 5, "created_at": 190, "quota": 99_999, "use_time": 9 },
                { "type": 2, "created_at": 50, "quota": 10_000, "use_time": 1 }
            ]
        });

        assert_eq!(
            normalize_new_api_usage_payload(&usage, Some(&logs), Some(100), 500_000.0)
                .expect("normalized usage"),
            serde_json::json!({
                "source": "new-api",
                "balanceUsd": 2.5,
                "todayCostUsd": 0.1,
                "totalCostUsd": 0.5,
                "spendPeriod": "today",
                "averageLatencyMs": 2000.0,
                "isUnlimited": false,
                "isPartial": false,
            })
        );
    }

    #[test]
    fn new_api_truncated_today_logs_fall_back_to_exact_total_cost() {
        let logs = serde_json::json!({
            "data": (0..1_000)
                .map(|index| serde_json::json!({
                    "type": 2,
                    "created_at": 200 + index,
                    "quota": 500
                }))
                .collect::<Vec<_>>()
        });

        assert_eq!(
            summarize_new_api_logs(Some(&logs), Some(100), 500_000.0),
            super::NewApiLogSummary {
                today_cost_usd: None,
                average_latency_ms: None,
                complete: false,
            }
        );
    }

    #[test]
    fn active_codex_key_runtime_env_uses_gateway_without_codex_home() {
        let mut settings = AppSettings::default();
        settings.codex_key_profiles = vec![CodexKeyProfile {
            id: "gateway".to_string(),
            name: "Gateway".to_string(),
            provider_kind: "deepseek".to_string(),
            usage_protocol: "auto".to_string(),
            key_env_var: "IGNORED_KEY_ENV".to_string(),
            key: "sk-provider".to_string(),
            base_url_env_var: "IGNORED_BASE_URL_ENV".to_string(),
            base_url: Some("https://api.deepseek.com/v1".to_string()),
            model: Some("deepseek-chat".to_string()),
            context_window: Some(128_000),
            max_output_tokens: None,
            use_gateway: true,
            supports_thinking: true,
            supports_reasoning_effort: true,
            last_model_refresh_at_ms: None,
            cached_models: Vec::new(),
            group_name: None,
        }];
        settings.active_codex_key_profile_id = Some("gateway".to_string());

        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_io()
            .enable_time()
            .build()
            .expect("runtime");
        let runtime_env = runtime
            .block_on(active_codex_key_runtime(
                &settings,
                Some("--profile inherited".to_string()),
            ))
            .expect("runtime env");
        let env = runtime_env.env;

        assert!(env.iter().all(|(name, _)| name != "CODEX_HOME"));
        assert!(runtime_env.gateway_shutdown.is_some());
        let args = parse_codex_args(runtime_env.codex_args.as_deref()).expect("merged args");
        assert!(args
            .windows(2)
            .any(|pair| { pair[0] == "-c" && pair[1] == "model_provider=codex_monitor" }));
        assert!(args.windows(2).any(|pair| {
            pair[0] == "-c"
                && pair[1].starts_with("model_providers.codex_monitor.base_url=http://127.0.0.1:")
                && pair[1].ends_with("/v1")
        }));
        assert!(args.windows(2).any(|pair| {
            pair[0] == "-c" && pair[1] == "model_providers.codex_monitor.supports_websockets=false"
        }));
        assert!(args
            .windows(2)
            .any(|pair| { pair[0] == "-c" && pair[1] == "model=deepseek-chat" }));
        assert!(matches!(
            env.iter()
                .find(|(name, _)| name == "CODEX_MONITOR_PROVIDER_KEY")
                .map(|(_, value)| value.as_str()),
            Some(value) if value.starts_with("codex-monitor-") && value != "sk-provider"
        ));
    }

    #[test]
    fn active_codex_key_runtime_uses_known_provider_default_base_url() {
        let mut settings = AppSettings::default();
        settings.codex_key_profiles = vec![CodexKeyProfile {
            id: "deepseek".to_string(),
            name: "DeepSeek".to_string(),
            provider_kind: "deepseek".to_string(),
            usage_protocol: "auto".to_string(),
            key_env_var: "OPENAI_API_KEY".to_string(),
            key: "sk-provider".to_string(),
            base_url_env_var: "OPENAI_BASE_URL".to_string(),
            base_url: None,
            model: None,
            context_window: None,
            max_output_tokens: None,
            use_gateway: false,
            supports_thinking: false,
            supports_reasoning_effort: false,
            last_model_refresh_at_ms: None,
            cached_models: Vec::new(),
            group_name: None,
        }];
        settings.active_codex_key_profile_id = Some("deepseek".to_string());

        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_io()
            .enable_time()
            .build()
            .expect("runtime");
        let runtime_env = runtime
            .block_on(active_codex_key_runtime(&settings, None))
            .expect("runtime env");

        assert!(runtime_env.env.contains(&(
            "OPENAI_BASE_URL".to_string(),
            "https://api.deepseek.com/v1".to_string()
        )));
    }

    #[test]
    fn active_profile_keeps_legacy_env_aliases_with_custom_provider() {
        let mut settings = AppSettings::default();
        settings.codex_key_profiles = vec![CodexKeyProfile {
            id: "legacy".to_string(),
            name: "Legacy".to_string(),
            provider_kind: "custom".to_string(),
            usage_protocol: "auto".to_string(),
            key_env_var: "LEGACY_API_KEY".to_string(),
            key: "sk-provider".to_string(),
            base_url_env_var: "LEGACY_BASE_URL".to_string(),
            base_url: Some("https://api.example.com/v1".to_string()),
            model: Some("example-model".to_string()),
            context_window: None,
            max_output_tokens: None,
            use_gateway: false,
            supports_thinking: false,
            supports_reasoning_effort: false,
            last_model_refresh_at_ms: None,
            cached_models: Vec::new(),
            group_name: None,
        }];
        settings.active_codex_key_profile_id = Some("legacy".to_string());

        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_io()
            .enable_time()
            .build()
            .expect("runtime");
        let runtime_env = runtime
            .block_on(active_codex_key_runtime(&settings, None))
            .expect("runtime env");

        assert!(runtime_env.env.contains(&(
            "CODEX_MONITOR_PROVIDER_KEY".to_string(),
            "sk-provider".to_string()
        )));
        assert!(runtime_env
            .env
            .contains(&("LEGACY_API_KEY".to_string(), "sk-provider".to_string())));
        assert!(runtime_env.env.contains(&(
            "OPENAI_BASE_URL".to_string(),
            "https://api.example.com/v1".to_string()
        )));
        assert!(runtime_env.env.contains(&(
            "LEGACY_BASE_URL".to_string(),
            "https://api.example.com/v1".to_string()
        )));
    }

    #[test]
    fn active_opencode_profile_forces_compatibility_gateway() {
        let mut settings = AppSettings::default();
        settings.codex_key_profiles = vec![CodexKeyProfile {
            id: "opencode".to_string(),
            name: "OpenCode Zen".to_string(),
            provider_kind: "opencode".to_string(),
            usage_protocol: "auto".to_string(),
            key_env_var: "OPENAI_API_KEY".to_string(),
            key: "sk-provider".to_string(),
            base_url_env_var: "OPENAI_BASE_URL".to_string(),
            base_url: None,
            model: Some("kimi-k2.7-code".to_string()),
            context_window: None,
            max_output_tokens: None,
            use_gateway: false,
            supports_thinking: false,
            supports_reasoning_effort: false,
            last_model_refresh_at_ms: None,
            cached_models: Vec::new(),
            group_name: None,
        }];
        settings.active_codex_key_profile_id = Some("opencode".to_string());

        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_io()
            .enable_time()
            .build()
            .expect("runtime");
        let runtime_env = runtime
            .block_on(active_codex_key_runtime(&settings, None))
            .expect("runtime env");

        assert!(runtime_env.gateway_shutdown.is_some());
        let args = parse_codex_args(runtime_env.codex_args.as_deref()).expect("merged args");
        assert!(args
            .windows(2)
            .any(|pair| { pair[0] == "-c" && pair[1] == "model_provider=codex_monitor" }));
        assert!(args.windows(2).any(|pair| {
            pair[0] == "-c"
                && pair[1].starts_with("model_providers.codex_monitor.base_url=http://127.0.0.1:")
                && pair[1].ends_with("/v1")
        }));
        assert!(args.windows(2).any(|pair| {
            pair[0] == "-c" && pair[1] == "model_providers.codex_monitor.supports_websockets=false"
        }));
        assert!(args
            .windows(2)
            .any(|pair| { pair[0] == "-c" && pair[1] == "model=kimi-k2.7-code" }));
        assert!(runtime_env.env.iter().any(|(name, value)| {
            name == "CODEX_MONITOR_PROVIDER_KEY"
                && value.starts_with("codex-monitor-")
                && value != "sk-provider"
        }));
    }

    #[test]
    fn active_opencode_profile_requires_explicit_model() {
        let mut settings = AppSettings::default();
        settings.codex_key_profiles = vec![CodexKeyProfile {
            id: "opencode".to_string(),
            name: "OpenCode Zen".to_string(),
            provider_kind: "opencode".to_string(),
            usage_protocol: "auto".to_string(),
            key_env_var: "OPENAI_API_KEY".to_string(),
            key: "sk-provider".to_string(),
            base_url_env_var: "OPENAI_BASE_URL".to_string(),
            base_url: None,
            model: None,
            context_window: None,
            max_output_tokens: None,
            use_gateway: true,
            supports_thinking: false,
            supports_reasoning_effort: false,
            last_model_refresh_at_ms: None,
            cached_models: Vec::new(),
            group_name: None,
        }];
        settings.active_codex_key_profile_id = Some("opencode".to_string());

        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_io()
            .enable_time()
            .build()
            .expect("runtime");
        let error = match runtime.block_on(active_codex_key_runtime(&settings, None)) {
            Ok(_) => panic!("missing model should fail"),
            Err(error) => error,
        };

        assert_eq!(error, "OpenCode profiles require an explicit model");
    }
}
