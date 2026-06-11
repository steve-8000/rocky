//! Agent-lifecycle session RPC handlers, matching the agent cases in
//! `session.ts` (`handleFetchAgents`, `handleFetchAgent`, `handleCancelAgentRequest`,
//! `handleArchiveAgentRequest`, `handleDeleteAgentRequest`,
//! `handleClearAgentAttention`, `handleCreateAgentRequest`,
//! `handleSendAgentMessageRequest`, `handleWaitForFinish`, the `set_agent_*` /
//! `update_agent` / `refresh_agent` group, and `handleAgentPermissionResponse`)
//! and the response shapes in `core/packages/protocol/src/messages.ts`.
//!
//! Inner request/response `type` strings and payload field names are
//! wire-compatible with the TypeScript daemon. Agent payloads mirror the
//! `toAgentPayload` projection (`agent-projections.ts` lines 101-154) onto the
//! `AgentSnapshotPayloadSchema` (messages.ts:676-703).
//!
//! Response `type` strings handled here (verified against messages.ts):
//! - `fetch_agents_request` -> `fetch_agents_response`
//!   `{requestId, entries:[{agent, project}], pageInfo:{nextCursor,prevCursor,hasMore}}`
//!   (messages.ts:2515-2523).
//! - `fetch_agent_request` -> `fetch_agent_response`
//!   `{requestId, agent|null, project|null, error}` (messages.ts:2657-2665).
//! - `fetch_agent_timeline_request` -> `fetch_agent_timeline_response`
//!   full window envelope `{requestId, agentId, agent|null, direction, projection,
//!   epoch, reset, staleCursor, gap, window, startCursor, endCursor, hasOlder,
//!   hasNewer, entries:[AgentTimelineEntryPayload], error}` (messages.ts:2682-2706).
//! - `cancel_agent_request` -> `cancel_agent_response`
//!   `{requestId, agentId, agent|null}` (messages.ts:2708-2715). No `error` field;
//!   a missing/uncancelable agent yields `agent: null`.
//! - `archive_agent_request` -> `agent_archived` `{agentId, archivedAt, requestId}`
//!   on success, `rpc_error` on failure (messages.ts:2893-2900 / 2191-2199;
//!   session.ts:2318-2331).
//! - `delete_agent_request` -> `agent_deleted` `{agentId, requestId}`
//!   (messages.ts:2885-2891; session.ts:2267-2316; close is best-effort).
//! - `clear_agent_attention` -> `clear_agent_attention_response`
//!   `{requestId, agentId, agents:[snapshot]}` (messages.ts:2717-2724).
//! - `create_agent_request` -> `status` `{status:"agent_created", agentId,
//!   requestId, agent}` on success (session.ts:3119-3128), carrying the live
//!   agent snapshot (the `toAgentPayload` projection). On failure the structured
//!   `status` `{status:"agent_create_failed", requestId, error, errorCode}`
//!   (messages.ts:2217-2222; session.ts:3138-3148) is returned (never a fake ok).
//!   Backed by a live [`rocky_agents::AgentProvider`] supplied at registration.
//! - `send_agent_message_request` -> `send_agent_message_response`
//!   `{requestId, agentId, accepted, error}` (messages.ts:2745-2753).
//! - `wait_for_finish_request` -> `wait_for_finish_response`
//!   `{requestId, status, final|null, error, lastMessage}` (messages.ts:2755-2764).
//! - `set_agent_mode_request` / `set_agent_model_request` /
//!   `set_agent_thinking_request` / `set_agent_feature_request` /
//!   `update_agent_request` -> their `_response` carrying
//!   `AgentActionResponsePayload {requestId, agentId, accepted, error}`
//!   (messages.ts:1250-1322).
//! - `refresh_agent_request` -> `status` `{status:"agent_refreshed",...}` on
//!   success, `rpc_error` on failure (messages.ts:2231-2235; session.ts:3366-3388).
//! - `agent_permission_response` (client answering) -> resolved via the manager's
//!   permission queue; returns an internal `agent_permission_response_ack` the WS
//!   transport suppresses (no TS response message exists for this inbound, exactly
//!   like `terminal_input` -> `terminal_input_ack` in `workspace.rs`).
//!
//! ## Backing limitations (no fabricated state)
//! The `AgentManager` is the source of truth for live agent state, the timeline,
//! and the permission queue, but it does not own provider capabilities, available
//! modes, project/git placement, or the durable agent-storage layer. Fields it
//! cannot compute are reported as the schema's null/false/empty defaults rather
//! than fabricated values (mirroring `workspace.rs`). Operations that require a
//! live provider session that is not wired in this slice (create/mode/model/
//! thinking/feature/update/refresh) return a structured response with a non-null
//! `error` (or `rpc_error`), never a fake ok.

use std::path::Path;
use std::sync::Arc;

use rocky_agent_domain::{AgentPermissionResponse, AgentStatus};
use rocky_agents::{AgentManager, AgentProvider, CreateAgentOptions, ManagedAgent};
use serde_json::{json, Value};

use crate::dispatch::{SessionDispatcher, SessionRpcError};

/// Shared agent control plane. `AgentManager` is `Clone` (Arc inner) and fully
/// internally synchronized (every method takes `&self` over an inner async
/// `Mutex`), so — unlike the synchronous Mission Control service — no outer
/// `Mutex` is needed here.
pub type SharedAgentManager = Arc<AgentManager>;

/// Register all agent-lifecycle handlers onto the dispatcher.
///
/// `provider` is the live agent provider (e.g. the amaze ACP provider) used by
/// `create_agent_request` to spin up real sessions. The mount task that owns
/// the socket must pass it in alongside the manager.
pub fn register(
    dispatcher: &mut SessionDispatcher,
    manager: SharedAgentManager,
    provider: Arc<dyn AgentProvider>,
) {
    macro_rules! reg {
        ($type:literal, $handler:path) => {{
            let m = manager.clone();
            dispatcher.register(
                $type,
                Arc::new(move |msg: Value| {
                    let m = m.clone();
                    async move { $handler(&m, msg).await }
                }),
            );
        }};
    }

    reg!("fetch_agents_request", handle_fetch_agents);
    reg!("fetch_agent_history_request", handle_fetch_agent_history);
    reg!("fetch_agent_request", handle_fetch_agent);
    reg!("fetch_agent_timeline_request", handle_fetch_agent_timeline);
    reg!("cancel_agent_request", handle_cancel_agent);
    reg!("archive_agent_request", handle_archive_agent);
    reg!("delete_agent_request", handle_delete_agent);
    reg!("clear_agent_attention", handle_clear_attention);
    {
        // `create_agent_request` needs the live provider in addition to the
        // manager, so it is registered explicitly rather than via `reg!`.
        let m = manager.clone();
        let p = provider.clone();
        dispatcher.register(
            "create_agent_request",
            Arc::new(move |msg: Value| {
                let m = m.clone();
                let p = p.clone();
                async move { handle_create_agent(&m, p.as_ref(), msg).await }
            }),
        );
    }
    reg!("send_agent_message_request", handle_send_agent_message);
    reg!("wait_for_finish_request", handle_wait_for_finish);
    reg!("set_agent_mode_request", handle_set_agent_mode);
    reg!("set_agent_model_request", handle_set_agent_model);
    reg!("set_agent_thinking_request", handle_set_agent_thinking);
    reg!("set_agent_feature_request", handle_set_agent_feature);
    reg!("update_agent_request", handle_update_agent);
    reg!("refresh_agent_request", handle_refresh_agent);
    reg!("agent_permission_response", handle_permission_response);
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

fn request_id(msg: &Value) -> String {
    msg.get("requestId")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

fn opt_str(msg: &Value, key: &str) -> Option<String> {
    msg.get(key).and_then(Value::as_str).map(|s| s.to_string())
}

fn internal(e: serde_json::Error) -> SessionRpcError {
    SessionRpcError::Handler(format!("serialize: {e}"))
}

/// Default capability flags. The manager does not own provider capabilities, so
/// the schema-required booleans (messages.ts:274-287) default to `false` rather
/// than being fabricated. The COMPAT(rewind) flags are included explicitly.
fn capabilities() -> Value {
    json!({
        "supportsStreaming": false,
        "supportsSessionPersistence": false,
        "supportsDynamicModes": false,
        "supportsMcpServers": false,
        "supportsReasoningStream": false,
        "supportsToolInvocations": false,
        "supportsRewindConversation": false,
        "supportsRewindFiles": false,
        "supportsRewindBoth": false,
    })
}

/// Map an `AttentionReason` to the snapshot enum string
/// (`["finished","error","permission"]`, messages.ts:699).
fn attention_reason_str(reason: rocky_store::AttentionReason) -> &'static str {
    match reason {
        rocky_store::AttentionReason::Finished => "finished",
        rocky_store::AttentionReason::Error => "error",
        rocky_store::AttentionReason::Permission => "permission",
    }
}

/// Project a live `ManagedAgent` onto `AgentSnapshotPayloadSchema`
/// (messages.ts:676-703), mirroring `toAgentPayload` (agent-projections.ts:101).
/// Pending permissions are read from the manager's queue (survives reconnect).
async fn agent_payload(manager: &AgentManager, agent: &ManagedAgent) -> Result<Value, SessionRpcError> {
    let runtime = agent.runtime_info.as_ref();
    let config = agent.config.as_ref();

    let model = config
        .and_then(|c| c.model.clone())
        .or_else(|| runtime.and_then(|r| r.model.clone()));
    let thinking_option_id = config.and_then(|c| c.thinking_option_id.clone());
    let effective_thinking_option_id = runtime
        .and_then(|r| r.thinking_option_id.clone())
        .or_else(|| thinking_option_id.clone());
    let (available_modes, session_mode_id) = manager.agent_modes(&agent.id).await;
    let current_mode_id = session_mode_id
        .or_else(|| runtime.and_then(|r| r.mode_id.clone()))
        .or_else(|| config.and_then(|c| c.mode_id.clone()));
    let available_modes = serde_json::to_value(&available_modes).map_err(internal)?;

    let runtime_info = match runtime {
        Some(r) => Some(serde_json::to_value(r).map_err(internal)?),
        None => None,
    };
    let persistence = match agent.persistence.as_ref() {
        Some(p) => serde_json::to_value(p).map_err(internal)?,
        None => Value::Null,
    };

    let pending = manager.list_pending_permissions(Some(&agent.id)).await;
    let pending_permissions = pending
        .into_iter()
        .map(|p| serde_json::to_value(p.request))
        .collect::<Result<Vec<_>, _>>()
        .map_err(internal)?;

    let status = serde_json::to_value(agent.status).map_err(internal)?;
    let labels = serde_json::to_value(&agent.labels).map_err(internal)?;

    let mut payload = json!({
        "id": agent.id,
        "provider": agent.provider,
        "cwd": agent.cwd,
        "model": model,
        "thinkingOptionId": thinking_option_id,
        "effectiveThinkingOptionId": effective_thinking_option_id,
        "createdAt": agent.created_at,
        "updatedAt": agent.updated_at,
        "lastUserMessageAt": Value::Null,
        "status": status,
        "capabilities": capabilities(),
        "currentModeId": current_mode_id,
        "availableModes": available_modes,
        "pendingPermissions": pending_permissions,
        "persistence": persistence,
        "title": agent.title,
        "labels": labels,
        "requiresAttention": agent.requires_attention,
        "archivedAt": agent.archived_at,
    });

    let obj = payload.as_object_mut().expect("payload is an object");
    if let Some(ri) = runtime_info {
        obj.insert("runtimeInfo".to_string(), ri);
    }
    if let Some(err) = agent.last_error.clone() {
        obj.insert("lastError".to_string(), Value::String(err));
    }
    if agent.requires_attention {
        obj.insert(
            "attentionReason".to_string(),
            agent
                .attention_reason
                .map(|r| Value::String(attention_reason_str(r).to_string()))
                .unwrap_or(Value::Null),
        );
        obj.insert(
            "attentionTimestamp".to_string(),
            agent
                .attention_timestamp
                .clone()
                .map(Value::String)
                .unwrap_or(Value::Null),
        );
    } else {
        obj.insert("attentionReason".to_string(), Value::Null);
        obj.insert("attentionTimestamp".to_string(), Value::Null);
    }

    Ok(payload)
}

/// Build a `ProjectPlacementPayload` (messages.ts:2331-2335) for a cwd. The
/// manager does not own git/checkout state, so the `checkout` uses the valid
/// not-git variant (messages.ts:2280-2293) rather than fabricated git fields.
fn project_placement(cwd: &str) -> Value {
    let project_key = rocky_store::project_dir_name_from_cwd(cwd);
    let project_name = Path::new(cwd)
        .file_name()
        .and_then(|s| s.to_str())
        .filter(|s| !s.is_empty())
        .unwrap_or(&project_key)
        .to_string();
    json!({
        "projectKey": project_key,
        "projectName": project_name,
        "checkout": {
            "cwd": cwd,
            "isGit": false,
            "currentBranch": Value::Null,
            "remoteUrl": Value::Null,
            "worktreeRoot": Value::Null,
            "isRockyOwnedWorktree": false,
            "mainRepoRoot": Value::Null,
        },
    })
}

/// Resolve an agent by full id (the manager keys on full ids; prefix/title
/// resolution lives in the daemon's storage layer, which is not wired here).
async fn resolve(manager: &AgentManager, agent_id: &str) -> Option<ManagedAgent> {
    manager.get(agent_id).await
}

fn action_response(
    type_str: &str,
    req_id: &str,
    agent_id: &str,
    accepted: bool,
    error: Option<String>,
) -> Value {
    json!({
        "type": type_str,
        "payload": {
            "requestId": req_id,
            "agentId": agent_id,
            "accepted": accepted,
            "error": error.map(Value::String).unwrap_or(Value::Null),
        }
    })
}

/// Build an `AgentActionResponsePayload` from a `Result`: `accepted:true` with a
/// null error on `Ok`, `accepted:false` carrying the error string on `Err`
/// (never a fake ok). Shared by the live `set_agent_*` config mutators.
fn action_result(
    type_str: &str,
    req_id: &str,
    agent_id: &str,
    result: Result<(), rocky_agents::AgentError>,
) -> Value {
    match result {
        Ok(()) => action_response(type_str, req_id, agent_id, true, None),
        Err(err) => action_response(type_str, req_id, agent_id, false, Some(err.to_string())),
    }
}

fn rpc_error(req_id: &str, request_type: &str, error: String, code: &str) -> Value {
    json!({
        "type": "rpc_error",
        "payload": {
            "requestId": req_id,
            "requestType": request_type,
            "error": error,
            "code": code,
        }
    })
}

// ---------------------------------------------------------------------------
// Fetch handlers
// ---------------------------------------------------------------------------

/// Build the full list of `AgentDirectoryResponseEntry` values
/// (`{agent: AgentSnapshotPayload, project: ProjectPlacementPayload}`,
/// messages.ts:2504-2507) for every hydrated agent the manager owns. Shared by
/// `fetch_agents_request` and `fetch_agent_history_request`.
async fn directory_entries(manager: &AgentManager) -> Result<Vec<Value>, SessionRpcError> {
    let agents = manager.list().await;
    let mut entries = Vec::with_capacity(agents.len());
    for agent in &agents {
        let payload = agent_payload(manager, agent).await?;
        entries.push(json!({
            "agent": payload,
            "project": project_placement(&agent.cwd),
        }));
    }
    Ok(entries)
}

async fn handle_fetch_agents(
    manager: &AgentManager,
    msg: Value,
) -> Result<Value, SessionRpcError> {
    let req_id = request_id(&msg);
    let entries = directory_entries(manager).await?;
    Ok(json!({
        "type": "fetch_agents_response",
        "payload": {
            "requestId": req_id,
            "entries": entries,
            "pageInfo": { "nextCursor": Value::Null, "prevCursor": Value::Null, "hasMore": false },
        }
    }))
}

/// `fetch_agent_history_request` -> `fetch_agent_history_response`
/// `{requestId, entries:[{agent, project}], pageInfo:{nextCursor,prevCursor,hasMore}}`
/// (request messages.ts:979-997; response messages.ts:2525-2532; entry
/// messages.ts:2504-2507). Reuses the exact entry projection as
/// `fetch_agents_request`.
///
/// Honors `page.limit` (messages.ts:991-996): entries are capped to `limit` and
/// `hasMore` is set when more hydrated agents exist than were returned. The
/// `AgentManager` has no cursor pagination, so `nextCursor`/`prevCursor` stay
/// `null` (no fabricated cursors). `filter`/`sort` (messages.ts:982-990) are
/// accepted but not yet applied — the hydrated agents are the full set, so
/// returning them all (capped by `limit`) is correct for a well-formed request.
async fn handle_fetch_agent_history(
    manager: &AgentManager,
    msg: Value,
) -> Result<Value, SessionRpcError> {
    let req_id = request_id(&msg);
    let limit = msg
        .get("page")
        .and_then(|p| p.get("limit"))
        .and_then(Value::as_u64)
        .map(|n| n as usize);

    let mut entries = directory_entries(manager).await?;
    let has_more = match limit {
        Some(limit) if entries.len() > limit => {
            entries.truncate(limit);
            true
        }
        _ => false,
    };

    Ok(json!({
        "type": "fetch_agent_history_response",
        "payload": {
            "requestId": req_id,
            "entries": entries,
            "pageInfo": { "nextCursor": Value::Null, "prevCursor": Value::Null, "hasMore": has_more },
        }
    }))
}

async fn handle_fetch_agent(manager: &AgentManager, msg: Value) -> Result<Value, SessionRpcError> {
    let req_id = request_id(&msg);
    let agent_id = opt_str(&msg, "agentId").unwrap_or_default();
    match resolve(manager, &agent_id).await {
        Some(agent) => {
            let payload = agent_payload(manager, &agent).await?;
            Ok(json!({
                "type": "fetch_agent_response",
                "payload": {
                    "requestId": req_id,
                    "agent": payload,
                    "project": project_placement(&agent.cwd),
                    "error": Value::Null,
                }
            }))
        }
        None => Ok(json!({
            "type": "fetch_agent_response",
            "payload": {
                "requestId": req_id,
                "agent": Value::Null,
                "project": Value::Null,
                "error": format!("Agent not found: {agent_id}"),
            }
        })),
    }
}

async fn handle_fetch_agent_timeline(
    manager: &AgentManager,
    msg: Value,
) -> Result<Value, SessionRpcError> {
    let req_id = request_id(&msg);
    let agent_id = opt_str(&msg, "agentId").unwrap_or_default();

    let cursor_seq = msg
        .get("cursor")
        .and_then(|c| c.get("seq"))
        .and_then(Value::as_u64);
    let direction = msg
        .get("direction")
        .and_then(Value::as_str)
        .map(|s| s.to_string())
        .unwrap_or_else(|| if cursor_seq.is_some() { "after".to_string() } else { "tail".to_string() });
    let projection = opt_str(&msg, "projection").unwrap_or_else(|| "projected".to_string());
    let limit = msg
        .get("limit")
        .and_then(Value::as_u64)
        .map(|n| n as usize)
        .unwrap_or(0);
    let after_seq = if direction == "after" { cursor_seq.unwrap_or(0) } else { 0 };

    let agent = resolve(manager, &agent_id).await;
    let agent_value = match &agent {
        Some(a) => agent_payload(manager, a).await?,
        None => Value::Null,
    };
    let provider = agent.as_ref().map(|a| a.provider.clone()).unwrap_or_default();

    let rows = manager.fetch_timeline(&agent_id, after_seq, limit).await;
    let mut entries = Vec::with_capacity(rows.len());
    let mut min_seq = 0u64;
    let mut max_seq = 0u64;
    for (idx, row) in rows.iter().enumerate() {
        if idx == 0 {
            min_seq = row.seq;
        }
        max_seq = row.seq;
        let item = serde_json::to_value(&row.item).map_err(internal)?;
        entries.push(json!({
            "provider": provider,
            "item": item,
            "timestamp": row.timestamp,
            "seqStart": row.seq,
            "seqEnd": row.seq,
            "sourceSeqRanges": [{ "startSeq": row.seq, "endSeq": row.seq }],
            "collapsed": [],
        }));
    }

    // The manager does not expose the per-agent timeline epoch publicly; report
    // the schema-required string as empty rather than fabricating an id.
    let epoch = "";
    let (start_cursor, end_cursor) = if entries.is_empty() {
        (Value::Null, Value::Null)
    } else {
        (
            json!({ "epoch": epoch, "seq": min_seq }),
            json!({ "epoch": epoch, "seq": max_seq }),
        )
    };

    Ok(json!({
        "type": "fetch_agent_timeline_response",
        "payload": {
            "requestId": req_id,
            "agentId": agent_id,
            "agent": agent_value,
            "direction": direction,
            "projection": projection,
            "epoch": epoch,
            "reset": false,
            "staleCursor": false,
            "gap": false,
            "window": { "minSeq": min_seq, "maxSeq": max_seq, "nextSeq": max_seq },
            "startCursor": start_cursor,
            "endCursor": end_cursor,
            "hasOlder": false,
            "hasNewer": false,
            "entries": entries,
            "error": Value::Null,
        }
    }))
}

// ---------------------------------------------------------------------------
// Lifecycle mutation handlers
// ---------------------------------------------------------------------------

async fn handle_cancel_agent(manager: &AgentManager, msg: Value) -> Result<Value, SessionRpcError> {
    let req_id = request_id(&msg);
    let agent_id = opt_str(&msg, "agentId").unwrap_or_default();
    // cancel_agent_response has no `error` field (messages.ts:2708-2715); a
    // missing or uncancelable agent surfaces as `agent: null`.
    let agent_value = match manager.cancel(&agent_id).await {
        Ok(()) => match resolve(manager, &agent_id).await {
            Some(agent) => agent_payload(manager, &agent).await?,
            None => Value::Null,
        },
        Err(_) => Value::Null,
    };
    Ok(json!({
        "type": "cancel_agent_response",
        "payload": { "requestId": req_id, "agentId": agent_id, "agent": agent_value }
    }))
}

async fn handle_archive_agent(
    manager: &AgentManager,
    msg: Value,
) -> Result<Value, SessionRpcError> {
    let req_id = request_id(&msg);
    let agent_id = opt_str(&msg, "agentId").unwrap_or_default();
    match manager.archive(&agent_id).await {
        Ok(()) => {
            let archived_at = resolve(manager, &agent_id)
                .await
                .and_then(|a| a.archived_at)
                .unwrap_or_else(rocky_agents::now_iso8601);
            Ok(json!({
                "type": "agent_archived",
                "payload": { "agentId": agent_id, "archivedAt": archived_at, "requestId": req_id }
            }))
        }
        Err(e) => Ok(rpc_error(
            &req_id,
            "archive_agent_request",
            e.to_string(),
            "agent_archive_failed",
        )),
    }
}

async fn handle_delete_agent(manager: &AgentManager, msg: Value) -> Result<Value, SessionRpcError> {
    let req_id = request_id(&msg);
    let agent_id = opt_str(&msg, "agentId").unwrap_or_default();
    // Best-effort close (matches session.ts:2278-2285 which warns and continues).
    // The durable agent-storage removal lives in the daemon and is not wired here.
    let _ = manager.close(&agent_id).await;
    Ok(json!({
        "type": "agent_deleted",
        "payload": { "agentId": agent_id, "requestId": req_id }
    }))
}

async fn handle_clear_attention(
    manager: &AgentManager,
    msg: Value,
) -> Result<Value, SessionRpcError> {
    let req_id = request_id(&msg);
    // `agentId` is `string | string[]` (messages.ts:1716).
    let ids: Vec<String> = match msg.get("agentId") {
        Some(Value::String(s)) => vec![s.clone()],
        Some(Value::Array(a)) => a
            .iter()
            .filter_map(|v| v.as_str().map(|s| s.to_string()))
            .collect(),
        _ => Vec::new(),
    };
    let mut agents = Vec::new();
    for id in &ids {
        let _ = manager.clear_attention(id).await;
        if let Some(agent) = resolve(manager, id).await {
            agents.push(agent_payload(manager, &agent).await?);
        }
    }
    let agent_id_value = msg.get("agentId").cloned().unwrap_or(Value::Null);
    Ok(json!({
        "type": "clear_agent_attention_response",
        "payload": { "requestId": req_id, "agentId": agent_id_value, "agents": agents }
    }))
}

/// `create_agent_request` -> `status` `{status:"agent_created", agentId,
/// requestId, agent}` on success (session.ts:3119-3128), or
/// `{status:"agent_create_failed", requestId, error, errorCode}` on failure
/// (messages.ts:2217-2222; session.ts:3138-3148). Request fields are read from
/// the nested `config` object (`AgentSessionConfigSchema`, messages.ts:323-343)
/// plus the top-level `initialPrompt`/`labels`/`callerAgentId`/`detached`
/// (`CreateAgentRequestMessageSchema`, messages.ts:1129-1146).
async fn handle_create_agent(
    manager: &AgentManager,
    provider: &dyn AgentProvider,
    msg: Value,
) -> Result<Value, SessionRpcError> {
    let req_id = request_id(&msg);
    let config = msg.get("config").cloned().unwrap_or(Value::Null);

    let provider_id = opt_str(&config, "provider").unwrap_or_else(|| provider.id().to_string());
    let cwd = opt_str(&config, "cwd");
    let model = opt_str(&config, "model");
    let mode_id = opt_str(&config, "modeId");
    let thinking_option_id = opt_str(&config, "thinkingOptionId");
    let approval_policy = opt_str(&config, "approvalPolicy");
    // `title` is `string|null` in the schema; only a non-empty string is a title.
    let title = config
        .get("title")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);

    let caller_agent_id = opt_str(&msg, "callerAgentId");
    let detached = msg
        .get("detached")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let labels = msg
        .get("labels")
        .and_then(Value::as_object)
        .map(|m| {
            m.iter()
                .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
                .collect()
        })
        .unwrap_or_default();

    let options = CreateAgentOptions {
        provider: provider_id,
        cwd,
        model,
        mode_id,
        thinking_option_id,
        approval_policy,
        title,
        labels,
        caller_agent_id,
        detached,
        internal: false,
        allow_custom_cwd: true,
        ..Default::default()
    };

    match manager.create_agent(provider, options).await {
        Ok(agent) => {
            // Deliver the initial prompt as the first turn, mirroring the TS
            // create flow (`create-agent/create.ts` `sendInitialPrompt`, invoked
            // when `resolved.prompt !== undefined`). The WebUI passes the first
            // message via `create_agent_request.initialPrompt` and does NOT send a
            // separate `send_agent_message_request`, so without this the agent is
            // created idle with an empty timeline and the message never arrives.
            if let Some(text) = opt_str(&msg, "initialPrompt")
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
            {
                let message_id = opt_str(&msg, "clientMessageId");
                let input = rocky_agents::PromptInput { text, message_id };
                if let Err(e) = manager.prompt(&agent.id, input).await {
                    tracing::warn!(
                        agent_id = %agent.id,
                        error = %e,
                        "failed to deliver initial prompt after agent creation"
                    );
                }
            }
            let agent_payload = agent_payload(manager, &agent).await?;
            Ok(json!({
                "type": "status",
                "payload": {
                    "status": "agent_created",
                    "agentId": agent.id,
                    "requestId": req_id,
                    "agent": agent_payload,
                }
            }))
        }
        Err(e) => Ok(json!({
            "type": "status",
            "payload": {
                "status": "agent_create_failed",
                "requestId": req_id,
                "error": e.to_string(),
                "errorCode": "agent_create_failed",
            }
        })),
    }
}

async fn handle_send_agent_message(
    manager: &AgentManager,
    msg: Value,
) -> Result<Value, SessionRpcError> {
    let req_id = request_id(&msg);
    let agent_id = opt_str(&msg, "agentId").unwrap_or_default();
    let text = opt_str(&msg, "text").unwrap_or_default();
    let message_id = opt_str(&msg, "messageId");
    let input = rocky_agents::PromptInput { text, message_id };
    let (accepted, error) = match manager.prompt(&agent_id, input).await {
        Ok(()) => (true, None),
        Err(e) => (false, Some(e.to_string())),
    };
    Ok(json!({
        "type": "send_agent_message_response",
        "payload": {
            "requestId": req_id,
            "agentId": agent_id,
            "accepted": accepted,
            "error": error.map(Value::String).unwrap_or(Value::Null),
        }
    }))
}

async fn handle_wait_for_finish(
    manager: &AgentManager,
    msg: Value,
) -> Result<Value, SessionRpcError> {
    let req_id = request_id(&msg);
    let agent_id = opt_str(&msg, "agentId").unwrap_or_default();
    // Without a live provider stream there is nothing to await; report the
    // current terminal/blocked state from the live snapshot. `status` is the
    // enum `["idle","error","permission","timeout"]` (messages.ts:2759).
    match resolve(manager, &agent_id).await {
        Some(agent) => {
            let status = if agent.requires_attention
                && agent.attention_reason == Some(rocky_store::AttentionReason::Permission)
            {
                "permission"
            } else {
                match agent.status {
                    AgentStatus::Error => "error",
                    AgentStatus::Idle | AgentStatus::Closed => "idle",
                    _ => "timeout",
                }
            };
            let final_payload = agent_payload(manager, &agent).await?;
            Ok(json!({
                "type": "wait_for_finish_response",
                "payload": {
                    "requestId": req_id,
                    "status": status,
                    "final": final_payload,
                    "error": Value::Null,
                    "lastMessage": Value::Null,
                }
            }))
        }
        None => Ok(json!({
            "type": "wait_for_finish_response",
            "payload": {
                "requestId": req_id,
                "status": "error",
                "final": Value::Null,
                "error": format!("Agent not found: {agent_id}"),
                "lastMessage": Value::Null,
            }
        })),
    }
}

// ---------------------------------------------------------------------------
// Config mutation handlers (require a live provider session)
// ---------------------------------------------------------------------------

/// Shared body for the `set_agent_*` / `update_agent` group. Mutating provider
/// config requires a live session (the TS commands talk to `agent.session`),
/// which is not wired in this slice, so we resolve the agent and return a
/// structured `accepted:false` with a non-null `error` (never a fake ok).
async fn config_mutation_response(
    manager: &AgentManager,
    response_type: &str,
    request_type: &str,
    msg: &Value,
) -> Value {
    let req_id = request_id(msg);
    let agent_id = opt_str(msg, "agentId").unwrap_or_default();
    let error = match resolve(manager, &agent_id).await {
        Some(_) => format!(
            "{request_type} requires a live provider session that is not wired into the session dispatcher"
        ),
        None => format!("Agent not found: {agent_id}"),
    };
    action_response(response_type, &req_id, &agent_id, false, Some(error))
}

async fn handle_set_agent_mode(manager: &AgentManager, msg: Value) -> Result<Value, SessionRpcError> {
    let req_id = request_id(&msg);
    let agent_id = opt_str(&msg, "agentId").unwrap_or_default();
    let mode_id = opt_str(&msg, "modeId").unwrap_or_default();
    let result = manager.set_agent_mode(&agent_id, &mode_id).await;
    Ok(action_result(
        "set_agent_mode_response",
        &req_id,
        &agent_id,
        result.map(|_| ()),
    ))
}

async fn handle_set_agent_model(
    manager: &AgentManager,
    msg: Value,
) -> Result<Value, SessionRpcError> {
    let req_id = request_id(&msg);
    let agent_id = opt_str(&msg, "agentId").unwrap_or_default();
    // `modelId` is nullable on the wire; a null/absent model is a no-op accept
    // (mirrors the TS no-op when no model id is supplied).
    let result = match opt_str(&msg, "modelId").filter(|s| !s.is_empty()) {
        Some(model_id) => manager.set_agent_model(&agent_id, &model_id).await.map(|_| ()),
        None => Ok(()),
    };
    Ok(action_result(
        "set_agent_model_response",
        &req_id,
        &agent_id,
        result,
    ))
}

async fn handle_set_agent_thinking(
    manager: &AgentManager,
    msg: Value,
) -> Result<Value, SessionRpcError> {
    let req_id = request_id(&msg);
    let agent_id = opt_str(&msg, "agentId").unwrap_or_default();
    // `thinkingOptionId` is nullable; null clears it (no provider call needed,
    // mirrors `setThinkingOption(null)`, acp-agent.ts:1469-1472).
    let result = match opt_str(&msg, "thinkingOptionId").filter(|s| !s.is_empty()) {
        Some(option_id) => manager
            .set_agent_thinking(&agent_id, &option_id)
            .await
            .map(|_| ()),
        None => Ok(()),
    };
    Ok(action_result(
        "set_agent_thinking_response",
        &req_id,
        &agent_id,
        result,
    ))
}

async fn handle_set_agent_feature(
    manager: &AgentManager,
    msg: Value,
) -> Result<Value, SessionRpcError> {
    Ok(config_mutation_response(
        manager,
        "set_agent_feature_response",
        "set_agent_feature_request",
        &msg,
    )
    .await)
}

async fn handle_update_agent(manager: &AgentManager, msg: Value) -> Result<Value, SessionRpcError> {
    // update_agent_request edits agent metadata (name/labels). This is a pure
    // storage edit (no live provider session needed), mirroring TS
    // `updateAgentCommand` -> `updateAgentMetadata`: a trimmed non-empty name
    // sets the title, labels are merged, and at least one must be present.
    let req_id = request_id(&msg);
    let agent_id = opt_str(&msg, "agentId").unwrap_or_default();
    let name = opt_str(&msg, "name");
    let labels: Option<std::collections::HashMap<String, String>> = msg
        .get("labels")
        .and_then(|v| serde_json::from_value(v.clone()).ok())
        .filter(|m: &std::collections::HashMap<String, String>| !m.is_empty());
    let has_title = name.as_deref().map(|s| !s.trim().is_empty()).unwrap_or(false);
    if !has_title && labels.is_none() {
        return Ok(action_response(
            "update_agent_response",
            &req_id,
            &agent_id,
            false,
            Some("Nothing to update (provide name and/or labels)".to_string()),
        ));
    }
    let result = manager
        .update_agent_metadata(&agent_id, name, labels)
        .await
        .map(|_| ());
    Ok(action_result("update_agent_response", &req_id, &agent_id, result))
}

async fn handle_refresh_agent(manager: &AgentManager, msg: Value) -> Result<Value, SessionRpcError> {
    let req_id = request_id(&msg);
    let agent_id = opt_str(&msg, "agentId").unwrap_or_default();
    // Refresh resumes/reloads from persistence (provider + storage), neither of
    // which is wired here. On success the TS daemon emits a `status`
    // `agent_refreshed`; failure emits `rpc_error` (session.ts:3366-3388).
    let error = match resolve(manager, &agent_id).await {
        Some(_) => "refresh_agent_request requires a live provider session that is not wired into the session dispatcher".to_string(),
        None => format!("Agent not found: {agent_id}"),
    };
    Ok(rpc_error(&req_id, "refresh_agent_request", error, "agent_refresh_failed"))
}

async fn handle_permission_response(
    manager: &AgentManager,
    msg: Value,
) -> Result<Value, SessionRpcError> {
    let req_id = request_id(&msg);
    let agent_id = opt_str(&msg, "agentId").unwrap_or_default();
    // `requestId` here is the permission request id (session.ts:1838 passes
    // msg.requestId straight to the resolver).
    let response: Option<AgentPermissionResponse> = msg
        .get("response")
        .and_then(|v| serde_json::from_value(v.clone()).ok());

    let error = match response {
        Some(response) => match manager.respond_to_permission(&req_id, response, None).await {
            Ok(_) => None,
            Err(e) => Some(e.to_string()),
        },
        None => Some("invalid or missing permission response".to_string()),
    };

    // No TS response message exists for `agent_permission_response` (the manager
    // broadcasts `permission_resolved`). Return an internal ack the WS transport
    // suppresses, exactly like `terminal_input` -> `terminal_input_ack`.
    Ok(json!({
        "type": "agent_permission_response_ack",
        "payload": {
            "requestId": req_id,
            "agentId": agent_id,
            "resolved": error.is_none(),
            "error": error.map(Value::String).unwrap_or(Value::Null),
        }
    }))
}
