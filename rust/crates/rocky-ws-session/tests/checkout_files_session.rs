//! Integration tests for the checkout (git-control) and files (filesystem)
//! session RPC handler groups. Exercises the dispatcher end-to-end (envelope
//! wrap/unwrap) with a temp `$ROCKY_HOME`, a real temp git repo, and real
//! filesystem reads.
//!
//! Response `type` strings and payload field names are asserted against the TS
//! protocol (`core/packages/protocol/src/messages.ts`).

use std::path::Path;
use std::process::Command;
use std::sync::{Arc, Mutex};

use rocky_workspaces::WorkspaceRegistry;
use rocky_ws_session::handlers::checkout::{register as register_checkout, CheckoutContext};
use rocky_ws_session::handlers::files::{register as register_files, FilesContext};
use rocky_ws_session::SessionDispatcher;
use serde_json::{json, Value};

fn build_dispatcher(rocky_home: &Path) -> SessionDispatcher {
    let workspace_registry = Arc::new(Mutex::new(WorkspaceRegistry::load(rocky_home)));
    let mut dispatcher = SessionDispatcher::new();
    register_checkout(
        &mut dispatcher,
        CheckoutContext {
            workspace_registry,
            rocky_home: rocky_home.to_path_buf(),
        },
    );
    register_files(
        &mut dispatcher,
        FilesContext::new(rocky_home.to_path_buf()),
    );
    dispatcher
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

/// Initialize a real git repo with one commit.
fn init_repo(repo: &Path) {
    run_git(repo, &["init", "-q", "-b", "main"]);
    run_git(repo, &["config", "user.email", "test@example.com"]);
    run_git(repo, &["config", "user.name", "Test"]);
    run_git(repo, &["config", "commit.gpgsign", "false"]);
    std::fs::write(repo.join("README.md"), "hello\n").unwrap();
    run_git(repo, &["add", "."]);
    run_git(repo, &["commit", "-q", "-m", "init"]);
}

// ---------------------------------------------------------------------------
// checkout group.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn checkout_refresh_against_real_repo_reports_branch_via_status() {
    // checkout_status_request is owned by workspace.rs; checkout.rs exposes the
    // refresh ack. Verify refresh succeeds against a real repo, and that a
    // branch-suggestions read surfaces the branch name.
    let home = tempfile::tempdir().unwrap();
    let repo = tempfile::tempdir().unwrap();
    init_repo(repo.path());
    let dispatcher = build_dispatcher(home.path());
    let cwd = repo.path().to_string_lossy().to_string();

    let resp = dispatch(
        &dispatcher,
        json!({ "type": "checkout.refresh.request", "cwd": cwd, "requestId": "r-refresh" }),
    )
    .await;
    assert_eq!(resp["type"], "checkout.refresh.response");
    assert_eq!(resp["payload"]["requestId"], "r-refresh");
    assert_eq!(resp["payload"]["success"], true);
    assert_eq!(resp["payload"]["error"], Value::Null);

    // branch_suggestions surfaces the current branch ("main").
    let branches = dispatch(
        &dispatcher,
        json!({ "type": "branch_suggestions_request", "cwd": cwd, "requestId": "r-branch" }),
    )
    .await;
    assert_eq!(branches["type"], "branch_suggestions_response");
    assert_eq!(branches["payload"]["requestId"], "r-branch");
    let names: Vec<&str> = branches["payload"]["branches"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap())
        .collect();
    assert!(names.contains(&"main"), "branches should include main: {names:?}");
}

#[tokio::test]
async fn checkout_commit_picks_up_dirty_file() {
    // A dirty file is committable; commit returns success and clears the tree.
    let home = tempfile::tempdir().unwrap();
    let repo = tempfile::tempdir().unwrap();
    init_repo(repo.path());
    std::fs::write(repo.path().join("new.txt"), "content\n").unwrap();
    let dispatcher = build_dispatcher(home.path());
    let cwd = repo.path().to_string_lossy().to_string();

    let resp = dispatch(
        &dispatcher,
        json!({ "type": "checkout_commit_request", "cwd": cwd,
                "message": "add new file", "requestId": "r-commit" }),
    )
    .await;
    assert_eq!(resp["type"], "checkout_commit_response");
    assert_eq!(resp["payload"]["requestId"], "r-commit");
    assert_eq!(resp["payload"]["success"], true, "commit payload: {resp}");
    assert_eq!(resp["payload"]["error"], Value::Null);

    // The working tree is now clean.
    let status = Command::new("git")
        .args(["status", "--porcelain"])
        .current_dir(repo.path())
        .output()
        .unwrap();
    assert!(String::from_utf8_lossy(&status.stdout).trim().is_empty());
}

#[tokio::test]
async fn stash_save_list_pop_round_trip() {
    let home = tempfile::tempdir().unwrap();
    let repo = tempfile::tempdir().unwrap();
    init_repo(repo.path());
    // Make a tracked change so there is something to stash.
    std::fs::write(repo.path().join("README.md"), "hello world\n").unwrap();
    let dispatcher = build_dispatcher(home.path());
    let cwd = repo.path().to_string_lossy().to_string();

    // Save.
    let save = dispatch(
        &dispatcher,
        json!({ "type": "stash_save_request", "cwd": cwd,
                "branch": "feature", "requestId": "r-save" }),
    )
    .await;
    assert_eq!(save["type"], "stash_save_response");
    assert_eq!(save["payload"]["requestId"], "r-save");
    assert_eq!(save["payload"]["success"], true, "save: {save}");
    assert_eq!(save["payload"]["error"], Value::Null);

    // List: one rocky stash tagged with the branch.
    let list = dispatch(
        &dispatcher,
        json!({ "type": "stash_list_request", "cwd": cwd, "requestId": "r-list" }),
    )
    .await;
    assert_eq!(list["type"], "stash_list_response");
    assert_eq!(list["payload"]["requestId"], "r-list");
    let entries = list["payload"]["entries"].as_array().unwrap();
    assert_eq!(entries.len(), 1, "one rocky stash: {list}");
    assert_eq!(entries[0]["index"], 0);
    assert_eq!(entries[0]["isRocky"], true);
    assert_eq!(entries[0]["branch"], "feature");

    // Pop: restores the change.
    let pop = dispatch(
        &dispatcher,
        json!({ "type": "stash_pop_request", "cwd": cwd,
                "stashIndex": 0, "requestId": "r-pop" }),
    )
    .await;
    assert_eq!(pop["type"], "stash_pop_response");
    assert_eq!(pop["payload"]["requestId"], "r-pop");
    assert_eq!(pop["payload"]["success"], true, "pop: {pop}");
    let restored = std::fs::read_to_string(repo.path().join("README.md")).unwrap();
    assert_eq!(restored, "hello world\n");
}

#[tokio::test]
async fn pr_status_request_returns_gh_not_wired_error() {
    let home = tempfile::tempdir().unwrap();
    let repo = tempfile::tempdir().unwrap();
    init_repo(repo.path());
    let dispatcher = build_dispatcher(home.path());
    let cwd = repo.path().to_string_lossy().to_string();

    let resp = dispatch(
        &dispatcher,
        json!({ "type": "checkout_pr_status_request", "cwd": cwd, "requestId": "r-pr" }),
    )
    .await;
    assert_eq!(resp["type"], "checkout_pr_status_response");
    assert_eq!(resp["payload"]["requestId"], "r-pr");
    assert_eq!(resp["payload"]["status"], Value::Null);
    assert_eq!(resp["payload"]["githubFeaturesEnabled"], false);
    // Structured CheckoutError, NOT a fake ok.
    assert_eq!(resp["payload"]["error"]["code"], "NOT_ALLOWED");
    let message = resp["payload"]["error"]["message"].as_str().unwrap();
    assert!(message.contains("gh-not-wired"), "message: {message}");
}

#[tokio::test]
async fn github_search_request_returns_gh_not_wired_string_error() {
    let home = tempfile::tempdir().unwrap();
    let dispatcher = build_dispatcher(home.path());

    let resp = dispatch(
        &dispatcher,
        json!({ "type": "github_search_request", "cwd": "/tmp",
                "query": "x", "requestId": "r-gh" }),
    )
    .await;
    assert_eq!(resp["type"], "github_search_response");
    assert_eq!(resp["payload"]["requestId"], "r-gh");
    assert_eq!(resp["payload"]["githubFeaturesEnabled"], false);
    assert_eq!(resp["payload"]["items"].as_array().unwrap().len(), 0);
    let message = resp["payload"]["error"].as_str().unwrap();
    assert!(message.contains("gh-not-wired"), "message: {message}");
}

// ---------------------------------------------------------------------------
// files group.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn file_explorer_list_returns_entries() {
    let home = tempfile::tempdir().unwrap();
    let work = tempfile::tempdir().unwrap();
    std::fs::write(work.path().join("a.txt"), "aaa").unwrap();
    std::fs::create_dir(work.path().join("sub")).unwrap();
    let dispatcher = build_dispatcher(home.path());
    let cwd = work.path().to_string_lossy().to_string();

    let resp = dispatch(
        &dispatcher,
        json!({ "type": "file_explorer_request", "cwd": cwd,
                "mode": "list", "requestId": "r-explore" }),
    )
    .await;
    assert_eq!(resp["type"], "file_explorer_response");
    assert_eq!(resp["payload"]["requestId"], "r-explore");
    assert_eq!(resp["payload"]["mode"], "list");
    assert_eq!(resp["payload"]["error"], Value::Null);
    let entries = resp["payload"]["directory"]["entries"].as_array().unwrap();
    let names: Vec<&str> = entries
        .iter()
        .map(|e| e["name"].as_str().unwrap())
        .collect();
    assert!(names.contains(&"a.txt"), "entries: {names:?}");
    assert!(names.contains(&"sub"), "entries: {names:?}");
    let sub = entries.iter().find(|e| e["name"] == "sub").unwrap();
    assert_eq!(sub["kind"], "directory");
    let file = entries.iter().find(|e| e["name"] == "a.txt").unwrap();
    assert_eq!(file["kind"], "file");
    assert_eq!(file["path"], "a.txt");
}

#[tokio::test]
async fn file_explorer_read_text_file() {
    let home = tempfile::tempdir().unwrap();
    let work = tempfile::tempdir().unwrap();
    std::fs::write(work.path().join("a.txt"), "hello body").unwrap();
    let dispatcher = build_dispatcher(home.path());
    let cwd = work.path().to_string_lossy().to_string();

    let resp = dispatch(
        &dispatcher,
        json!({ "type": "file_explorer_request", "cwd": cwd,
                "path": "a.txt", "mode": "file", "requestId": "r-file" }),
    )
    .await;
    assert_eq!(resp["type"], "file_explorer_response");
    assert_eq!(resp["payload"]["mode"], "file");
    assert_eq!(resp["payload"]["file"]["kind"], "text");
    assert_eq!(resp["payload"]["file"]["encoding"], "utf-8");
    assert_eq!(resp["payload"]["file"]["content"], "hello body");
}

#[tokio::test]
async fn file_explorer_rejects_traversal() {
    let home = tempfile::tempdir().unwrap();
    let work = tempfile::tempdir().unwrap();
    let dispatcher = build_dispatcher(home.path());
    let cwd = work.path().to_string_lossy().to_string();

    let resp = dispatch(
        &dispatcher,
        json!({ "type": "file_explorer_request", "cwd": cwd,
                "path": "../escape", "mode": "list", "requestId": "r-esc" }),
    )
    .await;
    assert_eq!(resp["type"], "file_explorer_response");
    let error = resp["payload"]["error"].as_str().unwrap();
    assert!(
        error.contains("outside of workspace"),
        "error: {error}"
    );
}

#[tokio::test]
async fn directory_suggestions_returns_subdirs() {
    let home = tempfile::tempdir().unwrap();
    let work = tempfile::tempdir().unwrap();
    std::fs::create_dir(work.path().join("alpha")).unwrap();
    std::fs::create_dir(work.path().join("beta")).unwrap();
    std::fs::write(work.path().join("file.txt"), "x").unwrap();
    let dispatcher = build_dispatcher(home.path());
    let cwd = work.path().to_string_lossy().to_string();

    let resp = dispatch(
        &dispatcher,
        json!({ "type": "directory_suggestions_request", "cwd": cwd,
                "query": "", "requestId": "r-dir" }),
    )
    .await;
    assert_eq!(resp["type"], "directory_suggestions_response");
    assert_eq!(resp["payload"]["requestId"], "r-dir");
    let dirs: Vec<String> = resp["payload"]["directories"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap().to_string())
        .collect();
    assert!(dirs.iter().any(|d| d.ends_with("/alpha")), "dirs: {dirs:?}");
    assert!(dirs.iter().any(|d| d.ends_with("/beta")), "dirs: {dirs:?}");
    // Files excluded by default (includeFiles defaults false).
    assert!(!dirs.iter().any(|d| d.ends_with("/file.txt")));
}

#[tokio::test]
async fn file_download_token_returns_token_string() {
    let home = tempfile::tempdir().unwrap();
    let work = tempfile::tempdir().unwrap();
    std::fs::write(work.path().join("doc.txt"), "downloadable").unwrap();
    let dispatcher = build_dispatcher(home.path());
    let cwd = work.path().to_string_lossy().to_string();

    let resp = dispatch(
        &dispatcher,
        json!({ "type": "file_download_token_request", "cwd": cwd,
                "path": "doc.txt", "requestId": "r-tok" }),
    )
    .await;
    assert_eq!(resp["type"], "file_download_token_response");
    assert_eq!(resp["payload"]["requestId"], "r-tok");
    assert_eq!(resp["payload"]["error"], Value::Null);
    assert_eq!(resp["payload"]["path"], "doc.txt");
    assert_eq!(resp["payload"]["fileName"], "doc.txt");
    assert_eq!(resp["payload"]["size"], 12);
    let token = resp["payload"]["token"].as_str().unwrap();
    assert_eq!(token.len(), 32, "32-hex-char token: {token}");
    assert!(token.chars().all(|c| c.is_ascii_hexdigit()));
}

#[tokio::test]
async fn list_available_editors_returns_response() {
    let home = tempfile::tempdir().unwrap();
    let dispatcher = build_dispatcher(home.path());

    let resp = dispatch(
        &dispatcher,
        json!({ "type": "list_available_editors_request", "requestId": "r-ed" }),
    )
    .await;
    assert_eq!(resp["type"], "list_available_editors_response");
    assert_eq!(resp["payload"]["requestId"], "r-ed");
    assert_eq!(resp["payload"]["error"], Value::Null);
    // Editors list is best-effort; just assert the shape (an array).
    assert!(resp["payload"]["editors"].is_array());
}
