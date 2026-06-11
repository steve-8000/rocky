//! File-backed Mission Control service, an exact port of
//! `FileBackedMissionControlService` in
//! `core/packages/server/src/server/mission-control/service.ts` (lines
//! 158-375).
//!
//! Storage layout: one `{missionId}.json` per mission under
//! `$ROCKY_HOME/missions`, written atomically via `rocky-store`. When a
//! mission's `boardPath` is set, a Markdown board projection is written there
//! too (service.ts `writeBoardProjection`, lines 367-374).

use std::path::{Path, PathBuf};

use rocky_store::{write_file_atomic, write_json_atomic};
use serde_json::{Map, Value};
use tracing::error;

use crate::board::render_mission_board;
use crate::clock::now_iso8601;
use crate::error::MissionControlError;
use crate::types::{
    MissionEvent, MissionRecord, MissionStatus, MissionTask, MissionTaskIsolation,
    MissionTaskStatus, MissionVerification, MissionVersion,
};

/// Input for [`FileBackedMissionControlService::create_mission`], mirroring
/// the TS `CreateMissionInput` (service.ts lines 28-36). Optional fields use
/// `Option` so callers can omit them; `status` defaults to `running`.
#[derive(Debug, Default, Clone)]
pub struct CreateMissionInput {
    pub goal: String,
    pub status: Option<MissionStatus>,
    pub project_id: Option<String>,
    pub workspace_id: Option<String>,
    pub leader_agent_id: Option<String>,
    pub chat_room_id: Option<String>,
    pub board_path: Option<String>,
}

/// Input for [`FileBackedMissionControlService::update_mission`], mirroring the
/// TS `UpdateMissionInput` (service.ts lines 38-45).
///
/// To match the TS `field === undefined ? current : trimToNull(field)`
/// semantics for nullable fields, each patchable nullable field is an
/// `Option<Option<String>>`: outer `None` = "leave unchanged", outer `Some`
/// carries the new (possibly cleared) value. `goal`/`status` follow the TS
/// `?? current` semantics with a plain `Option`.
#[derive(Debug, Default, Clone)]
pub struct UpdateMissionInput {
    pub mission_id: String,
    pub goal: Option<String>,
    pub status: Option<MissionStatus>,
    pub leader_agent_id: Option<Option<String>>,
    pub chat_room_id: Option<Option<String>>,
    pub board_path: Option<Option<String>>,
}

/// Input for [`FileBackedMissionControlService::create_task`], mirroring the TS
/// `CreateMissionTaskInput` (service.ts lines 47-57).
#[derive(Debug, Default, Clone)]
pub struct CreateMissionTaskInput {
    pub mission_id: String,
    pub title: String,
    pub description: Option<String>,
    pub acceptance_criteria: Option<Vec<String>>,
    pub status: Option<MissionTaskStatus>,
    pub owner_agent_id: Option<String>,
    pub roster_agent_id: Option<String>,
    pub worktree_path: Option<String>,
    pub isolation: Option<MissionTaskIsolation>,
}

/// Input for [`FileBackedMissionControlService::update_task`], mirroring the TS
/// `UpdateMissionTaskInput` (service.ts lines 59-72). Nullable patch fields use
/// `Option<Option<String>>` (see [`UpdateMissionInput`]); `acceptance_criteria`
/// and `verification` use a plain `Option` matching the TS `?? current`.
#[derive(Debug, Default, Clone)]
pub struct UpdateMissionTaskInput {
    pub mission_id: String,
    pub task_id: String,
    pub title: Option<String>,
    pub description: Option<Option<String>>,
    pub acceptance_criteria: Option<Vec<String>>,
    pub status: Option<MissionTaskStatus>,
    pub owner_agent_id: Option<Option<String>>,
    pub roster_agent_id: Option<Option<String>>,
    pub worktree_path: Option<Option<String>>,
    pub isolation: Option<MissionTaskIsolation>,
    pub result: Option<Option<String>>,
    pub verification: Option<Vec<MissionVerification>>,
}

/// Trim a value to `Some(trimmed)` when non-empty, else `None`. Port of
/// `trimToNull` (service.ts lines 79-85).
fn trim_to_null(value: Option<&str>) -> Option<String> {
    let trimmed = value?.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

/// Trim a required text field, erroring when empty. Port of `requireText`
/// (service.ts lines 87-93).
fn require_text(value: &str, field: &str) -> Result<String, MissionControlError> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        Err(MissionControlError::InvalidMissionInput(field.to_string()))
    } else {
        Ok(trimmed.to_string())
    }
}

/// Resolve a board path to an absolute path, or `None` when empty. Port of
/// `normalizeBoardPath` (service.ts lines 95-98), where `path.resolve`
/// resolves against the process cwd. We mirror that with
/// `std::env::current_dir` joins for relative inputs.
fn normalize_board_path(value: Option<&str>) -> Option<String> {
    let trimmed = trim_to_null(value)?;
    let path = Path::new(&trimmed);
    let resolved = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .map(|cwd| cwd.join(path))
            .unwrap_or_else(|_| path.to_path_buf())
    };
    Some(normalize_dots(&resolved).to_string_lossy().into_owned())
}

/// Lexically normalize `.`/`..` segments without touching the filesystem,
/// approximating Node `path.resolve`'s pure-lexical collapse.
fn normalize_dots(path: &Path) -> PathBuf {
    use std::path::Component;
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// Compare two missions, port of `compareMissions` (service.ts lines 100-104):
/// `updatedAt` descending, then `createdAt` descending. ISO8601 strings sort
/// lexicographically in chronological order, matching JS `localeCompare` for
/// these fixed-format timestamps.
fn compare_missions(left: &MissionRecord, right: &MissionRecord) -> std::cmp::Ordering {
    right
        .updated_at
        .cmp(&left.updated_at)
        .then_with(|| right.created_at.cmp(&left.created_at))
}

/// Next event seq: last event's seq + 1, or 1 when empty. Port of
/// `nextEventSeq` (service.ts lines 106-109).
fn next_event_seq(mission: &MissionRecord) -> u64 {
    mission.events.last().map(|e| e.seq + 1).unwrap_or(1)
}

/// Build an event for `mission` at `timestamp`. Port of `eventFor` (service.ts
/// lines 111-123). The seq is computed from `mission` *before* the event is
/// appended, exactly as the TS calls it.
fn event_for(
    mission: &MissionRecord,
    event_type: &str,
    payload: Map<String, Value>,
    timestamp: &str,
) -> MissionEvent {
    MissionEvent {
        seq: next_event_seq(mission),
        timestamp: timestamp.to_string(),
        event_type: event_type.to_string(),
        payload,
    }
}

/// Apply completed/archived timestamps when the status warrants it. Port of
/// `withStatusTimestamps` (service.ts lines 125-136): `completedAt`/`archivedAt`
/// are set to `now` only when transitioning into that status and not already
/// set (`?? now`).
fn with_status_timestamps(mission: &mut MissionRecord, status: MissionStatus, now: &str) {
    mission.status = status;
    if status == MissionStatus::Completed && mission.completed_at.is_none() {
        mission.completed_at = Some(now.to_string());
    }
    if status == MissionStatus::Archived && mission.archived_at.is_none() {
        mission.archived_at = Some(now.to_string());
    }
}

/// File-backed Mission Control store. Port of
/// `FileBackedMissionControlService` (service.ts lines 158-375). The TS class
/// also holds a pino logger child; here failures surface as `Result` and board
/// write failures are additionally logged via `tracing`.
#[derive(Debug, Clone)]
pub struct FileBackedMissionControlService {
    dir_path: PathBuf,
}

impl FileBackedMissionControlService {
    /// Construct a service rooted at `$ROCKY_HOME/missions`. Port of the TS
    /// constructor (service.ts lines 162-165).
    pub fn new(rocky_home: impl AsRef<Path>) -> Self {
        Self {
            dir_path: rocky_home.as_ref().join("missions"),
        }
    }

    /// The missions directory backing this service.
    pub fn dir_path(&self) -> &Path {
        &self.dir_path
    }

    /// Ensure the missions directory exists. Port of `initialize` (service.ts
    /// lines 167-169).
    pub fn initialize(&self) -> Result<(), MissionControlError> {
        std::fs::create_dir_all(&self.dir_path)?;
        Ok(())
    }

    /// Create a new mission. Port of `createMission` (service.ts lines
    /// 171-194): id `mis_<uuid v4>`, default status `running`,
    /// completed/archived timestamps when the initial status is
    /// completed/archived, and a `mission_created` event (seq 1).
    pub fn create_mission(
        &self,
        input: CreateMissionInput,
    ) -> Result<MissionRecord, MissionControlError> {
        let now = now_iso8601();
        let status = input.status.unwrap_or(MissionStatus::Running);
        let mut mission = MissionRecord {
            version: MissionVersion,
            id: format!("mis_{}", uuid::Uuid::new_v4()),
            goal: require_text(&input.goal, "goal")?,
            status,
            project_id: trim_to_null(input.project_id.as_deref()),
            workspace_id: trim_to_null(input.workspace_id.as_deref()),
            leader_agent_id: trim_to_null(input.leader_agent_id.as_deref()),
            chat_room_id: trim_to_null(input.chat_room_id.as_deref()),
            board_path: normalize_board_path(input.board_path.as_deref()),
            created_at: now.clone(),
            updated_at: now.clone(),
            completed_at: if status == MissionStatus::Completed {
                Some(now.clone())
            } else {
                None
            },
            archived_at: if status == MissionStatus::Archived {
                Some(now.clone())
            } else {
                None
            },
            tasks: Vec::new(),
            events: Vec::new(),
        };
        let mut payload = Map::new();
        payload.insert("status".to_string(), status_value(status));
        let event = event_for(&mission, "mission_created", payload, &now);
        mission.events.push(event);
        self.write_mission(&mission)?;
        Ok(mission)
    }

    /// List missions, filtering archived unless requested and sorting by
    /// `compareMissions`. Port of `listMissions` (service.ts lines 196-220).
    pub fn list_missions(
        &self,
        include_archived: bool,
    ) -> Result<Vec<MissionRecord>, MissionControlError> {
        self.initialize()?;
        let read_dir = match std::fs::read_dir(&self.dir_path) {
            Ok(rd) => rd,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(err) => return Err(err.into()),
        };
        let mut missions: Vec<MissionRecord> = Vec::new();
        for entry in read_dir {
            let entry = entry?;
            let file_type = entry.file_type()?;
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if !file_type.is_file() || !name.ends_with(".json") {
                continue;
            }
            missions.push(self.read_mission_file(&entry.path())?);
        }
        missions.retain(|m| include_archived || m.status != MissionStatus::Archived);
        missions.sort_by(compare_missions);
        Ok(missions)
    }

    /// Read a mission by id. Port of `inspectMission` (service.ts lines
    /// 222-224).
    pub fn inspect_mission(
        &self,
        mission_id: &str,
    ) -> Result<MissionRecord, MissionControlError> {
        self.read_mission(mission_id)
    }

    /// Apply a partial update to a mission and append a `mission_updated`
    /// event. Port of `updateMission` (service.ts lines 226-256).
    pub fn update_mission(
        &self,
        input: UpdateMissionInput,
    ) -> Result<MissionRecord, MissionControlError> {
        let mut mission = self.read_mission(&input.mission_id)?;
        let now = now_iso8601();
        if let Some(goal) = input.goal.as_deref() {
            mission.goal = require_text(goal, "goal")?;
        }
        let status = input.status.unwrap_or(mission.status);
        if let Some(leader) = input.leader_agent_id {
            mission.leader_agent_id = trim_to_null(leader.as_deref());
        }
        if let Some(chat_room) = input.chat_room_id {
            mission.chat_room_id = trim_to_null(chat_room.as_deref());
        }
        if let Some(board) = input.board_path {
            mission.board_path = normalize_board_path(board.as_deref());
        }
        mission.updated_at = now.clone();
        with_status_timestamps(&mut mission, status, &now);
        let mut payload = Map::new();
        payload.insert("status".to_string(), status_value(status));
        let event = event_for(&mission, "mission_updated", payload, &now);
        mission.events.push(event);
        self.write_mission(&mission)?;
        Ok(mission)
    }

    /// Append a new task to a mission and emit a `task_created` event. Port of
    /// `createTask` (service.ts lines 258-285): id `task_<uuid v4>`, default
    /// isolation `worktree`, default status `todo`.
    pub fn create_task(
        &self,
        input: CreateMissionTaskInput,
    ) -> Result<(MissionRecord, MissionTask), MissionControlError> {
        let mut mission = self.read_mission(&input.mission_id)?;
        let now = now_iso8601();
        let task = MissionTask {
            id: format!("task_{}", uuid::Uuid::new_v4()),
            title: require_text(&input.title, "title")?,
            description: trim_to_null(input.description.as_deref()),
            acceptance_criteria: input.acceptance_criteria.unwrap_or_default(),
            status: input.status.unwrap_or(MissionTaskStatus::Todo),
            owner_agent_id: trim_to_null(input.owner_agent_id.as_deref()),
            roster_agent_id: trim_to_null(input.roster_agent_id.as_deref()),
            worktree_path: trim_to_null(input.worktree_path.as_deref()),
            isolation: input.isolation.unwrap_or(MissionTaskIsolation::Worktree),
            result: None,
            verification: Vec::new(),
            created_at: now.clone(),
            updated_at: now.clone(),
        };
        let mut payload = Map::new();
        payload.insert("taskId".to_string(), Value::String(task.id.clone()));
        let event = event_for(&mission, "task_created", payload, &now);
        mission.updated_at = now.clone();
        mission.tasks.push(task.clone());
        mission.events.push(event);
        self.write_mission(&mission)?;
        Ok((mission, task))
    }

    /// Apply a partial update to a task and emit a `task_updated` event. Port
    /// of `updateTask` (service.ts lines 287-313): errors with
    /// `mission_task_not_found` when the task id is absent.
    pub fn update_task(
        &self,
        input: UpdateMissionTaskInput,
    ) -> Result<(MissionRecord, MissionTask), MissionControlError> {
        let mut mission = self.read_mission(&input.mission_id)?;
        let task_index = mission
            .tasks
            .iter()
            .position(|t| t.id == input.task_id)
            .ok_or_else(|| MissionControlError::MissionTaskNotFound(input.task_id.clone()))?;
        let now = now_iso8601();
        let updated_task = {
            let current = &mission.tasks[task_index];
            MissionTask {
                id: current.id.clone(),
                title: match input.title.as_deref() {
                    Some(title) => require_text(title, "title")?,
                    None => current.title.clone(),
                },
                description: match input.description {
                    Some(ref d) => trim_to_null(d.as_deref()),
                    None => current.description.clone(),
                },
                acceptance_criteria: input
                    .acceptance_criteria
                    .clone()
                    .unwrap_or_else(|| current.acceptance_criteria.clone()),
                status: input.status.unwrap_or(current.status),
                owner_agent_id: match input.owner_agent_id {
                    Some(ref v) => trim_to_null(v.as_deref()),
                    None => current.owner_agent_id.clone(),
                },
                roster_agent_id: match input.roster_agent_id {
                    Some(ref v) => trim_to_null(v.as_deref()),
                    None => current.roster_agent_id.clone(),
                },
                worktree_path: match input.worktree_path {
                    Some(ref v) => trim_to_null(v.as_deref()),
                    None => current.worktree_path.clone(),
                },
                isolation: input.isolation.unwrap_or(current.isolation),
                result: match input.result {
                    Some(ref v) => trim_to_null(v.as_deref()),
                    None => current.result.clone(),
                },
                verification: input
                    .verification
                    .clone()
                    .unwrap_or_else(|| current.verification.clone()),
                created_at: current.created_at.clone(),
                updated_at: now.clone(),
            }
        };
        let mut payload = Map::new();
        payload.insert("taskId".to_string(), Value::String(updated_task.id.clone()));
        payload.insert("status".to_string(), task_status_value(updated_task.status));
        let event = event_for(&mission, "task_updated", payload, &now);
        mission.tasks[task_index] = updated_task.clone();
        mission.updated_at = now.clone();
        mission.events.push(event);
        self.write_mission(&mission)?;
        Ok((mission, updated_task))
    }

    /// Read a mission by id, validating the id. Port of `readMission`
    /// (service.ts lines 315-318).
    fn read_mission(&self, mission_id: &str) -> Result<MissionRecord, MissionControlError> {
        let id = require_text(mission_id, "missionId")?;
        self.read_mission_file(&self.file_path_for(&id)?)
    }

    /// Read and parse a mission file, mapping ENOENT to `mission_not_found`.
    /// Port of `readMissionFile` (service.ts lines 320-333).
    fn read_mission_file(&self, file_path: &Path) -> Result<MissionRecord, MissionControlError> {
        match std::fs::read_to_string(file_path) {
            Ok(raw) => Ok(serde_json::from_str(&raw)?),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                let name = file_path
                    .file_stem()
                    .map(|s| s.to_string_lossy().into_owned())
                    .unwrap_or_default();
                Err(MissionControlError::MissionNotFound(name))
            }
            Err(err) => Err(err.into()),
        }
    }

    /// Resolve a mission id to its file path, rejecting separators. Port of
    /// `filePathFor` (service.ts lines 335-340).
    fn file_path_for(&self, mission_id: &str) -> Result<PathBuf, MissionControlError> {
        if mission_id.contains('/') || mission_id.contains('\\') {
            return Err(MissionControlError::InvalidMissionId(mission_id.to_string()));
        }
        Ok(self.dir_path.join(format!("{mission_id}.json")))
    }

    /// Persist a mission atomically and write its board projection. Port of
    /// `writeMission` (service.ts lines 342-346).
    fn write_mission(&self, mission: &MissionRecord) -> Result<(), MissionControlError> {
        self.initialize()?;
        write_json_atomic(&self.file_path_for(&mission.id)?, mission)?;
        self.write_board_projection(mission)?;
        Ok(())
    }

    /// Write the Markdown board projection when `boardPath` is set. Port of
    /// `writeBoardProjection` (service.ts lines 367-374): ensure the parent
    /// directory exists, then atomically write the rendered board.
    fn write_board_projection(&self, mission: &MissionRecord) -> Result<(), MissionControlError> {
        let Some(board_path) = mission.board_path.as_deref() else {
            return Ok(());
        };
        let board_path = Path::new(board_path);
        let result = (|| -> Result<(), MissionControlError> {
            if let Some(parent) = board_path.parent() {
                std::fs::create_dir_all(parent)?;
            }
            write_file_atomic(board_path, render_mission_board(mission).as_bytes())?;
            Ok(())
        })();
        if let Err(ref err) = result {
            error!(
                mission_id = %mission.id,
                board_path = %board_path.display(),
                error = %err,
                "Failed to write mission board"
            );
        }
        result
    }
}

/// Serialize a mission status to its JSON string value for event payloads,
/// matching the serde rename of [`MissionStatus`].
fn status_value(status: MissionStatus) -> Value {
    serde_json::to_value(status).unwrap_or(Value::Null)
}

/// Serialize a task status to its JSON string value for event payloads.
fn task_status_value(status: MissionTaskStatus) -> Value {
    serde_json::to_value(status).unwrap_or(Value::Null)
}
