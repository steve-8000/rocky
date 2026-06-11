//! Live agent integration test: drive create_agent_request + send through the
//! session dispatcher with a real `AmazeAcpProvider` over a temp `$ROCKY_HOME`.
//!
//! Gated `#[ignore]` because it spawns `bun` and the amaze coding-agent CLI,
//! which may be absent or network/auth-blocked. RUN with
//! `cargo test -p rocky-ws-session --test agent_live_session -- --ignored`.
//!
//! Acceptance (best-effort per network/auth): create_agent_request returns a
//! `status` `agent_created` with an agent id, the agent exists in the manager,
//! and send_agent_message_request returns `accepted:true`. A full assistant
//! turn requires network; the test asserts creation + accepted send and
//! best-effort observes timeline growth.

use std::sync::Arc;
use std::time::Duration;

use rocky_acp_provider::AmazeAcpProvider;
use rocky_agents::{AgentManager, AgentProvider};
use rocky_ws_session::{handlers, SessionDispatcher};
use serde_json::{json, Value};
use tempfile::TempDir;

const REPO_ROOT: &str = "/Users/steve/roy/rocky";

fn envelope(inner: Value) -> Value {
    json!({ "type": "session", "message": inner })
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "spawns bun + amaze ACP agent; run with --ignored"]
async fn create_and_send_through_live_amaze_provider() {
    let home = TempDir::new().unwrap();
    let manager = Arc::new(AgentManager::new(home.path()));
    let provider: Arc<dyn AgentProvider> = Arc::new(AmazeAcpProvider::new(REPO_ROOT));

    let mut d = SessionDispatcher::new();
    handlers::agent::register(&mut d, manager.clone(), provider);

    let env = envelope(json!({
        "type": "create_agent_request",
        "requestId": "live-cr1",
        "config": {
            "provider": "amaze",
            "cwd": REPO_ROOT,
            "approvalPolicy": "bypass",
        },
        "labels": {},
    }));
    let out = d.dispatch_envelope(&env).await.unwrap();
    let m = &out["message"];
    assert_eq!(m["type"], "status", "unexpected create response: {m}");
    assert_eq!(
        m["payload"]["status"], "agent_created",
        "agent creation failed (is `bun` on PATH?): {m}"
    );
    let agent_id = m["payload"]["agentId"].as_str().unwrap().to_string();
    assert!(!agent_id.is_empty());
    assert!(manager.get(&agent_id).await.is_some());

    let env = envelope(json!({
        "type": "send_agent_message_request",
        "requestId": "live-sm1",
        "agentId": agent_id.clone(),
        "text": "reply OK",
    }));
    let out = d.dispatch_envelope(&env).await.unwrap();
    let m = &out["message"];
    assert_eq!(m["type"], "send_agent_message_response");
    assert_eq!(m["payload"]["accepted"], true, "send rejected: {m}");

    // Best-effort: a real turn may grow the timeline (network/auth permitting).
    tokio::time::sleep(Duration::from_secs(3)).await;
    let rows = manager.fetch_timeline(&agent_id, 0, 0).await;
    eprintln!("live amaze timeline rows after send: {}", rows.len());
}
