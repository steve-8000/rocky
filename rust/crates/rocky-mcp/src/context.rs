//! Shared server context and per-request call context.
//!
//! The MCP server holds an [`McpContext`] bundling the [`AgentManager`], the
//! [`FileBackedMissionControlService`], and (optionally) a provider used by the
//! `create_agent` tool. Each JSON-RPC request derives a [`CallCtx`] that also
//! carries the authenticated `caller_agent_id` (set by the HTTP layer from the
//! `callerAgentId=` query parameter), so tools that stamp parent labels or
//! resolve child cwds have the caller in hand.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use rocky_agents::{AgentManager, AgentProvider};
use rocky_mission_control::FileBackedMissionControlService;
use rocky_scheduling::ScheduleService;
use rocky_terminal::TerminalManager;
use rocky_workspaces::WorkspaceRegistry;

/// Optional backing services shared with the WS session dispatcher. Each is
/// `None` in API-only/test contexts; the corresponding tools surface a
/// structured `not_wired` error rather than faking success when absent.
#[derive(Clone, Default)]
pub struct McpServices {
    /// PTY terminal manager (shared with the workspace WS handlers so the MCP
    /// terminal tools observe the same live terminals).
    pub terminal_manager: Option<Arc<TerminalManager>>,
    /// Schedule service (shared with the chat/schedule WS handlers). Wrapped in
    /// a mutex because [`ScheduleService`] is not internally synchronized.
    pub schedule_service: Option<Arc<Mutex<ScheduleService>>>,
    /// Workspace registry, used by the worktree tools to upsert worktree-kind
    /// workspace records.
    pub workspace_registry: Option<Arc<Mutex<WorkspaceRegistry>>>,
    /// `$ROCKY_HOME`, used to resolve the worktree base root.
    pub rocky_home: Option<PathBuf>,
    /// Optional worktree base-root override (mirrors the config root).
    pub worktrees_root: Option<String>,
}

/// Process-wide MCP dependencies. Cheap to clone (`Arc` inner).
#[derive(Clone)]
pub struct McpContext {
    inner: Arc<Inner>,
}

struct Inner {
    agent_manager: AgentManager,
    mission_control: FileBackedMissionControlService,
    /// Optional agent provider used by `create_agent`. When absent, that tool
    /// returns a structured `not_wired` error instead of faking success.
    provider: Option<Arc<dyn AgentProvider>>,
    /// Optional shared backing services (terminal/schedule/workspace).
    services: McpServices,
}

impl McpContext {
    /// Build a context without a provider. `create_agent` will report that
    /// provider wiring is required until [`McpContext::with_provider`] supplies
    /// one.
    pub fn new(
        agent_manager: AgentManager,
        mission_control: FileBackedMissionControlService,
    ) -> Self {
        Self {
            inner: Arc::new(Inner {
                agent_manager,
                mission_control,
                provider: None,
                services: McpServices::default(),
            }),
        }
    }

    /// Build a context with a live agent provider wired in.
    pub fn with_provider(
        agent_manager: AgentManager,
        mission_control: FileBackedMissionControlService,
        provider: Arc<dyn AgentProvider>,
    ) -> Self {
        Self {
            inner: Arc::new(Inner {
                agent_manager,
                mission_control,
                provider: Some(provider),
                services: McpServices::default(),
            }),
        }
    }

    /// Build a context with a live provider plus shared backing services
    /// (terminal/schedule/workspace). This is the full daemon wiring used by
    /// `rockyd`; the terminal/schedule/worktree tools become live.
    pub fn with_services(
        agent_manager: AgentManager,
        mission_control: FileBackedMissionControlService,
        provider: Arc<dyn AgentProvider>,
        services: McpServices,
    ) -> Self {
        Self {
            inner: Arc::new(Inner {
                agent_manager,
                mission_control,
                provider: Some(provider),
                services,
            }),
        }
    }

    pub fn agent_manager(&self) -> &AgentManager {
        &self.inner.agent_manager
    }

    pub fn mission_control(&self) -> &FileBackedMissionControlService {
        &self.inner.mission_control
    }

    pub fn provider(&self) -> Option<&Arc<dyn AgentProvider>> {
        self.inner.provider.as_ref()
    }

    pub fn services(&self) -> &McpServices {
        &self.inner.services
    }
}

/// Per-request context handed to every tool handler.
#[derive(Clone)]
pub struct CallCtx {
    ctx: McpContext,
    caller_agent_id: Option<String>,
}

impl CallCtx {
    pub fn new(ctx: McpContext, caller_agent_id: Option<String>) -> Self {
        Self {
            ctx,
            caller_agent_id,
        }
    }

    pub fn agent_manager(&self) -> &AgentManager {
        self.ctx.agent_manager()
    }

    pub fn mission_control(&self) -> &FileBackedMissionControlService {
        self.ctx.mission_control()
    }

    pub fn provider(&self) -> Option<&Arc<dyn AgentProvider>> {
        self.ctx.provider()
    }

    pub fn services(&self) -> &McpServices {
        self.ctx.services()
    }

    /// The authenticated caller agent id, if the request was agent-scoped.
    /// Empty strings are treated as absent.
    pub fn caller_agent_id(&self) -> Option<&str> {
        self.caller_agent_id
            .as_deref()
            .filter(|s| !s.is_empty())
    }
}
