//! End-to-end test: mission RPCs over the session dispatcher, backed by the
//! real file-backed Mission Control service in a temp `$ROCKY_HOME`.

use std::sync::{Arc, Mutex};

use rocky_mission_control::FileBackedMissionControlService;
use rocky_ws_session::handlers::mission;
use rocky_ws_session::SessionDispatcher;
use serde_json::{json, Value};

fn dispatcher_with_temp_home() -> (SessionDispatcher, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let svc = FileBackedMissionControlService::new(dir.path());
    svc.initialize().unwrap();
    let shared = Arc::new(Mutex::new(svc));
    let mut d = SessionDispatcher::new();
    mission::register(&mut d, shared);
    (d, dir)
}

fn session_envelope(inner: Value) -> Value {
    json!({ "type": "session", "message": inner })
}

#[tokio::test]
async fn mission_lifecycle_over_session_rpc() {
    let (d, _home) = dispatcher_with_temp_home();

    // create
    let out = d
        .dispatch_envelope(&session_envelope(json!({
            "type": "mission.create.request",
            "requestId": "c1",
            "goal": "ws session mission e2e"
        })))
        .await
        .unwrap();
    assert_eq!(out["type"], "session");
    let payload = &out["message"]["payload"];
    assert_eq!(out["message"]["type"], "mission.create.response");
    assert_eq!(payload["requestId"], "c1");
    assert!(payload["error"].is_null());
    let mission_id = payload["mission"]["id"].as_str().unwrap().to_string();
    assert!(mission_id.starts_with("mis_"));
    assert_eq!(payload["mission"]["status"], "running");

    // task create
    let out = d
        .dispatch_envelope(&session_envelope(json!({
            "type": "mission.task.create.request",
            "requestId": "tc1",
            "missionId": mission_id,
            "title": "first task",
            "acceptanceCriteria": ["tests pass"],
            "isolation": "shared"
        })))
        .await
        .unwrap();
    let payload = &out["message"]["payload"];
    assert_eq!(out["message"]["type"], "mission.task.create.response");
    let task_id = payload["task"]["id"].as_str().unwrap().to_string();
    assert!(task_id.starts_with("task_"));
    assert_eq!(payload["task"]["isolation"], "shared");

    // task update -> done
    let out = d
        .dispatch_envelope(&session_envelope(json!({
            "type": "mission.task.update.request",
            "requestId": "tu1",
            "missionId": mission_id,
            "taskId": task_id,
            "status": "done",
            "result": "verified"
        })))
        .await
        .unwrap();
    let payload = &out["message"]["payload"];
    assert_eq!(payload["task"]["status"], "done");
    assert_eq!(payload["task"]["result"], "verified");

    // mission update -> completed
    let out = d
        .dispatch_envelope(&session_envelope(json!({
            "type": "mission.update.request",
            "requestId": "u1",
            "missionId": mission_id,
            "status": "completed"
        })))
        .await
        .unwrap();
    assert_eq!(out["message"]["payload"]["mission"]["status"], "completed");
    assert!(!out["message"]["payload"]["mission"]["completedAt"].is_null());

    // list
    let out = d
        .dispatch_envelope(&session_envelope(json!({
            "type": "mission.list.request",
            "requestId": "l1"
        })))
        .await
        .unwrap();
    let missions = out["message"]["payload"]["missions"].as_array().unwrap();
    assert_eq!(missions.len(), 1);
    assert_eq!(missions[0]["id"], mission_id);

    // inspect
    let out = d
        .dispatch_envelope(&session_envelope(json!({
            "type": "mission.inspect.request",
            "requestId": "i1",
            "missionId": mission_id
        })))
        .await
        .unwrap();
    let m = &out["message"]["payload"]["mission"];
    assert_eq!(m["tasks"].as_array().unwrap().len(), 1);
    // events: created, task_created, task_updated, mission_updated
    assert_eq!(m["events"].as_array().unwrap().len(), 4);
}

#[tokio::test]
async fn inspect_unknown_mission_returns_error_payload() {
    let (d, _home) = dispatcher_with_temp_home();
    let out = d
        .dispatch_envelope(&session_envelope(json!({
            "type": "mission.inspect.request",
            "requestId": "x",
            "missionId": "mis_does_not_exist"
        })))
        .await
        .unwrap();
    let payload = &out["message"]["payload"];
    assert!(payload["mission"].is_null());
    assert!(payload["error"].is_string());
}
