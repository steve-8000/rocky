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
            cwd: config.process.cwd.clone(),
            terminals: HashMap::new(),
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
    /// Session cwd, used as the default working directory for client-served
    /// `terminal/create` requests (matches `acp-agent.ts` `params.cwd ?? cwd`).
    cwd: String,
    /// Live client-served terminals keyed by terminal id. Populated by
    /// `terminal/create` and consulted by `terminal/output` /
    /// `terminal/wait_for_exit` / `terminal/kill` / `terminal/release`.
    terminals: HashMap<String, AcpClientTerminal>,
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
                Inbound::Request { id, method, params } => match method.as_str() {
                    "session/request_permission" => {
                        self.handle_permission_request(id, params).await;
                    }
                    "fs/read_text_file" => self.handle_read_text_file(id, params).await,
                    "fs/write_text_file" => self.handle_write_text_file(id, params).await,
                    "terminal/create" => self.handle_terminal_create(id, params).await,
                    "terminal/output" => self.handle_terminal_output(id, params).await,
                    "terminal/wait_for_exit" => {
                        self.handle_terminal_wait_for_exit(id, params).await;
                    }
                    "terminal/kill" => self.handle_terminal_kill(id, params).await,
                    "terminal/release" => self.handle_terminal_release(id, params).await,
                    _ => {
                        // Unknown agent->client request: reply with an error so
                        // the agent is not left waiting.
                        let _ = self
                            .transport
                            .respond_error(id, -32601, "method not found")
                            .await;
                    }
                },
            }
        }
    }

    fn emit(&self, event: AgentStreamEvent) {
        let _ = self.events_tx.send(event);
    }

    /// `fs/read_text_file` (acp-agent.ts:1752-1761). Reads `path` from disk;
    /// when `line`/`limit` are given, returns the 1-based line slice joined by
    /// `\n`. Errors map to a JSON-RPC error so the agent's disk fallback runs.
    async fn handle_read_text_file(&self, id: Value, params: Value) {
        let path = match params.get("path").and_then(Value::as_str) {
            Some(p) => p.to_string(),
            None => {
                let _ = self
                    .transport
                    .respond_error(id, -32602, "fs/read_text_file requires `path`")
                    .await;
                return;
            }
        };
        let line = params.get("line").and_then(Value::as_u64);
        let limit = params.get("limit").and_then(Value::as_u64);
        match tokio::fs::read_to_string(&path).await {
            Ok(raw) => {
                let content = if line.is_none() && limit.is_none() {
                    raw
                } else {
                    let lines: Vec<&str> = raw.split('\n').collect();
                    let start = line.unwrap_or(1).saturating_sub(1) as usize;
                    let end = limit.map(|l| start + l as usize);
                    let slice = match end {
                        Some(end) => lines.get(start..end.min(lines.len())),
                        None => lines.get(start..),
                    }
                    .unwrap_or(&[]);
                    slice.join("\n")
                };
                let _ = self
                    .transport
                    .respond(id, json!({ "content": content }))
                    .await;
            }
            Err(err) => {
                let _ = self
                    .transport
                    .respond_error(id, -32000, &format!("fs/read_text_file failed: {err}"))
                    .await;
            }
        }
    }

    /// `fs/write_text_file` (acp-agent.ts:1763-1767). Creates parent dirs and
    /// writes `content` to `path`. Errors map to a JSON-RPC error (the agent's
    /// write tool surfaces the message; there is no disk fallback on the agent
    /// side, so this must genuinely succeed).
    async fn handle_write_text_file(&self, id: Value, params: Value) {
        let path = params.get("path").and_then(Value::as_str);
        let content = params.get("content").and_then(Value::as_str);
        let (Some(path), Some(content)) = (path, content) else {
            let _ = self
                .transport
                .respond_error(id, -32602, "fs/write_text_file requires `path` and `content`")
                .await;
            return;
        };
        let result = async {
            if let Some(parent) = std::path::Path::new(path).parent() {
                tokio::fs::create_dir_all(parent).await?;
            }
            tokio::fs::write(path, content).await
        }
        .await;
        match result {
            Ok(()) => {
                let _ = self.transport.respond(id, json!({})).await;
            }
            Err(err) => {
                let _ = self
                    .transport
                    .respond_error(id, -32000, &format!("fs/write_text_file failed: {err}"))
                    .await;
            }
        }
    }

    /// `terminal/create` (acp-agent.ts:1769-1823). Spawns the command (wrapping
    /// a shell when the command contains whitespace and no explicit args), pumps
    /// stdout+stderr into a shared output buffer with byte-limit truncation, and
    /// registers the live terminal for later output/wait/kill/release calls.
    async fn handle_terminal_create(&mut self, id: Value, params: Value) {
        let command = match params.get("command").and_then(Value::as_str) {
            Some(c) => c.to_string(),
            None => {
                let _ = self
                    .transport
                    .respond_error(id, -32602, "terminal/create requires `command`")
                    .await;
                return;
            }
        };
        let args: Vec<String> = params
            .get("args")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(|v| v.as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default();
        let cwd = params
            .get("cwd")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| self.cwd.clone());
        let output_byte_limit = params.get("outputByteLimit").and_then(Value::as_u64);

        let mut env: HashMap<String, String> = HashMap::new();
        if let Some(entries) = params.get("env").and_then(Value::as_array) {
            for entry in entries {
                if let (Some(name), Some(value)) = (
                    entry.get("name").and_then(Value::as_str),
                    entry.get("value").and_then(Value::as_str),
                ) {
                    env.insert(name.to_string(), value.to_string());
                }
            }
        }

        let (program, exec_args) = resolve_terminal_command(&command, &args);
        let mut cmd = tokio::process::Command::new(&program);
        cmd.args(&exec_args)
            .current_dir(&cwd)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true);
        for (key, value) in &env {
            cmd.env(key, value);
        }

        let mut child = match cmd.spawn() {
            Ok(child) => child,
            Err(err) => {
                let _ = self
                    .transport
                    .respond_error(id, -32000, &format!("terminal/create failed to spawn: {err}"))
                    .await;
                return;
            }
        };

        let terminal_id = format!(
            "{}{}",
            uuid_like_segment(),
            uuid_like_segment()
        );
        let state = Arc::new(std::sync::Mutex::new(TerminalOutputState {
            output: String::new(),
            truncated: false,
            output_byte_limit,
            exit: None,
        }));
        let pid = child.id();
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        if let Some(stdout) = stdout {
            spawn_output_pump(stdout, state.clone());
        }
        if let Some(stderr) = stderr {
            spawn_output_pump(stderr, state.clone());
        }

        // Wait task: records the exit status into the shared state and notifies
        // any `terminal/wait_for_exit` waiters.
        let (exit_tx, exit_rx) = tokio::sync::watch::channel(false);
        let wait_state = state.clone();
        let wait_handle = tokio::spawn(async move {
            let status = child.wait().await;
            let exit = match status {
                Ok(status) => TerminalExitInfo {
                    exit_code: status.code(),
                    signal: terminal_exit_signal(&status),
                },
                Err(_) => TerminalExitInfo {
                    exit_code: None,
                    signal: None,
                },
            };
            wait_state
                .lock()
                .expect("terminal output state poisoned")
                .exit = Some(exit);
            let _ = exit_tx.send(true);
        });

        self.terminals.insert(
            terminal_id.clone(),
            AcpClientTerminal {
                state,
                pid,
                exit_rx,
                wait_handle,
            },
        );

        let _ = self
            .transport
            .respond(id, json!({ "terminalId": terminal_id }))
            .await;
    }

    /// `terminal/output` (acp-agent.ts:1825-1832). Returns the buffered output,
    /// truncation flag, and exit status (when the command has completed).
    async fn handle_terminal_output(&self, id: Value, params: Value) {
        let terminal_id = params.get("terminalId").and_then(Value::as_str);
        let Some(terminal) = terminal_id.and_then(|t| self.terminals.get(t)) else {
            let _ = self
                .transport
                .respond_error(id, -32000, "Unknown terminal")
                .await;
            return;
        };
        let payload = {
            let snapshot = terminal
                .state
                .lock()
                .expect("terminal output state poisoned");
            let mut payload = json!({
                "output": snapshot.output,
                "truncated": snapshot.truncated,
            });
            if let Some(exit) = &snapshot.exit {
                payload["exitStatus"] = exit.to_value();
            }
            payload
        };
        let _ = self.transport.respond(id, payload).await;
    }

    /// `terminal/wait_for_exit` (acp-agent.ts:1834-1837). Blocks until the
    /// child exits, then returns its exit status.
    async fn handle_terminal_wait_for_exit(&self, id: Value, params: Value) {
        let terminal_id = params.get("terminalId").and_then(Value::as_str);
        let Some(terminal) = terminal_id.and_then(|t| self.terminals.get(t)) else {
            let _ = self
                .transport
                .respond_error(id, -32000, "Unknown terminal")
                .await;
            return;
        };
        let mut exit_rx = terminal.exit_rx.clone();
        // Wait until the watch channel reports the exit has been recorded.
        while !*exit_rx.borrow() {
            if exit_rx.changed().await.is_err() {
                break;
            }
        }
        let exit = terminal
            .state
            .lock()
            .expect("terminal output state poisoned")
            .exit
            .clone();
        let payload = exit
            .map(|e| e.to_value())
            .unwrap_or_else(|| json!({ "exitCode": null, "signal": null }));
        let _ = self.transport.respond(id, payload).await;
    }

    /// `terminal/kill` (acp-agent.ts:1847-1853). Sends SIGTERM to the child if
    /// it is still running; the terminal stays registered so the agent can read
    /// final output and exit status afterward.
    async fn handle_terminal_kill(&self, id: Value, params: Value) {
        let terminal_id = params.get("terminalId").and_then(Value::as_str);
        let Some(terminal) = terminal_id.and_then(|t| self.terminals.get(t)) else {
            let _ = self
                .transport
                .respond_error(id, -32000, "Unknown terminal")
                .await;
            return;
        };
        terminal.kill();
        let _ = self.transport.respond(id, json!({})).await;
    }

    /// `terminal/release` (acp-agent.ts:1839-1845). Kills the child if running
    /// and removes the terminal from the registry, freeing its resources.
    async fn handle_terminal_release(&mut self, id: Value, params: Value) {
        let terminal_id = params
            .get("terminalId")
            .and_then(Value::as_str)
            .map(str::to_string);
        if let Some(terminal_id) = terminal_id {
            if let Some(terminal) = self.terminals.remove(&terminal_id) {
                terminal.kill();
                terminal.wait_handle.abort();
            }
        }
        let _ = self.transport.respond(id, json!({})).await;
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

// --- client-served terminal support -----------------------------------------

/// Exit status of a client-served terminal child (`TerminalExitStatus`).
#[derive(Debug, Clone)]
struct TerminalExitInfo {
    exit_code: Option<i32>,
    signal: Option<String>,
}

impl TerminalExitInfo {
    fn to_value(&self) -> Value {
        json!({
            "exitCode": self.exit_code,
            "signal": self.signal,
        })
    }
}

/// Shared output buffer + exit slot for one client-served terminal. Mirrors the
/// mutable `TerminalEntry` fields the TS ACP agent maintains (acp-agent.ts).
struct TerminalOutputState {
    output: String,
    truncated: bool,
    output_byte_limit: Option<u64>,
    exit: Option<TerminalExitInfo>,
}

impl TerminalOutputState {
    /// Append a chunk, truncating from the front when the byte limit is
    /// exceeded (mirrors `appendTerminalOutput`, acp-agent.ts:2775-2785).
    fn append(&mut self, chunk: &str) {
        self.output.push_str(chunk);
        let Some(limit) = self.output_byte_limit else {
            return;
        };
        while self.output.len() as u64 > limit && !self.output.is_empty() {
            // Drop the leading char, keeping a valid UTF-8 boundary.
            let mut chars = self.output.chars();
            chars.next();
            self.output = chars.as_str().to_string();
            self.truncated = true;
        }
    }
}

/// A live client-served terminal registered after `terminal/create`.
struct AcpClientTerminal {
    state: Arc<std::sync::Mutex<TerminalOutputState>>,
    pid: Option<u32>,
    /// Flips to `true` once the wait task records the exit status.
    exit_rx: tokio::sync::watch::Receiver<bool>,
    wait_handle: tokio::task::JoinHandle<()>,
}

impl AcpClientTerminal {
    /// SIGTERM the child if it has not exited yet (best-effort, matching the TS
    /// `child.kill("SIGTERM")` guarded by `!entry.exit`).
    fn kill(&self) {
        let already_exited = self
            .state
            .lock()
            .expect("terminal output state poisoned")
            .exit
            .is_some();
        if already_exited {
            return;
        }
        if let Some(pid) = self.pid {
            #[cfg(unix)]
            // SAFETY: kill(2) with a valid pid and SIGTERM has no memory effects.
            unsafe {
                libc::kill(pid as libc::pid_t, libc::SIGTERM);
            }
            #[cfg(not(unix))]
            let _ = pid;
        }
    }
}

/// Spawn a task that pumps a child stdout/stderr pipe into the shared terminal
/// output buffer.
fn spawn_output_pump<R>(reader: R, state: Arc<std::sync::Mutex<TerminalOutputState>>)
where
    R: tokio::io::AsyncRead + Unpin + Send + 'static,
{
    tokio::spawn(async move {
        use tokio::io::AsyncReadExt;
        let mut reader = reader;
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let chunk = String::from_utf8_lossy(&buf[..n]);
                    state
                        .lock()
                        .expect("terminal output state poisoned")
                        .append(&chunk);
                }
            }
        }
    });
}

/// Extract the terminating signal name from an exit status, if any (unix only).
#[cfg(unix)]
fn terminal_exit_signal(status: &std::process::ExitStatus) -> Option<String> {
    use std::os::unix::process::ExitStatusExt;
    status.signal().map(|s| s.to_string())
}

#[cfg(not(unix))]
fn terminal_exit_signal(_status: &std::process::ExitStatus) -> Option<String> {
    None
}

/// Resolve a terminal command into `(program, args)`, mirroring
/// `resolveTerminalCommand` (acp-agent.ts:138-152): explicit args win; a bare
/// command with no whitespace runs directly; otherwise wrap in a shell.
fn resolve_terminal_command(command: &str, args: &[String]) -> (String, Vec<String>) {
    if !args.is_empty() {
        return (command.to_string(), args.to_vec());
    }
    if !command.trim().contains(char::is_whitespace) {
        return (command.to_string(), Vec::new());
    }
    #[cfg(windows)]
    {
        ("cmd.exe".to_string(), vec!["/c".to_string(), command.to_string()])
    }
    #[cfg(not(windows))]
    {
        ("/bin/sh".to_string(), vec!["-c".to_string(), command.to_string()])
    }
}

/// Generate a short random-ish hex segment for terminal ids without pulling in a
/// uuid dependency. Combines time and an atomic counter.
fn uuid_like_segment() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    let counter = COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("{:016x}", nanos ^ counter.wrapping_mul(0x9E37_79B9_7F4A_7C15))
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
