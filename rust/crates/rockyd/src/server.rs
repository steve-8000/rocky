use std::collections::HashSet;
use std::net::SocketAddr;
use std::process::ExitCode;

use axum::Router;
use rocky_config::{
    default_listen_string, format_listen_target, parse_listen_string, HostnamesConfig,
    ListenTarget, PersistedConfig,
};
use rocky_store::{
    acquire_pid_lock, get_or_create_server_id, release_pid_lock, update_pid_lock, PidLockError,
};
use std::sync::Arc;
use tokio::signal::unix::{signal, SignalKind};
use tracing::{error, info, warn};

use crate::auth::hash_daemon_password;
use crate::http::{build_allowed_origins, build_router_with_mcp, ServerContext};
use crate::lifecycle;
use crate::webui::resolve_web_ui_dir;
use rocky_acp_provider::AmazeAcpProvider;
use rocky_agents::{AgentManager, AgentProvider};
use rocky_mcp::McpContext;
use rocky_mission_control::FileBackedMissionControlService;
use rocky_scheduling::{LoopService, ScheduleService, ScheduleStore};
use rocky_terminal::TerminalManager;
use rocky_workspaces::{ProjectRegistry, WorkspaceRegistry};
use rocky_ws_session::handlers::chat_schedule_loop::{ChatFileStore, ChatScheduleLoopContext};
use rocky_ws_session::handlers::checkout::CheckoutContext;
use rocky_ws_session::handlers::daemon_read::DaemonReadContext;
use rocky_ws_session::handlers::files::FilesContext;
use rocky_ws_session::handlers::workspace::WorkspaceHandlerContext;
use rocky_ws_session::handlers::{
    agent, chat_schedule_loop, checkout, daemon_read, files, mission, workspace,
};
use rocky_ws_session::SessionDispatcher;
use std::sync::Mutex;

/// Outcome of the foreground run loop, distinguishing a restart request from a
/// normal shutdown so the entrypoint can re-exec itself.
enum RunOutcome {
    Shutdown,
    Restart,
}

pub fn run(home: Option<String>, listen_override: Option<String>) -> ExitCode {
    crate::lifecycle::init_logging();

    let rocky_home = match lifecycle::resolve_daemon_home(home) {
        Ok(path) => path,
        Err(err) => {
            // Fatal startup error: one clear record, then exit. No stack spam.
            error!(error = %err, "failed to resolve ROCKY_HOME");
            return ExitCode::from(1);
        }
    };

    // Resolve listen target: explicit override wins, else persisted config,
    // else the documented default. Phase 1 reads the override/env only; full
    // config parsing lands in Phase 3.
    let listen_string = listen_override
        .or_else(|| std::env::var("ROCKY_LISTEN").ok().filter(|v| !v.is_empty()))
        .unwrap_or_else(|| {
            default_listen_string(std::env::var("PORT").ok().as_deref())
        });

    let listen_target = match parse_listen_string(&listen_string) {
        Ok(target) => target,
        Err(err) => {
            error!(error = %err, listen = %listen_string, "invalid listen target");
            return ExitCode::from(1);
        }
    };

    let owner_pid = std::process::id() as i64;

    // Acquire the singleton lock with listen=null BEFORE binding, matching the
    // pid-lock algorithm. EADDRINUSE is never the singleton mechanism.
    if let Err(err) = acquire_pid_lock(&rocky_home, None, owner_pid) {
        match err {
            PidLockError::AlreadyRunning { message, existing } => {
                // Bounded, single diagnostic — never an unbounded EADDRINUSE loop.
                error!(
                    owner_pid = existing.pid,
                    listen = existing.listen.as_deref().unwrap_or("unknown"),
                    "{message}"
                );
            }
            other => error!(error = %other, "failed to acquire pid-lock"),
        }
        return ExitCode::from(1);
    }

    info!(
        home = %rocky_home.display(),
        listen = %listen_string,
        pid = owner_pid,
        "rockyd acquiring host control plane"
    );

    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(rt) => rt,
        Err(err) => {
            error!(error = %err, "failed to build tokio runtime");
            release_pid_lock(&rocky_home, owner_pid);
            return ExitCode::from(1);
        }
    };

    let outcome = runtime.block_on(async {
        serve(&rocky_home, owner_pid, &listen_string, listen_target).await
    });

    // Release the lock only if we still own it (graceful path).
    release_pid_lock(&rocky_home, owner_pid);

    match outcome {
        Ok(RunOutcome::Shutdown) => {
            info!("rockyd shutdown complete");
            ExitCode::SUCCESS
        }
        Ok(RunOutcome::Restart) => {
            info!("rockyd restart requested — re-executing self");
            // Drop the runtime before exec so listeners are closed.
            drop(runtime);
            match lifecycle::reexec_self() {
                Ok(never) => never,
                Err(err) => {
                    error!(error = %err, "failed to re-exec for restart");
                    ExitCode::from(1)
                }
            }
        }
        Err(err) => {
            error!(error = %err, "rockyd terminated with error");
            ExitCode::from(1)
        }
    }
}

async fn serve(
    rocky_home: &std::path::Path,
    owner_pid: i64,
    listen_string: &str,
    listen_target: ListenTarget,
) -> anyhow::Result<RunOutcome> {
    let _ = (listen_string, owner_pid);
    // Resolve Phase 2 inputs from $ROCKY_HOME/config.json + env.
    let persisted = PersistedConfig::load(rocky_home);
    let server_id =
        get_or_create_server_id(rocky_home, std::env::var("ROCKY_SERVER_ID").ok().as_deref());
    let hostname = host_name();

    // Password: ROCKY_PASSWORD env (hash it, cost 12) wins, else the persisted
    // bcrypt hash (`config.ts:296-303`).
    let password = resolve_password(&persisted);

    // Hostnames allowlist: persisted `daemon.hostnames` (`config.ts:394-398`;
    // env merging is deferred — Phase 2 honors the persisted value).
    let hostnames: Option<HostnamesConfig> = persisted.hostnames().cloned();

    // WebUI dir: explicit env (hard-fail if set but missing index.html) else
    // bundled dev candidate (soft-absent => API-only).
    let bundled_start = std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."));
    let webui_dir = match resolve_web_ui_dir(
        |k| std::env::var(k).ok().filter(|v| !v.is_empty()),
        &bundled_start,
    ) {
        Ok(dir) => dir,
        Err(err) => anyhow::bail!("{err}"),
    };
    if let Some(dir) = webui_dir.as_ref() {
        info!(dir = %dir.display(), "serving WebUI bundle");
    } else {
        info!("no WebUI bundle found — running API-only");
    }

    let public_dir = rocky_home.join("public");
    let cors_origins = persisted.cors_allowed_origins();

    // Bind first so CORS can include the actually-bound host:port.
    let (bound_listen, is_tcp, listener) = bind(listen_target).await?;

    let (cors_host, cors_port) = match &listener {
        BoundListener::Tcp(l) => {
            let addr = l.local_addr()?;
            (addr.ip().to_string(), addr.port())
        }
        BoundListener::Unix(_) => (String::new(), 0),
    };
    let allowed_origins: HashSet<String> =
        build_allowed_origins(&cors_origins, is_tcp, &cors_host, cors_port);

    // The agent control plane is shared between the MCP surface and the WS
    // session dispatcher. `AgentManager` is `Clone` (Arc inner), so both paths
    // observe the same live agent state.
    let agent_manager = AgentManager::new(rocky_home);

    // Build the WS session dispatcher (mission/agent/workspace/chat+schedule+loop
    // handler groups) and the agent + mission MCP surface, sharing the agent
    // manager. See `build_session_dispatcher` for the Mission Control sharing note.
    let repo_root = resolve_repo_root();
    let provider: Arc<dyn AgentProvider> = Arc::new(AmazeAcpProvider::new(repo_root.clone()));
    let daemon_read_ctx = DaemonReadContext {
        server_id: server_id.clone(),
        version: daemon_version().as_str().map(|s| s.to_string()),
        listen: Some(bound_listen.clone()),
        pid: std::process::id(),
        node_path: std::env::current_exe()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_else(|_| "rockyd".to_string()),
        started_at: None,
        rocky_home: rocky_home.to_path_buf(),
        repo_root,
        provider: provider.clone(),
    };
    let session_dispatcher = Some(Arc::new(build_session_dispatcher(
        rocky_home,
        agent_manager.clone(),
        provider.clone(),
        daemon_read_ctx,
    )));

    let ctx = Arc::new(ServerContext {
        server_id,
        hostname,
        version: daemon_version(),
        listen: bound_listen.clone(),
        is_tcp,
        password,
        allowed_origins,
        hostnames,
        webui_dir,
        public_dir,
        session_dispatcher,
        agent_manager: Some(Arc::new(agent_manager.clone())),
    });

    // Build the agent + mission MCP surface and mount it under `/mcp/agents`.
    let mcp_router = build_mcp_router(rocky_home, agent_manager, provider);
    let app = build_router_with_mcp(ctx, mcp_router);

    match listener {
        BoundListener::Tcp(l) => spawn_server(l, app),
        BoundListener::Unix(l) => spawn_unix_server(l, app),
    }

    // Update the lock with the actually-bound listen target.
    if let Err(err) = update_pid_lock(rocky_home, &bound_listen, owner_pid) {
        warn!(error = %err, "failed to update pid-lock with bound listen target");
    }

    info!(listen = %bound_listen, pid = owner_pid, "rockyd up — listening");

    wait_for_signal().await
}

/// Build the agent + mission MCP router mounted under `/mcp/agents`.
///
/// Reuses the shared [`AgentManager`] (so MCP and the WS session dispatcher act
/// on the same live agent state), constructs a file-backed
/// [`FileBackedMissionControlService`] (initialized) and an [`AmazeAcpProvider`]
/// rooted at the resolved Rocky repo root, then wires them into an
/// [`McpContext::with_provider`]. The MCP tools (mission + agent) become live
/// over JSON-RPC. Mission init failure is non-fatal (logged); the daemon keeps
/// serving and the mission tools surface the error per-call.
fn build_mcp_router(
    rocky_home: &std::path::Path,
    manager: AgentManager,
    provider: Arc<dyn AgentProvider>,
) -> Router {
    let mission = FileBackedMissionControlService::new(rocky_home);
    if let Err(err) = mission.initialize() {
        warn!(error = %err, "failed to initialize mission control store");
    }
    let ctx = McpContext::with_provider(manager, mission, provider);
    rocky_mcp::mcp_router(ctx)
}

/// Build the `/ws` session RPC dispatcher, registering the mission, agent,
/// workspace, and chat/schedule/loop handler groups against the backing Rust
/// services rooted at `$ROCKY_HOME`.
///
/// Sharing strategy:
/// - `AgentManager` is the shared (cloned) handle also wired into MCP, so the
///   agent session handlers observe the same live state.
/// - Mission Control gets its OWN `FileBackedMissionControlService` instance
///   (wrapped in `Arc<Mutex<…>>`), distinct from the MCP context's instance but
///   pointing at the same `$ROCKY_HOME/missions` directory. Both are file-backed
///   and serialize to the same atomic files, so the two instances stay
///   consistent; the mutex serializes the synchronous mutations on this side.
fn build_session_dispatcher(
    rocky_home: &std::path::Path,
    agent_manager: AgentManager,
    provider: Arc<dyn AgentProvider>,
    daemon_read_ctx: DaemonReadContext,
) -> SessionDispatcher {
    let mut dispatcher = SessionDispatcher::new();

    // Mission Control: a dedicated file-backed instance over the same
    // `$ROCKY_HOME/missions` dir as the MCP context (see doc comment).
    let mission_service = FileBackedMissionControlService::new(rocky_home);
    if let Err(err) = mission_service.initialize() {
        warn!(error = %err, "failed to initialize mission control store (session)");
    }
    mission::register(&mut dispatcher, Arc::new(Mutex::new(mission_service)));

    // Agent lifecycle over the shared manager + live provider.
    agent::register(&mut dispatcher, Arc::new(agent_manager), provider);

    // Workspace / git / worktree / terminal.
    let workspace_ctx = WorkspaceHandlerContext {
        workspace_registry: Arc::new(Mutex::new(WorkspaceRegistry::load(rocky_home))),
        project_registry: Arc::new(Mutex::new(ProjectRegistry::load(rocky_home))),
        terminal_manager: Arc::new(TerminalManager::new()),
        rocky_home: rocky_home.to_path_buf(),
        worktrees_root: None,
    };
    workspace::register(&mut dispatcher, workspace_ctx);

    // Chat / schedule / loop.
    let schedule_service = ScheduleService::new(ScheduleStore::new(rocky_home.join("schedules")));
    let loop_service = LoopService::new(rocky_home);
    let chat_schedule_loop_ctx = ChatScheduleLoopContext {
        chat: ChatFileStore::new(rocky_home),
        schedule: Arc::new(Mutex::new(schedule_service)),
        loops: Arc::new(Mutex::new(loop_service)),
    };
    chat_schedule_loop::register(&mut dispatcher, chat_schedule_loop_ctx);

    // On-load daemon read RPCs (config / status / providers / heartbeat / push).
    daemon_read::register(&mut dispatcher, daemon_read_ctx);

    // Checkout / git / stash (shares a workspace registry instance with above).
    let checkout_ctx = CheckoutContext {
        workspace_registry: Arc::new(Mutex::new(WorkspaceRegistry::load(rocky_home))),
        rocky_home: rocky_home.to_path_buf(),
    };
    checkout::register(&mut dispatcher, checkout_ctx);

    // Filesystem / config reads.
    files::register(&mut dispatcher, FilesContext::new(rocky_home.to_path_buf()));

    dispatcher
}

/// Resolve the Rocky repo root for `__ROCKY_ROOT__` expansion in ACP commands.
/// `ROCKY_ROOT` env wins; otherwise fall back to the process cwd (which is the
/// repo root under the canonical launch scripts).
fn resolve_repo_root() -> String {
    std::env::var("ROCKY_ROOT")
        .ok()
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| {
            std::env::current_dir()
                .map(|p| p.to_string_lossy().into_owned())
                .unwrap_or_else(|_| ".".to_string())
        })
}

/// A bound listener, retaining whether it is TCP for host-validation gating.
enum BoundListener {
    Tcp(tokio::net::TcpListener),
    Unix(tokio::net::UnixListener),
}

/// Bind the listen target and return its canonical string + TCP flag.
async fn bind(listen_target: ListenTarget) -> anyhow::Result<(String, bool, BoundListener)> {
    match listen_target {
        ListenTarget::Tcp { host, port } => {
            let addr: SocketAddr = format!("{host}:{port}").parse()?;
            let listener = tokio::net::TcpListener::bind(addr).await?;
            let actual = listener.local_addr()?;
            let bound = format_listen_target(&ListenTarget::Tcp {
                host: actual.ip().to_string(),
                port: actual.port(),
            });
            Ok((bound, true, BoundListener::Tcp(listener)))
        }
        ListenTarget::Socket { path } => {
            // Remove a stale socket file if present so bind succeeds.
            let _ = std::fs::remove_file(&path);
            let listener = tokio::net::UnixListener::bind(&path)?;
            Ok((path, false, BoundListener::Unix(listener)))
        }
        ListenTarget::Pipe { path } => {
            anyhow::bail!("named pipe listeners are not supported on this platform: {path}");
        }
    }
}

fn spawn_server(listener: tokio::net::TcpListener, app: Router) {
    tokio::spawn(async move {
        if let Err(err) = axum::serve(listener, app).await {
            error!(error = %err, "http server error");
        }
    });
}

fn spawn_unix_server(listener: tokio::net::UnixListener, app: Router) {
    tokio::spawn(async move {
        if let Err(err) = axum::serve(listener, app).await {
            error!(error = %err, "unix http server error");
        }
    });
}

/// Resolve the daemon password hash, matching `resolveAuthConfig`
/// (`config.ts:292-303`): `ROCKY_PASSWORD` env hashed at cost 12 wins, else the
/// persisted bcrypt hash.
fn resolve_password(persisted: &PersistedConfig) -> Option<String> {
    if let Some(raw) = std::env::var("ROCKY_PASSWORD").ok().map(|v| v.trim().to_string()) {
        if !raw.is_empty() {
            match hash_daemon_password(&raw) {
                Ok(hash) => return Some(hash),
                Err(err) => {
                    error!(error = %err, "failed to hash ROCKY_PASSWORD; auth disabled");
                    return None;
                }
            }
        }
    }
    persisted.auth_password().map(|s| s.to_string())
}

/// Best-effort daemon version for `/api/status` + WS `server_info`
/// (`bootstrap.ts:471`: null/"0.1.0" acceptable). Uses the crate version.
fn daemon_version() -> serde_json::Value {
    serde_json::Value::String(env!("CARGO_PKG_VERSION").to_string())
}

/// Resolve the local hostname (matches Node's `os.hostname()`), with a
/// localhost fallback.
fn host_name() -> String {
    #[cfg(unix)]
    {
        let mut buf = vec![0u8; 256];
        let res =
            unsafe { libc::gethostname(buf.as_mut_ptr() as *mut libc::c_char, buf.len()) };
        if res == 0 {
            let end = buf.iter().position(|&b| b == 0).unwrap_or(buf.len());
            if let Ok(name) = String::from_utf8(buf[..end].to_vec()) {
                if !name.is_empty() {
                    return name;
                }
            }
        }
    }
    "localhost".to_string()
}

/// Wait for a lifecycle signal:
/// - SIGINT/SIGTERM => graceful shutdown
/// - SIGHUP        => restart (re-exec self)
async fn wait_for_signal() -> anyhow::Result<RunOutcome> {
    let mut sigint = signal(SignalKind::interrupt())?;
    let mut sigterm = signal(SignalKind::terminate())?;
    let mut sighup = signal(SignalKind::hangup())?;

    tokio::select! {
        _ = sigint.recv() => {
            info!("received SIGINT — graceful shutdown");
            Ok(RunOutcome::Shutdown)
        }
        _ = sigterm.recv() => {
            info!("received SIGTERM — graceful shutdown");
            Ok(RunOutcome::Shutdown)
        }
        _ = sighup.recv() => {
            info!("received SIGHUP — restart");
            Ok(RunOutcome::Restart)
        }
    }
}
