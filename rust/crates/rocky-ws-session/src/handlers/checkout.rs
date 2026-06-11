//! Checkout / git-control session RPC handlers, matching the `checkout*`,
//! `stash_*`, and `branch_suggestions_request` cases in
//! `core/packages/server/src/server/session.ts` (dispatch table lines
//! ~2011-2057) and the response payload shapes in
//! `core/packages/protocol/src/messages.ts`.
//!
//! These back onto the primitive git wrapper in `rocky_workspaces::git`
//! (`run_git`, `current_branch`, `git_status_porcelain`, ...). The full daemon
//! has a `WorkspaceGitService` with caching, origin ahead/behind, and a live
//! `GitHubService`/`gh` CLI that this crate does not wire up. Operations that
//! require GitHub runtime (`checkout_pr_*`, `pull_request_timeline_request`,
//! `checkout.github.set_auto_merge.request`, `github_search_request`) return
//! the matching response shape with a structured error (`gh-not-wired`) rather
//! than a fabricated ok.
//!
//! ## Ownership note
//! `checkout_status_request` and `validate_branch_request` are NOT registered
//! here: `handlers::workspace` already owns those types. Registering them here
//! would create a duplicate (last-wins) registration. See the mount task.
//!
//! Request -> response `type` strings handled here:
//! - `checkout.refresh.request` -> `checkout.refresh.response`
//! - `subscribe_checkout_diff_request` -> `subscribe_checkout_diff_response`
//! - `unsubscribe_checkout_diff_request` -> internal ack (no TS response type;
//!   suppressed at the WS transport layer, like `terminal_input`).
//! - `checkout_commit_request` -> `checkout_commit_response`
//! - `checkout_push_request` -> `checkout_push_response`
//! - `checkout_pull_request` -> `checkout_pull_response`
//! - `checkout_switch_branch_request` -> `checkout_switch_branch_response`
//! - `checkout.rename_branch.request` -> `checkout.rename_branch.response`
//! - `checkout_merge_request` -> `checkout_merge_response`
//! - `checkout_merge_from_base_request` -> `checkout_merge_from_base_response`
//! - `stash_save_request` -> `stash_save_response`
//! - `stash_pop_request` -> `stash_pop_response`
//! - `stash_list_request` -> `stash_list_response`
//! - `branch_suggestions_request` -> `branch_suggestions_response`
//! - gh-not-wired: `checkout_pr_create_request`/`checkout_pr_merge_request`/
//!   `checkout_pr_status_request`/`pull_request_timeline_request`/
//!   `checkout.github.set_auto_merge.request`/`github_search_request`.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use rocky_workspaces::git::{self, GitOutput};
use rocky_workspaces::{validate_branch_slug, WorkspaceRegistry};
use serde_json::{json, Value};

use crate::dispatch::{SessionDispatcher, SessionRpcError};

/// Prefix the TS daemon tags rocky-created stashes with
/// (`Session.ROCKY_STASH_PREFIX`, session.ts:5062).
const ROCKY_STASH_PREFIX: &str = "rocky-auto-stash:";

/// Shared services the checkout handlers need.
///
/// `workspace_registry` resolves a `workspaceId` to a cwd when a message omits
/// `cwd` (the checkout request schemas all carry `cwd` directly, but the
/// registry lets the same handlers serve workspace-id-keyed callers). The
/// registry is file-backed and synchronous; the mutex serializes access.
#[derive(Clone)]
pub struct CheckoutContext {
    pub workspace_registry: Arc<Mutex<WorkspaceRegistry>>,
    /// `$ROCKY_HOME`; reserved for future config-derived resolution.
    pub rocky_home: PathBuf,
}

/// Register all checkout/git-control handlers onto the dispatcher.
///
/// Does NOT register `checkout_status_request` or `validate_branch_request`:
/// `handlers::workspace` owns those (avoids a duplicate registration).
pub fn register(dispatcher: &mut SessionDispatcher, ctx: CheckoutContext) {
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

    reg!("checkout.refresh.request", handle_refresh);
    reg!("subscribe_checkout_diff_request", handle_subscribe_diff);
    reg!("unsubscribe_checkout_diff_request", handle_unsubscribe_diff);
    reg!("checkout_commit_request", handle_commit);
    reg!("checkout_push_request", handle_push);
    reg!("checkout_pull_request", handle_pull);
    reg!("checkout_switch_branch_request", handle_switch_branch);
    reg!("checkout.rename_branch.request", handle_rename_branch);
    reg!("checkout_merge_request", handle_merge);
    reg!("checkout_merge_from_base_request", handle_merge_from_base);
    reg!("stash_save_request", handle_stash_save);
    reg!("stash_pop_request", handle_stash_pop);
    reg!("stash_list_request", handle_stash_list);
    reg!("branch_suggestions_request", handle_branch_suggestions);
    // GitHub-backed ops: not wired (no gh CLI / GitHubService here).
    reg!("checkout_pr_create_request", handle_pr_create);
    reg!("checkout_pr_merge_request", handle_pr_merge);
    reg!("checkout_pr_status_request", handle_pr_status);
    reg!("pull_request_timeline_request", handle_pr_timeline);
    reg!("checkout.github.set_auto_merge.request", handle_set_auto_merge);
    reg!("github_search_request", handle_github_search);
}

// ---------------------------------------------------------------------------
// Parse helpers (mirroring mission.rs / workspace.rs conventions).
// ---------------------------------------------------------------------------

fn request_id(msg: &Value) -> String {
    msg.get("requestId")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

fn opt_str(msg: &Value, key: &str) -> Option<String> {
    msg.get(key).and_then(Value::as_str).map(|s| s.to_string())
}

/// Expand a leading `~`/`~/` to `$HOME`, mirroring `expandTilde` in the TS
/// daemon (session.ts uses it before every git op).
fn expand_tilde(path: &str) -> String {
    if path == "~" {
        if let Ok(home) = std::env::var("HOME") {
            return home;
        }
        return path.to_string();
    }
    if let Some(rest) = path.strip_prefix("~/") {
        if let Ok(home) = std::env::var("HOME") {
            return format!("{home}/{rest}");
        }
    }
    path.to_string()
}

/// Resolve the working directory for a checkout op. Prefers an explicit `cwd`;
/// falls back to resolving a `workspaceId` through the registry. Returns the
/// tilde-expanded path string (always echoed back un-expanded as the original
/// `cwd` in the response, matching the TS daemon).
fn resolve_cwd(ctx: &CheckoutContext, msg: &Value) -> String {
    if let Some(cwd) = opt_str(msg, "cwd") {
        return cwd;
    }
    if let Some(workspace_id) = opt_str(msg, "workspaceId") {
        if let Ok(reg) = ctx.workspace_registry.lock() {
            if let Some(record) = reg.get(&workspace_id) {
                return record.cwd.clone();
            }
        }
    }
    String::new()
}

/// `{code, message}` checkout error object (`CheckoutErrorSchema`,
/// messages.ts:1365-1368). `code` is the `CheckoutErrorCodeSchema` enum:
/// `NOT_GIT_REPO` | `NOT_ALLOWED` | `MERGE_CONFLICT` | `UNKNOWN`.
fn checkout_error(code: &str, message: impl Into<String>) -> Value {
    json!({ "code": code, "message": message.into() })
}

/// Classify a failed `git` invocation into a `CheckoutError`, detecting merge
/// conflicts the way the TS conflict detectors do (`/CONFLICT|Automatic merge
/// failed/i`, checkout-git.ts:2458/2641).
fn git_failure_error(output: &GitOutput) -> Value {
    let combined = format!("{}\n{}", output.stderr, output.stdout);
    let lower = combined.to_lowercase();
    if lower.contains("conflict") || lower.contains("automatic merge failed") {
        return checkout_error("MERGE_CONFLICT", combined.trim().to_string());
    }
    let message = output.stderr.trim();
    let message = if message.is_empty() {
        output.stdout.trim()
    } else {
        message
    };
    checkout_error("UNKNOWN", message.to_string())
}

/// Map a [`git::GitError`] (spawn failure / not-a-repo) onto a `CheckoutError`.
fn git_error_to_checkout(err: &git::GitError) -> Value {
    match err {
        git::GitError::NotARepository { .. } => checkout_error("NOT_GIT_REPO", err.to_string()),
        other => checkout_error("UNKNOWN", other.to_string()),
    }
}

/// Structured `gh-not-wired` checkout error for GitHub-backed operations.
fn gh_not_wired_error() -> Value {
    checkout_error(
        "NOT_ALLOWED",
        "gh-not-wired: GitHub operations require the gh CLI / GitHubService, \
         which is not available in the Rust daemon",
    )
}

/// `{cwd, success, error, requestId}` response shared by commit/push/pull/
/// merge/merge-from-base/refresh.
fn success_or_error_response(
    msg_type: &str,
    cwd: &str,
    req_id: &str,
    result: Result<(), Value>,
) -> Value {
    match result {
        Ok(()) => json!({ "type": msg_type, "payload": {
            "cwd": cwd, "success": true, "error": Value::Null, "requestId": req_id } }),
        Err(error) => json!({ "type": msg_type, "payload": {
            "cwd": cwd, "success": false, "error": error, "requestId": req_id } }),
    }
}

/// Run `git` in `cwd`, mapping spawn errors / non-zero exits onto
/// `CheckoutError`. `Ok(output)` is only returned for a zero exit.
async fn run_git_ok(cwd: &Path, args: &[&str]) -> Result<GitOutput, Value> {
    let output = git::run_git(cwd, args)
        .await
        .map_err(|e| git_error_to_checkout(&e))?;
    if output.success() {
        Ok(output)
    } else {
        Err(git_failure_error(&output))
    }
}

/// Resolve the current branch name, erroring like the TS helpers when the repo
/// is in a detached-HEAD state.
async fn require_current_branch(cwd: &Path) -> Result<String, Value> {
    let output = run_git_ok(cwd, &["rev-parse", "--abbrev-ref", "HEAD"]).await?;
    let branch = output.stdout.trim().to_string();
    if branch.is_empty() || branch == "HEAD" {
        return Err(checkout_error(
            "UNKNOWN",
            "Unable to determine current branch",
        ));
    }
    Ok(branch)
}

/// Whether an `origin` remote is configured (`git remote get-url origin`),
/// mirroring `hasOriginRemote` in the TS daemon.
async fn has_origin_remote(cwd: &Path) -> bool {
    git::run_git(cwd, ["remote", "get-url", "origin"])
        .await
        .map(|o| o.success())
        .unwrap_or(false)
}

// ---------------------------------------------------------------------------
// Read / refresh.
// ---------------------------------------------------------------------------

/// `checkout.refresh.request` -> `checkout.refresh.response`
/// (session.ts:5340-5373; messages.ts:3151-3159). The TS handler force-refreshes
/// the git/GitHub snapshot cache; here we re-read status to confirm the cwd is a
/// live repo, then ack.
async fn handle_refresh(ctx: &CheckoutContext, msg: Value) -> Result<Value, SessionRpcError> {
    let req_id = request_id(&msg);
    let cwd = resolve_cwd(ctx, &msg);
    let path = PathBuf::from(expand_tilde(&cwd));

    let result = match git::git_status_porcelain(&path).await {
        Ok(_) => Ok(()),
        Err(e) => Err(git_error_to_checkout(&e)),
    };
    Ok(success_or_error_response(
        "checkout.refresh.response",
        &cwd,
        &req_id,
        result,
    ))
}

/// `subscribe_checkout_diff_request` -> `subscribe_checkout_diff_response`
/// (session.ts:4907-4935; messages.ts:3082-3094).
///
/// Live diff streaming (`checkout_diff_update`) is a transport concern handled
/// at the WS mount layer, not here. This returns the initial ack shape with an
/// empty `files` array (the primitive wrapper does not compute the parsed diff
/// tree). A real `repoRoot` error surfaces as a non-null `error`.
async fn handle_subscribe_diff(
    ctx: &CheckoutContext,
    msg: Value,
) -> Result<Value, SessionRpcError> {
    let req_id = request_id(&msg);
    let cwd = resolve_cwd(ctx, &msg);
    let subscription_id = opt_str(&msg, "subscriptionId").unwrap_or_default();
    let path = PathBuf::from(expand_tilde(&cwd));

    let error = match git::is_inside_work_tree(&path).await {
        Ok(true) => Value::Null,
        Ok(false) => checkout_error("NOT_GIT_REPO", format!("Not a git repository: {cwd}")),
        Err(e) => git_error_to_checkout(&e),
    };

    Ok(json!({
        "type": "subscribe_checkout_diff_response",
        "payload": {
            "subscriptionId": subscription_id,
            "cwd": cwd,
            "files": Value::Array(vec![]),
            "error": error,
            "requestId": req_id,
        }
    }))
}

/// `unsubscribe_checkout_diff_request` has NO TS response type
/// (session.ts:4937-4940 returns void). Like `terminal_input`, this returns an
/// internal ack that the WS transport layer suppresses (never forwarded to the
/// client); it exists only to satisfy the dispatcher's `Value` return.
async fn handle_unsubscribe_diff(
    _ctx: &CheckoutContext,
    msg: Value,
) -> Result<Value, SessionRpcError> {
    let subscription_id = opt_str(&msg, "subscriptionId").unwrap_or_default();
    Ok(json!({
        "type": "unsubscribe_checkout_diff_ack",
        "payload": { "subscriptionId": subscription_id }
    }))
}

// ---------------------------------------------------------------------------
// Safe mutations via run_git.
// ---------------------------------------------------------------------------

/// `checkout_commit_request` -> `checkout_commit_response`
/// (session.ts:5132-5173; messages.ts:3101-3109). The TS handler can generate a
/// commit message via an LLM when blank; the Rust daemon cannot, so a blank
/// message is an error (mirroring the `Commit message is required` throw).
async fn handle_commit(ctx: &CheckoutContext, msg: Value) -> Result<Value, SessionRpcError> {
    let req_id = request_id(&msg);
    let cwd = resolve_cwd(ctx, &msg);
    let path = PathBuf::from(expand_tilde(&cwd));
    let message = opt_str(&msg, "message").map(|m| m.trim().to_string());
    let add_all = msg.get("addAll").and_then(Value::as_bool).unwrap_or(true);

    let result = commit_inner(&path, message, add_all).await;
    Ok(success_or_error_response(
        "checkout_commit_response",
        &cwd,
        &req_id,
        result,
    ))
}

async fn commit_inner(path: &Path, message: Option<String>, add_all: bool) -> Result<(), Value> {
    let message = match message {
        Some(m) if !m.is_empty() => m,
        _ => return Err(checkout_error("UNKNOWN", "Commit message is required")),
    };
    // requireGitRepo equivalent.
    git::is_inside_work_tree(path)
        .await
        .map_err(|e| git_error_to_checkout(&e))
        .and_then(|inside| {
            if inside {
                Ok(())
            } else {
                Err(checkout_error(
                    "NOT_GIT_REPO",
                    format!("Not a git repository: {}", path.display()),
                ))
            }
        })?;
    if add_all {
        run_git_ok(path, &["add", "-A"]).await?;
    }
    run_git_ok(
        path,
        &["-c", "commit.gpgsign=false", "commit", "-m", &message],
    )
    .await?;
    Ok(())
}

/// `checkout_push_request` -> `checkout_push_response`
/// (session.ts:5310-5338; messages.ts:3141-3149). Mirrors `pushCurrentBranch`:
/// `git push -u origin <branch>`, erroring when detached or no origin remote.
async fn handle_push(ctx: &CheckoutContext, msg: Value) -> Result<Value, SessionRpcError> {
    let req_id = request_id(&msg);
    let cwd = resolve_cwd(ctx, &msg);
    let path = PathBuf::from(expand_tilde(&cwd));

    let result = async {
        let branch = require_current_branch(&path).await?;
        if !has_origin_remote(&path).await {
            return Err(checkout_error(
                "UNKNOWN",
                "Remote 'origin' is not configured.",
            ));
        }
        run_git_ok(&path, &["push", "-u", "origin", &branch]).await?;
        Ok(())
    }
    .await;
    Ok(success_or_error_response(
        "checkout_push_response",
        &cwd,
        &req_id,
        result,
    ))
}

/// `checkout_pull_request` -> `checkout_pull_response`
/// (session.ts:5278-5308; messages.ts:3131-3139). Mirrors `pullCurrentBranch`.
async fn handle_pull(ctx: &CheckoutContext, msg: Value) -> Result<Value, SessionRpcError> {
    let req_id = request_id(&msg);
    let cwd = resolve_cwd(ctx, &msg);
    let path = PathBuf::from(expand_tilde(&cwd));

    let result = async {
        require_current_branch(&path).await?;
        if !has_origin_remote(&path).await {
            return Err(checkout_error(
                "UNKNOWN",
                "Remote 'origin' is not configured.",
            ));
        }
        run_git_ok(&path, &["pull"]).await?;
        Ok(())
    }
    .await;
    Ok(success_or_error_response(
        "checkout_pull_response",
        &cwd,
        &req_id,
        result,
    ))
}

/// `checkout_switch_branch_request` -> `checkout_switch_branch_response`
/// (session.ts:4968-5004; messages.ts:3279-3289). Mirrors
/// `checkoutResolvedBranch` (checkout-git.ts:378-402): checkout a local branch
/// (`source: "local"`), else create-tracking from `origin/<branch>`
/// (`source: "remote"`), else not-found.
async fn handle_switch_branch(
    ctx: &CheckoutContext,
    msg: Value,
) -> Result<Value, SessionRpcError> {
    let req_id = request_id(&msg);
    let cwd = resolve_cwd(ctx, &msg);
    let branch = opt_str(&msg, "branch").unwrap_or_default();
    let path = PathBuf::from(expand_tilde(&cwd));

    match switch_branch_inner(&path, &branch).await {
        Ok(source) => Ok(json!({ "type": "checkout_switch_branch_response", "payload": {
            "cwd": cwd, "success": true, "branch": branch, "source": source,
            "error": Value::Null, "requestId": req_id } })),
        Err(error) => Ok(json!({ "type": "checkout_switch_branch_response", "payload": {
            "cwd": cwd, "success": false, "branch": branch,
            "error": error, "requestId": req_id } })),
    }
}

async fn switch_branch_inner(path: &Path, branch: &str) -> Result<&'static str, Value> {
    if branch.is_empty() {
        return Err(checkout_error("UNKNOWN", "Branch is required"));
    }
    // Already on this branch? `checkoutResolvedBranch` short-circuits.
    if let Ok(current) = require_current_branch(path).await {
        if current == branch {
            return Ok("local");
        }
    }
    let local_ref = format!("refs/heads/{branch}");
    let has_local = git::run_git(path, ["rev-parse", "--verify", "--quiet", &local_ref])
        .await
        .map(|o| o.success())
        .unwrap_or(false);
    if has_local {
        run_git_ok(path, &["checkout", branch]).await?;
        return Ok("local");
    }
    let remote_ref = format!("refs/remotes/origin/{branch}");
    let origin_ref = format!("origin/{branch}");
    let has_remote = git::run_git(path, ["rev-parse", "--verify", "--quiet", &remote_ref])
        .await
        .map(|o| o.success())
        .unwrap_or(false);
    if has_remote {
        run_git_ok(path, &["checkout", "-b", branch, "--track", &origin_ref]).await?;
        return Ok("remote");
    }
    Err(checkout_error("UNKNOWN", format!("Branch not found: {branch}")))
}

/// `checkout.rename_branch.request` -> `checkout.rename_branch.response`
/// (session.ts:5006-5056; messages.ts:3291-3300). Validates the slug, then
/// `git branch -m <branch>`.
async fn handle_rename_branch(
    ctx: &CheckoutContext,
    msg: Value,
) -> Result<Value, SessionRpcError> {
    let req_id = request_id(&msg);
    let cwd = resolve_cwd(ctx, &msg);
    let branch = opt_str(&msg, "branch").unwrap_or_default();
    let path = PathBuf::from(expand_tilde(&cwd));

    let validation = validate_branch_slug(&branch);
    if !validation.valid {
        let message = validation.error.unwrap_or_else(|| "Invalid branch name".to_string());
        return Ok(json!({ "type": "checkout.rename_branch.response", "payload": {
            "requestId": req_id, "success": false, "cwd": cwd,
            "currentBranch": Value::Null, "error": checkout_error("UNKNOWN", message) } }));
    }

    match rename_branch_inner(&path, &branch).await {
        Ok(current_branch) => Ok(json!({ "type": "checkout.rename_branch.response", "payload": {
            "requestId": req_id, "success": true, "cwd": cwd,
            "currentBranch": current_branch, "error": Value::Null } })),
        Err(error) => Ok(json!({ "type": "checkout.rename_branch.response", "payload": {
            "requestId": req_id, "success": false, "cwd": cwd,
            "currentBranch": Value::Null, "error": error } })),
    }
}

async fn rename_branch_inner(path: &Path, new_name: &str) -> Result<String, Value> {
    let previous = require_current_branch(path).await?;
    if previous == "HEAD" {
        return Err(checkout_error(
            "UNKNOWN",
            "Cannot rename branch in detached HEAD state",
        ));
    }
    run_git_ok(path, &["branch", "-m", new_name]).await?;
    // Re-read the current branch (matches `renameCurrentBranch`).
    require_current_branch(path).await
}

/// `checkout_merge_request` -> `checkout_merge_response`
/// (session.ts:5175-5234; messages.ts:3111-3119). Merges the current branch into
/// `baseRef` (`mergeToBase`): checkout base, `git merge [--squash] <current>`.
/// `baseRef` is required here (the primitive wrapper cannot derive a stored
/// base ref like the full snapshot service).
async fn handle_merge(ctx: &CheckoutContext, msg: Value) -> Result<Value, SessionRpcError> {
    let req_id = request_id(&msg);
    let cwd = resolve_cwd(ctx, &msg);
    let path = PathBuf::from(expand_tilde(&cwd));
    let base_ref = opt_str(&msg, "baseRef");
    let squash = opt_str(&msg, "strategy").as_deref() == Some("squash");
    let require_clean = msg
        .get("requireCleanTarget")
        .and_then(Value::as_bool)
        .unwrap_or(false);

    let result = merge_inner(&path, base_ref, squash, require_clean).await;
    Ok(success_or_error_response(
        "checkout_merge_response",
        &cwd,
        &req_id,
        result,
    ))
}

async fn merge_inner(
    path: &Path,
    base_ref: Option<String>,
    squash: bool,
    require_clean: bool,
) -> Result<(), Value> {
    let porcelain = git::git_status_porcelain(path)
        .await
        .map_err(|e| git_error_to_checkout(&e))?;
    if require_clean && !porcelain.trim().is_empty() {
        return Err(checkout_error(
            "UNKNOWN",
            "Working directory has uncommitted changes.",
        ));
    }
    let mut base_ref = match base_ref {
        Some(b) if !b.is_empty() => b,
        _ => return Err(checkout_error("UNKNOWN", "Base branch is required for merge")),
    };
    if let Some(stripped) = base_ref.strip_prefix("origin/") {
        base_ref = stripped.to_string();
    }
    let current = require_current_branch(path).await?;
    if base_ref == current {
        return Ok(());
    }
    run_git_ok(path, &["checkout", &base_ref]).await?;
    if squash {
        run_git_ok(path, &["merge", "--squash", &current]).await?;
        let message = format!("Squash merge {current} into {base_ref}");
        run_git_ok(
            path,
            &["-c", "commit.gpgsign=false", "commit", "-m", &message],
        )
        .await?;
    } else {
        run_git_ok(path, &["merge", &current]).await?;
    }
    Ok(())
}

/// `checkout_merge_from_base_request` -> `checkout_merge_from_base_response`
/// (session.ts:5236-5276; messages.ts:3121-3129). Merges `baseRef` into the
/// current branch (`mergeFromBase`): `git merge <baseRef>`.
async fn handle_merge_from_base(
    ctx: &CheckoutContext,
    msg: Value,
) -> Result<Value, SessionRpcError> {
    let req_id = request_id(&msg);
    let cwd = resolve_cwd(ctx, &msg);
    let path = PathBuf::from(expand_tilde(&cwd));
    let base_ref = opt_str(&msg, "baseRef");
    let require_clean = msg
        .get("requireCleanTarget")
        .and_then(Value::as_bool)
        .unwrap_or(true);

    let result = merge_from_base_inner(&path, base_ref, require_clean).await;
    Ok(success_or_error_response(
        "checkout_merge_from_base_response",
        &cwd,
        &req_id,
        result,
    ))
}

async fn merge_from_base_inner(
    path: &Path,
    base_ref: Option<String>,
    require_clean: bool,
) -> Result<(), Value> {
    let current = require_current_branch(path).await?;
    let mut base_ref = match base_ref {
        Some(b) if !b.is_empty() => b,
        _ => return Err(checkout_error("UNKNOWN", "Base branch is required for merge")),
    };
    if require_clean {
        let porcelain = git::git_status_porcelain(path)
            .await
            .map_err(|e| git_error_to_checkout(&e))?;
        if !porcelain.trim().is_empty() {
            return Err(checkout_error(
                "UNKNOWN",
                "Working directory has uncommitted changes.",
            ));
        }
    }
    if let Some(stripped) = base_ref.strip_prefix("origin/") {
        base_ref = stripped.to_string();
    }
    if base_ref == current {
        return Ok(());
    }
    run_git_ok(path, &["merge", &base_ref]).await?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Stash.
// ---------------------------------------------------------------------------

/// `stash_save_request` -> `stash_save_response`
/// (session.ts:5064-5088; messages.ts:3309-3317). Tags the stash with the rocky
/// prefix so `stash_list_request` can filter to rocky-created stashes.
async fn handle_stash_save(ctx: &CheckoutContext, msg: Value) -> Result<Value, SessionRpcError> {
    let req_id = request_id(&msg);
    let cwd = resolve_cwd(ctx, &msg);
    let path = PathBuf::from(expand_tilde(&cwd));
    let branch_label = opt_str(&msg, "branch").map(|b| b.trim().to_string());
    let label = match branch_label {
        Some(b) if !b.is_empty() => b,
        _ => "unnamed".to_string(),
    };
    let message = format!("{ROCKY_STASH_PREFIX} {label}");

    let result = run_git_ok(
        &path,
        &["stash", "push", "--include-untracked", "-m", &message],
    )
    .await
    .map(|_| ());
    Ok(success_or_error_response(
        "stash_save_response",
        &cwd,
        &req_id,
        result,
    ))
}

/// `stash_pop_request` -> `stash_pop_response`
/// (session.ts:5090-5110; messages.ts:3319-3327). `git stash pop stash@{N}`.
async fn handle_stash_pop(ctx: &CheckoutContext, msg: Value) -> Result<Value, SessionRpcError> {
    let req_id = request_id(&msg);
    let cwd = resolve_cwd(ctx, &msg);
    let path = PathBuf::from(expand_tilde(&cwd));
    let stash_index = msg.get("stashIndex").and_then(Value::as_u64).unwrap_or(0);
    let stash_ref = format!("stash@{{{stash_index}}}");

    let result = run_git_ok(&path, &["stash", "pop", &stash_ref])
        .await
        .map(|_| ());
    Ok(success_or_error_response(
        "stash_pop_response",
        &cwd,
        &req_id,
        result,
    ))
}

/// `stash_list_request` -> `stash_list_response`
/// (session.ts:5112-5130; messages.ts:3329-3337). Lists stashes via
/// `git stash list --format=%gd%x00%s`, parsing index/message/branch/isRocky
/// like `parseWorkspaceGitStashList` (workspace-git-service.ts:1941-1975).
async fn handle_stash_list(ctx: &CheckoutContext, msg: Value) -> Result<Value, SessionRpcError> {
    let req_id = request_id(&msg);
    let cwd = resolve_cwd(ctx, &msg);
    let path = PathBuf::from(expand_tilde(&cwd));
    // `rockyOnly` defaults to true (session.ts:5116).
    let rocky_only = msg.get("rockyOnly").and_then(Value::as_bool).unwrap_or(true);

    match run_git_ok(&path, &["stash", "list", "--format=%gd%x00%s"]).await {
        Ok(output) => {
            let entries = parse_stash_list(&output.stdout, rocky_only);
            Ok(json!({ "type": "stash_list_response", "payload": {
                "cwd": cwd, "entries": entries, "error": Value::Null, "requestId": req_id } }))
        }
        Err(error) => Ok(json!({ "type": "stash_list_response", "payload": {
            "cwd": cwd, "entries": Value::Array(vec![]), "error": error, "requestId": req_id } })),
    }
}

/// Parse `git stash list --format=%gd%x00%s` output into `StashEntry`s
/// (`StashEntrySchema`, messages.ts:3302-3307).
fn parse_stash_list(stdout: &str, rocky_only: bool) -> Vec<Value> {
    let mut entries = Vec::new();
    for line in stdout.trim().split('\n').filter(|l| !l.is_empty()) {
        let Some(sep_idx) = line.find('\0') else {
            continue;
        };
        let ref_part = &line[..sep_idx];
        let subject = &line[sep_idx + 1..];
        // Extract the `{N}` index from e.g. `stash@{0}`.
        let Some(index) = parse_stash_index(ref_part) else {
            continue;
        };
        let prefix_idx = subject.find(ROCKY_STASH_PREFIX);
        let is_rocky = prefix_idx.is_some();
        let branch = prefix_idx.and_then(|idx| {
            let rest = subject[idx + ROCKY_STASH_PREFIX.len()..].trim();
            if rest.is_empty() {
                None
            } else {
                Some(rest.to_string())
            }
        });
        if rocky_only && !is_rocky {
            continue;
        }
        entries.push(json!({
            "index": index,
            "message": subject,
            "branch": branch,
            "isRocky": is_rocky,
        }));
    }
    entries
}

/// Extract the integer inside `{...}` from a stash ref like `stash@{3}`.
fn parse_stash_index(ref_part: &str) -> Option<u64> {
    let start = ref_part.find('{')?;
    let end = ref_part[start..].find('}')? + start;
    ref_part[start + 1..end].parse().ok()
}

// ---------------------------------------------------------------------------
// Branch suggestions.
// ---------------------------------------------------------------------------

/// `branch_suggestions_request` -> `branch_suggestions_response`
/// (session.ts:4655-4686; messages.ts:3350-3367). Lists local + remote branches
/// via `git for-each-ref`, applies an optional substring `query` and `limit`,
/// and reports `branchDetails` with committer dates.
async fn handle_branch_suggestions(
    ctx: &CheckoutContext,
    msg: Value,
) -> Result<Value, SessionRpcError> {
    let req_id = request_id(&msg);
    let cwd = resolve_cwd(ctx, &msg);
    let path = PathBuf::from(expand_tilde(&cwd));
    let query = opt_str(&msg, "query").map(|q| q.to_lowercase());
    let limit = msg
        .get("limit")
        .and_then(Value::as_u64)
        .map(|n| n as usize);

    match suggest_branches(&path, query.as_deref(), limit).await {
        Ok((branches, details)) => Ok(json!({ "type": "branch_suggestions_response", "payload": {
            "branches": branches, "branchDetails": details,
            "error": Value::Null, "requestId": req_id } })),
        Err(message) => Ok(json!({ "type": "branch_suggestions_response", "payload": {
            "branches": Value::Array(vec![]), "branchDetails": Value::Array(vec![]),
            "error": message, "requestId": req_id } })),
    }
}

#[allow(clippy::type_complexity)]
async fn suggest_branches(
    path: &Path,
    query: Option<&str>,
    limit: Option<usize>,
) -> Result<(Vec<String>, Vec<Value>), String> {
    let output = git::run_git(
        path,
        [
            "for-each-ref",
            "--sort=-committerdate",
            "--format=%(refname:short)%00%(committerdate:unix)%00%(objecttype)",
            "refs/heads",
            "refs/remotes",
        ],
    )
    .await
    .map_err(|e| e.to_string())?;
    if !output.success() {
        return Err(output.stderr.trim().to_string());
    }

    // Merge local/remote refs by short name; remember which kinds were seen.
    let mut order: Vec<String> = Vec::new();
    let mut seen: std::collections::HashMap<String, (i64, bool, bool)> =
        std::collections::HashMap::new();
    for line in output.stdout.lines().filter(|l| !l.is_empty()) {
        let mut parts = line.split('\0');
        let raw_name = parts.next().unwrap_or("");
        let date: i64 = parts.next().unwrap_or("0").parse().unwrap_or(0);
        if raw_name.is_empty() || raw_name.ends_with("/HEAD") {
            continue;
        }
        let (name, is_remote) = match raw_name.strip_prefix("origin/") {
            Some(rest) => (rest.to_string(), true),
            None => (raw_name.to_string(), false),
        };
        if name.is_empty() {
            continue;
        }
        let entry = seen.entry(name.clone()).or_insert_with(|| {
            order.push(name.clone());
            (date, false, false)
        });
        entry.0 = entry.0.max(date);
        if is_remote {
            entry.2 = true;
        } else {
            entry.1 = true;
        }
    }

    let mut branches: Vec<String> = Vec::new();
    let mut details: Vec<Value> = Vec::new();
    for name in order {
        if let Some(q) = query {
            if !name.to_lowercase().contains(q) {
                continue;
            }
        }
        let (date, has_local, has_remote) = seen[&name];
        branches.push(name.clone());
        details.push(json!({
            "name": name,
            "committerDate": date,
            "hasLocal": has_local,
            "hasRemote": has_remote,
        }));
        if let Some(max) = limit {
            if branches.len() >= max {
                break;
            }
        }
    }
    Ok((branches, details))
}

// ---------------------------------------------------------------------------
// GitHub-backed ops: not wired (return structured gh-not-wired error).
// ---------------------------------------------------------------------------

/// `checkout_pr_create_request` -> `checkout_pr_create_response`
/// (session.ts:5375-5423; messages.ts:3161-3170). GitHub not wired.
async fn handle_pr_create(ctx: &CheckoutContext, msg: Value) -> Result<Value, SessionRpcError> {
    let req_id = request_id(&msg);
    let cwd = resolve_cwd(ctx, &msg);
    Ok(json!({ "type": "checkout_pr_create_response", "payload": {
        "cwd": cwd, "url": Value::Null, "number": Value::Null,
        "error": gh_not_wired_error(), "requestId": req_id } }))
}

/// `checkout_pr_merge_request` -> `checkout_pr_merge_response`
/// (session.ts:5425-5465; messages.ts:3172-3180). GitHub not wired.
async fn handle_pr_merge(ctx: &CheckoutContext, msg: Value) -> Result<Value, SessionRpcError> {
    let req_id = request_id(&msg);
    let cwd = resolve_cwd(ctx, &msg);
    Ok(json!({ "type": "checkout_pr_merge_response", "payload": {
        "cwd": cwd, "success": false, "error": gh_not_wired_error(), "requestId": req_id } }))
}

/// `checkout_pr_status_request` -> `checkout_pr_status_response`
/// (session.ts:5557-5584; `CheckoutPrStatusPayloadSchema`, messages.ts:3059-3065,
/// 3193-3196). GitHub not wired: `githubFeaturesEnabled: false`.
async fn handle_pr_status(ctx: &CheckoutContext, msg: Value) -> Result<Value, SessionRpcError> {
    let req_id = request_id(&msg);
    let cwd = resolve_cwd(ctx, &msg);
    Ok(json!({ "type": "checkout_pr_status_response", "payload": {
        "cwd": cwd, "status": Value::Null, "githubFeaturesEnabled": false,
        "error": gh_not_wired_error(), "requestId": req_id } }))
}

/// `pull_request_timeline_request` -> `pull_request_timeline_response`
/// (session.ts:5586-5665; messages.ts:3263-3277). GitHub not wired. The timeline
/// `error` uses the `{kind, message}` shape (`PullRequestTimelineErrorSchema`),
/// NOT the `{code, message}` checkout error.
async fn handle_pr_timeline(ctx: &CheckoutContext, msg: Value) -> Result<Value, SessionRpcError> {
    let req_id = request_id(&msg);
    let cwd = resolve_cwd(ctx, &msg);
    let pr_number = msg.get("prNumber").cloned().unwrap_or(Value::Null);
    Ok(json!({ "type": "pull_request_timeline_response", "payload": {
        "cwd": cwd,
        "prNumber": pr_number,
        "items": Value::Array(vec![]),
        "truncated": false,
        "error": { "kind": "unknown", "message":
            "gh-not-wired: GitHub CLI / GitHubService is unavailable in the Rust daemon" },
        "requestId": req_id,
        "githubFeaturesEnabled": false,
    } }))
}

/// `checkout.github.set_auto_merge.request` ->
/// `checkout.github.set_auto_merge.response` (session.ts:5475-5542;
/// messages.ts:3182-3191). GitHub not wired.
async fn handle_set_auto_merge(
    ctx: &CheckoutContext,
    msg: Value,
) -> Result<Value, SessionRpcError> {
    let req_id = request_id(&msg);
    let cwd = resolve_cwd(ctx, &msg);
    let enabled = msg.get("enabled").and_then(Value::as_bool).unwrap_or(false);
    Ok(json!({ "type": "checkout.github.set_auto_merge.response", "payload": {
        "cwd": cwd, "enabled": enabled, "success": false,
        "error": gh_not_wired_error(), "requestId": req_id } }))
}

/// `github_search_request` -> `github_search_response`
/// (session.ts:4688-4721; messages.ts:3369-3377). GitHub not wired. The `error`
/// field here is a plain string (`z.string().nullable()`), not a checkout error.
async fn handle_github_search(
    _ctx: &CheckoutContext,
    msg: Value,
) -> Result<Value, SessionRpcError> {
    let req_id = request_id(&msg);
    Ok(json!({ "type": "github_search_response", "payload": {
        "items": Value::Array(vec![]),
        "githubFeaturesEnabled": false,
        "error": "gh-not-wired: GitHub search requires the gh CLI / GitHubService, \
                  which is not available in the Rust daemon",
        "requestId": req_id,
    } }))
}
