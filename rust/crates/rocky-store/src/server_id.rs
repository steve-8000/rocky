use std::path::{Path, PathBuf};

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use rand::RngCore;

use crate::write_file_atomic;

const SERVER_ID_FILENAME: &str = "server-id";

/// File mode for the persisted server-id, matching `private-files.ts`
/// (`PRIVATE_FILE_MODE = 0o600`).
const PRIVATE_FILE_MODE: u32 = 0o600;

fn server_id_path(rocky_home: &Path) -> PathBuf {
    rocky_home.join(SERVER_ID_FILENAME)
}

/// Generate `srv_<base64url(9 random bytes)>`.
///
/// Mirrors `generateServerId` in `core/.../server-id.ts`: 9 random bytes
/// base64url-encoded (no padding) -> 12 URL-safe chars.
fn generate_server_id() -> String {
    let mut bytes = [0u8; 9];
    rand::thread_rng().fill_bytes(&mut bytes);
    let encoded = URL_SAFE_NO_PAD.encode(bytes);
    format!("srv_{encoded}")
}

#[cfg(unix)]
fn set_private_mode(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    if let Ok(meta) = std::fs::metadata(path) {
        let mut perms = meta.permissions();
        perms.set_mode(PRIVATE_FILE_MODE);
        let _ = std::fs::set_permissions(path, perms);
    }
}

#[cfg(not(unix))]
fn set_private_mode(_path: &Path) {}

fn persist(path: &Path, value: &str) {
    // Atomic write + chmod 0600 to match `writePrivateFileAtomicSync`.
    if write_file_atomic(path, format!("{value}\n").as_bytes()).is_ok() {
        set_private_mode(path);
    }
}

/// Stable daemon identifier scoped to a given `$ROCKY_HOME`.
///
/// Mirrors `getOrCreateServerId` in
/// `core/packages/server/src/server/server-id.ts`:
/// - `ROCKY_SERVER_ID` env override wins; persisted if not already present.
/// - else read `$ROCKY_HOME/server-id` (trimmed); regenerate if empty/missing.
/// - generated ids are persisted via an atomic private-file write (0600).
///
/// `env_override` is the already-resolved value of `ROCKY_SERVER_ID` (callers
/// pass `std::env::var("ROCKY_SERVER_ID").ok()` or a test value).
pub fn get_or_create_server_id(rocky_home: &Path, env_override: Option<&str>) -> String {
    let path = server_id_path(rocky_home);

    if let Some(raw) = env_override {
        let trimmed = raw.trim();
        if !trimmed.is_empty() {
            // Persist the override for consistent identity across restarts.
            if !path.exists() {
                persist(&path, trimmed);
            } else {
                set_private_mode(&path);
            }
            return trimmed.to_string();
        }
    }

    if path.exists() {
        if let Ok(raw) = std::fs::read_to_string(&path) {
            let parsed = raw.trim();
            if !parsed.is_empty() {
                set_private_mode(&path);
                return parsed.to_string();
            }
        }
    }

    let created = generate_server_id();
    persist(&path, &created);
    created
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generates_and_persists_when_absent() {
        let dir = tempfile::tempdir().unwrap();
        let id = get_or_create_server_id(dir.path(), None);
        assert!(id.starts_with("srv_"), "got {id}");
        // 9 bytes -> 12 base64url chars.
        assert_eq!(id.len(), "srv_".len() + 12, "got {id}");
        // Persisted and stable across calls.
        let again = get_or_create_server_id(dir.path(), None);
        assert_eq!(id, again);
        let persisted = std::fs::read_to_string(dir.path().join("server-id")).unwrap();
        assert_eq!(persisted.trim(), id);
    }

    #[test]
    fn env_override_wins_and_persists() {
        let dir = tempfile::tempdir().unwrap();
        let id = get_or_create_server_id(dir.path(), Some("  srv_custom  "));
        assert_eq!(id, "srv_custom");
        let persisted = std::fs::read_to_string(dir.path().join("server-id")).unwrap();
        assert_eq!(persisted.trim(), "srv_custom");
    }

    #[test]
    fn reads_existing_trimmed() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("server-id"), "srv_existing\n").unwrap();
        let id = get_or_create_server_id(dir.path(), None);
        assert_eq!(id, "srv_existing");
    }

    #[test]
    fn empty_env_override_falls_through() {
        let dir = tempfile::tempdir().unwrap();
        let id = get_or_create_server_id(dir.path(), Some("   "));
        assert!(id.starts_with("srv_"));
    }

    #[cfg(unix)]
    #[test]
    fn persisted_file_is_private() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        get_or_create_server_id(dir.path(), None);
        let mode = std::fs::metadata(dir.path().join("server-id"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o600);
    }
}
