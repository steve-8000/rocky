//! Frozen boundary types shared across the Rust agent runtime.
//!
//! These mirror the wire/timeline contracts in
//! `core/packages/server/src/server/agent/agent-sdk-types.ts` (the
//! `AgentTimelineItem`, `AgentStreamEvent`, `ToolCallDetail`,
//! `AgentPermissionRequest/Response`, `AgentRuntimeInfo`, `AgentUsage` unions).
//!
//! Serialization MUST stay wire-compatible with the existing TypeScript daemon:
//! camelCase fields, internally-tagged `type` unions, optional fields omitted
//! when absent. Parse permissively at the boundary; serialize only known shapes.
//!
//! This crate is intentionally dependency-light (serde only) so both the ACP
//! transport (`rocky-acp`) and the agent manager (`rocky-agents`) can depend on
//! it without cycles.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Token/usage accounting reported by providers (`AgentUsage`).
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentUsage {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cached_input_tokens: Option<u64>,
    /// Preserve any extra provider-specific usage fields verbatim.
    #[serde(flatten, default, skip_serializing_if = "serde_json::Map::is_empty")]
    pub extra: serde_json::Map<String, Value>,
}

/// Icon hints for `plain_text` tool details (`ToolCallIconName`). Kept as a
/// free string to avoid drift; the UI tolerates unknown values.
pub type ToolCallIconName = String;

/// Normalized tool-call detail union (`ToolCallDetail`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum ToolCallDetail {
    Shell {
        command: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        cwd: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        output: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        exit_code: Option<i64>,
    },
    Read {
        file_path: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        content: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        offset: Option<i64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        limit: Option<i64>,
    },
    Edit {
        file_path: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        old_string: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        new_string: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        unified_diff: Option<String>,
    },
    Write {
        file_path: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        content: Option<String>,
    },
    Search {
        query: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        tool_name: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        content: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        file_paths: Option<Vec<String>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        web_results: Option<Vec<WebResult>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        annotations: Option<Vec<String>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        num_files: Option<i64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        num_matches: Option<i64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        duration_ms: Option<i64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        duration_seconds: Option<f64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        truncated: Option<bool>,
        #[serde(skip_serializing_if = "Option::is_none")]
        mode: Option<String>,
    },
    Fetch {
        url: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        prompt: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        result: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        code: Option<i64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        code_text: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        bytes: Option<i64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        duration_ms: Option<i64>,
    },
    WorktreeSetup {
        worktree_path: String,
        branch_name: String,
        log: String,
        commands: Vec<WorktreeSetupCommand>,
        #[serde(skip_serializing_if = "Option::is_none")]
        truncated: Option<bool>,
    },
    SubAgent {
        #[serde(skip_serializing_if = "Option::is_none")]
        sub_agent_type: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        description: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        child_session_id: Option<String>,
        log: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        actions: Option<Vec<SubAgentAction>>,
    },
    PlainText {
        #[serde(skip_serializing_if = "Option::is_none")]
        label: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        text: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        icon: Option<ToolCallIconName>,
    },
    Plan {
        text: String,
    },
    Unknown {
        input: Value,
        output: Value,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct WebResult {
    pub title: String,
    pub url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeSetupCommand {
    pub index: i64,
    pub command: String,
    pub cwd: String,
    pub log: String,
    pub status: String,
    pub exit_code: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SubAgentAction {
    pub index: i64,
    pub tool_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
}

/// Status of a tool-call timeline item.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ToolCallStatus {
    Running,
    Completed,
    Failed,
    Canceled,
}

/// A single todo entry inside an `AgentTimelineItem::Todo`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TodoItem {
    pub text: String,
    pub completed: bool,
}

/// Append-only timeline row (`AgentTimelineItem`). Internally tagged on `type`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum AgentTimelineItem {
    UserMessage {
        text: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        message_id: Option<String>,
    },
    AssistantMessage {
        text: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        message_id: Option<String>,
    },
    Reasoning {
        text: String,
    },
    ToolCall {
        call_id: String,
        name: String,
        status: ToolCallStatus,
        detail: Box<ToolCallDetail>,
        /// `error` is `null` unless status is failed; preserve provider value.
        #[serde(default)]
        error: Value,
        #[serde(skip_serializing_if = "Option::is_none")]
        metadata: Option<serde_json::Map<String, Value>>,
    },
    Todo {
        items: Vec<TodoItem>,
    },
    Error {
        message: String,
    },
    Compaction {
        status: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        trigger: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        pre_tokens: Option<u64>,
    },
}

/// Live runtime info (`AgentRuntimeInfo`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentRuntimeInfo {
    pub provider: String,
    pub session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thinking_option_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mode_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub extra: Option<serde_json::Map<String, Value>>,
}

/// Permission request kind (`AgentPermissionRequestKind`).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PermissionKind {
    Tool,
    Plan,
    Question,
    Mode,
    Other,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PermissionAction {
    pub id: String,
    pub label: String,
    pub behavior: PermissionBehavior,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub variant: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub intent: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PermissionBehavior {
    Allow,
    Deny,
}

/// Permission request (`AgentPermissionRequest`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentPermissionRequest {
    pub id: String,
    pub provider: String,
    pub name: String,
    pub kind: PermissionKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input: Option<serde_json::Map<String, Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<ToolCallDetail>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub suggestions: Option<Vec<Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub actions: Option<Vec<PermissionAction>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<serde_json::Map<String, Value>>,
}

/// Permission response (`AgentPermissionResponse`), tagged on `behavior`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "behavior", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum AgentPermissionResponse {
    Allow {
        #[serde(skip_serializing_if = "Option::is_none")]
        selected_action_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        updated_input: Option<serde_json::Map<String, Value>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        updated_permissions: Option<Vec<Value>>,
    },
    Deny {
        #[serde(skip_serializing_if = "Option::is_none")]
        selected_action_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        message: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        interrupt: Option<bool>,
    },
}

/// An agent mode (`AgentMode`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentMode {
    pub id: String,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

/// Live provider stream event (`AgentStreamEvent`), internally tagged on `type`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum AgentStreamEvent {
    ThreadStarted {
        session_id: String,
        provider: String,
    },
    TurnStarted {
        provider: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        turn_id: Option<String>,
    },
    TurnCompleted {
        provider: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        usage: Option<AgentUsage>,
        #[serde(skip_serializing_if = "Option::is_none")]
        turn_id: Option<String>,
    },
    UsageUpdated {
        provider: String,
        usage: AgentUsage,
        #[serde(skip_serializing_if = "Option::is_none")]
        turn_id: Option<String>,
    },
    ModeChanged {
        provider: String,
        current_mode_id: Option<String>,
        available_modes: Vec<AgentMode>,
    },
    ModelChanged {
        provider: String,
        runtime_info: AgentRuntimeInfo,
    },
    ThinkingOptionChanged {
        provider: String,
        thinking_option_id: Option<String>,
    },
    TurnFailed {
        provider: String,
        error: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        code: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        diagnostic: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        turn_id: Option<String>,
    },
    TurnCanceled {
        provider: String,
        reason: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        turn_id: Option<String>,
    },
    Timeline {
        item: Box<AgentTimelineItem>,
        provider: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        turn_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        timestamp: Option<String>,
    },
    PermissionRequested {
        provider: String,
        request: Box<AgentPermissionRequest>,
        #[serde(skip_serializing_if = "Option::is_none")]
        turn_id: Option<String>,
    },
    PermissionResolved {
        provider: String,
        request_id: String,
        resolution: AgentPermissionResponse,
        #[serde(skip_serializing_if = "Option::is_none")]
        turn_id: Option<String>,
    },
    AttentionRequired {
        provider: String,
        reason: String,
        timestamp: String,
    },
}

/// Agent lifecycle status, matching `AGENT_LIFECYCLE_STATUSES`
/// (`core/packages/protocol/src/agent-lifecycle.ts`).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AgentStatus {
    Initializing,
    Idle,
    Running,
    Error,
    Closed,
}

impl AgentStatus {
    /// Allowed transitions per the Phase 4 state machine in
    /// `core/docs/rust-rebuild/04-agent-runtime-and-providers.md`.
    pub fn can_transition_to(self, next: AgentStatus) -> bool {
        use AgentStatus::*;
        match (self, next) {
            // Idempotent stays are allowed.
            (a, b) if a == b => true,
            (Initializing, Idle | Error | Closed) => true,
            (Idle, Running | Error | Closed) => true,
            (Running, Idle | Error | Closed) => true,
            (Error, Closed | Idle) => true,
            // closed is terminal
            (Closed, _) => false,
            _ => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timeline_tool_call_roundtrips_camel_and_tag() {
        let item = AgentTimelineItem::ToolCall {
            call_id: "c1".into(),
            name: "Bash".into(),
            status: ToolCallStatus::Completed,
            detail: Box::new(ToolCallDetail::Shell {
                command: "ls".into(),
                cwd: Some("/tmp".into()),
                output: Some("a\nb".into()),
                exit_code: Some(0),
            }),
            error: Value::Null,
            metadata: None,
        };
        let json = serde_json::to_value(&item).unwrap();
        assert_eq!(json["type"], "tool_call");
        assert_eq!(json["callId"], "c1");
        assert_eq!(json["detail"]["type"], "shell");
        assert_eq!(json["detail"]["exitCode"], 0);
        let back: AgentTimelineItem = serde_json::from_value(json).unwrap();
        assert_eq!(back, item);
    }

    #[test]
    fn stream_event_permission_requested_roundtrips() {
        let ev = AgentStreamEvent::PermissionRequested {
            provider: "amaze".into(),
            request: Box::new(AgentPermissionRequest {
                id: "p1".into(),
                provider: "amaze".into(),
                name: "write".into(),
                kind: PermissionKind::Tool,
                title: Some("Write file".into()),
                description: None,
                input: None,
                detail: None,
                suggestions: None,
                actions: Some(vec![PermissionAction {
                    id: "allow".into(),
                    label: "Allow".into(),
                    behavior: PermissionBehavior::Allow,
                    variant: Some("primary".into()),
                    intent: None,
                }]),
                metadata: None,
            }),
            turn_id: Some("t1".into()),
        };
        let json = serde_json::to_value(&ev).unwrap();
        assert_eq!(json["type"], "permission_requested");
        assert_eq!(json["request"]["kind"], "tool");
        assert_eq!(json["turnId"], "t1");
        let back: AgentStreamEvent = serde_json::from_value(json).unwrap();
        assert_eq!(back, ev);
    }

    #[test]
    fn permission_response_tagged_on_behavior() {
        let deny = AgentPermissionResponse::Deny {
            selected_action_id: None,
            message: Some("no".into()),
            interrupt: Some(true),
        };
        let json = serde_json::to_value(&deny).unwrap();
        assert_eq!(json["behavior"], "deny");
        assert_eq!(json["interrupt"], true);
        let back: AgentPermissionResponse = serde_json::from_value(json).unwrap();
        assert_eq!(back, deny);
    }

    #[test]
    fn status_transitions() {
        use AgentStatus::*;
        assert!(Initializing.can_transition_to(Idle));
        assert!(Idle.can_transition_to(Running));
        assert!(Running.can_transition_to(Idle));
        assert!(Error.can_transition_to(Closed));
        assert!(!Closed.can_transition_to(Idle));
        assert!(!Initializing.can_transition_to(Running));
    }
}
