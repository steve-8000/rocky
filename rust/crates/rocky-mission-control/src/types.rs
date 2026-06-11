//! Rust mirror of the Mission Control protocol schemas in
//! `core/packages/protocol/src/mission/types.ts`.
//!
//! These records are daemon-owned, so fields are explicit (no flatten/extra
//! bucket). serde defaults to ignoring unknown keys, which gives the forward
//! compatibility the brief asks for without dropping required fields.
//!
//! Status/isolation enums use serde renames matching the TS `z.enum` string
//! values exactly (lowercase status words; `read-only` for isolation).

use serde::de::{self, Deserializer};
use serde::ser::Serializer;
use serde::{Deserialize, Serialize};

/// Mission lifecycle status, matching `MissionStatusSchema` (types.ts lines
/// 3-12): `draft|running|blocked|verifying|completed|failed|canceled|archived`.
/// All variants are single lowercase words, so `rename_all = "lowercase"`
/// reproduces the TS string values exactly.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MissionStatus {
    Draft,
    Running,
    Blocked,
    Verifying,
    Completed,
    Failed,
    Canceled,
    Archived,
}

/// Mission task status, matching `MissionTaskStatusSchema` (types.ts lines
/// 14-21): `todo|running|blocked|failed|done|canceled`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MissionTaskStatus {
    Todo,
    Running,
    Blocked,
    Failed,
    Done,
    Canceled,
}

/// Task isolation mode, matching `MissionTaskIsolationSchema` (types.ts line
/// 23): `shared|worktree|read-only`. `kebab-case` yields `read-only` for the
/// two-word variant while leaving the single words unchanged.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum MissionTaskIsolation {
    Shared,
    Worktree,
    ReadOnly,
}

/// Verification kind, matching `MissionVerificationSchema.kind` (types.ts line
/// 26): `command|manual|agent|test`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MissionVerificationKind {
    Command,
    Manual,
    Agent,
    Test,
}

/// A single verification record, matching `MissionVerificationSchema`
/// (types.ts lines 25-31).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MissionVerification {
    pub kind: MissionVerificationKind,
    pub summary: String,
    pub evidence: String,
    pub passed: bool,
    pub timestamp: String,
}

/// A mission task, matching `MissionTaskSchema` (types.ts lines 33-47).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MissionTask {
    pub id: String,
    pub title: String,
    pub description: Option<String>,
    pub acceptance_criteria: Vec<String>,
    pub status: MissionTaskStatus,
    pub owner_agent_id: Option<String>,
    pub roster_agent_id: Option<String>,
    pub worktree_path: Option<String>,
    pub isolation: MissionTaskIsolation,
    pub result: Option<String>,
    pub verification: Vec<MissionVerification>,
    pub created_at: String,
    pub updated_at: String,
}

/// A mission event, matching `MissionEventSchema` (types.ts lines 49-54).
/// `payload` is `z.record(z.unknown())`, i.e. an arbitrary JSON object.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MissionEvent {
    /// `z.number().int().positive()` — seq starts at 1 and increments.
    pub seq: u64,
    pub timestamp: String,
    #[serde(rename = "type")]
    pub event_type: String,
    pub payload: serde_json::Map<String, serde_json::Value>,
}

/// The schema version literal, matching `version: z.literal(1)` in
/// `MissionRecordSchema` (types.ts line 57). Serializes as the bare integer
/// `1` and only deserializes when the on-disk value is exactly `1`, so the
/// daemon never silently accepts a foreign version.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MissionVersion;

impl Default for MissionVersion {
    fn default() -> Self {
        MissionVersion
    }
}

impl Serialize for MissionVersion {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_u64(1)
    }
}

impl<'de> Deserialize<'de> for MissionVersion {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = u64::deserialize(deserializer)?;
        if value == 1 {
            Ok(MissionVersion)
        } else {
            Err(de::Error::custom(format!(
                "unsupported mission version: expected 1, got {value}"
            )))
        }
    }
}

/// A full mission record, matching `MissionRecordSchema` (types.ts lines
/// 56-72). `version` always serializes as the integer literal `1`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MissionRecord {
    #[serde(default)]
    pub version: MissionVersion,
    pub id: String,
    pub goal: String,
    pub status: MissionStatus,
    pub project_id: Option<String>,
    pub workspace_id: Option<String>,
    pub leader_agent_id: Option<String>,
    pub chat_room_id: Option<String>,
    pub board_path: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub completed_at: Option<String>,
    pub archived_at: Option<String>,
    pub tasks: Vec<MissionTask>,
    pub events: Vec<MissionEvent>,
}
