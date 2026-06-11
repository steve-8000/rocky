use std::path::{Path, PathBuf};

use thiserror::Error;

/// Private directory mode, matching `PRIVATE_DIRECTORY_MODE` in
/// `core/packages/server/src/server/private-files.ts`.
pub const PRIVATE_DIRECTORY_MODE: u32 = 0o700;

#[derive(Debug, Error)]
pub enum RockyHomeError {
    #[error("could not determine home directory for '~' expansion")]
    NoHomeDir,
    #[error("failed to create ROCKY_HOME at {path}: {source}")]
    CreateDir {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
}

/// Resolve `$ROCKY_HOME` from the process environment, creating it with private
/// permissions where supported.
///
/// Mirrors `resolveRockyHome()` in `rocky-home.ts`:
/// - default is `~/.rocky`
/// - `~` / `~/...` are expanded against the user home directory
/// - the resolved path is created (recursively) and chmod'd to 0o700
pub fn resolve_rocky_home() -> Result<PathBuf, RockyHomeError> {
    resolve_rocky_home_from(std::env::var_os("ROCKY_HOME").as_deref().map(|s| s.to_owned()))
}

/// Resolve `$ROCKY_HOME` from an explicit raw value (or default when `None`).
pub fn resolve_rocky_home_from(
    raw: Option<std::ffi::OsString>,
) -> Result<PathBuf, RockyHomeError> {
    let raw = raw
        .and_then(|value| value.into_string().ok())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "~/.rocky".to_string());

    let expanded = expand_home_dir(&raw)?;
    let resolved = absolutize(&expanded);
    ensure_private_directory(&resolved)?;
    Ok(resolved)
}

fn expand_home_dir(input: &str) -> Result<PathBuf, RockyHomeError> {
    if input == "~" {
        return home_dir().ok_or(RockyHomeError::NoHomeDir);
    }
    if let Some(rest) = input.strip_prefix("~/") {
        let mut base = home_dir().ok_or(RockyHomeError::NoHomeDir)?;
        base.push(rest);
        return Ok(base);
    }
    Ok(PathBuf::from(input))
}

/// Make a path absolute without requiring it to exist (like `path.resolve`).
fn absolutize(path: &Path) -> PathBuf {
    if path.is_absolute() {
        return path.to_path_buf();
    }
    match std::env::current_dir() {
        Ok(cwd) => cwd.join(path),
        Err(_) => path.to_path_buf(),
    }
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

/// Create the directory recursively and set private permissions (best effort on
/// non-Unix platforms), matching `ensurePrivateDirectory`.
fn ensure_private_directory(path: &Path) -> Result<(), RockyHomeError> {
    std::fs::create_dir_all(path).map_err(|source| RockyHomeError::CreateDir {
        path: path.to_path_buf(),
        source,
    })?;
    chmod_best_effort(path, PRIVATE_DIRECTORY_MODE);
    Ok(())
}

#[cfg(unix)]
fn chmod_best_effort(path: &Path, mode: u32) {
    use std::os::unix::fs::PermissionsExt;
    if let Ok(meta) = std::fs::metadata(path) {
        let mut perms = meta.permissions();
        perms.set_mode(mode);
        let _ = std::fs::set_permissions(path, perms);
    }
}

#[cfg(not(unix))]
fn chmod_best_effort(_path: &Path, _mode: u32) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expands_tilde_slash() {
        std::env::set_var("HOME", "/tmp/fake-home");
        let expanded = expand_home_dir("~/.rocky").unwrap();
        assert_eq!(expanded, PathBuf::from("/tmp/fake-home/.rocky"));
    }

    #[test]
    fn expands_bare_tilde() {
        std::env::set_var("HOME", "/tmp/fake-home");
        let expanded = expand_home_dir("~").unwrap();
        assert_eq!(expanded, PathBuf::from("/tmp/fake-home"));
    }

    #[test]
    fn leaves_absolute_untouched() {
        let expanded = expand_home_dir("/var/lib/rocky").unwrap();
        assert_eq!(expanded, PathBuf::from("/var/lib/rocky"));
    }

    #[test]
    fn resolves_and_creates_with_private_mode() {
        let parent = tempfile::tempdir().unwrap();
        let home = parent.path().join("home");
        let resolved =
            resolve_rocky_home_from(Some(home.clone().into_os_string())).unwrap();
        assert_eq!(resolved, home);
        assert!(home.is_dir());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&home).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, PRIVATE_DIRECTORY_MODE);
        }
    }
}
