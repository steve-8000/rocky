//! In-memory permission queue.
//!
//! Mirrors the permission requirements in
//! `04-agent-runtime-and-providers.md` (permissions, lines 241-262): preserve
//! request id, agent id, kind, title/description/input/detail,
//! suggestions/actions, metadata; allow/deny responses with deny-interrupt and
//! follow-up prompt behavior; survive client reconnect (kept in manager memory,
//! keyed by agent); broadcast on enqueue/resolve. Entry points
//! `list_pending_permissions` / `respond_to_permission` are consumed by MCP
//! later (see `permission-response.ts`).
//!
//! The queue itself is broadcast-agnostic; the [`crate::manager::AgentManager`]
//! owns the broadcast channel and emits `PermissionRequested` /
//! `PermissionResolved` stream events around these calls (matching the TS
//! `recordAndDispatch` flow). Keeping the queue pure makes reconnect trivial:
//! a new subscriber simply calls [`PermissionQueue::list_pending`].

use std::collections::HashMap;

use rocky_agent_domain::{AgentPermissionRequest, AgentPermissionResponse};

use crate::error::AgentError;

/// A queued permission request plus the agent it belongs to.
#[derive(Debug, Clone, PartialEq)]
pub struct PendingPermission {
    pub agent_id: String,
    pub request: AgentPermissionRequest,
}

/// Follow-up the provider asked for after a resolution. Carries the prompt text
/// to start a follow-up turn (`AgentPermissionResult.followUpPrompt`).
#[derive(Debug, Clone, PartialEq)]
pub struct FollowUp {
    pub prompt: String,
}

/// Outcome of resolving a permission. `interrupt` reflects the deny-interrupt
/// flag from `AgentPermissionResponse::Deny { interrupt }`.
#[derive(Debug, Clone, PartialEq)]
pub struct Resolution {
    pub agent_id: String,
    pub request_id: String,
    pub response: AgentPermissionResponse,
    pub interrupt: bool,
    pub follow_up: Option<FollowUp>,
}

/// In-memory permission queue keyed by agent id, preserving FIFO order.
#[derive(Debug, Default)]
pub struct PermissionQueue {
    /// agent_id -> ordered pending requests.
    by_agent: HashMap<String, Vec<AgentPermissionRequest>>,
    /// request_id -> agent_id, for O(1) resolve.
    index: HashMap<String, String>,
}

impl PermissionQueue {
    pub fn new() -> Self {
        Self::default()
    }

    /// Enqueue a request for `agent_id`. Returns the stored pending entry. A
    /// duplicate request id replaces the prior entry in place.
    pub fn enqueue(
        &mut self,
        agent_id: &str,
        request: AgentPermissionRequest,
    ) -> PendingPermission {
        let request_id = request.id.clone();
        let queue = self.by_agent.entry(agent_id.to_string()).or_default();
        if let Some(existing) = queue.iter_mut().find(|r| r.id == request_id) {
            *existing = request.clone();
        } else {
            queue.push(request.clone());
        }
        self.index.insert(request_id, agent_id.to_string());
        PendingPermission {
            agent_id: agent_id.to_string(),
            request,
        }
    }

    /// List pending requests. When `agent_id` is `Some`, only that agent's
    /// queue is returned; otherwise all pending requests across agents.
    pub fn list_pending(&self, agent_id: Option<&str>) -> Vec<PendingPermission> {
        match agent_id {
            Some(id) => self
                .by_agent
                .get(id)
                .map(|reqs| {
                    reqs.iter()
                        .map(|r| PendingPermission {
                            agent_id: id.to_string(),
                            request: r.clone(),
                        })
                        .collect()
                })
                .unwrap_or_default(),
            None => self
                .by_agent
                .iter()
                .flat_map(|(id, reqs)| {
                    reqs.iter().map(move |r| PendingPermission {
                        agent_id: id.clone(),
                        request: r.clone(),
                    })
                })
                .collect(),
        }
    }

    /// Whether the agent has any pending requests.
    pub fn has_pending(&self, agent_id: &str) -> bool {
        self.by_agent
            .get(agent_id)
            .map(|q| !q.is_empty())
            .unwrap_or(false)
    }

    /// Resolve a request: remove it from the queue and compute interrupt /
    /// follow-up signals. `follow_up` is supplied by the caller (the provider
    /// decides whether a follow-up turn is needed); the queue does not invent
    /// it. Returns the resolution, or `PermissionNotFound` if unknown.
    pub fn resolve(
        &mut self,
        request_id: &str,
        response: AgentPermissionResponse,
        follow_up: Option<FollowUp>,
    ) -> Result<Resolution, AgentError> {
        let agent_id = self
            .index
            .remove(request_id)
            .ok_or_else(|| AgentError::PermissionNotFound(request_id.to_string()))?;
        if let Some(queue) = self.by_agent.get_mut(&agent_id) {
            queue.retain(|r| r.id != request_id);
            if queue.is_empty() {
                self.by_agent.remove(&agent_id);
            }
        }
        let interrupt = matches!(
            &response,
            AgentPermissionResponse::Deny {
                interrupt: Some(true),
                ..
            }
        );
        Ok(Resolution {
            agent_id,
            request_id: request_id.to_string(),
            response,
            interrupt,
            follow_up,
        })
    }

    /// Remove a request without computing a resolution (used when a
    /// `PermissionResolved` event arrives from the provider and the manager has
    /// already broadcast the resolution). Missing ids are ignored.
    pub fn resolve_silently(&mut self, request_id: &str) -> bool {
        let Some(agent_id) = self.index.remove(request_id) else {
            return false;
        };
        if let Some(queue) = self.by_agent.get_mut(&agent_id) {
            queue.retain(|r| r.id != request_id);
            if queue.is_empty() {
                self.by_agent.remove(&agent_id);
            }
        }
        true
    }

    /// Drop all pending requests for an agent (used on close/archive).
    pub fn clear_agent(&mut self, agent_id: &str) {
        if let Some(queue) = self.by_agent.remove(agent_id) {
            for req in queue {
                self.index.remove(&req.id);
            }
        }
    }
}
