//! Agent lifecycle manager — the source of truth for agent state.
//!
//! Mirrors `core/packages/server/src/server/agent/agent-manager.ts`. The
//! manager owns live `ManagedAgent` state, enforces the lifecycle state machine
//! via `AgentStatus::can_transition_to`, owns the timeline pipeline (persist
//! before broadcast, agent-manager.ts `recordTimeline` -> `dispatchStream`,
//! lines 3274-3282 / 3199-3217), owns the permission queue, and broadcasts
//! `AgentStreamEvent`s to subscribers via a tokio broadcast channel.
//!
//! State-machine reference: `04-agent-runtime-and-providers.md` lines 122-144.
//! Creation flow: lines 146-168 / `create-agent/create.ts`.
//! Timeline pipeline: lines 186-213. Permissions: lines 241-262.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use rocky_agent_domain::{
    AgentPermissionRequest, AgentPermissionResponse, AgentRuntimeInfo, AgentStatus,
    AgentStreamEvent, AgentTimelineItem,
};
use rocky_store::{
    project_dir_name_from_cwd, write_json_atomic, AttentionReason, PersistenceHandle, RuntimeInfo,
    SerializableAgentConfig, StoredAgentRecord,
};
use tokio::sync::{broadcast, Mutex};

use crate::clock::now_iso8601;
use crate::error::AgentError;
use crate::paths::{expand_user_path, resolve_child_agent_cwd};
use crate::permissions::{FollowUp, PendingPermission, PermissionQueue, Resolution};
use crate::provider::{AgentProvider, AgentSession, PromptInput, ProviderSessionConfig};
use crate::timeline::{Timeline, TimelineRow};

/// `rocky.parent-agent-id` label key (mirrors
/// `core/packages/protocol/src/agent-labels.ts`).
pub const PARENT_AGENT_ID_LABEL: &str = "rocky.parent-agent-id";

const BROADCAST_CAPACITY: usize = 1024;

/// A broadcast envelope carrying a stream event plus the daemon-owned timeline
/// metadata (seq/epoch/timestamp), matching the TS `dispatchStream` metadata
/// (agent-manager.ts lines 3433-3437).
#[derive(Debug, Clone)]
pub struct AgentStreamBroadcast {
    pub agent_id: String,
    pub event: AgentStreamEvent,
    pub seq: Option<u64>,
    pub epoch: Option<String>,
    pub timestamp: Option<String>,
}

/// In-memory live state for a single agent. Superset of the persisted
/// `StoredAgentRecord` fields the manager mutates at runtime.
#[derive(Clone)]
pub struct ManagedAgent {
    pub id: String,
    pub provider: String,
    pub cwd: String,
    pub status: AgentStatus,
    pub runtime_info: Option<AgentRuntimeInfo>,
    pub labels: BTreeMap<String, String>,
    pub requires_attention: bool,
    pub attention_reason: Option<AttentionReason>,
    pub attention_timestamp: Option<String>,
    pub last_error: Option<String>,
    pub current_turn_id: Option<String>,
    pub title: Option<String>,
    pub config: Option<SerializableAgentConfig>,
    pub persistence: Option<PersistenceHandle>,
    pub internal: bool,
    pub archived_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

impl std::fmt::Debug for ManagedAgent {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ManagedAgent")
            .field("id", &self.id)
            .field("provider", &self.provider)
            .field("cwd", &self.cwd)
            .field("status", &self.status)
            .field("requires_attention", &self.requires_attention)
            .field("current_turn_id", &self.current_turn_id)
            .finish_non_exhaustive()
    }
}

impl ManagedAgent {
    /// Project the live agent onto the persisted `StoredAgentRecord` shape.
    fn to_record(&self) -> StoredAgentRecord {
        StoredAgentRecord {
            id: self.id.clone(),
            provider: self.provider.clone(),
            cwd: self.cwd.clone(),
            created_at: self.created_at.clone(),
            updated_at: self.updated_at.clone(),
            last_activity_at: None,
            last_user_message_at: None,
            title: self.title.clone(),
            labels: self.labels.clone(),
            last_status: to_store_status(self.status),
            last_mode_id: self
                .runtime_info
                .as_ref()
                .and_then(|r| r.mode_id.clone()),
            config: self.config.clone(),
            runtime_info: self.runtime_info.as_ref().map(runtime_info_to_store),
            features: None,
            persistence: self.persistence.clone(),
            last_error: self.last_error.clone(),
            requires_attention: Some(self.requires_attention),
            attention_reason: self.attention_reason,
            attention_timestamp: self.attention_timestamp.clone(),
            internal: Some(self.internal),
            archived_at: self.archived_at.clone(),
        }
    }
}

fn to_store_status(status: AgentStatus) -> rocky_store::AgentStatus {
    match status {
        AgentStatus::Initializing => rocky_store::AgentStatus::Initializing,
        AgentStatus::Idle => rocky_store::AgentStatus::Idle,
        AgentStatus::Running => rocky_store::AgentStatus::Running,
        AgentStatus::Error => rocky_store::AgentStatus::Error,
        AgentStatus::Closed => rocky_store::AgentStatus::Closed,
    }
}

fn runtime_info_to_store(info: &AgentRuntimeInfo) -> RuntimeInfo {
    RuntimeInfo {
        provider: info.provider.clone(),
        session_id: info.session_id.clone(),
        model: info.model.clone(),
        thinking_option_id: info.thinking_option_id.clone(),
        mode_id: info.mode_id.clone(),
        extra: info
            .extra
            .as_ref()
            .map(|m| serde_json::Value::Object(m.clone())),
    }
}

/// Inverse of [`to_store_status`] for hydration. Applies the daemon-restart
/// recovery rule from `04-agent-runtime-and-providers.md` lines 277-289: a
/// persisted `running` (or `initializing`) status must NOT be treated as live
/// when no provider session exists. On hydration there is no live session, so
/// both downgrade to `idle` — the agent exists and is resumable, but no turn is
/// in flight. Matches the TS reload semantics in `agent-storage.ts` (records
/// are loaded as inert state; live `running` is only set when a turn starts).
fn from_store_status(status: rocky_store::AgentStatus) -> AgentStatus {
    match status {
        rocky_store::AgentStatus::Idle => AgentStatus::Idle,
        rocky_store::AgentStatus::Error => AgentStatus::Error,
        rocky_store::AgentStatus::Closed => AgentStatus::Closed,
        // Downgrade: no live session is restored on hydration.
        rocky_store::AgentStatus::Running | rocky_store::AgentStatus::Initializing => {
            AgentStatus::Idle
        }
    }
}

/// Inverse of [`runtime_info_to_store`]. `RuntimeInfo.extra` is an opaque
/// `serde_json::Value`; the live `AgentRuntimeInfo.extra` is a JSON object map,
/// so only `Value::Object` is carried through (anything else becomes `None`).
fn runtime_info_from_store(info: RuntimeInfo) -> AgentRuntimeInfo {
    AgentRuntimeInfo {
        provider: info.provider,
        session_id: info.session_id,
        model: info.model,
        thinking_option_id: info.thinking_option_id,
        mode_id: info.mode_id,
        extra: info.extra.and_then(|v| match v {
            serde_json::Value::Object(map) => Some(map),
            _ => None,
        }),
    }
}

/// Hydrate live agent state from the persisted records under
/// `$ROCKY_HOME/agents/*/*.json`. Mirrors the TS daemon, which lists and shows
/// all persisted, non-archived agents after restart (`agent-storage.ts`
/// `listAgentRecords`). Archived records are excluded from the live set. No
/// provider sessions are restored here (resume is a later phase), so statuses
/// are recovered inertly via [`from_store_status`].
fn hydrate_from_disk(rocky_home: &Path) -> BTreeMap<String, ManagedAgent> {
    let mut agents = BTreeMap::new();
    for record in rocky_store::list_agent_records(rocky_home) {
        if record.archived_at.is_some() {
            continue;
        }
        let id = record.id.clone();
        let agent = ManagedAgent {
            id: record.id,
            provider: record.provider,
            cwd: record.cwd,
            status: from_store_status(record.last_status),
            runtime_info: record.runtime_info.map(runtime_info_from_store),
            labels: record.labels,
            requires_attention: record.requires_attention.unwrap_or(false),
            attention_reason: record.attention_reason,
            attention_timestamp: record.attention_timestamp,
            last_error: record.last_error,
            current_turn_id: None,
            title: record.title,
            config: record.config,
            persistence: record.persistence,
            internal: record.internal.unwrap_or(false),
            // Skipped archived records above; the loaded live set is non-archived.
            archived_at: None,
            created_at: record.created_at,
            updated_at: record.updated_at,
        };
        agents.insert(id, agent);
    }
    agents
}

/// Options for creating an agent (mirrors the `createOptions` slice of the TS
/// create flow that the manager consumes: labels, caller context for child
/// cwd/parent label).
#[derive(Debug, Default, Clone)]
pub struct CreateAgentOptions {
    /// Provider id (`claude`, `codex`, …).
    pub provider: String,
    /// Requested cwd. For top-level agents this is used directly (or process
    /// cwd when absent). For child agents it is resolved relative to the parent.
    pub cwd: Option<String>,
    pub model: Option<String>,
    pub mode_id: Option<String>,
    pub thinking_option_id: Option<String>,
    pub approval_policy: Option<String>,
    pub title: Option<String>,
    /// User-supplied labels (merged last).
    pub labels: BTreeMap<String, String>,
    /// Caller (parent) agent id, if this is an agent-scoped MCP child.
    pub caller_agent_id: Option<String>,
    /// Whether the child is detached (no parent label).
    pub detached: bool,
    /// Default labels injected by the caller context.
    pub child_agent_default_labels: BTreeMap<String, String>,
    /// Caller context cwd lock.
    pub locked_cwd: Option<String>,
    /// Whether the caller allows a custom cwd (default true).
    pub allow_custom_cwd: bool,
    /// Internal/system agent (suppressed from global subscribers/attention).
    pub internal: bool,
}

impl CreateAgentOptions {
    /// Convenience constructor for a top-level agent.
    pub fn new(provider: impl Into<String>) -> Self {
        Self {
            provider: provider.into(),
            allow_custom_cwd: true,
            ..Default::default()
        }
    }
}

/// The agent control plane. Cheap to clone (`Arc` inner).
#[derive(Clone)]
pub struct AgentManager {
    inner: Arc<Inner>,
}

struct Inner {
    rocky_home: PathBuf,
    state: Mutex<ManagerState>,
    broadcast: broadcast::Sender<AgentStreamBroadcast>,
}

/// Error for config-mutation calls that need a live provider session.
/// Distinguishes a genuinely unknown agent (`NotFound`) from a known but
/// session-less one (hydrated from disk after a restart, or already closed),
/// where mutating provider config is impossible until the agent is resumed.
fn no_live_session_error(state: &ManagerState, id: &str) -> AgentError {
    if state.agents.contains_key(id) {
        AgentError::Provider(format!(
            "agent {id} has no live session (resume it before changing model/thinking/mode)"
        ))
    } else {
        AgentError::NotFound(id.to_string())
    }
}

struct ManagerState {
    agents: BTreeMap<String, ManagedAgent>,
    sessions: BTreeMap<String, Box<dyn AgentSession>>,
    timeline: Timeline,
    permissions: PermissionQueue,
}

impl AgentManager {
    /// Create a manager rooted at `$ROCKY_HOME`.
    pub fn new(rocky_home: impl Into<PathBuf>) -> Self {
        let rocky_home = rocky_home.into();
        let (tx, _rx) = broadcast::channel(BROADCAST_CAPACITY);

        // Hydrate live state from the persisted records on disk so the agent
        // list survives a daemon restart (matches the TS daemon, which shows
        // all persisted non-archived agents after reload). No provider sessions
        // are restored — `sessions` stays empty; resume is a later phase, and a
        // prompt/cancel on a session-less agent errors cleanly via the existing
        // `NotFound` path.
        let agents = hydrate_from_disk(&rocky_home);
        let mut timeline = Timeline::new(rocky_home.clone());
        for agent in agents.values() {
            // `register` is non-destructive: it loads any existing
            // `*.timeline.jsonl` and continues seq monotonically, never
            // truncating or rewriting on-disk timeline data.
            if let Err(err) = timeline.register(&agent.id, &agent.cwd) {
                tracing::warn!(
                    agent_id = %agent.id,
                    error = %err,
                    "failed to register hydrated agent timeline"
                );
            }
        }

        Self {
            inner: Arc::new(Inner {
                rocky_home,
                state: Mutex::new(ManagerState {
                    agents,
                    sessions: BTreeMap::new(),
                    timeline,
                    permissions: PermissionQueue::new(),
                }),
                broadcast: tx,
            }),
        }
    }

    /// Subscribe to broadcast stream events (one receiver per session).
    pub fn subscribe(&self) -> broadcast::Receiver<AgentStreamBroadcast> {
        self.inner.broadcast.subscribe()
    }

    /// Build the on-disk agent record path: `$ROCKY_HOME/agents/{project}/{id}.json`.
    fn record_path(&self, cwd: &str, id: &str) -> PathBuf {
        let project = project_dir_name_from_cwd(cwd);
        self.inner
            .rocky_home
            .join("agents")
            .join(project)
            .join(format!("{id}.json"))
    }

    /// Persist the agent record JSON atomically (matches TS `persistSnapshot`).
    fn persist_record(&self, agent: &ManagedAgent) -> Result<(), AgentError> {
        let path = self.record_path(&agent.cwd, &agent.id);
        write_json_atomic(&path, &agent.to_record())
            .map_err(|e| AgentError::Persistence(e.to_string()))
    }

    /// Create a new agent following the documented create flow
    /// (`04-agent-runtime-and-providers.md` lines 146-168). The provider
    /// session is created via the trait; the manager never spawns processes.
    pub async fn create_agent(
        &self,
        provider: &dyn AgentProvider,
        options: CreateAgentOptions,
    ) -> Result<ManagedAgent, AgentError> {
        let id = uuid::Uuid::new_v4().to_string();
        let now = now_iso8601();

        // Step 2: resolve cwd (parent-relative for child agents).
        let cwd = {
            let mut guard = self.inner.state.lock().await;
            self.resolve_cwd(&mut guard, &options)
        };

        // Step 6: merge labels.
        let labels = merge_labels(&options);

        // Step 8: create the provider session.
        let session = provider
            .create_session(ProviderSessionConfig {
                provider: options.provider.clone(),
                cwd: cwd.clone(),
                model: options.model.clone(),
                mode_id: options.mode_id.clone(),
                thinking_option_id: options.thinking_option_id.clone(),
                approval_policy: options.approval_policy.clone(),
            })
            .await?;

        let runtime_info = Some(session.runtime_info());
        let persistence = session.describe_persistence();

        let config = Some(SerializableAgentConfig {
            mode_id: options.mode_id.clone(),
            model: options.model.clone(),
            thinking_option_id: options.thinking_option_id.clone(),
            feature_values: None,
            extra: None,
            system_prompt: None,
            mcp_servers: None,
        });

        // Step 7: create the ManagedAgent record (initializing -> idle once the
        // session exists).
        let agent = ManagedAgent {
            id: id.clone(),
            provider: options.provider.clone(),
            cwd: cwd.clone(),
            status: AgentStatus::Idle,
            runtime_info,
            labels,
            requires_attention: false,
            attention_reason: None,
            attention_timestamp: None,
            last_error: None,
            current_turn_id: None,
            title: options.title.clone(),
            config,
            persistence,
            internal: options.internal,
            archived_at: None,
            created_at: now.clone(),
            updated_at: now,
        };

        // Steps 7/10: register live state, timeline, persist. Subscribe to the
        // session's event stream BEFORE registering so no early events (e.g.
        // `thread_started`, emitted during session creation) are missed.
        let session_events = session.subscribe_events();
        {
            let mut guard = self.inner.state.lock().await;
            guard.timeline.register(&id, &cwd)?;
            guard.agents.insert(id.clone(), agent.clone());
            guard.sessions.insert(id.clone(), session);
        }
        if let Some(rx) = session_events {
            self.spawn_event_pump(id.clone(), rx);
        }
        self.persist_record(&agent)?;

        tracing::info!(agent_id = %id, provider = %options.provider, cwd = %cwd, "agent created");
        Ok(agent)
    }

    /// Submit a prompt to a live agent's session, starting a turn. The
    /// resulting timeline/lifecycle events arrive asynchronously through the
    /// session's event stream and are ingested by the per-agent pump
    /// (see [`AgentManager::spawn_event_pump`]). Returns once the prompt has
    /// been dispatched to the provider.
    pub async fn prompt(&self, id: &str, input: PromptInput) -> Result<(), AgentError> {
        let guard = self.inner.state.lock().await;
        let session = guard
            .sessions
            .get(id)
            .ok_or_else(|| AgentError::NotFound(id.to_string()))?;
        session.prompt(input).await
    }

    /// Spawn a background task that ingests a session's stream events through
    /// the manager's full pipeline (timeline persist-before-broadcast, live
    /// state transitions, attention). The task ends when the session's sender
    /// is dropped (session closed). Errors are logged, not propagated, so a
    /// single bad event never tears down the stream.
    fn spawn_event_pump(
        &self,
        agent_id: String,
        mut rx: broadcast::Receiver<AgentStreamEvent>,
    ) {
        let manager = self.clone();
        tokio::spawn(async move {
            loop {
                match rx.recv().await {
                    Ok(event) => {
                        if let Err(err) = manager.ingest_stream_event(&agent_id, event).await {
                            tracing::warn!(
                                agent_id = %agent_id,
                                error = %err,
                                "failed to ingest session stream event"
                            );
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(skipped)) => {
                        tracing::warn!(
                            agent_id = %agent_id,
                            skipped,
                            "session event pump lagged; dropped events"
                        );
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
        });
    }

    fn resolve_cwd(&self, state: &mut ManagerState, options: &CreateAgentOptions) -> String {
        if let Some(parent_id) = options
            .caller_agent_id
            .as_deref()
            .filter(|s| !s.is_empty())
        {
            if let Some(parent) = state.agents.get(parent_id) {
                return resolve_child_agent_cwd(
                    &parent.cwd,
                    options.cwd.as_deref(),
                    options.locked_cwd.as_deref(),
                    options.allow_custom_cwd,
                );
            }
        }
        match options.cwd.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            Some(cwd) => expand_user_path(cwd),
            None => std::env::current_dir()
                .map(|p| p.to_string_lossy().into_owned())
                .unwrap_or_else(|_| "/".to_string()),
        }
    }

    /// Get a snapshot of an agent.
    pub async fn get(&self, id: &str) -> Option<ManagedAgent> {
        self.inner.state.lock().await.agents.get(id).cloned()
    }

    /// Modes the agent's live session advertises, plus its current mode id.
    /// Returns `(modes, current_mode_id)`. When the agent has no live session
    /// (hydrated after restart, or closed) both are empty/`None` — the WebUI
    /// then hides the composer mode selector, matching the TS behavior of an
    /// agent with no `availableModes`.
    pub async fn agent_modes(
        &self,
        id: &str,
    ) -> (Vec<rocky_agent_domain::AgentMode>, Option<String>) {
        let guard = self.inner.state.lock().await;
        match guard.sessions.get(id) {
            Some(session) => (session.available_modes(), session.current_mode_id()),
            None => (Vec::new(), None),
        }
    }

    /// List all live agents (sorted by id for determinism).
    pub async fn list(&self) -> Vec<ManagedAgent> {
        self.inner
            .state
            .lock()
            .await
            .agents
            .values()
            .cloned()
            .collect()
    }

    /// Set an agent's status, enforcing the state machine. Illegal transitions
    /// are rejected (logged + `IllegalTransition`); idempotent stays are
    /// allowed. On success, persists and emits an `AttentionRequired`-adjacent
    /// state update is left to callers; this only emits when status changes.
    pub async fn set_status(&self, id: &str, next: AgentStatus) -> Result<(), AgentError> {
        let (agent, changed) = {
            let mut guard = self.inner.state.lock().await;
            let agent = guard
                .agents
                .get_mut(id)
                .ok_or_else(|| AgentError::NotFound(id.to_string()))?;
            let from = agent.status;
            if !from.can_transition_to(next) {
                tracing::warn!(
                    agent_id = %id,
                    ?from,
                    to = ?next,
                    "rejected illegal status transition"
                );
                return Err(AgentError::IllegalTransition {
                    agent_id: id.to_string(),
                    from,
                    to: next,
                });
            }
            let changed = from != next;
            agent.status = next;
            if changed {
                agent.updated_at = now_iso8601();
            }
            (agent.clone(), changed)
        };
        if changed {
            self.persist_record(&agent)?;
        }
        Ok(())
    }

    /// Set the thinking (`thought_level`) option on a live agent's session and
    /// reflect the canonical applied value in the agent's runtime info. The
    /// provider's own `config_option_update` stream (if any) will reconcile the
    /// same value; this write is the authoritative immediate update.
    pub async fn set_agent_thinking(
        &self,
        id: &str,
        option_id: &str,
    ) -> Result<String, AgentError> {
        let guard = self.inner.state.lock().await;
        let session = guard
            .sessions
            .get(id)
            .ok_or_else(|| no_live_session_error(&guard, id))?;
        let applied = session.set_thinking_option(option_id).await?;
        let provider = session.runtime_info().provider;
        drop(guard);
        self.apply_runtime_change(id, |info| {
            info.thinking_option_id = Some(applied.clone());
        })
        .await?;
        self.broadcast(AgentStreamBroadcast {
            agent_id: id.to_string(),
            event: AgentStreamEvent::ThinkingOptionChanged {
                provider,
                thinking_option_id: Some(applied.clone()),
            },
            seq: None,
            epoch: None,
            timestamp: None,
        });
        Ok(applied)
    }

    /// Set the model on a live agent's session, reflecting the canonical applied
    /// model id in runtime info.
    pub async fn set_agent_model(&self, id: &str, model_id: &str) -> Result<String, AgentError> {
        let guard = self.inner.state.lock().await;
        let session = guard
            .sessions
            .get(id)
            .ok_or_else(|| no_live_session_error(&guard, id))?;
        let applied = session.set_model(model_id).await?;
        let provider = session.runtime_info().provider;
        drop(guard);
        let agent = self
            .apply_runtime_change(id, |info| {
                info.model = Some(applied.clone());
            })
            .await?;
        if let Some(runtime_info) = agent.runtime_info {
            self.broadcast(AgentStreamBroadcast {
                agent_id: id.to_string(),
                event: AgentStreamEvent::ModelChanged {
                    provider,
                    runtime_info,
                },
                seq: None,
                epoch: None,
                timestamp: None,
            });
        }
        Ok(applied)
    }

    /// Set the session mode on a live agent's session, reflecting it in runtime
    /// info.
    pub async fn set_agent_mode(&self, id: &str, mode_id: &str) -> Result<(), AgentError> {
        let guard = self.inner.state.lock().await;
        let session = guard
            .sessions
            .get(id)
            .ok_or_else(|| no_live_session_error(&guard, id))?;
        session.set_mode(mode_id).await?;
        let provider = session.runtime_info().provider;
        drop(guard);
        self.apply_runtime_change(id, |info| {
            info.mode_id = Some(mode_id.to_string());
        })
        .await?;
        self.broadcast(AgentStreamBroadcast {
            agent_id: id.to_string(),
            event: AgentStreamEvent::ModeChanged {
                provider,
                current_mode_id: Some(mode_id.to_string()),
                available_modes: Vec::new(),
            },
            seq: None,
            epoch: None,
            timestamp: None,
        });
        Ok(())
    }

    /// Apply an in-place mutation to an agent's runtime info and persist. No-op
    /// (other than persist) if runtime info is absent.
    async fn apply_runtime_change(
        &self,
        id: &str,
        mutate: impl FnOnce(&mut AgentRuntimeInfo),
    ) -> Result<ManagedAgent, AgentError> {
        let agent = {
            let mut guard = self.inner.state.lock().await;
            let agent = guard
                .agents
                .get_mut(id)
                .ok_or_else(|| AgentError::NotFound(id.to_string()))?;
            if let Some(info) = agent.runtime_info.as_mut() {
                mutate(info);
            }
            agent.updated_at = now_iso8601();
            agent.clone()
        };
        self.persist_record(&agent)?;
        Ok(agent)
    }

    /// Update an agent's runtime info (provider/model/mode/session id).
    pub async fn update_runtime_info(
        &self,
        id: &str,
        info: AgentRuntimeInfo,
    ) -> Result<(), AgentError> {
        let agent = {
            let mut guard = self.inner.state.lock().await;
            let agent = guard
                .agents
                .get_mut(id)
                .ok_or_else(|| AgentError::NotFound(id.to_string()))?;
            if agent.persistence.is_none() {
                if let Some(session_id) = info.session_id.clone() {
                    agent.persistence = Some(PersistenceHandle {
                        provider: agent.provider.clone(),
                        session_id,
                        native_handle: None,
                        metadata: None,
                    });
                }
            }
            agent.runtime_info = Some(info);
            agent.updated_at = now_iso8601();
            agent.clone()
        };
        self.persist_record(&agent)?;
        Ok(())
    }

    /// Mark an agent as requiring attention with a reason.
    pub async fn mark_attention(
        &self,
        id: &str,
        reason: AttentionReason,
    ) -> Result<(), AgentError> {
        let agent = {
            let mut guard = self.inner.state.lock().await;
            let agent = guard
                .agents
                .get_mut(id)
                .ok_or_else(|| AgentError::NotFound(id.to_string()))?;
            let ts = now_iso8601();
            agent.requires_attention = true;
            agent.attention_reason = Some(reason);
            agent.attention_timestamp = Some(ts);
            agent.updated_at = now_iso8601();
            agent.clone()
        };
        self.persist_record(&agent)?;
        // Delegated (child) agents do not raise attention broadcasts
        // (agent-manager.ts broadcastAgentAttention guard, lines 3418-3425).
        if !agent.labels.contains_key(PARENT_AGENT_ID_LABEL) && !agent.internal {
            self.broadcast(AgentStreamBroadcast {
                agent_id: agent.id.clone(),
                event: AgentStreamEvent::AttentionRequired {
                    provider: agent.provider.clone(),
                    reason: attention_reason_str(reason).to_string(),
                    timestamp: agent
                        .attention_timestamp
                        .clone()
                        .unwrap_or_else(now_iso8601),
                },
                seq: None,
                epoch: None,
                timestamp: agent.attention_timestamp.clone(),
            });
        }
        Ok(())
    }

    /// Clear an agent's attention flag.
    pub async fn clear_attention(&self, id: &str) -> Result<(), AgentError> {
        let agent = {
            let mut guard = self.inner.state.lock().await;
            let agent = guard
                .agents
                .get_mut(id)
                .ok_or_else(|| AgentError::NotFound(id.to_string()))?;
            agent.requires_attention = false;
            agent.attention_reason = None;
            agent.attention_timestamp = None;
            agent.updated_at = now_iso8601();
            agent.clone()
        };
        self.persist_record(&agent)?;
        Ok(())
    }

    /// Cancel the in-flight turn. Moves Running -> Idle (if legal).
    pub async fn cancel(&self, id: &str) -> Result<(), AgentError> {
        {
            let guard = self.inner.state.lock().await;
            if !guard.agents.contains_key(id) {
                return Err(AgentError::NotFound(id.to_string()));
            }
            if let Some(sess) = guard.sessions.get(id) {
                sess.cancel().await?;
            }
        }
        // Best-effort transition back to idle.
        let _ = self.set_status(id, AgentStatus::Idle).await;
        Ok(())
    }

    /// Archive an agent (sets `archived_at`, keeps the record). Closes first.
    pub async fn archive(&self, id: &str) -> Result<(), AgentError> {
        self.close(id).await?;
        let agent = {
            let mut guard = self.inner.state.lock().await;
            let agent = guard
                .agents
                .get_mut(id)
                .ok_or_else(|| AgentError::NotFound(id.to_string()))?;
            agent.archived_at = Some(now_iso8601());
            agent.updated_at = now_iso8601();
            agent.clone()
        };
        self.persist_record(&agent)?;
        Ok(())
    }

    /// Close an agent: transition to `closed` (terminal), close the provider
    /// session, clear pending permissions and live timeline.
    pub async fn close(&self, id: &str) -> Result<(), AgentError> {
        let (agent, session) = {
            let mut guard = self.inner.state.lock().await;
            let agent = guard
                .agents
                .get_mut(id)
                .ok_or_else(|| AgentError::NotFound(id.to_string()))?;
            if agent.status.can_transition_to(AgentStatus::Closed) {
                agent.status = AgentStatus::Closed;
                agent.updated_at = now_iso8601();
            }
            let agent = agent.clone();
            guard.permissions.clear_agent(id);
            guard.timeline.forget(id);
            let session = guard.sessions.remove(id);
            (agent, session)
        };
        if let Some(session) = session {
            session.close().await?;
        }
        self.persist_record(&agent)?;
        tracing::info!(agent_id = %id, "agent closed");
        Ok(())
    }

    // --- Timeline pipeline ---

    /// Append a timeline item for an agent (persist-before-broadcast). Returns
    /// the durable row. Broadcasts a `Timeline` stream event after the row is
    /// on disk.
    pub async fn append_timeline(
        &self,
        agent_id: &str,
        item: AgentTimelineItem,
        turn_id: Option<String>,
    ) -> Result<TimelineRow, AgentError> {
        let (provider, row, epoch) = {
            let mut guard = self.inner.state.lock().await;
            let provider = guard
                .agents
                .get(agent_id)
                .ok_or_else(|| AgentError::NotFound(agent_id.to_string()))?
                .provider
                .clone();
            let row = guard
                .timeline
                .append(agent_id, item.clone(), turn_id.clone())?;
            let epoch = guard.timeline.epoch(agent_id).map(str::to_string);
            (provider, row, epoch)
        };
        // Persistence already happened inside `append`; safe to broadcast.
        self.broadcast(AgentStreamBroadcast {
            agent_id: agent_id.to_string(),
            event: AgentStreamEvent::Timeline {
                item: Box::new(row.item.clone()),
                provider,
                turn_id: row.turn_id.clone(),
                timestamp: Some(row.timestamp.clone()),
            },
            seq: Some(row.seq),
            epoch,
            timestamp: Some(row.timestamp.clone()),
        });
        Ok(row)
    }

    /// Paged timeline fetch (`seq > after_seq`, up to `limit`; 0 = all).
    pub async fn fetch_timeline(
        &self,
        agent_id: &str,
        after_seq: u64,
        limit: usize,
    ) -> Vec<TimelineRow> {
        self.inner
            .state
            .lock()
            .await
            .timeline
            .fetch(agent_id, after_seq, limit)
    }

    /// Ingest a normalized provider stream event through the full pipeline:
    /// attach daemon timestamp/turn -> update live state -> append timeline row
    /// (for `Timeline` events) -> persist -> broadcast -> update attention.
    ///
    /// Returns the broadcast envelope that was emitted (the event downstream
    /// sessions observe). Mirrors `dispatchStreamEventByType`
    /// (agent-manager.ts lines 2904-2980) for the categories the Rust slice
    /// owns.
    pub async fn ingest_stream_event(
        &self,
        agent_id: &str,
        event: AgentStreamEvent,
    ) -> Result<AgentStreamBroadcast, AgentError> {
        // Timeline events go through the persist-before-broadcast path.
        if let AgentStreamEvent::Timeline {
            item,
            turn_id,
            timestamp,
            ..
        } = &event
        {
            let (provider, row, epoch) = {
                let mut guard = self.inner.state.lock().await;
                let agent = guard
                    .agents
                    .get_mut(agent_id)
                    .ok_or_else(|| AgentError::NotFound(agent_id.to_string()))?;
                let provider = agent.provider.clone();
                if turn_id.is_some() {
                    agent.current_turn_id = turn_id.clone();
                }
                let row = guard.timeline.append_with_timestamp(
                    agent_id,
                    (**item).clone(),
                    turn_id.clone(),
                    timestamp.clone(),
                )?;
                let epoch = guard.timeline.epoch(agent_id).map(str::to_string);
                (provider, row, epoch)
            };
            let envelope = AgentStreamBroadcast {
                agent_id: agent_id.to_string(),
                event: AgentStreamEvent::Timeline {
                    item: Box::new(row.item.clone()),
                    provider,
                    turn_id: row.turn_id.clone(),
                    timestamp: Some(row.timestamp.clone()),
                },
                seq: Some(row.seq),
                epoch,
                timestamp: Some(row.timestamp.clone()),
            };
            self.broadcast(envelope.clone());
            return Ok(envelope);
        }

        // Non-timeline events: update live state, then broadcast (no row).
        let mut attention: Option<AttentionReason> = None;
        {
            let mut guard = self.inner.state.lock().await;
            if !guard.agents.contains_key(agent_id) {
                return Err(AgentError::NotFound(agent_id.to_string()));
            }
            // Permission events touch the queue, not the agent borrow — handle
            // them first to keep the borrows disjoint.
            match &event {
                AgentStreamEvent::PermissionRequested { request, .. } => {
                    guard.permissions.enqueue(agent_id, (**request).clone());
                    attention = Some(AttentionReason::Permission);
                }
                AgentStreamEvent::PermissionResolved { request_id, .. } => {
                    let _ = guard.permissions.resolve_silently(request_id);
                }
                _ => {}
            }
            let agent = guard
                .agents
                .get_mut(agent_id)
                .ok_or_else(|| AgentError::NotFound(agent_id.to_string()))?;
            match &event {
                AgentStreamEvent::TurnStarted { turn_id, .. } => {
                    agent.current_turn_id = turn_id.clone();
                    transition(agent, AgentStatus::Running);
                }
                AgentStreamEvent::TurnCompleted { .. } => {
                    agent.last_error = None;
                    agent.current_turn_id = None;
                    transition(agent, AgentStatus::Idle);
                    attention = Some(AttentionReason::Finished);
                }
                AgentStreamEvent::TurnFailed { error, .. } => {
                    agent.last_error = Some(error.clone());
                    agent.current_turn_id = None;
                    transition(agent, AgentStatus::Error);
                    attention = Some(AttentionReason::Error);
                }
                AgentStreamEvent::TurnCanceled { .. } => {
                    agent.current_turn_id = None;
                    transition(agent, AgentStatus::Idle);
                }
                AgentStreamEvent::ThreadStarted { session_id, .. } => {
                    if agent.persistence.is_none() {
                        agent.persistence = Some(PersistenceHandle {
                            provider: agent.provider.clone(),
                            session_id: session_id.clone(),
                            native_handle: None,
                            metadata: None,
                        });
                    }
                }
                AgentStreamEvent::ModelChanged { runtime_info, .. } => {
                    agent.runtime_info = Some(runtime_info.clone());
                }
                AgentStreamEvent::ModeChanged { current_mode_id, .. } => {
                    if let Some(info) = agent.runtime_info.as_mut() {
                        info.mode_id = current_mode_id.clone();
                    }
                }
                AgentStreamEvent::ThinkingOptionChanged {
                    thinking_option_id, ..
                } => {
                    if let Some(info) = agent.runtime_info.as_mut() {
                        info.thinking_option_id = thinking_option_id.clone();
                    }
                }
                _ => {}
            }
            agent.updated_at = now_iso8601();
        }

        // Persist updated record before broadcasting state-affecting events.
        if let Some(agent) = self.get(agent_id).await {
            self.persist_record(&agent)?;
        }

        let envelope = AgentStreamBroadcast {
            agent_id: agent_id.to_string(),
            event,
            seq: None,
            epoch: None,
            timestamp: None,
        };
        self.broadcast(envelope.clone());

        if let Some(reason) = attention {
            self.mark_attention(agent_id, reason).await?;
        }
        Ok(envelope)
    }

    // --- Permissions ---

    /// Enqueue a permission request and broadcast `PermissionRequested`. Sets
    /// attention (`permission`) for non-internal, non-delegated agents.
    pub async fn enqueue_permission(
        &self,
        agent_id: &str,
        request: AgentPermissionRequest,
    ) -> Result<PendingPermission, AgentError> {
        let (pending, provider) = {
            let mut guard = self.inner.state.lock().await;
            let provider = guard
                .agents
                .get(agent_id)
                .ok_or_else(|| AgentError::NotFound(agent_id.to_string()))?
                .provider
                .clone();
            let pending = guard.permissions.enqueue(agent_id, request.clone());
            (pending, provider)
        };
        self.broadcast(AgentStreamBroadcast {
            agent_id: agent_id.to_string(),
            event: AgentStreamEvent::PermissionRequested {
                provider,
                request: Box::new(request),
                turn_id: None,
            },
            seq: None,
            epoch: None,
            timestamp: None,
        });
        self.mark_attention(agent_id, AttentionReason::Permission)
            .await?;
        Ok(pending)
    }

    /// List pending permissions, optionally scoped to one agent. Survives
    /// reconnect: a new subscriber calls this to recover state.
    pub async fn list_pending_permissions(
        &self,
        agent_id: Option<&str>,
    ) -> Vec<PendingPermission> {
        self.inner
            .state
            .lock()
            .await
            .permissions
            .list_pending(agent_id)
    }

    /// Resolve a permission. Broadcasts `PermissionResolved`, clears attention
    /// when no more pending for the agent, and returns any follow-up.
    pub async fn respond_to_permission(
        &self,
        request_id: &str,
        response: AgentPermissionResponse,
        follow_up: Option<FollowUp>,
    ) -> Result<Resolution, AgentError> {
        let (resolution, provider, still_pending) = {
            let mut guard = self.inner.state.lock().await;
            let resolution = guard
                .permissions
                .resolve(request_id, response.clone(), follow_up)?;
            let provider = guard
                .agents
                .get(&resolution.agent_id)
                .map(|a| a.provider.clone())
                .unwrap_or_default();
            let still_pending = guard.permissions.has_pending(&resolution.agent_id);
            (resolution, provider, still_pending)
        };
        self.broadcast(AgentStreamBroadcast {
            agent_id: resolution.agent_id.clone(),
            event: AgentStreamEvent::PermissionResolved {
                provider,
                request_id: request_id.to_string(),
                resolution: response,
                turn_id: None,
            },
            seq: None,
            epoch: None,
            timestamp: None,
        });
        if !still_pending {
            // Best-effort: clearing attention is fine even if it was already clear.
            let _ = self.clear_attention(&resolution.agent_id).await;
        }
        Ok(resolution)
    }

    fn broadcast(&self, envelope: AgentStreamBroadcast) {
        // A send error only means there are no subscribers; that is fine.
        let _ = self.inner.broadcast.send(envelope);
    }
}

/// Apply a status transition iff legal; log + ignore otherwise. Used for
/// event-driven transitions where rejecting the whole event is wrong.
fn transition(agent: &mut ManagedAgent, next: AgentStatus) {
    let from = agent.status;
    if from.can_transition_to(next) {
        agent.status = next;
    } else {
        tracing::warn!(
            agent_id = %agent.id,
            ?from,
            to = ?next,
            "ignored illegal event-driven status transition"
        );
    }
}

/// Port of `mergeLabels` (create.ts lines 487-504): parent label (when caller
/// present and not detached), caller default labels, then user labels.
fn merge_labels(options: &CreateAgentOptions) -> BTreeMap<String, String> {
    let mut labels: BTreeMap<String, String> = BTreeMap::new();
    if !options.detached {
        if let Some(parent) = options
            .caller_agent_id
            .as_deref()
            .filter(|s| !s.is_empty())
        {
            labels.insert(PARENT_AGENT_ID_LABEL.to_string(), parent.to_string());
        }
    }
    for (k, v) in &options.child_agent_default_labels {
        labels.insert(k.clone(), v.clone());
    }
    for (k, v) in &options.labels {
        labels.insert(k.clone(), v.clone());
    }
    if options.detached {
        labels.remove(PARENT_AGENT_ID_LABEL);
    }
    labels
}

fn attention_reason_str(reason: AttentionReason) -> &'static str {
    match reason {
        AttentionReason::Finished => "finished",
        AttentionReason::Error => "error",
        AttentionReason::Permission => "permission",
    }
}

#[cfg(test)]
mod hydration_tests {
    use super::*;
    use rocky_store::AgentStatus as StoreStatus;

    /// Build a minimal `StoredAgentRecord` with the given id/cwd/status, plus a
    /// title and a label so field round-tripping can be asserted.
    fn record(id: &str, cwd: &str, status: StoreStatus) -> StoredAgentRecord {
        let mut labels = BTreeMap::new();
        labels.insert("rocky.kind".to_string(), "test".to_string());
        StoredAgentRecord {
            id: id.to_string(),
            provider: "claude".to_string(),
            cwd: cwd.to_string(),
            created_at: "2026-01-01T00:00:00.000Z".to_string(),
            updated_at: "2026-01-02T00:00:00.000Z".to_string(),
            last_activity_at: None,
            last_user_message_at: None,
            title: Some(format!("title-{id}")),
            labels,
            last_status: status,
            last_mode_id: None,
            config: None,
            runtime_info: None,
            features: None,
            persistence: None,
            last_error: None,
            requires_attention: None,
            attention_reason: None,
            attention_timestamp: None,
            internal: None,
            archived_at: None,
        }
    }

    /// Write a record to `$ROCKY_HOME/agents/{project}/{id}.json`.
    fn write_record(home: &Path, rec: &StoredAgentRecord) -> PathBuf {
        let path = home
            .join("agents")
            .join(project_dir_name_from_cwd(&rec.cwd))
            .join(format!("{}.json", rec.id));
        write_json_atomic(&path, rec).expect("write record");
        path
    }

    #[tokio::test]
    async fn hydrate_loads_non_archived_and_downgrades_running() {
        let home = tempfile::tempdir().unwrap();
        let cwd = "/tmp/rocky-proj";

        let idle = record("agent-idle", cwd, StoreStatus::Idle);
        let running = record("agent-running", cwd, StoreStatus::Running);
        let mut archived = record("agent-archived", cwd, StoreStatus::Idle);
        archived.archived_at = Some("2026-01-03T00:00:00.000Z".to_string());

        let idle_path = write_record(home.path(), &idle);
        let running_path = write_record(home.path(), &running);
        let archived_path = write_record(home.path(), &archived);

        let manager = AgentManager::new(home.path());
        let agents = manager.list().await;

        // Archived excluded; both non-archived loaded.
        let ids: Vec<&str> = agents.iter().map(|a| a.id.as_str()).collect();
        assert_eq!(ids, vec!["agent-idle", "agent-running"]);

        let loaded_idle = agents.iter().find(|a| a.id == "agent-idle").unwrap();
        let loaded_running = agents.iter().find(|a| a.id == "agent-running").unwrap();

        // Downgrade rule: persisted running hydrates as Idle; idle stays Idle.
        assert_eq!(loaded_running.status, AgentStatus::Idle);
        assert_eq!(loaded_idle.status, AgentStatus::Idle);

        // Fields survive.
        assert_eq!(loaded_idle.provider, "claude");
        assert_eq!(loaded_idle.cwd, cwd);
        assert_eq!(loaded_idle.title.as_deref(), Some("title-agent-idle"));
        assert_eq!(loaded_idle.labels.get("rocky.kind").map(String::as_str), Some("test"));
        assert_eq!(loaded_idle.current_turn_id, None);

        // Hydration must NOT delete the on-disk record files.
        assert!(idle_path.exists());
        assert!(running_path.exists());
        assert!(archived_path.exists());
    }

    #[tokio::test]
    async fn hydrate_recovers_error_and_closed_status() {
        let home = tempfile::tempdir().unwrap();
        let cwd = "/tmp/rocky-proj-2";
        write_record(home.path(), &record("err", cwd, StoreStatus::Error));
        write_record(home.path(), &record("closed", cwd, StoreStatus::Closed));
        write_record(home.path(), &record("init", cwd, StoreStatus::Initializing));

        let manager = AgentManager::new(home.path());
        let agents = manager.list().await;
        let status_of = |id: &str| agents.iter().find(|a| a.id == id).unwrap().status;

        assert_eq!(status_of("err"), AgentStatus::Error);
        assert_eq!(status_of("closed"), AgentStatus::Closed);
        // initializing downgrades to idle (no live session on hydration).
        assert_eq!(status_of("init"), AgentStatus::Idle);
    }

    #[tokio::test]
    async fn prompt_on_session_less_hydrated_agent_errors_cleanly() {
        let home = tempfile::tempdir().unwrap();
        write_record(home.path(), &record("a1", "/tmp/rocky-proj-3", StoreStatus::Idle));
        let manager = AgentManager::new(home.path());

        let err = manager
            .prompt(
                "a1",
                PromptInput {
                    text: "hi".to_string(),
                    message_id: None,
                },
            )
            .await
            .expect_err("no session restored -> error");
        assert!(matches!(err, AgentError::NotFound(_)));
    }
}
