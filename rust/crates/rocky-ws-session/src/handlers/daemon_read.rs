//! On-load daemon read RPC handlers, matching the daemon-status / config /
//! provider-snapshot / heartbeat / push cases in `session.ts` that the WebUI
//! fires immediately after `hello`. Without these the UI hangs waiting for a
//! response on connect.
//!
//! Inner request/response `type` strings and payload field names are
//! wire-compatible with the TypeScript daemon. Response `type` strings handled
//! here (verified against messages.ts / session.ts):
//!
//! - `get_daemon_config_request` -> `get_daemon_config_response`
//!   `{requestId, config}` where `config` is the `MutableDaemonConfig`
//!   (messages.ts:151-164 `MutableDaemonConfigSchema`; response schema
//!   messages.ts:2766-2774; session.ts:1861-1866). The config is projected from
//!   the persisted `$ROCKY_HOME/config.json` `daemon` section.
//! - `daemon.get_status.request` -> `daemon.get_status.response`
//!   `{requestId, serverId, version, pid, nodePath, startedAt, listen, relay,
//!   providers}` (messages.ts:2776-2806; session.ts:3753-3794). `providers` is
//!   the `{provider, available, error}` availability list derived from the
//!   provider snapshot.
//! - `client_heartbeat` -> internal `client_heartbeat_ack` (the TS daemon emits
//!   nothing — `session.ts:1751-1753` returns `undefined`). The WS transport
//!   suppresses this ack, exactly like `terminal_input` -> `terminal_input_ack`
//!   in `workspace.rs`.
//! - `register_push_token` -> internal `register_push_token_ack` (the TS daemon
//!   emits nothing — `session.ts:2200-2202` returns). The token is persisted via
//!   the `PushTokenStore` (`$ROCKY_HOME/push-tokens.json`); the ack carries the
//!   real `stored`/`error` outcome (never a fake ok). Request schema
//!   messages.ts:1757-1760.
//! - `read_project_config_request` -> `read_project_config_response`
//!   discriminated union on `ok` (messages.ts:2830-2845; session.ts:1889-1933).
//!   Best-effort: reads `<repoRoot>/.rocky/config.json`; reports a structured
//!   `ok:false` error when the repo root cannot be resolved or read.
//! - `get_providers_snapshot_request` -> `get_providers_snapshot_response`
//!   `{entries, generatedAt, requestId}` (messages.ts:3525-3533;
//!   session.ts:3864-3880).
//! - `refresh_providers_snapshot_request` -> `refresh_providers_snapshot_response`
//!   `{acknowledged, requestId}` (messages.ts:3546-3551; session.ts:3882-3907).
//! - `list_available_providers_request` -> `list_available_providers_response`
//!   `{providers, error, fetchedAt, requestId}` (messages.ts:3515-3523;
//!   session.ts:3833-3862).
//!
//! ## Models / modes via live ACP discovery
//! The Rust daemon does not own a static provider catalog. Models/modes are
//! discovered from the live ACP agent via [`AgentProvider::list_models`] /
//! [`AgentProvider::list_modes`] (a short-lived probe that spawns the agent
//! subprocess). To avoid probing on every snapshot/RPC, discovery is cached per
//! `provider+cwd` with a short TTL (see [`DISCOVERY_TTL`]). Availability/status
//! is still probed structurally (launch command on PATH + CLI entrypoint
//! present). Nothing is fabricated: on probe failure the typed `_response`
//! carries a non-null `error` and empty arrays.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock};
use std::time::{Duration, Instant};

use rocky_agent_domain::AgentMode;
use rocky_agents::{AgentModelDef, AgentProvider};
use rocky_notify::PushTokenStore;
use serde_json::{json, Value};
use time::{format_description::well_known::Rfc3339, OffsetDateTime};
use tokio::sync::Mutex;

use crate::dispatch::{SessionDispatcher, SessionRpcError};

/// Context the on-load read handlers need. Cheap to clone (all fields are
/// `String`/`PathBuf`/`Arc`). Mirrors the daemon-runtime fields the TS session
/// reads for `daemon.get_status` plus the persisted-config root.
#[derive(Clone)]
pub struct DaemonReadContext {
    /// Stable daemon server id (`daemon.get_status.response.serverId`).
    pub server_id: String,
    /// Daemon version string, if known (`version`).
    pub version: Option<String>,
    /// Resolved listen string (`listen`).
    pub listen: Option<String>,
    /// OS process id (`pid`).
    pub pid: u32,
    /// Runtime binary path (`nodePath`; the rust daemon reports its own exe).
    pub node_path: String,
    /// Process start time as RFC3339 (`startedAt`).
    pub started_at: Option<String>,
    /// `$ROCKY_HOME` root (config.json + push-tokens.json live here).
    pub rocky_home: PathBuf,
    /// Repo root used to probe provider launch commands (`__ROCKY_ROOT__`).
    pub repo_root: String,
    /// Live agent provider (used for its `id()` in the snapshot).
    pub provider: Arc<dyn AgentProvider>,
}

/// Register all on-load daemon read handlers onto the dispatcher.
pub fn register(dispatcher: &mut SessionDispatcher, ctx: DaemonReadContext) {
    macro_rules! reg {
        ($type:literal, $handler:path) => {{
            let c = ctx.clone();
            dispatcher.register(
                $type,
                Arc::new(move |msg: Value| {
                    let c = c.clone();
                    async move { $handler(&c, msg).await }
                }),
            );
        }};
    }

    reg!("get_daemon_config_request", handle_get_daemon_config);
    reg!("daemon.get_status.request", handle_daemon_get_status);
    reg!("client_heartbeat", handle_client_heartbeat);
    reg!("register_push_token", handle_register_push_token);
    reg!("read_project_config_request", handle_read_project_config);
    reg!("get_providers_snapshot_request", handle_get_providers_snapshot);
    reg!("refresh_providers_snapshot_request", handle_refresh_providers_snapshot);
    reg!("list_available_providers_request", handle_list_available_providers);
    reg!("list_provider_models_request", handle_list_provider_models);
    reg!("list_provider_modes_request", handle_list_provider_modes);
    reg!("list_provider_features_request", handle_list_provider_features);
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

fn request_id(msg: &Value) -> String {
    msg.get("requestId")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

fn now_rfc3339() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_string())
}

/// Resolve a launch command's first token against `PATH`. Mirrors the runnable
/// check the TS provider availability probe performs before declaring `ready`.
fn command_on_path(command: &str) -> bool {
    if command.contains('/') {
        return Path::new(command).is_file();
    }
    let Ok(path) = std::env::var("PATH") else {
        return false;
    };
    std::env::split_paths(&path).any(|dir| dir.join(command).is_file())
}

/// Expand `__ROCKY_ROOT__` in a command argument against the repo root
/// (mirrors `rocky-acp-provider` / `scripts/setup.sh`).
fn expand_rocky_root(arg: &str, repo_root: &str) -> String {
    arg.replace("__ROCKY_ROOT__", repo_root)
}

// ---------------------------------------------------------------------------
// Provider discovery (models / modes) — cached live ACP probe
// ---------------------------------------------------------------------------

/// TTL for the per-`provider+cwd` models/modes cache. The ACP discovery probe
/// spawns the agent subprocess (~1.5s); caching avoids re-probing on every
/// snapshot call and every `list_provider_*` RPC within the window.
const DISCOVERY_TTL: Duration = Duration::from_secs(60);

/// Cached models+modes for one provider/cwd.
#[derive(Clone, Default)]
struct ProviderDiscovery {
    models: Vec<AgentModelDef>,
    modes: Vec<AgentMode>,
}

type DiscoveryCache = Mutex<HashMap<String, (Instant, ProviderDiscovery)>>;

/// Process-wide discovery cache, keyed by `provider\0cwd`. Lives in the handler
/// module (not on `DaemonReadContext`) so `server.rs` needs no new field; the
/// TTL bounds staleness and the daemon hosts a single provider.
static DISCOVERY_CACHE: LazyLock<DiscoveryCache> = LazyLock::new(|| Mutex::new(HashMap::new()));

/// Discover models+modes for `cwd` via the live provider, memoized per
/// `provider+cwd` for [`DISCOVERY_TTL`]. On probe error the error string is
/// returned (callers surface it in the typed `_response`); failures are not
/// cached so a transient probe error self-heals on the next call.
async fn discover(ctx: &DaemonReadContext, cwd: &str) -> Result<ProviderDiscovery, String> {
    let key = format!("{}\u{0}{}", ctx.provider.id(), cwd);
    {
        let cache = DISCOVERY_CACHE.lock().await;
        if let Some((at, disc)) = cache.get(&key) {
            if at.elapsed() < DISCOVERY_TTL {
                return Ok(disc.clone());
            }
        }
    }
    let models = ctx
        .provider
        .list_models(cwd)
        .await
        .map_err(|e| e.to_string())?;
    let modes = ctx
        .provider
        .list_modes(cwd)
        .await
        .map_err(|e| e.to_string())?;
    let disc = ProviderDiscovery { models, modes };
    // Do NOT cache an empty-models result: a cold-start ACP `session/new` can
    // transiently return Ok with no advertised models, and caching that would
    // pin an empty model picker for the whole TTL (the exact "provider lookup
    // empty" symptom). Only memoize a non-empty discovery; otherwise return it
    // once and re-probe on the next call so it self-heals.
    if !disc.models.is_empty() {
        let mut cache = DISCOVERY_CACHE.lock().await;
        cache.insert(key, (Instant::now(), disc.clone()));
    }
    Ok(disc)
}

/// `defaultModeId` for a snapshot entry: prefer an explicit `default` mode, else
/// the first advertised mode, else `null`.
fn default_mode_id(modes: &[AgentMode]) -> Value {
    if modes.iter().any(|m| m.id == "default") {
        return Value::String("default".to_string());
    }
    match modes.first() {
        Some(m) => Value::String(m.id.clone()),
        None => Value::Null,
    }
}

// ---------------------------------------------------------------------------
// Provider snapshot
// ---------------------------------------------------------------------------

/// A single `ProviderSnapshotEntry` (messages.ts:261-272). Structural
/// availability (`status`/`label`/`error`) is determined locally; for a `ready`
/// amaze entry, `models`/`modes`/`defaultModeId` are filled from live ACP
/// discovery (cached). Discovery failure downgrades the entry to `error` with a
/// non-null `error` rather than fabricating a catalog.
async fn provider_snapshot_entry(ctx: &DaemonReadContext, cwd: &str) -> Value {
    let provider_id = ctx.provider.id();
    let repo_root = ctx.repo_root.as_str();
    let (status, error, label, description) = match provider_id {
        "amaze" => {
            // amaze launch command: `bun __ROCKY_ROOT__/vendor/amaze/.../cli.ts acp`.
            let bun_ok = command_on_path("bun");
            let cli_path = expand_rocky_root(
                "__ROCKY_ROOT__/vendor/amaze/packages/coding-agent/src/cli.ts",
                repo_root,
            );
            let cli_ok = Path::new(&cli_path).is_file();
            if bun_ok && cli_ok {
                (
                    "ready",
                    None,
                    "Amaze",
                    "Amaze coding agent (ACP)".to_string(),
                )
            } else {
                let mut missing = Vec::new();
                if !bun_ok {
                    missing.push("`bun` is not on PATH".to_string());
                }
                if !cli_ok {
                    missing.push(format!("amaze CLI not found at {cli_path}"));
                }
                (
                    "unavailable",
                    Some(missing.join("; ")),
                    "Amaze",
                    "Amaze coding agent (ACP)".to_string(),
                )
            }
        }
        other => (
            "unavailable",
            Some(format!("Provider `{other}` availability cannot be determined")),
            "Provider",
            format!("Provider `{other}`"),
        ),
    };

    // For a structurally-ready provider, populate models/modes from live
    // discovery. A probe failure downgrades to `error` (the WebUI shows the
    // reason) rather than presenting an empty catalog as `ready`.
    let mut status = status;
    let mut error = error;
    let mut models = Vec::new();
    let mut modes = Vec::new();
    let mut default_mode = Value::Null;
    if status == "ready" {
        match discover(ctx, cwd).await {
            Ok(disc) => {
                default_mode = default_mode_id(&disc.modes);
                models = disc.models;
                modes = disc.modes;
            }
            Err(e) => {
                status = "error";
                error = Some(e);
            }
        }
    }

    let mut entry = json!({
        "provider": provider_id,
        "status": status,
        "enabled": true,
        "label": label,
        "description": description,
        "fetchedAt": now_rfc3339(),
        "models": models,
        "modes": modes,
        "defaultModeId": default_mode,
    });
    if let Some(err) = error {
        entry
            .as_object_mut()
            .expect("entry is an object")
            .insert("error".to_string(), Value::String(err));
    }
    entry
}

/// Build the provider-snapshot array for `cwd` (defaults to the repo root when
/// absent). `cwd` selects the discovery probe's working directory.
pub async fn provider_snapshot(ctx: &DaemonReadContext, cwd: Option<&str>) -> Vec<Value> {
    let cwd = cwd.unwrap_or(&ctx.repo_root);
    vec![provider_snapshot_entry(ctx, cwd).await]
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/// Project the persisted `config.json` `daemon` section onto a
/// `MutableDaemonConfig` (messages.ts:151-164). Required fields fall back to
/// their schema defaults when absent (the TS `DaemonConfigStore` seeds the same
/// defaults), so the WebUI always receives a parseable config object.
async fn handle_get_daemon_config(
    ctx: &DaemonReadContext,
    msg: Value,
) -> Result<Value, SessionRpcError> {
    let req_id = request_id(&msg);
    let raw = std::fs::read_to_string(ctx.rocky_home.join("config.json")).unwrap_or_default();
    let parsed: Value = serde_json::from_str(&raw).unwrap_or(Value::Null);
    let daemon = parsed.get("daemon").cloned().unwrap_or(Value::Null);

    let inject_into_agents = daemon
        .get("mcp")
        .and_then(|m| m.get("injectIntoAgents"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let auto_archive = daemon
        .get("autoArchiveAfterMerge")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let append_system_prompt = daemon
        .get("appendSystemPrompt")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let team_agents = daemon
        .get("teamAgents")
        .cloned()
        .unwrap_or_else(|| json!([]));
    let providers = parsed
        .get("providers")
        .cloned()
        .unwrap_or_else(|| json!({}));

    let config = json!({
        "mcp": { "injectIntoAgents": inject_into_agents },
        "providers": providers,
        "metadataGeneration": { "providers": [] },
        "autoArchiveAfterMerge": auto_archive,
        "appendSystemPrompt": append_system_prompt,
        "teamAgents": team_agents,
    });

    Ok(json!({
        "type": "get_daemon_config_response",
        "payload": { "requestId": req_id, "config": config }
    }))
}

async fn handle_daemon_get_status(
    ctx: &DaemonReadContext,
    msg: Value,
) -> Result<Value, SessionRpcError> {
    let req_id = request_id(&msg);
    let entries = provider_snapshot(ctx, None).await;
    // `providers` is the `{provider, available, error}` availability list
    // (messages.ts:2797-2804). Derive it from the snapshot entries.
    let providers: Vec<Value> = entries
        .iter()
        .map(|e| {
            let available = e.get("status").and_then(Value::as_str) == Some("ready");
            json!({
                "provider": e.get("provider").cloned().unwrap_or(Value::Null),
                "available": available,
                "error": e.get("error").cloned().unwrap_or(Value::Null),
            })
        })
        .collect();

    Ok(json!({
        "type": "daemon.get_status.response",
        "payload": {
            "requestId": req_id,
            "serverId": ctx.server_id,
            "version": ctx.version.clone(),
            "pid": ctx.pid,
            "nodePath": ctx.node_path,
            "startedAt": ctx.started_at.clone(),
            "listen": ctx.listen.clone(),
            "relay": Value::Null,
            "providers": providers,
        }
    }))
}

async fn handle_client_heartbeat(
    _ctx: &DaemonReadContext,
    _msg: Value,
) -> Result<Value, SessionRpcError> {
    // The TS daemon records client activity and emits nothing
    // (session.ts:1751-1753). Return an internal ack the WS transport
    // suppresses (like `terminal_input` -> `terminal_input_ack`).
    Ok(json!({
        "type": "client_heartbeat_ack",
        "payload": { "received": true }
    }))
}

async fn handle_register_push_token(
    ctx: &DaemonReadContext,
    msg: Value,
) -> Result<Value, SessionRpcError> {
    let token = msg
        .get("token")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    // The TS daemon persists the token and emits nothing (session.ts:2200-2202).
    // Persist via the real `PushTokenStore`; the internal ack carries the true
    // stored/error outcome (never a fake ok). The WS transport suppresses it.
    let path = ctx.rocky_home.join("push-tokens.json");
    let mut store = PushTokenStore::open(&path);
    let (stored, error) = if token.trim().is_empty() {
        (false, Some("empty push token".to_string()))
    } else {
        match store.add_token(&token) {
            Ok(()) => (true, None),
            Err(e) => (false, Some(e.to_string())),
        }
    };
    Ok(json!({
        "type": "register_push_token_ack",
        "payload": {
            "stored": stored,
            "error": error.map(Value::String).unwrap_or(Value::Null),
        }
    }))
}

async fn handle_read_project_config(
    _ctx: &DaemonReadContext,
    msg: Value,
) -> Result<Value, SessionRpcError> {
    let req_id = request_id(&msg);
    let repo_root = msg
        .get("repoRoot")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();

    if repo_root.is_empty() {
        return Ok(json!({
            "type": "read_project_config_response",
            "payload": {
                "requestId": req_id,
                "repoRoot": repo_root,
                "ok": false,
                "error": { "code": "invalid_request", "message": "missing repoRoot" },
            }
        }));
    }

    // The TS daemon reads `<repoRoot>/.rocky/config.json` (project rocky config).
    // Read best-effort: a present, parseable file -> `ok:true` with the raw
    // config; absent -> `ok:true` with `config:null`; unparseable -> `ok:false`.
    let path = Path::new(&repo_root).join(".rocky").join("config.json");
    match std::fs::read_to_string(&path) {
        Ok(raw) => match serde_json::from_str::<Value>(&raw) {
            Ok(config) => Ok(json!({
                "type": "read_project_config_response",
                "payload": {
                    "requestId": req_id,
                    "repoRoot": repo_root,
                    "ok": true,
                    "config": config,
                    "revision": Value::Null,
                }
            })),
            Err(e) => Ok(json!({
                "type": "read_project_config_response",
                "payload": {
                    "requestId": req_id,
                    "repoRoot": repo_root,
                    "ok": false,
                    "error": { "code": "parse_error", "message": e.to_string() },
                }
            })),
        },
        Err(_) => Ok(json!({
            "type": "read_project_config_response",
            "payload": {
                "requestId": req_id,
                "repoRoot": repo_root,
                "ok": true,
                "config": Value::Null,
                "revision": Value::Null,
            }
        })),
    }
}

async fn handle_get_providers_snapshot(
    ctx: &DaemonReadContext,
    msg: Value,
) -> Result<Value, SessionRpcError> {
    let req_id = request_id(&msg);
    let cwd = msg.get("cwd").and_then(Value::as_str);
    let entries = provider_snapshot(ctx, cwd).await;
    Ok(json!({
        "type": "get_providers_snapshot_response",
        "payload": {
            "entries": entries,
            "generatedAt": now_rfc3339(),
            "requestId": req_id,
        }
    }))
}

async fn handle_refresh_providers_snapshot(
    _ctx: &DaemonReadContext,
    msg: Value,
) -> Result<Value, SessionRpcError> {
    let req_id = request_id(&msg);
    // Drop the cached discovery so the next snapshot/RPC re-probes the live
    // agent, then acknowledge (session.ts:3895-3906).
    DISCOVERY_CACHE.lock().await.clear();
    Ok(json!({
        "type": "refresh_providers_snapshot_response",
        "payload": { "acknowledged": true, "requestId": req_id }
    }))
}

async fn handle_list_available_providers(
    ctx: &DaemonReadContext,
    msg: Value,
) -> Result<Value, SessionRpcError> {
    let req_id = request_id(&msg);
    let providers: Vec<Value> = provider_snapshot(ctx, None)
        .await
        .iter()
        .map(|e| {
            let available = e.get("status").and_then(Value::as_str) == Some("ready");
            json!({
                "provider": e.get("provider").cloned().unwrap_or(Value::Null),
                "available": available,
                "error": e.get("error").cloned().unwrap_or(Value::Null),
            })
        })
        .collect();
    Ok(json!({
        "type": "list_available_providers_response",
        "payload": {
            "providers": providers,
            "error": Value::Null,
            "fetchedAt": now_rfc3339(),
            "requestId": req_id,
        }
    }))
}

// ---------------------------------------------------------------------------
// Per-provider discovery RPCs (models / modes / features)
// ---------------------------------------------------------------------------

/// Resolve the discovery `cwd` for a `list_provider_*` request: the request's
/// `cwd` when present, else the daemon repo root.
fn discovery_cwd<'a>(ctx: &'a DaemonReadContext, msg: &'a Value) -> &'a str {
    msg.get("cwd")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .unwrap_or(&ctx.repo_root)
}

/// Echo the requested `provider` back in the response. The daemon hosts a
/// single provider; the WebUI may send a composite id (e.g.
/// `amaze/anthropic/claude-...`), so discovery always runs against
/// `ctx.provider` regardless. The echoed value mirrors what the client sent
/// (falling back to the provider id) for response correlation.
fn echo_provider(ctx: &DaemonReadContext, msg: &Value) -> String {
    msg.get("provider")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| ctx.provider.id())
        .to_string()
}

/// `list_provider_models_request` -> `list_provider_models_response`
/// (messages.ts:3477-3485). On probe failure: empty `models` + non-null
/// `error` (never `rpc_error`, never fabricated data).
async fn handle_list_provider_models(
    ctx: &DaemonReadContext,
    msg: Value,
) -> Result<Value, SessionRpcError> {
    let req_id = request_id(&msg);
    let provider = echo_provider(ctx, &msg);
    let cwd = discovery_cwd(ctx, &msg);
    let (models, error) = match discover(ctx, cwd).await {
        Ok(disc) => (
            // `AgentModelDef` already serializes to the wire `AgentModelDefinition`
            // shape (camelCase, optional fields skipped), including the per-model
            // `thinkingOptions` / `defaultThinkingOptionId` the WebUI needs to
            // render the thinking picker. Serialize it directly.
            disc.models
                .iter()
                .map(|m| serde_json::to_value(m).unwrap_or(Value::Null))
                .collect::<Vec<_>>(),
            Value::Null,
        ),
        Err(e) => (Vec::new(), Value::String(e)),
    };
    Ok(json!({
        "type": "list_provider_models_response",
        "payload": {
            "provider": provider,
            "models": models,
            "error": error,
            "fetchedAt": now_rfc3339(),
            "requestId": req_id,
        }
    }))
}

/// `list_provider_modes_request` -> `list_provider_modes_response`
/// (messages.ts:3487-3496). `AgentMode` (domain type) serializes directly to
/// the wire `AgentMode` (`{id, label, description?}`).
async fn handle_list_provider_modes(
    ctx: &DaemonReadContext,
    msg: Value,
) -> Result<Value, SessionRpcError> {
    let req_id = request_id(&msg);
    let provider = echo_provider(ctx, &msg);
    let cwd = discovery_cwd(ctx, &msg);
    let (modes, error) = match discover(ctx, cwd).await {
        Ok(disc) => (
            serde_json::to_value(&disc.modes).unwrap_or_else(|_| json!([])),
            Value::Null,
        ),
        Err(e) => (json!([]), Value::String(e)),
    };
    Ok(json!({
        "type": "list_provider_modes_response",
        "payload": {
            "provider": provider,
            "modes": modes,
            "error": error,
            "fetchedAt": now_rfc3339(),
            "requestId": req_id,
        }
    }))
}

/// `list_provider_features_request` -> `list_provider_features_response`
/// (messages.ts:3498-3507). amaze exposes no discrete features over ACP, so
/// `features` is empty; a probe error still surfaces in `error`.
async fn handle_list_provider_features(
    ctx: &DaemonReadContext,
    msg: Value,
) -> Result<Value, SessionRpcError> {
    let req_id = request_id(&msg);
    let provider = echo_provider(ctx, &msg);
    let cwd = discovery_cwd(ctx, &msg);
    let (features, error) = match ctx.provider.list_features(cwd).await {
        Ok(features) => (Value::Array(features), Value::Null),
        Err(e) => (json!([]), Value::String(e.to_string())),
    };
    Ok(json!({
        "type": "list_provider_features_response",
        "payload": {
            "provider": provider,
            "features": features,
            "error": error,
            "fetchedAt": now_rfc3339(),
            "requestId": req_id,
        }
    }))
}