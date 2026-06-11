//! Project/workspace registry projection (read-only).
//!
//! Mirrors `core/packages/server/src/server/workspace-registry.ts`:
//! - `PersistedProjectRecordSchema` (lines 9-24)
//! - `PersistedWorkspaceRecordSchema` (lines 26-35)
//!
//! Both registries persist a bare JSON array of records via
//! `writeJsonFileAtomic(this.filePath, records)` (workspace-registry.ts:161-164),
//! and load with `z.array(this.schema).parse(JSON.parse(raw))` (lines 147-148).
//! Files live at `$ROCKY_HOME/projects/projects.json` and
//! `$ROCKY_HOME/projects/workspaces.json` (bootstrap.ts:545-552).
//!
//! Parsing is permissive: unknown fields are ignored, optional fields become
//! `Option<T>`, and malformed entries are skipped best-effort rather than
//! failing the whole read.

use std::path::Path;

use serde::{Deserialize, Serialize};

/// Project kind, matching `kind: z.enum(["git", "non_git"])`
/// (workspace-registry.ts:12).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ProjectKind {
    #[serde(rename = "git")]
    Git,
    #[serde(rename = "non_git")]
    NonGit,
}

/// Persisted project record, matching `PersistedProjectRecordSchema`
/// (workspace-registry.ts:9-24).
///
/// `customName` is nullable+optional in TS (lines 16-20); `archivedAt` is
/// nullable (line 23).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistedProjectRecord {
    pub project_id: String,
    pub root_path: String,
    pub kind: ProjectKind,
    pub display_name: String,
    #[serde(default)]
    pub custom_name: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub archived_at: Option<String>,
}

/// Persisted workspace record, matching `PersistedWorkspaceRecordSchema`
/// (workspace-registry.ts:26-35).
///
/// `kind` is `z.enum(["local_checkout", "worktree", "directory"])` (line 30);
/// kept as a plain `String` here since the Rust projection does not switch on
/// it and new variants must not break the read.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistedWorkspaceRecord {
    pub workspace_id: String,
    pub project_id: String,
    pub cwd: String,
    pub kind: String,
    pub display_name: String,
    pub created_at: String,
    pub updated_at: String,
    pub archived_at: Option<String>,
}

fn projects_path(rocky_home: &Path) -> std::path::PathBuf {
    rocky_home.join("projects").join("projects.json")
}

fn workspaces_path(rocky_home: &Path) -> std::path::PathBuf {
    rocky_home.join("projects").join("workspaces.json")
}

/// Parse a bare JSON array of records, skipping malformed entries.
///
/// Returns an empty vec when the file is missing or the top level is not a
/// JSON array, matching the TS loader's ENOENT tolerance
/// (workspace-registry.ts:140-159).
fn read_records<T: for<'de> Deserialize<'de>>(path: &Path) -> Vec<T> {
    let Ok(raw) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return Vec::new();
    };
    let Some(array) = value.as_array() else {
        return Vec::new();
    };
    array
        .iter()
        .filter_map(|entry| serde_json::from_value::<T>(entry.clone()).ok())
        .collect()
}

/// Read `$ROCKY_HOME/projects/projects.json`, best-effort.
pub fn read_projects(rocky_home: &Path) -> Vec<PersistedProjectRecord> {
    read_records(&projects_path(rocky_home))
}

/// Read `$ROCKY_HOME/projects/workspaces.json`, best-effort.
pub fn read_workspaces(rocky_home: &Path) -> Vec<PersistedWorkspaceRecord> {
    read_records(&workspaces_path(rocky_home))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn write_projects(dir: &TempDir, body: &str) {
        let path = projects_path(dir.path());
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, body).unwrap();
    }

    #[test]
    fn parses_full_project_record() {
        let dir = TempDir::new().unwrap();
        write_projects(
            &dir,
            r#"[
              {
                "projectId": "proj_1",
                "rootPath": "/repo",
                "kind": "git",
                "displayName": "Repo",
                "customName": "My Repo",
                "createdAt": "2026-01-01T00:00:00.000Z",
                "updatedAt": "2026-01-02T00:00:00.000Z",
                "archivedAt": null
              }
            ]"#,
        );
        let records = read_projects(dir.path());
        assert_eq!(records.len(), 1);
        let record = &records[0];
        assert_eq!(record.project_id, "proj_1");
        assert_eq!(record.root_path, "/repo");
        assert_eq!(record.kind, ProjectKind::Git);
        assert_eq!(record.display_name, "Repo");
        assert_eq!(record.custom_name.as_deref(), Some("My Repo"));
        assert_eq!(record.archived_at, None);
    }

    #[test]
    fn parses_minimal_project_record() {
        let dir = TempDir::new().unwrap();
        write_projects(
            &dir,
            r#"[
              {
                "projectId": "proj_2",
                "rootPath": "/dir",
                "kind": "non_git",
                "displayName": "Dir",
                "createdAt": "2026-01-01T00:00:00.000Z",
                "updatedAt": "2026-01-01T00:00:00.000Z",
                "archivedAt": "2026-02-01T00:00:00.000Z"
              }
            ]"#,
        );
        let records = read_projects(dir.path());
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].kind, ProjectKind::NonGit);
        assert_eq!(records[0].custom_name, None);
        assert_eq!(
            records[0].archived_at.as_deref(),
            Some("2026-02-01T00:00:00.000Z")
        );
    }

    #[test]
    fn ignores_unknown_fields() {
        let dir = TempDir::new().unwrap();
        write_projects(
            &dir,
            r#"[
              {
                "projectId": "proj_3",
                "rootPath": "/x",
                "kind": "git",
                "displayName": "X",
                "createdAt": "2026-01-01T00:00:00.000Z",
                "updatedAt": "2026-01-01T00:00:00.000Z",
                "archivedAt": null,
                "futureField": {"nested": true}
              }
            ]"#,
        );
        let records = read_projects(dir.path());
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].project_id, "proj_3");
    }

    #[test]
    fn missing_file_yields_empty() {
        let dir = TempDir::new().unwrap();
        assert!(read_projects(dir.path()).is_empty());
        assert!(read_workspaces(dir.path()).is_empty());
    }

    #[test]
    fn skips_malformed_entries() {
        let dir = TempDir::new().unwrap();
        write_projects(
            &dir,
            r#"[
              {"projectId": "ok", "rootPath": "/a", "kind": "git", "displayName": "A", "createdAt": "t", "updatedAt": "t", "archivedAt": null},
              {"projectId": "bad"}
            ]"#,
        );
        let records = read_projects(dir.path());
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].project_id, "ok");
    }

    #[test]
    fn parses_full_workspace_record() {
        let dir = TempDir::new().unwrap();
        let path = workspaces_path(dir.path());
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(
            path,
            r#"[
              {
                "workspaceId": "ws_1",
                "projectId": "proj_1",
                "cwd": "/repo/wt",
                "kind": "worktree",
                "displayName": "Worktree",
                "createdAt": "2026-01-01T00:00:00.000Z",
                "updatedAt": "2026-01-01T00:00:00.000Z",
                "archivedAt": null
              }
            ]"#,
        )
        .unwrap();
        let records = read_workspaces(dir.path());
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].workspace_id, "ws_1");
        assert_eq!(records[0].project_id, "proj_1");
        assert_eq!(records[0].cwd, "/repo/wt");
        assert_eq!(records[0].kind, "worktree");
    }
}
