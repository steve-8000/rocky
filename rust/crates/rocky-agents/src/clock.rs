//! Daemon-owned ISO8601 millisecond timestamps.
//!
//! Mirrors the helper style in `rocky-store`'s `pid_lock::now_iso8601` /
//! `trim_to_millis` (Node `Date#toISOString()`: millisecond precision, trailing
//! `Z`). Kept local here rather than re-exported from `rocky-store` to avoid
//! widening that crate's public surface.

use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;

/// Current UTC time as an ISO8601 string with millisecond precision and a
/// trailing `Z`, e.g. `2026-06-11T23:14:49.406Z`.
pub fn now_iso8601() -> String {
    let now = OffsetDateTime::now_utc();
    let full = now
        .format(&Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_string());
    trim_to_millis(&full)
}

/// Trim an RFC3339 timestamp's fractional seconds to exactly three digits,
/// matching `Date#toISOString()`. Copied from `rocky-store/pid_lock` per the
/// task brief (kept local; `rocky-store` is not edited).
pub fn trim_to_millis(rfc3339: &str) -> String {
    if let Some(dot) = rfc3339.find('.') {
        let suffix_start = rfc3339[dot..]
            .find(['Z', '+', '-'])
            .map(|i| dot + i)
            .unwrap_or(rfc3339.len());
        let frac = &rfc3339[dot + 1..suffix_start];
        let millis: String = frac.chars().take(3).collect();
        let millis = format!("{millis:0<3}");
        let suffix = &rfc3339[suffix_start..];
        format!("{}.{}{}", &rfc3339[..dot], millis, suffix)
    } else {
        rfc3339.to_string()
    }
}
