use std::process::Command;
use std::time::Duration;

const MACOS_PROXY_LOOKUP_TIMEOUT: Duration = Duration::from_secs(8);

pub(crate) async fn resolve_proxy_for_url() -> Result<Option<String>, String> {
    let lookup = tokio::task::spawn_blocking(resolve_proxy_blocking);
    match tokio::time::timeout(MACOS_PROXY_LOOKUP_TIMEOUT, lookup).await {
        Ok(Ok(result)) => result,
        Ok(Err(_)) => Err("macOS proxy lookup failed.".to_string()),
        Err(_) => Err("macOS proxy lookup timed out.".to_string()),
    }
}

fn resolve_proxy_blocking() -> Result<Option<String>, String> {
    let output = Command::new("/usr/sbin/scutil")
        .arg("--proxy")
        .output()
        .map_err(|_| "Unable to read the current macOS proxy settings.".to_string())?;
    if !output.status.success() {
        return Err("Unable to read the current macOS proxy settings.".to_string());
    }
    let settings = String::from_utf8_lossy(&output.stdout);
    Ok(parse_proxy_settings(&settings))
}

fn parse_proxy_settings(settings: &str) -> Option<String> {
    proxy_from_settings(settings, "HTTPS")
        .or_else(|| proxy_from_settings(settings, "HTTP"))
}

fn proxy_from_settings(settings: &str, prefix: &str) -> Option<String> {
    let enabled = setting_value(settings, &format!("{prefix}Enable"))?;
    if enabled != "1" {
        return None;
    }
    let host = setting_value(settings, &format!("{prefix}Proxy"))?;
    let port = setting_value(settings, &format!("{prefix}Port"))?
        .parse::<u16>()
        .ok()?;
    if host.is_empty() || port == 0 {
        return None;
    }
    let host = if host.contains(':') && !host.starts_with('[') {
        format!("[{host}]")
    } else {
        host.to_string()
    };
    Some(format!("http://{host}:{port}"))
}

fn setting_value<'a>(settings: &'a str, key: &str) -> Option<&'a str> {
    settings.lines().find_map(|line| {
        let (name, value) = line.split_once(':')?;
        (name.trim() == key).then(|| value.trim())
    })
}

#[cfg(test)]
mod tests {
    use super::parse_proxy_settings;

    #[test]
    fn selects_enabled_https_proxy_from_system_settings() {
        let settings = "HTTPSProxy : 127.0.0.1\nHTTPSPort : 7890\nHTTPSEnable : 1\n";
        assert_eq!(
            parse_proxy_settings(settings).as_deref(),
            Some("http://127.0.0.1:7890")
        );
    }

    #[test]
    fn falls_back_to_http_proxy_and_ignores_disabled_entries() {
        let settings = "HTTPSProxy : 127.0.0.1\nHTTPSPort : 7891\nHTTPSEnable : 0\nHTTPProxy : 127.0.0.1\nHTTPPort : 7890\nHTTPEnable : 1\n";
        assert_eq!(
            parse_proxy_settings(settings).as_deref(),
            Some("http://127.0.0.1:7890")
        );
    }
}
