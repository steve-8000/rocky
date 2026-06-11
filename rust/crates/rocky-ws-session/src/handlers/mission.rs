//! Mission Control session RPC handlers, matching the `mission.*` cases in
//! `session.ts` (`handleMissionCreateRequest` etc., lines ~2143-2154 and
//! ~8888-9034) and the response shapes in
//! `core/packages/protocol/src/mission/rpc-schemas.ts`.
//!
//! Inner request/response `type` strings and payload shapes are wire-compatible
//! with the TypeScript daemon. Each response payload carries the `requestId`,
//! the result (`mission`/`missions`/`task`), and a nullable `error`.

use std::sync::{Arc, Mutex};

use rocky_mission_control::{
    CreateMissionInput, CreateMissionTaskInput, FileBackedMissionControlService, MissionStatus,
    MissionTaskIsolation, MissionTaskStatus, UpdateMissionInput, UpdateMissionTaskInput,
};
use serde_json::{json, Value};

use crate::dispatch::{SessionDispatcher, SessionRpcError};

/// Shared, mutex-guarded Mission Control service. The file-backed service is
/// synchronous; the mutex serializes mutations (matching the single-writer
/// behavior of the TS service).
pub type SharedMissionService = Arc<Mutex<FileBackedMissionControlService>>;

/// Register all `mission.*` handlers onto the dispatcher.
pub fn register(dispatcher: &mut SessionDispatcher, service: SharedMissionService) {
    let s = service.clone();
    dispatcher.register(
        "mission.create.request",
        Arc::new(move |msg: Value| {
            let s = s.clone();
            async move { handle_create(&s, msg) }
        }),
    );

    let s = service.clone();
    dispatcher.register(
        "mission.list.request",
        Arc::new(move |msg: Value| {
            let s = s.clone();
            async move { handle_list(&s, msg) }
        }),
    );

    let s = service.clone();
    dispatcher.register(
        "mission.inspect.request",
        Arc::new(move |msg: Value| {
            let s = s.clone();
            async move { handle_inspect(&s, msg) }
        }),
    );

    let s = service.clone();
    dispatcher.register(
        "mission.update.request",
        Arc::new(move |msg: Value| {
            let s = s.clone();
            async move { handle_update(&s, msg) }
        }),
    );

    let s = service.clone();
    dispatcher.register(
        "mission.task.create.request",
        Arc::new(move |msg: Value| {
            let s = s.clone();
            async move { handle_task_create(&s, msg) }
        }),
    );

    let s = service;
    dispatcher.register(
        "mission.task.update.request",
        Arc::new(move |msg: Value| {
            let s = s.clone();
            async move { handle_task_update(&s, msg) }
        }),
    );
}

fn request_id(msg: &Value) -> String {
    msg.get("requestId")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

fn opt_str(msg: &Value, key: &str) -> Option<String> {
    msg.get(key).and_then(Value::as_str).map(|s| s.to_string())
}

/// Outer Option = field present? Inner Option = null vs value (nullable patch).
fn opt_nullable(msg: &Value, key: &str) -> Option<Option<String>> {
    match msg.get(key) {
        None => None,
        Some(Value::Null) => Some(None),
        Some(Value::String(s)) => Some(Some(s.clone())),
        Some(_) => None,
    }
}

fn parse_mission_status(msg: &Value) -> Option<MissionStatus> {
    msg.get("status")
        .and_then(Value::as_str)
        .and_then(|s| serde_json::from_value(Value::String(s.to_string())).ok())
}

fn parse_task_status(msg: &Value) -> Option<MissionTaskStatus> {
    msg.get("status")
        .and_then(Value::as_str)
        .and_then(|s| serde_json::from_value(Value::String(s.to_string())).ok())
}

fn parse_isolation(msg: &Value) -> Option<MissionTaskIsolation> {
    msg.get("isolation")
        .and_then(Value::as_str)
        .and_then(|s| serde_json::from_value(Value::String(s.to_string())).ok())
}

fn create_response(req_id: &str, mission: Result<Value, String>) -> Value {
    match mission {
        Ok(m) => json!({ "type": "mission.create.response", "payload": {
            "requestId": req_id, "mission": m, "error": Value::Null } }),
        Err(e) => json!({ "type": "mission.create.response", "payload": {
            "requestId": req_id, "mission": Value::Null, "error": e } }),
    }
}

fn handle_create(service: &SharedMissionService, msg: Value) -> Result<Value, SessionRpcError> {
    let req_id = request_id(&msg);
    let goal = opt_str(&msg, "goal").unwrap_or_default();
    let input = CreateMissionInput {
        goal,
        status: parse_mission_status(&msg),
        project_id: opt_str(&msg, "projectId"),
        workspace_id: opt_str(&msg, "workspaceId"),
        leader_agent_id: opt_str(&msg, "leaderAgentId"),
        chat_room_id: opt_str(&msg, "chatRoomId"),
        board_path: opt_str(&msg, "boardPath"),
    };
    let svc = service.lock().map_err(poisoned)?;
    let result = svc
        .create_mission(input)
        .map_err(|e| e.to_string())
        .and_then(|m| serde_json::to_value(m).map_err(|e| e.to_string()));
    Ok(create_response(&req_id, result))
}

fn handle_list(service: &SharedMissionService, msg: Value) -> Result<Value, SessionRpcError> {
    let req_id = request_id(&msg);
    let include_archived = msg
        .get("includeArchived")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let svc = service.lock().map_err(poisoned)?;
    match svc.list_missions(include_archived) {
        Ok(missions) => {
            let arr = serde_json::to_value(missions).map_err(internal)?;
            Ok(json!({ "type": "mission.list.response", "payload": {
                "requestId": req_id, "missions": arr, "error": Value::Null } }))
        }
        Err(e) => Ok(json!({ "type": "mission.list.response", "payload": {
            "requestId": req_id, "missions": [], "error": e.to_string() } })),
    }
}

fn handle_inspect(service: &SharedMissionService, msg: Value) -> Result<Value, SessionRpcError> {
    let req_id = request_id(&msg);
    let mission_id = opt_str(&msg, "missionId").unwrap_or_default();
    let svc = service.lock().map_err(poisoned)?;
    match svc.inspect_mission(&mission_id) {
        Ok(m) => {
            let v = serde_json::to_value(m).map_err(internal)?;
            Ok(json!({ "type": "mission.inspect.response", "payload": {
                "requestId": req_id, "mission": v, "error": Value::Null } }))
        }
        Err(e) => Ok(json!({ "type": "mission.inspect.response", "payload": {
            "requestId": req_id, "mission": Value::Null, "error": e.to_string() } })),
    }
}

fn handle_update(service: &SharedMissionService, msg: Value) -> Result<Value, SessionRpcError> {
    let req_id = request_id(&msg);
    let input = UpdateMissionInput {
        mission_id: opt_str(&msg, "missionId").unwrap_or_default(),
        goal: opt_str(&msg, "goal"),
        status: parse_mission_status(&msg),
        leader_agent_id: opt_nullable(&msg, "leaderAgentId"),
        chat_room_id: opt_nullable(&msg, "chatRoomId"),
        board_path: opt_nullable(&msg, "boardPath"),
    };
    let svc = service.lock().map_err(poisoned)?;
    match svc.update_mission(input) {
        Ok(m) => {
            let v = serde_json::to_value(m).map_err(internal)?;
            Ok(json!({ "type": "mission.update.response", "payload": {
                "requestId": req_id, "mission": v, "error": Value::Null } }))
        }
        Err(e) => Ok(json!({ "type": "mission.update.response", "payload": {
            "requestId": req_id, "mission": Value::Null, "error": e.to_string() } })),
    }
}

fn handle_task_create(
    service: &SharedMissionService,
    msg: Value,
) -> Result<Value, SessionRpcError> {
    let req_id = request_id(&msg);
    let acceptance = msg.get("acceptanceCriteria").and_then(Value::as_array).map(|a| {
        a.iter()
            .filter_map(|v| v.as_str().map(|s| s.to_string()))
            .collect::<Vec<_>>()
    });
    let input = CreateMissionTaskInput {
        mission_id: opt_str(&msg, "missionId").unwrap_or_default(),
        title: opt_str(&msg, "title").unwrap_or_default(),
        description: opt_str(&msg, "description"),
        acceptance_criteria: acceptance,
        status: parse_task_status(&msg),
        owner_agent_id: opt_str(&msg, "ownerAgentId"),
        roster_agent_id: opt_str(&msg, "rosterAgentId"),
        worktree_path: opt_str(&msg, "worktreePath"),
        isolation: parse_isolation(&msg),
    };
    let svc = service.lock().map_err(poisoned)?;
    match svc.create_task(input) {
        Ok((mission, task)) => {
            let m = serde_json::to_value(mission).map_err(internal)?;
            let t = serde_json::to_value(task).map_err(internal)?;
            Ok(json!({ "type": "mission.task.create.response", "payload": {
                "requestId": req_id, "mission": m, "task": t, "error": Value::Null } }))
        }
        Err(e) => Ok(json!({ "type": "mission.task.create.response", "payload": {
            "requestId": req_id, "mission": Value::Null, "task": Value::Null, "error": e.to_string() } })),
    }
}

fn handle_task_update(
    service: &SharedMissionService,
    msg: Value,
) -> Result<Value, SessionRpcError> {
    let req_id = request_id(&msg);
    let acceptance = msg.get("acceptanceCriteria").and_then(Value::as_array).map(|a| {
        a.iter()
            .filter_map(|v| v.as_str().map(|s| s.to_string()))
            .collect::<Vec<_>>()
    });
    let verification = msg
        .get("verification")
        .and_then(|v| serde_json::from_value(v.clone()).ok());
    let input = UpdateMissionTaskInput {
        mission_id: opt_str(&msg, "missionId").unwrap_or_default(),
        task_id: opt_str(&msg, "taskId").unwrap_or_default(),
        title: opt_str(&msg, "title"),
        description: opt_nullable(&msg, "description"),
        acceptance_criteria: acceptance,
        status: parse_task_status(&msg),
        owner_agent_id: opt_nullable(&msg, "ownerAgentId"),
        roster_agent_id: opt_nullable(&msg, "rosterAgentId"),
        worktree_path: opt_nullable(&msg, "worktreePath"),
        isolation: parse_isolation(&msg),
        result: opt_nullable(&msg, "result"),
        verification,
    };
    let svc = service.lock().map_err(poisoned)?;
    match svc.update_task(input) {
        Ok((mission, task)) => {
            let m = serde_json::to_value(mission).map_err(internal)?;
            let t = serde_json::to_value(task).map_err(internal)?;
            Ok(json!({ "type": "mission.task.update.response", "payload": {
                "requestId": req_id, "mission": m, "task": t, "error": Value::Null } }))
        }
        Err(e) => Ok(json!({ "type": "mission.task.update.response", "payload": {
            "requestId": req_id, "mission": Value::Null, "task": Value::Null, "error": e.to_string() } })),
    }
}

fn poisoned<T>(_: std::sync::PoisonError<T>) -> SessionRpcError {
    SessionRpcError::Handler("mission service lock poisoned".to_string())
}

fn internal(e: serde_json::Error) -> SessionRpcError {
    SessionRpcError::Handler(format!("serialize: {e}"))
}
