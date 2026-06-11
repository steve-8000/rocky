//! Writable schedule store.
//!
//! Port of `core/packages/server/src/server/schedule/store.ts` (`ScheduleStore`).
//! One file per schedule at `<dir>/{id}.json`; ids are `randomBytes(4)` hex
//! (8 lowercase hex chars, store.ts lines 7-9). `list` reads every `*.json`
//! entry and sorts by `createdAt` ascending (store.ts lines 22-34). Writes go
//! through `rocky-store::write_json_atomic` so the on-disk bytes
//! (pretty-printed JSON, 2-space indent) stay identical to
//! `writeJsonFileAtomic`.

use std::path::{Path, PathBuf};

use rand::RngCore;
use rocky_store::{list_schedules, read_schedule, write_json_atomic, StoredSchedule};

#[derive(Debug, thiserror::Error)]
pub enum ScheduleStoreError {
    #[error("schedule not found: {0}")]
    NotFound(String),
    #[error("failed to read schedule {id}: {source}")]
    Read { id: String, source: std::io::Error },
    #[error(transparent)]
    Write(#[from] rocky_store::AtomicWriteError),
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

/// Generate an 8-char lowercase hex id, matching
/// `randomBytes(4).toString("hex")` (store.ts lines 7-9).
fn generate_schedule_id() -> String {
    let mut bytes = [0u8; 4];
    rand::thread_rng().fill_bytes(&mut bytes);
    let mut id = String::with_capacity(8);
    for byte in bytes {
        id.push_str(&format!("{byte:02x}"));
    }
    id
}

/// Writable schedule store rooted at a schedules directory
/// (`$ROCKY_HOME/schedules`).
#[derive(Debug, Clone)]
pub struct ScheduleStore {
    dir: PathBuf,
}

impl ScheduleStore {
    /// Create a store over `dir` (the schedules directory).
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Self { dir: dir.into() }
    }

    fn file_path(&self, id: &str) -> PathBuf {
        self.dir.join(format!("{id}.json"))
    }

    /// List all schedules sorted by `createdAt` ascending (store.ts lines
    /// 22-34). Delegates to the read-only `list_schedules` parser, which
    /// expects the parent of the schedules dir; we reconstruct that root so the
    /// parser scans `<dir>/*.json`.
    pub fn list(&self) -> Vec<StoredSchedule> {
        // `list_schedules` joins "schedules" onto its argument; our `dir`
        // already *is* the schedules directory, so pass its parent. When `dir`
        // has no parent (e.g. a relative bare name), fall back to a direct scan.
        match self.dir.parent() {
            Some(parent) if self.dir.file_name().is_some_and(|n| n == "schedules") => {
                list_schedules(parent)
            }
            _ => self.scan_dir(),
        }
    }

    fn scan_dir(&self) -> Vec<StoredSchedule> {
        let Ok(entries) = std::fs::read_dir(&self.dir) else {
            return Vec::new();
        };
        let mut schedules: Vec<StoredSchedule> = entries
            .filter_map(|entry| entry.ok())
            .filter(|entry| {
                let path = entry.path();
                path.is_file() && path.extension().is_some_and(|ext| ext == "json")
            })
            .filter_map(|entry| read_schedule(&entry.path()).ok())
            .collect();
        schedules.sort_by(|left, right| left.created_at.cmp(&right.created_at));
        schedules
    }

    /// Read a single schedule by id. Returns `Ok(None)` when the file does not
    /// exist, matching `ScheduleStore.get` ENOENT handling (store.ts lines
    /// 36-47).
    pub fn get(&self, id: &str) -> Result<Option<StoredSchedule>, ScheduleStoreError> {
        match read_schedule(&self.file_path(id)) {
            Ok(schedule) => Ok(Some(schedule)),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(source) => Err(ScheduleStoreError::Read {
                id: id.to_string(),
                source,
            }),
        }
    }

    /// Persist a schedule (`ScheduleStore.put`, store.ts lines 55-58).
    pub fn put(&self, schedule: &StoredSchedule) -> Result<(), ScheduleStoreError> {
        write_json_atomic(&self.file_path(&schedule.id), schedule)?;
        Ok(())
    }

    /// Assign a fresh 8-hex id, persist, and return the stored record
    /// (`ScheduleStore.create`, store.ts lines 49-53). The `id` field of the
    /// supplied record is ignored and replaced.
    pub fn create(&self, schedule: StoredSchedule) -> Result<StoredSchedule, ScheduleStoreError> {
        let created = StoredSchedule {
            id: generate_schedule_id(),
            ..schedule
        };
        self.put(&created)?;
        Ok(created)
    }

    /// Remove a schedule file if present (`ScheduleStore.delete`, store.ts lines
    /// 60-63: `rm(..., { force: true })` — missing files are not an error).
    pub fn delete(&self, id: &str) -> Result<(), ScheduleStoreError> {
        match std::fs::remove_file(self.file_path(id)) {
            Ok(()) => Ok(()),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(err) => Err(ScheduleStoreError::Io(err)),
        }
    }

    /// The schedules directory this store writes to.
    pub fn dir(&self) -> &Path {
        &self.dir
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rocky_store::{ScheduleCadence, ScheduleStatus, ScheduleTarget};
    use tempfile::tempdir;

    fn sample(created_at: &str) -> StoredSchedule {
        StoredSchedule {
            id: String::new(),
            name: Some("sample".to_string()),
            prompt: "tick".to_string(),
            cadence: ScheduleCadence::Every { every_ms: 3_600_000 },
            target: ScheduleTarget::Agent {
                agent_id: "agent-1".to_string(),
            },
            status: ScheduleStatus::Active,
            created_at: created_at.to_string(),
            updated_at: created_at.to_string(),
            next_run_at: Some(created_at.to_string()),
            last_run_at: None,
            paused_at: None,
            expires_at: None,
            max_runs: None,
            runs: Vec::new(),
        }
    }

    #[test]
    fn create_assigns_eight_hex_id() {
        let dir = tempdir().unwrap();
        let store = ScheduleStore::new(dir.path().join("schedules"));
        let created = store.create(sample("2026-01-01T00:00:00.000Z")).unwrap();
        assert_eq!(created.id.len(), 8);
        assert!(created.id.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()));
        // File is named after the id and contains exactly that record.
        let path = store.file_path(&created.id);
        assert!(path.is_file());
        let back = store.get(&created.id).unwrap().unwrap();
        assert_eq!(back.id, created.id);
    }

    #[test]
    fn put_get_delete_round_trip() {
        let dir = tempdir().unwrap();
        let store = ScheduleStore::new(dir.path().join("schedules"));
        let created = store.create(sample("2026-01-01T00:00:00.000Z")).unwrap();
        let mut updated = created.clone();
        updated.prompt = "changed".to_string();
        store.put(&updated).unwrap();
        assert_eq!(store.get(&created.id).unwrap().unwrap().prompt, "changed");
        store.delete(&created.id).unwrap();
        assert!(store.get(&created.id).unwrap().is_none());
        // Deleting a missing schedule is a no-op (force: true).
        store.delete(&created.id).unwrap();
    }

    #[test]
    fn list_sorts_by_created_at_and_is_store_compatible() {
        let dir = tempdir().unwrap();
        let store = ScheduleStore::new(dir.path().join("schedules"));
        store.create(sample("2026-03-01T00:00:00.000Z")).unwrap();
        store.create(sample("2026-01-01T00:00:00.000Z")).unwrap();
        store.create(sample("2026-02-01T00:00:00.000Z")).unwrap();
        let listed = store.list();
        assert_eq!(listed.len(), 3);
        assert_eq!(listed[0].created_at, "2026-01-01T00:00:00.000Z");
        assert_eq!(listed[1].created_at, "2026-02-01T00:00:00.000Z");
        assert_eq!(listed[2].created_at, "2026-03-01T00:00:00.000Z");
        // Byte-compatible: the read-only `list_schedules` parser sees the same.
        let via_parser = list_schedules(dir.path());
        assert_eq!(via_parser.len(), 3);
    }
}
