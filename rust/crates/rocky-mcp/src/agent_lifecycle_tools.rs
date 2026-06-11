//! Agent lifecycle MCP tools: `kill_agent`, `update_agent`, `set_agent_mode`,
//! and `get_agent_activity`.
//!
//! Mirrors `core/packages/server/src/server/agent/mcp-server.ts`:
//! - `kill_agent` (lines 1557-1577) — terminate the session permanently.
//! - `update_agent` (lines 1579-1619) — apply name/labels + runtime settings.
//! - `set_agent_mode` (lines 2460-2482) — switch the session mode.
//! - `get_agent_activity` (lines 2404-2458) — curated timeline summary.
//!
//! All four delegate to the shared [`rocky_agents::AgentManager`] already wired
//! into the MCP context, so they observe the same live agent state as the WS
//! session dispatcher.

use std::collections::HashMap;

use rocky_agent_domain::AgentTimelineItem;
use serde_json::{json, Value};

use crate::protocol::{tool_result, ToolDescriptor, ToolError, ToolRegistry};
use crate::tools::{agent_err, as_object, boxed, object_schema, opt_labels, opt_str, req_str};

/// Register the agent lifecycle tools on `registry`.
pub fn register(registry: &mut ToolRegistry) {
    register_kill_agent(registry);
    register_update_agent(registry);
    register_set_agent_mode(registry);
    register_get_agent_activity(registry);
}

/// `kill_agent` (mcp-server.ts:1557-1577). The Rust manager has no separate
/// "kill" vs "close"; closing the session ends the run and clears live state,
/// matching `closeAgentCommand`. The agent record is kept (resumable), which is
/// the same outcome as the TS close path.
fn register_kill_agent(registry: &mut ToolRegistry) {
    registry.register(
        ToolDescriptor {
            name: "kill_agent".into(),
            title: "Kill agent".into(),
            description: "Terminate an agent session permanently.".into(),
            input_schema: object_schema(&[("agentId", "string")], &[]),
        },
        boxed(|args, ctx| async move {
            let map = as_object(&args)?;
            let agent_id = req_str(map, "agentId")?;
            ctx.agent_manager()
                .close(&agent_id)
                .await
                .map_err(agent_err)?;
            Ok(tool_result(json!({ "success": true })))
        }),
    );
}

/// `update_agent` (mcp-server.ts:1579-1619). Applies runtime settings
/// (`modeId`/`model`/`thinkingOptionId`) first, then name/labels. Only the
/// settings the Rust manager exposes are applied; unknown settings are ignored
/// rather than erroring, matching the optional-field semantics of the TS tool.
fn register_update_agent(registry: &mut ToolRegistry) {
    registry.register(
        ToolDescriptor {
            name: "update_agent".into(),
            title: "Update agent".into(),
            description: "Update an agent name, labels, and/or runtime settings.".into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "agentId": { "type": "string" },
                    "name": { "type": "string" },
                    "labels": { "type": "object", "additionalProperties": { "type": "string" } },
                    "settings": { "type": "object" },
                },
                "required": ["agentId"],
                "additionalProperties": true,
            }),
        },
        boxed(|args, ctx| async move {
            let map = as_object(&args)?;
            let agent_id = req_str(map, "agentId")?;
            let settings = map.get("settings").and_then(Value::as_object);

            if let Some(settings) = settings {
                if let Some(mode_id) = settings.get("modeId").and_then(Value::as_str) {
                    ctx.agent_manager()
                        .set_agent_mode(&agent_id, mode_id)
                        .await
                        .map_err(agent_err)?;
                }
                if let Some(model) = settings.get("model").and_then(Value::as_str) {
                    ctx.agent_manager()
                        .set_agent_model(&agent_id, model)
                        .await
                        .map_err(agent_err)?;
                }
                if let Some(thinking) = settings.get("thinkingOptionId").and_then(Value::as_str) {
                    ctx.agent_manager()
                        .set_agent_thinking(&agent_id, thinking)
                        .await
                        .map_err(agent_err)?;
                }
            }

            let name = opt_str(map, "name")?;
            let labels = opt_labels(map, "labels")?;
            let labels: Option<HashMap<String, String>> = if labels.is_empty() {
                None
            } else {
                Some(labels.into_iter().collect())
            };
            ctx.agent_manager()
                .update_agent_metadata(&agent_id, name, labels)
                .await
                .map_err(agent_err)?;

            Ok(tool_result(json!({ "success": true })))
        }),
    );
}

/// `set_agent_mode` (mcp-server.ts:2460-2482). Switches the session mode and
/// returns the new mode id.
fn register_set_agent_mode(registry: &mut ToolRegistry) {
    registry.register(
        ToolDescriptor {
            name: "set_agent_mode".into(),
            title: "Set agent session mode".into(),
            description:
                "Switch the agent's session mode (plan, bypassPermissions, read-only, auto, etc.)."
                    .into(),
            input_schema: object_schema(&[("agentId", "string"), ("modeId", "string")], &[]),
        },
        boxed(|args, ctx| async move {
            let map = as_object(&args)?;
            let agent_id = req_str(map, "agentId")?;
            let mode_id = req_str(map, "modeId")?;
            ctx.agent_manager()
                .set_agent_mode(&agent_id, &mode_id)
                .await
                .map_err(agent_err)?;
            Ok(tool_result(json!({ "success": true, "newMode": mode_id })))
        }),
    );
}

/// `get_agent_activity` (mcp-server.ts:2404-2458). Returns a curated summary of
/// the most-recent timeline entries (tail), plus the total update count and the
/// agent's current mode id.
fn register_get_agent_activity(registry: &mut ToolRegistry) {
    registry.register(
        ToolDescriptor {
            name: "get_agent_activity".into(),
            title: "Get agent activity".into(),
            description: "Return recent agent timeline entries as a curated summary.".into(),
            input_schema: object_schema(&[("agentId", "string")], &[("limit", "number")]),
        },
        boxed(|args, ctx| async move {
            let map = as_object(&args)?;
            let agent_id = req_str(map, "agentId")?;
            let limit = map.get("limit").and_then(Value::as_u64).map(|n| n as usize);

            let agent = ctx
                .agent_manager()
                .get(&agent_id)
                .await
                .ok_or_else(|| {
                    ToolError::execution("agent_not_found", format!("Agent {agent_id} not found"))
                })?;

            // Fetch the full timeline (0 = all), then take the tail slice.
            let rows = ctx.agent_manager().fetch_timeline(&agent_id, 0, 0).await;
            let total = rows.len();
            let shown_rows: Vec<&AgentTimelineItem> = match limit {
                Some(limit) if limit < total => rows[total - limit..].iter().map(|r| &r.item).collect(),
                _ => rows.iter().map(|r| &r.item).collect(),
            };
            let shown = shown_rows.len();

            let curated = curate_agent_activity(&shown_rows);
            let noun = if total == 1 { "activity" } else { "activities" };
            let count_header = match limit {
                Some(limit) if shown < total => {
                    format!("Showing {shown} of {total} {noun} (limited to {limit})")
                }
                _ => format!("Showing all {total} {noun}"),
            };
            let content = format!("{count_header}\n\n{curated}");

            let current_mode_id = agent
                .runtime_info
                .as_ref()
                .and_then(|r| r.mode_id.clone());

            Ok(tool_result(json!({
                "agentId": agent_id,
                "updateCount": total,
                "currentModeId": current_mode_id,
                "content": content,
            })))
        }),
    );
}

/// Render timeline items into a compact, human-readable activity summary, one
/// line per entry. Mirrors the intent of the TS `curateAgentActivity` (a terse
/// projection of each timeline row), kept deterministic for orchestration.
fn curate_agent_activity(items: &[&AgentTimelineItem]) -> String {
    if items.is_empty() {
        return "(no activity)".to_string();
    }
    items
        .iter()
        .map(|item| match item {
            AgentTimelineItem::UserMessage { text, .. } => {
                format!("user: {}", truncate_line(text))
            }
            AgentTimelineItem::AssistantMessage { text, .. } => {
                format!("assistant: {}", truncate_line(text))
            }
            AgentTimelineItem::Reasoning { text } => {
                format!("reasoning: {}", truncate_line(text))
            }
            AgentTimelineItem::ToolCall { name, status, .. } => {
                format!("tool {name} [{}]", serde_json::to_value(status)
                    .ok()
                    .and_then(|v| v.as_str().map(str::to_string))
                    .unwrap_or_else(|| "unknown".to_string()))
            }
            AgentTimelineItem::Todo { items } => format!("todo: {} item(s)", items.len()),
            AgentTimelineItem::Error { message } => format!("error: {}", truncate_line(message)),
            AgentTimelineItem::Compaction { status, .. } => format!("compaction: {status}"),
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// Collapse whitespace and cap a single rendered line to keep summaries compact.
fn truncate_line(text: &str) -> String {
    let collapsed = text.split_whitespace().collect::<Vec<_>>().join(" ");
    const MAX: usize = 200;
    if collapsed.chars().count() > MAX {
        let truncated: String = collapsed.chars().take(MAX).collect();
        format!("{truncated}…")
    } else {
        collapsed
    }
}
