//! Behavior tests for the on-load daemon read RPC handlers
//! (`handlers::daemon_read::register`). The WebUI fires these immediately after
//! `hello`; assert the wire response `type` strings, `requestId` echo, and
//! payload shapes match the TypeScript daemon (messages.ts / session.ts).

use std::sync::Arc;

use async_trait::async_trait;
use rocky_agents::{AgentError, AgentProvider, AgentSession, ProviderSessionConfig};
use rocky_ws_session::handlers::daemon_read::DaemonReadContext;
use rocky_ws_session::{handlers, SessionDispatcher};
use serde_json::{json, Value};
use tempfile::TempDir;

const REPO_ROOT: &str = "/Users/steve/roy/rocky";

struct AmazeProvider;

#[async_trait]
impl AgentProvider for AmazeProvider {
    fn id(&self) -> &str {
        "amaze"
    }
    async fn create_session(
        &self,
        _config: ProviderSessionConfig,
    ) -> Result<Box<dyn AgentSession>, AgentError> {
        Err(AgentError::Provider("not used in daemon_read tests".to_string()))
    }
}

fn build(home: &TempDir) -> SessionDispatcher {
    let ctx = DaemonReadContext {
        server_id: "srv-test".to_string(),
        version: Some("0.1.0".to_string()),
        listen: Some("127.0.0.1:7767".to_string()),
        pid: 4242,
        node_path: "/usr/bin/rockyd".to_string(),
        started_at: Some("2026-06-11T00:00:00Z".to_string()),
        rocky_home: home.path().to_path_buf(),
        repo_root: REPO_ROOT.to_string(),
        provider: Arc::new(AmazeProvider),
    };
    let mut d = SessionDispatcher::new();
    handlers::daemon_read::register(&mut d, ctx);
    d
}

fn envelope(inner: Value) -> Value {
    json!({ "type": "session", "message": inner })
}

#[tokio::test]
async fn get_daemon_config_returns_config_object() {
    let home = TempDir::new().unwrap();
    std::fs::write(
        home.path().join("config.json"),
        r#"{"daemon":{"mcp":{"injectIntoAgents":true},"appendSystemPrompt":"hi","autoArchiveAfterMerge":true,"teamAgents":[]}}"#,
    )
    .unwrap();
    let d = build(&home);

    let env = envelope(json!({ "type": "get_daemon_config_request", "requestId": "g1" }));
    let out = d.dispatch_envelope(&env).await.unwrap();
    let m = &out["message"];
    assert_eq!(m["type"], "get_daemon_config_response");
    assert_eq!(m["payload"]["requestId"], "g1");
    let config = &m["payload"]["config"];
    assert!(config.is_object());
    assert_eq!(config["mcp"]["injectIntoAgents"], true);
    assert_eq!(config["appendSystemPrompt"], "hi");
    assert_eq!(config["autoArchiveAfterMerge"], true);
    assert!(config["providers"].is_object());
    assert!(config["metadataGeneration"]["providers"].is_array());
}

#[tokio::test]
async fn get_daemon_config_defaults_when_no_file() {
    let home = TempDir::new().unwrap();
    let d = build(&home);
    let env = envelope(json!({ "type": "get_daemon_config_request", "requestId": "g2" }));
    let out = d.dispatch_envelope(&env).await.unwrap();
    let config = &out["message"]["payload"]["config"];
    assert_eq!(config["mcp"]["injectIntoAgents"], false);
    assert_eq!(config["appendSystemPrompt"], "");
    assert_eq!(config["teamAgents"], json!([]));
}

#[tokio::test]
async fn daemon_get_status_returns_serverid_listen_providers() {
    let home = TempDir::new().unwrap();
    let d = build(&home);
    let env = envelope(json!({ "type": "daemon.get_status.request", "requestId": "s1" }));
    let out = d.dispatch_envelope(&env).await.unwrap();
    let m = &out["message"];
    assert_eq!(m["type"], "daemon.get_status.response");
    assert_eq!(m["payload"]["requestId"], "s1");
    assert_eq!(m["payload"]["serverId"], "srv-test");
    assert_eq!(m["payload"]["listen"], "127.0.0.1:7767");
    assert_eq!(m["payload"]["pid"], 4242);
    assert_eq!(m["payload"]["nodePath"], "/usr/bin/rockyd");
    let providers = m["payload"]["providers"].as_array().unwrap();
    assert_eq!(providers.len(), 1);
    assert_eq!(providers[0]["provider"], "amaze");
    assert!(providers[0]["available"].is_boolean());
}

#[tokio::test]
async fn get_providers_snapshot_returns_amaze_entry_with_valid_status() {
    let home = TempDir::new().unwrap();
    let d = build(&home);
    let env = envelope(json!({ "type": "get_providers_snapshot_request", "requestId": "p1" }));
    let out = d.dispatch_envelope(&env).await.unwrap();
    let m = &out["message"];
    assert_eq!(m["type"], "get_providers_snapshot_response");
    assert_eq!(m["payload"]["requestId"], "p1");
    assert!(m["payload"]["generatedAt"].is_string());
    let entries = m["payload"]["entries"].as_array().unwrap();
    let amaze = entries
        .iter()
        .find(|e| e["provider"] == "amaze")
        .expect("amaze entry present");
    let status = amaze["status"].as_str().unwrap();
    assert!(
        matches!(status, "ready" | "loading" | "error" | "unavailable"),
        "status `{status}` must be a valid ProviderStatus enum value"
    );
    assert_eq!(amaze["label"], "Amaze");
}

#[tokio::test]
async fn refresh_providers_snapshot_acknowledges() {
    let home = TempDir::new().unwrap();
    let d = build(&home);
    let env = envelope(json!({ "type": "refresh_providers_snapshot_request", "requestId": "r1" }));
    let out = d.dispatch_envelope(&env).await.unwrap();
    let m = &out["message"];
    assert_eq!(m["type"], "refresh_providers_snapshot_response");
    assert_eq!(m["payload"]["acknowledged"], true);
    assert_eq!(m["payload"]["requestId"], "r1");
}

#[tokio::test]
async fn list_available_providers_returns_availability() {
    let home = TempDir::new().unwrap();
    let d = build(&home);
    let env = envelope(json!({ "type": "list_available_providers_request", "requestId": "l1" }));
    let out = d.dispatch_envelope(&env).await.unwrap();
    let m = &out["message"];
    assert_eq!(m["type"], "list_available_providers_response");
    assert_eq!(m["payload"]["requestId"], "l1");
    assert!(m["payload"]["fetchedAt"].is_string());
    assert!(m["payload"]["error"].is_null());
    let providers = m["payload"]["providers"].as_array().unwrap();
    assert_eq!(providers[0]["provider"], "amaze");
}

#[tokio::test]
async fn client_heartbeat_returns_internal_ack() {
    let home = TempDir::new().unwrap();
    let d = build(&home);
    let env = envelope(json!({
        "type": "client_heartbeat",
        "deviceType": "web",
        "focusedAgentId": null,
        "lastActivityAt": "2026-06-11T00:00:00Z",
        "appVisible": true,
    }));
    let out = d.dispatch_envelope(&env).await.unwrap();
    assert_eq!(out["message"]["type"], "client_heartbeat_ack");
}

#[tokio::test]
async fn register_push_token_persists_and_acks() {
    let home = TempDir::new().unwrap();
    let d = build(&home);
    let env = envelope(json!({
        "type": "register_push_token",
        "token": "ExponentPushToken[abc]",
    }));
    let out = d.dispatch_envelope(&env).await.unwrap();
    let m = &out["message"];
    assert_eq!(m["type"], "register_push_token_ack");
    assert_eq!(m["payload"]["stored"], true);
    assert!(m["payload"]["error"].is_null());
    // Persisted to disk.
    let raw = std::fs::read_to_string(home.path().join("push-tokens.json")).unwrap();
    assert!(raw.contains("ExponentPushToken[abc]"));
}

#[tokio::test]
async fn register_push_token_empty_reports_not_stored() {
    let home = TempDir::new().unwrap();
    let d = build(&home);
    let env = envelope(json!({ "type": "register_push_token", "token": "  " }));
    let out = d.dispatch_envelope(&env).await.unwrap();
    let m = &out["message"];
    assert_eq!(m["payload"]["stored"], false);
    assert!(!m["payload"]["error"].is_null());
}

#[tokio::test]
async fn read_project_config_reads_existing_file() {
    let home = TempDir::new().unwrap();
    let repo = TempDir::new().unwrap();
    std::fs::create_dir_all(repo.path().join(".rocky")).unwrap();
    std::fs::write(
        repo.path().join(".rocky").join("config.json"),
        r#"{"foo":"bar"}"#,
    )
    .unwrap();
    let d = build(&home);
    let env = envelope(json!({
        "type": "read_project_config_request",
        "requestId": "rp1",
        "repoRoot": repo.path().to_string_lossy(),
    }));
    let out = d.dispatch_envelope(&env).await.unwrap();
    let m = &out["message"];
    assert_eq!(m["type"], "read_project_config_response");
    assert_eq!(m["payload"]["ok"], true);
    assert_eq!(m["payload"]["config"]["foo"], "bar");
}

#[tokio::test]
async fn read_project_config_missing_repo_root_is_structured_error() {
    let home = TempDir::new().unwrap();
    let d = build(&home);
    let env = envelope(json!({
        "type": "read_project_config_request",
        "requestId": "rp2",
        "repoRoot": "",
    }));
    let out = d.dispatch_envelope(&env).await.unwrap();
    let m = &out["message"];
    assert_eq!(m["payload"]["ok"], false);
    assert!(m["payload"]["error"]["message"].is_string());
}
