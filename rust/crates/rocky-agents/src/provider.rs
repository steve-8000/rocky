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
use serde::{Deserialize, Serialize};

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

/// A model a provider advertises for a cwd, as surfaced to the WebUI by the
/// `list_provider_models` RPC.
///
/// `rocky-agent-domain` has no model type (it only carries the *selected* model
/// as a `String` on `AgentRuntimeInfo` and `ProviderSessionConfig`), so this
/// minimal, serde-serializable shape lives here for the ws layer to emit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentModelDef {
    /// Provider id this model belongs to (`AgentProvider::id`).
    pub provider: String,
    /// Stable model id (e.g. `anthropic/claude-...`).
    pub id: String,
    /// Human-facing label.
    pub label: String,
    /// Optional description.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// Per-model "thinking" (thought_level) selector choices. TS attaches the
    /// session's `thought_level` config options to every model definition
    /// (`deriveModelDefinitionsFromACP`, acp-agent.ts:517-540); the WebUI shows
    /// the thinking picker only when a model carries more than one option.
    /// Omitted from the wire when empty.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub thinking_options: Vec<AgentSelectOption>,
    /// Default thinking option id (the option whose value equals the agent's
    /// current `thought_level`). Omitted from the wire when absent.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_thinking_option_id: Option<String>,
}

/// A choice within a select-style option (e.g. a model's thinking levels).
/// Mirrors the wire `AgentSelectOption` (`messages.ts:214-220`):
/// `{ id, label, description?, isDefault? }`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSelectOption {
    /// Stable option id.
    pub id: String,
    /// Human-facing label.
    pub label: String,
    /// Optional description.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// True when this is the option's current/default choice. Omitted when false.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub is_default: bool,
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

    /// Set the thinking (`thought_level`) option, returning the canonical id
    /// the provider applied. Default: unsupported. ACP-backed sessions override
    /// this.
    async fn set_thinking_option(&self, _option_id: &str) -> Result<String, AgentError> {
        Err(AgentError::Provider(
            "provider does not support thinking-option selection".into(),
        ))
    }

    /// Set the model, returning the canonical model id the provider applied.
    /// Default: unsupported. ACP-backed sessions override this.
    async fn set_model(&self, _model_id: &str) -> Result<String, AgentError> {
        Err(AgentError::Provider(
            "provider does not support model selection".into(),
        ))
    }

    /// Set the session mode. Default: unsupported. ACP-backed sessions override
    /// this.
    async fn set_mode(&self, _mode_id: &str) -> Result<(), AgentError> {
        Err(AgentError::Provider(
            "provider does not support mode selection".into(),
        ))
    }

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

    /// Discover the models this provider exposes for `cwd`. Maps to the WebUI
    /// `list_provider_models` RPC. Default: empty (providers that cannot probe
    /// models, and mocks, do not break).
    async fn list_models(&self, _cwd: &str) -> Result<Vec<AgentModelDef>, AgentError> {
        Ok(vec![])
    }

    /// Discover the modes this provider exposes for `cwd`. Maps to the WebUI
    /// `list_provider_modes` RPC. Default: empty.
    async fn list_modes(
        &self,
        _cwd: &str,
    ) -> Result<Vec<rocky_agent_domain::AgentMode>, AgentError> {
        Ok(vec![])
    }

    /// Discover the features this provider exposes for `cwd`. Maps to the WebUI
    /// `list_provider_features` RPC. Default: empty (amaze exposes none over ACP).
    async fn list_features(&self, _cwd: &str) -> Result<Vec<serde_json::Value>, AgentError> {
        Ok(vec![])
    }
}
