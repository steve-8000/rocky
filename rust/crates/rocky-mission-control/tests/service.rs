//! Behavioral tests for the file-backed Mission Control service, mirroring the
//! lifecycle, sort, error, board, and persistence semantics ported from
//! `core/packages/server/src/server/mission-control/service.ts`.

use rocky_mission_control::{
    render_mission_board, CreateMissionInput, CreateMissionTaskInput, FileBackedMissionControlService,
    MissionControlError, MissionRecord, MissionStatus, MissionTaskStatus, MissionVersion,
    UpdateMissionInput, UpdateMissionTaskInput,
};
use tempfile::TempDir;

fn service() -> (TempDir, FileBackedMissionControlService) {
    let dir = TempDir::new().unwrap();
    let svc = FileBackedMissionControlService::new(dir.path());
    svc.initialize().unwrap();
    (dir, svc)
}

#[test]
fn full_lifecycle_events_in_order() {
    let (_dir, svc) = service();
    let mission = svc
        .create_mission(CreateMissionInput {
            goal: "  Ship the thing  ".to_string(),
            ..Default::default()
        })
        .unwrap();
    // goal trimmed; default status running; mission_created seq 1.
    assert_eq!(mission.goal, "Ship the thing");
    assert_eq!(mission.status, MissionStatus::Running);
    assert_eq!(mission.events.len(), 1);
    assert_eq!(mission.events[0].seq, 1);
    assert_eq!(mission.events[0].event_type, "mission_created");
    assert!(mission.completed_at.is_none());

    let (_m, task) = svc
        .create_task(CreateMissionTaskInput {
            mission_id: mission.id.clone(),
            title: "Write the port".to_string(),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(task.status, MissionTaskStatus::Todo);
    assert!(task.id.starts_with("task_"));

    let (mission_after_task, updated_task) = svc
        .update_task(UpdateMissionTaskInput {
            mission_id: mission.id.clone(),
            task_id: task.id.clone(),
            status: Some(MissionTaskStatus::Done),
            result: Some(Some("landed in main".to_string())),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(updated_task.status, MissionTaskStatus::Done);
    assert_eq!(updated_task.result.as_deref(), Some("landed in main"));
    assert_eq!(mission_after_task.tasks[0].result.as_deref(), Some("landed in main"));

    let completed = svc
        .update_mission(UpdateMissionInput {
            mission_id: mission.id.clone(),
            status: Some(MissionStatus::Completed),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(completed.status, MissionStatus::Completed);
    assert!(completed.completed_at.is_some());

    // Events: mission_created, task_created, task_updated, mission_updated with
    // seq 1..=4 strictly increasing in order.
    let types: Vec<&str> = completed.events.iter().map(|e| e.event_type.as_str()).collect();
    assert_eq!(
        types,
        vec!["mission_created", "task_created", "task_updated", "mission_updated"]
    );
    let seqs: Vec<u64> = completed.events.iter().map(|e| e.seq).collect();
    assert_eq!(seqs, vec![1, 2, 3, 4]);

    // task_updated payload carries the task status; mission_updated the status.
    let task_updated = &completed.events[2];
    assert_eq!(task_updated.payload["taskId"], task.id.as_str());
    assert_eq!(task_updated.payload["status"], "done");
    let mission_updated = &completed.events[3];
    assert_eq!(mission_updated.payload["status"], "completed");
}

#[test]
fn list_missions_sorts_and_filters_archived() {
    let (_dir, svc) = service();
    let a = svc
        .create_mission(CreateMissionInput {
            goal: "first".to_string(),
            ..Default::default()
        })
        .unwrap();
    let b = svc
        .create_mission(CreateMissionInput {
            goal: "second".to_string(),
            ..Default::default()
        })
        .unwrap();

    // Bump `a`'s updatedAt so it sorts ahead of `b` (updatedAt desc). The clock
    // has millisecond resolution; sleep to guarantee a strictly later stamp.
    std::thread::sleep(std::time::Duration::from_millis(5));
    let a = svc
        .update_mission(UpdateMissionInput {
            mission_id: a.id.clone(),
            goal: Some("first updated".to_string()),
            ..Default::default()
        })
        .unwrap();
    assert!(a.updated_at > b.updated_at);

    let listed = svc.list_missions(false).unwrap();
    assert_eq!(listed.len(), 2);
    assert_eq!(listed[0].id, a.id, "most-recently-updated mission sorts first");
    assert_eq!(listed[1].id, b.id);

    // Archiving b removes it from the default listing but not when included.
    svc.update_mission(UpdateMissionInput {
        mission_id: b.id.clone(),
        status: Some(MissionStatus::Archived),
        ..Default::default()
    })
    .unwrap();
    let visible = svc.list_missions(false).unwrap();
    assert_eq!(visible.len(), 1);
    assert_eq!(visible[0].id, a.id);
    let all = svc.list_missions(true).unwrap();
    assert_eq!(all.len(), 2);
    let archived = all.iter().find(|m| m.id == b.id).unwrap();
    assert_eq!(archived.status, MissionStatus::Archived);
    assert!(archived.archived_at.is_some());
}

#[test]
fn inspect_missing_mission_errors() {
    let (_dir, svc) = service();
    let err = svc.inspect_mission("mis_does_not_exist").unwrap_err();
    assert!(matches!(err, MissionControlError::MissionNotFound(_)));
    assert_eq!(err.code(), "mission_not_found");
}

#[test]
fn update_task_bad_id_errors() {
    let (_dir, svc) = service();
    let mission = svc
        .create_mission(CreateMissionInput {
            goal: "g".to_string(),
            ..Default::default()
        })
        .unwrap();
    let err = svc
        .update_task(UpdateMissionTaskInput {
            mission_id: mission.id,
            task_id: "task_missing".to_string(),
            ..Default::default()
        })
        .unwrap_err();
    assert!(matches!(err, MissionControlError::MissionTaskNotFound(_)));
    assert_eq!(err.code(), "mission_task_not_found");
}

#[test]
fn invalid_mission_id_rejected() {
    let (_dir, svc) = service();
    // The id flows through read_mission -> file_path_for, which rejects
    // separators with invalid_mission_id.
    let err = svc.inspect_mission("foo/bar").unwrap_err();
    assert!(matches!(err, MissionControlError::InvalidMissionId(_)));
    assert_eq!(err.code(), "invalid_mission_id");
    let err = svc.inspect_mission("foo\\bar").unwrap_err();
    assert_eq!(err.code(), "invalid_mission_id");
}

#[test]
fn board_projection_written_and_matches_render() {
    let (dir, svc) = service();
    let board_path = dir.path().join("nested").join("TEAM_BOARD.md");
    let mission = svc
        .create_mission(CreateMissionInput {
            goal: "Board goal".to_string(),
            board_path: Some(board_path.to_string_lossy().into_owned()),
            ..Default::default()
        })
        .unwrap();
    let (mission, _task) = svc
        .create_task(CreateMissionTaskInput {
            mission_id: mission.id.clone(),
            title: "Cell with | pipe\nand newline".to_string(),
            owner_agent_id: Some("agent_7".to_string()),
            ..Default::default()
        })
        .unwrap();

    let written = std::fs::read_to_string(&board_path).unwrap();
    let expected = render_mission_board(&mission);
    assert_eq!(written, expected);

    // escapeBoardCell behavior surfaces in the row: pipe escaped, newline -> space.
    assert!(written.contains("Cell with \\| pipe and newline"));
    assert!(written.contains("| agent_7 |"));
    assert!(written.starts_with("# Team Board — Board goal\n"));
    assert!(written.ends_with(" |\n"));
}

#[test]
fn version_serializes_as_integer_and_round_trips() {
    let (dir, svc) = service();
    let mission = svc
        .create_mission(CreateMissionInput {
            goal: "round trip".to_string(),
            ..Default::default()
        })
        .unwrap();

    let file = dir.path().join("missions").join(format!("{}.json", mission.id));
    let raw = std::fs::read_to_string(&file).unwrap();
    // version must be the bare integer literal 1, not a string or float.
    let json: serde_json::Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(json["version"], serde_json::json!(1));
    assert!(raw.contains("\"version\": 1"));

    // Round-trip: parsing the written file yields the in-memory record.
    let reparsed: MissionRecord = serde_json::from_str(&raw).unwrap();
    assert_eq!(reparsed, mission);
    assert_eq!(reparsed.version, MissionVersion);

    // A foreign version is rejected on parse (literal-1 guard).
    let tampered = raw.replacen("\"version\": 1", "\"version\": 2", 1);
    assert!(serde_json::from_str::<MissionRecord>(&tampered).is_err());
}

#[test]
fn persistence_reload_returns_same_record() {
    let (dir, svc) = service();
    let mission = svc
        .create_mission(CreateMissionInput {
            goal: "persist me".to_string(),
            project_id: Some("proj_1".to_string()),
            ..Default::default()
        })
        .unwrap();

    // File exists at $ROCKY_HOME/missions/{id}.json.
    let file = dir.path().join("missions").join(format!("{}.json", mission.id));
    assert!(file.exists(), "mission file should be written to disk");

    // A fresh service instance over the same home reloads identical data.
    let reloaded = FileBackedMissionControlService::new(dir.path());
    let inspected = reloaded.inspect_mission(&mission.id).unwrap();
    assert_eq!(inspected, mission);
    let listed = reloaded.list_missions(false).unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0], mission);
}
