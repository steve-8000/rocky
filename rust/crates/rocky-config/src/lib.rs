//! Configuration root resolution and listen-target parsing for `rockyd`.
//!
//! These mirror the behavior of the current TypeScript daemon so the Rust
//! binary can own the same `$ROCKY_HOME` and `listen` grammar without forcing
//! clients or operators to change anything.
//!
//! Source baseline:
//! - `core/packages/server/src/server/rocky-home.ts`
//! - `core/packages/server/src/server/bootstrap.ts` (`parseListenString`)
//! - `core/packages/server/src/server/config.ts` (`DEFAULT_PORT`, listen default)

mod daemon_config;
mod home;
mod listen;

pub use daemon_config::{
    AuthSection, CorsSection, DaemonSection, HostnamesConfig, McpSection, PersistedConfig,
};
pub use home::{resolve_rocky_home, resolve_rocky_home_from, RockyHomeError, PRIVATE_DIRECTORY_MODE};
pub use listen::{format_listen_target, parse_listen_string, ListenParseError, ListenTarget};

/// Default TCP port, matching `DEFAULT_PORT` in `config.ts`.
pub const DEFAULT_PORT: u16 = 7767;

/// Resolve the default listen string when nothing is configured.
///
/// Mirrors `config.ts`: `127.0.0.1:${PORT ?? DEFAULT_PORT}`.
pub fn default_listen_string(port_env: Option<&str>) -> String {
    let port = port_env
        .and_then(|raw| raw.trim().parse::<u16>().ok())
        .unwrap_or(DEFAULT_PORT);
    format!("127.0.0.1:{port}")
}
