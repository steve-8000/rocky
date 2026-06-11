//! MCP tool registrations: the mission + core agent tool subset.
//!
//! Tool names, titles, and input schemas mirror
//! `core/packages/server/src/server/agent/mcp-server.ts`. Mission tools delegate
//! to [`rocky_mission_control::FileBackedMissionControlService`]
//! (mcp-server.ts lines 1344-1499); agent tools delegate to
//! [`rocky_agents::AgentManager`] (mcp-server.ts lines 888-1342, 1500-1577,
//! 2484-2546).
//!
//! Functional status per tool:
//! - Fully functional (delegate to the manager / mission service):
//!   `create_mission`, `list_missions`, `inspect_mission`,
//!   `create_mission_task`, `update_mission_task`, `list_agents`,
//!   `get_agent_status`, `cancel_agent`, `archive_agent`,
//!   `list_pending_permissions`, `respond_to_permission`.
//! - Needs provider wiring (descriptor + validation + manager call, but a live
//!   provider session must be supplied by the orchestrator): `create_agent`
//!   (works when `McpContext::with_provider` is used; otherwise returns a
//!   structured `not_wired` error), `send_agent_prompt`, `wait_for_agent`
//!   (always `not_wired` in this phase — the manager exposes no prompt/wait
//!   entry point yet).

use std::collections::BTreeMap;

use rocky_agent_domain::{AgentPermissionResponse, AgentStatus};
use rocky_agents::{AgentError, CreateAgentOptions, FollowUp, ManagedAgent};
use rocky_mission_control::{
    CreateMissionInput, CreateMissionTaskInput, MissionControlError, MissionStatus,
    MissionTaskIsolation, MissionTaskStatus, UpdateMissionTaskInput,
};
use serde_json::{json, Map, Value};

use crate::context::CallCtx;
use crate::protocol::{tool_result, ToolDescriptor, ToolError, ToolRegistry};

/// Register the mission + core agent tool subset on `registry`.
pub fn register_all(registry: &mut ToolRegistry) {
    register_mission_tools(registry);
    register_agent_tools(registry);
}

// --- argument helpers -------------------------------------------------------

fn as_object(args: &Value) -> Result<&Map<String, Value>, ToolError> {
    match args {
        Value::Object(map) => Ok(map),
        Value::Null => Err(ToolError::invalid_params("missing arguments object")),
        _ => Err(ToolError::invalid_params("arguments must be an object")),
    }
}

/// Required, non-empty (after trim) string field.
fn req_str(args: &Map<String, Value>, key: &str) -> Result<String, ToolError> {
    let raw = args
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| ToolError::invalid_params(format!("`{key}` is required and must be a string")))?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(ToolError::invalid_params(format!("`{key}` must not be empty")));
    }
    Ok(trimmed.to_string())
}

/// Optional string field. Returns `None` when absent or JSON null; errors when
/// present but not a string.
fn opt_str(args: &Map<String, Value>, key: &str) -> Result<Option<String>, ToolError> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) => Ok(Some(s.clone())),
        Some(_) => Err(ToolError::invalid_params(format!("`{key}` must be a string"))),
    }
}

/// Optional `Option<Option<String>>` patch field: absent -> `None`; JSON null
/// -> `Some(None)` (clear); string -> `Some(Some(..))`.
fn opt_nullable_str(
    args: &Map<String, Value>,
    key: &str,
) -> Result<Option<Option<String>>, ToolError> {
    match args.get(key) {
        None => Ok(None),
        Some(Value::Null) => Ok(Some(None)),
        Some(Value::String(s)) => Ok(Some(Some(s.clone()))),
        Some(_) => Err(ToolError::invalid_params(format!(
            "`{key}` must be a string or null"
        ))),
    }
}

fn opt_bool(args: &Map<String, Value>, key: &str) -> Result<Option<bool>, ToolError> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Bool(b)) => Ok(Some(*b)),
        Some(_) => Err(ToolError::invalid_params(format!("`{key}` must be a boolean"))),
    }
}

fn opt_str_array(args: &Map<String, Value>, key: &str) -> Result<Option<Vec<String>>, ToolError> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Array(items)) => {
            let mut out = Vec::with_capacity(items.len());
            for item in items {
                let s = item.as_str().ok_or_else(|| {
                    ToolError::invalid_params(format!("`{key}` must be an array of strings"))
                })?;
                out.push(s.to_string());
            }
            Ok(Some(out))
        }
        Some(_) => Err(ToolError::invalid_params(format!("`{key}` must be an array"))),
    }
}

fn opt_labels(args: &Map<String, Value>, key: &str) -> Result<BTreeMap<String, String>, ToolError> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(BTreeMap::new()),
        Some(Value::Object(map)) => {
            let mut out = BTreeMap::new();
            for (k, v) in map {
                let value = v.as_str().ok_or_else(|| {
                    ToolError::invalid_params(format!("`{key}` values must be strings"))
                })?;
                out.insert(k.clone(), value.to_string());
            }
            Ok(out)
        }
        Some(_) => Err(ToolError::invalid_params(format!(
            "`{key}` must be a string map"
        ))),
    }
}

/// Deserialize an optional serde enum from a JSON string field.
fn opt_enum<T: serde::de::DeserializeOwned>(
    args: &Map<String, Value>,
    key: &str,
) -> Result<Option<T>, ToolError> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(value @ Value::String(_)) => serde_json::from_value(value.clone())
            .map(Some)
            .map_err(|e| ToolError::invalid_params(format!("invalid `{key}`: {e}"))),
        Some(_) => Err(ToolError::invalid_params(format!("`{key}` must be a string"))),
    }
}

// --- error mapping ----------------------------------------------------------

fn mission_err(e: MissionControlError) -> ToolError {
    match &e {
        MissionControlError::InvalidMissionInput(_) | MissionControlError::InvalidMissionId(_) => {
            ToolError::invalid_params(e.to_string())
        }
        other => ToolError::execution(other.code(), other.to_string()),
    }
}

fn agent_err(e: AgentError) -> ToolError {
    let code = match &e {
        AgentError::NotFound(_) => "agent_not_found",
        AgentError::IllegalTransition { .. } => "illegal_transition",
        AgentError::PermissionNotFound(_) => "permission_not_found",
        AgentError::Persistence(_) => "persistence_error",
        AgentError::Provider(_) => "provider_error",
    };
    ToolError::execution(code, e.to_string())
}

// --- mission tools ----------------------------------------------------------

fn register_mission_tools(registry: &mut ToolRegistry) {
    // create_mission — mcp-server.ts lines 1345-1375.
    registry.register(
        ToolDescriptor {
            name: "create_mission".into(),
            title: "Create mission".into(),
            description:
                "Create a durable Mission Control mission. Use this before coordinating Leader/Teammate work."
                    .into(),
            input_schema: object_schema(
                &[("goal", "string")],
                &[
                    ("projectId", "string"),
                    ("workspaceId", "string"),
                    ("leaderAgentId", "string"),
                    ("chatRoomId", "string"),
                    ("boardPath", "string"),
                    ("status", "string"),
                ],
            ),
        },
        boxed(|args, ctx| async move {
            let map = as_object(&args)?;
            let goal = req_str(map, "goal")?;
            let leader = opt_str(map, "leaderAgentId")?
                .or_else(|| ctx.caller_agent_id().map(str::to_string));
            let input = CreateMissionInput {
                goal,
                status: opt_enum::<MissionStatus>(map, "status")?,
                project_id: opt_str(map, "projectId")?,
                workspace_id: opt_str(map, "workspaceId")?,
                leader_agent_id: leader,
                chat_room_id: opt_str(map, "chatRoomId")?,
                board_path: opt_str(map, "boardPath")?,
            };
            let mission = ctx
                .mission_control()
                .create_mission(input)
                .map_err(mission_err)?;
            Ok(tool_result(json!({ "mission": mission })))
        }),
    );

    // list_missions — mcp-server.ts lines 1377-1396.
    registry.register(
        ToolDescriptor {
            name: "list_missions".into(),
            title: "List missions".into(),
            description: "List durable Mission Control missions.".into(),
            input_schema: object_schema(&[], &[("includeArchived", "boolean")]),
        },
        boxed(|args, ctx| async move {
            let map = as_object(&args).ok();
            let include_archived = map
                .map(|m| opt_bool(m, "includeArchived"))
                .transpose()?
                .flatten()
                .unwrap_or(false);
            let missions = ctx
                .mission_control()
                .list_missions(include_archived)
                .map_err(mission_err)?;
            Ok(tool_result(json!({ "missions": missions })))
        }),
    );

    // inspect_mission — mcp-server.ts lines 1398-1417.
    registry.register(
        ToolDescriptor {
            name: "inspect_mission".into(),
            title: "Inspect mission".into(),
            description: "Inspect one Mission Control mission by ID.".into(),
            input_schema: object_schema(&[("missionId", "string")], &[]),
        },
        boxed(|args, ctx| async move {
            let map = as_object(&args)?;
            let mission_id = req_str(map, "missionId")?;
            let mission = ctx
                .mission_control()
                .inspect_mission(&mission_id)
                .map_err(mission_err)?;
            Ok(tool_result(json!({ "mission": mission })))
        }),
    );

    // create_mission_task — mcp-server.ts lines 1419-1461.
    registry.register(
        ToolDescriptor {
            name: "create_mission_task".into(),
            title: "Create mission task".into(),
            description: "Create a task on a Mission Control mission board.".into(),
            input_schema: object_schema(
                &[("missionId", "string"), ("title", "string")],
                &[
                    ("description", "string"),
                    ("acceptanceCriteria", "array"),
                    ("ownerAgentId", "string"),
                    ("rosterAgentId", "string"),
                    ("worktreePath", "string"),
                    ("isolation", "string"),
                    ("status", "string"),
                ],
            ),
        },
        boxed(|args, ctx| async move {
            let map = as_object(&args)?;
            let input = CreateMissionTaskInput {
                mission_id: req_str(map, "missionId")?,
                title: req_str(map, "title")?,
                description: opt_str(map, "description")?,
                acceptance_criteria: opt_str_array(map, "acceptanceCriteria")?,
                status: opt_enum::<MissionTaskStatus>(map, "status")?,
                owner_agent_id: opt_str(map, "ownerAgentId")?,
                roster_agent_id: opt_str(map, "rosterAgentId")?,
                worktree_path: opt_str(map, "worktreePath")?,
                isolation: opt_enum::<MissionTaskIsolation>(map, "isolation")?,
            };
            let (mission, task) = ctx
                .mission_control()
                .create_task(input)
                .map_err(mission_err)?;
            Ok(tool_result(json!({ "mission": mission, "task": task })))
        }),
    );

    // update_mission_task — mcp-server.ts lines 1463-1497.
    registry.register(
        ToolDescriptor {
            name: "update_mission_task".into(),
            title: "Update mission task".into(),
            description: "Update a task on a Mission Control mission board.".into(),
            input_schema: object_schema(
                &[("missionId", "string"), ("taskId", "string")],
                &[
                    ("title", "string"),
                    ("description", "string"),
                    ("acceptanceCriteria", "array"),
                    ("status", "string"),
                    ("ownerAgentId", "string"),
                    ("rosterAgentId", "string"),
                    ("worktreePath", "string"),
                    ("isolation", "string"),
                    ("result", "string"),
                ],
            ),
        },
        boxed(|args, ctx| async move {
            let map = as_object(&args)?;
            let input = UpdateMissionTaskInput {
                mission_id: req_str(map, "missionId")?,
                task_id: req_str(map, "taskId")?,
                title: opt_str(map, "title")?,
                description: opt_nullable_str(map, "description")?,
                acceptance_criteria: opt_str_array(map, "acceptanceCriteria")?,
                status: opt_enum::<MissionTaskStatus>(map, "status")?,
                owner_agent_id: opt_nullable_str(map, "ownerAgentId")?,
                roster_agent_id: opt_nullable_str(map, "rosterAgentId")?,
                worktree_path: opt_nullable_str(map, "worktreePath")?,
                isolation: opt_enum::<MissionTaskIsolation>(map, "isolation")?,
                result: opt_nullable_str(map, "result")?,
                verification: None,
            };
            let (mission, task) = ctx
                .mission_control()
                .update_task(input)
                .map_err(mission_err)?;
            Ok(tool_result(json!({ "mission": mission, "task": task })))
        }),
    );
}

// --- agent tools ------------------------------------------------------------

/// Compact metadata projection of a live agent (mirrors the
/// `AgentListItemPayload` subset the Rust slice owns).
fn agent_payload(agent: &ManagedAgent) -> Value {
    json!({
        "agentId": agent.id,
        "id": agent.id,
        "provider": agent.provider,
        "type": agent.provider,
        "status": agent.status,
        "cwd": agent.cwd,
        "title": agent.title,
        "labels": agent.labels,
        "requiresAttention": agent.requires_attention,
        "lastError": agent.last_error,
        "archivedAt": agent.archived_at,
        "createdAt": agent.created_at,
        "updatedAt": agent.updated_at,
    })
}

fn register_agent_tools(registry: &mut ToolRegistry) {
    // list_agents — mcp-server.ts lines 1285-1342. The Rust manager only owns
    // live agents; `includeArchived`/`cwd`/`statuses`/`limit` filter that set.
    registry.register(
        ToolDescriptor {
            name: "list_agents".into(),
            title: "List agents".into(),
            description: "List recent agents as compact metadata.".into(),
            input_schema: object_schema(
                &[],
                &[
                    ("includeArchived", "boolean"),
                    ("cwd", "string"),
                    ("statuses", "array"),
                    ("limit", "number"),
                ],
            ),
        },
        boxed(|args, ctx| async move {
            let map = as_object(&args).ok();
            let include_archived = map
                .map(|m| opt_bool(m, "includeArchived"))
                .transpose()?
                .flatten()
                .unwrap_or(false);
            let cwd = map.and_then(|m| opt_str(m, "cwd").ok().flatten());
            let statuses = map
                .map(|m| opt_str_array(m, "statuses"))
                .transpose()?
                .flatten();
            let limit = map
                .and_then(|m| m.get("limit"))
                .and_then(Value::as_u64)
                .map(|n| n as usize);

            let status_filter: Option<Vec<AgentStatus>> = match statuses {
                Some(list) => {
                    let mut parsed = Vec::with_capacity(list.len());
                    for s in &list {
                        let status = serde_json::from_value::<AgentStatus>(Value::String(s.clone()))
                            .map_err(|e| {
                                ToolError::invalid_params(format!("invalid status `{s}`: {e}"))
                            })?;
                        parsed.push(status);
                    }
                    Some(parsed)
                }
                None => None,
            };

            let agents: Vec<Value> = ctx
                .agent_manager()
                .list()
                .await
                .into_iter()
                .filter(|a| include_archived || a.archived_at.is_none())
                .filter(|a| !a.internal)
                .filter(|a| cwd.as_deref().is_none_or(|c| a.cwd == c))
                .filter(|a| {
                    status_filter
                        .as_ref()
                        .is_none_or(|set| set.contains(&a.status))
                })
                .map(|a| agent_payload(&a))
                .take(limit.unwrap_or(usize::MAX))
                .collect();

            Ok(tool_result(json!({ "agents": agents })))
        }),
    );

    // get_agent_status — mcp-server.ts lines 1235-1283.
    registry.register(
        ToolDescriptor {
            name: "get_agent_status".into(),
            title: "Get agent status".into(),
            description:
                "Return the latest snapshot for an agent, including lifecycle state and pending permissions."
                    .into(),
            input_schema: object_schema(&[("agentId", "string")], &[]),
        },
        boxed(|args, ctx| async move {
            let map = as_object(&args)?;
            let agent_id = req_str(map, "agentId")?;
            let agent = ctx
                .agent_manager()
                .get(&agent_id)
                .await
                .ok_or_else(|| ToolError::execution("agent_not_found", format!("Agent {agent_id} not found")))?;
            let pending = ctx
                .agent_manager()
                .list_pending_permissions(Some(&agent_id))
                .await;
            let mut snapshot = agent_payload(&agent);
            if let Value::Object(obj) = &mut snapshot {
                obj.insert(
                    "pendingPermissions".into(),
                    json!(pending.into_iter().map(|p| p.request).collect::<Vec<_>>()),
                );
            }
            Ok(tool_result(json!({
                "status": agent.status,
                "snapshot": snapshot,
            })))
        }),
    );

    // cancel_agent — mcp-server.ts lines 1500-1525.
    registry.register(
        ToolDescriptor {
            name: "cancel_agent".into(),
            title: "Cancel agent run".into(),
            description: "Abort the agent's current run but keep the agent alive for future tasks."
                .into(),
            input_schema: object_schema(&[("agentId", "string")], &[]),
        },
        boxed(|args, ctx| async move {
            let map = as_object(&args)?;
            let agent_id = req_str(map, "agentId")?;
            ctx.agent_manager().cancel(&agent_id).await.map_err(agent_err)?;
            Ok(tool_result(json!({ "success": true })))
        }),
    );

    // archive_agent — mcp-server.ts lines 1527-1555.
    registry.register(
        ToolDescriptor {
            name: "archive_agent".into(),
            title: "Archive agent".into(),
            description:
                "Archive an agent (soft-delete). The agent is interrupted if running and removed from the active list."
                    .into(),
            input_schema: object_schema(&[("agentId", "string")], &[]),
        },
        boxed(|args, ctx| async move {
            let map = as_object(&args)?;
            let agent_id = req_str(map, "agentId")?;
            ctx.agent_manager().archive(&agent_id).await.map_err(agent_err)?;
            Ok(tool_result(json!({ "success": true })))
        }),
    );

    // list_pending_permissions — mcp-server.ts lines 2484-2516. The TS tool
    // takes no args (all agents); we additionally accept an optional `agentId`
    // scope, matching `AgentManager::list_pending_permissions`.
    registry.register(
        ToolDescriptor {
            name: "list_pending_permissions".into(),
            title: "List pending permissions".into(),
            description:
                "Return pending permission requests (optionally scoped to one agent) with normalized payloads."
                    .into(),
            input_schema: object_schema(&[], &[("agentId", "string")]),
        },
        boxed(|args, ctx| async move {
            let map = as_object(&args).ok();
            let agent_id = map.and_then(|m| opt_str(m, "agentId").ok().flatten());
            let pending = ctx
                .agent_manager()
                .list_pending_permissions(agent_id.as_deref())
                .await;
            let permissions: Vec<Value> = pending
                .into_iter()
                .map(|p| {
                    json!({
                        "agentId": p.agent_id,
                        "request": p.request,
                    })
                })
                .collect();
            Ok(tool_result(json!({ "permissions": permissions })))
        }),
    );

    // respond_to_permission — mcp-server.ts lines 2518-2546. TS shape:
    // { agentId, requestId, response }. We also accept a flattened `behavior`
    // payload for convenience; either resolves to an `AgentPermissionResponse`.
    registry.register(
        ToolDescriptor {
            name: "respond_to_permission".into(),
            title: "Respond to permission".into(),
            description:
                "Approve or deny a pending permission request with an AgentManager-compatible response payload."
                    .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "agentId": { "type": "string" },
                    "requestId": { "type": "string" },
                    "behavior": { "type": "string", "enum": ["allow", "deny"] },
                    "response": { "type": "object" },
                    "followUpPrompt": { "type": "string" },
                },
                "required": ["requestId"],
                "additionalProperties": true,
            }),
        },
        boxed(|args, ctx| async move {
            let map = as_object(&args)?;
            let request_id = req_str(map, "requestId")?;
            let response = parse_permission_response(map)?;
            let follow_up = opt_str(map, "followUpPrompt")?.map(|prompt| FollowUp { prompt });
            ctx.agent_manager()
                .respond_to_permission(&request_id, response, follow_up)
                .await
                .map_err(agent_err)?;
            Ok(tool_result(json!({ "success": true })))
        }),
    );

    register_create_agent(registry);
    register_not_wired_session_tools(registry);
}

/// Build an `AgentPermissionResponse` from either a nested `response` object or
/// a flattened `behavior` field.
fn parse_permission_response(
    map: &Map<String, Value>,
) -> Result<AgentPermissionResponse, ToolError> {
    let value = if let Some(response) = map.get("response") {
        if !response.is_object() {
            return Err(ToolError::invalid_params("`response` must be an object"));
        }
        response.clone()
    } else if let Some(behavior) = map.get("behavior") {
        let mut obj = map.clone();
        obj.remove("agentId");
        obj.remove("requestId");
        obj.remove("followUpPrompt");
        obj.insert("behavior".into(), behavior.clone());
        Value::Object(obj)
    } else {
        return Err(ToolError::invalid_params(
            "either `response` or `behavior` is required",
        ));
    };
    serde_json::from_value(value)
        .map_err(|e| ToolError::invalid_params(format!("invalid permission response: {e}")))
}

/// `create_agent` — mcp-server.ts lines 888-1010. Validates args and calls
/// `AgentManager::create_agent`, passing `callerAgentId` so the manager stamps
/// `rocky.parent-agent-id` (unless `detached`). Requires a wired provider;
/// otherwise returns a structured `not_wired` error (never a fake ok).
fn register_create_agent(registry: &mut ToolRegistry) {
    registry.register(
        ToolDescriptor {
            name: "create_agent".into(),
            title: "Create agent".into(),
            description:
                "Create an agent tied to a working directory. Requires provider/model, for example codex/gpt-5.4."
                    .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "provider": { "type": "string", "description": "Provider/model pair, e.g. codex/gpt-5.4." },
                    "title": { "type": "string", "description": "Short descriptive title (<= 60 chars)." },
                    "cwd": { "type": "string", "description": "Working directory for the agent." },
                    "initialPrompt": { "type": "string", "description": "First task to run after creation." },
                    "labels": { "type": "object", "additionalProperties": { "type": "string" } },
                    "detached": { "type": "boolean", "description": "If true, no parent label / not archived with caller." },
                    "settings": { "type": "object" },
                },
                "required": ["provider", "title"],
                "additionalProperties": true,
            }),
        },
        boxed(|args, ctx| async move {
            let map = as_object(&args)?;
            let provider_pair = req_str(map, "provider")?;
            let _title = req_str(map, "title")?;
            let (provider_id, model) = split_provider_model(&provider_pair);
            let detached = opt_bool(map, "detached")?.unwrap_or(false);
            let settings = map.get("settings").and_then(Value::as_object);
            let mode_id = settings
                .and_then(|s| s.get("modeId"))
                .and_then(Value::as_str)
                .map(str::to_string);
            let thinking_option_id = settings
                .and_then(|s| s.get("thinkingOptionId"))
                .and_then(Value::as_str)
                .map(str::to_string);

            let options = CreateAgentOptions {
                provider: provider_id,
                cwd: opt_str(map, "cwd")?,
                model,
                mode_id: mode_id.clone(),
                thinking_option_id,
                approval_policy: if mode_id.as_deref() == Some("never") {
                    Some("never".into())
                } else {
                    None
                },
                title: opt_str(map, "title")?,
                labels: opt_labels(map, "labels")?,
                caller_agent_id: ctx.caller_agent_id().map(str::to_string),
                detached,
                allow_custom_cwd: true,
                ..Default::default()
            };

            let Some(provider) = ctx.provider() else {
                return Err(ToolError::not_wired(
                    "create_agent requires a live agent provider; the orchestrator must wire one via McpContext::with_provider before this tool can spawn sessions.",
                ));
            };

            let agent = ctx
                .agent_manager()
                .create_agent(provider.as_ref(), options)
                .await
                .map_err(agent_err)?;

            Ok(tool_result(json!({
                "agentId": agent.id,
                "type": agent.provider,
                "status": agent.status,
                "cwd": agent.cwd,
                "currentModeId": agent.runtime_info.as_ref().and_then(|r| r.mode_id.clone()),
                "availableModes": [],
                "lastMessage": null,
                "permission": null,
            })))
        }),
    );
}

/// Split a `provider/model` pair into `(provider, Some(model))`, or
/// `(provider, None)` when no slash is present.
fn split_provider_model(pair: &str) -> (String, Option<String>) {
    match pair.split_once('/') {
        Some((provider, model)) if !model.is_empty() => {
            (provider.to_string(), Some(model.to_string()))
        }
        _ => (pair.to_string(), None),
    }
}

/// `send_agent_prompt` (mcp-server.ts lines 1135-1233) and `wait_for_agent`
/// (lines 1058-1133) need a live provider session loop and a wait tracker that
/// this phase does not own. Register descriptors + validation but return a
/// structured `not_wired` error rather than faking success.
fn register_not_wired_session_tools(registry: &mut ToolRegistry) {
    registry.register(
        ToolDescriptor {
            name: "send_agent_prompt".into(),
            title: "Send agent prompt".into(),
            description: "Send a task to a running agent. Returns once the agent begins processing."
                .into(),
            input_schema: object_schema(
                &[("agentId", "string"), ("prompt", "string")],
                &[
                    ("sessionMode", "string"),
                    ("background", "boolean"),
                    ("notifyOnFinish", "boolean"),
                ],
            ),
        },
        boxed(|args, _ctx| async move {
            let map = as_object(&args)?;
            let _agent_id = req_str(map, "agentId")?;
            let _prompt = req_str(map, "prompt")?;
            Err(ToolError::not_wired(
                "send_agent_prompt requires a live provider session loop; the orchestrator wires prompt dispatch in a later phase.",
            ))
        }),
    );

    registry.register(
        ToolDescriptor {
            name: "wait_for_agent".into(),
            title: "Wait for agent".into(),
            description:
                "Block until the agent requests permission or the current run completes.".into(),
            input_schema: object_schema(&[("agentId", "string")], &[]),
        },
        boxed(|args, _ctx| async move {
            let map = as_object(&args)?;
            let _agent_id = req_str(map, "agentId")?;
            Err(ToolError::not_wired(
                "wait_for_agent requires the run wait-tracker; the orchestrator wires turn completion signaling in a later phase.",
            ))
        }),
    );
}

// --- schema helpers ---------------------------------------------------------

/// Build a JSON Schema object with the given required + optional fields. `kind`
/// is a coarse JSON Schema type (`string`/`boolean`/`number`/`array`/`object`).
fn object_schema(required: &[(&str, &str)], optional: &[(&str, &str)]) -> Value {
    let mut props = Map::new();
    for (name, kind) in required.iter().chain(optional.iter()) {
        props.insert((*name).to_string(), json!({ "type": type_for(kind) }));
    }
    let required_names: Vec<Value> = required.iter().map(|(n, _)| json!(n)).collect();
    json!({
        "type": "object",
        "properties": props,
        "required": required_names,
        "additionalProperties": true,
    })
}

fn type_for(kind: &str) -> &'static str {
    match kind {
        "boolean" => "boolean",
        "number" => "number",
        "array" => "array",
        "object" => "object",
        _ => "string",
    }
}

// --- handler boxing ---------------------------------------------------------

/// Box an async handler closure into the registry's `ToolHandler` type.
fn boxed<F, Fut>(f: F) -> crate::protocol::ToolHandler
where
    F: Fn(Value, CallCtx) -> Fut + Send + Sync + 'static,
    Fut: std::future::Future<Output = Result<Value, ToolError>> + Send + 'static,
{
    std::sync::Arc::new(move |args, ctx| Box::pin(f(args, ctx)) as crate::protocol::ToolFuture)
}
