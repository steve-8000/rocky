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

/// Serializes the live amaze ACP probes below: each `build_live()` dispatch
/// spawns a short-lived `bun ... acp` subprocess and shares a per-process
/// discovery cache + the daemon on :7767, so running them concurrently (the
/// default `cargo test` parallelism) races. Hold this guard for the duration of
/// a probe so only one subprocess runs at a time.
static LIVE_PROBE_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Run a live discovery dispatch under `LIVE_PROBE_LOCK`, retrying up to 4 times
/// with a small backoff until `ok(payload)` holds, so transient probe contention
/// self-heals. Returns the final `message` object (with `type` + `payload`).
///
/// The daemon memoizes discovery per `provider+cwd` in a process-static cache
/// with a 60s TTL, so a single transient empty-but-`Ok` probe (a cold-start
/// `session/new` race that yields no advertised models/modes) would otherwise
/// poison every live test for the whole run. Before each attempt we dispatch
/// `refresh_providers_snapshot_request`, whose handler clears that cache, so a
/// retry actually spawns a fresh probe instead of re-reading the poisoned entry.
async fn live_probe<F>(req: Value, ok: F) -> Value
where
    F: Fn(&Value) -> bool,
{
    let _g = LIVE_PROBE_LOCK.lock().await;
    let mut last = Value::Null;
    for attempt in 0..4u32 {
        let d = build_live();
        // Bust the process-static discovery cache so this attempt re-probes the
        // live agent rather than returning a possibly-poisoned cached result.
        let _ = d
            .dispatch_envelope(&envelope(json!({
                "type": "refresh_providers_snapshot_request",
                "requestId": "live-probe-refresh",
            })))
            .await
            .unwrap();
        let out = d.dispatch_envelope(&envelope(req.clone())).await.unwrap();
        last = out["message"].clone();
        if ok(&last["payload"]) {
            return last;
        }
        tokio::time::sleep(std::time::Duration::from_millis(300 * u64::from(attempt + 1)))
            .await;
    }
    last
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

// ---------------------------------------------------------------------------
// Per-provider discovery RPCs (models / modes / features) + snapshot catalog
// ---------------------------------------------------------------------------

/// A mock provider returning fixed models/modes without spawning a subprocess,
/// so the response-shape tests run without `bun`.
struct MockProvider;

#[async_trait]
impl AgentProvider for MockProvider {
    fn id(&self) -> &str {
        "amaze"
    }
    async fn create_session(
        &self,
        _config: ProviderSessionConfig,
    ) -> Result<Box<dyn AgentSession>, AgentError> {
        Err(AgentError::Provider("not used".to_string()))
    }
    async fn list_models(
        &self,
        _cwd: &str,
    ) -> Result<Vec<rocky_agents::AgentModelDef>, AgentError> {
        Ok(vec![rocky_agents::AgentModelDef {
            provider: "amaze".to_string(),
            id: "anthropic/claude-sonnet".to_string(),
            label: "Claude Sonnet".to_string(),
            description: Some("mock".to_string()),
            thinking_options: vec![
                rocky_agents::AgentSelectOption {
                    id: "off".to_string(),
                    label: "Off".to_string(),
                    description: None,
                    is_default: false,
                },
                rocky_agents::AgentSelectOption {
                    id: "high".to_string(),
                    label: "high".to_string(),
                    description: None,
                    is_default: true,
                },
            ],
            default_thinking_option_id: Some("high".to_string()),
        }])
    }
    async fn list_modes(
        &self,
        _cwd: &str,
    ) -> Result<Vec<rocky_agent_domain::AgentMode>, AgentError> {
        Ok(vec![
            rocky_agent_domain::AgentMode {
                id: "default".to_string(),
                label: "Default".to_string(),
                description: None,
            },
            rocky_agent_domain::AgentMode {
                id: "plan".to_string(),
                label: "Plan".to_string(),
                description: Some("planning".to_string()),
            },
        ])
    }
}

fn build_with(home: &TempDir, provider: Arc<dyn AgentProvider>) -> SessionDispatcher {
    let ctx = DaemonReadContext {
        server_id: "srv-test".to_string(),
        version: Some("0.1.0".to_string()),
        listen: Some("127.0.0.1:7767".to_string()),
        pid: 4242,
        node_path: "/usr/bin/rockyd".to_string(),
        started_at: Some("2026-06-11T00:00:00Z".to_string()),
        rocky_home: home.path().to_path_buf(),
        repo_root: REPO_ROOT.to_string(),
        provider,
    };
    let mut d = SessionDispatcher::new();
    handlers::daemon_read::register(&mut d, ctx);
    d
}

#[tokio::test]
async fn list_provider_models_mock_response_shape() {
    let home = TempDir::new().unwrap();
    let d = build_with(&home, Arc::new(MockProvider));
    // Unique cwd avoids the process-wide discovery cache colliding with the
    // live tests (keyed by provider+cwd).
    let env = envelope(json!({
        "type": "list_provider_models_request",
        "provider": "amaze",
        "cwd": "/tmp/mock-models-cwd",
        "requestId": "lm-mock",
    }));
    let out = d.dispatch_envelope(&env).await.unwrap();
    let m = &out["message"];
    assert_eq!(m["type"], "list_provider_models_response");
    let p = &m["payload"];
    assert_eq!(p["provider"], "amaze");
    assert_eq!(p["requestId"], "lm-mock");
    assert!(p["fetchedAt"].is_string());
    assert!(p["error"].is_null());
    let models = p["models"].as_array().unwrap();
    assert_eq!(models.len(), 1);
    assert_eq!(models[0]["id"], "anthropic/claude-sonnet");
    assert_eq!(models[0]["label"], "Claude Sonnet");
    assert_eq!(models[0]["description"], "mock");
    // Top-level model `isDefault` is not owned by the daemon and must NOT be
    // fabricated.
    assert!(models[0].get("isDefault").is_none());
    // Per-model thinking options ARE surfaced (mirrors TS
    // `deriveModelDefinitionsFromACP`): the WebUI needs them to render the
    // thinking picker. Verify the camelCase wire shape and the default flag.
    let thinking = models[0]["thinkingOptions"].as_array().unwrap();
    assert_eq!(thinking.len(), 2);
    assert_eq!(thinking[0]["id"], "off");
    assert!(thinking[0].get("isDefault").is_none());
    assert_eq!(thinking[1]["id"], "high");
    assert_eq!(thinking[1]["isDefault"], true);
    assert_eq!(models[0]["defaultThinkingOptionId"], "high");
}

#[tokio::test]
async fn list_provider_modes_mock_response_shape() {
    let home = TempDir::new().unwrap();
    let d = build_with(&home, Arc::new(MockProvider));
    let env = envelope(json!({
        "type": "list_provider_modes_request",
        "provider": "amaze",
        "cwd": "/tmp/mock-modes-cwd",
        "requestId": "lmo-mock",
    }));
    let out = d.dispatch_envelope(&env).await.unwrap();
    let m = &out["message"];
    assert_eq!(m["type"], "list_provider_modes_response");
    let p = &m["payload"];
    assert_eq!(p["provider"], "amaze");
    assert_eq!(p["requestId"], "lmo-mock");
    assert!(p["fetchedAt"].is_string());
    assert!(p["error"].is_null());
    let modes = p["modes"].as_array().unwrap();
    assert_eq!(modes.len(), 2);
    assert_eq!(modes[0]["id"], "default");
    assert_eq!(modes[1]["id"], "plan");
    // description omitted when None (serde skip_serializing_if).
    assert!(modes[0].get("description").is_none());
}

#[tokio::test]
async fn list_provider_features_mock_is_empty_no_error() {
    let home = TempDir::new().unwrap();
    let d = build_with(&home, Arc::new(MockProvider));
    let env = envelope(json!({
        "type": "list_provider_features_request",
        "provider": "amaze",
        "cwd": "/tmp/mock-features-cwd",
        "requestId": "lf-mock",
    }));
    let out = d.dispatch_envelope(&env).await.unwrap();
    let m = &out["message"];
    assert_eq!(m["type"], "list_provider_features_response");
    let p = &m["payload"];
    assert_eq!(p["provider"], "amaze");
    assert_eq!(p["requestId"], "lf-mock");
    assert!(p["fetchedAt"].is_string());
    assert!(p["error"].is_null());
    assert_eq!(p["features"], json!([]));
}

/// Build a dispatcher around the real `AmazeAcpProvider` rooted at the rocky
/// repo. Live tests probe the agent over ACP (spawns `bun`).
fn build_live() -> SessionDispatcher {
    let home = TempDir::new().unwrap();
    let provider: Arc<dyn AgentProvider> =
        Arc::new(rocky_acp_provider::AmazeAcpProvider::new(REPO_ROOT));
    // Keep `home` alive for the dispatcher's lifetime by leaking it; the test
    // process is short-lived.
    std::mem::forget(home);
    let ctx = DaemonReadContext {
        server_id: "srv-live".to_string(),
        version: Some("0.1.0".to_string()),
        listen: Some("127.0.0.1:7767".to_string()),
        pid: std::process::id(),
        node_path: "/usr/bin/rockyd".to_string(),
        started_at: Some("2026-06-11T00:00:00Z".to_string()),
        rocky_home: std::env::temp_dir(),
        repo_root: REPO_ROOT.to_string(),
        provider,
    };
    let mut d = SessionDispatcher::new();
    handlers::daemon_read::register(&mut d, ctx);
    d
}

#[tokio::test]
async fn list_provider_models_live_returns_claude_model() {
    let has_claude = |p: &Value| {
        p["error"].is_null()
            && p["models"].as_array().is_some_and(|models| {
                !models.is_empty()
                    && models
                        .iter()
                        .any(|m| m["id"].as_str().is_some_and(|s| s.contains("claude")))
            })
    };
    let msg = live_probe(
        json!({
            "type": "list_provider_models_request",
            "provider": "amaze",
            "requestId": "lm-live",
        }),
        has_claude,
    )
    .await;
    let p = &msg["payload"];
    assert_eq!(msg["type"], "list_provider_models_response");
    assert!(p["error"].is_null(), "live probe errored: {:?}", p["error"]);
    let models = p["models"].as_array().unwrap();
    assert!(!models.is_empty(), "expected non-empty models");
    assert!(
        models
            .iter()
            .any(|m| m["id"].as_str().is_some_and(|s| s.contains("claude"))),
        "expected an anthropic/claude model id"
    );
    // Live amaze advertises a `thought_level` selector (off/minimal/low/medium/
    // high/xhigh); every model must carry it so the WebUI thinking picker works.
    let thinking = models[0]["thinkingOptions"]
        .as_array()
        .expect("live model should carry thinkingOptions");
    assert!(
        thinking.len() > 1,
        "expected multiple thinking options, got {}",
        thinking.len()
    );
    assert!(
        models[0].get("defaultThinkingOptionId").is_some(),
        "expected a defaultThinkingOptionId"
    );
}

#[tokio::test]
async fn list_provider_modes_live_returns_default_plan_bypass() {
    let has_modes = |p: &Value| {
        p["error"].is_null()
            && p["modes"].as_array().is_some_and(|modes| {
                let ids: Vec<&str> = modes.iter().filter_map(|m| m["id"].as_str()).collect();
                ["default", "plan", "bypass"].iter().all(|w| ids.contains(w))
            })
    };
    let msg = live_probe(
        json!({
            "type": "list_provider_modes_request",
            "provider": "amaze",
            "requestId": "lmo-live",
        }),
        has_modes,
    )
    .await;
    let p = &msg["payload"];
    assert!(p["error"].is_null(), "live probe errored: {:?}", p["error"]);
    let modes = p["modes"].as_array().unwrap();
    let ids: Vec<&str> = modes.iter().filter_map(|m| m["id"].as_str()).collect();
    for want in ["default", "plan", "bypass"] {
        assert!(ids.contains(&want), "expected mode `{want}` in {ids:?}");
    }
}

#[tokio::test]
async fn list_provider_features_live_is_empty() {
    let msg = live_probe(
        json!({
            "type": "list_provider_features_request",
            "provider": "amaze",
            "requestId": "lf-live",
        }),
        |p| p["error"].is_null(),
    )
    .await;
    let p = &msg["payload"];
    assert!(p["error"].is_null());
    assert_eq!(p["features"], json!([]));
}

#[tokio::test]
async fn providers_snapshot_live_amaze_has_models_and_modes() {
    let amaze_ready = |p: &Value| {
        p["entries"].as_array().is_some_and(|entries| {
            entries.iter().any(|e| {
                e["provider"] == "amaze"
                    && e["status"] == "ready"
                    && e["models"].as_array().is_some_and(|m| !m.is_empty())
                    && e["modes"].as_array().is_some_and(|m| !m.is_empty())
                    && e["defaultModeId"].is_string()
            })
        })
    };
    let msg = live_probe(
        json!({
            "type": "get_providers_snapshot_request",
            "requestId": "snap-live",
        }),
        amaze_ready,
    )
    .await;
    let entries = msg["payload"]["entries"].as_array().unwrap();
    let amaze = entries
        .iter()
        .find(|e| e["provider"] == "amaze")
        .expect("amaze entry present");
    assert_eq!(amaze["status"], "ready", "entry: {amaze}");
    assert!(
        !amaze["models"].as_array().unwrap().is_empty(),
        "expected non-empty models"
    );
    let modes = amaze["modes"].as_array().unwrap();
    assert!(!modes.is_empty(), "expected non-empty modes");
    assert!(amaze["defaultModeId"].is_string());
}
