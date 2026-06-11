//! Integration tests for the workspace/git/worktree/terminal session RPC
//! handlers. Exercises the dispatcher end-to-end (envelope wrap/unwrap) with a
//! temp `$ROCKY_HOME`, a real temp git repo, and a real PTY-backed terminal.
//!
//! Response `type` strings and payload field names are asserted against the TS
//! protocol (`core/packages/protocol/src/messages.ts`).

use std::path::Path;
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use rocky_terminal::TerminalManager;
use rocky_workspaces::{ProjectRegistry, WorkspaceRegistry};
use rocky_ws_session::handlers::workspace::{register, WorkspaceHandlerContext};
use rocky_ws_session::SessionDispatcher;
use serde_json::{json, Value};

fn build_dispatcher(rocky_home: &Path) -> (SessionDispatcher, Arc<TerminalManager>) {
    let workspace_registry = Arc::new(Mutex::new(WorkspaceRegistry::load(rocky_home)));
    let project_registry = Arc::new(Mutex::new(ProjectRegistry::load(rocky_home)));
    let terminal_manager = Arc::new(TerminalManager::new());
    let ctx = WorkspaceHandlerContext {
        workspace_registry,
        project_registry,
        terminal_manager: terminal_manager.clone(),
        rocky_home: rocky_home.to_path_buf(),
        worktrees_root: None,
    };
    let mut dispatcher = SessionDispatcher::new();
    register(&mut dispatcher, ctx);
    (dispatcher, terminal_manager)
}

/// Wrap an inner message, dispatch, and return the unwrapped inner response.
async fn dispatch(dispatcher: &SessionDispatcher, inner: Value) -> Value {
    let env = json!({ "type": "session", "message": inner });
    let out = dispatcher
        .dispatch_envelope(&env)
        .await
        .expect("dispatch ok");
    assert_eq!(out["type"], "session", "outbound envelope type");
    out["message"].clone()
}

fn run_git(repo: &Path, args: &[&str]) {
    let status = Command::new("git")
        .args(args)
        .current_dir(repo)
        .status()
        .expect("spawn git");
    assert!(status.success(), "git {args:?} failed");
}

/// Initialize a real git repo with one commit so worktree/status operations work.
fn init_repo(repo: &Path) {
    run_git(repo, &["init", "-q", "-b", "main"]);
    run_git(repo, &["config", "user.email", "test@example.com"]);
    run_git(repo, &["config", "user.name", "Test"]);
    run_git(repo, &["config", "commit.gpgsign", "false"]);
    std::fs::write(repo.join("README.md"), "hello\n").unwrap();
    run_git(repo, &["add", "."]);
    run_git(repo, &["commit", "-q", "-m", "init"]);
}

#[tokio::test]
async fn fetch_workspaces_empty_registry_returns_empty_list() {
    let home = tempfile::tempdir().unwrap();
    let (dispatcher, _term) = build_dispatcher(home.path());

    let resp = dispatch(
        &dispatcher,
        json!({ "type": "fetch_workspaces_request", "requestId": "r-fetch" }),
    )
    .await;

    assert_eq!(resp["type"], "fetch_workspaces_response");
    assert_eq!(resp["payload"]["requestId"], "r-fetch");
    assert_eq!(resp["payload"]["entries"], json!([]));
    assert_eq!(resp["payload"]["pageInfo"]["hasMore"], false);
    assert_eq!(resp["payload"]["pageInfo"]["nextCursor"], Value::Null);
}

#[tokio::test]
async fn validate_branch_reports_valid_and_invalid() {
    let home = tempfile::tempdir().unwrap();
    let (dispatcher, _term) = build_dispatcher(home.path());

    // Valid slug: lowercase, hyphen, slash.
    let ok = dispatch(
        &dispatcher,
        json!({ "type": "validate_branch_request", "cwd": "/tmp", "branchName": "feature/login-flow", "requestId": "r-ok" }),
    )
    .await;
    assert_eq!(ok["type"], "validate_branch_response");
    assert_eq!(ok["payload"]["requestId"], "r-ok");
    assert_eq!(ok["payload"]["error"], Value::Null);
    assert_eq!(ok["payload"]["isRemote"], false);

    // Invalid: uppercase + consecutive-hyphen rule rejects it.
    let bad = dispatch(
        &dispatcher,
        json!({ "type": "validate_branch_request", "cwd": "/tmp", "branchName": "Feature", "requestId": "r-bad" }),
    )
    .await;
    assert_eq!(bad["payload"]["requestId"], "r-bad");
    assert!(
        bad["payload"]["error"].is_string(),
        "invalid slug must carry an error message"
    );
    assert_eq!(bad["payload"]["exists"], false);

    // Empty slug -> the "cannot be empty" rule.
    let empty = dispatch(
        &dispatcher,
        json!({ "type": "validate_branch_request", "cwd": "/tmp", "branchName": "", "requestId": "r-empty" }),
    )
    .await;
    assert_eq!(
        empty["payload"]["error"],
        json!("Branch name cannot be empty")
    );
}

#[tokio::test]
async fn checkout_status_on_real_repo_returns_status() {
    let home = tempfile::tempdir().unwrap();
    let repo = tempfile::tempdir().unwrap();
    init_repo(repo.path());
    let (dispatcher, _term) = build_dispatcher(home.path());

    let resp = dispatch(
        &dispatcher,
        json!({ "type": "checkout_status_request", "cwd": repo.path().to_string_lossy(), "requestId": "r-status" }),
    )
    .await;

    assert_eq!(resp["type"], "checkout_status_response");
    assert_eq!(resp["payload"]["requestId"], "r-status");
    assert_eq!(resp["payload"]["isGit"], true);
    assert_eq!(resp["payload"]["currentBranch"], "main");
    assert_eq!(resp["payload"]["isDirty"], false);
    assert_eq!(resp["payload"]["error"], Value::Null);
    assert!(resp["payload"]["repoRoot"].is_string());

    // A non-git directory reports the not-git payload shape.
    let plain = tempfile::tempdir().unwrap();
    let not_git = dispatch(
        &dispatcher,
        json!({ "type": "checkout_status_request", "cwd": plain.path().to_string_lossy(), "requestId": "r-plain" }),
    )
    .await;
    assert_eq!(not_git["payload"]["isGit"], false);
    assert_eq!(not_git["payload"]["repoRoot"], Value::Null);
    assert_eq!(not_git["payload"]["isRockyOwnedWorktree"], false);
}

#[tokio::test]
async fn create_and_list_rocky_worktree_round_trip() {
    let home = tempfile::tempdir().unwrap();
    let repo = tempfile::tempdir().unwrap();
    init_repo(repo.path());
    let (dispatcher, _term) = build_dispatcher(home.path());

    let created = dispatch(
        &dispatcher,
        json!({
            "type": "create_rocky_worktree_request",
            "cwd": repo.path().to_string_lossy(),
            "projectId": "proj-1",
            "worktreeSlug": "feature/x",
            "requestId": "r-create",
        }),
    )
    .await;

    assert_eq!(created["type"], "create_rocky_worktree_response");
    assert_eq!(created["payload"]["requestId"], "r-create");
    assert_eq!(
        created["payload"]["error"],
        Value::Null,
        "worktree creation should succeed in a real repo: {:?}",
        created["payload"]["error"]
    );
    assert_eq!(created["payload"]["setupTerminalId"], Value::Null);
    assert_eq!(created["payload"]["workspace"]["workspaceKind"], "worktree");
    assert_eq!(created["payload"]["workspace"]["name"], "feature/x");

    // The worktree should now appear in the list, parsed from `git worktree list`.
    let listed = dispatch(
        &dispatcher,
        json!({
            "type": "rocky_worktree_list_request",
            "repoRoot": repo.path().to_string_lossy(),
            "requestId": "r-list",
        }),
    )
    .await;

    assert_eq!(listed["type"], "rocky_worktree_list_response");
    assert_eq!(listed["payload"]["requestId"], "r-list");
    assert_eq!(listed["payload"]["error"], Value::Null);
    let worktrees = listed["payload"]["worktrees"].as_array().unwrap();
    assert!(
        worktrees.iter().any(|w| w["branchName"] == "feature/x"),
        "expected feature/x worktree in listing, got {worktrees:?}"
    );
    for w in worktrees {
        assert!(w["worktreePath"].is_string());
        assert!(w["createdAt"].is_string());
    }
}

#[tokio::test]
async fn create_worktree_invalid_slug_returns_error() {
    let home = tempfile::tempdir().unwrap();
    let repo = tempfile::tempdir().unwrap();
    init_repo(repo.path());
    let (dispatcher, _term) = build_dispatcher(home.path());

    let resp = dispatch(
        &dispatcher,
        json!({
            "type": "create_rocky_worktree_request",
            "cwd": repo.path().to_string_lossy(),
            "projectId": "proj-1",
            "worktreeSlug": "Invalid Slug",
            "requestId": "r-bad-slug",
        }),
    )
    .await;
    assert_eq!(resp["payload"]["workspace"], Value::Null);
    assert!(resp["payload"]["error"].is_string());
    assert_eq!(resp["payload"]["errorCode"], "UNKNOWN");
}

#[tokio::test]
async fn worktree_list_missing_cwd_returns_error() {
    let home = tempfile::tempdir().unwrap();
    let (dispatcher, _term) = build_dispatcher(home.path());

    let resp = dispatch(
        &dispatcher,
        json!({ "type": "rocky_worktree_list_request", "requestId": "r-nocwd" }),
    )
    .await;
    assert_eq!(resp["payload"]["worktrees"], json!([]));
    assert_eq!(resp["payload"]["error"]["code"], "UNKNOWN");
    assert!(resp["payload"]["error"]["message"].is_string());
}

#[tokio::test]
async fn terminal_create_then_capture_returns_output() {
    let home = tempfile::tempdir().unwrap();
    let (dispatcher, term) = build_dispatcher(home.path());

    let created = dispatch(
        &dispatcher,
        json!({
            "type": "create_terminal_request",
            "cwd": home.path().to_string_lossy(),
            "name": "t1",
            "command": "sh",
            "args": ["-c", "printf marker789"],
            "requestId": "r-term-create",
        }),
    )
    .await;
    assert_eq!(created["type"], "create_terminal_response");
    assert_eq!(created["payload"]["requestId"], "r-term-create");
    assert_eq!(created["payload"]["error"], Value::Null);
    assert_eq!(created["payload"]["terminal"]["name"], "t1");
    let terminal_id = created["payload"]["terminal"]["id"]
        .as_str()
        .unwrap()
        .to_string();

    // List should include the terminal.
    let listed = dispatch(
        &dispatcher,
        json!({ "type": "list_terminals_request", "requestId": "r-term-list" }),
    )
    .await;
    assert_eq!(listed["type"], "list_terminals_response");
    let terminals = listed["payload"]["terminals"].as_array().unwrap();
    assert!(terminals.iter().any(|t| t["id"] == terminal_id.as_str()));

    // Wait deterministically for the child to emit its marker into the capture buffer.
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let snapshot = term.capture(&terminal_id).expect("capture");
        if snapshot.windows(9).any(|w| w == b"marker789") {
            break;
        }
        if Instant::now() >= deadline {
            panic!(
                "marker789 not captured, got {:?}",
                String::from_utf8_lossy(&snapshot)
            );
        }
        std::thread::sleep(Duration::from_millis(20));
    }

    // The capture RPC returns the buffered output as lines.
    let capture = dispatch(
        &dispatcher,
        json!({ "type": "capture_terminal_request", "terminalId": terminal_id, "stripAnsi": true, "requestId": "r-cap" }),
    )
    .await;
    assert_eq!(capture["type"], "capture_terminal_response");
    assert_eq!(capture["payload"]["requestId"], "r-cap");
    assert_eq!(capture["payload"]["terminalId"], terminal_id.as_str());
    let lines = capture["payload"]["lines"].as_array().unwrap();
    assert!(
        lines.iter().any(|l| l.as_str().unwrap_or("").contains("marker789")),
        "capture lines missing marker789: {lines:?}"
    );
    assert!(capture["payload"]["totalLines"].as_u64().unwrap() >= 1);

    // Subscribe returns the frame slot for the live terminal.
    let sub = dispatch(
        &dispatcher,
        json!({ "type": "subscribe_terminal_request", "terminalId": terminal_id, "requestId": "r-sub" }),
    )
    .await;
    assert_eq!(sub["type"], "subscribe_terminal_response");
    assert_eq!(sub["payload"]["requestId"], "r-sub");
    assert!(sub["payload"]["slot"].is_number());
    assert_eq!(sub["payload"]["error"], Value::Null);

    // Kill returns success.
    let kill = dispatch(
        &dispatcher,
        json!({ "type": "kill_terminal_request", "terminalId": terminal_id, "requestId": "r-kill" }),
    )
    .await;
    assert_eq!(kill["type"], "kill_terminal_response");
    assert_eq!(kill["payload"]["success"], true);

    // Subscribing to a now-dead terminal reports an error in the union shape.
    let sub_dead = dispatch(
        &dispatcher,
        json!({ "type": "subscribe_terminal_request", "terminalId": terminal_id, "requestId": "r-sub2" }),
    )
    .await;
    assert!(sub_dead["payload"]["error"].is_string());
}

#[tokio::test]
async fn archive_workspace_unknown_returns_error() {
    let home = tempfile::tempdir().unwrap();
    let (dispatcher, _term) = build_dispatcher(home.path());

    let resp = dispatch(
        &dispatcher,
        json!({ "type": "archive_workspace_request", "workspaceId": "nope", "requestId": "r-arch" }),
    )
    .await;
    assert_eq!(resp["type"], "archive_workspace_response");
    assert_eq!(resp["payload"]["requestId"], "r-arch");
    assert_eq!(resp["payload"]["workspaceId"], "nope");
    assert_eq!(resp["payload"]["archivedAt"], Value::Null);
    assert!(resp["payload"]["error"].is_string());
}

#[tokio::test]
async fn open_project_then_archive_round_trip() {
    let home = tempfile::tempdir().unwrap();
    let repo = tempfile::tempdir().unwrap();
    init_repo(repo.path());
    let (dispatcher, _term) = build_dispatcher(home.path());

    let opened = dispatch(
        &dispatcher,
        json!({ "type": "open_project_request", "cwd": repo.path().to_string_lossy(), "requestId": "r-open" }),
    )
    .await;
    assert_eq!(opened["type"], "open_project_response");
    assert_eq!(opened["payload"]["error"], Value::Null);
    assert_eq!(opened["payload"]["workspace"]["projectKind"], "git");
    let workspace_id = opened["payload"]["workspace"]["id"].as_str().unwrap().to_string();

    // It now shows up in fetch_workspaces.
    let listed = dispatch(
        &dispatcher,
        json!({ "type": "fetch_workspaces_request", "requestId": "r-fetch2" }),
    )
    .await;
    let entries = listed["payload"]["entries"].as_array().unwrap();
    assert!(entries.iter().any(|e| e["id"] == workspace_id.as_str()));

    // A local_checkout workspace can be archived (not a worktree).
    let archived = dispatch(
        &dispatcher,
        json!({ "type": "archive_workspace_request", "workspaceId": workspace_id, "requestId": "r-arch2" }),
    )
    .await;
    assert_eq!(archived["payload"]["error"], Value::Null);
    assert!(archived["payload"]["archivedAt"].is_string());
}
