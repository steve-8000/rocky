//! Vite-style Host header allowlist, ported from
//! `core/packages/server/src/server/hostnames.ts` (`isHostnameAllowed` and
//! helpers). DNS-rebinding protection applied to TCP listeners only.

use std::net::{Ipv4Addr, Ipv6Addr};

use rocky_config::HostnamesConfig;

fn normalize_hostname(hostname: &str) -> String {
    hostname.trim().to_lowercase()
}

/// Parse a hostname out of a raw `Host` header.
///
/// Mirrors `parseHostnameFromHostHeader`: strips `[..]` IPv6 brackets, strips a
/// trailing `:port`, then lowercases/trims. Returns `None` for empty/invalid.
pub fn parse_hostname_from_host_header(host_header: &str) -> Option<String> {
    let trimmed = host_header.trim();
    if trimmed.is_empty() {
        return None;
    }

    // IPv6 in brackets: [::1]:7767
    if let Some(rest) = trimmed.strip_prefix('[') {
        let end = rest.find(']')?;
        return Some(normalize_hostname(&rest[..end]));
    }

    // IPv4/hostname with optional port: localhost:7767
    match trimmed.find(':') {
        None => Some(normalize_hostname(trimmed)),
        Some(idx) => Some(normalize_hostname(&trimmed[..idx])),
    }
}

/// `net.isIP(hostname) !== 0` — true for any valid IPv4 or IPv6 literal.
fn is_ip(hostname: &str) -> bool {
    hostname.parse::<Ipv4Addr>().is_ok() || hostname.parse::<Ipv6Addr>().is_ok()
}

fn matches_hostname_pattern(hostname: &str, pattern: &str) -> bool {
    let normalized = normalize_hostname(pattern);
    if normalized.is_empty() {
        return false;
    }
    if let Some(base) = normalized.strip_prefix('.') {
        if base.is_empty() {
            return false;
        }
        return hostname == base || hostname.ends_with(&format!(".{base}"));
    }
    hostname == normalized
}

fn is_default_allowed_hostname(hostname: &str) -> bool {
    // Vite-style defaults: localhost, *.localhost, and all IP addresses.
    if hostname == "localhost" {
        return true;
    }
    if hostname.ends_with(".localhost") {
        return true;
    }
    is_ip(hostname)
}

/// Vite-style hostname allowlist check, adapted to raw Host headers.
///
/// Mirrors `isHostnameAllowed`:
/// - `hostnames === true` => allow any host.
/// - `hostnames === []`/`undefined` => allow localhost, *.localhost, and IPs.
/// - extra patterns add to the defaults; a pattern starting with '.' matches
///   the base host or any subdomain.
pub fn is_hostname_allowed(host_header: Option<&str>, hostnames: Option<&HostnamesConfig>) -> bool {
    let hostname = match host_header.and_then(parse_hostname_from_host_header) {
        Some(h) => h,
        None => return false,
    };

    if matches!(hostnames, Some(HostnamesConfig::Any(true))) {
        return true;
    }

    if is_default_allowed_hostname(&hostname) {
        return true;
    }

    if let Some(HostnamesConfig::List(patterns)) = hostnames {
        for pattern in patterns {
            if matches_hostname_pattern(&hostname, pattern) {
                return true;
            }
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn true_allows_any() {
        let cfg = HostnamesConfig::Any(true);
        assert!(is_hostname_allowed(Some("evil.com"), Some(&cfg)));
        assert!(is_hostname_allowed(Some("anything:1234"), Some(&cfg)));
    }

    #[test]
    fn default_allows_localhost_and_ips() {
        // undefined / None => defaults.
        assert!(is_hostname_allowed(Some("localhost"), None));
        assert!(is_hostname_allowed(Some("localhost:7767"), None));
        assert!(is_hostname_allowed(Some("app.localhost"), None));
        assert!(is_hostname_allowed(Some("127.0.0.1"), None));
        assert!(is_hostname_allowed(Some("127.0.0.1:7767"), None));
        assert!(is_hostname_allowed(Some("[::1]"), None));
        assert!(is_hostname_allowed(Some("[::1]:7767"), None));
        // empty list behaves like defaults.
        let empty = HostnamesConfig::List(vec![]);
        assert!(is_hostname_allowed(Some("localhost"), Some(&empty)));
        assert!(!is_hostname_allowed(Some("evil.com"), Some(&empty)));
    }

    #[test]
    fn default_rejects_non_local() {
        assert!(!is_hostname_allowed(Some("evil.com"), None));
        assert!(!is_hostname_allowed(Some("example.com:7767"), None));
    }

    #[test]
    fn dot_pattern_matches_base_and_subdomain() {
        let cfg = HostnamesConfig::List(vec![".example.com".to_string()]);
        assert!(is_hostname_allowed(Some("example.com"), Some(&cfg)));
        assert!(is_hostname_allowed(Some("a.example.com"), Some(&cfg)));
        assert!(is_hostname_allowed(Some("a.b.example.com:80"), Some(&cfg)));
        assert!(!is_hostname_allowed(Some("evil.com"), Some(&cfg)));
        assert!(!is_hostname_allowed(Some("notexample.com"), Some(&cfg)));
    }

    #[test]
    fn exact_pattern_matches_only_exact() {
        let cfg = HostnamesConfig::List(vec!["myhost".to_string()]);
        assert!(is_hostname_allowed(Some("myhost"), Some(&cfg)));
        assert!(is_hostname_allowed(Some("MyHost:7767"), Some(&cfg)));
        assert!(!is_hostname_allowed(Some("amyhost"), Some(&cfg)));
    }

    #[test]
    fn missing_or_empty_host_rejected() {
        assert!(!is_hostname_allowed(None, None));
        assert!(!is_hostname_allowed(Some("   "), None));
    }

    #[test]
    fn parses_ipv6_brackets_and_port() {
        assert_eq!(
            parse_hostname_from_host_header("[2001:db8::1]:7767").as_deref(),
            Some("2001:db8::1")
        );
        assert_eq!(
            parse_hostname_from_host_header("LocalHost:7767").as_deref(),
            Some("localhost")
        );
        assert_eq!(parse_hostname_from_host_header("[bad").as_deref(), None);
    }
}
