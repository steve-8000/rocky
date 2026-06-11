use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use thiserror::Error;
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;

/// pid-lock schema, matching `pidLockInfoSchema` in `pid-lock.ts`.
///
/// `listen` is nullable; `desktopManaged` is optional and only present when
/// true (the TS writer omits it otherwise).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PidLockInfo {
    pub pid: i64,
    #[serde(rename = "startedAt")]
    pub started_at: String,
    pub hostname: String,
    pub uid: i64,
    pub listen: Option<String>,
    #[serde(rename = "desktopManaged", skip_serializing_if = "Option::is_none")]
    pub desktop_managed: Option<bool>,
}

#[derive(Debug, Error)]
pub enum PidLockError {
    #[error("{message}")]
    AlreadyRunning {
        message: String,
        existing: Box<PidLockInfo>,
    },
    #[error("{0}")]
    Conflict(String),
    #[error("io error on {path}: {source}")]
    Io {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LockState {
    Unlocked,
    /// Stale lock present but the owning PID is dead.
    Stale(PidLockInfo),
    /// Live lock held by a running PID.
    Locked(PidLockInfo),
}

fn pid_file_path(rocky_home: &Path) -> PathBuf {
    rocky_home.join("rocky.pid")
}

fn now_iso8601() -> String {
    // Node's toISOString() emits millisecond precision with a trailing Z.
    let now = OffsetDateTime::now_utc();
    // RFC3339 from `time` yields nanosecond precision; trim to milliseconds to
    // match the JS shape closely. Either form parses fine, but we keep parity.
    let full = now.format(&Rfc3339).unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_string());
    trim_to_millis(&full)
}

fn trim_to_millis(rfc3339: &str) -> String {
    // e.g. 2026-06-10T23:14:49.406123456Z -> 2026-06-10T23:14:49.406Z
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

/// Whether a PID is alive, matching `isPidRunning` (kill(pid, 0)).
///
/// A live process the caller cannot signal (`EPERM`) still counts as running.
pub fn is_pid_running(pid: i64) -> bool {
    if pid <= 0 {
        return false;
    }
    #[cfg(unix)]
    {
        let res = unsafe { libc::kill(pid as libc::pid_t, 0) };
        if res == 0 {
            return true;
        }
        let errno = std::io::Error::last_os_error().raw_os_error();
        // EPERM => exists but not signalable; ESRCH => no such process.
        errno == Some(libc::EPERM)
    }
    #[cfg(not(unix))]
    {
        // Best effort on non-unix: assume not running so stale locks recover.
        false
    }
}

fn current_uid() -> i64 {
    #[cfg(unix)]
    {
        unsafe { libc::getuid() as i64 }
    }
    #[cfg(not(unix))]
    {
        0
    }
}

fn hostname() -> String {
    std::env::var("HOSTNAME")
        .ok()
        .filter(|h| !h.is_empty())
        .or_else(read_hostname_syscall)
        .unwrap_or_else(|| "localhost".to_string())
}

#[cfg(unix)]
fn read_hostname_syscall() -> Option<String> {
    let mut buf = vec![0u8; 256];
    let res = unsafe { libc::gethostname(buf.as_mut_ptr() as *mut libc::c_char, buf.len()) };
    if res != 0 {
        return None;
    }
    let end = buf.iter().position(|&b| b == 0).unwrap_or(buf.len());
    String::from_utf8(buf[..end].to_vec()).ok().filter(|s| !s.is_empty())
}

#[cfg(not(unix))]
fn read_hostname_syscall() -> Option<String> {
    None
}

fn parse_lock(content: &str) -> Option<PidLockInfo> {
    serde_json::from_str::<PidLockInfo>(content).ok()
}

fn read_lock(path: &Path) -> Option<PidLockInfo> {
    let content = std::fs::read_to_string(path).ok()?;
    parse_lock(&content)
}

/// Acquire the singleton pid-lock for `rocky_home`.
///
/// Mirrors `acquirePidLock`:
/// - idempotent when the live lock is already owned by `owner_pid`
/// - rejects when another live PID holds the lock
/// - removes a stale lock (dead PID) and continues
/// - creates the lock with `O_EXCL`; on race re-reads and reports the winner
pub fn acquire_pid_lock(
    rocky_home: &Path,
    listen: Option<&str>,
    owner_pid: i64,
) -> Result<(), PidLockError> {
    let pid_path = pid_file_path(rocky_home);

    if !rocky_home.exists() {
        std::fs::create_dir_all(rocky_home).map_err(|source| PidLockError::Io {
            path: rocky_home.to_path_buf(),
            source,
        })?;
    }

    if let Some(existing) = read_lock(&pid_path) {
        if is_pid_running(existing.pid) {
            if existing.pid == owner_pid {
                return Ok(());
            }
            return Err(PidLockError::AlreadyRunning {
                message: format!(
                    "Another Rocky daemon is already running (PID {}, started {})",
                    existing.pid, existing.started_at
                ),
                existing: Box::new(existing),
            });
        }
        // Stale lock - remove it.
        let _ = std::fs::remove_file(&pid_path);
    }

    let lock_info = PidLockInfo {
        pid: owner_pid,
        started_at: now_iso8601(),
        hostname: hostname(),
        uid: current_uid(),
        listen: listen.map(|s| s.to_string()),
        desktop_managed: if std::env::var("ROCKY_DESKTOP_MANAGED").as_deref() == Ok("1") {
            Some(true)
        } else {
            None
        },
    };

    match OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&pid_path)
    {
        Ok(mut file) => {
            let payload = serde_json::to_vec(&lock_info)
                .map_err(|e| PidLockError::Conflict(format!("serialize lock: {e}")))?;
            file.write_all(&payload).map_err(|source| PidLockError::Io {
                path: pid_path.clone(),
                source,
            })?;
            Ok(())
        }
        Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => {
            // Race: another process created it first.
            if let Some(race) = read_lock(&pid_path) {
                Err(PidLockError::AlreadyRunning {
                    message: format!("Another Rocky daemon is already running (PID {})", race.pid),
                    existing: Box::new(race),
                })
            } else {
                Err(PidLockError::Conflict(
                    "Failed to acquire PID lock due to race condition".to_string(),
                ))
            }
        }
        Err(source) => Err(PidLockError::Io {
            path: pid_path,
            source,
        }),
    }
}

/// Update the lock's `listen` field, only if owned by `owner_pid`.
///
/// Mirrors `updatePidLock`.
pub fn update_pid_lock(
    rocky_home: &Path,
    listen: &str,
    owner_pid: i64,
) -> Result<(), PidLockError> {
    let pid_path = pid_file_path(rocky_home);
    let existing = read_lock(&pid_path)
        .ok_or_else(|| PidLockError::Conflict("Cannot update PID lock: invalid lock file".into()))?;
    if existing.pid != owner_pid {
        return Err(PidLockError::Conflict(format!(
            "Cannot update PID lock owned by PID {}",
            existing.pid
        )));
    }
    let updated = PidLockInfo {
        listen: Some(listen.to_string()),
        ..existing
    };
    let payload = serde_json::to_vec(&updated)
        .map_err(|e| PidLockError::Conflict(format!("serialize lock: {e}")))?;
    // Truncate-in-place to match the TS r+ truncate/write behavior.
    let mut file = OpenOptions::new()
        .write(true)
        .truncate(true)
        .open(&pid_path)
        .map_err(|source| PidLockError::Io {
            path: pid_path.clone(),
            source,
        })?;
    file.write_all(&payload).map_err(|source| PidLockError::Io {
        path: pid_path,
        source,
    })?;
    Ok(())
}

/// Release the lock only when owned by `owner_pid`, matching `releasePidLock`.
pub fn release_pid_lock(rocky_home: &Path, owner_pid: i64) {
    let pid_path = pid_file_path(rocky_home);
    if let Some(lock) = read_lock(&pid_path) {
        if lock.pid == owner_pid {
            let _ = std::fs::remove_file(&pid_path);
        }
    }
}

/// Read the current lock info, matching `getPidLockInfo`.
pub fn get_pid_lock_info(rocky_home: &Path) -> Option<PidLockInfo> {
    read_lock(&pid_file_path(rocky_home))
}

/// Classify the lock state, matching `isLocked` (plus stale visibility).
pub fn is_locked(rocky_home: &Path) -> LockState {
    match get_pid_lock_info(rocky_home) {
        None => LockState::Unlocked,
        Some(info) => {
            if is_pid_running(info.pid) {
                LockState::Locked(info)
            } else {
                LockState::Stale(info)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn home() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }

    #[test]
    fn acquire_writes_lock_with_listen() {
        let dir = home();
        acquire_pid_lock(dir.path(), Some("127.0.0.1:7767"), 4242).unwrap();
        let info = get_pid_lock_info(dir.path()).unwrap();
        assert_eq!(info.pid, 4242);
        assert_eq!(info.listen.as_deref(), Some("127.0.0.1:7767"));
        assert!(info.desktop_managed.is_none());
    }

    #[test]
    fn acquire_is_idempotent_for_same_owner() {
        let dir = home();
        let me = std::process::id() as i64;
        acquire_pid_lock(dir.path(), None, me).unwrap();
        // Second acquire by the same (live) owner pid is a no-op.
        acquire_pid_lock(dir.path(), None, me).unwrap();
    }

    #[test]
    fn acquire_rejects_when_live_other_owner() {
        let dir = home();
        // Our own pid is alive; pretend a different live owner already holds it.
        let me = std::process::id() as i64;
        acquire_pid_lock(dir.path(), None, me).unwrap();
        let err = acquire_pid_lock(dir.path(), None, me + 1_000_000).unwrap_err();
        match err {
            PidLockError::AlreadyRunning { existing, .. } => assert_eq!(existing.pid, me),
            other => panic!("expected AlreadyRunning, got {other:?}"),
        }
    }

    #[test]
    fn stale_lock_is_recovered() {
        let dir = home();
        // A dead PID (very unlikely to be alive): use a large unused value.
        let dead = 999_999_999i64;
        acquire_pid_lock(dir.path(), None, dead).unwrap();
        assert!(matches!(is_locked(dir.path()), LockState::Stale(_)));
        // New owner can take over a stale lock.
        let me = std::process::id() as i64;
        acquire_pid_lock(dir.path(), Some("127.0.0.1:7767"), me).unwrap();
        let info = get_pid_lock_info(dir.path()).unwrap();
        assert_eq!(info.pid, me);
    }

    #[test]
    fn update_listen_requires_owner() {
        let dir = home();
        let me = std::process::id() as i64;
        acquire_pid_lock(dir.path(), None, me).unwrap();
        update_pid_lock(dir.path(), "127.0.0.1:7767", me).unwrap();
        assert_eq!(
            get_pid_lock_info(dir.path()).unwrap().listen.as_deref(),
            Some("127.0.0.1:7767")
        );
        let err = update_pid_lock(dir.path(), "x", me + 1).unwrap_err();
        assert!(matches!(err, PidLockError::Conflict(_)));
    }

    #[test]
    fn release_only_when_owner() {
        let dir = home();
        let me = std::process::id() as i64;
        acquire_pid_lock(dir.path(), None, me).unwrap();
        release_pid_lock(dir.path(), me + 1); // not owner -> no-op
        assert!(get_pid_lock_info(dir.path()).is_some());
        release_pid_lock(dir.path(), me);
        assert!(get_pid_lock_info(dir.path()).is_none());
    }

    #[test]
    fn started_at_is_millisecond_iso() {
        let dir = home();
        acquire_pid_lock(dir.path(), None, std::process::id() as i64).unwrap();
        let info = get_pid_lock_info(dir.path()).unwrap();
        // e.g. 2026-06-10T23:14:49.406Z
        assert!(info.started_at.ends_with('Z'), "got {}", info.started_at);
        let dot = info.started_at.find('.').expect("has millis");
        let millis = &info.started_at[dot + 1..info.started_at.len() - 1];
        assert_eq!(millis.len(), 3, "millis precision: {}", info.started_at);
    }
}
