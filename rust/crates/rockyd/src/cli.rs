use clap::{Parser, Subcommand};

/// Authoritative Rocky host daemon.
#[derive(Debug, Parser)]
#[command(name = "rockyd", version, about = "Rocky host daemon (Rust)")]
pub struct Cli {
    /// Run in foreground (the only supported launch mode; service managers own
    /// process lifetime). Present for `rockyd --foreground` parity.
    #[arg(long, global = true)]
    pub foreground: bool,

    /// Override `$ROCKY_HOME`.
    #[arg(long, global = true)]
    pub home: Option<String>,

    /// Override the listen target (`host:port`, port, or unix socket path).
    #[arg(long, global = true)]
    pub listen: Option<String>,

    #[command(subcommand)]
    pub command: Option<Command>,
}

#[derive(Debug, Subcommand)]
pub enum Command {
    /// Daemon lifecycle controls.
    Daemon {
        #[command(subcommand)]
        command: DaemonCommand,
    },
}

#[derive(Debug, Subcommand)]
pub enum DaemonCommand {
    /// Report daemon status from the pid-lock the daemon owns.
    Status {
        /// Emit JSON instead of human-readable text.
        #[arg(long)]
        json: bool,
    },
    /// Stop the running daemon (graceful SIGTERM to the owner).
    Stop,
    /// Restart the running daemon in place (SIGHUP -> self re-exec).
    Restart,
    /// Run the daemon in foreground (alias for the default invocation).
    Run {
        #[arg(long)]
        foreground: bool,
    },
}
