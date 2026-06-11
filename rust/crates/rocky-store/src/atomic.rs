use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use thiserror::Error;

#[derive(Debug, Error)]
pub enum AtomicWriteError {
    #[error("failed to create parent directory {path}: {source}")]
    CreateDir {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("failed to write temp file {path}: {source}")]
    WriteTemp {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("failed to rename {from} -> {to}: {source}")]
    Rename {
        from: PathBuf,
        to: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("failed to serialize JSON: {0}")]
    Serialize(#[from] serde_json::Error),
}

// Monotonic counter so concurrent writes in-process never collide on temp name.
static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

fn temp_path_for(file_path: &Path) -> PathBuf {
    let dir = file_path.parent().unwrap_or_else(|| Path::new("."));
    let base = file_path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "file".to_string());
    let pid = std::process::id();
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let seq = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    dir.join(format!(".{base}.{pid}.{now}.{seq}.tmp"))
}

/// Write a file atomically (temp file + rename), matching `writeFileAtomic`.
pub fn write_file_atomic(file_path: &Path, data: &[u8]) -> Result<(), AtomicWriteError> {
    if let Some(parent) = file_path.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent).map_err(|source| AtomicWriteError::CreateDir {
                path: parent.to_path_buf(),
                source,
            })?;
        }
    }
    let temp_path = temp_path_for(file_path);
    if let Err(source) = std::fs::write(&temp_path, data) {
        let _ = std::fs::remove_file(&temp_path);
        return Err(AtomicWriteError::WriteTemp {
            path: temp_path,
            source,
        });
    }
    if let Err(source) = std::fs::rename(&temp_path, file_path) {
        let _ = std::fs::remove_file(&temp_path);
        return Err(AtomicWriteError::Rename {
            from: temp_path,
            to: file_path.to_path_buf(),
            source,
        });
    }
    Ok(())
}

/// Write a value as pretty-printed JSON atomically, matching
/// `writeJsonFileAtomic`.
pub fn write_json_atomic<T: serde::Serialize>(
    file_path: &Path,
    value: &T,
) -> Result<(), AtomicWriteError> {
    let json = serde_json::to_vec_pretty(value)?;
    write_file_atomic(file_path, &json)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_and_replaces_atomically() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("nested").join("data.json");
        write_file_atomic(&target, b"first").unwrap();
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "first");
        write_file_atomic(&target, b"second").unwrap();
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "second");
        // No leftover temp files.
        let leftovers: Vec<_> = std::fs::read_dir(target.parent().unwrap())
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "temp files left behind: {leftovers:?}");
    }
}
