//! Workspace / git / worktree / terminal session RPC handlers.
//!
//! These mirror the workspace-, git-, worktree-, and terminal-control cases in
//! `core/packages/server/src/server/session.ts` (dispatch table lines
//! ~2011-2084) plus the helper handlers in
//! `core/packages/server/src/server/worktree-session.ts` (lines ~381-560), and
//! serialize the exact response payload shapes defined in
//! `core/packages/protocol/src/messages.ts`.
//!
//! Request -> response `type` strings and payload field names handled here:
//! - `fetch_workspaces_request` -> `fetch_workspaces_response`
//!   `{requestId, entries:[WorkspaceDescriptor], pageInfo:{nextCursor,prevCursor,hasMore}}`
//!   (messages.ts:2544-2555).
//! - `archive_workspace_request` -> `archive_workspace_response`
//!   `{requestId, workspaceId, archivedAt, error}` (messages.ts:2648-2656;
//!   session.ts:7340-7378).
//! - `open_project_request` -> `open_project_response`
//!   `{requestId, workspace, error}` (messages.ts:2605-2612; session.ts:7077-7117).
//! - `checkout_status_request` -> `checkout_status_response`
//!   not-git / git payload union (messages.ts:2926-2990; session.ts:4549-4587).
//! - `validate_branch_request` -> `validate_branch_response`
//!   `{exists, resolvedRef, isRemote, error, requestId}` (messages.ts:3340-3348;
//!   session.ts:4589-4651). Backed by `rocky_workspaces::validate_branch_slug`.
//! - `create_rocky_worktree_request` -> `create_rocky_worktree_response`
//!   `{workspace, error, errorCode?, setupTerminalId, requestId}`
//!   (messages.ts:3424-3434; worktree-session.ts:492-560).
//! - `rocky_worktree_list_request` -> `rocky_worktree_list_response`
//!   `{worktrees:[{worktreePath,createdAt,branchName,head}], error, requestId}`
//!   (messages.ts:3405-3412; worktree-session.ts:381-431).
//! - `rocky_worktree_archive_request` -> `rocky_worktree_archive_response`
//!   `{success, removedAgents?, error, requestId}` (messages.ts:3414-3422;
//!   worktree-session.ts:432-486).
//! - `create_terminal_request` -> `create_terminal_response`
//!   `{terminal:{id,name,cwd,title?}|null, error, requestId}` (messages.ts:3649-3656).
//! - `list_terminals_request` -> `list_terminals_response`
//!   `{cwd?, terminals:[{id,name,title?}], requestId}` (messages.ts:3632-3639).
//! - `kill_terminal_request` -> `kill_terminal_response`
//!   `{terminalId, success, requestId}` (messages.ts:3684-3690).
//! - `subscribe_terminal_request` -> `subscribe_terminal_response`
//!   union `{terminalId, slot, error:null, requestId}` | `{terminalId, error, requestId}`
//!   (messages.ts:3667-3681).
//! - `capture_terminal_request` -> `capture_terminal_response`
//!   `{terminalId, lines:[string], totalLines, requestId}` (messages.ts:3693-3699).
//! - `terminal_input` (input/resize) — fire-and-forget control message with no
//!   TS response type (messages.ts:1841-1845). See the handler note.
//!
//! ## Binary terminal stream frames are NOT handled here
//! The terminal Output/Exit STREAM frames are *binary* WebSocket frames
//! (`rocky_terminal::frames`), not JSON session messages. Piping a subscriber's
//! `broadcast::Receiver<Vec<u8>>` (from `TerminalManager::subscribe`) onto the
//! socket is wired at the WS transport layer (the mount task that owns the
//! socket), not in this dispatcher. This module only handles the JSON
//! request/response *control* messages.
//!
//! ## Backing service limitations
//! The Rust crates back the registry/worktree/git/PTY primitives. Fields the
//! primitives cannot compute without the full daemon (origin ahead/behind,
//! GitHub runtime, rocky-owned-worktree detection) are reported as the schema's
//! null/false defaults rather than fabricated values. Operations needing a real
//! git repo or live workspace that is absent return a response with a non-null
//! `error` (never a fake ok).

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::SystemTime;

use rocky_terminal::{CreateTerminalOptions, TerminalManager};
use rocky_workspaces::{
    archive_worktree, create_worktree, current_branch, derive_worktree_repo_root,
    git_status_porcelain, is_inside_work_tree, list_worktrees, normalize_workspace_id,
    resolve_worktree_root, run_git, upsert_workspace_for_worktree, validate_branch_slug,
    PersistedProjectRecord, PersistedWorkspaceRecord, ProjectKind, ProjectRegistry,
    WorkspaceRegistry,
};
use serde_json::{json, Value};
use time::{format_description::well_known::Rfc3339, OffsetDateTime};

use crate::dispatch::{SessionDispatcher, SessionRpcError};

/// Shared services the workspace/git/worktree/terminal handlers need.
///
/// The registries are file-backed and synchronous; each is guarded by its own
/// mutex so mutations serialize (matching the single-writer TS registries).
/// `TerminalManager` is internally `Arc`-shared and cheap to clone.
#[derive(Clone)]
pub struct WorkspaceHandlerContext {
    pub workspace_registry: Arc<Mutex<WorkspaceRegistry>>,
    pub project_registry: Arc<Mutex<ProjectRegistry>>,
    pub terminal_manager: Arc<TerminalManager>,
    /// `$ROCKY_HOME`; used to resolve the default worktree base root.
    pub rocky_home: PathBuf,
    /// Optional config override for the worktree base root
    /// (`resolveRockyWorktreesBaseRoot`); `None` => `$ROCKY_HOME/worktrees`.
    pub worktrees_root: Option<String>,
}

/// Register all workspace/git/worktree/terminal handlers onto the dispatcher.
pub fn register(dispatcher: &mut SessionDispatcher, ctx: WorkspaceHandlerContext) {
    macro_rules! reg {
        ($name:expr, $f:ident) => {{
            let ctx = ctx.clone();
            dispatcher.register(
                $name,
                Arc::new(move |msg: Value| {
                    let ctx = ctx.clone();
                    async move { $f(&ctx, msg).await }
                }),
            );
        }};
    }

    reg!("fetch_workspaces_request", handle_fetch_workspaces);
    reg!("archive_workspace_request", handle_archive_workspace);
    reg!("open_project_request", handle_open_project);
    reg!("checkout_status_request", handle_checkout_status);
    reg!("workspace_setup_status_request", handle_workspace_setup_status);
    reg!("validate_branch_request", handle_validate_branch);
    reg!("create_rocky_worktree_request", handle_create_worktree);
    reg!("rocky_worktree_list_request", handle_worktree_list);
    reg!("rocky_worktree_archive_request", handle_worktree_archive);
    reg!("create_terminal_request", handle_create_terminal);
    reg!("list_terminals_request", handle_list_terminals);
    reg!("subscribe_terminals_request", handle_subscribe_terminals);
    reg!("unsubscribe_terminals_request", handle_unsubscribe_terminals);
    reg!("kill_terminal_request", handle_kill_terminal);
    reg!("subscribe_terminal_request", handle_subscribe_terminal);
    reg!("capture_terminal_request", handle_capture_terminal);
    reg!("terminal_input", handle_terminal_input);
}

// ---------------------------------------------------------------------------
// Small parse helpers (mirroring mission.rs conventions).
// ---------------------------------------------------------------------------

fn request_id(msg: &Value) -> String {
    msg.get("requestId")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

fn opt_str(msg: &Value, key: &str) -> Option<String> {
    msg.get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
}

fn poisoned<T>(_: std::sync::PoisonError<T>) -> SessionRpcError {
    SessionRpcError::Handler("workspace registry lock poisoned".to_string())
}

/// `{code, message}` checkout error object (`CheckoutErrorSchema`,
/// messages.ts:1365). Codes are the `CheckoutErrorCodeSchema` enum.
fn checkout_error(code: &str, message: impl Into<String>) -> Value {
    json!({ "code": code, "message": message.into() })
}

/// Current UTC time as `new Date().toISOString()`-compatible string.
fn now_iso8601() -> String {
    iso8601(OffsetDateTime::now_utc())
}

fn iso8601(dt: OffsetDateTime) -> String {
    let full = dt
        .format(&Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_string());
    trim_to_millis(&full)
}

/// Trim a fractional-seconds RFC3339 string to millisecond precision with a
/// trailing `Z`, matching `Date.prototype.toISOString`.
fn trim_to_millis(rfc3339: &str) -> String {
    if let Some(dot) = rfc3339.find('.') {
        let suffix_start = rfc3339[dot..]
            .find(['Z', '+', '-'])
            .map(|i| dot + i)
            .unwrap_or(rfc3339.len());
        let frac = &rfc3339[dot + 1..suffix_start];
        let millis: String = frac.chars().take(3).collect();
        let millis = format!("{millis:0<3}");
        let suffix = &rfc3339[suffix_start..];
        format!("{}.{}{}", &rfc3339[..dot], millis, suffix)
    } else {
        rfc3339.to_string()
    }
}

fn system_time_to_iso(st: SystemTime) -> String {
    iso8601(OffsetDateTime::from(st))
}

/// `git rev-parse --show-toplevel` for `cwd`, or `None` when not a repo.
async fn repo_toplevel(cwd: &Path) -> Option<String> {
    let out = run_git(cwd, ["rev-parse", "--show-toplevel"]).await.ok()?;
    if !out.success() {
        return None;
    }
    let trimmed = out.stdout.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

// ---------------------------------------------------------------------------
// Workspace descriptor serialization (WorkspaceDescriptorPayloadSchema,
// messages.ts:2417-2459). Only the fields the Rust primitives can populate are
// set; optional+nullable runtime blocks (gitRuntime/githubRuntime) are omitted.
// ---------------------------------------------------------------------------

fn project_kind_str(kind: ProjectKind) -> &'static str {
    match kind {
        ProjectKind::Git => "git",
        ProjectKind::NonGit => "non_git",
    }
}

/// Build a wire `WorkspaceDescriptorPayload` from a workspace record plus its
/// (optional) project record.
fn workspace_descriptor(ws: &PersistedWorkspaceRecord, project: Option<&PersistedProjectRecord>) -> Value {
    let project_display_name = project
        .map(|p| p.display_name.clone())
        .unwrap_or_else(|| ws.project_id.clone());
    let project_custom_name = project.and_then(|p| p.custom_name.clone());
    let project_root_path = project
        .map(|p| p.root_path.clone())
        .unwrap_or_else(|| ws.cwd.clone());
    let project_kind = project.map(|p| project_kind_str(p.kind)).unwrap_or("directory");

    json!({
        "id": ws.workspace_id,
        "projectId": ws.project_id,
        "projectDisplayName": project_display_name,
        "projectCustomName": project_custom_name,
        "projectRootPath": project_root_path,
        "workspaceDirectory": ws.cwd,
        "projectKind": project_kind,
        "workspaceKind": ws.kind,
        "name": ws.display_name,
        "archivingAt": Value::Null,
        "status": "done",
        "statusEnteredAt": Value::Null,
        "activityAt": ws.updated_at,
        "scripts": [],
    })
}

// ---------------------------------------------------------------------------
// Workspace handlers.
// ---------------------------------------------------------------------------

async fn handle_fetch_workspaces(
    ctx: &WorkspaceHandlerContext,
    msg: Value,
) -> Result<Value, SessionRpcError> {
    let req_id = request_id(&msg);
    let workspaces = ctx.workspace_registry.lock().map_err(poisoned)?;
    let projects = ctx.project_registry.lock().map_err(poisoned)?;

    let entries: Vec<Value> = workspaces
        .list()
        .into_iter()
        .filter(|w| w.archived_at.is_none())
        .map(|w| {
            let project = projects.get(&w.project_id).cloned();
            workspace_descriptor(&w, project.as_ref())
        })
        .collect();

    Ok(json!({
        "type": "fetch_workspaces_response",
        "payload": {
            "requestId": req_id,
            "entries": entries,
            "pageInfo": { "nextCursor": Value::Null, "prevCursor": Value::Null, "hasMore": false },
        }
    }))
}

async fn handle_archive_workspace(
    ctx: &WorkspaceHandlerContext,
    msg: Value,
) -> Result<Value, SessionRpcError> {
    let req_id = request_id(&msg);
    let workspace_id = opt_str(&msg, "workspaceId").unwrap_or_default();

    // Snapshot the record, then release the lock before any async git/FS work.
    let existing = {
        let registry = ctx.workspace_registry.lock().map_err(poisoned)?;
        registry.get(&workspace_id).cloned()
    };

    let result: Result<String, String> = match existing {
        None => Err(format!("Workspace not found: {workspace_id}")),
        Some(existing) => {
            // Worktree-kind workspaces need the git/FS teardown, not just a
            // record flag. The UI "Remove project" path bulk-archives every
            // workspace (worktrees included) via `archive_workspace_request`, so
            // rejecting worktrees here surfaced as "Failed to remove some
            // workspaces". Run the idempotent teardown (deriving the repo root
            // from git, since this request carries no repoRoot) and then archive
            // the record.
            if existing.kind == "worktree" {
                let worktree_path = PathBuf::from(&existing.cwd);
                let repo_root = derive_worktree_repo_root(&worktree_path).await;
                if let Err(err) =
                    archive_worktree(repo_root.as_deref(), &worktree_path).await
                {
                    tracing::warn!(error = %err, workspace_id, "worktree teardown failed during archive_workspace; archiving record anyway");
                }
            }
            let archived_at = now_iso8601();
            let mut registry = ctx.workspace_registry.lock().map_err(poisoned)?;
            registry
                .archive(&workspace_id, &archived_at)
                .map(|()| archived_at)
                .map_err(|e| e.to_string())
        }
    };

    Ok(match result {
        Ok(archived_at) => json!({
            "type": "archive_workspace_response",
            "payload": { "requestId": req_id, "workspaceId": workspace_id, "archivedAt": archived_at, "error": Value::Null }
        }),
        Err(message) => json!({
            "type": "archive_workspace_response",
            "payload": { "requestId": req_id, "workspaceId": workspace_id, "archivedAt": Value::Null, "error": message }
        }),
    })
}

async fn handle_open_project(
    ctx: &WorkspaceHandlerContext,
    msg: Value,
) -> Result<Value, SessionRpcError> {
    let req_id = request_id(&msg);
    let cwd = opt_str(&msg, "cwd").unwrap_or_default();

    match open_project_inner(ctx, &cwd).await {
        Ok(descriptor) => Ok(json!({
            "type": "open_project_response",
            "payload": { "requestId": req_id, "workspace": descriptor, "error": Value::Null }
        })),
        Err(message) => Ok(json!({
            "type": "open_project_response",
            "payload": { "requestId": req_id, "workspace": Value::Null, "error": message }
        })),
    }
}

/// Find-or-create the project + workspace records for a directory and return a
/// descriptor (the registry-backed subset of `findOrCreateWorkspaceForDirectory`
/// + `describeWorkspaceRecord`, session.ts:7077-7100).
async fn open_project_inner(
    ctx: &WorkspaceHandlerContext,
    cwd: &str,
) -> Result<Value, String> {
    if cwd.is_empty() {
        return Err("cwd is required".to_string());
    }
    let path = Path::new(cwd);
    if !path.exists() {
        return Err(format!("Directory does not exist: {cwd}"));
    }

    // Resolve the project root + kind from git (when available).
    let is_git = is_inside_work_tree(path).await.unwrap_or(false);
    let (root_path, kind) = if is_git {
        let root = repo_toplevel(path).await.unwrap_or_else(|| cwd.to_string());
        (root, ProjectKind::Git)
    } else {
        (cwd.to_string(), ProjectKind::NonGit)
    };

    let project_id = normalize_workspace_id(Path::new(&root_path));
    let workspace_id = normalize_workspace_id(path);
    let now = now_iso8601();
    let display_name = Path::new(&root_path)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or(&project_id)
        .to_string();

    let mut projects = ctx.project_registry.lock().map_err(|_| "project registry lock poisoned".to_string())?;
    let existing_project = projects.get(&project_id).cloned();
    let project = match existing_project {
        Some(p) => p,
        None => {
            let record = PersistedProjectRecord {
                project_id: project_id.clone(),
                root_path: root_path.clone(),
                kind,
                display_name: display_name.clone(),
                custom_name: None,
                created_at: now.clone(),
                updated_at: now.clone(),
                archived_at: None,
            };
            projects.upsert(record.clone()).map_err(|e| e.to_string())?;
            record
        }
    };
    drop(projects);

    let mut workspaces = ctx.workspace_registry.lock().map_err(poisoned).map_err(|e| e.to_string())?;
    let workspace = match workspaces.get(&workspace_id).cloned() {
        Some(mut w) => {
            w.updated_at = now.clone();
            w.archived_at = None;
            workspaces.upsert(w.clone()).map_err(|e| e.to_string())?;
            w
        }
        None => {
            let record = PersistedWorkspaceRecord {
                workspace_id: workspace_id.clone(),
                project_id: project_id.clone(),
                cwd: cwd.to_string(),
                kind: if is_git { "local_checkout".to_string() } else { "directory".to_string() },
                display_name,
                created_at: now.clone(),
                updated_at: now,
                archived_at: None,
            };
            workspaces.upsert(record.clone()).map_err(|e| e.to_string())?;
            record
        }
    };

    Ok(workspace_descriptor(&workspace, Some(&project)))
}

async fn handle_checkout_status(
    _ctx: &WorkspaceHandlerContext,
    msg: Value,
) -> Result<Value, SessionRpcError> {
    let req_id = request_id(&msg);
    let cwd = opt_str(&msg, "cwd").unwrap_or_default();
    let path = Path::new(&cwd);

    let payload = match checkout_status_payload(path, &cwd, &req_id).await {
        Ok(payload) => payload,
        Err(message) => not_git_payload(&cwd, &req_id, Some(checkout_error("UNKNOWN", message))),
    };
    Ok(json!({ "type": "checkout_status_response", "payload": payload }))
}

/// `workspace_setup_status_request` -> `workspace_setup_status_response`
/// `{requestId, workspaceId, snapshot: WorkspaceSetupSnapshot|null}`
/// (request messages.ts:1599-1603; response messages.ts:2595-2602).
///
/// A `WorkspaceSetupSnapshot` (messages.ts:2589-2593) only models an in-flight
/// or finished worktree-setup run: its `status` enum is `running|completed|
/// failed` with no idle/none variant. The Rust daemon does not yet run worktree
/// setup commands, so there is never a setup run to report. Per the schema's
/// `snapshot: WorkspaceSetupSnapshotSchema.nullable()` (messages.ts:2600), the
/// correct schema-valid "no setup in progress / none recorded" value is `null`
/// — NOT a fabricated snapshot. `requestId` and `workspaceId` are echoed back
/// from the request.
async fn handle_workspace_setup_status(
    _ctx: &WorkspaceHandlerContext,
    msg: Value,
) -> Result<Value, SessionRpcError> {
    let req_id = request_id(&msg);
    let workspace_id = opt_str(&msg, "workspaceId").unwrap_or_default();
    Ok(json!({
        "type": "workspace_setup_status_response",
        "payload": {
            "requestId": req_id,
            "workspaceId": workspace_id,
            "snapshot": Value::Null,
        }
    }))
}

/// `CheckoutStatusNotGitSchema` payload (messages.ts:2932-2944).
fn not_git_payload(cwd: &str, req_id: &str, error: Option<Value>) -> Value {
    json!({
        "cwd": cwd,
        "isGit": false,
        "isRockyOwnedWorktree": false,
        "repoRoot": Value::Null,
        "currentBranch": Value::Null,
        "isDirty": Value::Null,
        "baseRef": Value::Null,
        "aheadBehind": Value::Null,
        "aheadOfOrigin": Value::Null,
        "behindOfOrigin": Value::Null,
        "hasRemote": false,
        "remoteUrl": Value::Null,
        "error": error.unwrap_or(Value::Null),
        "requestId": req_id,
    })
}

async fn checkout_status_payload(path: &Path, cwd: &str, req_id: &str) -> Result<Value, String> {
    let inside = is_inside_work_tree(path).await.map_err(|e| e.to_string())?;
    if !inside {
        return Ok(not_git_payload(cwd, req_id, None));
    }
    let repo_root = repo_toplevel(path).await.unwrap_or_else(|| cwd.to_string());
    let branch = current_branch(path).await.map_err(|e| e.to_string())?;
    let porcelain = git_status_porcelain(path).await.map_err(|e| e.to_string())?;
    let is_dirty = !porcelain.trim().is_empty();

    // `CheckoutStatusGitNonRockySchema` (messages.ts:2946-2958). Origin/remote
    // and rocky-owned detection are not computed by the primitive git wrapper,
    // so they use the schema's null/false defaults.
    Ok(json!({
        "cwd": cwd,
        "isGit": true,
        "isRockyOwnedWorktree": false,
        "repoRoot": repo_root,
        "mainRepoRoot": Value::Null,
        "currentBranch": branch,
        "isDirty": is_dirty,
        "baseRef": Value::Null,
        "aheadBehind": Value::Null,
        "aheadOfOrigin": Value::Null,
        "behindOfOrigin": Value::Null,
        "hasRemote": false,
        "remoteUrl": Value::Null,
        "error": Value::Null,
        "requestId": req_id,
    }))
}

async fn handle_validate_branch(
    _ctx: &WorkspaceHandlerContext,
    msg: Value,
) -> Result<Value, SessionRpcError> {
    let req_id = request_id(&msg);
    let branch_name = opt_str(&msg, "branchName").unwrap_or_default();
    let validation = validate_branch_slug(&branch_name);

    // The slug validator reports format validity. A valid slug is reported with
    // `error: null`; an invalid one carries the validator's message. Existence
    // resolution against a live ref store is a daemon concern, so `exists` is
    // reported false here (no fabricated resolution).
    let payload = if validation.valid {
        json!({
            "exists": false,
            "resolvedRef": Value::Null,
            "isRemote": false,
            "error": Value::Null,
            "requestId": req_id,
        })
    } else {
        json!({
            "exists": false,
            "resolvedRef": Value::Null,
            "isRemote": false,
            "error": validation.error,
            "requestId": req_id,
        })
    };
    Ok(json!({ "type": "validate_branch_response", "payload": payload }))
}

async fn handle_create_worktree(
    ctx: &WorkspaceHandlerContext,
    msg: Value,
) -> Result<Value, SessionRpcError> {
    let req_id = request_id(&msg);
    let cwd = opt_str(&msg, "cwd").unwrap_or_default();
    let slug = opt_str(&msg, "worktreeSlug").unwrap_or_default();
    let project_id =
        opt_str(&msg, "projectId").unwrap_or_else(|| normalize_workspace_id(Path::new(&cwd)));

    match create_worktree_inner(ctx, &cwd, &slug, &project_id).await {
        Ok(descriptor) => Ok(json!({
            "type": "create_rocky_worktree_response",
            "payload": {
                "workspace": descriptor,
                "error": Value::Null,
                "setupTerminalId": Value::Null,
                "requestId": req_id,
            }
        })),
        Err((code, message)) => Ok(json!({
            "type": "create_rocky_worktree_response",
            "payload": {
                "workspace": Value::Null,
                "error": message,
                "errorCode": code,
                "setupTerminalId": Value::Null,
                "requestId": req_id,
            }
        })),
    }
}

async fn create_worktree_inner(
    ctx: &WorkspaceHandlerContext,
    cwd: &str,
    slug: &str,
    project_id: &str,
) -> Result<Value, (String, String)> {
    let validation = validate_branch_slug(slug);
    if !validation.valid {
        return Err((
            "UNKNOWN".to_string(),
            validation
                .error
                .unwrap_or_else(|| "Invalid worktree slug".to_string()),
        ));
    }
    if cwd.is_empty() {
        return Err(("UNKNOWN".to_string(), "cwd is required".to_string()));
    }

    let base_root = resolve_worktree_root(&ctx.rocky_home, ctx.worktrees_root.as_deref());
    let worktree_path = base_root.join(project_id).join(slug);

    create_worktree(Path::new(cwd), &worktree_path, slug, None)
        .await
        .map_err(|e| ("UNKNOWN".to_string(), e.to_string()))?;

    let mut workspaces = ctx
        .workspace_registry
        .lock()
        .map_err(|_| ("UNKNOWN".to_string(), "workspace registry lock poisoned".to_string()))?;
    let mut record = upsert_workspace_for_worktree(&mut workspaces, project_id, &worktree_path)
        .map_err(|e| ("UNKNOWN".to_string(), e.to_string()))?;
    // Surface the branch name as the display name (TS sets it post-create).
    if record.display_name != slug {
        record.display_name = slug.to_string();
        workspaces
            .upsert(record.clone())
            .map_err(|e| ("UNKNOWN".to_string(), e.to_string()))?;
    }
    drop(workspaces);

    let projects = ctx
        .project_registry
        .lock()
        .map_err(|_| ("UNKNOWN".to_string(), "project registry lock poisoned".to_string()))?;
    let project = projects.get(project_id).cloned();
    Ok(workspace_descriptor(&record, project.as_ref()))
}

async fn handle_worktree_list(
    _ctx: &WorkspaceHandlerContext,
    msg: Value,
) -> Result<Value, SessionRpcError> {
    let req_id = request_id(&msg);
    let cwd = opt_str(&msg, "repoRoot").or_else(|| opt_str(&msg, "cwd"));

    let Some(cwd) = cwd else {
        return Ok(json!({
            "type": "rocky_worktree_list_response",
            "payload": {
                "worktrees": [],
                "error": checkout_error("UNKNOWN", "cwd or repoRoot is required"),
                "requestId": req_id,
            }
        }));
    };

    match list_worktrees(Path::new(&cwd)).await {
        Ok(entries) => {
            let worktrees: Vec<Value> = entries
                .into_iter()
                .map(|entry| {
                    let created_at = std::fs::metadata(&entry.path)
                        .and_then(|m| m.modified())
                        .map(system_time_to_iso)
                        .unwrap_or_else(|_| now_iso8601());
                    json!({
                        "worktreePath": entry.path.to_string_lossy(),
                        "createdAt": created_at,
                        "branchName": entry.branch,
                        "head": entry.head,
                    })
                })
                .collect();
            Ok(json!({
                "type": "rocky_worktree_list_response",
                "payload": { "worktrees": worktrees, "error": Value::Null, "requestId": req_id }
            }))
        }
        Err(e) => Ok(json!({
            "type": "rocky_worktree_list_response",
            "payload": {
                "worktrees": [],
                "error": checkout_error("UNKNOWN", e.to_string()),
                "requestId": req_id,
            }
        })),
    }
}

async fn handle_worktree_archive(
    ctx: &WorkspaceHandlerContext,
    msg: Value,
) -> Result<Value, SessionRpcError> {
    let req_id = request_id(&msg);
    let worktree_path = opt_str(&msg, "worktreePath");
    let repo_root = opt_str(&msg, "repoRoot");

    // The UI archives a worktree with only `worktreePath` (no `repoRoot`), so
    // derive the repo root from git when the caller omits it. When neither the
    // caller nor git can supply one (the worktree dir is already gone), the
    // teardown still proceeds — the directory removal is a no-op and the
    // registry record is archived below so the workspace leaves the sidebar.
    let result: Result<(), Value> = match worktree_path.as_deref() {
        Some(path) => {
            let resolved_root = match repo_root.as_deref() {
                Some(root) => Some(PathBuf::from(root)),
                None => derive_worktree_repo_root(Path::new(path)).await,
            };
            archive_worktree(resolved_root.as_deref(), Path::new(path))
                .await
                .map_err(|e| checkout_error("UNKNOWN", e.to_string()))
        }
        None => Err(checkout_error("UNKNOWN", "worktreePath is required")),
    };

    // Whether or not the git/FS teardown succeeded, archive the workspace
    // registry record so the worktree leaves the sidebar (matches the TS
    // `archiveWorkspaceRecord` step, which runs even when teardown throws a
    // `WorktreeTeardownError`; rocky-worktree-archive-service.ts:124-166). The
    // `fetch_workspaces` handler filters on `archived_at.is_none()`, so an
    // un-archived record would otherwise persist forever.
    if let Some(path) = worktree_path.as_deref() {
        let workspace_id = normalize_workspace_id(Path::new(path));
        let archived_at = now_iso8601();
        if let Ok(mut registry) = ctx.workspace_registry.lock() {
            if let Err(err) = registry.archive(&workspace_id, &archived_at) {
                tracing::warn!(error = %err, workspace_id, "failed to archive workspace record after worktree teardown");
            }
        }
    }

    Ok(match result {
        Ok(()) => json!({
            "type": "rocky_worktree_archive_response",
            "payload": { "success": true, "removedAgents": [], "error": Value::Null, "requestId": req_id }
        }),
        Err(error) => json!({
            "type": "rocky_worktree_archive_response",
            "payload": { "success": false, "removedAgents": [], "error": error, "requestId": req_id }
        }),
    })
}

// ---------------------------------------------------------------------------
// Terminal control handlers (JSON request/response only; STREAM frames are
// piped at the WS transport layer, see module docs).
// ---------------------------------------------------------------------------

async fn handle_create_terminal(
    ctx: &WorkspaceHandlerContext,
    msg: Value,
) -> Result<Value, SessionRpcError> {
    let req_id = request_id(&msg);
    let cwd = opt_str(&msg, "cwd").unwrap_or_default();
    let name = opt_str(&msg, "name");
    let command = opt_str(&msg, "command");
    let args = msg
        .get("args")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    let opts = CreateTerminalOptions {
        name: name.clone(),
        cwd: if cwd.is_empty() { None } else { Some(cwd.clone()) },
        command,
        args,
        ..Default::default()
    };

    Ok(match ctx.terminal_manager.create(opts) {
        Ok(created) => {
            let display_name = name.unwrap_or_else(|| format!("terminal-{}", created.slot));
            json!({
                "type": "create_terminal_response",
                "payload": {
                    "terminal": { "id": created.id, "name": display_name, "cwd": cwd },
                    "error": Value::Null,
                    "requestId": req_id,
                }
            })
        }
        Err(e) => json!({
            "type": "create_terminal_response",
            "payload": { "terminal": Value::Null, "error": e.to_string(), "requestId": req_id }
        }),
    })
}

async fn handle_list_terminals(
    ctx: &WorkspaceHandlerContext,
    msg: Value,
) -> Result<Value, SessionRpcError> {
    let req_id = request_id(&msg);
    let cwd = opt_str(&msg, "cwd");
    let terminals: Vec<Value> = ctx
        .terminal_manager
        .list()
        .into_iter()
        .map(|t| json!({ "id": t.id, "name": t.name }))
        .collect();

    let mut payload = json!({ "terminals": terminals, "requestId": req_id });
    if let Some(cwd) = cwd {
        payload["cwd"] = json!(cwd);
    }
    Ok(json!({ "type": "list_terminals_response", "payload": payload }))
}

/// `true` when `candidate` is `root` or a descendant of `root`, comparing
/// path components (mirrors TS `isSameOrDescendantPath`, used by
/// `TerminalManager.getTerminals` to surface terminals opened in subdirectories
/// of a subscribed workspace root).
fn is_same_or_descendant_path(root: &str, candidate: &str) -> bool {
    let root = Path::new(root);
    let candidate = Path::new(candidate);
    candidate == root || candidate.starts_with(root)
}

/// Snapshot the terminals at or below `cwd` as a `terminals_changed` message
/// payload (`{id, name}` per `TerminalInfoSchema.omit({cwd})`).
fn terminals_changed_for_cwd(ctx: &WorkspaceHandlerContext, cwd: &str) -> Vec<Value> {
    ctx.terminal_manager
        .list()
        .into_iter()
        .filter(|t| match t.cwd.as_deref() {
            Some(term_cwd) => is_same_or_descendant_path(cwd, term_cwd),
            None => false,
        })
        .map(|t| json!({ "id": t.id, "name": t.name }))
        .collect()
}

/// `subscribe_terminals_request` -> `terminals_changed` (messages.ts:3656-3662;
/// terminal-session-controller.ts:316-344). The TS controller adds the cwd to a
/// subscription set and emits an initial snapshot; the Rust daemon has no live
/// terminal-mutation broadcast yet, so it replies with the current snapshot for
/// the root. The directory subscription is implicit: every later snapshot is
/// recomputed from the manager, so there is no per-session set to maintain.
async fn handle_subscribe_terminals(
    ctx: &WorkspaceHandlerContext,
    msg: Value,
) -> Result<Value, SessionRpcError> {
    let cwd = opt_str(&msg, "cwd").unwrap_or_default();
    let terminals = terminals_changed_for_cwd(ctx, &cwd);
    Ok(json!({
        "type": "terminals_changed",
        "payload": { "cwd": cwd, "terminals": terminals }
    }))
}

/// `unsubscribe_terminals_request` -> internal ack (terminal-session-controller.ts
/// :321-323 returns void; the TS daemon emits no response message). Returns an
/// internal ack the WS transport leaves unhandled by the client, exactly like
/// `terminal_input` -> `terminal_input_ack`.
async fn handle_unsubscribe_terminals(
    _ctx: &WorkspaceHandlerContext,
    msg: Value,
) -> Result<Value, SessionRpcError> {
    let cwd = opt_str(&msg, "cwd").unwrap_or_default();
    Ok(json!({
        "type": "unsubscribe_terminals_ack",
        "payload": { "cwd": cwd }
    }))
}

async fn handle_kill_terminal(
    ctx: &WorkspaceHandlerContext,
    msg: Value,
) -> Result<Value, SessionRpcError> {
    let req_id = request_id(&msg);
    let terminal_id = opt_str(&msg, "terminalId").unwrap_or_default();
    let success = ctx.terminal_manager.kill(&terminal_id).is_ok();
    Ok(json!({
        "type": "kill_terminal_response",
        "payload": { "terminalId": terminal_id, "success": success, "requestId": req_id }
    }))
}

async fn handle_subscribe_terminal(
    ctx: &WorkspaceHandlerContext,
    msg: Value,
) -> Result<Value, SessionRpcError> {
    let req_id = request_id(&msg);
    let terminal_id = opt_str(&msg, "terminalId").unwrap_or_default();

    // Acknowledge the JSON control message by reporting the frame slot. Live
    // Output frames are delivered as binary WS frames by the transport layer
    // (it owns the `TerminalManager::subscribe` receiver); they are not emitted
    // from this dispatcher.
    let slot = ctx
        .terminal_manager
        .list()
        .into_iter()
        .find(|t| t.id == terminal_id)
        .map(|t| t.slot);

    let payload = match slot {
        Some(slot) => json!({
            "terminalId": terminal_id,
            "slot": slot,
            "error": Value::Null,
            "requestId": req_id,
        }),
        None => json!({
            "terminalId": terminal_id,
            "error": format!("terminal not found: {terminal_id}"),
            "requestId": req_id,
        }),
    };
    Ok(json!({ "type": "subscribe_terminal_response", "payload": payload }))
}

async fn handle_capture_terminal(
    ctx: &WorkspaceHandlerContext,
    msg: Value,
) -> Result<Value, SessionRpcError> {
    let req_id = request_id(&msg);
    let terminal_id = opt_str(&msg, "terminalId").unwrap_or_default();
    let strip = msg
        .get("stripAnsi")
        .and_then(Value::as_bool)
        .unwrap_or(true);

    let (lines, total) = match ctx.terminal_manager.capture(&terminal_id) {
        Ok(bytes) => {
            let text = String::from_utf8_lossy(&bytes).into_owned();
            let text = if strip { strip_ansi(&text) } else { text };
            let lines: Vec<Value> = text
                .split('\n')
                .map(|l| json!(l.trim_end_matches('\r')))
                .collect();
            let total = lines.len();
            (lines, total)
        }
        // `capture_terminal_response` has no error field; an unknown id yields
        // an empty capture.
        Err(_) => (Vec::new(), 0),
    };

    Ok(json!({
        "type": "capture_terminal_response",
        "payload": { "terminalId": terminal_id, "lines": lines, "totalLines": total, "requestId": req_id }
    }))
}

/// Fire-and-forget terminal control (`terminal_input`, messages.ts:1841-1845).
///
/// `input` writes to the pty master; `resize` applies an interactive resize
/// (passive resizes never arrive via this control path). There is no TS
/// response message for `terminal_input`, so this returns an internal
/// acknowledgement that the WS transport layer suppresses (does not forward to
/// the client). It exists only to satisfy the dispatcher's `Value` return.
async fn handle_terminal_input(
    ctx: &WorkspaceHandlerContext,
    msg: Value,
) -> Result<Value, SessionRpcError> {
    let terminal_id = opt_str(&msg, "terminalId").unwrap_or_default();
    let inner = msg.get("message").cloned().unwrap_or(Value::Null);
    let kind = inner.get("type").and_then(Value::as_str).unwrap_or("");

    let applied = match kind {
        "input" => {
            let data = inner.get("data").and_then(Value::as_str).unwrap_or("");
            ctx.terminal_manager
                .write_input(&terminal_id, data.as_bytes())
                .is_ok()
        }
        "resize" => {
            let rows = inner.get("rows").and_then(Value::as_u64).unwrap_or(0) as u16;
            let cols = inner.get("cols").and_then(Value::as_u64).unwrap_or(0) as u16;
            ctx.terminal_manager
                .resize(&terminal_id, rows, cols, true)
                .unwrap_or(false)
        }
        // `mouse` and unknown kinds have no PTY-byte mapping here.
        _ => false,
    };

    Ok(json!({
        "type": "terminal_input_ack",
        "payload": { "terminalId": terminal_id, "applied": applied }
    }))
}

/// Strip ANSI escape sequences (CSI `ESC [ ... final`, OSC `ESC ] ... BEL/ST`,
/// and lone two-byte escapes) for `capture_terminal_request` text output.
fn strip_ansi(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '\u{1b}' {
            out.push(c);
            continue;
        }
        match chars.peek().copied() {
            Some('[') => {
                chars.next();
                // CSI: consume params/intermediates until a final byte 0x40-0x7e.
                for next in chars.by_ref() {
                    if ('\u{40}'..='\u{7e}').contains(&next) {
                        break;
                    }
                }
            }
            Some(']') => {
                chars.next();
                // OSC: consume until BEL or ST (ESC \).
                while let Some(next) = chars.next() {
                    if next == '\u{07}' {
                        break;
                    }
                    if next == '\u{1b}' {
                        if chars.peek() == Some(&'\\') {
                            chars.next();
                        }
                        break;
                    }
                }
            }
            // Lone escape: drop the next byte (two-byte escape).
            Some(_) => {
                chars.next();
            }
            None => {}
        }
    }
    out
}
