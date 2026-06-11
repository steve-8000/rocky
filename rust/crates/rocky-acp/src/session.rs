//! `AcpSession`: drives the ACP lifecycle and translates inbound traffic into
//! `rocky_agent_domain::AgentStreamEvent`.
//!
//! Mirrors `acp-agent.ts`:
//! - initialize + `session/new` (lines 1903-1027) / `session/load` (1029-1065)
//! - `session/prompt` + stopReason handling (1084-1128, 2148-2174)
//! - `translateSessionUpdate` (1990-2049)
//! - `mapPlanToTimeline` (2481-2489) with empty-plan suppression
//!   (`04-agent-runtime-and-providers.md:237-238`)
//! - `mapPermissionRequest` (2736-2756) + `selectPermissionOption` (2758-2773)
//!
//! ACP method names and param/result shapes verified against the live amaze
//! ACP agent (`bun vendor/amaze/packages/coding-agent/src/cli.ts acp`):
//! - `initialize` -> `{ protocolVersion, agentInfo, agentCapabilities, ... }`
//! - `session/new` -> `{ sessionId, configOptions, ... }`
//! - `session/load` (resume) -> session state
//! - `session/prompt` -> `{ stopReason, usage, userMessageId }`
//! - `session/cancel`, `session/set_mode` (notifications/requests)
//! - inbound `session/update` carrying `sessionUpdate` discriminator
//! - inbound `session/request_permission` -> reply `{ outcome: { outcome,
//!   optionId } }`

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use rocky_agent_domain::{
    AgentMode, AgentPermissionRequest, AgentPermissionResponse, AgentStreamEvent,
    AgentTimelineItem, AgentUsage, PermissionKind, TodoItem, ToolCallStatus,
};
use serde_json::{json, Map, Value};
use tokio::sync::{mpsc, Mutex};

use crate::approval::{append_rocky_bypass_mode, is_rocky_autonomous_approval, ROCKY_BYPASS_MODE_ID};
use crate::error::{AcpError, AcpResult};
use crate::process::{AcpProcess, ProcessSpec};
use crate::tool_detail::{map_tool_detail, map_tool_status, AcpToolSnapshot};
use crate::transport::{Inbound, InboundReceiver, Transport};

/// Protocol version Rocky advertises (matches `PROTOCOL_VERSION` used by amaze).
pub const PROTOCOL_VERSION: i64 = 1;

/// Provider id Rocky tags ACP events with (matches `provider: "acp"`).
pub const ACP_PROVIDER: &str = "acp";

/// A model the ACP agent advertises for a session. Mirrors the minimal fields
/// of amaze's `AgentModelDefinition`. Captured live `session/new` result shape
/// (see `session.ts` / module docs):
/// `result.models = { availableModels: [ { modelId, name, description } ] }`.
#[derive(Debug, Clone, PartialEq)]
pub struct AcpModel {
    /// Stable model id (`modelId`), e.g. `anthropic/claude-...`.
    pub id: String,
    /// Human label (`name`).
    pub label: String,
    /// Optional description (`description`).
    pub description: Option<String>,
}

/// A choice within a `select` config option (e.g. the `thought_level`
/// selector's `off`/`low`/`high`/...). Mirrors the wire `AgentSelectOption`
/// (`messages.ts:214-220`): `{ id, label, description?, isDefault? }`.
/// `is_default` is set when the choice equals the option's `currentValue`
/// (`deriveSelectorOptions`, acp-agent.ts:2339-2345).
#[derive(Debug, Clone, PartialEq)]
pub struct AcpSelectOption {
    /// Choice value (`value`), used as the option id.
    pub id: String,
    /// Human label (`name`).
    pub label: String,
    /// Optional description.
    pub description: Option<String>,
    /// True when this choice is the option's current/default value.
    pub is_default: bool,
}

/// How a session is initialized.
pub enum SessionInit {
    /// Fresh `session/new`.
    New,
    /// Resume an existing session via `session/load`.
    Load {
        /// Persisted ACP session id.
        session_id: String,
    },
}

/// Configuration for connecting an `AcpSession`.
pub struct SessionConfig {
    /// Subprocess launch spec (command + repo root + cwd + env).
    pub process: ProcessSpec,
    /// New session or resume.
    pub init: SessionInit,
    /// MCP servers to advertise to the agent (passed verbatim).
    pub mcp_servers: Vec<Value>,
    /// Approval policy. When autonomous (`is_rocky_autonomous_approval`),
    /// permission requests are auto-granted by Rocky instead of being
    /// forwarded; mirrors `generic-acp-agent.ts` bypass handling.
    pub approval_policy: Option<String>,
}

/// A held permission request awaiting the caller's answer.
struct PendingPermission {
    /// JSON-RPC id of the inbound `session/request_permission` request.
    rpc_id: Value,
    /// Options the agent offered (each `{ optionId, name, kind }`).
    options: Vec<PermissionOption>,
}

#[derive(Clone)]
struct PermissionOption {
    option_id: String,
    kind: String,
}

type PendingPermissions = Arc<Mutex<HashMap<String, PendingPermission>>>;

/// Live ACP session. Cloneable handles share the same transport and event sink.
pub struct AcpSession {
    transport: Transport,
    process: Mutex<Option<AcpProcess>>,
    session_id: String,
    provider: String,
    /// Whether Rocky auto-grants permission requests. Shared with the
    /// [`Translator`] so a runtime mode change (selecting/leaving bypass via
    /// [`AcpSession::set_mode`]) takes effect immediately on in-flight and
    /// future permission prompts, not just at connect.
    autonomous: Arc<AtomicBool>,
    available_modes: Vec<AgentMode>,
    /// True when the `bypass` mode we expose is Rocky's synthetic one (the agent
    /// advertised no native autonomous mode). Used by [`AcpSession::set_mode`] to
    /// short-circuit: selecting synthetic bypass must NOT be forwarded to the
    /// agent (it would reject an unknown mode) — Rocky auto-grants permissions
    /// itself. Computed BEFORE `available_modes` is augmented with the synthetic
    /// entry, so it cannot be derived by scanning `available_modes` afterwards.
    bypass_is_synthetic: bool,
    available_models: Vec<AcpModel>,
    thinking_options: Vec<AcpSelectOption>,
    /// Wire `configId` of the `thought_level` select option, if the agent
    /// advertised one (amaze: `"thinking"`). Needed to address it in
    /// `session/set_config_option`.
    thinking_config_id: Option<String>,
    /// Wire `configId` of the `model` select option, if any (amaze: `"model"`).
    model_config_id: Option<String>,
    /// The session's current mode id (`modes.currentModeId`). Interior-mutable
    /// and shared with the [`Translator`] so it tracks both runtime
    /// [`AcpSession::set_mode`] calls and agent-driven `current_mode_update`
    /// events. Without this the value is frozen at connect and the WebUI
    /// composer's mode selector never reflects a change.
    current_mode_id: Arc<std::sync::Mutex<Option<String>>>,
    events_rx: Mutex<Option<mpsc::UnboundedReceiver<AgentStreamEvent>>>,
    lifecycle_tx: mpsc::UnboundedSender<AgentStreamEvent>,
    pending: PendingPermissions,
}

impl AcpSession {
    /// Connect: spawn the process, run `initialize` + `session/new`/`session/load`,
    /// and start the inbound translation task.
    pub async fn connect(config: SessionConfig) -> AcpResult<Self> {
        let (process, stdin, stdout) = AcpProcess::spawn(&config.process)?;
        let (transport, inbound_rx) = Transport::new(stdin, stdout);

        // initialize
        let init_params = json!({
            "protocolVersion": PROTOCOL_VERSION,
            "clientCapabilities": {
                "fs": { "readTextFile": true, "writeTextFile": true },
                "terminal": true,
            },
            "clientInfo": { "name": "Rocky", "version": "dev" },
        });
        transport.request("initialize", init_params).await?;

        // session/new or session/load
        let (method, params) = match &config.init {
            SessionInit::New => (
                "session/new",
                json!({ "cwd": config.process.cwd, "mcpServers": config.mcp_servers }),
            ),
            SessionInit::Load { session_id } => (
                "session/load",
                json!({
                    "sessionId": session_id,
                    "cwd": config.process.cwd,
                    "mcpServers": config.mcp_servers,
                }),
            ),
        };
        let session_state = transport.request(method, params).await?;
        let session_id = match &config.init {
            SessionInit::New => session_state
                .get("sessionId")
                .and_then(Value::as_str)
                .ok_or_else(|| AcpError::Protocol("session/new did not return sessionId".into()))?
                .to_string(),
            SessionInit::Load { session_id } => session_id.clone(),
        };

        let available_modes = extract_modes(&session_state);
        // Rocky appends a synthetic `bypass` mode iff the agent advertised no
        // native autonomous mode. When synthetic, selecting it is handled by
        // Rocky (auto-grant) and must NOT be forwarded to the agent.
        let bypass_is_synthetic = !available_modes
            .iter()
            .any(|mode| is_rocky_autonomous_approval(&mode.id));
        let available_models = extract_models(&session_state);
        let thinking_options = extract_thinking_options(&session_state);
        let thinking_config_id = extract_select_config_id(&session_state, "thought_level");
        let model_config_id = extract_select_config_id(&session_state, "model");
        let current_mode_id = Arc::new(std::sync::Mutex::new(extract_current_mode_id(
            &session_state,
        )));
        let autonomous = Arc::new(AtomicBool::new(
            config
                .approval_policy
                .as_deref()
                .map(is_rocky_autonomous_approval)
                .unwrap_or(false),
        ));

        let (events_tx, events_rx) = mpsc::unbounded_channel();
        let pending: PendingPermissions = Arc::new(Mutex::new(HashMap::new()));

        // thread_started, mirroring emitBootstrapThreadEvent / subscribe().
        let _ = events_tx.send(AgentStreamEvent::ThreadStarted {
            session_id: session_id.clone(),
            provider: ACP_PROVIDER.to_string(),
        });

        let translator = Translator {
            session_id: session_id.clone(),
            provider: ACP_PROVIDER.to_string(),
            events_tx: events_tx.clone(),
            pending: pending.clone(),
            transport: transport.clone(),
            autonomous: autonomous.clone(),
            current_mode_id: current_mode_id.clone(),
            tool_calls: HashMap::new(),
        };
        tokio::spawn(translator.run(inbound_rx));

        Ok(Self {
            transport,
            process: Mutex::new(Some(process)),
            session_id,
            provider: ACP_PROVIDER.to_string(),
            autonomous,
            available_modes: append_rocky_bypass_mode(available_modes),
            bypass_is_synthetic,
            available_models,
            thinking_options,
            thinking_config_id,
            model_config_id,
            current_mode_id,
            events_rx: Mutex::new(Some(events_rx)),
            lifecycle_tx: events_tx,
            pending,
        })
    }

    /// The ACP session id (persist this to resume later).
    pub fn session_id(&self) -> &str {
        &self.session_id
    }

    /// Provider id used on emitted events (`"acp"`).
    pub fn provider(&self) -> &str {
        &self.provider
    }

    /// Available modes including the synthetic `bypass` mode when appropriate.
    pub fn available_modes(&self) -> &[AgentMode] {
        &self.available_modes
    }

    /// Models the agent advertised for this session (from `session/new`).
    pub fn available_models(&self) -> &[AcpModel] {
        &self.available_models
    }

    /// The `thought_level` (thinking) select options the agent advertised for
    /// this session, if any. TS attaches these to every model definition
    /// (`deriveModelDefinitionsFromACP`, acp-agent.ts:517-540).
    pub fn thinking_options(&self) -> &[AcpSelectOption] {
        &self.thinking_options
    }

    /// Wire `configId` of the `thought_level` select option, if advertised.
    pub fn thinking_config_id(&self) -> Option<&str> {
        self.thinking_config_id.as_deref()
    }

    /// Wire `configId` of the `model` select option, if advertised.
    pub fn model_config_id(&self) -> Option<&str> {
        self.model_config_id.as_deref()
    }

    /// Set the thinking (`thought_level`) option by id, returning the canonical
    /// value the agent reports. Errors if the agent did not advertise a
    /// `thought_level` selector (mirrors `setThinkingOption`'s throw,
    /// acp-agent.ts:1489-1491).
    pub async fn set_thinking_option(&self, option_id: &str) -> AcpResult<String> {
        let config_id = self.thinking_config_id.as_deref().ok_or_else(|| {
            AcpError::Protocol("agent does not expose ACP thought-level selection".into())
        })?;
        let canonical = self.set_config_option(config_id, option_id).await?;
        Ok(canonical.unwrap_or_else(|| option_id.to_string()))
    }

    /// Set the model (`model` config option) by id, returning the canonical
    /// value the agent reports. Errors if the agent did not advertise a `model`
    /// selector (mirrors `setModel`'s throw, acp-agent.ts:1431-1432).
    pub async fn set_model_option(&self, model_id: &str) -> AcpResult<String> {
        let config_id = self.model_config_id.as_deref().ok_or_else(|| {
            AcpError::Protocol("agent does not expose ACP model selection".into())
        })?;
        let canonical = self.set_config_option(config_id, model_id).await?;
        Ok(canonical.unwrap_or_else(|| model_id.to_string()))
    }

    /// The session's current mode id (`modes.currentModeId`), if any. Reflects
    /// runtime [`AcpSession::set_mode`] calls and agent-driven updates.
    pub fn current_mode_id(&self) -> Option<String> {
        self.current_mode_id.lock().unwrap().clone()
    }

    /// Take the event receiver. Returns `None` if already taken.
    pub fn take_events(&self) -> Option<mpsc::UnboundedReceiver<AgentStreamEvent>> {
        self.events_rx.try_lock().ok().and_then(|mut g| g.take())
    }

    /// Send a prompt and await the turn outcome. Emits `TurnStarted` immediately
    /// and a terminal `TurnCompleted`/`TurnFailed`/`TurnCanceled` based on the
    /// `session/prompt` response `stopReason`.
    ///
    /// Returns the raw `stopReason` string for the caller.
    pub async fn prompt(&self, text: &str) -> AcpResult<String> {
        let prompt_blocks = json!([{ "type": "text", "text": text }]);
        self.prompt_blocks(prompt_blocks).await
    }

    /// Like [`prompt`](Self::prompt) but with explicit ACP content blocks.
    pub async fn prompt_blocks(&self, prompt: Value) -> AcpResult<String> {
        // turn_started, mirroring startTurn (acp-agent.ts:1102).
        self.emit_external(AgentStreamEvent::TurnStarted {
            provider: self.provider.clone(),
            turn_id: None,
        })
        .await;

        let params = json!({
            "sessionId": self.session_id,
            "prompt": prompt,
        });
        let response = self.transport.request("session/prompt", params).await;

        match response {
            Ok(value) => {
                let stop_reason = value
                    .get("stopReason")
                    .and_then(Value::as_str)
                    .unwrap_or("end_turn")
                    .to_string();
                let usage = value.get("usage").and_then(map_usage);
                // handlePromptResponse stopReason switch (acp-agent.ts:2151-2173).
                match stop_reason.as_str() {
                    "cancelled" => {
                        self.emit_external(AgentStreamEvent::TurnCanceled {
                            provider: self.provider.clone(),
                            reason: "Interrupted".to_string(),
                            turn_id: None,
                        })
                        .await;
                    }
                    // end_turn, max_tokens, max_turn_requests, refusal, default.
                    _ => {
                        self.emit_external(AgentStreamEvent::TurnCompleted {
                            provider: self.provider.clone(),
                            usage,
                            turn_id: None,
                        })
                        .await;
                    }
                }
                Ok(stop_reason)
            }
            Err(err) => {
                self.emit_external(AgentStreamEvent::TurnFailed {
                    provider: self.provider.clone(),
                    error: err.to_string(),
                    code: None,
                    diagnostic: None,
                    turn_id: None,
                })
                .await;
                Err(err)
            }
        }
    }

    /// Cancel the active turn (`session/cancel`).
    pub async fn cancel(&self) -> AcpResult<()> {
        self.transport
            .notify("session/cancel", json!({ "sessionId": self.session_id }))
            .await
    }

    /// Set the session mode (`session/set_mode`). When the requested mode is a
    /// Rocky autonomous alias not exposed by the agent, this is a no-op handled
    /// by Rocky (mirrors the `providerModeWriter` short-circuit).
    pub async fn set_mode(&self, mode_id: &str) -> AcpResult<()> {
        // A mode is "native" only if the agent itself advertised it — the
        // synthetic `bypass` entry we appended does not count. Selecting an
        // autonomous alias that is not native is handled by Rocky (auto-grant)
        // and must NOT be forwarded (the agent would reject an unknown mode).
        let is_native = self.available_modes.iter().any(|m| m.id == mode_id)
            && !(mode_id == ROCKY_BYPASS_MODE_ID && self.bypass_is_synthetic);
        let is_autonomous_mode = is_rocky_autonomous_approval(mode_id);
        // Reflect the runtime mode change in our auto-grant policy so permission
        // prompts are auto-approved while in bypass and held again when leaving.
        // Shared with the Translator, so this takes effect immediately.
        self.autonomous.store(is_autonomous_mode, Ordering::SeqCst);
        if is_autonomous_mode && !is_native {
            // Rocky handles bypass itself; do not forward to the agent.
            *self.current_mode_id.lock().unwrap() = Some(mode_id.to_string());
            return Ok(());
        }
        self.transport
            .request(
                "session/set_mode",
                json!({ "sessionId": self.session_id, "modeId": mode_id }),
            )
            .await
            .map(|_| ())?;
        *self.current_mode_id.lock().unwrap() = Some(mode_id.to_string());
        Ok(())
    }

    /// Set a `select` config option (`session/set_config_option`, the wire
    /// method amaze registers as `session_set_config_option`). Mirrors the TS
    /// `connection.setSessionConfigOption({ sessionId, configId, value })`
    /// (acp-agent.ts:1492). Returns the canonical `currentValue` the agent
    /// reports back for `config_id` in the response `configOptions`, falling
    /// back to `None` when the agent omits it (caller then keeps the requested
    /// value, matching `applyConfigOptionResponse`, acp-agent.ts:1530-1537).
    pub async fn set_config_option(
        &self,
        config_id: &str,
        value: &str,
    ) -> AcpResult<Option<String>> {
        let response = self
            .transport
            .request(
                "session/set_config_option",
                json!({
                    "sessionId": self.session_id,
                    "configId": config_id,
                    "value": value,
                }),
            )
            .await?;
        Ok(response
            .get("configOptions")
            .and_then(Value::as_array)
            .and_then(|opts| {
                opts.iter()
                    .find(|o| o.get("id").and_then(Value::as_str) == Some(config_id))
            })
            .and_then(|o| o.get("currentValue").and_then(Value::as_str))
            .map(str::to_string))
    }

    /// Answer a held permission request. Selects the matching ACP option per
    /// `selectPermissionOption` and replies to the held JSON-RPC request.
    pub async fn answer_permission(
        &self,
        request_id: &str,
        response: &AgentPermissionResponse,
    ) -> AcpResult<()> {
        let pending = {
            let mut guard = self.pending.lock().await;
            guard.remove(request_id)
        };
        let Some(pending) = pending else {
            return Err(AcpError::Protocol(format!(
                "no pending permission request '{request_id}'"
            )));
        };

        let outcome = match select_permission_option(&pending.options, response) {
            Some(option) => json!({ "outcome": "selected", "optionId": option.option_id }),
            None => json!({ "outcome": "cancelled" }),
        };
        let resolution = response.clone();
        self.transport
            .respond(pending.rpc_id, json!({ "outcome": outcome }))
            .await?;

        // Emit PermissionResolved so subscribers observe the resolution.
        self.emit_external(AgentStreamEvent::PermissionResolved {
            provider: self.provider.clone(),
            request_id: request_id.to_string(),
            resolution,
            turn_id: None,
        })
        .await;
        Ok(())
    }

    /// Whether this session auto-grants permissions (autonomous approval).
    pub fn is_autonomous(&self) -> bool {
        self.autonomous.load(Ordering::SeqCst)
    }

    /// Graceful shutdown: close stdin, SIGTERM, wait, then SIGKILL.
    pub async fn shutdown(&self) {
        self.transport.shutdown();
        if let Some(process) = self.process.lock().await.take() {
            process.shutdown().await;
        }
    }

    async fn emit_external(&self, event: AgentStreamEvent) {
        // Lifecycle events (turn started/completed/failed/canceled,
        // permission resolved) share the translator's event channel so the
        // caller observes a single ordered stream.
        let _ = self.lifecycle_tx.send(event);
    }
}

/// Background task: translates inbound `session/update` notifications and
/// `session/request_permission` requests into `AgentStreamEvent`s.
struct Translator {
    session_id: String,
    provider: String,
    events_tx: mpsc::UnboundedSender<AgentStreamEvent>,
    pending: PendingPermissions,
    transport: Transport,
    autonomous: Arc<AtomicBool>,
    current_mode_id: Arc<std::sync::Mutex<Option<String>>>,
    tool_calls: HashMap<String, AcpToolSnapshot>,
}

impl Translator {
    async fn run(mut self, mut inbound: InboundReceiver) {
        while let Some(message) = inbound.recv().await {
            match message {
                Inbound::Notification { method, params } => {
                    if method == "session/update" {
                        self.handle_session_update(&params);
                    }
                    // Other notifications (ext/*) are ignored, matching
                    // extNotification's log-only behavior.
                }
                Inbound::Request { id, method, params } => {
                    if method == "session/request_permission" {
                        self.handle_permission_request(id, params).await;
                    } else {
                        // Unknown agent->client request: reply with an error so
                        // the agent is not left waiting.
                        let _ = self
                            .transport
                            .respond_error(id, -32601, "method not found")
                            .await;
                    }
                }
            }
        }
    }

    fn emit(&self, event: AgentStreamEvent) {
        let _ = self.events_tx.send(event);
    }

    fn wrap_timeline(&self, item: AgentTimelineItem) -> AgentStreamEvent {
        AgentStreamEvent::Timeline {
            item: Box::new(item),
            provider: self.provider.clone(),
            turn_id: None,
            timestamp: None,
        }
    }

    /// `translateSessionUpdate` (acp-agent.ts:1990-2049). Session id mismatch is
    /// ignored, mirroring sessionUpdate's guard (acp-agent.ts:1709).
    fn handle_session_update(&mut self, params: &Value) {
        if params.get("sessionId").and_then(Value::as_str) != Some(self.session_id.as_str()) {
            return;
        }
        let Some(update) = params.get("update") else {
            return;
        };
        let kind = update.get("sessionUpdate").and_then(Value::as_str);
        match kind {
            Some("agent_message_chunk") => {
                if let Some(text) = chunk_text(update) {
                    self.emit(self.wrap_timeline(AgentTimelineItem::AssistantMessage {
                        text,
                        message_id: update
                            .get("messageId")
                            .and_then(Value::as_str)
                            .map(str::to_string),
                    }));
                }
            }
            Some("agent_thought_chunk") => {
                if let Some(text) = chunk_text(update) {
                    self.emit(self.wrap_timeline(AgentTimelineItem::Reasoning { text }));
                }
            }
            Some("user_message_chunk") => {
                if let Some(text) = chunk_text(update) {
                    self.emit(self.wrap_timeline(AgentTimelineItem::UserMessage {
                        text,
                        message_id: update
                            .get("messageId")
                            .and_then(Value::as_str)
                            .map(str::to_string),
                    }));
                }
            }
            Some("tool_call") => self.handle_tool_call(update),
            Some("tool_call_update") => self.handle_tool_call(update),
            Some("plan") => {
                if let Some(item) = map_plan_to_timeline(update) {
                    self.emit(self.wrap_timeline(item));
                }
            }
            Some("current_mode_update") => {
                let current_mode_id = update
                    .get("currentModeId")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                // Track agent-driven mode changes so AcpSession::current_mode_id
                // (read by the agent snapshot) stays in sync.
                *self.current_mode_id.lock().unwrap() = current_mode_id.clone();
                self.emit(AgentStreamEvent::ModeChanged {
                    provider: self.provider.clone(),
                    current_mode_id,
                    available_modes: Vec::new(),
                });
            }
            Some("usage_update") => {
                if let Some(usage) = map_usage(update) {
                    self.emit(AgentStreamEvent::UsageUpdated {
                        provider: self.provider.clone(),
                        usage,
                        turn_id: None,
                    });
                }
            }
            // available_commands_update, session_info_update, etc. are state-only.
            _ => {}
        }
    }

    /// `handleToolCallUpdate` (acp-agent.ts:2051-2062) + mapToolSnapshotToTimeline.
    fn handle_tool_call(&mut self, update: &Value) {
        let parsed: AcpToolSnapshot = match serde_json::from_value(update.clone()) {
            Ok(snapshot) => snapshot,
            Err(err) => {
                tracing::warn!(error = %err, "failed to parse ACP tool_call update");
                return;
            }
        };
        let tool_call_id = parsed.tool_call_id.clone();
        let merged = AcpToolSnapshot::merge(&tool_call_id, parsed, self.tool_calls.get(&tool_call_id));
        let status = map_tool_status(merged.status.as_deref());
        let detail = map_tool_detail(&merged);
        let name = merged
            .kind
            .clone()
            .or_else(|| merged.title.clone())
            .unwrap_or_else(|| tool_call_id.clone());
        // error is null unless failed (mapToolSnapshotToTimeline, acp-agent.ts:2507-2525).
        let error = if status == ToolCallStatus::Failed {
            json!({ "message": read_error_message(merged.raw_output.as_ref()) })
        } else {
            Value::Null
        };
        self.tool_calls.insert(tool_call_id.clone(), merged);
        self.emit(self.wrap_timeline(AgentTimelineItem::ToolCall {
            call_id: tool_call_id,
            name,
            status,
            detail: Box::new(detail),
            error,
            metadata: None,
        }));
    }

    /// Handle inbound `session/request_permission`. Emits `PermissionRequested`
    /// and either auto-grants (autonomous) or holds the request for the caller.
    async fn handle_permission_request(&mut self, rpc_id: Value, params: Value) {
        let request_id = uuid_like(&rpc_id);
        let snapshot: AcpToolSnapshot = params
            .get("toolCall")
            .and_then(|tc| serde_json::from_value(tc.clone()).ok())
            .unwrap_or_default();
        let options = parse_permission_options(&params);
        let request = map_permission_request(&self.provider, &request_id, &params, &snapshot);

        self.emit(AgentStreamEvent::PermissionRequested {
            provider: self.provider.clone(),
            request: Box::new(request),
            turn_id: None,
        });

        if self.autonomous.load(Ordering::SeqCst) {
            // Rocky auto-grants (generic-acp-agent.ts autonomous handling).
            let response = AgentPermissionResponse::Allow {
                selected_action_id: None,
                updated_input: None,
                updated_permissions: None,
            };
            let outcome = match select_permission_option(&options, &response) {
                Some(option) => json!({ "outcome": "selected", "optionId": option.option_id }),
                None => json!({ "outcome": "cancelled" }),
            };
            let _ = self
                .transport
                .respond(rpc_id, json!({ "outcome": outcome }))
                .await;
            self.emit(AgentStreamEvent::PermissionResolved {
                provider: self.provider.clone(),
                request_id,
                resolution: response,
                turn_id: None,
            });
        } else {
            self.pending
                .lock()
                .await
                .insert(request_id, PendingPermission { rpc_id, options });
        }
    }
}

/// `mapPlanToTimeline` (acp-agent.ts:2481-2489) with empty-plan suppression
/// (`04-agent-runtime-and-providers.md:237-238`): an empty `entries` list emits
/// nothing rather than a permanent empty todo card.
fn map_plan_to_timeline(update: &Value) -> Option<AgentTimelineItem> {
    let entries = update.get("entries").and_then(Value::as_array)?;
    if entries.is_empty() {
        return None;
    }
    let items = entries
        .iter()
        .map(|entry| TodoItem {
            text: entry
                .get("content")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            completed: entry.get("status").and_then(Value::as_str) == Some("completed"),
        })
        .collect();
    Some(AgentTimelineItem::Todo { items })
}

/// `mapPermissionRequest` (acp-agent.ts:2736-2756). `switch_mode` => mode kind,
/// otherwise tool.
fn map_permission_request(
    provider: &str,
    request_id: &str,
    params: &Value,
    snapshot: &AcpToolSnapshot,
) -> AgentPermissionRequest {
    let kind = if snapshot.kind.as_deref() == Some("switch_mode") {
        PermissionKind::Mode
    } else {
        PermissionKind::Tool
    };
    let title = params
        .get("toolCall")
        .and_then(|tc| tc.get("title"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| snapshot.title.clone());
    let mut metadata = Map::new();
    if let Some(tc_id) = params
        .get("toolCall")
        .and_then(|tc| tc.get("toolCallId"))
        .and_then(Value::as_str)
    {
        metadata.insert("toolCallId".to_string(), json!(tc_id));
    }
    if let Some(options) = params.get("options") {
        metadata.insert("options".to_string(), options.clone());
    }
    metadata.insert("rawRequest".to_string(), params.clone());

    AgentPermissionRequest {
        id: request_id.to_string(),
        provider: provider.to_string(),
        name: snapshot
            .kind
            .clone()
            .or_else(|| snapshot.title.clone())
            .unwrap_or_default(),
        kind,
        title,
        description: None,
        input: None,
        detail: Some(map_tool_detail(snapshot)),
        suggestions: None,
        actions: None,
        metadata: Some(metadata),
    }
}

/// `selectPermissionOption` (acp-agent.ts:2758-2773): preferred option order by
/// behavior. allow => allow_once then allow_always; deny => reject_once then
/// reject_always.
fn select_permission_option<'a>(
    options: &'a [PermissionOption],
    response: &AgentPermissionResponse,
) -> Option<&'a PermissionOption> {
    let order: &[&str] = match response {
        AgentPermissionResponse::Allow { .. } => &["allow_once", "allow_always"],
        AgentPermissionResponse::Deny { .. } => &["reject_once", "reject_always"],
    };
    for kind in order {
        if let Some(option) = options.iter().find(|o| o.kind == *kind) {
            return Some(option);
        }
    }
    None
}

fn parse_permission_options(params: &Value) -> Vec<PermissionOption> {
    params
        .get("options")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|o| {
                    Some(PermissionOption {
                        option_id: o.get("optionId").and_then(Value::as_str)?.to_string(),
                        kind: o.get("kind").and_then(Value::as_str)?.to_string(),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Extract `AgentMode`s from a `session/new`/`session/load` state response by
/// reading the `mode` select config option's choices.
fn extract_modes(state: &Value) -> Vec<AgentMode> {
    let Some(options) = state.get("configOptions").and_then(Value::as_array) else {
        return Vec::new();
    };
    let Some(mode_option) = options.iter().find(|o| {
        o.get("category").and_then(Value::as_str) == Some("mode")
            || o.get("id").and_then(Value::as_str) == Some("mode")
    }) else {
        return Vec::new();
    };
    mode_option
        .get("options")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|choice| {
                    Some(AgentMode {
                        id: choice.get("value").and_then(Value::as_str)?.to_string(),
                        label: choice
                            .get("name")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string(),
                        description: choice
                            .get("description")
                            .and_then(Value::as_str)
                            .map(str::to_string),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Extract [`AcpModel`]s from a `session/new`/`session/load` state response.
///
/// Captured live amaze `session/new` result shape (cf. `session.ts`):
/// `result.models = { availableModels: [ { modelId, name, description } ] }`.
/// Tolerates absence (no `models` / `availableModels`) by returning `[]`.
fn extract_models(state: &Value) -> Vec<AcpModel> {
    let Some(models) = state
        .get("models")
        .and_then(|m| m.get("availableModels"))
        .and_then(Value::as_array)
    else {
        return Vec::new();
    };
    models
        .iter()
        .filter_map(|m| {
            Some(AcpModel {
                id: m.get("modelId").and_then(Value::as_str)?.to_string(),
                label: m
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                description: m
                    .get("description")
                    .and_then(Value::as_str)
                    .map(str::to_string),
            })
        })
        .collect()
}

/// Find the wire `id` of the `select` config option whose `category` (or `id`)
/// matches `category`. Used to address the option in `session/set_config_option`
/// (amaze ids: `mode`/`model`/`thinking`). Returns `None` when absent.
fn extract_select_config_id(state: &Value, category: &str) -> Option<String> {
    state
        .get("configOptions")
        .and_then(Value::as_array)?
        .iter()
        .find(|o| {
            o.get("category").and_then(Value::as_str) == Some(category)
                || o.get("id").and_then(Value::as_str) == Some(category)
        })
        .and_then(|o| o.get("id").and_then(Value::as_str))
        .map(str::to_string)
}

/// Extract the `thought_level` (thinking) select options from a
/// `session/new`/`session/load` state response's `configOptions`.
///
/// Mirrors `deriveSelectorOptions(configOptions, "thought_level")`
/// (acp-agent.ts:2330-2346): find the select config option whose `category`
/// (or `id`) is `thought_level`, then map each choice's `value`/`name` and mark
/// the one equal to the option's `currentValue` as default. Live amaze shape:
/// `{ id: "thinking", category: "thought_level", type: "select",
///    currentValue: "xhigh", options: [ { value: "off", name: "Off" }, ... ] }`.
/// Tolerates absence by returning `[]`.
fn extract_thinking_options(state: &Value) -> Vec<AcpSelectOption> {
    let Some(options) = state.get("configOptions").and_then(Value::as_array) else {
        return Vec::new();
    };
    let Some(opt) = options.iter().find(|o| {
        o.get("category").and_then(Value::as_str) == Some("thought_level")
            || o.get("id").and_then(Value::as_str) == Some("thought_level")
    }) else {
        return Vec::new();
    };
    let current = opt.get("currentValue").and_then(Value::as_str);
    opt.get("options")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|choice| {
                    let value = choice.get("value").and_then(Value::as_str)?;
                    Some(AcpSelectOption {
                        id: value.to_string(),
                        label: choice
                            .get("name")
                            .and_then(Value::as_str)
                            .unwrap_or(value)
                            .to_string(),
                        description: choice
                            .get("description")
                            .and_then(Value::as_str)
                            .map(str::to_string),
                        is_default: current == Some(value),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Read `modes.currentModeId` from a `session/new`/`session/load` state response.
///
/// Captured live amaze shape (cf. `session.ts`):
/// `result.modes = { availableModes: [...], currentModeId: "default" }`.
fn extract_current_mode_id(state: &Value) -> Option<String> {
    state
        .get("modes")
        .and_then(|m| m.get("currentModeId"))
        .and_then(Value::as_str)
        .map(str::to_string)
}

/// `mapACPUsage` (acp-agent.ts:429-439). Reads token counts from a usage object
/// (in a `session/prompt` response or a `usage_update`).
fn map_usage(value: &Value) -> Option<AgentUsage> {
    let usage = if value.get("usage").is_some() {
        value.get("usage").unwrap()
    } else {
        value
    };
    let input = usage.get("inputTokens").and_then(Value::as_u64);
    let output = usage.get("outputTokens").and_then(Value::as_u64);
    let total = usage.get("totalTokens").and_then(Value::as_u64);
    let cached = usage
        .get("cachedReadTokens")
        .or_else(|| usage.get("cachedInputTokens"))
        .and_then(Value::as_u64);
    if input.is_none() && output.is_none() && total.is_none() && cached.is_none() {
        return None;
    }
    Some(AgentUsage {
        input_tokens: input,
        output_tokens: output,
        total_tokens: total,
        cached_input_tokens: cached,
        extra: Map::new(),
    })
}

/// `readErrorMessage` (acp-agent.ts:2831-2837).
fn read_error_message(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(s)) => s.clone(),
        Some(v) => v
            .get("message")
            .or_else(|| v.get("error"))
            .and_then(Value::as_str)
            .unwrap_or("Tool call failed")
            .to_string(),
        None => "Tool call failed".to_string(),
    }
}

/// Reuse the JSON-RPC id as a stable request id string.
fn uuid_like(rpc_id: &Value) -> String {
    match rpc_id {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

/// `contentBlockToText` over a chunk update's `content` block.
fn chunk_text(update: &Value) -> Option<String> {
    let content = update.get("content")?;
    let text = match content.get("type").and_then(Value::as_str) {
        Some("text") => content.get("text").and_then(Value::as_str)?.to_string(),
        Some("resource_link") => content
            .get("title")
            .and_then(Value::as_str)
            .or_else(|| content.get("uri").and_then(Value::as_str))?
            .to_string(),
        Some("image") => "[image]".to_string(),
        Some("audio") => "[audio]".to_string(),
        _ => return None,
    };
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn plan_with_entries_maps_to_todo() {
        let update = json!({
            "sessionUpdate": "plan",
            "entries": [
                { "content": "first", "status": "completed" },
                { "content": "second", "status": "in_progress" }
            ]
        });
        match map_plan_to_timeline(&update) {
            Some(AgentTimelineItem::Todo { items }) => {
                assert_eq!(items.len(), 2);
                assert_eq!(items[0].text, "first");
                assert!(items[0].completed);
                assert_eq!(items[1].text, "second");
                assert!(!items[1].completed);
            }
            other => panic!("expected todo, got {other:?}"),
        }
    }

    #[test]
    fn empty_plan_is_suppressed() {
        let update = json!({ "sessionUpdate": "plan", "entries": [] });
        assert!(map_plan_to_timeline(&update).is_none());
    }

    #[test]
    fn permission_request_maps_from_real_frame() {
        // From the live amaze agent: session/request_permission params.
        let params = json!({
            "sessionId": "sess",
            "toolCall": {
                "toolCallId": "toolu_018wnvZbbkUqcryb356Qe91S",
                "title": "echo hello-rocky",
                "kind": "execute",
                "status": "pending",
                "rawInput": { "command": "echo hello-rocky", "timeout": 300 }
            },
            "options": [
                { "optionId": "allow_once", "name": "Allow once", "kind": "allow_once" },
                { "optionId": "allow_always", "name": "Always allow", "kind": "allow_always" },
                { "optionId": "reject_once", "name": "Reject", "kind": "reject_once" },
                { "optionId": "reject_always", "name": "Always reject", "kind": "reject_always" }
            ]
        });
        let snapshot: AcpToolSnapshot =
            serde_json::from_value(params.get("toolCall").unwrap().clone()).unwrap();
        let request = map_permission_request("acp", "req-1", &params, &snapshot);
        assert_eq!(request.id, "req-1");
        assert_eq!(request.provider, "acp");
        assert_eq!(request.kind, PermissionKind::Tool);
        assert_eq!(request.name, "execute");
        assert_eq!(request.title.as_deref(), Some("echo hello-rocky"));
        match request.detail {
            Some(rocky_agent_domain::ToolCallDetail::Shell { command, .. }) => {
                assert_eq!(command, "echo hello-rocky");
            }
            other => panic!("expected shell detail, got {other:?}"),
        }
    }

    #[test]
    fn switch_mode_permission_is_mode_kind() {
        let params = json!({
            "toolCall": { "toolCallId": "t", "title": "Switch", "kind": "switch_mode" },
            "options": []
        });
        let snapshot: AcpToolSnapshot =
            serde_json::from_value(params.get("toolCall").unwrap().clone()).unwrap();
        let request = map_permission_request("acp", "r", &params, &snapshot);
        assert_eq!(request.kind, PermissionKind::Mode);
    }

    #[test]
    fn select_option_prefers_once_then_always() {
        let options = vec![
            PermissionOption { option_id: "a1".into(), kind: "allow_once".into() },
            PermissionOption { option_id: "a2".into(), kind: "allow_always".into() },
            PermissionOption { option_id: "r1".into(), kind: "reject_once".into() },
        ];
        let allow = AgentPermissionResponse::Allow {
            selected_action_id: None,
            updated_input: None,
            updated_permissions: None,
        };
        assert_eq!(select_permission_option(&options, &allow).unwrap().option_id, "a1");
        let deny = AgentPermissionResponse::Deny {
            selected_action_id: None,
            message: None,
            interrupt: None,
        };
        assert_eq!(select_permission_option(&options, &deny).unwrap().option_id, "r1");
    }

    #[test]
    fn select_option_falls_back_to_always_when_no_once() {
        let options = vec![PermissionOption { option_id: "a2".into(), kind: "allow_always".into() }];
        let allow = AgentPermissionResponse::Allow {
            selected_action_id: None,
            updated_input: None,
            updated_permissions: None,
        };
        assert_eq!(select_permission_option(&options, &allow).unwrap().option_id, "a2");
    }

    #[test]
    fn extract_modes_from_real_session_new_config() {
        // From the live amaze agent's session/new configOptions.
        let state = json!({
            "sessionId": "s",
            "configOptions": [{
                "id": "mode",
                "name": "Mode",
                "category": "mode",
                "type": "select",
                "currentValue": "default",
                "options": [
                    { "value": "default", "name": "Default", "description": "Standard ACP headless mode" },
                    { "value": "plan", "name": "Plan", "description": "Read-only planning mode" }
                ]
            }]
        });
        let modes = extract_modes(&state);
        assert_eq!(modes.len(), 2);
        assert_eq!(modes[0].id, "default");
        assert_eq!(modes[1].id, "plan");
        // append_rocky_bypass_mode would add bypass on top.
        let with_bypass = append_rocky_bypass_mode(modes);
        assert!(with_bypass.iter().any(|m| m.id == "bypass"));
    }

    #[test]
    fn extract_models_from_real_session_new_result() {
        // Captured live amaze session/new result:
        // result.models = { availableModels: [ { modelId, name, description } ] }.
        let state = json!({
            "sessionId": "s",
            "models": {
                "availableModels": [
                    {
                        "modelId": "anthropic/claude-sonnet-4",
                        "name": "Claude Sonnet 4",
                        "description": "Anthropic Claude Sonnet 4"
                    },
                    {
                        "modelId": "openai/gpt-5",
                        "name": "GPT-5",
                        "description": null
                    }
                ]
            }
        });
        let models = extract_models(&state);
        assert_eq!(models.len(), 2);
        assert_eq!(models[0].id, "anthropic/claude-sonnet-4");
        assert_eq!(models[0].label, "Claude Sonnet 4");
        assert_eq!(models[0].description.as_deref(), Some("Anthropic Claude Sonnet 4"));
        assert_eq!(models[1].id, "openai/gpt-5");
        assert_eq!(models[1].description, None);
    }

    #[test]
    fn extract_models_tolerates_absence() {
        assert!(extract_models(&json!({})).is_empty());
        assert!(extract_models(&json!({ "models": {} })).is_empty());
        assert!(extract_models(&json!({ "models": { "availableModels": [] } })).is_empty());
    }

    #[test]
    fn extract_thinking_options_reads_thought_level_selector() {
        // Live amaze `session/new` configOptions shape.
        let state = json!({
            "configOptions": [
                { "id": "mode", "category": "mode", "type": "select", "currentValue": "default",
                  "options": [ { "value": "default", "name": "Default" } ] },
                { "id": "thinking", "category": "thought_level", "type": "select",
                  "currentValue": "xhigh", "options": [
                    { "value": "off", "name": "Off" },
                    { "value": "high", "name": "high" },
                    { "value": "xhigh", "name": "xhigh" }
                  ] }
            ]
        });
        let opts = extract_thinking_options(&state);
        assert_eq!(opts.len(), 3);
        assert_eq!(opts[0].id, "off");
        assert!(!opts[0].is_default);
        assert_eq!(opts[2].id, "xhigh");
        assert!(opts[2].is_default, "currentValue choice must be marked default");
    }

    #[test]
    fn extract_thinking_options_tolerates_absence() {
        assert!(extract_thinking_options(&json!({})).is_empty());
        assert!(extract_thinking_options(&json!({ "configOptions": [] })).is_empty());
        // No thought_level option present -> empty.
        assert!(extract_thinking_options(&json!({
            "configOptions": [ { "id": "mode", "category": "mode", "type": "select",
                "currentValue": "default", "options": [] } ]
        }))
        .is_empty());
    }

    #[test]
    fn extract_current_mode_id_reads_modes_block() {
        // Captured live amaze shape:
        // result.modes = { availableModes: [...], currentModeId: "default" }.
        let state = json!({
            "modes": {
                "availableModes": [
                    { "id": "default", "name": "Default", "description": "d" }
                ],
                "currentModeId": "default"
            }
        });
        assert_eq!(extract_current_mode_id(&state).as_deref(), Some("default"));
        assert_eq!(extract_current_mode_id(&json!({})), None);
        assert_eq!(extract_current_mode_id(&json!({ "modes": {} })), None);
    }

    #[test]
    fn maps_usage_from_real_prompt_response() {
        // From the live amaze agent's session/prompt result.
        let response = json!({
            "stopReason": "end_turn",
            "usage": { "inputTokens": 2, "outputTokens": 4, "totalTokens": 19560, "cachedWriteTokens": 19554 }
        });
        let usage = map_usage(&response).unwrap();
        assert_eq!(usage.input_tokens, Some(2));
        assert_eq!(usage.output_tokens, Some(4));
        assert_eq!(usage.total_tokens, Some(19560));
    }

    #[test]
    fn chunk_text_reads_real_agent_message_chunk() {
        // From the live amaze agent's agent_message_chunk update.
        let update = json!({
            "sessionUpdate": "agent_message_chunk",
            "content": { "type": "text", "text": "OK" },
            "messageId": "b6ac88e3-39b7-4b3c-91a3-3ba904027ea2"
        });
        assert_eq!(chunk_text(&update).as_deref(), Some("OK"));
    }
}
