//! Worktree root resolution, branch-slug validation, and `git worktree`
//! lifecycle operations.
//!
//! Source baselines:
//! - `core/packages/server/src/utils/worktree.ts`:
//!   - `resolveRockyWorktreesBaseRoot` (lines 777-789) — default
//!     `$ROCKY_HOME/worktrees`, overridable by a config root.
//!   - `createWorktree` (lines 1160-1222) — runs `git worktree add`.
//!   - `parseWorktreeList` (lines 879-914) — parses `git worktree list
//!     --porcelain`.
//! - `core/packages/protocol/src/branch-slug.ts` (`validateBranchSlug`,
//!   lines 5-38) — ported verbatim into [`validate_branch_slug`].
//! - `core/packages/server/src/server/rocky-worktree-service.ts`
//!   (`upsertWorkspaceForWorktree`, lines 193-243) — creates a `worktree`-kind
//!   workspace record.

use std::path::{Component, Path, PathBuf};

use rocky_store::PersistedWorkspaceRecord;
use thiserror::Error;
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;

use crate::git::{self, GitError};
use crate::registry::{RegistryError, WorkspaceRegistry};

/// Errors from worktree operations.
#[derive(Debug, Error)]
pub enum WorktreeError {
    #[error("invalid branch slug: {0}")]
    InvalidBranch(String),

    #[error("worktree teardown failed: {0}")]
    Teardown(String),

    #[error(transparent)]
    Git(#[from] GitError),

    #[error(transparent)]
    Registry(#[from] RegistryError),
}

/// Outcome of [`validate_branch_slug`], mirroring the TS
/// `{ valid, error? }` return (branch-slug.ts:5-8).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BranchSlugValidation {
    pub valid: bool,
    pub error: Option<String>,
}

impl BranchSlugValidation {
    fn ok() -> Self {
        Self {
            valid: true,
            error: None,
        }
    }
    fn err(message: &str) -> Self {
        Self {
            valid: false,
            error: Some(message.to_string()),
        }
    }
}

/// Validate a git branch slug, ported verbatim from `validateBranchSlug`
/// (branch-slug.ts:5-38). Rules, in order:
/// 1. non-empty (else "Branch name cannot be empty")
/// 2. length <= 100 (else "Branch name too long (max 100 characters)")
/// 3. matches `^[a-z0-9-/]+$` — only lowercase letters, digits, `-`, `/`
///    (else "Branch name must contain only lowercase letters, numbers,
///    hyphens, and forward slashes"). This rejects spaces, dots (`..`),
///    uppercase, and any other punctuation.
/// 4. no leading/trailing `-` (else "Branch name cannot start or end with a
///    hyphen")
/// 5. no consecutive hyphens `--` (else "Branch name cannot have consecutive
///    hyphens")
pub fn validate_branch_slug(slug: &str) -> BranchSlugValidation {
    if slug.is_empty() {
        return BranchSlugValidation::err("Branch name cannot be empty");
    }
    if slug.len() > 100 {
        return BranchSlugValidation::err("Branch name too long (max 100 characters)");
    }
    let valid_chars = slug
        .chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '/');
    if !valid_chars {
        return BranchSlugValidation::err(
            "Branch name must contain only lowercase letters, numbers, hyphens, and forward slashes",
        );
    }
    if slug.starts_with('-') || slug.ends_with('-') {
        return BranchSlugValidation::err("Branch name cannot start or end with a hyphen");
    }
    if slug.contains("--") {
        return BranchSlugValidation::err("Branch name cannot have consecutive hyphens");
    }
    BranchSlugValidation::ok()
}

/// Resolve the base worktree root, mirroring `resolveRockyWorktreesBaseRoot`
/// (worktree.ts:777-789).
///
/// - When `config_root` is set: if absolute, use it as-is; otherwise resolve it
///   relative to `rocky_home`.
/// - Otherwise default to `$ROCKY_HOME/worktrees`.
///
/// `~`-expansion is intentionally NOT performed here; callers pass already
/// expanded/absolute paths (the TS `expandTilde` step lives upstream).
pub fn resolve_worktree_root(rocky_home: &Path, config_root: Option<&str>) -> PathBuf {
    match config_root {
        Some(root) if !root.is_empty() => {
            let candidate = Path::new(root);
            if candidate.is_absolute() {
                normalize_path(candidate)
            } else {
                normalize_path(&rocky_home.join(candidate))
            }
        }
        _ => rocky_home.join("worktrees"),
    }
}

/// A worktree created by [`create_worktree`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CreatedWorktree {
    pub path: PathBuf,
    pub branch: String,
}

/// Information about an existing worktree, from `git worktree list --porcelain`.
///
/// Field semantics match `parseWorktreeList` (worktree.ts:879-914): `branch`
/// has the `refs/heads/` prefix stripped, and `head` is the raw commit OID.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorktreeInfo {
    pub path: PathBuf,
    pub branch: Option<String>,
    pub head: Option<String>,
}

/// Create a git worktree at `worktree_path` for `branch`.
///
/// Mirrors `createWorktree` (worktree.ts:1160-1222), which runs
/// `git worktree add <path> ...`. When `branch` does not yet exist locally a
/// new branch is created with `-b <branch> [<base_ref>]` (base defaults to the
/// current `HEAD`). When the branch already exists it is attached directly
/// (`git worktree add <path> <branch>`).
///
/// The explicit `worktree_path` deviates from the TS signature
/// (`{ cwd, source, worktreeSlug, ... }`): path layout under the worktree root
/// is the caller's concern here (see [`resolve_worktree_root`]), keeping this
/// function a thin, testable primitive over `git worktree add`.
pub async fn create_worktree(
    repo_root: &Path,
    worktree_path: &Path,
    branch: &str,
    base_ref: Option<&str>,
) -> Result<CreatedWorktree, WorktreeError> {
    let validation = validate_branch_slug(branch);
    if !validation.valid {
        return Err(WorktreeError::InvalidBranch(
            validation.error.unwrap_or_else(|| branch.to_string()),
        ));
    }

    if let Some(parent) = worktree_path.parent() {
        std::fs::create_dir_all(parent).ok();
    }

    let path_str = worktree_path.to_string_lossy().into_owned();
    let branch_exists = local_branch_exists(repo_root, branch).await?;

    let mut args: Vec<String> = vec!["worktree".into(), "add".into(), path_str];
    if branch_exists {
        // Attach the existing branch.
        args.push(branch.to_string());
    } else {
        args.push("-b".into());
        args.push(branch.to_string());
        if let Some(base) = base_ref {
            args.push(base.to_string());
        }
    }

    git::run_git_checked(repo_root, &args).await?;

    Ok(CreatedWorktree {
        path: worktree_path.to_path_buf(),
        branch: branch.to_string(),
    })
}

/// Whether a local branch exists (`git rev-parse --verify refs/heads/<branch>`).
async fn local_branch_exists(repo_root: &Path, branch: &str) -> Result<bool, GitError> {
    let refname = format!("refs/heads/{branch}");
    let output = git::run_git(repo_root, ["rev-parse", "--verify", "--quiet", &refname]).await?;
    Ok(output.success())
}

/// List all worktrees of `repo_root`, parsing `git worktree list --porcelain`.
///
/// Parsing mirrors `parseWorktreeList` (worktree.ts:879-914).
pub async fn list_worktrees(repo_root: &Path) -> Result<Vec<WorktreeInfo>, WorktreeError> {
    let output = git::run_git_checked(repo_root, ["worktree", "list", "--porcelain"]).await?;
    Ok(parse_worktree_list(&output.stdout))
}

fn parse_worktree_list(output: &str) -> Vec<WorktreeInfo> {
    let mut entries: Vec<WorktreeInfo> = Vec::new();
    let mut current: Option<WorktreeInfo> = None;

    for line in output.split('\n') {
        if let Some(rest) = line.strip_prefix("worktree ") {
            if let Some(existing) = current.take() {
                entries.push(existing);
            }
            current = Some(WorktreeInfo {
                path: PathBuf::from(rest.trim()),
                branch: None,
                head: None,
            });
            continue;
        }

        let Some(entry) = current.as_mut() else {
            continue;
        };

        if let Some(rest) = line.strip_prefix("branch ") {
            let reff = rest.trim();
            let branch = reff
                .strip_prefix("refs/heads/")
                .unwrap_or(reff)
                .to_string();
            entry.branch = Some(branch);
        } else if let Some(rest) = line.strip_prefix("HEAD ") {
            entry.head = Some(rest.trim().to_string());
        } else if line.trim().is_empty() {
            if let Some(existing) = current.take() {
                entries.push(existing);
            }
        }
    }

    if let Some(existing) = current.take() {
        entries.push(existing);
    }

    entries
}

/// Remove the worktree at `path` and prune stale admin entries.
///
/// Mirrors `deleteRockyWorktree` (worktree.ts:1039-1114): the operation is
/// idempotent. `git worktree remove --force` fails when the admin dir is
/// already gone (a prior partial archive, or the repo root moved) — that
/// failure is intentionally swallowed so we fall through to removing the
/// directory ourselves and pruning lazily. The only hard error is when the
/// working-tree directory still exists on disk and cannot be deleted.
pub async fn archive_worktree(repo_root: &Path, path: &Path) -> Result<(), WorktreeError> {
    let path_str = path.to_string_lossy().into_owned();

    // Best-effort `git worktree remove --force`; ignore failures (e.g. the
    // admin entry is already gone, "is not a working tree").
    let _ = git::run_git(repo_root, ["worktree", "remove", "--force", &path_str]).await;

    // Ensure the working-tree directory is gone, retrying transient FS errors.
    remove_dir_with_retries(path).await?;

    // Lazily prune stale admin entries; not critical if it fails.
    let _ = git::run_git(repo_root, ["worktree", "prune"]).await;
    Ok(())
}

/// Remove `path` and its contents, retrying transient failures, mirroring the
/// `removeDirectoryWithRetries` helper (worktree.ts:1128-1150). A missing path
/// is success.
async fn remove_dir_with_retries(path: &Path) -> Result<(), WorktreeError> {
    if !path.exists() {
        return Ok(());
    }
    let delays_ms = [0u64, 100, 300, 700, 1500];
    let mut last_err: Option<std::io::Error> = None;
    for delay in delays_ms {
        if delay > 0 {
            tokio::time::sleep(std::time::Duration::from_millis(delay)).await;
        }
        match std::fs::remove_dir_all(path) {
            Ok(()) => return Ok(()),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(err) => last_err = Some(err),
        }
        if !path.exists() {
            return Ok(());
        }
    }
    Err(WorktreeError::Teardown(format!(
        "failed to remove worktree directory {}: {}",
        path.display(),
        last_err
            .map(|e| e.to_string())
            .unwrap_or_else(|| "unknown error".to_string()),
    )))
}

/// Upsert a `worktree`-kind workspace record for `cwd`.
///
/// Mirrors `upsertWorkspaceForWorktree` (rocky-worktree-service.ts:193-243):
/// the workspace id is the normalized cwd, `kind` is `"worktree"`, `createdAt`
/// is preserved from any existing record, and `updatedAt` is set to now.
/// `displayName` defaults to the normalized cwd (callers with a branch name in
/// hand may set it on the returned record before further use).
pub fn upsert_workspace_for_worktree(
    workspace_registry: &mut WorkspaceRegistry,
    project_id: &str,
    cwd: &Path,
) -> Result<PersistedWorkspaceRecord, WorktreeError> {
    let workspace_id = normalize_workspace_id(cwd);
    let now = now_iso8601();
    let created_at = workspace_registry
        .get(&workspace_id)
        .map(|existing| existing.created_at.clone())
        .unwrap_or_else(|| now.clone());

    let record = PersistedWorkspaceRecord {
        workspace_id: workspace_id.clone(),
        project_id: project_id.to_string(),
        cwd: workspace_id.clone(),
        kind: "worktree".to_string(),
        display_name: workspace_id,
        created_at,
        updated_at: now,
        archived_at: None,
    };

    workspace_registry.upsert(record.clone())?;
    Ok(record)
}

/// Normalize a cwd into a stable workspace id, mirroring `normalizeWorkspaceId`
/// (workspace-registry-model.ts:30-37): trim, make absolute, and normalize
/// `.`/`..` components. Unlike `realpath` this does not require the path to
/// exist and does not resolve symlinks.
pub fn normalize_workspace_id(cwd: &Path) -> String {
    let trimmed = cwd.to_string_lossy();
    let trimmed = trimmed.trim();
    if trimmed.is_empty() {
        return cwd.to_string_lossy().into_owned();
    }
    let absolute = if Path::new(trimmed).is_absolute() {
        PathBuf::from(trimmed)
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("/"))
            .join(trimmed)
    };
    normalize_path(&absolute).to_string_lossy().into_owned()
}

/// Lexically normalize `.`/`..`/duplicate separators without touching the FS.
fn normalize_path(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// Current UTC time as an ISO8601 string with millisecond precision and a
/// trailing `Z`, matching `new Date().toISOString()` (see rockyd clock parity).
fn now_iso8601() -> String {
    let full = OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_string());
    trim_to_millis(&full)
}

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

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command as StdCommand;

    fn git(dir: &Path, args: &[&str]) {
        let out = StdCommand::new("git")
            .args(args)
            .current_dir(dir)
            .env("GIT_AUTHOR_NAME", "T")
            .env("GIT_AUTHOR_EMAIL", "t@example.com")
            .env("GIT_COMMITTER_NAME", "T")
            .env("GIT_COMMITTER_EMAIL", "t@example.com")
            .output()
            .unwrap();
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    }

    fn init_repo(dir: &Path) {
        git(dir, &["init", "-b", "main"]);
        std::fs::write(dir.join("README.md"), "hi\n").unwrap();
        git(dir, &["add", "."]);
        git(dir, &["commit", "-m", "init"]);
    }

    #[test]
    fn resolve_worktree_root_defaults_and_overrides() {
        let home = Path::new("/home/rocky");
        assert_eq!(
            resolve_worktree_root(home, None),
            PathBuf::from("/home/rocky/worktrees")
        );
        // Absolute override used as-is.
        assert_eq!(
            resolve_worktree_root(home, Some("/custom/wt")),
            PathBuf::from("/custom/wt")
        );
        // Relative override resolved against home.
        assert_eq!(
            resolve_worktree_root(home, Some("trees")),
            PathBuf::from("/home/rocky/trees")
        );
    }

    #[test]
    fn validate_branch_slug_accepts_valid() {
        assert!(validate_branch_slug("feature/new-thing").valid);
        assert!(validate_branch_slug("fix-123").valid);
        assert!(validate_branch_slug("a").valid);
    }

    #[test]
    fn validate_branch_slug_rejects_invalid() {
        assert_eq!(
            validate_branch_slug("").error.as_deref(),
            Some("Branch name cannot be empty")
        );
        assert!(validate_branch_slug("has space").error.unwrap().contains("only lowercase"));
        // ".." contains a dot -> fails the character pattern.
        assert!(validate_branch_slug("a..b").error.unwrap().contains("only lowercase"));
        assert!(validate_branch_slug("UPPER").error.unwrap().contains("only lowercase"));
        assert_eq!(
            validate_branch_slug("-leading").error.as_deref(),
            Some("Branch name cannot start or end with a hyphen")
        );
        assert_eq!(
            validate_branch_slug("trailing-").error.as_deref(),
            Some("Branch name cannot start or end with a hyphen")
        );
        assert_eq!(
            validate_branch_slug("double--hyphen").error.as_deref(),
            Some("Branch name cannot have consecutive hyphens")
        );
        let long = "a".repeat(101);
        assert!(validate_branch_slug(&long).error.unwrap().contains("too long"));
    }

    #[test]
    fn parse_worktree_list_handles_multiple_entries() {
        let output = "worktree /repo\nHEAD abc123\nbranch refs/heads/main\n\nworktree /repo/wt/feature\nHEAD def456\nbranch refs/heads/feature/x\n\n";
        let parsed = parse_worktree_list(output);
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0].path, PathBuf::from("/repo"));
        assert_eq!(parsed[0].branch.as_deref(), Some("main"));
        assert_eq!(parsed[0].head.as_deref(), Some("abc123"));
        assert_eq!(parsed[1].branch.as_deref(), Some("feature/x"));
    }

    #[tokio::test]
    async fn create_list_and_archive_worktree_with_real_git() {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        init_repo(&repo);

        let wt_path = dir.path().join("worktrees").join("feature-x");
        let created = create_worktree(&repo, &wt_path, "feature-x", None)
            .await
            .unwrap();
        assert_eq!(created.branch, "feature-x");
        assert!(wt_path.exists());

        // Appears in list_worktrees with its branch.
        let list = list_worktrees(&repo).await.unwrap();
        let found = list
            .iter()
            .find(|w| w.branch.as_deref() == Some("feature-x"))
            .expect("worktree not listed");
        // Path may be canonicalized by git; compare by file name tail.
        assert!(found.path.ends_with("feature-x"));

        // Archive removes it.
        archive_worktree(&repo, &found.path).await.unwrap();
        let after = list_worktrees(&repo).await.unwrap();
        assert!(after.iter().all(|w| w.branch.as_deref() != Some("feature-x")));
        assert!(!wt_path.exists());
    }

    #[tokio::test]
    async fn archive_worktree_is_idempotent_when_admin_entry_already_gone() {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        init_repo(&repo);

        let wt_path = dir.path().join("worktrees").join("stale-x");
        create_worktree(&repo, &wt_path, "stale-x", None)
            .await
            .unwrap();
        assert!(wt_path.exists());

        // Simulate a prior partial archive: drop git's admin entry so that
        // `git worktree remove` will fail with "is not a working tree", while
        // the working-tree directory itself still exists on disk.
        git::run_git(&repo, ["worktree", "prune"]).await.unwrap();
        std::fs::remove_dir_all(repo.join(".git").join("worktrees")).ok();

        // Archive must still succeed (idempotent) and remove the directory.
        archive_worktree(&repo, &wt_path).await.unwrap();
        assert!(!wt_path.exists());

        // A second archive of an already-gone path is a no-op success.
        archive_worktree(&repo, &wt_path).await.unwrap();
    }

    #[tokio::test]
    async fn create_worktree_attaches_existing_branch() {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        init_repo(&repo);
        git(&repo, &["branch", "existing"]);

        let wt_path = dir.path().join("worktrees").join("existing");
        let created = create_worktree(&repo, &wt_path, "existing", None)
            .await
            .unwrap();
        assert_eq!(created.branch, "existing");
        assert!(wt_path.exists());
    }

    #[tokio::test]
    async fn create_worktree_rejects_invalid_branch() {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        init_repo(&repo);
        let err = create_worktree(&repo, &dir.path().join("wt"), "Bad Branch", None)
            .await
            .unwrap_err();
        assert!(matches!(err, WorktreeError::InvalidBranch(_)), "got: {err:?}");
    }

    #[test]
    fn upsert_workspace_for_worktree_creates_worktree_kind() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path();
        let mut workspaces = WorkspaceRegistry::load(home);
        let cwd = Path::new("/abs/work/feature-x");
        let record = upsert_workspace_for_worktree(&mut workspaces, "proj-1", cwd).unwrap();
        assert_eq!(record.kind, "worktree");
        assert_eq!(record.project_id, "proj-1");
        assert_eq!(record.workspace_id, "/abs/work/feature-x");

        // Persisted and reloadable.
        let reloaded = WorkspaceRegistry::load(home);
        assert_eq!(reloaded.get("/abs/work/feature-x").map(|r| r.kind.as_str()), Some("worktree"));
    }

    #[test]
    fn upsert_workspace_preserves_created_at() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path();
        let mut workspaces = WorkspaceRegistry::load(home);
        let cwd = Path::new("/abs/work/y");
        let first = upsert_workspace_for_worktree(&mut workspaces, "p", cwd).unwrap();
        let second = upsert_workspace_for_worktree(&mut workspaces, "p", cwd).unwrap();
        assert_eq!(first.created_at, second.created_at);
    }

    #[test]
    fn normalize_workspace_id_resolves_dot_segments() {
        assert_eq!(normalize_workspace_id(Path::new("/a/b/../c")), "/a/c");
        assert_eq!(normalize_workspace_id(Path::new("/a/./b")), "/a/b");
    }
}
