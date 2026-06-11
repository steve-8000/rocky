//! Error type for the agent control plane.

use thiserror::Error;

/// Errors surfaced by the agent manager, timeline store, and permission queue.
#[derive(Debug, Error)]
pub enum AgentError {
    /// No agent with the given id is known to the manager.
    #[error("agent not found: {0}")]
    NotFound(String),

    /// The requested lifecycle transition is not permitted by the state
    /// machine (`AgentStatus::can_transition_to`).
    #[error("illegal status transition for agent {agent_id}: {from:?} -> {to:?}")]
    IllegalTransition {
        agent_id: String,
        from: rocky_agent_domain::AgentStatus,
        to: rocky_agent_domain::AgentStatus,
    },

    /// No pending permission with the given request id.
    #[error("permission request not found: {0}")]
    PermissionNotFound(String),

    /// Persistence failure (atomic write / timeline append).
    #[error("persistence error: {0}")]
    Persistence(String),

    /// Provider-side failure (session creation, prompt, cancel, close).
    #[error("provider error: {0}")]
    Provider(String),
}
