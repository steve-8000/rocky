//! ACP-backed [`rocky_agents::AgentProvider`] — the glue connecting the
//! [`rocky_acp`] stdio transport to the [`rocky_agents::AgentManager`].
//!
//! The manager only ever talks to the [`AgentProvider`] / [`AgentSession`]
//! traits; it never spawns processes itself. This crate implements those traits
//! by driving a [`rocky_acp::AcpSession`]:
//!
//! - [`AcpProvider`] builds a [`rocky_acp::SessionConfig`] from the manager's
//!   [`ProviderSessionConfig`] (a [`ProcessSpec`] from the configured command —
//!   with `__ROCKY_ROOT__` expansion against the repo root — plus cwd, env, and
//!   approval policy) and `connect`s an [`AcpSession`], returning a boxed
//!   [`AgentSession`] adapter.
//! - [`AcpAgentSession`] maps the rocky-agents trait calls (prompt / cancel /
//!   close / runtime_info / subscribe_events) onto the [`AcpSession`]
//!   (prompt / cancel / shutdown / session_id / take_events). The session's
//!   `mpsc` event receiver is bridged onto a `broadcast` channel so the
//!   manager's pump (`AgentManager::create_agent`) can ingest the stream into
//!   its timeline pipeline.
//!
//! `AmazeAcpProvider` is a thin convenience constructor preset to launch the
//! amaze coding agent (`bun __ROCKY_ROOT__/vendor/amaze/packages/coding-agent/src/cli.ts acp`).

use std::collections::HashMap;
use std::sync::Mutex as StdMutex;
use std::sync::Arc;

use async_trait::async_trait;
use rocky_acp::process::{expand_rocky_root, ProcessSpec};
use rocky_acp::session::{AcpSession, SessionConfig, SessionInit};
use rocky_agent_domain::{AgentMode, AgentRuntimeInfo, AgentStreamEvent};
use rocky_agents::{
    AgentError, AgentModelDef, AgentProvider, AgentSession, PromptInput, ProviderSessionConfig,
};
use tokio::sync::{broadcast, mpsc};

/// Broadcast capacity for the per-session event fan-out. Matches the manager's
/// broadcast capacity so a slow pump does not lag behind a chatty turn.
const EVENT_BROADCAST_CAPACITY: usize = 1024;

/// Upper bound on a short-lived discovery probe (`session/new` to read the
/// agent's advertised models/modes). A hung agent must not block the WebUI's
/// `list_provider_models/modes` RPCs indefinitely.
const PROBE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);

/// The default amaze coding-agent ACP command. `__ROCKY_ROOT__` is expanded to
/// the configured repo root at spawn time (mirrors `scripts/setup.sh`).
pub fn amaze_acp_command() -> Vec<String> {
    vec![
        "bun".to_string(),
        "__ROCKY_ROOT__/vendor/amaze/packages/coding-agent/src/cli.ts".to_string(),
        "acp".to_string(),
    ]
}

/// An [`AgentProvider`] that drives [`rocky_acp::AcpSession`] subprocesses.
pub struct AcpProvider {
    id: String,
    command: Vec<String>,
    repo_root: String,
    env: HashMap<String, String>,
    mcp_servers: Vec<serde_json::Value>,
}

impl AcpProvider {
    /// Build a provider from an explicit command, repo root, and env overlay.
    pub fn new(
        id: impl Into<String>,
        command: Vec<String>,
        repo_root: impl Into<String>,
        env: HashMap<String, String>,
    ) -> Self {
        Self {
            id: id.into(),
            command,
            repo_root: repo_root.into(),
            env,
            mcp_servers: Vec::new(),
        }
    }

    /// Advertise MCP servers to the agent (passed verbatim into `session/new`).
    pub fn with_mcp_servers(mut self, servers: Vec<serde_json::Value>) -> Self {
        self.mcp_servers = servers;
        self
    }

    /// Short-lived discovery probe: spawn an ACP session via `session/new`,
    /// invoke `read` against the live [`AcpSession`], then shut the child down
    /// (best-effort, so no process leaks). Wrapped in [`PROBE_TIMEOUT`] so a
    /// hung agent surfaces an error rather than blocking the caller forever.
    async fn probe<T, F>(&self, cwd: &str, read: F) -> Result<T, AgentError>
    where
        F: FnOnce(&AcpSession) -> T,
    {
        // `create_session` passes cwd straight into the ProcessSpec; mirror that
        // here but also expand `__ROCKY_ROOT__` so callers may pass the token.
        let cwd = expand_rocky_root(cwd, &self.repo_root);
        let mut process = ProcessSpec::new(self.command.clone(), self.repo_root.clone(), cwd);
        process.env = self.env.clone();
        let session_config = SessionConfig {
            process,
            init: SessionInit::New,
            mcp_servers: self.mcp_servers.clone(),
            approval_policy: None,
        };

        let result = tokio::time::timeout(PROBE_TIMEOUT, async {
            let session = AcpSession::connect(session_config)
                .await
                .map_err(|e| AgentError::Provider(e.to_string()))?;
            let value = read(&session);
            // Best-effort shutdown: close stdin, SIGTERM, wait, SIGKILL. Ensures
            // the probed child does not leak.
            session.shutdown().await;
            Ok::<T, AgentError>(value)
        })
        .await;

        match result {
            Ok(inner) => inner,
            Err(_) => Err(AgentError::Provider(format!(
                "ACP discovery probe timed out after {}s",
                PROBE_TIMEOUT.as_secs()
            ))),
        }
    }
}

/// Convenience alias preset to launch the amaze coding agent over ACP.
pub struct AmazeAcpProvider;

impl AmazeAcpProvider {
    /// Build an [`AcpProvider`] (id `amaze`) rooted at `repo_root`, launching
    /// the amaze coding-agent ACP CLI via `bun`.
    #[allow(clippy::new_ret_no_self)]
    pub fn new(repo_root: impl Into<String>) -> AcpProvider {
        AcpProvider::new("amaze", amaze_acp_command(), repo_root, HashMap::new())
    }
}

#[async_trait]
impl AgentProvider for AcpProvider {
    fn id(&self) -> &str {
        &self.id
    }

    async fn create_session(
        &self,
        config: ProviderSessionConfig,
    ) -> Result<Box<dyn AgentSession>, AgentError> {
        let mut process = ProcessSpec::new(self.command.clone(), self.repo_root.clone(), config.cwd.clone());
        process.env = self.env.clone();

        let session_config = SessionConfig {
            process,
            init: SessionInit::New,
            mcp_servers: self.mcp_servers.clone(),
            approval_policy: config.approval_policy.clone(),
        };

        let session = AcpSession::connect(session_config)
            .await
            .map_err(|e| AgentError::Provider(e.to_string()))?;

        Ok(Box::new(AcpAgentSession::new(session, &config)))
    }

    async fn list_models(&self, cwd: &str) -> Result<Vec<AgentModelDef>, AgentError> {
        let id = self.id.clone();
        self.probe(cwd, move |session| {
            session
                .available_models()
                .iter()
                .map(|m| AgentModelDef {
                    provider: id.clone(),
                    id: m.id.clone(),
                    label: m.label.clone(),
                    description: m.description.clone(),
                })
                .collect()
        })
        .await
    }

    async fn list_modes(&self, cwd: &str) -> Result<Vec<AgentMode>, AgentError> {
        // `AcpSession::available_modes` already returns domain `AgentMode`s
        // (including the synthetic Rocky `bypass` mode appended at the session
        // layer), so they map through directly.
        self.probe(cwd, |session| session.available_modes().to_vec())
            .await
    }

    async fn list_features(&self, _cwd: &str) -> Result<Vec<serde_json::Value>, AgentError> {
        // amaze exposes no discrete "features" over ACP (only modes + models +
        // configOptions), so there is nothing to probe. Return empty.
        Ok(vec![])
    }
}

/// Adapter mapping the rocky-agents [`AgentSession`] trait onto an
/// [`AcpSession`].
pub struct AcpAgentSession {
    inner: Arc<AcpSession>,
    runtime: AgentRuntimeInfo,
    /// Fan-out channel: the session's single-consumer `mpsc` stream is
    /// forwarded here so each [`AgentSession::subscribe_events`] caller gets an
    /// independent receiver.
    broadcast_tx: broadcast::Sender<AgentStreamEvent>,
    /// The session's raw event receiver, taken on the first `subscribe_events`
    /// call to start the forwarder. Held until then so no early events (e.g.
    /// `thread_started`, emitted during `connect`) are dropped before a
    /// subscriber exists.
    mpsc_rx: StdMutex<Option<mpsc::UnboundedReceiver<AgentStreamEvent>>>,
}

impl AcpAgentSession {
    fn new(session: AcpSession, config: &ProviderSessionConfig) -> Self {
        let session_id = session.session_id().to_string();
        let mpsc_rx = session.take_events();
        let (broadcast_tx, _) = broadcast::channel(EVENT_BROADCAST_CAPACITY);
        let runtime = AgentRuntimeInfo {
            provider: config.provider.clone(),
            session_id: Some(session_id),
            model: config.model.clone(),
            thinking_option_id: config.thinking_option_id.clone(),
            mode_id: config.mode_id.clone(),
            extra: None,
        };
        Self {
            inner: Arc::new(session),
            runtime,
            broadcast_tx,
            mpsc_rx: StdMutex::new(mpsc_rx),
        }
    }
}

#[async_trait]
impl AgentSession for AcpAgentSession {
    fn session_id(&self) -> Option<String> {
        Some(self.inner.session_id().to_string())
    }

    fn runtime_info(&self) -> AgentRuntimeInfo {
        self.runtime.clone()
    }

    async fn prompt(&self, input: PromptInput) -> Result<(), AgentError> {
        // The ACP `session/prompt` request blocks until the turn's terminal
        // stopReason. The manager contract is "start a turn; events arrive via
        // the stream", so drive the turn in the background and return once it is
        // dispatched. Lifecycle events (turn_started/completed/...) and the
        // assistant timeline flow through the broadcast stream.
        let inner = self.inner.clone();
        tokio::spawn(async move {
            if let Err(err) = inner.prompt(&input.text).await {
                tracing::warn!(error = %err, "ACP prompt turn failed");
            }
        });
        Ok(())
    }

    async fn cancel(&self) -> Result<(), AgentError> {
        self.inner
            .cancel()
            .await
            .map_err(|e| AgentError::Provider(e.to_string()))
    }

    async fn close(&self) -> Result<(), AgentError> {
        self.inner.shutdown().await;
        Ok(())
    }

    fn subscribe_events(&self) -> Option<broadcast::Receiver<AgentStreamEvent>> {
        // Subscribe BEFORE starting the forwarder so the first forwarded event
        // (e.g. thread_started buffered in the mpsc channel) is delivered to
        // this receiver rather than lost to an empty subscriber set.
        let receiver = self.broadcast_tx.subscribe();
        if let Ok(mut guard) = self.mpsc_rx.lock() {
            if let Some(mut rx) = guard.take() {
                let tx = self.broadcast_tx.clone();
                tokio::spawn(async move {
                    while let Some(event) = rx.recv().await {
                        // Send errors only mean no live subscribers; that is fine.
                        let _ = tx.send(event);
                    }
                });
            }
        }
        Some(receiver)
    }
}
