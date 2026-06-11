//! Live integration test against the vendored amaze ACP agent.
//!
//! Gated with `#[ignore]` because it requires `bun` and the vendored amaze
//! sources to be present (and, for a full prompt turn, provider credentials
//! under `~/.amaze`). Run with:
//!
//! ```sh
//! cargo test -p rocky-acp --test live_acp -- --ignored --nocapture
//! ```
//!
//! Verified method/param shapes captured from the live agent
//! (`bun vendor/amaze/packages/coding-agent/src/cli.ts acp`):
//! - `initialize` -> `{ protocolVersion: 1, agentInfo, agentCapabilities, ... }`
//! - `session/new` -> `{ sessionId, configOptions: [{ id: "mode", ... }], ... }`
//! - `session/prompt` -> `{ stopReason: "end_turn", usage, userMessageId }`
//! - inbound `session/update` with `update.sessionUpdate == "agent_message_chunk"`

use std::path::PathBuf;
use std::time::Duration;

use rocky_acp::{AcpSession, ProcessSpec, SessionConfig, SessionInit};
use rocky_agent_domain::{AgentStreamEvent, AgentTimelineItem};

/// Resolve the rocky repo root (parent of the `rust/` workspace).
fn repo_root() -> PathBuf {
    // CARGO_MANIFEST_DIR = <root>/rust/crates/rocky-acp
    // ancestors: [0]=rocky-acp [1]=crates [2]=rust [3]=<root>
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    manifest
        .ancestors()
        .nth(3)
        .expect("manifest has rust/crates/rocky-acp ancestors")
        .to_path_buf()
}

fn amaze_cli_present(root: &std::path::Path) -> bool {
    root.join("vendor/amaze/packages/coding-agent/src/cli.ts")
        .exists()
}

#[tokio::test]
#[ignore = "requires bun + vendored amaze ACP agent (and provider creds for a full turn)"]
async fn live_initialize_session_and_prompt() {
    let root = repo_root();
    if !amaze_cli_present(&root) {
        eprintln!("skipping: vendored amaze ACP cli not found under {root:?}");
        return;
    }
    let root_str = root.to_string_lossy().to_string();

    let spec = ProcessSpec::new(
        vec![
            "bun".to_string(),
            "__ROCKY_ROOT__/vendor/amaze/packages/coding-agent/src/cli.ts".to_string(),
            "acp".to_string(),
        ],
        root_str.clone(),
        root_str,
    );

    let config = SessionConfig {
        process: spec,
        init: SessionInit::New,
        mcp_servers: vec![],
        approval_policy: None,
    };

    // initialize + session/new must succeed (no network/creds needed).
    let session = tokio::time::timeout(Duration::from_secs(30), AcpSession::connect(config))
        .await
        .expect("connect timed out")
        .expect("initialize + session/new should succeed");

    assert!(
        !session.session_id().is_empty(),
        "session/new returned a sessionId"
    );
    eprintln!("LIVE sessionId = {}", session.session_id());
    eprintln!(
        "LIVE available modes = {:?}",
        session.available_modes().iter().map(|m| &m.id).collect::<Vec<_>>()
    );

    let mut events = session.take_events().expect("event receiver available");

    // Send a trivial prompt. If the provider lacks credentials/network this
    // turn fails; we still asserted initialize + session/new above.
    let prompt_result = tokio::time::timeout(
        Duration::from_secs(120),
        session.prompt("reply with the single word OK and do nothing else"),
    )
    .await;

    let mut saw_assistant_message = false;
    let mut saw_terminal = false;

    // Drain whatever lifecycle/timeline events were produced.
    while let Ok(Some(event)) =
        tokio::time::timeout(Duration::from_secs(2), events.recv()).await
    {
        match &event {
            AgentStreamEvent::Timeline { item, .. } => {
                if matches!(**item, AgentTimelineItem::AssistantMessage { .. }) {
                    saw_assistant_message = true;
                }
            }
            AgentStreamEvent::TurnCompleted { .. }
            | AgentStreamEvent::TurnFailed { .. }
            | AgentStreamEvent::TurnCanceled { .. } => {
                saw_terminal = true;
            }
            _ => {}
        }
    }

    match prompt_result {
        Ok(Ok(stop_reason)) => {
            eprintln!("LIVE stopReason = {stop_reason}");
            assert!(saw_terminal, "expected a terminal turn event");
            assert!(
                saw_assistant_message,
                "expected at least one assistant message timeline event"
            );
        }
        Ok(Err(err)) => {
            // Provider unavailable (e.g. missing creds/network): document it.
            eprintln!(
                "LIVE prompt failed (likely missing provider creds/network): {err}. \
                 initialize + session/new succeeded, which is the minimum assertion."
            );
        }
        Err(_) => {
            eprintln!(
                "LIVE prompt timed out (likely network-bound provider). \
                 initialize + session/new succeeded."
            );
        }
    }

    session.shutdown().await;
}
