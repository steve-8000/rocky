//! Minimal `$ROCKY_HOME/config.json` reader for the Phase 2 daemon.
//!
//! Only the fields Phase 2 actually consumes are extracted; every other field
//! is ignored (serde `#[serde(default)]`, no `deny_unknown_fields`) so the Rust
//! daemon tolerates the full TS config schema.
//!
//! Source baseline:
//! - `core/packages/server/src/server/config.ts`
//!   (`resolveListenAddress`, `resolveCorsAllowedOrigins`, `resolveAuthConfig`,
//!   `resolveStaticLoadConfigSettings` hostnames)
//! - `core/packages/server/src/server/hostnames.ts` (`HostnamesConfig`)
//! - `core/packages/server/src/server/persisted-config.ts` (`config.json`)

use std::path::Path;

use serde::Deserialize;

/// Allowlist configuration, matching `HostnamesConfig = true | string[] |
/// undefined` in `hostnames.ts`.
///
/// `undefined` (absent) and `[]` are equivalent for allowlist purposes; both
/// fall to the built-in defaults. Modeled as `Option<HostnamesConfig>` where
/// `None` is `undefined`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(untagged)]
pub enum HostnamesConfig {
    /// `hostnames === true`: allow any host.
    Any(bool),
    /// `hostnames === ["..."]`: extra patterns added to defaults.
    List(Vec<String>),
}

/// Parsed view of the persisted `config.json`, limited to Phase 2 needs.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct PersistedConfig {
    pub daemon: Option<DaemonSection>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct DaemonSection {
    /// `daemon.listen` — listen string (override resolution is handled by the
    /// caller; this is the persisted fallback).
    pub listen: Option<String>,
    /// `daemon.hostnames` — `true` or a list of allow patterns.
    pub hostnames: Option<HostnamesConfig>,
    /// `daemon.cors` — CORS settings.
    pub cors: Option<CorsSection>,
    /// `daemon.auth` — bearer auth settings (password is a bcrypt hash).
    pub auth: Option<AuthSection>,
    /// `daemon.mcp` — agent MCP injection settings.
    pub mcp: Option<McpSection>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct CorsSection {
    #[serde(rename = "allowedOrigins")]
    pub allowed_origins: Option<Vec<String>>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct McpSection {
    /// `daemon.mcp.injectIntoAgents` — whether the daemon injects its own
    /// `rocky` MCP server into every created/resumed agent. Absent => enabled
    /// (matches the TS default `config.mcpInjectIntoAgents !== false`).
    #[serde(rename = "injectIntoAgents")]
    pub inject_into_agents: Option<bool>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct AuthSection {
    /// Persisted bcrypt hash of the daemon password.
    pub password: Option<String>,
}

impl PersistedConfig {
    /// Read and parse `$ROCKY_HOME/config.json`.
    ///
    /// Returns an empty (all-default) config when the file is absent or cannot
    /// be parsed — Phase 2 is read-only and must not hard-fail on a missing or
    /// malformed config (the TS loader initializes/validates separately).
    pub fn load(rocky_home: &Path) -> Self {
        let path = rocky_home.join("config.json");
        let Ok(raw) = std::fs::read_to_string(&path) else {
            return Self::default();
        };
        serde_json::from_str(&raw).unwrap_or_default()
    }

    /// Persisted `daemon.listen`, if any.
    pub fn listen(&self) -> Option<&str> {
        self.daemon.as_ref()?.listen.as_deref()
    }

    /// Persisted `daemon.hostnames`, if any.
    pub fn hostnames(&self) -> Option<&HostnamesConfig> {
        self.daemon.as_ref()?.hostnames.as_ref()
    }

    /// Persisted CORS allowed origins (`daemon.cors.allowedOrigins`), filtered
    /// to non-empty entries. Mirrors `resolveCorsAllowedOrigins`.
    pub fn cors_allowed_origins(&self) -> Vec<String> {
        self.daemon
            .as_ref()
            .and_then(|d| d.cors.as_ref())
            .and_then(|c| c.allowed_origins.as_ref())
            .map(|origins| {
                origins
                    .iter()
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
                    .collect()
            })
            .unwrap_or_default()
    }

    /// Whether the daemon injects its own `rocky` MCP server into agents
    /// (`daemon.mcp.injectIntoAgents`). Defaults to `true` when absent, matching
    /// the TS `config.mcpInjectIntoAgents !== false` default.
    pub fn mcp_inject_into_agents(&self) -> bool {
        self.daemon
            .as_ref()
            .and_then(|d| d.mcp.as_ref())
            .and_then(|m| m.inject_into_agents)
            .unwrap_or(true)
    }

    /// Persisted bcrypt password hash (`daemon.auth.password`), if any.
    pub fn auth_password(&self) -> Option<&str> {
        self.daemon.as_ref()?.auth.as_ref()?.password.as_deref()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_config(dir: &Path, json: &str) {
        std::fs::write(dir.join("config.json"), json).unwrap();
    }

    #[test]
    fn missing_file_yields_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let cfg = PersistedConfig::load(dir.path());
        assert!(cfg.listen().is_none());
        assert!(cfg.hostnames().is_none());
        assert!(cfg.cors_allowed_origins().is_empty());
        assert!(cfg.auth_password().is_none());
    }

    #[test]
    fn ignores_unknown_fields() {
        let dir = tempfile::tempdir().unwrap();
        write_config(
            dir.path(),
            r#"{"daemon":{"listen":"0.0.0.0:7767","unknownField":42,"teamAgents":[{"id":"x"}]},"app":{"baseUrl":"https://x"}}"#,
        );
        let cfg = PersistedConfig::load(dir.path());
        assert_eq!(cfg.listen(), Some("0.0.0.0:7767"));
    }

    #[test]
    fn parses_hostnames_true() {
        let dir = tempfile::tempdir().unwrap();
        write_config(dir.path(), r#"{"daemon":{"hostnames":true}}"#);
        let cfg = PersistedConfig::load(dir.path());
        assert_eq!(cfg.hostnames(), Some(&HostnamesConfig::Any(true)));
    }

    #[test]
    fn parses_hostnames_list() {
        let dir = tempfile::tempdir().unwrap();
        write_config(dir.path(), r#"{"daemon":{"hostnames":[".example.com","host"]}}"#);
        let cfg = PersistedConfig::load(dir.path());
        assert_eq!(
            cfg.hostnames(),
            Some(&HostnamesConfig::List(vec![
                ".example.com".to_string(),
                "host".to_string()
            ]))
        );
    }

    #[test]
    fn parses_cors_and_auth() {
        let dir = tempfile::tempdir().unwrap();
        write_config(
            dir.path(),
            r#"{"daemon":{"cors":{"allowedOrigins":["https://a"," ","https://b"]},"auth":{"password":"$2b$12$hash"}}}"#,
        );
        let cfg = PersistedConfig::load(dir.path());
        assert_eq!(
            cfg.cors_allowed_origins(),
            vec!["https://a".to_string(), "https://b".to_string()]
        );
        assert_eq!(cfg.auth_password(), Some("$2b$12$hash"));
    }

    #[test]
    fn malformed_json_yields_defaults() {
        let dir = tempfile::tempdir().unwrap();
        write_config(dir.path(), "{not json");
        let cfg = PersistedConfig::load(dir.path());
        assert!(cfg.listen().is_none());
    }
}
