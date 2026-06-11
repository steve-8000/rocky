//! Cron / cadence next-run computation.
//!
//! Direct port of `core/packages/server/src/server/schedule/cron.ts`:
//! - `parseField` (cron.ts lines 19-74): each field is a comma list of
//!   `*`, a single value, or `a-b` ranges, any of which may carry a `/step`.
//! - `parseCronExpression` (cron.ts lines 92-105): exactly 5 whitespace
//!   separated fields — minute(0-59), hour(0-23), day-of-month(1-31),
//!   month(1-12), day-of-week(0-6, Sunday=0). No seconds field.
//! - `computeNextRunAt` (cron.ts lines 183-210): `every` => `after + everyMs`;
//!   `cron` => starting from `startOfNextMinute(after)` (cron.ts lines 107-119)
//!   step minute-by-minute up to `366 * 24 * 60` iterations and return the
//!   first instant whose wall-clock parts match every field.
//! - Timezone handling (cron.ts lines 129-172): absent timezone => UTC parts;
//!   present => IANA local wall-clock (`Intl.DateTimeFormat` h23), with
//!   day-of-week derived from the local calendar date.

use rocky_store::ScheduleCadence;
use time::{Duration, OffsetDateTime};
use time_tz::{timezones, OffsetDateTimeExt};

/// Maximum number of minute steps to scan, matching `limit = 366 * 24 * 60`.
const SCAN_LIMIT: u32 = 366 * 24 * 60;

#[derive(Debug, thiserror::Error)]
pub enum CronError {
    #[error("Cron expressions must have 5 fields")]
    FieldCount,
    #[error("Invalid cron {0} field")]
    Field(&'static str),
    #[error("Invalid cron {0} step")]
    Step(&'static str),
    #[error("Invalid cron {0} range")]
    Range(&'static str),
    #[error("Invalid cron {0} value")]
    Value(&'static str),
    #[error("Invalid cron time zone: {0}")]
    TimeZone(String),
    #[error("Unable to compute next run time for cron expression: {0}")]
    Unresolved(String),
}

struct FieldMatcher {
    allowed: Vec<bool>,
    min: u8,
}

impl FieldMatcher {
    fn matches(&self, value: u8) -> bool {
        if value < self.min {
            return false;
        }
        let idx = (value - self.min) as usize;
        self.allowed.get(idx).copied().unwrap_or(false)
    }
}

struct Bounds {
    min: u8,
    max: u8,
    name: &'static str,
}

/// Port of `parseField` (cron.ts lines 19-74).
fn parse_field(source: &str, bounds: &Bounds) -> Result<FieldMatcher, CronError> {
    let trimmed = source.trim();
    if trimmed.is_empty() {
        return Err(CronError::Field(bounds.name));
    }

    let span = (bounds.max - bounds.min + 1) as usize;
    let mut allowed = vec![false; span];
    let set = |value: u8, allowed: &mut [bool]| {
        allowed[(value - bounds.min) as usize] = true;
    };

    for raw_part in trimmed.split(',') {
        let part = raw_part.trim();
        if part.is_empty() {
            return Err(CronError::Field(bounds.name));
        }

        let mut split = part.splitn(2, '/');
        let base = split.next().unwrap_or("");
        let step = match split.next() {
            None => 1i64,
            Some(step_src) => parse_int(step_src).ok_or(CronError::Step(bounds.name))?,
        };
        if step <= 0 {
            return Err(CronError::Step(bounds.name));
        }

        if base == "*" {
            range_values(bounds.min, bounds.max, step, |v| set(v, &mut allowed));
            continue;
        }

        if let Some((start_s, end_s)) = parse_range(base) {
            let start = parse_int(start_s).ok_or(CronError::Range(bounds.name))?;
            let end = parse_int(end_s).ok_or(CronError::Range(bounds.name))?;
            if start > end || start < bounds.min as i64 || end > bounds.max as i64 {
                return Err(CronError::Range(bounds.name));
            }
            range_values(start as u8, end as u8, step, |v| set(v, &mut allowed));
            continue;
        }

        let value = parse_int(base).ok_or(CronError::Value(bounds.name))?;
        if value < bounds.min as i64 || value > bounds.max as i64 {
            return Err(CronError::Value(bounds.name));
        }
        set(value as u8, &mut allowed);
    }

    Ok(FieldMatcher {
        allowed,
        min: bounds.min,
    })
}

/// Mirror `Number.parseInt(s, 10)` for the non-negative integers cron uses:
/// require the string to be all ASCII digits (after the JS impl never produces
/// signs here) and parse into an `i64`.
fn parse_int(s: &str) -> Option<i64> {
    if s.is_empty() || !s.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    s.parse::<i64>().ok()
}

/// Match the regex `^(\d+)-(\d+)$` from cron.ts line 47.
fn parse_range(base: &str) -> Option<(&str, &str)> {
    let (a, b) = base.split_once('-')?;
    if a.is_empty()
        || b.is_empty()
        || !a.bytes().all(|c| c.is_ascii_digit())
        || !b.bytes().all(|c| c.is_ascii_digit())
    {
        return None;
    }
    Some((a, b))
}

/// Port of `createRange` (cron.ts lines 11-17): `start..=end` stepping by
/// `step`. Values are passed to `sink`.
fn range_values(start: u8, end: u8, step: i64, mut sink: impl FnMut(u8)) {
    let mut value = start as i64;
    while value <= end as i64 {
        sink(value as u8);
        value += step;
    }
}

struct ParsedCron {
    minute: FieldMatcher,
    hour: FieldMatcher,
    day_of_month: FieldMatcher,
    month: FieldMatcher,
    day_of_week: FieldMatcher,
}

/// Port of `parseCronExpression` (cron.ts lines 92-105).
fn parse_cron_expression(expression: &str) -> Result<ParsedCron, CronError> {
    let parts: Vec<&str> = expression.split_whitespace().collect();
    if parts.len() != 5 {
        return Err(CronError::FieldCount);
    }
    Ok(ParsedCron {
        minute: parse_field(parts[0], &Bounds { min: 0, max: 59, name: "minute" })?,
        hour: parse_field(parts[1], &Bounds { min: 0, max: 23, name: "hour" })?,
        day_of_month: parse_field(parts[2], &Bounds { min: 1, max: 31, name: "day-of-month" })?,
        month: parse_field(parts[3], &Bounds { min: 1, max: 12, name: "month" })?,
        day_of_week: parse_field(parts[4], &Bounds { min: 0, max: 6, name: "day-of-week" })?,
    })
}

/// Validate a cadence the way `validateScheduleCadence` (cron.ts lines 174-181)
/// does: cron expressions must parse and any timezone must be a known IANA zone.
pub fn validate_cadence(cadence: &ScheduleCadence) -> Result<(), CronError> {
    if let ScheduleCadence::Cron { expression, timezone } = cadence {
        parse_cron_expression(expression)?;
        if let Some(tz) = timezone {
            resolve_tz(tz)?;
        }
    }
    Ok(())
}

fn resolve_tz(name: &str) -> Result<&'static time_tz::Tz, CronError> {
    timezones::get_by_name(name).ok_or_else(|| CronError::TimeZone(name.to_string()))
}

struct DateParts {
    minute: u8,
    hour: u8,
    day_of_month: u8,
    month: u8,
    day_of_week: u8,
}

fn parts_for(instant: OffsetDateTime, tz: Option<&'static time_tz::Tz>) -> DateParts {
    let local = match tz {
        Some(zone) => instant.to_timezone(zone),
        None => instant.to_offset(time::UtcOffset::UTC),
    };
    DateParts {
        minute: local.minute(),
        hour: local.hour(),
        day_of_month: local.day(),
        month: local.month() as u8,
        day_of_week: local.weekday().number_days_from_sunday(),
    }
}

/// Port of `startOfNextMinute` (cron.ts lines 107-119): truncate to the start
/// of the minute (UTC) and advance by one minute.
fn start_of_next_minute(after: OffsetDateTime) -> OffsetDateTime {
    let utc = after.to_offset(time::UtcOffset::UTC);
    let truncated = utc
        .replace_second(0)
        .expect("0 is a valid second")
        .replace_nanosecond(0)
        .expect("0 is a valid nanosecond");
    truncated + Duration::minutes(1)
}

/// Compute the next run instant strictly after `after`.
///
/// Port of `computeNextRunAt` (cron.ts lines 183-210). For `every`, returns
/// `after + everyMs`. For `cron`, parses the expression and scans forward
/// minute-by-minute (UTC instants, wall-clock matching) until a match is found
/// or the `366 * 24 * 60` minute scan limit is exhausted. `tz` overrides the
/// timezone used for wall-clock matching (callers pass the cadence timezone);
/// `None` means UTC.
pub fn next_run_after(
    cadence: &ScheduleCadence,
    after: OffsetDateTime,
    tz: Option<&str>,
) -> Result<OffsetDateTime, CronError> {
    match cadence {
        ScheduleCadence::Every { every_ms } => Ok(after + Duration::milliseconds(*every_ms)),
        ScheduleCadence::Cron { expression, .. } => {
            let cron = parse_cron_expression(expression)?;
            let zone = match tz {
                Some(name) => Some(resolve_tz(name)?),
                None => None,
            };
            let mut cursor = start_of_next_minute(after);
            for _ in 0..SCAN_LIMIT {
                let parts = parts_for(cursor, zone);
                if cron.minute.matches(parts.minute)
                    && cron.hour.matches(parts.hour)
                    && cron.day_of_month.matches(parts.day_of_month)
                    && cron.month.matches(parts.month)
                    && cron.day_of_week.matches(parts.day_of_week)
                {
                    return Ok(cursor);
                }
                cursor += Duration::minutes(1);
            }
            Err(CronError::Unresolved(expression.clone()))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use time::macros::datetime;

    fn cron(expr: &str, tz: Option<&str>) -> ScheduleCadence {
        ScheduleCadence::Cron {
            expression: expr.to_string(),
            timezone: tz.map(str::to_string),
        }
    }

    #[test]
    fn every_adds_milliseconds() {
        let after = datetime!(2026-01-01 00:00:00 UTC);
        let next = next_run_after(&ScheduleCadence::Every { every_ms: 3_600_000 }, after, None)
            .unwrap();
        assert_eq!(next, datetime!(2026-01-01 01:00:00 UTC));
    }

    #[test]
    fn hourly_cron_returns_next_top_of_hour() {
        // '0 * * * *' after 00:30 => 01:00 UTC.
        let after = datetime!(2026-01-01 00:30:00 UTC);
        let next = next_run_after(&cron("0 * * * *", None), after, None).unwrap();
        assert_eq!(next, datetime!(2026-01-01 01:00:00 UTC));
    }

    #[test]
    fn cron_on_exact_minute_advances_to_next() {
        // startOfNextMinute always advances at least one minute, so 01:00 -> 02:00.
        let after = datetime!(2026-01-01 01:00:00 UTC);
        let next = next_run_after(&cron("0 * * * *", None), after, None).unwrap();
        assert_eq!(next, datetime!(2026-01-01 02:00:00 UTC));
    }

    #[test]
    fn daily_midnight_cron() {
        // '0 0 * * *' after midday => next midnight UTC.
        let after = datetime!(2026-01-01 12:00:00 UTC);
        let next = next_run_after(&cron("0 0 * * *", Some("UTC")), after, Some("UTC")).unwrap();
        assert_eq!(next, datetime!(2026-01-02 00:00:00 UTC));
    }

    #[test]
    fn timezone_wall_clock_midnight() {
        // '0 0 * * *' in America/New_York: local midnight = 05:00 UTC (EST).
        let after = datetime!(2026-01-01 12:00:00 UTC);
        let next = next_run_after(
            &cron("0 0 * * *", Some("America/New_York")),
            after,
            Some("America/New_York"),
        )
        .unwrap();
        assert_eq!(next, datetime!(2026-01-02 05:00:00 UTC));
    }

    #[test]
    fn step_and_range_fields() {
        // Every 15 minutes: after 00:07 => 00:15.
        let after = datetime!(2026-01-01 00:07:00 UTC);
        let next = next_run_after(&cron("*/15 * * * *", None), after, None).unwrap();
        assert_eq!(next, datetime!(2026-01-01 00:15:00 UTC));
    }

    #[test]
    fn day_of_week_match() {
        // '0 0 * * 1' => next Monday 00:00. 2026-01-01 is a Thursday.
        let after = datetime!(2026-01-01 00:00:00 UTC);
        let next = next_run_after(&cron("0 0 * * 1", None), after, None).unwrap();
        // First Monday after Jan 1 2026 is Jan 5.
        assert_eq!(next, datetime!(2026-01-05 00:00:00 UTC));
    }

    #[test]
    fn rejects_wrong_field_count() {
        let err = validate_cadence(&cron("0 0 * *", None)).unwrap_err();
        assert!(matches!(err, CronError::FieldCount));
    }

    #[test]
    fn rejects_unknown_timezone() {
        let err = validate_cadence(&cron("0 0 * * *", Some("Mars/Phobos"))).unwrap_err();
        assert!(matches!(err, CronError::TimeZone(_)));
    }
}
