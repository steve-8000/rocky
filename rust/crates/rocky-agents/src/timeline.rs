//! Append-only timeline store with daemon-owned canonical timestamps and
//! monotonic per-agent sequence numbers.
//!
//! Mirrors the seq/timestamp ownership of the TS
//! `InMemoryAgentTimelineStore.append` (agent-timeline-store.ts) — the daemon,
//! not the provider, mints `seq` and `timestamp`. The manager's pipeline must
//! call [`Timeline::append`] (which persists synchronously) **before** it
//! broadcasts, matching the "do not broadcast before persistence" rule in
//! `04-agent-runtime-and-providers.md` (timeline pipeline, lines 186-213).
//!
//! ## Persistence location (documented deviation)
//!
//! In TS, agent record metadata lives in
//! `$ROCKY_HOME/agents/{project}/{agentId}.json` (agent-storage.ts
//! `buildRecordPath`, lines 350-353), while timeline rows live in a pluggable
//! `durableTimelineStore` (`AgentManager` ctor option `durableTimelineStore`,
//! agent-manager.ts lines 184/425/439) that is **not** the agent JSON file.
//! There is no committed file-backed durable store in this slice to match
//! byte-for-byte, so — per the task brief — we persist rows as a sibling
//! JSONL file:
//!
//! ```text
//! $ROCKY_HOME/agents/{project}/{agentId}.timeline.jsonl
//! ```
//!
//! One JSON object per line: `{ "seq", "timestamp", "item", "turnId"? }`. This
//! is a deliberate deviation to be reconciled when the real durable store lands.

use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};

use rocky_agent_domain::AgentTimelineItem;
use rocky_store::project_dir_name_from_cwd;
use serde::{Deserialize, Serialize};

use crate::clock::now_iso8601;
use crate::error::AgentError;

/// A persisted timeline row. Extends the domain `AgentTimelineRow` shape with
/// the owning `turn_id` (TS dispatch metadata carries turn id alongside the
/// row; we keep it on the row so the JSONL is self-describing).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineRow {
    pub seq: u64,
    pub timestamp: String,
    pub item: AgentTimelineItem,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
}

/// Per-agent in-memory state plus its on-disk JSONL path.
#[derive(Debug)]
struct AgentTimeline {
    /// Epoch id; changes when the timeline is reset (resume/rehydrate). Stable
    /// across appends so cursors remain valid.
    epoch: String,
    rows: Vec<TimelineRow>,
    next_seq: u64,
    path: PathBuf,
}

/// Append-only timeline store keyed by agent id.
#[derive(Debug)]
pub struct Timeline {
    rocky_home: PathBuf,
    agents: HashMap<String, AgentTimeline>,
}

impl Timeline {
    /// Create a timeline store rooted at `$ROCKY_HOME`.
    pub fn new(rocky_home: impl Into<PathBuf>) -> Self {
        Self {
            rocky_home: rocky_home.into(),
            agents: HashMap::new(),
        }
    }

    /// Compute the JSONL path for an agent given its cwd.
    fn timeline_path(&self, agent_id: &str, cwd: &str) -> PathBuf {
        let project = project_dir_name_from_cwd(cwd);
        self.rocky_home
            .join("agents")
            .join(project)
            .join(format!("{agent_id}.timeline.jsonl"))
    }

    /// Register an agent so its rows persist to the correct project dir. If a
    /// JSONL file already exists on disk it is loaded so seq numbers continue
    /// monotonically across daemon restarts (resume/reload). Idempotent: a
    /// second call with the same id is a no-op.
    pub fn register(&mut self, agent_id: &str, cwd: &str) -> Result<(), AgentError> {
        if self.agents.contains_key(agent_id) {
            return Ok(());
        }
        let path = self.timeline_path(agent_id, cwd);
        let rows = load_rows(&path)?;
        let next_seq = rows.last().map(|r| r.seq + 1).unwrap_or(1);
        self.agents.insert(
            agent_id.to_string(),
            AgentTimeline {
                epoch: uuid::Uuid::new_v4().to_string(),
                rows,
                next_seq,
                path,
            },
        );
        Ok(())
    }

    /// Whether the agent is registered.
    pub fn has(&self, agent_id: &str) -> bool {
        self.agents.contains_key(agent_id)
    }

    /// The current epoch for an agent.
    pub fn epoch(&self, agent_id: &str) -> Option<&str> {
        self.agents.get(agent_id).map(|a| a.epoch.as_str())
    }

    /// Append a timeline item. The daemon mints the seq and (unless an explicit
    /// timestamp is supplied) the canonical timestamp. **Persists the row to
    /// disk before returning** so callers can broadcast only after the row is
    /// durable.
    pub fn append(
        &mut self,
        agent_id: &str,
        item: AgentTimelineItem,
        turn_id: Option<String>,
    ) -> Result<TimelineRow, AgentError> {
        self.append_with_timestamp(agent_id, item, turn_id, None)
    }

    /// Like [`Timeline::append`] but with an explicit timestamp (used when
    /// re-streaming provider history that carries its own timestamps).
    pub fn append_with_timestamp(
        &mut self,
        agent_id: &str,
        item: AgentTimelineItem,
        turn_id: Option<String>,
        timestamp: Option<String>,
    ) -> Result<TimelineRow, AgentError> {
        let agent = self
            .agents
            .get_mut(agent_id)
            .ok_or_else(|| AgentError::NotFound(agent_id.to_string()))?;
        let row = TimelineRow {
            seq: agent.next_seq,
            timestamp: timestamp.unwrap_or_else(now_iso8601),
            item,
            turn_id,
        };
        // Persist BEFORE updating in-memory state so an append failure does not
        // leave a row visible in memory that never reached disk.
        persist_row(&agent.path, &row)?;
        agent.next_seq += 1;
        agent.rows.push(row.clone());
        Ok(row)
    }

    /// Paged fetch of rows with `seq > after_seq`, oldest-first. A `limit` of 0
    /// returns all matching rows.
    pub fn fetch(&self, agent_id: &str, after_seq: u64, limit: usize) -> Vec<TimelineRow> {
        let Some(agent) = self.agents.get(agent_id) else {
            return Vec::new();
        };
        let iter = agent.rows.iter().filter(|r| r.seq > after_seq).cloned();
        if limit == 0 {
            iter.collect()
        } else {
            iter.take(limit).collect()
        }
    }

    /// All rows for an agent, oldest-first.
    pub fn rows(&self, agent_id: &str) -> Vec<TimelineRow> {
        self.agents
            .get(agent_id)
            .map(|a| a.rows.clone())
            .unwrap_or_default()
    }

    /// The latest committed seq (0 if empty/unknown).
    pub fn latest_seq(&self, agent_id: &str) -> u64 {
        self.agents
            .get(agent_id)
            .and_then(|a| a.rows.last().map(|r| r.seq))
            .unwrap_or(0)
    }

    /// Reset an agent's timeline (resume/rehydrate): mint a new epoch, clear
    /// in-memory rows, and truncate the on-disk JSONL. Re-registers if needed.
    pub fn reset(&mut self, agent_id: &str, cwd: &str) -> Result<(), AgentError> {
        let path = self.timeline_path(agent_id, cwd);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| AgentError::Persistence(e.to_string()))?;
        }
        // Truncate the file.
        std::fs::write(&path, b"").map_err(|e| AgentError::Persistence(e.to_string()))?;
        self.agents.insert(
            agent_id.to_string(),
            AgentTimeline {
                epoch: uuid::Uuid::new_v4().to_string(),
                rows: Vec::new(),
                next_seq: 1,
                path,
            },
        );
        Ok(())
    }

    /// Drop an agent's in-memory timeline (does not delete the JSONL file).
    pub fn forget(&mut self, agent_id: &str) {
        self.agents.remove(agent_id);
    }
}

/// Append a single row as one JSON line, fsync-free but flushed. Creates the
/// parent dir on demand.
fn persist_row(path: &Path, row: &TimelineRow) -> Result<(), AgentError> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| AgentError::Persistence(e.to_string()))?;
    }
    let line = serde_json::to_string(row).map_err(|e| AgentError::Persistence(e.to_string()))?;
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|e| AgentError::Persistence(e.to_string()))?;
    file.write_all(line.as_bytes())
        .and_then(|_| file.write_all(b"\n"))
        .and_then(|_| file.flush())
        .map_err(|e| AgentError::Persistence(e.to_string()))?;
    Ok(())
}

/// Load rows from an existing JSONL file, skipping blank lines. Missing file
/// yields an empty vec.
fn load_rows(path: &Path) -> Result<Vec<TimelineRow>, AgentError> {
    let contents = match std::fs::read_to_string(path) {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(AgentError::Persistence(e.to_string())),
    };
    let mut rows = Vec::new();
    for line in contents.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let row: TimelineRow =
            serde_json::from_str(line).map_err(|e| AgentError::Persistence(e.to_string()))?;
        rows.push(row);
    }
    Ok(rows)
}
