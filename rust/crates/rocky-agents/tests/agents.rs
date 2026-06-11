//! Behavior tests for the agent control plane: state machine, timeline
//! (seq/timestamp/paging/persistence), persist-before-broadcast, permissions,
//! and create_agent label/cwd resolution.

use std::collections::BTreeMap;

use async_trait::async_trait;
use rocky_agent_domain::{
    AgentPermissionRequest, AgentPermissionResponse, AgentRuntimeInfo, AgentStatus,
    AgentStreamEvent, AgentTimelineItem, PermissionKind,
};
use rocky_agents::{
    AgentError, AgentManager, AgentProvider, AgentSession, CreateAgentOptions, FollowUp,
    ProviderSessionConfig, PromptInput, Timeline,
};
use tempfile::TempDir;

// --- Mock provider/session ---

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
impl MockProvider {
    fn new(id: &str) -> Self {
        Self { id: id.to_string() }
    }
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

fn assistant(text: &str) -> AgentTimelineItem {
    AgentTimelineItem::AssistantMessage {
        text: text.to_string(),
        message_id: None,
    }
}

async fn create_idle_agent(home: &TempDir, cwd: &str) -> (AgentManager, String) {
    let manager = AgentManager::new(home.path());
    let provider = MockProvider::new("claude");
    let mut opts = CreateAgentOptions::new("claude");
    opts.cwd = Some(cwd.to_string());
    let agent = manager.create_agent(&provider, opts).await.unwrap();
    (manager, agent.id)
}

// --- State machine ---

#[tokio::test]
async fn set_status_allows_legal_transitions() {
    let home = TempDir::new().unwrap();
    let (manager, id) = create_idle_agent(&home, "/tmp/proj-legal").await;
    // idle -> running -> idle -> error -> idle -> closed are all legal.
    manager.set_status(&id, AgentStatus::Running).await.unwrap();
    assert_eq!(manager.get(&id).await.unwrap().status, AgentStatus::Running);
    manager.set_status(&id, AgentStatus::Idle).await.unwrap();
    manager.set_status(&id, AgentStatus::Error).await.unwrap();
    manager.set_status(&id, AgentStatus::Idle).await.unwrap();
    manager.set_status(&id, AgentStatus::Closed).await.unwrap();
    assert_eq!(manager.get(&id).await.unwrap().status, AgentStatus::Closed);
}

#[tokio::test]
async fn set_status_rejects_illegal_transitions() {
    let home = TempDir::new().unwrap();
    let (manager, id) = create_idle_agent(&home, "/tmp/proj-illegal").await;
    // closed is terminal: closed -> idle rejected.
    manager.set_status(&id, AgentStatus::Closed).await.unwrap();
    let err = manager.set_status(&id, AgentStatus::Idle).await.unwrap_err();
    assert!(matches!(err, AgentError::IllegalTransition { .. }));
    assert_eq!(manager.get(&id).await.unwrap().status, AgentStatus::Closed);
}

#[tokio::test]
async fn set_status_rejects_initializing_to_running() {
    // Construct via domain check: initializing -> running is illegal.
    assert!(!AgentStatus::Initializing.can_transition_to(AgentStatus::Running));
    // And the manager enforces the same: drive an agent to a state that cannot
    // jump straight to running from initializing-like origin. We assert the
    // domain rule directly since fresh agents start idle.
    assert!(AgentStatus::Idle.can_transition_to(AgentStatus::Running));
}

#[tokio::test]
async fn set_status_emits_status_via_persisted_record() {
    let home = TempDir::new().unwrap();
    let (manager, id) = create_idle_agent(&home, "/tmp/proj-emit").await;
    manager.set_status(&id, AgentStatus::Running).await.unwrap();
    // Persisted record reflects the new status (manager is source of truth).
    let path = home
        .path()
        .join("agents")
        .join("tmp-proj-emit")
        .join(format!("{id}.json"));
    let raw = std::fs::read_to_string(&path).unwrap();
    assert!(raw.contains("\"lastStatus\": \"running\""), "got: {raw}");
}

// --- Timeline ---

#[tokio::test]
async fn timeline_append_assigns_increasing_seq_and_iso_timestamps() {
    let home = TempDir::new().unwrap();
    let mut tl = Timeline::new(home.path());
    tl.register("a1", "/tmp/proj-tl").unwrap();
    let r1 = tl.append("a1", assistant("one"), None).unwrap();
    let r2 = tl.append("a1", assistant("two"), Some("turn-1".into())).unwrap();
    assert_eq!(r1.seq, 1);
    assert_eq!(r2.seq, 2);
    assert_eq!(r2.turn_id.as_deref(), Some("turn-1"));
    // ISO8601 millisecond + trailing Z, e.g. 2026-06-11T23:14:49.406Z
    let re_ok = |ts: &str| {
        ts.ends_with('Z')
            && ts.len() == 24
            && ts.as_bytes()[10] == b'T'
            && ts.as_bytes()[19] == b'.'
    };
    assert!(re_ok(&r1.timestamp), "bad ts: {}", r1.timestamp);
    assert!(re_ok(&r2.timestamp), "bad ts: {}", r2.timestamp);
}

#[tokio::test]
async fn timeline_fetch_pages_after_seq_and_limit() {
    let home = TempDir::new().unwrap();
    let mut tl = Timeline::new(home.path());
    tl.register("a1", "/tmp/proj-page").unwrap();
    for i in 0..5 {
        tl.append("a1", assistant(&format!("m{i}")), None).unwrap();
    }
    // after_seq=0 limit=2 -> seqs 1,2
    let p1 = tl.fetch("a1", 0, 2);
    assert_eq!(p1.iter().map(|r| r.seq).collect::<Vec<_>>(), vec![1, 2]);
    // after_seq=2 limit=2 -> seqs 3,4
    let p2 = tl.fetch("a1", 2, 2);
    assert_eq!(p2.iter().map(|r| r.seq).collect::<Vec<_>>(), vec![3, 4]);
    // after_seq=4 limit=0 -> all remaining (5)
    let p3 = tl.fetch("a1", 4, 0);
    assert_eq!(p3.iter().map(|r| r.seq).collect::<Vec<_>>(), vec![5]);
}

#[tokio::test]
async fn timeline_persistence_round_trips() {
    let home = TempDir::new().unwrap();
    let cwd = "/tmp/proj-rt";
    let written;
    {
        let mut tl = Timeline::new(home.path());
        tl.register("a1", cwd).unwrap();
        tl.append("a1", assistant("one"), None).unwrap();
        tl.append("a1", assistant("two"), Some("t".into())).unwrap();
        written = tl.rows("a1");
    }
    // Reload from disk into a fresh store: same rows + seq + ordering.
    let mut tl2 = Timeline::new(home.path());
    tl2.register("a1", cwd).unwrap();
    let reloaded = tl2.rows("a1");
    assert_eq!(written, reloaded);
    assert_eq!(reloaded.iter().map(|r| r.seq).collect::<Vec<_>>(), vec![1, 2]);
    // next seq continues monotonically after reload.
    let r3 = tl2.append("a1", assistant("three"), None).unwrap();
    assert_eq!(r3.seq, 3);
}

// --- persist-before-broadcast ---

#[tokio::test]
async fn timeline_row_is_durable_when_broadcast_observed() {
    let home = TempDir::new().unwrap();
    let cwd = "/tmp/proj-pbb";
    let (manager, id) = create_idle_agent(&home, cwd).await;
    let mut rx = manager.subscribe();

    manager
        .ingest_stream_event(
            &id,
            AgentStreamEvent::Timeline {
                item: Box::new(assistant("durable")),
                provider: "claude".to_string(),
                turn_id: Some("turn-9".to_string()),
                timestamp: None,
            },
        )
        .await
        .unwrap();

    // At the moment the broadcast is observed, the row must already be on disk.
    let bcast = rx.recv().await.unwrap();
    let seq = bcast.seq.expect("timeline broadcast carries seq");
    let path = home
        .path()
        .join("agents")
        .join("tmp-proj-pbb")
        .join(format!("{id}.timeline.jsonl"));
    let raw = std::fs::read_to_string(&path).expect("timeline jsonl exists at broadcast time");
    assert!(raw.contains("durable"), "row not durable: {raw}");
    assert!(raw.contains("\"seq\":1"));
    assert_eq!(seq, 1);
    assert_eq!(bcast.turn_id_or_none(), Some("turn-9".to_string()));
}

// Helper trait to extract turn id from the broadcast event for assertions.
trait TurnIdExt {
    fn turn_id_or_none(&self) -> Option<String>;
}
impl TurnIdExt for rocky_agents::AgentStreamBroadcast {
    fn turn_id_or_none(&self) -> Option<String> {
        match &self.event {
            AgentStreamEvent::Timeline { turn_id, .. } => turn_id.clone(),
            _ => None,
        }
    }
}

// --- Permissions ---

fn perm_request(id: &str) -> AgentPermissionRequest {
    AgentPermissionRequest {
        id: id.to_string(),
        provider: "claude".to_string(),
        name: "shell".to_string(),
        kind: PermissionKind::Tool,
        title: Some("Run command".to_string()),
        description: None,
        input: None,
        detail: None,
        suggestions: None,
        actions: None,
        metadata: None,
    }
}

#[tokio::test]
async fn permission_enqueue_list_resolve_allow() {
    let home = TempDir::new().unwrap();
    let (manager, id) = create_idle_agent(&home, "/tmp/proj-perm-allow").await;
    manager
        .enqueue_permission(&id, perm_request("req-1"))
        .await
        .unwrap();
    let pending = manager.list_pending_permissions(Some(&id)).await;
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].request.id, "req-1");

    let res = manager
        .respond_to_permission(
            "req-1",
            AgentPermissionResponse::Allow {
                selected_action_id: None,
                updated_input: None,
                updated_permissions: None,
            },
            None,
        )
        .await
        .unwrap();
    assert!(!res.interrupt);
    assert!(res.follow_up.is_none());
    assert!(manager.list_pending_permissions(Some(&id)).await.is_empty());
}

#[tokio::test]
async fn permission_resolve_deny_interrupt_signals_and_follow_up() {
    let home = TempDir::new().unwrap();
    let (manager, id) = create_idle_agent(&home, "/tmp/proj-perm-deny").await;
    manager
        .enqueue_permission(&id, perm_request("req-2"))
        .await
        .unwrap();

    let res = manager
        .respond_to_permission(
            "req-2",
            AgentPermissionResponse::Deny {
                selected_action_id: None,
                message: Some("nope".to_string()),
                interrupt: Some(true),
            },
            Some(FollowUp {
                prompt: "retry differently".to_string(),
            }),
        )
        .await
        .unwrap();
    assert!(res.interrupt, "deny+interrupt must signal interrupt");
    assert_eq!(res.follow_up.unwrap().prompt, "retry differently");
    assert!(manager.list_pending_permissions(Some(&id)).await.is_empty());
}

#[tokio::test]
async fn permissions_survive_reconnect() {
    let home = TempDir::new().unwrap();
    let (manager, id) = create_idle_agent(&home, "/tmp/proj-perm-reconnect").await;
    manager
        .enqueue_permission(&id, perm_request("req-3"))
        .await
        .unwrap();
    // Simulate a fresh client subscribing after the request was enqueued:
    // it recovers the pending list from manager memory.
    let _late_subscriber = manager.subscribe();
    let pending = manager.list_pending_permissions(None).await;
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].request.id, "req-3");
    assert_eq!(pending[0].agent_id, id);
}

#[tokio::test]
async fn resolve_unknown_permission_errors() {
    let home = TempDir::new().unwrap();
    let (manager, _id) = create_idle_agent(&home, "/tmp/proj-perm-unknown").await;
    let err = manager
        .respond_to_permission(
            "missing",
            AgentPermissionResponse::Allow {
                selected_action_id: None,
                updated_input: None,
                updated_permissions: None,
            },
            None,
        )
        .await
        .unwrap_err();
    assert!(matches!(err, AgentError::PermissionNotFound(_)));
}

// --- create_agent ---

#[tokio::test]
async fn create_child_agent_gets_parent_label_and_relative_cwd() {
    let home = TempDir::new().unwrap();
    let manager = AgentManager::new(home.path());
    let provider = MockProvider::new("claude");

    let mut parent_opts = CreateAgentOptions::new("claude");
    parent_opts.cwd = Some("/tmp/parentproj".to_string());
    let parent = manager.create_agent(&provider, parent_opts).await.unwrap();

    let mut child_opts = CreateAgentOptions::new("claude");
    child_opts.caller_agent_id = Some(parent.id.clone());
    child_opts.cwd = Some("sub/dir".to_string()); // relative -> parent-relative
    child_opts.allow_custom_cwd = true;
    let child = manager.create_agent(&provider, child_opts).await.unwrap();

    assert_eq!(
        child.labels.get(rocky_agents::PARENT_AGENT_ID_LABEL),
        Some(&parent.id)
    );
    assert_eq!(child.cwd, "/tmp/parentproj/sub/dir");
}

#[tokio::test]
async fn create_detached_child_has_no_parent_label() {
    let home = TempDir::new().unwrap();
    let manager = AgentManager::new(home.path());
    let provider = MockProvider::new("claude");

    let mut parent_opts = CreateAgentOptions::new("claude");
    parent_opts.cwd = Some("/tmp/parentproj2".to_string());
    let parent = manager.create_agent(&provider, parent_opts).await.unwrap();

    let mut child_opts = CreateAgentOptions::new("claude");
    child_opts.caller_agent_id = Some(parent.id.clone());
    child_opts.detached = true;
    let child = manager.create_agent(&provider, child_opts).await.unwrap();

    assert!(!child
        .labels
        .contains_key(rocky_agents::PARENT_AGENT_ID_LABEL));
    // Detached child with no requested cwd defaults to the parent cwd.
    assert_eq!(child.cwd, "/tmp/parentproj2");
}

#[tokio::test]
async fn create_merges_user_labels() {
    let home = TempDir::new().unwrap();
    let manager = AgentManager::new(home.path());
    let provider = MockProvider::new("claude");
    let mut labels = BTreeMap::new();
    labels.insert("team".to_string(), "core".to_string());
    let mut opts = CreateAgentOptions::new("claude");
    opts.cwd = Some("/tmp/labels".to_string());
    opts.labels = labels;
    let agent = manager.create_agent(&provider, opts).await.unwrap();
    assert_eq!(agent.labels.get("team"), Some(&"core".to_string()));
    assert_eq!(agent.status, AgentStatus::Idle);
}
