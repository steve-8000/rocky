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

use rocky_acp_provider::{AcpProvider, AmazeAcpProvider};
use rocky_agent_domain::{AgentStreamEvent, AgentTimelineItem};
use rocky_agents::{AgentManager, AgentProvider, CreateAgentOptions, PromptInput};
use tempfile::TempDir;

const REPO_ROOT: &str = "/Users/steve/roy/rocky";

fn amaze_command() -> Vec<String> {
    vec![
        "bun".to_string(),
        "__ROCKY_ROOT__/vendor/amaze/packages/coding-agent/src/cli.ts".to_string(),
        "acp".to_string(),
    ]
}

/// Serializes the live amaze ACP probes in this binary: each spawns a real
/// `bun ... acp` subprocess and shares the per-process discovery cache + the
/// daemon on :7767, so running them concurrently (e.g. `--ignored` runs both)
/// races. Hold this guard for the duration of a probe so only one runs at once.
static LIVE_PROBE_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "spawns bun + amaze ACP agent; run with --ignored"]
async fn amaze_bridge_creates_session_and_streams_events() {
    let _g = LIVE_PROBE_LOCK.lock().await;
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

/// Live discovery probe: `AmazeAcpProvider::list_models` / `list_modes` spin up
/// a short-lived ACP session, read the agent's advertised models/modes from the
/// `session/new` result, and shut the child down. Asserts real amaze data and
/// that the probe completes (no leaked/hung child).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "spawns bun + amaze ACP agent; run with --ignored"]
async fn amaze_provider_probes_models_and_modes() {
    let _g = LIVE_PROBE_LOCK.lock().await;
    let provider = AmazeAcpProvider::new(REPO_ROOT);

    let models = provider
        .list_models(REPO_ROOT)
        .await
        .expect("list_models probe should succeed (is `bun` on PATH?)");
    assert!(!models.is_empty(), "amaze should advertise at least one model");
    assert!(
        models.iter().all(|m| m.provider == "amaze"),
        "every model should be tagged with the provider id"
    );
    assert!(
        models
            .iter()
            .any(|m| m.id.contains("claude") || m.id.contains("anthropic")),
        "expected an anthropic/claude model id, got: {:?}",
        models.iter().map(|m| &m.id).collect::<Vec<_>>()
    );

    let modes = provider
        .list_modes(REPO_ROOT)
        .await
        .expect("list_modes probe should succeed");
    assert!(
        modes.iter().any(|m| m.id == "default"),
        "expected a `default` mode, got: {:?}",
        modes.iter().map(|m| &m.id).collect::<Vec<_>>()
    );
    assert!(
        modes.iter().any(|m| m.id == "plan"),
        "expected a `plan` mode, got: {:?}",
        modes.iter().map(|m| &m.id).collect::<Vec<_>>()
    );
    // The session layer appends a synthetic Rocky `bypass` mode.
    assert!(
        modes.iter().any(|m| m.id == "bypass"),
        "expected the synthetic `bypass` mode"
    );

    // features: amaze exposes none over ACP.
    let features = provider.list_features(REPO_ROOT).await.expect("list_features");
    assert!(features.is_empty());

    eprintln!(
        "live amaze probe: {} models, {} modes",
        models.len(),
        modes.len()
    );
}
