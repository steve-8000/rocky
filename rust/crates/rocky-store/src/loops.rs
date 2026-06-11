//! Loop record projection (read-only).
//!
//! Mirrors the persisted loop store written by
//! `core/packages/server/src/server/loop-service.ts`:
//! - `LoopVerifyPromptSchema` (lines 28-31)
//! - `LoopLogEntrySchema` (lines 33-40)
//! - `LoopVerifyCheckResultSchema` (lines 42-50)
//! - `LoopVerifyPromptResultSchema` (lines 52-58)
//! - `LoopIterationRecordSchema` (lines 60-71)
//! - `LoopRecordSchema` (lines 73-104)
//! - `StoredLoopsSchema = z.array(LoopRecordSchema)` (line 106)
//!
//! On-disk file: `$ROCKY_HOME/loops/loops.json` (a bare JSON array), per
//! `LoopService` constructor `path.join(rockyHome, "loops", "loops.json")`
//! (line 317). Parsing is permissive: unknown fields are ignored and malformed
//! entries are skipped best-effort.

use std::path::Path;

use serde::{Deserialize, Serialize};

/// Loop lifecycle status, matching the `status` enum in `LoopRecordSchema`
/// and `LoopIterationRecordSchema` (loop-service.ts lines 92 / 66):
/// `["running", "succeeded", "failed", "stopped"]`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LoopStatus {
    Running,
    Succeeded,
    Failed,
    Stopped,
}

/// Source of a log entry, matching `LoopLogEntrySchema.source`
/// (loop-service.ts line 37): `["loop", "worker", "verifier", "verify-check"]`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum LoopLogSource {
    Loop,
    Worker,
    Verifier,
    VerifyCheck,
}

/// Severity of a log entry, matching `LoopLogEntrySchema.level`
/// (loop-service.ts line 38): `["info", "error"]`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LoopLogLevel {
    Info,
    Error,
}

/// Worker outcome, matching `LoopIterationRecordSchema.workerOutcome`
/// (loop-service.ts line 67): `["completed", "failed", "canceled"]`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LoopWorkerOutcome {
    Completed,
    Failed,
    Canceled,
}

/// One persisted log line, matching `LoopLogEntrySchema` (loop-service.ts
/// lines 33-40).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoopLogEntry {
    pub seq: i64,
    pub timestamp: String,
    pub iteration: Option<i64>,
    pub source: LoopLogSource,
    pub level: LoopLogLevel,
    pub text: String,
}

/// One verify-check command result, matching `LoopVerifyCheckResultSchema`
/// (loop-service.ts lines 42-50).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoopVerifyCheckResult {
    pub command: String,
    pub exit_code: i64,
    pub passed: bool,
    pub stdout: String,
    pub stderr: String,
    pub started_at: String,
    pub completed_at: String,
}

/// Verifier-prompt result, matching `LoopVerifyPromptResultSchema`
/// (loop-service.ts lines 52-58).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoopVerifyPromptResult {
    pub passed: bool,
    pub reason: String,
    pub verifier_agent_id: Option<String>,
    pub started_at: String,
    pub completed_at: String,
}

/// One loop iteration, matching `LoopIterationRecordSchema` (loop-service.ts
/// lines 60-71).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoopIterationRecord {
    pub index: i64,
    pub worker_agent_id: Option<String>,
    pub worker_started_at: String,
    pub worker_completed_at: Option<String>,
    pub verifier_agent_id: Option<String>,
    pub status: LoopStatus,
    pub worker_outcome: Option<LoopWorkerOutcome>,
    pub failure_reason: Option<String>,
    pub verify_checks: Vec<LoopVerifyCheckResult>,
    pub verify_prompt: Option<LoopVerifyPromptResult>,
}

/// A full loop record, matching `LoopRecordSchema` (loop-service.ts
/// lines 73-104).
///
/// Optional/nullable TS fields map to `Option`; `mode_id` and `verifier_mode_id`
/// default to `null` in TS (`.nullable().default(null)`) so they are tolerated
/// when absent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoopRecord {
    pub id: String,
    pub name: Option<String>,
    pub prompt: String,
    pub cwd: String,
    pub provider: String,
    pub model: Option<String>,
    #[serde(default)]
    pub mode_id: Option<String>,
    pub worker_provider: Option<String>,
    pub worker_model: Option<String>,
    pub verifier_provider: Option<String>,
    pub verifier_model: Option<String>,
    #[serde(default)]
    pub verifier_mode_id: Option<String>,
    pub verify_prompt: Option<String>,
    pub verify_checks: Vec<String>,
    pub archive: bool,
    pub sleep_ms: i64,
    pub max_iterations: Option<i64>,
    pub max_time_ms: Option<i64>,
    pub status: LoopStatus,
    pub created_at: String,
    pub updated_at: String,
    pub started_at: String,
    pub completed_at: Option<String>,
    pub stop_requested_at: Option<String>,
    pub iterations: Vec<LoopIterationRecord>,
    pub logs: Vec<LoopLogEntry>,
    pub next_log_seq: i64,
    pub active_iteration: Option<i64>,
    pub active_worker_agent_id: Option<String>,
    pub active_verifier_agent_id: Option<String>,
}

/// Compact projection of a loop, mirroring the `LoopListItem` shape used by the
/// TS loop service (loop-service.ts lines 135-143), reduced to the fields this
/// crate needs for list views.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoopListItem {
    pub id: String,
    pub name: Option<String>,
    pub status: LoopStatus,
}

impl LoopRecord {
    /// Project this record to a `LoopListItem`.
    pub fn to_list_item(&self) -> LoopListItem {
        LoopListItem {
            id: self.id.clone(),
            name: self.name.clone(),
            status: self.status,
        }
    }
}

fn loops_path(rocky_home: &Path) -> std::path::PathBuf {
    rocky_home.join("loops").join("loops.json")
}

/// Read all loop records from `$ROCKY_HOME/loops/loops.json`.
///
/// Mirrors `LoopService.load` (loop-service.ts lines 317-362): the file is a
/// bare JSON array (`StoredLoopsSchema`). Returns an empty vec when the file is
/// missing or unreadable. Parsing is best-effort: the whole array is parsed
/// first, and if that fails the array is re-parsed element-wise so malformed
/// entries are skipped rather than discarding every record.
pub fn read_loops(rocky_home: &Path) -> Vec<LoopRecord> {
    let path = loops_path(rocky_home);
    let Ok(raw) = std::fs::read_to_string(&path) else {
        return Vec::new();
    };
    parse_loops(&raw)
}

fn parse_loops(raw: &str) -> Vec<LoopRecord> {
    if let Ok(records) = serde_json::from_str::<Vec<LoopRecord>>(raw) {
        return records;
    }
    // Fall back to element-wise parsing, skipping malformed entries.
    match serde_json::from_str::<Vec<serde_json::Value>>(raw) {
        Ok(values) => values
            .into_iter()
            .filter_map(|value| serde_json::from_value::<LoopRecord>(value).ok())
            .collect(),
        Err(_) => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    fn full_record_json() -> &'static str {
        r#"{
          "id": "abc12345",
          "name": "nightly",
          "prompt": "do the thing",
          "cwd": "/work",
          "provider": "claude",
          "model": "sonnet",
          "modeId": null,
          "workerProvider": "claude",
          "workerModel": "sonnet",
          "verifierProvider": "claude",
          "verifierModel": "opus",
          "verifierModeId": "review",
          "verifyPrompt": "is it done?",
          "verifyChecks": ["cargo test", "cargo clippy"],
          "archive": false,
          "sleepMs": 1000,
          "maxIterations": 5,
          "maxTimeMs": 60000,
          "status": "running",
          "createdAt": "2026-01-01T00:00:00.000Z",
          "updatedAt": "2026-01-01T00:01:00.000Z",
          "startedAt": "2026-01-01T00:00:01.000Z",
          "completedAt": null,
          "stopRequestedAt": null,
          "iterations": [
            {
              "index": 1,
              "workerAgentId": "w1",
              "workerStartedAt": "2026-01-01T00:00:02.000Z",
              "workerCompletedAt": "2026-01-01T00:00:30.000Z",
              "verifierAgentId": "v1",
              "status": "succeeded",
              "workerOutcome": "completed",
              "failureReason": null,
              "verifyChecks": [
                {
                  "command": "cargo test",
                  "exitCode": 0,
                  "passed": true,
                  "stdout": "ok",
                  "stderr": "",
                  "startedAt": "2026-01-01T00:00:31.000Z",
                  "completedAt": "2026-01-01T00:00:40.000Z"
                }
              ],
              "verifyPrompt": {
                "passed": true,
                "reason": "looks good",
                "verifierAgentId": "v1",
                "startedAt": "2026-01-01T00:00:41.000Z",
                "completedAt": "2026-01-01T00:00:45.000Z"
              }
            }
          ],
          "logs": [
            {
              "seq": 1,
              "timestamp": "2026-01-01T00:00:01.000Z",
              "iteration": null,
              "source": "loop",
              "level": "info",
              "text": "started"
            },
            {
              "seq": 2,
              "timestamp": "2026-01-01T00:00:42.000Z",
              "iteration": 1,
              "source": "verify-check",
              "level": "error",
              "text": "boom"
            }
          ],
          "nextLogSeq": 3,
          "activeIteration": 1,
          "activeWorkerAgentId": "w1",
          "activeVerifierAgentId": null
        }"#
    }

    fn minimal_record_json() -> &'static str {
        r#"{
          "id": "min00001",
          "name": null,
          "prompt": "p",
          "cwd": "/",
          "provider": "claude",
          "model": null,
          "workerProvider": null,
          "workerModel": null,
          "verifierProvider": null,
          "verifierModel": null,
          "verifyPrompt": null,
          "verifyChecks": [],
          "archive": true,
          "sleepMs": 0,
          "maxIterations": null,
          "maxTimeMs": null,
          "status": "stopped",
          "createdAt": "2026-01-02T00:00:00.000Z",
          "updatedAt": "2026-01-02T00:00:00.000Z",
          "startedAt": "2026-01-02T00:00:00.000Z",
          "completedAt": null,
          "stopRequestedAt": null,
          "iterations": [],
          "logs": [],
          "nextLogSeq": 1,
          "activeIteration": null,
          "activeWorkerAgentId": null,
          "activeVerifierAgentId": null
        }"#
    }

    #[test]
    fn parses_full_and_minimal_records() {
        let json = format!("[{},{}]", full_record_json(), minimal_record_json());
        let records = parse_loops(&json);
        assert_eq!(records.len(), 2);

        let full = &records[0];
        assert_eq!(full.id, "abc12345");
        assert_eq!(full.name.as_deref(), Some("nightly"));
        assert_eq!(full.status, LoopStatus::Running);
        assert_eq!(full.mode_id, None);
        assert_eq!(full.verifier_mode_id.as_deref(), Some("review"));
        assert_eq!(full.iterations.len(), 1);
        let iter = &full.iterations[0];
        assert_eq!(iter.status, LoopStatus::Succeeded);
        assert_eq!(iter.worker_outcome, Some(LoopWorkerOutcome::Completed));
        assert_eq!(iter.verify_checks.len(), 1);
        assert_eq!(iter.verify_checks[0].exit_code, 0);
        assert!(iter.verify_prompt.as_ref().unwrap().passed);
        assert_eq!(full.logs.len(), 2);
        assert_eq!(full.logs[0].source, LoopLogSource::Loop);
        assert_eq!(full.logs[0].level, LoopLogLevel::Info);
        assert_eq!(full.logs[1].source, LoopLogSource::VerifyCheck);
        assert_eq!(full.logs[1].level, LoopLogLevel::Error);

        let min = &records[1];
        assert_eq!(min.name, None);
        assert_eq!(min.status, LoopStatus::Stopped);
        assert_eq!(min.mode_id, None);
    }

    #[test]
    fn missing_file_returns_empty() {
        let dir = tempdir().unwrap();
        assert!(read_loops(dir.path()).is_empty());
    }

    #[test]
    fn reads_from_disk() {
        let dir = tempdir().unwrap();
        fs::create_dir_all(dir.path().join("loops")).unwrap();
        let json = format!("[{}]", minimal_record_json());
        fs::write(dir.path().join("loops").join("loops.json"), json).unwrap();
        let records = read_loops(dir.path());
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].id, "min00001");
    }

    #[test]
    fn unknown_field_is_ignored() {
        let json = minimal_record_json().replacen(
            "\"id\": \"min00001\",",
            "\"id\": \"min00001\",\n\"futureField\": {\"nested\": true},",
            1,
        );
        let records = parse_loops(&format!("[{json}]"));
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].id, "min00001");
    }

    #[test]
    fn skips_malformed_entries_element_wise() {
        let json = format!("[{},{{\"broken\":true}}]", minimal_record_json());
        let records = parse_loops(&json);
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].id, "min00001");
    }

    #[test]
    fn status_enum_round_trips() {
        for (status, text) in [
            (LoopStatus::Running, "\"running\""),
            (LoopStatus::Succeeded, "\"succeeded\""),
            (LoopStatus::Failed, "\"failed\""),
            (LoopStatus::Stopped, "\"stopped\""),
        ] {
            let serialized = serde_json::to_string(&status).unwrap();
            assert_eq!(serialized, text);
            let parsed: LoopStatus = serde_json::from_str(text).unwrap();
            assert_eq!(parsed, status);
        }
    }

    #[test]
    fn list_item_projection() {
        let json = format!("[{}]", full_record_json());
        let records = parse_loops(&json);
        let item = records[0].to_list_item();
        assert_eq!(item.id, "abc12345");
        assert_eq!(item.name.as_deref(), Some("nightly"));
        assert_eq!(item.status, LoopStatus::Running);
    }
}
