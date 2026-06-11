//! Writable file-backed registries for projects and workspaces.
//!
//! Mirrors `FileBackedRegistry` in
//! `core/packages/server/src/server/workspace-registry.ts` (lines 62-171):
//! an in-memory `Map<id, record>` cache loaded lazily from a bare JSON array,
//! mutated via `upsert`/`archive`/`remove`, and persisted in full on every
//! mutation through `writeJsonFileAtomic` (lines 159-164).
//!
//! The on-disk shape is a bare JSON array of records — NOT wrapped in an object —
//! so files written here stay byte-compatible with the TS registry
//! (`z.array(this.schema).parse(JSON.parse(raw))`, line 147). Reads reuse the
//! permissive `rocky-store` parsers (`read_projects`/`read_workspaces`).
//!
//! Records keep all TS fields (customName/displayName/kind/timestamps/archivedAt)
//! via the `rocky-store` record types, so nothing is dropped on round-trip.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use rocky_store::{
    read_projects, read_workspaces, write_json_atomic, AtomicWriteError, PersistedProjectRecord,
    PersistedWorkspaceRecord,
};
use thiserror::Error;

/// Errors raised by registry persistence.
#[derive(Debug, Error)]
pub enum RegistryError {
    #[error("failed to persist registry: {0}")]
    Persist(#[from] AtomicWriteError),
}

fn projects_path(rocky_home: &Path) -> PathBuf {
    rocky_home.join("projects").join("projects.json")
}

fn workspaces_path(rocky_home: &Path) -> PathBuf {
    rocky_home.join("projects").join("workspaces.json")
}

/// Writable registry for [`PersistedProjectRecord`]s, keyed by `projectId`.
///
/// Mirrors `FileBackedProjectRegistry` (workspace-registry.ts:173-186).
pub struct ProjectRegistry {
    file_path: PathBuf,
    cache: BTreeMap<String, PersistedProjectRecord>,
}

impl ProjectRegistry {
    /// Load the registry at `$ROCKY_HOME/projects/projects.json`, best-effort.
    pub fn load(rocky_home: &Path) -> Self {
        let file_path = projects_path(rocky_home);
        let mut cache = BTreeMap::new();
        for record in read_projects(rocky_home) {
            cache.insert(record.project_id.clone(), record);
        }
        Self { file_path, cache }
    }

    /// Whether the backing file exists on disk
    /// (`existsOnDisk`, workspace-registry.ts:91-98).
    pub fn exists_on_disk(&self) -> bool {
        self.file_path.exists()
    }

    /// All records currently cached (insertion order is not preserved; sorted
    /// by id for determinism).
    pub fn list(&self) -> Vec<PersistedProjectRecord> {
        self.cache.values().cloned().collect()
    }

    /// Look up a single record by `projectId`.
    pub fn get(&self, project_id: &str) -> Option<&PersistedProjectRecord> {
        self.cache.get(project_id)
    }

    /// Insert or replace `record`, then persist the full array atomically.
    pub fn upsert(&mut self, record: PersistedProjectRecord) -> Result<(), RegistryError> {
        self.cache.insert(record.project_id.clone(), record);
        self.persist()
    }

    /// Mark a record archived (`updatedAt`/`archivedAt` set to `archived_at`),
    /// then persist. No-op when the id is unknown
    /// (workspace-registry.ts:117-130).
    pub fn archive(&mut self, project_id: &str, archived_at: &str) -> Result<(), RegistryError> {
        let Some(existing) = self.cache.get_mut(project_id) else {
            return Ok(());
        };
        existing.updated_at = archived_at.to_string();
        existing.archived_at = Some(archived_at.to_string());
        self.persist()
    }

    /// Remove a record, then persist. No-op when the id is unknown
    /// (workspace-registry.ts:132-138).
    pub fn remove(&mut self, project_id: &str) -> Result<(), RegistryError> {
        if self.cache.remove(project_id).is_none() {
            return Ok(());
        }
        self.persist()
    }

    fn persist(&self) -> Result<(), RegistryError> {
        let records = self.list();
        write_json_atomic(&self.file_path, &records)?;
        Ok(())
    }
}

/// Writable registry for [`PersistedWorkspaceRecord`]s, keyed by `workspaceId`.
///
/// Mirrors `FileBackedWorkspaceRegistry` (workspace-registry.ts:188-201).
pub struct WorkspaceRegistry {
    file_path: PathBuf,
    cache: BTreeMap<String, PersistedWorkspaceRecord>,
}

impl WorkspaceRegistry {
    /// Load the registry at `$ROCKY_HOME/projects/workspaces.json`, best-effort.
    pub fn load(rocky_home: &Path) -> Self {
        let file_path = workspaces_path(rocky_home);
        let mut cache = BTreeMap::new();
        for record in read_workspaces(rocky_home) {
            cache.insert(record.workspace_id.clone(), record);
        }
        Self { file_path, cache }
    }

    /// Whether the backing file exists on disk.
    pub fn exists_on_disk(&self) -> bool {
        self.file_path.exists()
    }

    /// All records currently cached, sorted by id for determinism.
    pub fn list(&self) -> Vec<PersistedWorkspaceRecord> {
        self.cache.values().cloned().collect()
    }

    /// Look up a single record by `workspaceId`.
    pub fn get(&self, workspace_id: &str) -> Option<&PersistedWorkspaceRecord> {
        self.cache.get(workspace_id)
    }

    /// Insert or replace `record`, then persist the full array atomically.
    pub fn upsert(&mut self, record: PersistedWorkspaceRecord) -> Result<(), RegistryError> {
        self.cache.insert(record.workspace_id.clone(), record);
        self.persist()
    }

    /// Mark a record archived, then persist. No-op when unknown.
    pub fn archive(&mut self, workspace_id: &str, archived_at: &str) -> Result<(), RegistryError> {
        let Some(existing) = self.cache.get_mut(workspace_id) else {
            return Ok(());
        };
        existing.updated_at = archived_at.to_string();
        existing.archived_at = Some(archived_at.to_string());
        self.persist()
    }

    /// Remove a record, then persist. No-op when unknown.
    pub fn remove(&mut self, workspace_id: &str) -> Result<(), RegistryError> {
        if self.cache.remove(workspace_id).is_none() {
            return Ok(());
        }
        self.persist()
    }

    fn persist(&self) -> Result<(), RegistryError> {
        let records = self.list();
        write_json_atomic(&self.file_path, &records)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rocky_store::ProjectKind;

    fn project(id: &str) -> PersistedProjectRecord {
        PersistedProjectRecord {
            project_id: id.to_string(),
            root_path: format!("/repos/{id}"),
            kind: ProjectKind::Git,
            display_name: format!("Project {id}"),
            custom_name: Some("Custom".to_string()),
            created_at: "2026-01-01T00:00:00.000Z".to_string(),
            updated_at: "2026-01-01T00:00:00.000Z".to_string(),
            archived_at: None,
        }
    }

    fn workspace(id: &str, project_id: &str) -> PersistedWorkspaceRecord {
        PersistedWorkspaceRecord {
            workspace_id: id.to_string(),
            project_id: project_id.to_string(),
            cwd: id.to_string(),
            kind: "worktree".to_string(),
            display_name: "branch-x".to_string(),
            created_at: "2026-01-01T00:00:00.000Z".to_string(),
            updated_at: "2026-01-01T00:00:00.000Z".to_string(),
            archived_at: None,
        }
    }

    #[test]
    fn upsert_persists_and_reloads_via_rocky_store() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path();

        let mut projects = ProjectRegistry::load(home);
        let mut workspaces = WorkspaceRegistry::load(home);
        let proj = project("p1");
        let ws = workspace("/work/p1", "p1");
        projects.upsert(proj.clone()).unwrap();
        workspaces.upsert(ws.clone()).unwrap();

        // Reload through the read-only rocky-store parsers: same records.
        let reloaded_projects = read_projects(home);
        let reloaded_workspaces = read_workspaces(home);
        assert_eq!(reloaded_projects, vec![proj]);
        assert_eq!(reloaded_workspaces, vec![ws]);
    }

    #[test]
    fn preserves_all_fields_including_custom_name() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path();
        let mut projects = ProjectRegistry::load(home);
        let proj = project("p1");
        projects.upsert(proj.clone()).unwrap();

        let mut reloaded = ProjectRegistry::load(home);
        assert_eq!(reloaded.get("p1"), Some(&proj));
        // Round-trips customName.
        assert_eq!(reloaded.get("p1").unwrap().custom_name.as_deref(), Some("Custom"));
        // Cache survives further mutation cleanly.
        reloaded.upsert(project("p2")).unwrap();
        assert_eq!(read_projects(home).len(), 2);
    }

    #[test]
    fn archive_sets_archived_at_and_updated_at() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path();
        let mut projects = ProjectRegistry::load(home);
        projects.upsert(project("p1")).unwrap();
        projects.archive("p1", "2026-06-11T12:00:00.000Z").unwrap();

        let reloaded = read_projects(home);
        assert_eq!(reloaded.len(), 1);
        assert_eq!(reloaded[0].archived_at.as_deref(), Some("2026-06-11T12:00:00.000Z"));
        assert_eq!(reloaded[0].updated_at, "2026-06-11T12:00:00.000Z");
    }

    #[test]
    fn archive_unknown_id_is_noop() {
        let dir = tempfile::tempdir().unwrap();
        let mut projects = ProjectRegistry::load(dir.path());
        projects.archive("missing", "2026-06-11T12:00:00.000Z").unwrap();
        // No file written since nothing changed.
        assert!(!projects.exists_on_disk());
    }

    #[test]
    fn remove_deletes_record() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path();
        let mut workspaces = WorkspaceRegistry::load(home);
        workspaces.upsert(workspace("/work/a", "p1")).unwrap();
        workspaces.upsert(workspace("/work/b", "p1")).unwrap();
        workspaces.remove("/work/a").unwrap();

        let reloaded = read_workspaces(home);
        assert_eq!(reloaded.len(), 1);
        assert_eq!(reloaded[0].workspace_id, "/work/b");
    }

    #[test]
    fn file_on_disk_is_a_bare_json_array() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path();
        let mut projects = ProjectRegistry::load(home);
        projects.upsert(project("p1")).unwrap();

        let raw = std::fs::read_to_string(home.join("projects").join("projects.json")).unwrap();
        let trimmed = raw.trim_start();
        assert!(trimmed.starts_with('['), "expected bare array, got: {raw}");
        // It parses as a JSON array (not an object wrapper) and uses camelCase keys.
        let value: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert!(value.is_array());
        assert!(raw.contains("\"projectId\""));
        assert!(raw.contains("\"customName\""));
    }
}
