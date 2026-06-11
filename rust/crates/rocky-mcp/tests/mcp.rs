//! Behavior tests for the MCP protocol layer + mission/agent tool subset.
//!
//! Exercises the JSON-RPC envelope (`initialize`/`tools/list`/`tools/call`),
//! the mission round-trip through `rocky-mission-control` (Phase 5 acceptance),
//! error mapping for unknown/invalid calls, and parent-label stamping on
//! `create_agent`.

use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use rocky_agent_domain::{AgentRuntimeInfo, AgentStatus};
use rocky_agents::{
    AgentError, AgentManager, AgentProvider, AgentSession, ProviderSessionConfig, PromptInput,
    PARENT_AGENT_ID_LABEL,
};
use rocky_mcp::{McpContext, McpServer};
use rocky_mission_control::FileBackedMissionControlService;
use serde_json::{json, Value};
use tempfile::TempDir;

// --- mock provider ----------------------------------------------------------

/// Records the config of every session it creates, so tests can assert what the
/// manager passed through (cwd, model). Parent label is asserted on the created
/// `ManagedAgent` itself.
#[derive(Default)]
struct RecordingProvider {
    configs: Mutex<Vec<ProviderSessionConfig>>,
}

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

#[async_trait]
impl AgentProvider for RecordingProvider {
    fn id(&self) -> &str {
        "claude"
    }
    async fn create_session(
        &self,
        config: ProviderSessionConfig,
    ) -> Result<Box<dyn AgentSession>, AgentError> {
        let provider = config.provider.clone();
        self.configs.lock().unwrap().push(config);
        Ok(Box::new(MockSession { provider }))
    }
}

// --- harness ----------------------------------------------------------------

struct Harness {
    _home: TempDir,
    manager: AgentManager,
    server: McpServer,
}

fn build_harness(provider: Option<Arc<dyn AgentProvider>>) -> Harness {
    let home = TempDir::new().unwrap();
    let manager = AgentManager::new(home.path());
    let mission = FileBackedMissionControlService::new(home.path());
    mission.initialize().unwrap();
    let ctx = match provider {
        Some(p) => McpContext::with_provider(manager.clone(), mission, p),
        None => McpContext::new(manager.clone(), mission),
    };
    let server = McpServer::new(ctx);
    Harness {
        _home: home,
        manager,
        server,
    }
}

async fn call(server: &McpServer, name: &str, args: Value, caller: Option<&str>) -> Value {
    let body = json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": { "name": name, "arguments": args },
    });
    server
        .handle_jsonrpc(body, caller.map(str::to_string))
        .await
}

fn result_of(response: &Value) -> &Value {
    assert!(
        response.get("error").is_none(),
        "expected success, got error: {response}"
    );
    &response["result"]["structuredContent"]
}

fn error_of(response: &Value) -> &Value {
    assert!(
        response.get("result").is_none(),
        "expected error, got result: {response}"
    );
    &response["error"]
}

// --- protocol ---------------------------------------------------------------

#[tokio::test]
async fn initialize_returns_protocol_and_server_info() {
    let h = build_harness(None);
    let body = json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize" });
    let response = h.server.handle_jsonrpc(body, None).await;
    let result = &response["result"];
    assert_eq!(result["protocolVersion"], rocky_mcp::PROTOCOL_VERSION);
    assert_eq!(result["serverInfo"]["name"], rocky_mcp::SERVER_NAME);
    assert!(result["serverInfo"]["version"].is_string());
    assert!(result["capabilities"]["tools"].is_object());
}

#[tokio::test]
async fn tools_list_includes_mission_and_agent_tools_with_schemas() {
    let h = build_harness(None);
    let body = json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" });
    let response = h.server.handle_jsonrpc(body, None).await;
    let tools = response["result"]["tools"].as_array().unwrap();
    let names: Vec<&str> = tools.iter().map(|t| t["name"].as_str().unwrap()).collect();
    for expected in [
        "create_mission",
        "list_missions",
        "inspect_mission",
        "create_mission_task",
        "update_mission_task",
        "list_agents",
        "get_agent_status",
        "cancel_agent",
        "archive_agent",
        "list_pending_permissions",
        "respond_to_permission",
        "create_agent",
    ] {
        assert!(names.contains(&expected), "missing tool {expected}");
    }
    // Every descriptor carries an inputSchema object with a type.
    for tool in tools {
        let schema = &tool["inputSchema"];
        assert_eq!(
            schema["type"], "object",
            "tool {} missing object inputSchema",
            tool["name"]
        );
    }
}

#[tokio::test]
async fn unknown_method_returns_method_not_found() {
    let h = build_harness(None);
    let body = json!({ "jsonrpc": "2.0", "id": 3, "method": "does/not/exist" });
    let response = h.server.handle_jsonrpc(body, None).await;
    assert_eq!(error_of(&response)["code"], -32601);
}

#[tokio::test]
async fn unknown_tool_returns_tool_error() {
    let h = build_harness(None);
    let response = call(&h.server, "no_such_tool", json!({}), None).await;
    assert_eq!(error_of(&response)["code"], -32601);
}

#[tokio::test]
async fn bad_args_return_invalid_params() {
    let h = build_harness(None);
    // create_mission requires a non-empty goal.
    let response = call(&h.server, "create_mission", json!({ "goal": "   " }), None).await;
    assert_eq!(error_of(&response)["code"], -32602);

    // missing required field entirely.
    let response = call(&h.server, "inspect_mission", json!({}), None).await;
    assert_eq!(error_of(&response)["code"], -32602);
}

// --- mission round-trip (Phase 5 acceptance) --------------------------------

#[tokio::test]
async fn mission_create_list_task_roundtrip_over_mcp() {
    let h = build_harness(None);

    // create_mission
    let created = call(
        &h.server,
        "create_mission",
        json!({ "goal": "Ship Phase 5", "status": "running" }),
        Some("leader-1"),
    )
    .await;
    let mission = &result_of(&created)["mission"];
    let mission_id = mission["id"].as_str().unwrap().to_string();
    assert_eq!(mission["goal"], "Ship Phase 5");
    assert_eq!(mission["status"], "running");
    // leaderAgentId defaults to the caller when omitted.
    assert_eq!(mission["leaderAgentId"], "leader-1");

    // list_missions returns it
    let listed = call(&h.server, "list_missions", json!({}), None).await;
    let missions = result_of(&listed)["missions"].as_array().unwrap();
    assert!(missions.iter().any(|m| m["id"] == mission_id.as_str()));

    // create_mission_task
    let created_task = call(
        &h.server,
        "create_mission_task",
        json!({
            "missionId": mission_id,
            "title": "Implement MCP layer",
            "acceptanceCriteria": ["compiles", "tests pass"],
            "isolation": "worktree",
        }),
        None,
    )
    .await;
    let task = &result_of(&created_task)["task"];
    let task_id = task["id"].as_str().unwrap().to_string();
    assert_eq!(task["title"], "Implement MCP layer");
    assert_eq!(task["isolation"], "worktree");
    assert_eq!(task["status"], "todo");

    // update_mission_task round-trips a status + result change
    let updated = call(
        &h.server,
        "update_mission_task",
        json!({
            "missionId": mission_id,
            "taskId": task_id,
            "status": "done",
            "result": "landed",
        }),
        None,
    )
    .await;
    let task = &result_of(&updated)["task"];
    assert_eq!(task["status"], "done");
    assert_eq!(task["result"], "landed");

    // inspect_mission reflects the task
    let inspected = call(
        &h.server,
        "inspect_mission",
        json!({ "missionId": mission_id }),
        None,
    )
    .await;
    let mission = &result_of(&inspected)["mission"];
    let tasks = mission["tasks"].as_array().unwrap();
    assert_eq!(tasks.len(), 1);
    assert_eq!(tasks[0]["status"], "done");
}

#[tokio::test]
async fn inspect_unknown_mission_returns_execution_error() {
    let h = build_harness(None);
    let response = call(
        &h.server,
        "inspect_mission",
        json!({ "missionId": "nope" }),
        None,
    )
    .await;
    let err = error_of(&response);
    assert_eq!(err["code"], -32000);
    assert_eq!(err["data"]["code"], "mission_not_found");
}

// --- core agent tools -------------------------------------------------------

#[tokio::test]
async fn list_agents_and_permissions_empty_on_fresh_manager() {
    let h = build_harness(None);

    let listed = call(&h.server, "list_agents", json!({}), None).await;
    assert_eq!(result_of(&listed)["agents"].as_array().unwrap().len(), 0);

    let perms = call(&h.server, "list_pending_permissions", json!({}), None).await;
    assert_eq!(
        result_of(&perms)["permissions"].as_array().unwrap().len(),
        0
    );
}

#[tokio::test]
async fn respond_to_unknown_permission_returns_structured_error() {
    let h = build_harness(None);
    let response = call(
        &h.server,
        "respond_to_permission",
        json!({ "requestId": "missing", "behavior": "allow" }),
        None,
    )
    .await;
    let err = error_of(&response);
    assert_eq!(err["code"], -32000);
    assert_eq!(err["data"]["code"], "permission_not_found");
}

#[tokio::test]
async fn create_agent_without_provider_is_not_wired_not_fake_ok() {
    let h = build_harness(None);
    let response = call(
        &h.server,
        "create_agent",
        json!({ "provider": "claude/sonnet", "title": "child" }),
        Some("parent-1"),
    )
    .await;
    let err = error_of(&response);
    assert_eq!(err["code"], -32010);
    assert_eq!(err["data"]["code"], "provider_wiring_required");
}

#[tokio::test]
async fn create_agent_stamps_parent_label_when_not_detached() {
    let provider = Arc::new(RecordingProvider::default());
    let h = build_harness(Some(provider.clone() as Arc<dyn AgentProvider>));

    let response = call(
        &h.server,
        "create_agent",
        json!({ "provider": "claude/sonnet", "title": "child", "cwd": "/tmp/work" }),
        Some("parent-1"),
    )
    .await;
    let structured = result_of(&response);
    let agent_id = structured["agentId"].as_str().unwrap();
    assert_eq!(structured["type"], "claude");
    assert_eq!(structured["status"], "idle");

    // The manager received the parent label.
    let agent = h.manager.get(agent_id).await.unwrap();
    assert_eq!(
        agent.labels.get(PARENT_AGENT_ID_LABEL).map(String::as_str),
        Some("parent-1")
    );
    // provider/model split was passed through.
    let configs = provider.configs.lock().unwrap();
    assert_eq!(configs.len(), 1);
    assert_eq!(configs[0].provider, "claude");
    assert_eq!(configs[0].model.as_deref(), Some("sonnet"));
    assert_eq!(configs[0].cwd, "/tmp/work");
}

#[tokio::test]
async fn create_agent_detached_omits_parent_label() {
    let provider = Arc::new(RecordingProvider::default());
    let h = build_harness(Some(provider as Arc<dyn AgentProvider>));

    let response = call(
        &h.server,
        "create_agent",
        json!({ "provider": "claude/sonnet", "title": "solo", "detached": true }),
        Some("parent-1"),
    )
    .await;
    let agent_id = result_of(&response)["agentId"].as_str().unwrap().to_string();
    let agent = h.manager.get(&agent_id).await.unwrap();
    assert!(!agent.labels.contains_key(PARENT_AGENT_ID_LABEL));
}

#[tokio::test]
async fn cancel_unknown_agent_returns_not_found() {
    let h = build_harness(None);
    let response = call(&h.server, "cancel_agent", json!({ "agentId": "ghost" }), None).await;
    let err = error_of(&response);
    assert_eq!(err["code"], -32000);
    assert_eq!(err["data"]["code"], "agent_not_found");
}

#[tokio::test]
async fn session_tools_report_not_wired() {
    let h = build_harness(None);
    let response = call(
        &h.server,
        "send_agent_prompt",
        json!({ "agentId": "a", "prompt": "hi" }),
        None,
    )
    .await;
    assert_eq!(error_of(&response)["code"], -32010);

    let response = call(&h.server, "wait_for_agent", json!({ "agentId": "a" }), None).await;
    assert_eq!(error_of(&response)["code"], -32010);
}

// --- router smoke (axum mount) ----------------------------------------------

#[tokio::test]
async fn router_post_handles_initialize() {
    use tower::ServiceExt;

    let home = TempDir::new().unwrap();
    let manager = AgentManager::new(home.path());
    let mission = FileBackedMissionControlService::new(home.path());
    mission.initialize().unwrap();
    let ctx = McpContext::new(manager, mission);
    let app = rocky_mcp::mcp_router(ctx);

    let body = serde_json::to_vec(&json!({
        "jsonrpc": "2.0", "id": 1, "method": "initialize"
    }))
    .unwrap();
    let request = axum::http::Request::builder()
        .method("POST")
        .uri("/?callerAgentId=caller-9")
        .header("content-type", "application/json")
        .body(axum::body::Body::from(body))
        .unwrap();

    let response = app.oneshot(request).await.unwrap();
    assert_eq!(response.status(), axum::http::StatusCode::OK);
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let value: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(value["result"]["serverInfo"]["name"], rocky_mcp::SERVER_NAME);
}

// Keep AgentStatus import used (status enum serde shape relied on above).
#[allow(dead_code)]
fn _assert_status(_s: AgentStatus) {}
