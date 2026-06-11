//! Schedule record projection (read-only).
//!
//! Mirrors the schedule schema in
//! `core/packages/protocol/src/schedule/types.ts`:
//! - `ScheduleStatusSchema` (line 4): `["active", "paused", "completed"]`
//! - `ScheduleCadenceSchema` (lines 7-17): discriminated union on `type`
//!   (`"every"` | `"cron"`)
//! - `ScheduleTargetSchema` (lines 20-50): discriminated union on `type`
//!   (`"agent"` | `"new-agent"`)
//! - `ScheduleRunSchema` (lines 53-62)
//! - `StoredScheduleSchema` (lines 65-80)
//!
//! Store layout (`core/packages/server/src/server/schedule/store.ts`): one file
//! per schedule at `$ROCKY_HOME/schedules/{id}.json`, each holding a single
//! `StoredSchedule` object. `ScheduleStore.list` (store.ts lines 22-34) reads
//! every `*.json` entry and sorts by `createdAt` ascending. Parsing here is
//! permissive: unknown fields are ignored and malformed files are skipped.

use std::path::Path;

use serde::{Deserialize, Serialize};

/// Schedule lifecycle status, matching `ScheduleStatusSchema` (types.ts
/// line 4): `["active", "paused", "completed"]`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ScheduleStatus {
    Active,
    Paused,
    Completed,
}

/// Schedule cadence, matching `ScheduleCadenceSchema` (types.ts lines 7-17), a
/// discriminated union on `type` (`"every"` | `"cron"`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum ScheduleCadence {
    Every {
        every_ms: i64,
    },
    Cron {
        expression: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        timezone: Option<String>,
    },
}

/// `new-agent` target config, matching the inline object in
/// `ScheduleTargetSchema` (types.ts lines 26-48). Documented fields are
/// enumerated; opaque sub-blobs (`featureValues`, `extra`, `mcpServers`) are
/// kept as raw JSON.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleNewAgentConfig {
    pub provider: String,
    pub cwd: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thinking_option_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub approval_policy: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sandbox_mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub network_access: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub web_search: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub feature_values: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub extra: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub system_prompt: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mcp_servers: Option<serde_json::Value>,
}

/// Schedule target, matching `ScheduleTargetSchema` (types.ts lines 20-50), a
/// discriminated union on `type` (`"agent"` | `"new-agent"`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case", rename_all_fields = "camelCase")]
pub enum ScheduleTarget {
    Agent {
        agent_id: String,
    },
    NewAgent {
        config: Box<ScheduleNewAgentConfig>,
    },
}

/// Status of one schedule run, matching `ScheduleRunSchema.status` (types.ts
/// line 58): `["running", "succeeded", "failed"]`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ScheduleRunStatus {
    Running,
    Succeeded,
    Failed,
}

/// A single recorded run, matching `ScheduleRunSchema` (types.ts lines 53-62).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleRun {
    pub id: String,
    pub scheduled_for: String,
    pub started_at: String,
    pub ended_at: Option<String>,
    pub status: ScheduleRunStatus,
    pub agent_id: Option<String>,
    pub output: Option<String>,
    pub error: Option<String>,
}

/// A persisted schedule, matching `StoredScheduleSchema` (types.ts
/// lines 65-80).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredSchedule {
    pub id: String,
    pub name: Option<String>,
    pub prompt: String,
    pub cadence: ScheduleCadence,
    pub target: ScheduleTarget,
    pub status: ScheduleStatus,
    pub created_at: String,
    pub updated_at: String,
    pub next_run_at: Option<String>,
    pub last_run_at: Option<String>,
    pub paused_at: Option<String>,
    pub expires_at: Option<String>,
    pub max_runs: Option<i64>,
    pub runs: Vec<ScheduleRun>,
}

fn schedules_dir(rocky_home: &Path) -> std::path::PathBuf {
    rocky_home.join("schedules")
}

/// Read and parse a single schedule file.
///
/// Mirrors `ScheduleStore.get` (store.ts lines 36-47) for the read+parse path.
pub fn read_schedule(path: &Path) -> std::io::Result<StoredSchedule> {
    let raw = std::fs::read_to_string(path)?;
    serde_json::from_str(&raw).map_err(std::io::Error::from)
}

/// List all schedules under `$ROCKY_HOME/schedules/*.json`.
///
/// Mirrors `ScheduleStore.list` (store.ts lines 22-34): every `*.json` file is
/// parsed and the results are sorted by `createdAt` ascending. Missing
/// directory yields an empty vec; unreadable or malformed files are skipped.
pub fn list_schedules(rocky_home: &Path) -> Vec<StoredSchedule> {
    let dir = schedules_dir(rocky_home);
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut schedules: Vec<StoredSchedule> = entries
        .filter_map(|entry| entry.ok())
        .filter(|entry| {
            let path = entry.path();
            path.is_file() && path.extension().is_some_and(|ext| ext == "json")
        })
        .filter_map(|entry| read_schedule(&entry.path()).ok())
        .collect();
    schedules.sort_by(|left, right| left.created_at.cmp(&right.created_at));
    schedules
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    fn every_agent_json() -> &'static str {
        r#"{
          "id": "sched0001",
          "name": "hourly",
          "prompt": "tick",
          "cadence": { "type": "every", "everyMs": 3600000 },
          "target": { "type": "agent", "agentId": "00000000-0000-0000-0000-000000000001" },
          "status": "active",
          "createdAt": "2026-01-01T00:00:00.000Z",
          "updatedAt": "2026-01-01T00:00:00.000Z",
          "nextRunAt": "2026-01-01T01:00:00.000Z",
          "lastRunAt": null,
          "pausedAt": null,
          "expiresAt": null,
          "maxRuns": 10,
          "runs": [
            {
              "id": "run1",
              "scheduledFor": "2026-01-01T00:00:00.000Z",
              "startedAt": "2026-01-01T00:00:01.000Z",
              "endedAt": "2026-01-01T00:00:05.000Z",
              "status": "succeeded",
              "agentId": "00000000-0000-0000-0000-000000000001",
              "output": "done",
              "error": null
            }
          ]
        }"#
    }

    fn cron_new_agent_json() -> &'static str {
        r#"{
          "id": "sched0002",
          "name": null,
          "prompt": "nightly job",
          "cadence": { "type": "cron", "expression": "0 0 * * *", "timezone": "UTC" },
          "target": {
            "type": "new-agent",
            "config": {
              "provider": "claude",
              "cwd": "/work",
              "modeId": "build",
              "model": "sonnet",
              "title": "nightly",
              "networkAccess": true,
              "featureValues": { "flag": 1 },
              "extra": { "codex": { "x": true } },
              "mcpServers": {}
            }
          },
          "status": "paused",
          "createdAt": "2026-01-02T00:00:00.000Z",
          "updatedAt": "2026-01-02T00:00:00.000Z",
          "nextRunAt": null,
          "lastRunAt": null,
          "pausedAt": "2026-01-02T01:00:00.000Z",
          "expiresAt": null,
          "maxRuns": null,
          "runs": []
        }"#
    }

    #[test]
    fn parses_every_agent_schedule() {
        let schedule: StoredSchedule = serde_json::from_str(every_agent_json()).unwrap();
        assert_eq!(schedule.id, "sched0001");
        assert_eq!(schedule.status, ScheduleStatus::Active);
        match schedule.cadence {
            ScheduleCadence::Every { every_ms } => assert_eq!(every_ms, 3_600_000),
            other => panic!("expected every cadence, got {other:?}"),
        }
        match schedule.target {
            ScheduleTarget::Agent { agent_id } => {
                assert_eq!(agent_id, "00000000-0000-0000-0000-000000000001");
            }
            other => panic!("expected agent target, got {other:?}"),
        }
        assert_eq!(schedule.runs.len(), 1);
        assert_eq!(schedule.runs[0].status, ScheduleRunStatus::Succeeded);
    }

    #[test]
    fn parses_cron_new_agent_schedule() {
        let schedule: StoredSchedule = serde_json::from_str(cron_new_agent_json()).unwrap();
        assert_eq!(schedule.status, ScheduleStatus::Paused);
        match schedule.cadence {
            ScheduleCadence::Cron {
                expression,
                timezone,
            } => {
                assert_eq!(expression, "0 0 * * *");
                assert_eq!(timezone.as_deref(), Some("UTC"));
            }
            other => panic!("expected cron cadence, got {other:?}"),
        }
        match schedule.target {
            ScheduleTarget::NewAgent { config } => {
                assert_eq!(config.provider, "claude");
                assert_eq!(config.cwd, "/work");
                assert_eq!(config.mode_id.as_deref(), Some("build"));
                assert_eq!(config.network_access, Some(true));
                assert!(config.feature_values.is_some());
            }
            other => panic!("expected new-agent target, got {other:?}"),
        }
    }

    #[test]
    fn list_sorts_and_skips_malformed() {
        let dir = tempdir().unwrap();
        let schedules = dir.path().join("schedules");
        fs::create_dir_all(&schedules).unwrap();
        // Written out of createdAt order on purpose.
        fs::write(schedules.join("b.json"), cron_new_agent_json()).unwrap();
        fs::write(schedules.join("a.json"), every_agent_json()).unwrap();
        fs::write(schedules.join("bad.json"), "{ not json").unwrap();
        // Non-json file is ignored.
        fs::write(schedules.join("note.txt"), "ignore me").unwrap();

        let listed = list_schedules(dir.path());
        assert_eq!(listed.len(), 2);
        assert_eq!(listed[0].id, "sched0001");
        assert_eq!(listed[1].id, "sched0002");
    }

    #[test]
    fn list_missing_dir_returns_empty() {
        let dir = tempdir().unwrap();
        assert!(list_schedules(dir.path()).is_empty());
    }

    #[test]
    fn unknown_field_is_ignored() {
        let json = every_agent_json().replacen(
            "\"id\": \"sched0001\",",
            "\"id\": \"sched0001\",\n\"futureField\": 42,",
            1,
        );
        let schedule: StoredSchedule = serde_json::from_str(&json).unwrap();
        assert_eq!(schedule.id, "sched0001");
    }

    #[test]
    fn read_schedule_round_trips_from_disk() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("sched0001.json");
        fs::write(&path, every_agent_json()).unwrap();
        let schedule = read_schedule(&path).unwrap();
        assert_eq!(schedule.id, "sched0001");
    }

    #[test]
    fn cadence_variants_round_trip() {
        let every = ScheduleCadence::Every {
            every_ms: 1000,
        };
        let json = serde_json::to_string(&every).unwrap();
        assert_eq!(json, r#"{"type":"every","everyMs":1000}"#);

        let cron = ScheduleCadence::Cron {
            expression: "* * * * *".to_string(),
            timezone: None,
        };
        let json = serde_json::to_string(&cron).unwrap();
        assert_eq!(json, r#"{"type":"cron","expression":"* * * * *"}"#);
    }

    #[test]
    fn target_variants_round_trip() {
        let agent = ScheduleTarget::Agent {
            agent_id: "id".to_string(),
        };
        let json = serde_json::to_string(&agent).unwrap();
        assert_eq!(json, r#"{"type":"agent","agentId":"id"}"#);
        let parsed: ScheduleTarget = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed, agent);
    }
}
