//! Spawn and gracefully terminate the ACP subprocess.
//!
//! `__ROCKY_ROOT__` expansion mirrors `scripts/setup.sh`
//! (`sed "s|__ROCKY_ROOT__|$ROOT|g"`): the literal token is replaced with the
//! resolved repo root in every command argument.
//!
//! Graceful shutdown mirrors `terminateChildProcess` / `waitForChildExit`
//! (`acp-agent.ts:2862-2887`): SIGTERM (after closing stdin), wait up to a kill
//! timeout, then SIGKILL.

use std::collections::HashMap;
use std::process::Stdio;
use std::time::Duration;

use tokio::process::{Child, ChildStdin, ChildStdout, Command};

use crate::error::{AcpError, AcpResult};

/// The token replaced with the repo root in command arguments.
pub const ROCKY_ROOT_TOKEN: &str = "__ROCKY_ROOT__";

/// Expand every `__ROCKY_ROOT__` occurrence in `arg` with `repo_root`.
///
/// Matches the `sed "s|__ROCKY_ROOT__|$ROOT|g"` setup step: all occurrences,
/// anywhere in the string, are replaced.
pub fn expand_rocky_root(arg: &str, repo_root: &str) -> String {
    arg.replace(ROCKY_ROOT_TOKEN, repo_root)
}

/// Specification for launching the ACP agent subprocess.
#[derive(Debug, Clone)]
pub struct ProcessSpec {
    /// Command + args, e.g. `["bun", "__ROCKY_ROOT__/.../cli.ts", "acp"]`.
    /// `__ROCKY_ROOT__` tokens are expanded at spawn time.
    pub command: Vec<String>,
    /// Repo root used for `__ROCKY_ROOT__` expansion.
    pub repo_root: String,
    /// Working directory for the child.
    pub cwd: String,
    /// Environment overlay applied on top of the inherited environment.
    pub env: HashMap<String, String>,
    /// Kill timeout: how long to wait after SIGTERM before SIGKILL.
    pub kill_timeout: Duration,
}

impl ProcessSpec {
    /// Build a spec from the canonical pieces with a default 5s kill timeout.
    pub fn new(
        command: Vec<String>,
        repo_root: impl Into<String>,
        cwd: impl Into<String>,
    ) -> Self {
        Self {
            command,
            repo_root: repo_root.into(),
            cwd: cwd.into(),
            env: HashMap::new(),
            kill_timeout: Duration::from_secs(5),
        }
    }

    /// Resolve the command with `__ROCKY_ROOT__` expanded in every argument.
    pub fn resolved_command(&self) -> Vec<String> {
        self.command
            .iter()
            .map(|arg| expand_rocky_root(arg, &self.repo_root))
            .collect()
    }
}

/// A spawned ACP agent process with its stdio pipes detached for the transport.
pub struct AcpProcess {
    child: Child,
    kill_timeout: Duration,
}

impl AcpProcess {
    /// Spawn the subprocess and hand back the process plus stdin/stdout pipes.
    pub fn spawn(spec: &ProcessSpec) -> AcpResult<(Self, ChildStdin, ChildStdout)> {
        let resolved = spec.resolved_command();
        let (program, args) = resolved
            .split_first()
            .ok_or_else(|| AcpError::Protocol("empty ACP command".to_string()))?;

        let mut command = Command::new(program);
        command
            .args(args)
            .current_dir(&spec.cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        for (key, value) in &spec.env {
            command.env(key, value);
        }

        let mut child = command.spawn().map_err(AcpError::Spawn)?;
        let stdin = child.stdin.take().ok_or(AcpError::MissingPipes)?;
        let stdout = child.stdout.take().ok_or(AcpError::MissingPipes)?;

        Ok((
            Self {
                child,
                kill_timeout: spec.kill_timeout,
            },
            stdin,
            stdout,
        ))
    }

    /// Process id, if the child is still running.
    pub fn id(&self) -> Option<u32> {
        self.child.id()
    }

    /// Graceful shutdown: SIGTERM, wait up to the kill timeout, then SIGKILL.
    ///
    /// stdin is expected to already be dropped by the caller (mirrors
    /// `child.stdin.destroy()`), which lets a cooperating agent exit on EOF.
    pub async fn shutdown(mut self) {
        // Already exited?
        if matches!(self.child.try_wait(), Ok(Some(_))) {
            return;
        }

        send_sigterm(&self.child);

        let waited =
            tokio::time::timeout(self.kill_timeout, self.child.wait()).await;
        if waited.is_err() {
            // Timed out; force kill and reap.
            let _ = self.child.kill().await;
            let _ = self.child.wait().await;
        }
    }
}

#[cfg(unix)]
fn send_sigterm(child: &Child) {
    if let Some(pid) = child.id() {
        // SAFETY: kill(2) with a valid pid and SIGTERM has no memory effects.
        unsafe {
            libc::kill(pid as libc::pid_t, libc::SIGTERM);
        }
    }
}

#[cfg(not(unix))]
fn send_sigterm(_child: &Child) {
    // Non-unix has no SIGTERM; shutdown() falls through to kill() on timeout.
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expands_rocky_root_token_everywhere() {
        assert_eq!(
            expand_rocky_root("__ROCKY_ROOT__/vendor/amaze/cli.ts", "/repo"),
            "/repo/vendor/amaze/cli.ts"
        );
        // Replaces all occurrences, like sed's g flag.
        assert_eq!(
            expand_rocky_root("__ROCKY_ROOT__:__ROCKY_ROOT__", "/r"),
            "/r:/r"
        );
        // No token => unchanged.
        assert_eq!(expand_rocky_root("bun", "/repo"), "bun");
        // No token => unchanged even when root present elsewhere.
        assert_eq!(expand_rocky_root("acp", "/repo"), "acp");
    }

    #[test]
    fn resolved_command_expands_only_args_with_token() {
        let spec = ProcessSpec::new(
            vec![
                "bun".to_string(),
                "__ROCKY_ROOT__/vendor/amaze/packages/coding-agent/src/cli.ts".to_string(),
                "acp".to_string(),
            ],
            "/Users/steve/roy/rocky",
            "/tmp/work",
        );
        assert_eq!(
            spec.resolved_command(),
            vec![
                "bun".to_string(),
                "/Users/steve/roy/rocky/vendor/amaze/packages/coding-agent/src/cli.ts".to_string(),
                "acp".to_string(),
            ]
        );
    }
}
