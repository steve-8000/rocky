//! Behavior tests for the agent-lifecycle session RPC handlers
//! (`handlers::agent::register`). Build a dispatcher over a fresh `AgentManager`
//! rooted at a temp `$ROCKY_HOME`, then drive it through `dispatch_envelope` and
//! assert the wire response `type` strings, `requestId` echo, and payload shapes
//! match the TypeScript daemon (messages.ts).

use std::sync::Arc;

use async_trait::async_trait;
use rocky_agent_domain::{AgentRuntimeInfo, AgentTimelineItem};
use rocky_agents::{
    AgentError, AgentManager, AgentProvider, AgentSession, CreateAgentOptions, ProviderSessionConfig,
    PromptInput,
};
use rocky_ws_session::{handlers, SessionDispatcher};
use serde_json::{json, Value};
use tempfile::TempDir;

// --- Mock provider/session (mirrors rocky-agents/tests/agents.rs) ---

struct MockSession {
    provider: String,
}

#[async_trait]
impl AgentSession for MockSession {
    fn session_id(&self) -> Option<String> {
        Some("sess-mock".to_string())
    }
    fn runtime_info(&self) -> AgentRuntimeInfo {
        AgentRuntimeInfo {
            provider: self.provider.clone(),
            session_id: self.session_id(),
            model: None,
            thinking_option_id: None,
            mode_id: None,
            extra: None,
        }
    }
    async fn prompt(&self, _input: PromptInput) -> Result<(), AgentError> {
        Ok(())
    }
    async fn cancel(&self) -> Result<(), AgentError> {
        Ok(())
    }
    async fn close(&self) -> Result<(), AgentError> {
        Ok(())
    }
}

struct MockProvider {
    id: String,
}

#[async_trait]
impl AgentProvider for MockProvider {
    fn id(&self) -> &str {
        &self.id
    }
    async fn create_session(
        &self,
        config: ProviderSessionConfig,
    ) -> Result<Box<dyn AgentSession>, AgentError> {
        Ok(Box::new(MockSession {
            provider: config.provider,
        }))
    }
}

fn build_dispatcher(manager: Arc<AgentManager>) -> SessionDispatcher {
    let mut d = SessionDispatcher::new();
    let provider: Arc<dyn AgentProvider> = Arc::new(MockProvider {
        id: "claude".to_string(),
    });
    handlers::agent::register(&mut d, manager, provider);
    d
}

fn envelope(inner: Value) -> Value {
    json!({ "type": "session", "message": inner })
}

async fn create_agent(manager: &AgentManager, cwd: &str) -> String {
    let provider = MockProvider {
        id: "claude".to_string(),
    };
    let mut opts = CreateAgentOptions::new("claude");
    opts.cwd = Some(cwd.to_string());
    manager.create_agent(&provider, opts).await.unwrap().id
}

#[tokio::test]
async fn fetch_agents_on_empty_manager_returns_empty_entries() {
    let home = TempDir::new().unwrap();
    let manager = Arc::new(AgentManager::new(home.path()));
    let d = build_dispatcher(manager);

    let env = envelope(json!({ "type": "fetch_agents_request", "requestId": "r1" }));
    let out = d.dispatch_envelope(&env).await.unwrap();

    assert_eq!(out["type"], "session");
    let m = &out["message"];
    assert_eq!(m["type"], "fetch_agents_response");
    assert_eq!(m["payload"]["requestId"], "r1");
    assert_eq!(m["payload"]["entries"], json!([]));
    assert_eq!(m["payload"]["pageInfo"]["hasMore"], false);
    assert!(m["payload"]["pageInfo"]["nextCursor"].is_null());
}

#[tokio::test]
async fn cancel_nonexistent_agent_returns_response_with_null_agent() {
    let home = TempDir::new().unwrap();
    let manager = Arc::new(AgentManager::new(home.path()));
    let d = build_dispatcher(manager);

    let env = envelope(json!({
        "type": "cancel_agent_request",
        "requestId": "c1",
        "agentId": "does-not-exist",
    }));
    let out = d.dispatch_envelope(&env).await.unwrap();
    let m = &out["message"];
    assert_eq!(m["type"], "cancel_agent_response");
    assert_eq!(m["payload"]["requestId"], "c1");
    assert_eq!(m["payload"]["agentId"], "does-not-exist");
    // No panic; missing agent surfaces as null agent (messages.ts:2708-2715).
    assert!(m["payload"]["agent"].is_null());
}

#[tokio::test]
async fn archive_nonexistent_agent_returns_rpc_error() {
    let home = TempDir::new().unwrap();
    let manager = Arc::new(AgentManager::new(home.path()));
    let d = build_dispatcher(manager);

    let env = envelope(json!({
        "type": "archive_agent_request",
        "requestId": "a1",
        "agentId": "missing",
    }));
    let out = d.dispatch_envelope(&env).await.unwrap();
    let m = &out["message"];
    assert_eq!(m["type"], "rpc_error");
    assert_eq!(m["payload"]["requestId"], "a1");
    assert_eq!(m["payload"]["requestType"], "archive_agent_request");
    assert!(m["payload"]["error"].as_str().is_some());
}

#[tokio::test]
async fn fetch_agent_nonexistent_returns_null_with_error() {
    let home = TempDir::new().unwrap();
    let manager = Arc::new(AgentManager::new(home.path()));
    let d = build_dispatcher(manager);

    let env = envelope(json!({
        "type": "fetch_agent_request",
        "requestId": "f1",
        "agentId": "nope",
    }));
    let out = d.dispatch_envelope(&env).await.unwrap();
    let m = &out["message"];
    assert_eq!(m["type"], "fetch_agent_response");
    assert_eq!(m["payload"]["requestId"], "f1");
    assert!(m["payload"]["agent"].is_null());
    assert!(m["payload"]["project"].is_null());
    assert_eq!(m["payload"]["error"], "Agent not found: nope");
}

#[tokio::test]
async fn fetch_agent_returns_created_agent_payload() {
    let home = TempDir::new().unwrap();
    let manager = Arc::new(AgentManager::new(home.path()));
    let id = create_agent(&manager, "/tmp/proj-fetch").await;
    let d = build_dispatcher(manager);

    let env = envelope(json!({
        "type": "fetch_agent_request",
        "requestId": "f2",
        "agentId": id.clone(),
    }));
    let out = d.dispatch_envelope(&env).await.unwrap();
    let m = &out["message"];
    assert_eq!(m["type"], "fetch_agent_response");
    assert_eq!(m["payload"]["requestId"], "f2");
    let agent = &m["payload"]["agent"];
    assert_eq!(agent["id"], id);
    assert_eq!(agent["provider"], "claude");
    assert_eq!(agent["cwd"], "/tmp/proj-fetch");
    assert_eq!(agent["status"], "idle");
    // Default-projected required fields are present and well-typed.
    assert!(agent["capabilities"]["supportsStreaming"].is_boolean());
    assert!(agent["availableModes"].is_array());
    assert!(agent["pendingPermissions"].is_array());
    assert_eq!(agent["requiresAttention"], false);
    assert!(agent["attentionReason"].is_null());
    // runtimeInfo from the mock session is projected through.
    assert_eq!(agent["runtimeInfo"]["provider"], "claude");
    // Project placement uses the valid not-git checkout variant.
    assert_eq!(m["payload"]["project"]["checkout"]["isGit"], false);
}

#[tokio::test]
async fn fetch_agents_lists_created_agent_entry() {
    let home = TempDir::new().unwrap();
    let manager = Arc::new(AgentManager::new(home.path()));
    let id = create_agent(&manager, "/tmp/proj-list").await;
    let d = build_dispatcher(manager);

    let env = envelope(json!({ "type": "fetch_agents_request", "requestId": "r2" }));
    let out = d.dispatch_envelope(&env).await.unwrap();
    let entries = out["message"]["payload"]["entries"].as_array().unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0]["agent"]["id"], id);
    assert_eq!(entries[0]["project"]["projectKey"], "tmp-proj-list");
}

#[tokio::test]
async fn fetch_agent_history_lists_all_entries_with_page_info() {
    let home = TempDir::new().unwrap();
    let manager = Arc::new(AgentManager::new(home.path()));
    let id_a = create_agent(&manager, "/tmp/proj-hist-a").await;
    let id_b = create_agent(&manager, "/tmp/proj-hist-b").await;
    let d = build_dispatcher(manager);

    let env = envelope(json!({ "type": "fetch_agent_history_request", "requestId": "h1" }));
    let out = d.dispatch_envelope(&env).await.unwrap();

    let m = &out["message"];
    assert_eq!(m["type"], "fetch_agent_history_response");
    assert_eq!(m["payload"]["requestId"], "h1");
    let entries = m["payload"]["entries"].as_array().unwrap();
    assert_eq!(entries.len(), 2);
    let ids: Vec<&str> = entries
        .iter()
        .map(|e| e["agent"]["id"].as_str().unwrap())
        .collect();
    assert!(ids.contains(&id_a.as_str()));
    assert!(ids.contains(&id_b.as_str()));
    for entry in entries {
        assert!(entry.get("agent").is_some());
        assert!(entry.get("project").is_some());
    }
    assert_eq!(m["payload"]["pageInfo"]["hasMore"], false);
    assert!(m["payload"]["pageInfo"]["nextCursor"].is_null());
    assert!(m["payload"]["pageInfo"]["prevCursor"].is_null());
}

#[tokio::test]
async fn fetch_agent_history_honors_page_limit_and_sets_has_more() {
    let home = TempDir::new().unwrap();
    let manager = Arc::new(AgentManager::new(home.path()));
    create_agent(&manager, "/tmp/proj-hist-1").await;
    create_agent(&manager, "/tmp/proj-hist-2").await;
    let d = build_dispatcher(manager);

    let env = envelope(json!({
        "type": "fetch_agent_history_request",
        "requestId": "h2",
        "page": { "limit": 1 },
    }));
    let out = d.dispatch_envelope(&env).await.unwrap();

    let m = &out["message"];
    assert_eq!(m["type"], "fetch_agent_history_response");
    let entries = m["payload"]["entries"].as_array().unwrap();
    assert_eq!(entries.len(), 1);
    assert!(entries[0].get("agent").is_some());
    assert!(entries[0].get("project").is_some());
    assert_eq!(m["payload"]["pageInfo"]["hasMore"], true);
    assert!(m["payload"]["pageInfo"]["nextCursor"].is_null());
    assert!(m["payload"]["pageInfo"]["prevCursor"].is_null());
}

#[tokio::test]
async fn fetch_agent_timeline_returns_rows() {
    let home = TempDir::new().unwrap();
    let manager = Arc::new(AgentManager::new(home.path()));
    let id = create_agent(&manager, "/tmp/proj-timeline").await;
    manager
        .append_timeline(
            &id,
            AgentTimelineItem::AssistantMessage {
                text: "hello".to_string(),
                message_id: None,
            },
            Some("turn-1".to_string()),
        )
        .await
        .unwrap();
    let d = build_dispatcher(manager);

    let env = envelope(json!({
        "type": "fetch_agent_timeline_request",
        "requestId": "t1",
        "agentId": id.clone(),
    }));
    let out = d.dispatch_envelope(&env).await.unwrap();
    let m = &out["message"];
    assert_eq!(m["type"], "fetch_agent_timeline_response");
    assert_eq!(m["payload"]["requestId"], "t1");
    assert_eq!(m["payload"]["agentId"], id);
    let entries = m["payload"]["entries"].as_array().unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0]["provider"], "claude");
    assert_eq!(entries[0]["item"]["type"], "assistant_message");
    assert_eq!(entries[0]["item"]["text"], "hello");
    assert_eq!(entries[0]["seqStart"], 1);
    assert_eq!(entries[0]["seqEnd"], 1);
    assert_eq!(m["payload"]["window"]["maxSeq"], 1);
}

#[tokio::test]
async fn delete_nonexistent_agent_acks_without_panic() {
    let home = TempDir::new().unwrap();
    let manager = Arc::new(AgentManager::new(home.path()));
    let d = build_dispatcher(manager);

    let env = envelope(json!({
        "type": "delete_agent_request",
        "requestId": "d1",
        "agentId": "ghost",
    }));
    let out = d.dispatch_envelope(&env).await.unwrap();
    let m = &out["message"];
    assert_eq!(m["type"], "agent_deleted");
    assert_eq!(m["payload"]["agentId"], "ghost");
    assert_eq!(m["payload"]["requestId"], "d1");
}

#[tokio::test]
async fn set_agent_mode_without_provider_returns_structured_error() {
    let home = TempDir::new().unwrap();
    let manager = Arc::new(AgentManager::new(home.path()));
    let id = create_agent(&manager, "/tmp/proj-mode").await;
    let d = build_dispatcher(manager);

    let env = envelope(json!({
        "type": "set_agent_mode_request",
        "requestId": "m1",
        "agentId": id.clone(),
        "modeId": "plan",
    }));
    let out = d.dispatch_envelope(&env).await.unwrap();
    let m = &out["message"];
    assert_eq!(m["type"], "set_agent_mode_response");
    assert_eq!(m["payload"]["requestId"], "m1");
    assert_eq!(m["payload"]["agentId"], id);
    assert_eq!(m["payload"]["accepted"], false);
    assert!(m["payload"]["error"].as_str().is_some());
}

#[tokio::test]
async fn clear_attention_returns_agents_array() {
    let home = TempDir::new().unwrap();
    let manager = Arc::new(AgentManager::new(home.path()));
    let id = create_agent(&manager, "/tmp/proj-attn").await;
    let d = build_dispatcher(manager);

    let env = envelope(json!({
        "type": "clear_agent_attention",
        "requestId": "ca1",
        "agentId": id.clone(),
    }));
    let out = d.dispatch_envelope(&env).await.unwrap();
    let m = &out["message"];
    assert_eq!(m["type"], "clear_agent_attention_response");
    assert_eq!(m["payload"]["requestId"], "ca1");
    assert_eq!(m["payload"]["agentId"], id);
    let agents = m["payload"]["agents"].as_array().unwrap();
    assert_eq!(agents.len(), 1);
    assert_eq!(agents[0]["id"], id);
}

#[tokio::test]
async fn create_agent_request_uses_live_provider_and_send_is_accepted() {
    // create_agent_request -> `status` `agent_created` with the live snapshot
    // (session.ts:3119-3128), then send_agent_message_request -> accepted:true
    // (messages.ts:2745-2753). Backed by the mock provider, no subprocess.
    let home = TempDir::new().unwrap();
    let manager = Arc::new(AgentManager::new(home.path()));
    let d = build_dispatcher(manager.clone());

    let env = envelope(json!({
        "type": "create_agent_request",
        "requestId": "cr1",
        "config": { "provider": "claude", "cwd": "/tmp/proj-create" },
        "labels": {},
    }));
    let out = d.dispatch_envelope(&env).await.unwrap();
    let m = &out["message"];
    assert_eq!(m["type"], "status");
    assert_eq!(m["payload"]["status"], "agent_created");
    assert_eq!(m["payload"]["requestId"], "cr1");
    let agent_id = m["payload"]["agentId"].as_str().unwrap().to_string();
    assert!(!agent_id.is_empty());
    assert_eq!(m["payload"]["agent"]["id"], agent_id);
    assert_eq!(m["payload"]["agent"]["provider"], "claude");

    // Agent exists in the manager.
    assert!(manager.get(&agent_id).await.is_some());

    let env = envelope(json!({
        "type": "send_agent_message_request",
        "requestId": "sm1",
        "agentId": agent_id.clone(),
        "text": "reply OK",
    }));
    let out = d.dispatch_envelope(&env).await.unwrap();
    let m = &out["message"];
    assert_eq!(m["type"], "send_agent_message_response");
    assert_eq!(m["payload"]["requestId"], "sm1");
    assert_eq!(m["payload"]["agentId"], agent_id);
    assert_eq!(m["payload"]["accepted"], true);
    assert!(m["payload"]["error"].is_null());
}

/// Session that records every prompt it receives, so a test can assert the
/// initial prompt is delivered as the first turn.
struct RecordingSession {
    provider: String,
    prompts: Arc<std::sync::Mutex<Vec<PromptInput>>>,
    /// Records (kind, value) for each config mutation, e.g. ("thinking","low").
    config_writes: Arc<std::sync::Mutex<Vec<(String, String)>>>,
    /// When true, config mutators return an error instead of recording.
    fail_config: bool,
}

#[async_trait]
impl AgentSession for RecordingSession {
    fn session_id(&self) -> Option<String> {
        Some("sess-rec".to_string())
    }
    fn runtime_info(&self) -> AgentRuntimeInfo {
        AgentRuntimeInfo {
            provider: self.provider.clone(),
            session_id: self.session_id(),
            model: None,
            thinking_option_id: None,
            mode_id: None,
            extra: None,
        }
    }
    async fn prompt(&self, input: PromptInput) -> Result<(), AgentError> {
        self.prompts.lock().unwrap().push(input);
        Ok(())
    }
    async fn set_thinking_option(&self, option_id: &str) -> Result<String, AgentError> {
        if self.fail_config {
            return Err(AgentError::Provider("thinking unsupported".into()));
        }
        self.config_writes
            .lock()
            .unwrap()
            .push(("thinking".to_string(), option_id.to_string()));
        Ok(option_id.to_string())
    }
    async fn set_model(&self, model_id: &str) -> Result<String, AgentError> {
        if self.fail_config {
            return Err(AgentError::Provider("model unsupported".into()));
        }
        self.config_writes
            .lock()
            .unwrap()
            .push(("model".to_string(), model_id.to_string()));
        Ok(model_id.to_string())
    }
    async fn set_mode(&self, mode_id: &str) -> Result<(), AgentError> {
        if self.fail_config {
            return Err(AgentError::Provider("mode unsupported".into()));
        }
        self.config_writes
            .lock()
            .unwrap()
            .push(("mode".to_string(), mode_id.to_string()));
        Ok(())
    }
    fn available_modes(&self) -> Vec<rocky_agent_domain::AgentMode> {
        vec![
            rocky_agent_domain::AgentMode {
                id: "default".to_string(),
                label: "Default".to_string(),
                description: None,
            },
            rocky_agent_domain::AgentMode {
                id: "bypass".to_string(),
                label: "Bypass".to_string(),
                description: None,
            },
        ]
    }
    fn current_mode_id(&self) -> Option<String> {
        Some("default".to_string())
    }
    async fn cancel(&self) -> Result<(), AgentError> {
        Ok(())
    }
    async fn close(&self) -> Result<(), AgentError> {
        Ok(())
    }
}

struct RecordingProvider {
    prompts: Arc<std::sync::Mutex<Vec<PromptInput>>>,
    config_writes: Arc<std::sync::Mutex<Vec<(String, String)>>>,
    fail_config: bool,
}

impl RecordingProvider {
    fn new(prompts: Arc<std::sync::Mutex<Vec<PromptInput>>>) -> Self {
        Self {
            prompts,
            config_writes: Arc::new(std::sync::Mutex::new(Vec::new())),
            fail_config: false,
        }
    }
}

#[async_trait]
impl AgentProvider for RecordingProvider {
    fn id(&self) -> &str {
        "claude"
    }
    async fn create_session(
        &self,
        config: ProviderSessionConfig,
    ) -> Result<Box<dyn AgentSession>, AgentError> {
        Ok(Box::new(RecordingSession {
            provider: config.provider,
            prompts: self.prompts.clone(),
            config_writes: self.config_writes.clone(),
            fail_config: self.fail_config,
        }))
    }
}

#[tokio::test]
async fn create_agent_request_delivers_initial_prompt_as_first_turn() {
    // Regression: the WebUI's Team "Launch Leader" flow (and any first-message
    // create) passes the message via `create_agent_request.initialPrompt` and
    // sends NO separate send_agent_message_request. The Rust handler must deliver
    // that prompt as the first turn (mirrors TS create.ts `sendInitialPrompt`),
    // otherwise the agent is created idle and the message is silently dropped.
    let home = TempDir::new().unwrap();
    let manager = Arc::new(AgentManager::new(home.path()));
    let prompts = Arc::new(std::sync::Mutex::new(Vec::<PromptInput>::new()));
    let mut d = SessionDispatcher::new();
    let provider: Arc<dyn AgentProvider> = Arc::new(RecordingProvider::new(prompts.clone()));
    handlers::agent::register(&mut d, manager.clone(), provider);

    let env = envelope(json!({
        "type": "create_agent_request",
        "requestId": "cr-ip",
        "config": { "provider": "claude", "cwd": "/tmp/proj-initial-prompt" },
        "initialPrompt": "  Launch the mission: build X  ",
        "clientMessageId": "cmsg-1",
        "labels": {},
    }));
    let out = d.dispatch_envelope(&env).await.unwrap();
    assert_eq!(out["message"]["payload"]["status"], "agent_created");

    let recorded = prompts.lock().unwrap();
    assert_eq!(recorded.len(), 1, "exactly one first-turn prompt expected");
    // Trimmed, mirroring TS `initialPrompt?.trim()`.
    assert_eq!(recorded[0].text, "Launch the mission: build X");
    assert_eq!(recorded[0].message_id.as_deref(), Some("cmsg-1"));
}

#[tokio::test]
async fn create_agent_request_without_initial_prompt_does_not_prompt() {
    // A blank/whitespace initialPrompt (or none) must not start a turn.
    let home = TempDir::new().unwrap();
    let manager = Arc::new(AgentManager::new(home.path()));
    let prompts = Arc::new(std::sync::Mutex::new(Vec::<PromptInput>::new()));
    let mut d = SessionDispatcher::new();
    let provider: Arc<dyn AgentProvider> = Arc::new(RecordingProvider::new(prompts.clone()));
    handlers::agent::register(&mut d, manager, provider);

    let env = envelope(json!({
        "type": "create_agent_request",
        "requestId": "cr-empty",
        "config": { "provider": "claude", "cwd": "/tmp/proj-no-prompt" },
        "initialPrompt": "   ",
        "labels": {},
    }));
    let out = d.dispatch_envelope(&env).await.unwrap();
    assert_eq!(out["message"]["payload"]["status"], "agent_created");
    assert!(prompts.lock().unwrap().is_empty(), "no prompt for blank initialPrompt");
}

#[tokio::test]
async fn fetch_agent_payload_carries_live_session_modes() {
    // Regression: the composer mode selector (Default/Plan/Bypass) renders only
    // when the agent snapshot carries a non-empty `availableModes`. The ws layer
    // used to hardcode `availableModes: []`, so an existing agent never showed
    // the bypass mode even though its live session advertised it. The payload
    // must surface the live session's modes and current mode id.
    let home = TempDir::new().unwrap();
    let manager = Arc::new(AgentManager::new(home.path()));
    let prompts = Arc::new(std::sync::Mutex::new(Vec::<PromptInput>::new()));
    let provider: Arc<dyn AgentProvider> = Arc::new(RecordingProvider::new(prompts));
    let mut d = SessionDispatcher::new();
    handlers::agent::register(&mut d, manager, provider);

    let agent_id = create_agent_for(&d, "/tmp/proj-modes").await;

    let env = envelope(json!({
        "type": "fetch_agent_request",
        "requestId": "fm",
        "agentId": agent_id,
    }));
    let out = d.dispatch_envelope(&env).await.unwrap();
    let agent = &out["message"]["payload"]["agent"];
    let modes = agent["availableModes"].as_array().expect("availableModes is an array");
    let ids: Vec<&str> = modes.iter().filter_map(|m| m["id"].as_str()).collect();
    assert_eq!(ids, vec!["default", "bypass"], "live session modes surfaced to UI");
    assert_eq!(agent["currentModeId"], "default");
}

#[tokio::test]
async fn send_agent_message_to_missing_agent_is_rejected() {
    let home = TempDir::new().unwrap();
    let manager = Arc::new(AgentManager::new(home.path()));
    let d = build_dispatcher(manager);

    let env = envelope(json!({
        "type": "send_agent_message_request",
        "requestId": "sm2",
        "agentId": "does-not-exist",
        "text": "hi",
    }));
    let out = d.dispatch_envelope(&env).await.unwrap();
    let m = &out["message"];
    assert_eq!(m["type"], "send_agent_message_response");
    assert_eq!(m["payload"]["accepted"], false);
    assert!(!m["payload"]["error"].is_null());
}

/// Create an agent through the dispatcher and return its id.
async fn create_agent_for(d: &SessionDispatcher, cwd: &str) -> String {
    let env = envelope(json!({
        "type": "create_agent_request",
        "requestId": "cr-cfg",
        "config": { "provider": "claude", "cwd": cwd },
        "labels": {},
    }));
    let out = d.dispatch_envelope(&env).await.unwrap();
    assert_eq!(out["message"]["payload"]["status"], "agent_created");
    out["message"]["payload"]["agentId"]
        .as_str()
        .expect("agent_created carries agentId")
        .to_string()
}

#[tokio::test]
async fn set_agent_thinking_delivers_to_session_and_accepts() {
    // Regression: the composer exposes the thinking selector (off/minimal/.../xhigh).
    // Applying a level must reach the live session via session/set_config_option
    // and return accepted:true — not the old "not wired into the session
    // dispatcher" rejection.
    let home = TempDir::new().unwrap();
    let manager = Arc::new(AgentManager::new(home.path()));
    let prompts = Arc::new(std::sync::Mutex::new(Vec::<PromptInput>::new()));
    let provider = Arc::new(RecordingProvider::new(prompts));
    let writes = provider.config_writes.clone();
    let mut d = SessionDispatcher::new();
    handlers::agent::register(&mut d, manager, provider as Arc<dyn AgentProvider>);

    let agent_id = create_agent_for(&d, "/tmp/proj-thinking").await;

    // thinking
    let env = envelope(json!({
        "type": "set_agent_thinking_request",
        "requestId": "st-1",
        "agentId": agent_id,
        "thinkingOptionId": "low",
    }));
    let out = d.dispatch_envelope(&env).await.unwrap();
    let m = &out["message"];
    assert_eq!(m["type"], "set_agent_thinking_response");
    assert_eq!(m["payload"]["accepted"], true);
    assert!(m["payload"]["error"].is_null());

    // model
    let env = envelope(json!({
        "type": "set_agent_model_request",
        "requestId": "sm-1",
        "agentId": agent_id,
        "modelId": "anthropic/claude-3-5-sonnet",
    }));
    let out = d.dispatch_envelope(&env).await.unwrap();
    assert_eq!(out["message"]["type"], "set_agent_model_response");
    assert_eq!(out["message"]["payload"]["accepted"], true);

    // mode
    let env = envelope(json!({
        "type": "set_agent_mode_request",
        "requestId": "smode-1",
        "agentId": agent_id,
        "modeId": "default",
    }));
    let out = d.dispatch_envelope(&env).await.unwrap();
    assert_eq!(out["message"]["type"], "set_agent_mode_response");
    assert_eq!(out["message"]["payload"]["accepted"], true);

    let recorded = writes.lock().unwrap();
    assert_eq!(
        *recorded,
        vec![
            ("thinking".to_string(), "low".to_string()),
            ("model".to_string(), "anthropic/claude-3-5-sonnet".to_string()),
            ("mode".to_string(), "default".to_string()),
        ]
    );
}

#[tokio::test]
async fn set_agent_thinking_null_is_accepted_without_session_call() {
    // A null thinkingOptionId clears the level (TS setThinkingOption(null) early
    // return); it must accept without hitting the session.
    let home = TempDir::new().unwrap();
    let manager = Arc::new(AgentManager::new(home.path()));
    let prompts = Arc::new(std::sync::Mutex::new(Vec::<PromptInput>::new()));
    let provider = Arc::new(RecordingProvider::new(prompts));
    let writes = provider.config_writes.clone();
    let mut d = SessionDispatcher::new();
    handlers::agent::register(&mut d, manager, provider as Arc<dyn AgentProvider>);

    let agent_id = create_agent_for(&d, "/tmp/proj-thinking-null").await;
    let env = envelope(json!({
        "type": "set_agent_thinking_request",
        "requestId": "st-null",
        "agentId": agent_id,
        "thinkingOptionId": Value::Null,
    }));
    let out = d.dispatch_envelope(&env).await.unwrap();
    assert_eq!(out["message"]["payload"]["accepted"], true);
    assert!(writes.lock().unwrap().is_empty(), "null must not call the session");
}

#[tokio::test]
async fn set_agent_thinking_propagates_provider_error() {
    // When the provider/session rejects the change, the response must be
    // accepted:false with a non-null error (never a fake ok).
    let home = TempDir::new().unwrap();
    let manager = Arc::new(AgentManager::new(home.path()));
    let prompts = Arc::new(std::sync::Mutex::new(Vec::<PromptInput>::new()));
    let mut provider = RecordingProvider::new(prompts);
    provider.fail_config = true;
    let provider = Arc::new(provider);
    let mut d = SessionDispatcher::new();
    handlers::agent::register(&mut d, manager, provider as Arc<dyn AgentProvider>);

    let agent_id = create_agent_for(&d, "/tmp/proj-thinking-fail").await;
    let env = envelope(json!({
        "type": "set_agent_thinking_request",
        "requestId": "st-fail",
        "agentId": agent_id,
        "thinkingOptionId": "high",
    }));
    let out = d.dispatch_envelope(&env).await.unwrap();
    assert_eq!(out["message"]["payload"]["accepted"], false);
    assert!(!out["message"]["payload"]["error"].is_null());
}

#[tokio::test]
async fn set_agent_thinking_missing_agent_is_rejected() {
    let home = TempDir::new().unwrap();
    let manager = Arc::new(AgentManager::new(home.path()));
    let prompts = Arc::new(std::sync::Mutex::new(Vec::<PromptInput>::new()));
    let provider = Arc::new(RecordingProvider::new(prompts));
    let mut d = SessionDispatcher::new();
    handlers::agent::register(&mut d, manager, provider as Arc<dyn AgentProvider>);

    let env = envelope(json!({
        "type": "set_agent_thinking_request",
        "requestId": "st-missing",
        "agentId": "does-not-exist",
        "thinkingOptionId": "low",
    }));
    let out = d.dispatch_envelope(&env).await.unwrap();
    assert_eq!(out["message"]["payload"]["accepted"], false);
    assert!(!out["message"]["payload"]["error"].is_null());
}
