//! Thin async wrapper around the real `git` binary.
//!
//! Mirrors the spawn shape of `core/packages/server/src/utils/run-git-command.ts`
//! (`runGitCommand`, lines 122-326): every invocation prepends
//! `-c core.quotepath=false` so git emits raw UTF-8 paths, captures stdout and
//! stderr, and surfaces the exit code. The higher-level helpers here cover the
//! operations the MCP/UI need: porcelain status, current branch, and diff.
//!
//! Non-git directories are classified gracefully: callers receive a
//! [`GitError::NotARepository`] rather than a panic or an opaque exit-code
//! failure, matching `buildNotGitSnapshot` in
//! `core/packages/server/src/server/workspace-git-service.ts` (lines 1977-1997).

use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::process::Output;

use thiserror::Error;
use tokio::process::Command;

/// Errors raised by the git wrapper.
#[derive(Debug, Error)]
pub enum GitError {
    /// The `git` binary could not be spawned (e.g. not on `PATH`).
    #[error("failed to spawn git: {0}")]
    Spawn(#[source] std::io::Error),

    /// `cwd` is not inside a git working tree.
    #[error("not a git repository: {path}")]
    NotARepository { path: PathBuf },

    /// git exited with a non-zero status for an operation that expected success.
    #[error("git {args:?} failed (exit {code:?}): {stderr}")]
    Command {
        args: Vec<String>,
        code: Option<i32>,
        stderr: String,
    },
}

/// Result of a raw `git` invocation with decoded stdout/stderr.
#[derive(Debug, Clone)]
pub struct GitOutput {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<i32>,
}

impl GitOutput {
    /// Whether git exited successfully (exit code 0).
    pub fn success(&self) -> bool {
        self.exit_code == Some(0)
    }
}

/// Options for [`diff`].
#[derive(Debug, Clone, Default)]
pub struct DiffOptions {
    /// Diff staged changes (`--cached`) instead of the working tree.
    pub staged: bool,
    /// Restrict the diff to specific pathspecs.
    pub paths: Vec<String>,
    /// Extra raw args appended after the diff flags (e.g. `--stat`).
    pub extra_args: Vec<String>,
}

/// Run `git` in `cwd` with `args`, capturing stdout and stderr.
///
/// Prepends `-c core.quotepath=false` like the TS `runGitCommand`
/// (run-git-command.ts:165). Unlike the higher-level helpers this does NOT
/// fail on a non-zero exit; callers inspect [`GitOutput::exit_code`].
pub async fn run_git<I, S>(cwd: &Path, args: I) -> Result<GitOutput, GitError>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let mut command = Command::new("git");
    command.arg("-c").arg("core.quotepath=false");
    let mut arg_strings: Vec<String> = Vec::new();
    for arg in args {
        let arg = arg.as_ref();
        arg_strings.push(arg.to_string_lossy().into_owned());
        command.arg(arg);
    }
    command.current_dir(cwd);
    let output: Output = command.output().await.map_err(GitError::Spawn)?;
    Ok(GitOutput {
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        exit_code: output.status.code(),
    })
}

/// Run `git` and require a zero exit code, mapping failures to
/// [`GitError::Command`]. The stderr is captured and trimmed.
pub async fn run_git_checked<I, S>(cwd: &Path, args: I) -> Result<GitOutput, GitError>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let arg_strings: Vec<String> = args
        .into_iter()
        .map(|a| a.as_ref().to_string_lossy().into_owned())
        .collect();
    let output = run_git(cwd, &arg_strings).await?;
    if output.success() {
        return Ok(output);
    }
    Err(GitError::Command {
        args: arg_strings,
        code: output.exit_code,
        stderr: output.stderr.trim().to_string(),
    })
}

/// Whether `cwd` is inside a git working tree
/// (`git rev-parse --is-inside-work-tree`).
pub async fn is_inside_work_tree(cwd: &Path) -> Result<bool, GitError> {
    let output = run_git(cwd, ["rev-parse", "--is-inside-work-tree"]).await?;
    Ok(output.success() && output.stdout.trim() == "true")
}

/// Ensure `cwd` is a git repository, returning [`GitError::NotARepository`]
/// otherwise.
async fn ensure_repo(cwd: &Path) -> Result<(), GitError> {
    if is_inside_work_tree(cwd).await? {
        Ok(())
    } else {
        Err(GitError::NotARepository {
            path: cwd.to_path_buf(),
        })
    }
}

/// `git status --porcelain` output for `cwd`.
///
/// Classifies non-git directories as [`GitError::NotARepository`] rather than
/// returning a confusing exit-code failure.
pub async fn git_status_porcelain(cwd: &Path) -> Result<String, GitError> {
    ensure_repo(cwd).await?;
    let output = run_git_checked(cwd, ["status", "--porcelain"]).await?;
    Ok(output.stdout)
}

/// The current branch name (`git rev-parse --abbrev-ref HEAD`).
///
/// Returns `None` for a detached HEAD (git reports the literal `HEAD`).
pub async fn current_branch(cwd: &Path) -> Result<Option<String>, GitError> {
    ensure_repo(cwd).await?;
    let output = run_git_checked(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]).await?;
    let branch = output.stdout.trim().to_string();
    if branch.is_empty() || branch == "HEAD" {
        Ok(None)
    } else {
        Ok(Some(branch))
    }
}

/// `git diff` for `cwd`, honoring [`DiffOptions`].
pub async fn diff(cwd: &Path, opts: &DiffOptions) -> Result<String, GitError> {
    ensure_repo(cwd).await?;
    let mut args: Vec<String> = vec!["diff".to_string()];
    if opts.staged {
        args.push("--cached".to_string());
    }
    args.extend(opts.extra_args.iter().cloned());
    if !opts.paths.is_empty() {
        args.push("--".to_string());
        args.extend(opts.paths.iter().cloned());
    }
    let output = run_git_checked(cwd, &args).await?;
    Ok(output.stdout)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command as StdCommand;

    fn git(dir: &Path, args: &[&str]) {
        let status = StdCommand::new("git")
            .args(args)
            .current_dir(dir)
            .env("GIT_AUTHOR_NAME", "T")
            .env("GIT_AUTHOR_EMAIL", "t@example.com")
            .env("GIT_COMMITTER_NAME", "T")
            .env("GIT_COMMITTER_EMAIL", "t@example.com")
            .output()
            .unwrap();
        assert!(status.status.success(), "git {args:?} failed: {}", String::from_utf8_lossy(&status.stderr));
    }

    fn init_repo(dir: &Path) {
        git(dir, &["init", "-b", "main"]);
        std::fs::write(dir.join("README.md"), "hello\n").unwrap();
        git(dir, &["add", "."]);
        git(dir, &["commit", "-m", "init"]);
    }

    #[tokio::test]
    async fn status_porcelain_shows_changes() {
        let dir = tempfile::tempdir().unwrap();
        init_repo(dir.path());
        // Clean repo: empty status.
        assert_eq!(git_status_porcelain(dir.path()).await.unwrap().trim(), "");
        // Dirty it.
        std::fs::write(dir.path().join("new.txt"), "x").unwrap();
        let status = git_status_porcelain(dir.path()).await.unwrap();
        assert!(status.contains("new.txt"), "status: {status}");
    }

    #[tokio::test]
    async fn current_branch_returns_branch() {
        let dir = tempfile::tempdir().unwrap();
        init_repo(dir.path());
        assert_eq!(current_branch(dir.path()).await.unwrap().as_deref(), Some("main"));
    }

    #[tokio::test]
    async fn diff_reports_staged_and_unstaged() {
        let dir = tempfile::tempdir().unwrap();
        init_repo(dir.path());
        std::fs::write(dir.path().join("README.md"), "hello\nworld\n").unwrap();
        let unstaged = diff(dir.path(), &DiffOptions::default()).await.unwrap();
        assert!(unstaged.contains("+world"), "diff: {unstaged}");

        git(dir.path(), &["add", "README.md"]);
        let staged = diff(
            dir.path(),
            &DiffOptions {
                staged: true,
                ..Default::default()
            },
        )
        .await
        .unwrap();
        assert!(staged.contains("+world"), "staged diff: {staged}");
    }

    #[tokio::test]
    async fn non_git_dir_classified_gracefully() {
        let dir = tempfile::tempdir().unwrap();
        let err = git_status_porcelain(dir.path()).await.unwrap_err();
        assert!(matches!(err, GitError::NotARepository { .. }), "got: {err:?}");
        assert!(!is_inside_work_tree(dir.path()).await.unwrap());
        assert!(matches!(
            current_branch(dir.path()).await.unwrap_err(),
            GitError::NotARepository { .. }
        ));
    }
}
