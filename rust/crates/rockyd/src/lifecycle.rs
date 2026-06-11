use std::process::ExitCode;
use std::sync::Once;

use rocky_config::resolve_rocky_home_from;
use rocky_store::{get_pid_lock_info, is_locked, is_pid_running, LockState, PidLockInfo};
use serde_json::json;
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;
use tracing::error;

static LOGGING_INIT: Once = Once::new();

/// Initialize structured logging once. JSON lines by default; level via
/// `RUST_LOG`/`ROCKY_LOG` env (default `info`). Matches the spec requirement
/// for one logging system with stdout suitable for launchd/systemd.
pub fn init_logging() {
    LOGGING_INIT.call_once(|| {
        use tracing_subscriber::EnvFilter;
        let filter = EnvFilter::try_from_env("ROCKY_LOG")
            .or_else(|_| EnvFilter::try_from_default_env())
            .unwrap_or_else(|_| EnvFilter::new("info"));
        let json = std::env::var("ROCKY_LOG_FORMAT").as_deref() != Ok("pretty");
        let builder = tracing_subscriber::fmt().with_env_filter(filter);
        if json {
            builder.json().with_current_span(false).init();
        } else {
            builder.init();
        }
    });
}

/// ISO-8601 millisecond timestamp with trailing `Z`, matching Node's
/// `toISOString()`.
pub fn now_iso8601() -> String {
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
        format!("{}.{}{}", &rfc3339[..dot], millis, &rfc3339[suffix_start..])
    } else {
        rfc3339.to_string()
    }
}

fn resolve_home_or_exit(home: Option<String>) -> Result<std::path::PathBuf, ExitCode> {
    resolve_daemon_home(home).map_err(|err| {
        eprintln!("error: {err}");
        ExitCode::from(1)
    })
}

/// Resolve `$ROCKY_HOME` for the daemon: explicit `--home` flag wins, otherwise
/// fall back to the `ROCKY_HOME` env (and finally the `~/.rocky` default).
pub fn resolve_daemon_home(
    home_flag: Option<String>,
) -> Result<std::path::PathBuf, rocky_config::RockyHomeError> {
    let raw = home_flag
        .filter(|value| !value.is_empty())
        .or_else(|| std::env::var("ROCKY_HOME").ok().filter(|v| !v.is_empty()));
    resolve_rocky_home_from(raw.map(Into::into))
}

/// `rockyd daemon status`.
pub fn status(home: Option<String>, json_output: bool) -> ExitCode {
    let rocky_home = match resolve_home_or_exit(home) {
        Ok(path) => path,
        Err(code) => return code,
    };

    let (local_state, info) = match is_locked(&rocky_home) {
        LockState::Unlocked => ("stopped", None),
        LockState::Stale(info) => ("stale_pid", Some(info)),
        LockState::Locked(info) => ("running", Some(info)),
    };

    if json_output {
        let payload = json!({
            "localDaemon": local_state,
            "home": rocky_home.display().to_string(),
            "pid": info.as_ref().map(|i| i.pid),
            "listen": info.as_ref().and_then(|i| i.listen.clone()),
            "startedAt": info.as_ref().map(|i| i.started_at.clone()),
            "hostname": info.as_ref().map(|i| i.hostname.clone()),
            "owner": info.as_ref().map(owner_label),
            "desktopManaged": info.as_ref().and_then(|i| i.desktop_managed),
        });
        println!("{}", serde_json::to_string_pretty(&payload).unwrap());
    } else {
        match &info {
            Some(info) if local_state == "running" => {
                println!("local daemon: running");
                println!("pid:          {}", info.pid);
                println!("listen:       {}", info.listen.as_deref().unwrap_or("unknown"));
                println!("startedAt:    {}", info.started_at);
                println!("owner:        {}", owner_label(info));
            }
            Some(info) => {
                println!("local daemon: {local_state} (pid {} not running)", info.pid);
            }
            None => println!("local daemon: stopped"),
        }
    }
    ExitCode::SUCCESS
}

fn owner_label(info: &PidLockInfo) -> String {
    format!("{}@{}", info.uid, info.hostname)
}

/// `rockyd daemon stop` — graceful SIGTERM to the owner PID.
pub fn stop(home: Option<String>) -> ExitCode {
    let rocky_home = match resolve_home_or_exit(home) {
        Ok(path) => path,
        Err(code) => return code,
    };
    match get_pid_lock_info(&rocky_home) {
        Some(info) if is_pid_running(info.pid) => {
            if send_signal(info.pid, libc::SIGTERM) {
                println!("sent SIGTERM to rockyd (pid {})", info.pid);
                ExitCode::SUCCESS
            } else {
                eprintln!("failed to signal rockyd (pid {})", info.pid);
                ExitCode::from(1)
            }
        }
        Some(info) => {
            println!("daemon not running (stale pid {}); nothing to stop", info.pid);
            ExitCode::SUCCESS
        }
        None => {
            println!("daemon not running");
            ExitCode::SUCCESS
        }
    }
}

/// `rockyd daemon restart` — SIGHUP to the owner PID, which re-execs in place.
pub fn restart(home: Option<String>) -> ExitCode {
    let rocky_home = match resolve_home_or_exit(home) {
        Ok(path) => path,
        Err(code) => return code,
    };
    match get_pid_lock_info(&rocky_home) {
        Some(info) if is_pid_running(info.pid) => {
            if send_signal(info.pid, libc::SIGHUP) {
                println!("sent SIGHUP to rockyd (pid {}) — restarting", info.pid);
                ExitCode::SUCCESS
            } else {
                eprintln!("failed to signal rockyd (pid {})", info.pid);
                ExitCode::from(1)
            }
        }
        _ => {
            eprintln!("daemon not running; cannot restart");
            ExitCode::from(1)
        }
    }
}

fn send_signal(pid: i64, sig: libc::c_int) -> bool {
    #[cfg(unix)]
    {
        unsafe { libc::kill(pid as libc::pid_t, sig) == 0 }
    }
    #[cfg(not(unix))]
    {
        let _ = (pid, sig);
        false
    }
}

/// Re-exec the current binary in place, preserving argv/env. Used by the
/// foreground process to satisfy a restart request without spawning a second
/// daemon. Returns `ExitCode` only on failure (success never returns).
pub fn reexec_self() -> std::io::Result<ExitCode> {
    use std::os::unix::process::CommandExt;
    let exe = std::env::current_exe()?;
    let args: Vec<String> = std::env::args().skip(1).collect();
    let err = std::process::Command::new(exe).args(args).exec();
    // exec only returns on error.
    error!(error = %err, "exec failed");
    Err(err)
}
