use std::ffi::c_void;
use std::ptr::{null, null_mut};
use std::time::Duration;

use windows_sys::Win32::Foundation::GlobalFree;
use windows_sys::Win32::Networking::WinHttp::{
    WinHttpCloseHandle, WinHttpGetIEProxyConfigForCurrentUser, WinHttpGetProxyForUrl, WinHttpOpen,
    WinHttpSetTimeouts, WINHTTP_ACCESS_TYPE_NAMED_PROXY, WINHTTP_ACCESS_TYPE_NO_PROXY,
    WINHTTP_AUTOPROXY_AUTO_DETECT, WINHTTP_AUTOPROXY_CONFIG_URL, WINHTTP_AUTOPROXY_OPTIONS,
    WINHTTP_AUTO_DETECT_TYPE_DHCP, WINHTTP_AUTO_DETECT_TYPE_DNS_A,
    WINHTTP_CURRENT_USER_IE_PROXY_CONFIG, WINHTTP_PROXY_INFO,
};

const WINDOWS_PROXY_LOOKUP_TIMEOUT: Duration = Duration::from_secs(8);
const WINHTTP_TIMEOUT_MS: i32 = 5_000;
const MAX_PROXY_SETTING_CHARS: usize = 32_768;

pub(crate) async fn resolve_proxy_for_url(url: String) -> Result<Option<String>, String> {
    let lookup = tokio::task::spawn_blocking(move || resolve_proxy_for_url_blocking(&url));
    match tokio::time::timeout(WINDOWS_PROXY_LOOKUP_TIMEOUT, lookup).await {
        Ok(Ok(result)) => result,
        Ok(Err(_)) => Err("Windows proxy lookup failed.".to_string()),
        Err(_) => Err("Windows proxy lookup timed out.".to_string()),
    }
}

fn resolve_proxy_for_url_blocking(url: &str) -> Result<Option<String>, String> {
    let mut settings = UserProxyConfig(unsafe { std::mem::zeroed() });
    if unsafe { WinHttpGetIEProxyConfigForCurrentUser(&mut settings.0) } == 0 {
        return Err("Unable to read the current user's Windows proxy settings.".to_string());
    }

    let auto_config_url = unsafe { read_wide_string(settings.0.lpszAutoConfigUrl) };
    let static_proxy = unsafe { read_wide_string(settings.0.lpszProxy) };
    let static_bypass = unsafe { read_wide_string(settings.0.lpszProxyBypass) };
    let auto_detect = settings.0.fAutoDetect != 0;

    let auto_proxy = if auto_detect || auto_config_url.is_some() {
        match resolve_automatic_proxy(url, &settings.0, auto_detect) {
            Ok(proxy) => Some(proxy),
            Err(_) => None,
        }
    } else {
        None
    };

    match auto_proxy {
        Some(AutomaticProxyResult::Proxy(proxy)) => return Ok(Some(proxy)),
        Some(AutomaticProxyResult::Direct) => return Ok(None),
        None => {}
    }

    let parsed_url = reqwest::Url::parse(url)
        .map_err(|_| "Invalid update URL while resolving Windows proxy.".to_string())?;
    let Some(host) = parsed_url.host_str() else {
        return Err("Update URL has no host while resolving Windows proxy.".to_string());
    };

    Ok(static_proxy.and_then(|proxy| {
        static_proxy_for_url(&proxy, static_bypass.as_deref().unwrap_or_default(), host)
    }))
}

#[derive(Debug, PartialEq, Eq)]
enum AutomaticProxyResult {
    Direct,
    Proxy(String),
}

fn resolve_automatic_proxy(
    url: &str,
    settings: &WINHTTP_CURRENT_USER_IE_PROXY_CONFIG,
    auto_detect: bool,
) -> Result<AutomaticProxyResult, String> {
    let agent = "ThreadFleet updater";
    let agent = agent
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let session = unsafe { WinHttpOpen(agent.as_ptr(), 1, null(), null(), 0) };
    if session.is_null() {
        return Err("Unable to open Windows proxy resolver.".to_string());
    }
    let session = WinHttpSession(session);
    unsafe {
        WinHttpSetTimeouts(
            session.0,
            WINHTTP_TIMEOUT_MS,
            WINHTTP_TIMEOUT_MS,
            WINHTTP_TIMEOUT_MS,
            WINHTTP_TIMEOUT_MS,
        );
    }

    let mut flags = 0;
    let auto_detect_flags = if auto_detect {
        flags |= WINHTTP_AUTOPROXY_AUTO_DETECT;
        WINHTTP_AUTO_DETECT_TYPE_DHCP | WINHTTP_AUTO_DETECT_TYPE_DNS_A
    } else {
        0
    };
    if !settings.lpszAutoConfigUrl.is_null() {
        flags |= WINHTTP_AUTOPROXY_CONFIG_URL;
    }
    if flags == 0 {
        return Err("Windows has no automatic proxy source for this URL.".to_string());
    }

    let mut options = WINHTTP_AUTOPROXY_OPTIONS {
        dwFlags: flags,
        dwAutoDetectFlags: auto_detect_flags,
        lpszAutoConfigUrl: settings.lpszAutoConfigUrl,
        lpvReserved: null_mut(),
        dwReserved: 0,
        fAutoLogonIfChallenged: 0,
    };
    let url = url
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let mut proxy_info = ProxyInfo(unsafe { std::mem::zeroed() });
    if unsafe { WinHttpGetProxyForUrl(session.0, url.as_ptr(), &mut options, &mut proxy_info.0) }
        == 0
    {
        return Err("Windows automatic proxy resolution failed.".to_string());
    }

    if proxy_info.0.dwAccessType == WINHTTP_ACCESS_TYPE_NO_PROXY {
        return Ok(AutomaticProxyResult::Direct);
    }
    if proxy_info.0.dwAccessType != WINHTTP_ACCESS_TYPE_NAMED_PROXY {
        return Err("Windows returned an unsupported proxy type.".to_string());
    }

    let raw_proxy = unsafe { read_wide_string(proxy_info.0.lpszProxy) }
        .ok_or_else(|| "Windows returned an empty proxy address.".to_string())?;
    parse_auto_proxy_result(&raw_proxy)
        .ok_or_else(|| "Windows returned an unsupported proxy address.".to_string())
}

fn static_proxy_for_url(proxy: &str, bypass: &str, host: &str) -> Option<String> {
    if bypass
        .split(|character| character == ';' || character == ',')
        .map(str::trim)
        .any(|pattern| host_matches_bypass(host, pattern))
    {
        return None;
    }

    match select_https_proxy_entry(proxy)? {
        ProxyEntry::Direct => None,
        ProxyEntry::Address(address) => normalize_proxy_address(address),
    }
}

fn parse_auto_proxy_result(raw: &str) -> Option<AutomaticProxyResult> {
    match select_https_proxy_entry(raw)? {
        ProxyEntry::Direct => Some(AutomaticProxyResult::Direct),
        ProxyEntry::Address(address) => {
            normalize_proxy_address(address).map(AutomaticProxyResult::Proxy)
        }
    }
}

enum ProxyEntry<'a> {
    Direct,
    Address(&'a str),
}

fn select_https_proxy_entry(raw: &str) -> Option<ProxyEntry<'_>> {
    let entries = raw
        .split(|character| character == ';' || character == ',')
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
        .collect::<Vec<_>>();
    if entries.is_empty() {
        return None;
    }

    let has_protocol_mapping = entries.iter().any(|entry| entry.contains('='));
    let selected = if has_protocol_mapping {
        entries
            .iter()
            .filter_map(|entry| entry.split_once('='))
            .find(|(protocol, _)| protocol.trim().eq_ignore_ascii_case("https"))
            .or_else(|| {
                entries
                    .iter()
                    .filter_map(|entry| entry.split_once('='))
                    .find(|(protocol, _)| protocol.trim().eq_ignore_ascii_case("http"))
            })
            .map(|(_, address)| address.trim())?
    } else {
        entries[0]
    };

    if selected.eq_ignore_ascii_case("direct") {
        return Some(ProxyEntry::Direct);
    }
    let address = match selected.split_once(' ') {
        Some((kind, address))
            if ["PROXY", "HTTP", "HTTPS"]
                .iter()
                .any(|supported| kind.eq_ignore_ascii_case(supported)) =>
        {
            address.trim()
        }
        Some((kind, _)) if kind.to_ascii_uppercase().starts_with("SOCKS") => return None,
        _ => selected,
    };
    if address.is_empty() || address.eq_ignore_ascii_case("direct") {
        return None;
    }
    Some(ProxyEntry::Address(address))
}

fn normalize_proxy_address(address: &str) -> Option<String> {
    let address = address.trim();
    let candidate = if address.contains("://") {
        address.to_string()
    } else {
        format!("http://{address}")
    };
    let parsed = reqwest::Url::parse(&candidate).ok()?;
    if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
        return None;
    }
    Some(parsed.to_string())
}

fn host_matches_bypass(host: &str, pattern: &str) -> bool {
    if pattern.is_empty() {
        return false;
    }
    if pattern.eq_ignore_ascii_case("<local>") {
        return !host.contains('.');
    }
    if pattern == "*" {
        return true;
    }
    let normalized_pattern = pattern
        .strip_prefix("*.")
        .or_else(|| pattern.strip_prefix('.'))
        .unwrap_or(pattern);
    host.eq_ignore_ascii_case(normalized_pattern)
        || host
            .to_ascii_lowercase()
            .ends_with(&format!(".{}", normalized_pattern.to_ascii_lowercase()))
}

unsafe fn read_wide_string(value: *const u16) -> Option<String> {
    if value.is_null() {
        return None;
    }
    let mut length = 0;
    while length < MAX_PROXY_SETTING_CHARS && *value.add(length) != 0 {
        length += 1;
    }
    if length == MAX_PROXY_SETTING_CHARS {
        return None;
    }
    Some(String::from_utf16_lossy(std::slice::from_raw_parts(
        value, length,
    )))
}

struct UserProxyConfig(WINHTTP_CURRENT_USER_IE_PROXY_CONFIG);

impl Drop for UserProxyConfig {
    fn drop(&mut self) {
        unsafe {
            free_global_string(self.0.lpszAutoConfigUrl);
            free_global_string(self.0.lpszProxy);
            free_global_string(self.0.lpszProxyBypass);
        }
    }
}

struct ProxyInfo(WINHTTP_PROXY_INFO);

impl Drop for ProxyInfo {
    fn drop(&mut self) {
        unsafe {
            free_global_string(self.0.lpszProxy);
            free_global_string(self.0.lpszProxyBypass);
        }
    }
}

struct WinHttpSession(*mut c_void);

impl Drop for WinHttpSession {
    fn drop(&mut self) {
        unsafe {
            WinHttpCloseHandle(self.0);
        }
    }
}

unsafe fn free_global_string(value: *mut u16) {
    if !value.is_null() {
        GlobalFree(value.cast());
    }
}

#[cfg(test)]
mod tests {
    use super::{
        host_matches_bypass, normalize_proxy_address, parse_auto_proxy_result,
        static_proxy_for_url, AutomaticProxyResult,
    };

    #[test]
    fn uses_the_https_proxy_from_a_pac_result_and_honors_direct() {
        assert_eq!(
            parse_auto_proxy_result("http=proxy-http.local:8080;https=127.0.0.1:7890"),
            Some(AutomaticProxyResult::Proxy(
                "http://127.0.0.1:7890/".to_string()
            ))
        );
        assert_eq!(
            parse_auto_proxy_result("DIRECT;PROXY 127.0.0.1:7890"),
            Some(AutomaticProxyResult::Direct)
        );
    }

    #[test]
    fn honors_static_proxy_protocol_mapping_and_bypass_rules() {
        assert_eq!(
            static_proxy_for_url(
                "http=proxy-http.local:8080;https=proxy-https.local:8443",
                "*.example.com;<local>",
                "updates.example.org",
            ),
            Some("http://proxy-https.local:8443/".to_string())
        );
        assert_eq!(
            static_proxy_for_url("127.0.0.1:7890", "*.example.com;<local>", "api.example.com",),
            None
        );
        assert!(host_matches_bypass("printer", "<local>"));
    }

    #[test]
    fn rejects_non_http_proxy_schemes() {
        assert_eq!(normalize_proxy_address("socks5://127.0.0.1:1080"), None);
    }
}
