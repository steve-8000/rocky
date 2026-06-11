//! Minimal provider/session abstraction.
//!
//! The real ACP-backed implementation lives in `rocky-acp` and is wired in by
//! the orchestrator later. The `AgentManager` only ever talks to these traits;
//! it never spawns subprocesses itself. The shapes mirror the relevant slice of
//! the TS `AgentSession` / provider interface
//! (`core/packages/server/src/server/agent/agent-sdk-types.ts`) that the
//! manager depends on: an opaque session id, a runtime-info snapshot, a stream
//! of `AgentStreamEvent`s, prompt submission, cancellation, and close.

use async_trait::async_trait;
use rocky_agent_domain::{AgentRuntimeInfo, AgentStreamEvent};
use rocky_store::PersistenceHandle;

use crate::error::AgentError;

/// Configuration handed to a provider when creating a new session. Mirrors the
/// persisted subset of `AgentSessionConfig` plus the resolved cwd.
#[derive(Debug, Clone)]
pub struct ProviderSessionConfig {
    pub provider: String,
    pub cwd: String,
    pub model: Option<String>,
    pub mode_id: Option<String>,
    pub thinking_option_id: Option<String>,
    pub approval_policy: Option<String>,
}

/// A prompt submitted to a live session.
#[derive(Debug, Clone)]
pub struct PromptInput {
    pub text: String,
    /// Optional client-supplied message id (used for idempotency upstream).
    pub message_id: Option<String>,
}

/// A live provider session. Stream events flow from the provider into the
/// manager's timeline pipeline; the manager owns canonical timestamps/seq.
#[async_trait]
pub trait AgentSession: Send + Sync {
    /// Provider-assigned session id (the ACP/native session handle).
    fn session_id(&self) -> Option<String>;

    /// Snapshot of live runtime info (provider/model/mode/session id).
    fn runtime_info(&self) -> AgentRuntimeInfo;

    /// Persistence handle for resume/reload, if the provider supports it.
    fn describe_persistence(&self) -> Option<PersistenceHandle> {
        None
    }

    /// Submit a prompt, starting a turn. The resulting events arrive via the
    /// channel returned from [`AgentSession::subscribe_events`].
    async fn prompt(&self, input: PromptInput) -> Result<(), AgentError>;

    /// Cancel the in-flight turn, if any.
    async fn cancel(&self) -> Result<(), AgentError>;

    /// Close the underlying provider session. Idempotent.
    async fn close(&self) -> Result<(), AgentError>;

    /// Subscribe to the live event stream from this session. Each subscriber
    /// gets an independent receiver. Returns `None` if the provider does not
    /// surface a stream (e.g. fully synchronous mocks drive the pipeline
    /// directly).
    fn subscribe_events(&self) -> Option<tokio::sync::broadcast::Receiver<AgentStreamEvent>> {
        None
    }
}

/// Factory that creates provider sessions. The manager calls this; it never
/// launches processes itself.
#[async_trait]
pub trait AgentProvider: Send + Sync {
    /// Provider id (`claude`, `codex`, `opencode`, …).
    fn id(&self) -> &str;

    /// Create a new live session for `config`.
    async fn create_session(
        &self,
        config: ProviderSessionConfig,
    ) -> Result<Box<dyn AgentSession>, AgentError>;
}
