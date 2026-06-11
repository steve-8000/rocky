//! Agent lifecycle manager, timeline pipeline, and permission queue for
//! `rockyd` (Phase 4).
//!
//! Mirrors `core/packages/server/src/server/agent/agent-manager.ts` and the
//! lifecycle/timeline/permission spec in
//! `core/docs/rust-rebuild/04-agent-runtime-and-providers.md`.
//!
//! - [`AgentManager`] is the source of truth for agent state. It enforces the
//!   lifecycle state machine via `AgentStatus::can_transition_to`, owns the
//!   timeline pipeline (persist-before-broadcast), the permission queue, and a
//!   tokio broadcast channel of [`AgentStreamBroadcast`].
//! - [`Timeline`] is the append-only per-agent timeline with daemon-owned
//!   timestamps + monotonic sequence numbers, persisted to disk.
//! - [`PermissionQueue`] preserves pending permission requests, survives
//!   reconnect, and resolves allow/deny (with deny-interrupt + follow-up).
//! - Provider session creation is abstracted behind [`AgentProvider`] /
//!   [`AgentSession`]; the real ACP impl is wired in by the orchestrator.

mod clock;
mod error;
mod manager;
mod paths;
mod permissions;
mod provider;
mod timeline;

pub use clock::{now_iso8601, trim_to_millis};
pub use error::AgentError;
pub use manager::{
    AgentManager, AgentStreamBroadcast, CreateAgentOptions, ManagedAgent, PARENT_AGENT_ID_LABEL,
};
pub use permissions::{FollowUp, PendingPermission, PermissionQueue, Resolution};
pub use provider::{
    AgentModelDef, AgentProvider, AgentSelectOption, AgentSession, ProviderSessionConfig,
    PromptInput, WaitForAgentResult,
};
pub use timeline::{Timeline, TimelineRow};
