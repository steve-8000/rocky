//! ISO-8601 timestamp helpers matching the JavaScript `Date.toISOString()`
//! format used by the TS schedule/loop services (`YYYY-MM-DDTHH:MM:SS.mmmZ`,
//! always UTC, millisecond precision).

use time::format_description::well_known::Rfc3339;
use time::macros::format_description;
use time::{OffsetDateTime, UtcOffset};

const ISO_MILLIS: &[time::format_description::FormatItem<'_>] = format_description!(
    "[year]-[month]-[day]T[hour]:[minute]:[second].[subsecond digits:3]Z"
);

/// Format an instant as a JS-compatible ISO string (UTC, millisecond
/// precision), mirroring `new Date(...).toISOString()`.
pub(crate) fn to_iso_millis(dt: OffsetDateTime) -> String {
    dt.to_offset(UtcOffset::UTC)
        .format(&ISO_MILLIS)
        .expect("ISO millis format is total for OffsetDateTime")
}

/// Parse an ISO-8601 timestamp into an `OffsetDateTime`, mirroring
/// `new Date(value)`. Accepts the `Z`/offset forms RFC 3339 covers.
pub(crate) fn parse_iso(value: &str) -> Option<OffsetDateTime> {
    OffsetDateTime::parse(value, &Rfc3339).ok()
}
