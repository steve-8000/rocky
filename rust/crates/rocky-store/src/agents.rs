//! Agent record projection (read-only).
//!
//! Mirrors `core/packages/server/src/server/agent/agent-storage.ts`:
//! - `STORED_AGENT_SCHEMA` (lines 35-66) and the nested
//!   `SERIALIZABLE_CONFIG_SCHEMA` / `PERSISTENCE_HANDLE_SCHEMA` / runtime-info
//!   schemas (lines 12-33, 48-57).
//! - `projectDirNameFromCwd` (lines 377-388).
//!
//! `AgentStatus` mirrors `AGENT_LIFECYCLE_STATUSES` in
//! `core/packages/protocol/src/agent-lifecycle.ts` (used by `AgentStatusSchema`
//! in `core/packages/protocol/src/messages.ts`).
//!
//! Parsing is permissive: unknown fields are ignored (no
//! `deny_unknown_fields`), so newer on-disk records still load. Complex/opaque
//! sub-objects are preserved as `serde_json::Value` to avoid dropping detail.

use std::collections::BTreeMap;
use std::path::Path;

use serde::{Deserialize, Serialize};

/// Agent lifecycle status.
///
/// Mirrors `AGENT_LIFECYCLE_STATUSES` in
/// `core/packages/protocol/src/agent-lifecycle.ts`:
/// `initializing | idle | running | error | closed`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentStatus {
    Initializing,
    Idle,
    Running,
    Error,
    Closed,
}

/// Default `lastStatus`, matching `AgentStatusSchema.default("closed")`.
fn default_agent_status() -> AgentStatus {
    AgentStatus::Closed
}

/// Reason an agent requires attention.
///
/// Mirrors `attentionReason: z.enum(["finished", "error", "permission"])`
/// (agent-storage.ts line 62).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AttentionReason {
    Finished,
    Error,
    Permission,
}

/// Subset of `AgentSessionConfig` persisted with a stored agent.
///
/// Mirrors `SERIALIZABLE_CONFIG_SCHEMA` (agent-storage.ts lines 12-23). All
/// fields are nullable+optional; opaque records are kept as raw JSON.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SerializableAgentConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thinking_option_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub feature_values: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub extra: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub system_prompt: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mcp_servers: Option<serde_json::Value>,
}

/// Runtime info attached to a stored agent.
///
/// Mirrors the inline `runtimeInfo` schema (agent-storage.ts lines 48-57).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeInfo {
    pub provider: String,
    // `sessionId: z.string().nullable()` — nullable but not optional in TS.
    pub session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thinking_option_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub extra: Option<serde_json::Value>,
}

/// Provider persistence handle.
///
/// Mirrors `PERSISTENCE_HANDLE_SCHEMA` (agent-storage.ts lines 25-33).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistenceHandle {
    pub provider: String,
    pub session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub native_handle: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata: Option<serde_json::Value>,
}

/// Persisted agent record.
///
/// Mirrors `STORED_AGENT_SCHEMA` (agent-storage.ts lines 35-66). The
/// `features` union (`AgentFeatureSchema[]`) is kept as raw JSON values to
/// avoid dropping provider-specific detail.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredAgentRecord {
    pub id: String,
    pub provider: String,
    pub cwd: String,
    pub created_at: String,
    pub updated_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_activity_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_user_message_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// `z.record(z.string()).default({})`.
    #[serde(default)]
    pub labels: BTreeMap<String, String>,
    /// `AgentStatusSchema.default("closed")`.
    #[serde(default = "default_agent_status")]
    pub last_status: AgentStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_mode_id: Option<String>,
    /// Nullable+optional; JSON `null` is treated as `None`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub config: Option<SerializableAgentConfig>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime_info: Option<RuntimeInfo>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub features: Option<Vec<serde_json::Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub persistence: Option<PersistenceHandle>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub requires_attention: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attention_reason: Option<AttentionReason>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attention_timestamp: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub internal: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub archived_at: Option<String>,
}

/// Parse a stored agent record from an already-decoded JSON value.
///
/// Mirrors `parseStoredAgentRecord` (agent-storage.ts lines 80-82).
pub fn parse_stored_agent_record(
    value: &serde_json::Value,
) -> Result<StoredAgentRecord, serde_json::Error> {
    StoredAgentRecord::deserialize(value)
}

/// Read and parse a stored agent record from `path`.
pub fn read_agent_record(path: &Path) -> std::io::Result<StoredAgentRecord> {
    let content = std::fs::read_to_string(path)?;
    serde_json::from_str::<StoredAgentRecord>(&content).map_err(std::io::Error::other)
}

/// Derive the project directory name from a working directory.
///
/// Ported exactly from `projectDirNameFromCwd` (agent-storage.ts lines
/// 377-388), reproducing `path.win32.parse` root semantics on all platforms:
/// - `/Users/steve/app` -> `Users-steve-app`
/// - `/` -> `root`
/// - `C:\proj\x` -> `C-proj-x`
/// - `\\server\share\p` -> `server-share-p`
pub fn project_dir_name_from_cwd(cwd: &str) -> String {
    let root = win32_root(cwd);
    // `cwd.slice(root.length).replace(/[\\/]+$/, "")`.
    let without_root = trim_trailing_separators(&cwd[root.len()..]);
    // `root.replace(/[:\\/]+/g, "-").replace(/^-+|-+$/g, "")`.
    let sanitized_root = trim_dashes(&replace_runs(root, |c| c == ':' || c == '\\' || c == '/'));
    if without_root.is_empty() {
        return if sanitized_root.is_empty() {
            "root".to_string()
        } else {
            sanitized_root
        };
    }
    let body = replace_runs(without_root, |c| c == '\\' || c == '/');
    if sanitized_root.is_empty() {
        body
    } else {
        format!("{sanitized_root}-{body}")
    }
}

/// Replicate `path.win32.parse(cwd).root`.
///
/// Recognizes (in order): UNC roots (`\\server\share\` or `//server/share/`),
/// drive roots (`C:\`, `C:/`, or bare `C:`), and POSIX/absolute roots (a single
/// leading `\` or `/`). Returns the empty string for relative paths.
fn win32_root(cwd: &str) -> &str {
    let bytes = cwd.as_bytes();
    let is_sep = |b: u8| b == b'\\' || b == b'/';

    // UNC: two leading separators, then `server`, sep, `share`, then the root
    // includes the trailing separator after the share (if present).
    if bytes.len() >= 2 && is_sep(bytes[0]) && is_sep(bytes[1]) {
        // Skip the two leading separators.
        let mut i = 2;
        // server segment (non-separator).
        let server_start = i;
        while i < bytes.len() && !is_sep(bytes[i]) {
            i += 1;
        }
        if i > server_start && i < bytes.len() {
            // separator between server and share.
            i += 1;
            let share_start = i;
            while i < bytes.len() && !is_sep(bytes[i]) {
                i += 1;
            }
            if i > share_start {
                // Include a single trailing separator after the share, if any.
                if i < bytes.len() && is_sep(bytes[i]) {
                    i += 1;
                }
                return &cwd[..i];
            }
        }
        // Malformed UNC (e.g. just "\\"): root is the two separators.
        return &cwd[..2];
    }

    // Drive: letter + ':'.
    if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
        if bytes.len() >= 3 && is_sep(bytes[2]) {
            return &cwd[..3];
        }
        return &cwd[..2];
    }

    // POSIX/absolute: single leading separator.
    if !bytes.is_empty() && is_sep(bytes[0]) {
        return &cwd[..1];
    }

    ""
}

/// Replace each maximal run of chars matching `pred` with a single `-`.
fn replace_runs(s: &str, pred: impl Fn(char) -> bool) -> String {
    let mut out = String::with_capacity(s.len());
    let mut in_run = false;
    for c in s.chars() {
        if pred(c) {
            if !in_run {
                out.push('-');
                in_run = true;
            }
        } else {
            out.push(c);
            in_run = false;
        }
    }
    out
}

/// `replace(/^-+|-+$/g, "")`.
fn trim_dashes(s: &str) -> String {
    s.trim_matches('-').to_string()
}

/// `replace(/[\\/]+$/, "")`.
fn trim_trailing_separators(s: &str) -> &str {
    s.trim_end_matches(['\\', '/'])
}

/// List all agent records under `$ROCKY_HOME/agents/*/*.json`, best-effort.
///
/// Walks each project subdirectory of `agents/` and parses every `*.json`
/// file, silently skipping files that fail to read or parse. Used for the
/// agent-list projection.
pub fn list_agent_records(rocky_home: &Path) -> Vec<StoredAgentRecord> {
    let agents_dir = rocky_home.join("agents");
    let mut out = Vec::new();
    let Ok(projects) = std::fs::read_dir(&agents_dir) else {
        return out;
    };
    for project in projects.flatten() {
        let project_path = project.path();
        if !project_path.is_dir() {
            continue;
        }
        let Ok(entries) = std::fs::read_dir(&project_path) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            if let Ok(record) = read_agent_record(&path) {
                out.push(record);
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_full_record() {
        let json = serde_json::json!({
            "id": "agent-1",
            "provider": "claude",
            "cwd": "/Users/steve/app",
            "createdAt": "2026-01-01T00:00:00.000Z",
            "updatedAt": "2026-01-02T00:00:00.000Z",
            "lastActivityAt": "2026-01-02T00:00:01.000Z",
            "lastUserMessageAt": "2026-01-02T00:00:02.000Z",
            "title": "My Agent",
            "labels": { "team": "core", "env": "prod" },
            "lastStatus": "running",
            "lastModeId": "mode-x",
            "config": {
                "modeId": "mode-x",
                "model": "sonnet",
                "thinkingOptionId": null,
                "featureValues": { "a": 1 },
                "extra": { "k": "v" },
                "systemPrompt": "be nice",
                "mcpServers": { "srv": {} }
            },
            "runtimeInfo": {
                "provider": "claude",
                "sessionId": "sess-1",
                "model": "sonnet",
                "thinkingOptionId": null,
                "modeId": "mode-x",
                "extra": { "r": true }
            },
            "features": [ { "type": "thinking", "value": 1 } ],
            "persistence": {
                "provider": "claude",
                "sessionId": "sess-1",
                "nativeHandle": { "h": 1 },
                "metadata": { "m": 2 }
            },
            "lastError": "boom",
            "requiresAttention": true,
            "attentionReason": "permission",
            "attentionTimestamp": "2026-01-02T00:00:03.000Z",
            "internal": false,
            "archivedAt": "2026-01-03T00:00:00.000Z",
            "unknownExtraField": "ignored"
        });
        let rec = parse_stored_agent_record(&json).unwrap();
        assert_eq!(rec.id, "agent-1");
        assert_eq!(rec.last_status, AgentStatus::Running);
        assert_eq!(rec.labels.get("team").map(String::as_str), Some("core"));
        assert_eq!(rec.attention_reason, Some(AttentionReason::Permission));
        assert_eq!(rec.requires_attention, Some(true));
        let config = rec.config.unwrap();
        assert_eq!(config.model.as_deref(), Some("sonnet"));
        assert_eq!(config.thinking_option_id, None);
        let runtime = rec.runtime_info.unwrap();
        assert_eq!(runtime.session_id.as_deref(), Some("sess-1"));
        let persistence = rec.persistence.unwrap();
        assert_eq!(persistence.session_id, "sess-1");
        assert_eq!(rec.features.unwrap().len(), 1);
    }

    #[test]
    fn parses_minimal_record_with_defaults() {
        let json = serde_json::json!({
            "id": "agent-2",
            "provider": "codex",
            "cwd": "/tmp/x",
            "createdAt": "2026-01-01T00:00:00.000Z",
            "updatedAt": "2026-01-01T00:00:00.000Z"
        });
        let rec = parse_stored_agent_record(&json).unwrap();
        assert!(rec.labels.is_empty());
        assert_eq!(rec.last_status, AgentStatus::Closed);
        assert_eq!(rec.config, None);
        assert_eq!(rec.runtime_info, None);
        assert_eq!(rec.title, None);
    }

    #[test]
    fn project_dir_name_cases() {
        assert_eq!(project_dir_name_from_cwd("/Users/steve/app"), "Users-steve-app");
        assert_eq!(project_dir_name_from_cwd("/"), "root");
        assert_eq!(project_dir_name_from_cwd("C:\\proj\\x"), "C-proj-x");
        assert_eq!(project_dir_name_from_cwd("\\\\server\\share\\p"), "server-share-p");
    }

    #[test]
    fn project_dir_name_extra_cases() {
        // Drive root only.
        assert_eq!(project_dir_name_from_cwd("C:\\"), "C");
        // Trailing separators stripped.
        assert_eq!(project_dir_name_from_cwd("/Users/steve/app/"), "Users-steve-app");
        // Collapsed separator runs.
        assert_eq!(project_dir_name_from_cwd("/a//b"), "a-b");
        // Relative path: no root.
        assert_eq!(project_dir_name_from_cwd("a/b"), "a-b");
    }

    #[test]
    fn list_agent_records_walks_projects_and_skips_malformed() {
        let dir = tempfile::tempdir().unwrap();
        let agents = dir.path().join("agents");
        let proj_a = agents.join("proj-a");
        let proj_b = agents.join("proj-b");
        std::fs::create_dir_all(&proj_a).unwrap();
        std::fs::create_dir_all(&proj_b).unwrap();

        let rec = serde_json::json!({
            "id": "a1",
            "provider": "claude",
            "cwd": "/x",
            "createdAt": "t",
            "updatedAt": "t"
        });
        std::fs::write(proj_a.join("a1.json"), rec.to_string()).unwrap();
        let rec2 = serde_json::json!({
            "id": "b1",
            "provider": "codex",
            "cwd": "/y",
            "createdAt": "t",
            "updatedAt": "t"
        });
        std::fs::write(proj_b.join("b1.json"), rec2.to_string()).unwrap();
        // Malformed JSON: must be skipped.
        std::fs::write(proj_b.join("bad.json"), "{not json").unwrap();
        // Non-JSON file: ignored by extension filter.
        std::fs::write(proj_b.join("notes.txt"), "ignore me").unwrap();

        let mut ids: Vec<String> = list_agent_records(dir.path())
            .into_iter()
            .map(|r| r.id)
            .collect();
        ids.sort();
        assert_eq!(ids, vec!["a1".to_string(), "b1".to_string()]);
    }

    #[test]
    fn list_agent_records_missing_dir_is_empty() {
        let dir = tempfile::tempdir().unwrap();
        assert!(list_agent_records(dir.path()).is_empty());
    }
}
