//! Deterministic service-proxy hostname/label construction.
//!
//! Direct port of the label algorithm in
//! `core/packages/server/src/server/service-proxy.ts`. The hostnames produced
//! here are a compatibility contract: the app/links generate the same labels,
//! so any divergence breaks routing. Every function below mirrors the TS
//! implementation byte-for-byte for the inputs it handles.

use sha2::{Digest, Sha256};
use unicode_normalization::UnicodeNormalization;

/// `MAX_DNS_LABEL_LENGTH` (service-proxy.ts:79).
pub const MAX_DNS_LABEL_LENGTH: usize = 63;
/// `HASH_SUFFIX_LENGTH` (service-proxy.ts:80).
pub const HASH_SUFFIX_LENGTH: usize = 8;

/// Port of `normalizeHostHeader` (service-proxy.ts:94-96):
/// `host.trim().toLowerCase().replace(/:\d+$/, "")`.
///
/// Trims surrounding whitespace, lowercases, and strips a trailing `:<port>`.
pub fn normalize_host_header(host: &str) -> String {
    let trimmed = host.trim().to_lowercase();
    strip_trailing_port(&trimmed)
}

/// Mirror of JS `replace(/:\d+$/, "")`: remove a trailing colon followed by one
/// or more ASCII digits (and nothing else after).
fn strip_trailing_port(value: &str) -> String {
    if let Some(colon) = value.rfind(':') {
        let suffix = &value[colon + 1..];
        if !suffix.is_empty() && suffix.bytes().all(|b| b.is_ascii_digit()) {
            return value[..colon].to_string();
        }
    }
    value.to_string()
}

/// Port of `toHostnameLabel` (service-proxy.ts:98-107).
///
/// ```text
/// value.toLowerCase()
///   .normalize("NFKD")
///   .replace(/[\u0300-\u036f]/g, "")  // strip combining diacritical marks
///   .replace(/[^a-z0-9]+/g, "-")      // collapse non-alphanumerics to '-'
///   .replace(/^-+|-+$/g, "")          // trim leading/trailing '-'
///   || "untitled"
/// ```
pub fn to_hostname_label(value: &str) -> String {
    // toLowerCase + NFKD, then drop combining diacritical marks (U+0300..=U+036F).
    let decomposed: String = value
        .to_lowercase()
        .nfkd()
        .filter(|c| !('\u{0300}'..='\u{036f}').contains(c))
        .collect();

    // Collapse every maximal run of non-[a-z0-9] characters into a single '-'.
    let mut out = String::with_capacity(decomposed.len());
    let mut in_dash = false;
    for ch in decomposed.chars() {
        if ch.is_ascii_lowercase() || ch.is_ascii_digit() {
            out.push(ch);
            in_dash = false;
        } else if !in_dash {
            out.push('-');
            in_dash = true;
        }
    }

    // Trim leading/trailing '-'.
    let trimmed = out.trim_matches('-');
    if trimmed.is_empty() {
        "untitled".to_string()
    } else {
        trimmed.to_string()
    }
}

/// Port of `hashLabel` (service-proxy.ts:109-111): sha256 hex digest, first
/// `HASH_SUFFIX_LENGTH` (8) hex characters.
pub fn hash_label(label: &str) -> String {
    let digest = Sha256::digest(label.as_bytes());
    let hex = hex::encode(digest);
    hex[..HASH_SUFFIX_LENGTH].to_string()
}

/// Port of `capDnsLabel` (service-proxy.ts:113-121).
///
/// Labels within the length limit pass through. Otherwise the label is capped
/// to a `<prefix>--<8-char sha256>` form that stays within
/// `MAX_DNS_LABEL_LENGTH`.
pub fn cap_dns_label(label: &str) -> String {
    if label.chars().count() <= MAX_DNS_LABEL_LENGTH {
        return label.to_string();
    }
    let suffix = hash_label(label);
    // maxPrefixLength = MAX_DNS_LABEL_LENGTH - suffix.length - 2 (for the "--").
    let max_prefix_length = MAX_DNS_LABEL_LENGTH - suffix.len() - 2;
    // label.slice(0, maxPrefixLength) operates on UTF-16 code units in JS; for
    // hostname labels (ascii after to_hostname_label) this equals char/byte
    // slicing. We slice by chars to stay safe.
    let prefix_raw: String = label.chars().take(max_prefix_length).collect();
    let prefix_trimmed = prefix_raw.trim_end_matches('-');
    let prefix = if prefix_trimmed.is_empty() {
        "svc"
    } else {
        prefix_trimmed
    };
    format!("{prefix}--{suffix}")
}

/// Service identity used to build a proxy label.
#[derive(Debug, Clone)]
pub struct ServiceLabelInput<'a> {
    pub project_slug: &'a str,
    pub branch_name: Option<&'a str>,
    pub script_name: &'a str,
}

/// Port of `buildServiceProxyLabel` (service-proxy.ts:123-139).
///
/// Joins `[script, (branch unless default), project]` hostname labels with
/// `--`, then caps to a valid DNS label.
pub fn build_service_proxy_label(input: &ServiceLabelInput<'_>) -> String {
    let mut labels = vec![to_hostname_label(input.script_name)];
    let is_default_branch = matches!(input.branch_name, None | Some("main") | Some("master"));
    if !is_default_branch {
        // Safe: not default implies Some(..).
        labels.push(to_hostname_label(input.branch_name.unwrap()));
    }
    labels.push(to_hostname_label(input.project_slug));
    cap_dns_label(&labels.join("--"))
}

/// Port of `buildLocalServiceHostname` (service-proxy.ts:141-147):
/// `${buildServiceProxyLabel(input)}.localhost`.
pub fn build_local_service_hostname(input: &ServiceLabelInput<'_>) -> String {
    format!("{}.localhost", build_service_proxy_label(input))
}

/// Port of `buildPublicServiceHostname` (service-proxy.ts:149-160):
/// `${buildServiceProxyLabel(service)}.${new URL(publicBaseUrl).hostname}`.
pub fn build_public_service_hostname(input: &ServiceLabelInput<'_>, public_base_url: &str) -> String {
    let base = url_hostname(public_base_url);
    format!("{}.{}", build_service_proxy_label(input), base)
}

/// Extract the lowercased hostname from a URL string, mirroring
/// `new URL(value).hostname`. Handles scheme, userinfo, port, path/query, and
/// bracketed IPv6 literals. Falls back to the trimmed/lowercased input when no
/// scheme is present.
pub fn url_hostname(value: &str) -> String {
    let lower = value.trim().to_lowercase();
    let after_scheme = match lower.split_once("://") {
        Some((_, rest)) => rest,
        None => lower.as_str(),
    };
    // Authority ends at the first '/', '?', or '#'.
    let authority_end = after_scheme
        .find(['/', '?', '#'])
        .unwrap_or(after_scheme.len());
    let authority = &after_scheme[..authority_end];
    // Strip userinfo.
    let host_port = match authority.rsplit_once('@') {
        Some((_, rest)) => rest,
        None => authority,
    };
    // IPv6 literal: keep brackets content, drop any trailing :port.
    if let Some(stripped) = host_port.strip_prefix('[') {
        if let Some(end) = stripped.find(']') {
            return stripped[..end].to_string();
        }
    }
    // Strip :port for the host:port case.
    match host_port.rsplit_once(':') {
        Some((host, port)) if !port.is_empty() && port.bytes().all(|b| b.is_ascii_digit()) => {
            host.to_string()
        }
        _ => host_port.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input<'a>(script: &'a str, branch: Option<&'a str>, project: &'a str) -> ServiceLabelInput<'a> {
        ServiceLabelInput { project_slug: project, branch_name: branch, script_name: script }
    }

    #[test]
    fn normalize_host_header_strips_port_lowercases_trims() {
        assert_eq!(normalize_host_header("  Example.COM:8080 "), "example.com");
        assert_eq!(normalize_host_header("Foo.LOCALHOST"), "foo.localhost");
        assert_eq!(normalize_host_header("host:1"), "host");
        // No trailing :digits -> untouched (after trim/lower).
        assert_eq!(normalize_host_header("HOST:abc"), "host:abc");
        assert_eq!(normalize_host_header("127.0.0.1:3000"), "127.0.0.1");
    }

    #[test]
    fn to_hostname_label_sanitizes() {
        assert_eq!(to_hostname_label("--Foo  Bar!!--"), "foo-bar");
        assert_eq!(to_hostname_label("café app"), "cafe-app");
        assert_eq!(to_hostname_label("!!!"), "untitled");
        assert_eq!(to_hostname_label(""), "untitled");
    }

    #[test]
    fn hash_label_sha256_first_8_hex() {
        // Derived from the TS algorithm (createHash sha256 hex slice(0,8)).
        assert_eq!(hash_label("dev"), "ef260e9a");
        assert_eq!(hash_label(&"a".repeat(80)), "0f45e858");
    }

    #[test]
    fn build_service_proxy_label_matches_ts() {
        // Default branch -> branch omitted.
        assert_eq!(
            build_service_proxy_label(&input("web", Some("main"), "my-project")),
            "web--my-project"
        );
        assert_eq!(
            build_service_proxy_label(&input("web", None, "my-project")),
            "web--my-project"
        );
        assert_eq!(
            build_service_proxy_label(&input("web", Some("master"), "my-project")),
            "web--my-project"
        );
        // Non-default branch -> included and sanitized.
        assert_eq!(
            build_service_proxy_label(&input("Web Server", Some("feature/Foo"), "My Project!!")),
            "web-server--feature-foo--my-project"
        );
        // Diacritics stripped.
        assert_eq!(
            build_service_proxy_label(&input("café app", None, "pröject")),
            "cafe-app--project"
        );
    }

    #[test]
    fn long_labels_capped_to_63_with_hash_suffix() {
        let label = build_service_proxy_label(&input(
            &"s".repeat(30),
            Some(&"b".repeat(30)),
            &"p".repeat(30),
        ));
        assert_eq!(label.len(), 63);
        assert!(label.ends_with("--6f3c8e3f"), "got {label}");
        assert_eq!(
            label,
            "ssssssssssssssssssssssssssssss--bbbbbbbbbbbbbbbbbbbbb--6f3c8e3f"
        );

        // cap_dns_label directly.
        assert_eq!(
            cap_dns_label(&"a".repeat(80)),
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa--0f45e858"
        );
        assert!(cap_dns_label(&"a".repeat(80)).len() <= MAX_DNS_LABEL_LENGTH);
        // Within limit -> unchanged.
        assert_eq!(cap_dns_label("short--label"), "short--label");
    }

    #[test]
    fn build_local_and_public_hostnames() {
        let i = input("web", Some("main"), "my-project");
        assert_eq!(build_local_service_hostname(&i), "web--my-project.localhost");
        assert_eq!(
            build_public_service_hostname(&i, "https://apps.example.com"),
            "web--my-project.apps.example.com"
        );
        assert_eq!(
            build_public_service_hostname(&i, "https://user:pw@Apps.Example.com:8443/path?q=1"),
            "web--my-project.apps.example.com"
        );
    }

    #[test]
    fn url_hostname_parses() {
        assert_eq!(url_hostname("https://apps.example.com:443/x"), "apps.example.com");
        assert_eq!(url_hostname("http://[::1]:8080/"), "::1");
        assert_eq!(url_hostname("example.com"), "example.com");
    }
}
