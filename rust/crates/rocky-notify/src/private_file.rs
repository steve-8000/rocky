//! Atomic private-file write mirroring
//! `core/packages/server/src/server/private-files.ts`.
//!
//! TS `writePrivateFileAtomicSync` writes with `PRIVATE_FILE_MODE = 0o600`
//! into a directory ensured at `PRIVATE_DIRECTORY_MODE = 0o700`, then renames
//! atomically. We reuse `rocky-store`'s `write_file_atomic` (temp + rename)
//! and apply the private modes best-effort on unix, matching the TS
//! `chmodBestEffort` semantics (silently tolerate filesystems without POSIX
//! modes / non-unix platforms).

use std::path::Path;

use rocky_store::{write_file_atomic, AtomicWriteError};

/// File mode for private files, matching `PRIVATE_FILE_MODE = 0o600`.
pub const PRIVATE_FILE_MODE: u32 = 0o600;
/// Directory mode for private directories, matching `PRIVATE_DIRECTORY_MODE = 0o700`.
pub const PRIVATE_DIRECTORY_MODE: u32 = 0o700;

#[cfg(unix)]
fn chmod_best_effort(path: &Path, mode: u32) {
    use std::os::unix::fs::PermissionsExt;
    if let Ok(meta) = std::fs::metadata(path) {
        let mut perms = meta.permissions();
        perms.set_mode(mode);
        // Best-effort: keep resilient if the filesystem rejects POSIX modes.
        let _ = std::fs::set_permissions(path, perms);
    }
}

#[cfg(not(unix))]
fn chmod_best_effort(_path: &Path, _mode: u32) {}

/// Write `data` atomically to `file_path` with private (0600) permissions,
/// ensuring the parent directory is private (0700). Mirrors
/// `writePrivateFileAtomicSync`.
pub fn write_private_file_atomic(file_path: &Path, data: &[u8]) -> Result<(), AtomicWriteError> {
    write_file_atomic(file_path, data)?;
    if let Some(parent) = file_path.parent() {
        if !parent.as_os_str().is_empty() {
            chmod_best_effort(parent, PRIVATE_DIRECTORY_MODE);
        }
    }
    chmod_best_effort(file_path, PRIVATE_FILE_MODE);
    Ok(())
}
