//! Live bridge integration test: drive a real amaze ACP agent through the
//! `AcpProvider` + `AgentManager` and assert that session events flow back to
//! the manager's broadcast stream.
//!
//! Gated `#[ignore]` because it spawns `bun` and the amaze coding-agent CLI,
//! which may be absent or network/auth-blocked in some environments. RUN it
//! with `cargo test -p rocky-acp-provider -- --ignored`.
//!
//! Acceptance: session creation succeeds and a `thread_started` event reaches
//! the manager. If a full turn completes (network/auth permitting), an
//! assistant `Timeline` event is also observed. The full-turn assertion is
//! best-effort: when the turn is network-gated, the test still passes on the
//! session-creation + thread_started evidence and logs that the turn did not
//! complete.

use std::collections::HashMap;
use std::time::Duration;

use rocky_acp_provider::AcpProvider;
use rocky_agent_domain::{AgentStreamEvent, AgentTimelineItem};
use rocky_agents::{AgentManager, CreateAgentOptions, PromptInput};
use tempfile::TempDir;

const REPO_ROOT: &str = "/Users/steve/roy/rocky";

fn amaze_command() -> Vec<String> {
    vec![
        "bun".to_string(),
        "__ROCKY_ROOT__/vendor/amaze/packages/coding-agent/src/cli.ts".to_string(),
        "acp".to_string(),
    ]
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "spawns bun + amaze ACP agent; run with --ignored"]
async fn amaze_bridge_creates_session_and_streams_events() {
    let home = TempDir::new().unwrap();
    let manager = AgentManager::new(home.path());
    let provider = AcpProvider::new(
        "amaze",
        amaze_command(),
        REPO_ROOT,
        HashMap::new(),
    );

    // Subscribe BEFORE creating the agent so we capture thread_started, which is
    // emitted during session connect and pumped through the manager.
    let mut events = manager.subscribe();

    let mut opts = CreateAgentOptions::new("amaze");
    opts.cwd = Some(REPO_ROOT.to_string());
    // Autonomous approval so a real turn does not block on a permission prompt.
    opts.approval_policy = Some("bypass".to_string());

    let agent = manager
        .create_agent(&provider, opts)
        .await
        .expect("amaze ACP session should be created (is `bun` on PATH?)");
    assert_eq!(agent.provider, "amaze");
    assert!(
        agent.runtime_info.and_then(|r| r.session_id).is_some(),
        "session should have an ACP session id"
    );

    // 1. Assert thread_started reaches the manager broadcast.
    let mut saw_thread_started = false;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    while tokio::time::Instant::now() < deadline {
        match tokio::time::timeout(Duration::from_secs(5), events.recv()).await {
            Ok(Ok(envelope)) => {
                if matches!(envelope.event, AgentStreamEvent::ThreadStarted { .. }) {
                    saw_thread_started = true;
                    break;
                }
            }
            Ok(Err(_)) => break, // channel closed
            Err(_) => break,     // timed out
        }
    }
    assert!(
        saw_thread_started,
        "thread_started should arrive through the manager"
    );

    // 2. Prompt and look for an assistant timeline event. Best-effort: a
    //    network/auth-gated turn may never produce assistant text, in which case
    //    the test still passes on session creation + thread_started above.
    manager
        .prompt(&agent.id, PromptInput { text: "reply OK".to_string(), message_id: None })
        .await
        .expect("prompt should dispatch");

    let mut saw_assistant = false;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(45);
    while tokio::time::Instant::now() < deadline {
        match tokio::time::timeout(Duration::from_secs(10), events.recv()).await {
            Ok(Ok(envelope)) => {
                if let AgentStreamEvent::Timeline { item, .. } = &envelope.event {
                    if matches!(**item, AgentTimelineItem::AssistantMessage { .. }) {
                        saw_assistant = true;
                        break;
                    }
                }
                // A terminal turn event also ends the wait.
                if matches!(
                    envelope.event,
                    AgentStreamEvent::TurnCompleted { .. }
                        | AgentStreamEvent::TurnFailed { .. }
                        | AgentStreamEvent::TurnCanceled { .. }
                ) {
                    break;
                }
            }
            Ok(Err(_)) => break,
            Err(_) => break,
        }
    }

    if !saw_assistant {
        eprintln!(
            "NOTE: no assistant timeline event observed — turn was likely network/auth-gated; \
             session creation + thread_started verified the bridge wiring."
        );
    }

    manager.close(&agent.id).await.expect("close should succeed");
}
