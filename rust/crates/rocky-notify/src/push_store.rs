//! Persistent Expo push-token store.
//!
//! Byte-compatible Rust port of
//! `core/packages/server/src/server/push/token-store.ts`.
//!
//! On-disk shape (`$ROCKY_HOME/push-tokens.json`):
//! ```json
//! {
//!   "tokens": [
//!     "ExponentPushToken[aaa]",
//!     "ExponentPushToken[bbb]"
//!   ]
//! }
//! ```
//! Tokens are an insertion-ordered, de-duplicated, trimmed set (TS `Set<string>`
//! serialized via `Array.from`). The file is pretty-printed with 2-space
//! indentation plus a trailing newline (`JSON.stringify(..., null, 2) + "\n"`)
//! and written atomically with mode 0600 (`writePrivateFileAtomicSync`).

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::private_file::write_private_file_atomic;

#[derive(Debug, Error)]
pub enum PushTokenStoreError {
    #[error("failed to persist push tokens to {path}: {source}")]
    Persist {
        path: PathBuf,
        source: rocky_store::AtomicWriteError,
    },
}

/// Permissive parse target matching `JSON.parse(raw) as { tokens?: unknown }`.
/// `tokens` defaults to an empty list when absent or not an array; non-string
/// and blank entries are dropped, mirroring the TS `loadFromDisk` filter.
#[derive(Debug, Default, Deserialize)]
struct PushTokensFileIn {
    #[serde(default)]
    tokens: Option<Vec<serde_json::Value>>,
}

/// Serialization target reproducing `{ tokens: Array.from(this.tokens) }`.
#[derive(Debug, Serialize)]
struct PushTokensFileOut<'a> {
    tokens: &'a [String],
}

/// Store for Expo push tokens, persisted so pushes survive daemon restarts.
#[derive(Debug, Clone)]
pub struct PushTokenStore {
    path: PathBuf,
    /// Insertion-ordered, de-duplicated, trimmed tokens (mirrors TS `Set`).
    tokens: Vec<String>,
}

impl PushTokenStore {
    /// Open the store at `path`, loading existing tokens from disk if present.
    /// Load failures are tolerated (logged, empty set) to match the resilient
    /// TS `loadFromDisk` behavior.
    pub fn open(path: impl Into<PathBuf>) -> Self {
        let path = path.into();
        let tokens = Self::load_from_disk(&path);
        Self { path, tokens }
    }

    /// Path of the backing `push-tokens.json` file.
    pub fn path(&self) -> &Path {
        &self.path
    }

    fn load_from_disk(path: &Path) -> Vec<String> {
        if !path.exists() {
            return Vec::new();
        }
        let raw = match std::fs::read_to_string(path) {
            Ok(raw) => raw,
            Err(err) => {
                tracing::warn!(error = %err, "Failed to load push tokens");
                return Vec::new();
            }
        };
        let parsed: PushTokensFileIn = match serde_json::from_str(&raw) {
            Ok(parsed) => parsed,
            Err(err) => {
                tracing::warn!(error = %err, "Failed to load push tokens");
                return Vec::new();
            }
        };
        let mut tokens = Vec::new();
        for value in parsed.tokens.unwrap_or_default() {
            let serde_json::Value::String(s) = value else {
                continue;
            };
            let trimmed = s.trim();
            if trimmed.is_empty() {
                continue;
            }
            let normalized = trimmed.to_string();
            if !tokens.contains(&normalized) {
                tokens.push(normalized);
            }
        }
        tracing::info!(total = tokens.len(), "Loaded push tokens");
        tokens
    }

    /// Add a token (trimmed). No-op for blank input or duplicates. Persists on
    /// change. Mirrors TS `addToken`.
    pub fn add_token(&mut self, token: &str) -> Result<(), PushTokenStoreError> {
        let normalized = token.trim();
        if normalized.is_empty() {
            return Ok(());
        }
        if self.tokens.iter().any(|t| t == normalized) {
            return Ok(());
        }
        self.tokens.push(normalized.to_string());
        self.persist()?;
        tracing::debug!(total = self.tokens.len(), "Added token");
        Ok(())
    }

    /// Remove a token (trimmed). No-op for blank input or absent token.
    /// Persists only when a token was removed. Mirrors TS `removeToken`.
    pub fn remove_token(&mut self, token: &str) -> Result<(), PushTokenStoreError> {
        let normalized = token.trim();
        if normalized.is_empty() {
            return Ok(());
        }
        let before = self.tokens.len();
        self.tokens.retain(|t| t != normalized);
        if self.tokens.len() != before {
            self.persist()?;
            tracing::debug!(total = self.tokens.len(), "Removed token");
        }
        Ok(())
    }

    /// All stored tokens in insertion order. Mirrors TS `getAllTokens`.
    pub fn list_tokens(&self) -> Vec<String> {
        self.tokens.clone()
    }

    fn persist(&self) -> Result<(), PushTokenStoreError> {
        let payload = serde_json::to_string_pretty(&PushTokensFileOut {
            tokens: &self.tokens,
        })
        .expect("serializing push tokens never fails");
        // `JSON.stringify(..., null, 2) + "\n"`.
        let payload = format!("{payload}\n");
        write_private_file_atomic(&self.path, payload.as_bytes()).map_err(|source| {
            PushTokenStoreError::Persist {
                path: self.path.clone(),
                source,
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store_path(dir: &Path) -> PathBuf {
        dir.join("push-tokens.json")
    }

    #[test]
    fn add_list_remove_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let path = store_path(dir.path());

        let mut store = PushTokenStore::open(&path);
        store.add_token("ExponentPushToken[aaa]").unwrap();
        store.add_token("ExponentPushToken[bbb]").unwrap();
        assert_eq!(
            store.list_tokens(),
            vec![
                "ExponentPushToken[aaa]".to_string(),
                "ExponentPushToken[bbb]".to_string(),
            ]
        );

        // Reload from disk: persisted state round-trips.
        let reloaded = PushTokenStore::open(&path);
        assert_eq!(
            reloaded.list_tokens(),
            vec![
                "ExponentPushToken[aaa]".to_string(),
                "ExponentPushToken[bbb]".to_string(),
            ]
        );

        store.remove_token("ExponentPushToken[aaa]").unwrap();
        assert_eq!(
            store.list_tokens(),
            vec!["ExponentPushToken[bbb]".to_string()]
        );
        let reloaded = PushTokenStore::open(&path);
        assert_eq!(
            reloaded.list_tokens(),
            vec!["ExponentPushToken[bbb]".to_string()]
        );
    }

    #[test]
    fn dedupes_duplicate_and_blank_tokens() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = PushTokenStore::open(store_path(dir.path()));
        store.add_token("tok").unwrap();
        store.add_token("tok").unwrap();
        // Trimmed comparison: padded duplicate is the same token.
        store.add_token("  tok  ").unwrap();
        store.add_token("   ").unwrap();
        store.add_token("").unwrap();
        assert_eq!(store.list_tokens(), vec!["tok".to_string()]);
    }

    #[test]
    fn file_on_disk_matches_ts_shape() {
        let dir = tempfile::tempdir().unwrap();
        let path = store_path(dir.path());
        let mut store = PushTokenStore::open(&path);
        store.add_token("a").unwrap();
        store.add_token("b").unwrap();

        let raw = std::fs::read_to_string(&path).unwrap();
        // Byte-for-byte: `JSON.stringify({ tokens }, null, 2) + "\n"`.
        let expected = "{\n  \"tokens\": [\n    \"a\",\n    \"b\"\n  ]\n}\n";
        assert_eq!(raw, expected);
    }

    #[test]
    fn empty_file_shape_matches_ts() {
        let dir = tempfile::tempdir().unwrap();
        let path = store_path(dir.path());
        let mut store = PushTokenStore::open(&path);
        // Force a persist with no tokens by adding then removing.
        store.add_token("x").unwrap();
        store.remove_token("x").unwrap();
        let raw = std::fs::read_to_string(&path).unwrap();
        assert_eq!(raw, "{\n  \"tokens\": []\n}\n");
    }

    #[test]
    fn tolerates_missing_and_malformed_entries() {
        let dir = tempfile::tempdir().unwrap();
        let path = store_path(dir.path());
        std::fs::write(
            &path,
            "{\n  \"tokens\": [\"keep\", 42, \"\", \"  \", \"keep\", \"two\"]\n}\n",
        )
        .unwrap();
        let store = PushTokenStore::open(&path);
        assert_eq!(
            store.list_tokens(),
            vec!["keep".to_string(), "two".to_string()]
        );
    }

    #[test]
    fn missing_file_loads_empty() {
        let dir = tempfile::tempdir().unwrap();
        let store = PushTokenStore::open(store_path(dir.path()));
        assert!(store.list_tokens().is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn persisted_file_is_private() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = store_path(dir.path());
        let mut store = PushTokenStore::open(&path);
        store.add_token("tok").unwrap();
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }
}
