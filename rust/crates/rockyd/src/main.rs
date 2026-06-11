//! `rockyd` — authoritative Rust host daemon for Rocky.
//!
//! Phase 1 scope (per `core/docs/rust-rebuild/05-migration-and-verification.md`):
//! process identity, singleton pid-lock, listen parsing, structured logging,
//! foreground launch for launchd/systemd, a health route, and
//! `daemon status/stop/restart`. Business logic (WebUI, agents, mission control)
//! arrives in later phases against the same binary.

mod auth;
mod cli;
mod hostnames;
mod http;
mod lifecycle;
mod server;
mod webui;
mod ws;

#[cfg(test)]
mod http_tests;
#[cfg(test)]
mod ws_tests;

use std::process::ExitCode;

use clap::Parser;
use cli::{Cli, Command, DaemonCommand};

fn main() -> ExitCode {
    let cli = Cli::parse();
    match cli.command {
        None => run_foreground(cli.foreground, cli.home, cli.listen),
        Some(Command::Daemon { command }) => match command {
            DaemonCommand::Status { json } => lifecycle::status(cli.home, json),
            DaemonCommand::Stop => lifecycle::stop(cli.home),
            DaemonCommand::Restart => lifecycle::restart(cli.home),
            DaemonCommand::Run { foreground } => {
                run_foreground(foreground || cli.foreground, cli.home, cli.listen)
            }
        },
    }
}

fn run_foreground(foreground: bool, home: Option<String>, listen: Option<String>) -> ExitCode {
    // `--foreground` is the only supported launch mode for launchd/systemd. We
    // do not background ourselves; the service manager owns process lifetime.
    // Accepting the flag (or its absence) keeps the documented invocation
    // `rockyd --foreground` working while never silently daemonizing.
    let _ = foreground;
    server::run(home, listen)
}
