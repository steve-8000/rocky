//! Daemon E2EE keypair parsing (read-only).
//!
//! Mirrors `core/packages/server/src/server/daemon-keypair.ts`:
//! - `KeyPairSchema` (lines 16-20): `{ v: 2, publicKeyB64: min(1),
//!   secretKeyB64: min(1) }`.
//! - `KEYPAIR_FILENAME = "daemon-keypair.json"` (line 24).
//!
//! This is the read-only Phase 3 projection: it parses an existing stored
//! keypair but does NOT generate one.
//
// TODO(phase>=7): generation requires relay e2ee port (the TS
// `loadOrCreateDaemonKeyPair` calls into the relay crypto to mint a v2 bundle
// when none exists). Until that port lands, this module only reads.

use std::path::Path;

use serde::{Deserialize, Serialize};

const KEYPAIR_FILENAME: &str = "daemon-keypair.json";

/// Persisted daemon keypair bundle.
///
/// Mirrors `KeyPairSchema` (daemon-keypair.ts lines 16-20). `v` must equal `2`
/// and both key strings must be non-empty; see [`StoredKeyPair::is_valid`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredKeyPair {
    pub v: u8,
    pub public_key_b64: String,
    pub secret_key_b64: String,
}

impl StoredKeyPair {
    /// Whether the bundle satisfies `KeyPairSchema`: `v == 2` and both keys
    /// non-empty (`z.literal(2)` + `z.string().min(1)`).
    fn is_valid(&self) -> bool {
        self.v == 2 && !self.public_key_b64.is_empty() && !self.secret_key_b64.is_empty()
    }
}

/// Parse a stored keypair from raw file contents.
///
/// Returns `None` when the JSON is malformed or fails schema validation
/// (`v != 2`, or an empty key string).
fn parse(content: &str) -> Option<StoredKeyPair> {
    let parsed = serde_json::from_str::<StoredKeyPair>(content).ok()?;
    parsed.is_valid().then_some(parsed)
}

/// Read the daemon keypair from `$ROCKY_HOME/daemon-keypair.json`.
///
/// Returns `None` if the file is missing, unreadable, malformed, or invalid
/// (`v != 2` or an empty key). Unlike the TS `loadOrCreateDaemonKeyPair`, this
/// never generates a new keypair (deferred to a later phase).
pub fn read_daemon_keypair(rocky_home: &Path) -> Option<StoredKeyPair> {
    let path = rocky_home.join(KEYPAIR_FILENAME);
    let content = std::fs::read_to_string(path).ok()?;
    parse(&content)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_valid_v2_bundle() {
        let kp = parse(r#"{"v":2,"publicKeyB64":"cHVi","secretKeyB64":"c2Vj"}"#).unwrap();
        assert_eq!(kp.v, 2);
        assert_eq!(kp.public_key_b64, "cHVi");
        assert_eq!(kp.secret_key_b64, "c2Vj");
    }

    #[test]
    fn rejects_v1() {
        assert!(parse(r#"{"v":1,"publicKeyB64":"cHVi","secretKeyB64":"c2Vj"}"#).is_none());
    }

    #[test]
    fn rejects_empty_public_key() {
        assert!(parse(r#"{"v":2,"publicKeyB64":"","secretKeyB64":"c2Vj"}"#).is_none());
    }

    #[test]
    fn rejects_empty_secret_key() {
        assert!(parse(r#"{"v":2,"publicKeyB64":"cHVi","secretKeyB64":""}"#).is_none());
    }

    #[test]
    fn rejects_malformed_json() {
        assert!(parse("{not json").is_none());
    }

    #[test]
    fn read_missing_file_is_none() {
        let dir = tempfile::tempdir().unwrap();
        assert!(read_daemon_keypair(dir.path()).is_none());
    }

    #[test]
    fn read_valid_file() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join(KEYPAIR_FILENAME),
            r#"{"v":2,"publicKeyB64":"cHVi","secretKeyB64":"c2Vj"}"#,
        )
        .unwrap();
        let kp = read_daemon_keypair(dir.path()).unwrap();
        assert_eq!(kp.public_key_b64, "cHVi");
    }

    #[test]
    fn read_invalid_file_is_none() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join(KEYPAIR_FILENAME),
            r#"{"v":1,"publicKeyB64":"cHVi","secretKeyB64":"c2Vj"}"#,
        )
        .unwrap();
        assert!(read_daemon_keypair(dir.path()).is_none());
    }
}
