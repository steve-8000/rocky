//! End-to-end session-dispatch tests for the chat/schedule/loop handlers.
//!
//! Each test drives the handlers through the public `dispatch_envelope` path
//! (session-wrapped inner message in, session-wrapped response out), asserting
//! the exact response `type` strings, `requestId` echo, and that mutations land
//! on disk under a temporary `$ROCKY_HOME`.

use std::sync::{Arc, Mutex};

use rocky_scheduling::{LoopService, ScheduleService, ScheduleStore};
use rocky_ws_session::handlers::chat_schedule_loop::{register, ChatFileStore, ChatScheduleLoopContext};
use rocky_ws_session::SessionDispatcher;
use serde_json::{json, Value};
use tempfile::TempDir;

fn build_dispatcher(home: &std::path::Path) -> SessionDispatcher {
    let chat = ChatFileStore::new(home);
    let schedule = ScheduleService::new(ScheduleStore::new(home.join("schedules")));
    let loops = LoopService::new(home);
    let ctx = ChatScheduleLoopContext {
        chat,
        schedule: Arc::new(Mutex::new(schedule)),
        loops: Arc::new(Mutex::new(loops)),
    };
    let mut dispatcher = SessionDispatcher::new();
    register(&mut dispatcher, ctx);
    dispatcher
}

async fn dispatch(dispatcher: &SessionDispatcher, message: Value) -> Value {
    let envelope = json!({ "type": "session", "message": message });
    let out = dispatcher.dispatch_envelope(&envelope).await.unwrap();
    assert_eq!(out["type"], "session");
    out["message"].clone()
}

fn is_8_hex(value: &str) -> bool {
    value.len() == 8 && value.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
}

#[tokio::test]
async fn chat_create_list_post_read_round_trip() {
    let home = TempDir::new().unwrap();
    let d = build_dispatcher(home.path());

    // create
    let res = dispatch(
        &d,
        json!({ "type": "chat/create", "requestId": "c1", "name": "General", "purpose": "team" }),
    )
    .await;
    assert_eq!(res["type"], "chat/create/response");
    assert_eq!(res["payload"]["requestId"], "c1");
    assert!(res["payload"]["error"].is_null());
    let room = &res["payload"]["room"];
    assert_eq!(room["name"], "General");
    assert_eq!(room["purpose"], "team");
    assert_eq!(room["messageCount"], 0);
    assert!(room["lastMessageAt"].is_null());
    let room_id = room["id"].as_str().unwrap().to_string();

    // rooms.json persisted with {rooms,messages} shape
    let raw = std::fs::read_to_string(home.path().join("chat").join("rooms.json")).unwrap();
    let store: Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(store["rooms"].as_array().unwrap().len(), 1);
    assert_eq!(store["messages"].as_array().unwrap().len(), 0);
    assert_eq!(store["rooms"][0]["id"], room_id);

    // list
    let res = dispatch(&d, json!({ "type": "chat/list", "requestId": "c2" })).await;
    assert_eq!(res["type"], "chat/list/response");
    assert_eq!(res["payload"]["requestId"], "c2");
    let rooms = res["payload"]["rooms"].as_array().unwrap();
    assert_eq!(rooms.len(), 1);
    assert_eq!(rooms[0]["id"], room_id);

    // post (resolve room by name, author + mention)
    let res = dispatch(
        &d,
        json!({
            "type": "chat/post",
            "requestId": "c3",
            "room": "general",
            "body": "hello @bob",
            "authorAgentId": "alice",
        }),
    )
    .await;
    assert_eq!(res["type"], "chat/post/response");
    assert_eq!(res["payload"]["requestId"], "c3");
    assert!(res["payload"]["error"].is_null());
    let message = &res["payload"]["message"];
    assert_eq!(message["roomId"], room_id);
    assert_eq!(message["authorAgentId"], "alice");
    assert_eq!(message["body"], "hello @bob");
    assert_eq!(message["mentionAgentIds"], json!(["bob"]));
    assert!(message["replyToMessageId"].is_null());
    let message_id = message["id"].as_str().unwrap().to_string();

    // message persisted
    let raw = std::fs::read_to_string(home.path().join("chat").join("rooms.json")).unwrap();
    let store: Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(store["messages"].as_array().unwrap().len(), 1);
    assert_eq!(store["messages"][0]["id"], message_id);
    assert_eq!(store["messages"][0]["roomId"], room_id);

    // read
    let res = dispatch(
        &d,
        json!({ "type": "chat/read", "requestId": "c4", "room": room_id }),
    )
    .await;
    assert_eq!(res["type"], "chat/read/response");
    assert_eq!(res["payload"]["requestId"], "c4");
    let messages = res["payload"]["messages"].as_array().unwrap();
    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0]["id"], message_id);
    assert_eq!(messages[0]["body"], "hello @bob");

    // inspect reflects messageCount + lastMessageAt
    let res = dispatch(
        &d,
        json!({ "type": "chat/inspect", "requestId": "c5", "room": room_id }),
    )
    .await;
    assert_eq!(res["type"], "chat/inspect/response");
    assert_eq!(res["payload"]["room"]["messageCount"], 1);
    assert!(!res["payload"]["room"]["lastMessageAt"].is_null());
}

#[tokio::test]
async fn schedule_create_list_inspect_pause_resume_delete_round_trip() {
    let home = TempDir::new().unwrap();
    std::fs::create_dir_all(home.path().join("schedules")).unwrap();
    let d = build_dispatcher(home.path());

    // create (every cadence -> active, runOnCreate default true)
    let res = dispatch(
        &d,
        json!({
            "type": "schedule/create",
            "requestId": "s1",
            "prompt": "do the thing",
            "name": "nightly",
            "cadence": { "type": "every", "everyMs": 3_600_000 },
            "target": { "type": "agent", "agentId": "11111111-1111-4111-8111-111111111111" },
        }),
    )
    .await;
    assert_eq!(res["type"], "schedule/create/response");
    assert_eq!(res["payload"]["requestId"], "s1");
    assert!(res["payload"]["error"].is_null());
    let schedule = &res["payload"]["schedule"];
    // ScheduleSummary omits `runs`.
    assert!(schedule.get("runs").is_none());
    assert_eq!(schedule["status"], "active");
    let id = schedule["id"].as_str().unwrap().to_string();
    assert!(is_8_hex(&id), "schedule id not 8-hex: {id}");

    // list
    let res = dispatch(&d, json!({ "type": "schedule/list", "requestId": "s2" })).await;
    assert_eq!(res["type"], "schedule/list/response");
    let schedules = res["payload"]["schedules"].as_array().unwrap();
    assert_eq!(schedules.len(), 1);
    assert_eq!(schedules[0]["id"], id);
    assert!(schedules[0].get("runs").is_none());

    // inspect (full record, includes runs)
    let res = dispatch(
        &d,
        json!({ "type": "schedule/inspect", "requestId": "s3", "scheduleId": id }),
    )
    .await;
    assert_eq!(res["type"], "schedule/inspect/response");
    assert_eq!(res["payload"]["schedule"]["id"], id);
    assert!(res["payload"]["schedule"]["runs"].is_array());

    // pause -> paused
    let res = dispatch(
        &d,
        json!({ "type": "schedule/pause", "requestId": "s4", "scheduleId": id }),
    )
    .await;
    assert_eq!(res["type"], "schedule/pause/response");
    assert_eq!(res["payload"]["schedule"]["status"], "paused");
    assert!(res["payload"]["schedule"]["nextRunAt"].is_null());

    // resume -> active
    let res = dispatch(
        &d,
        json!({ "type": "schedule/resume", "requestId": "s5", "scheduleId": id }),
    )
    .await;
    assert_eq!(res["type"], "schedule/resume/response");
    assert_eq!(res["payload"]["schedule"]["status"], "active");
    assert!(!res["payload"]["schedule"]["nextRunAt"].is_null());

    // delete
    let res = dispatch(
        &d,
        json!({ "type": "schedule/delete", "requestId": "s6", "scheduleId": id }),
    )
    .await;
    assert_eq!(res["type"], "schedule/delete/response");
    assert_eq!(res["payload"]["scheduleId"], id);
    assert!(res["payload"]["error"].is_null());

    // gone
    let res = dispatch(&d, json!({ "type": "schedule/list", "requestId": "s7" })).await;
    assert_eq!(res["payload"]["schedules"].as_array().unwrap().len(), 0);
}

#[tokio::test]
async fn loop_run_list_inspect_stop_round_trip() {
    let home = TempDir::new().unwrap();
    let d = build_dispatcher(home.path());

    // run (create record only; no executor)
    let res = dispatch(
        &d,
        json!({
            "type": "loop/run",
            "requestId": "l1",
            "prompt": "iterate",
            "cwd": "/tmp/work",
            "verifyPrompt": "is it done?",
        }),
    )
    .await;
    assert_eq!(res["type"], "loop/run/response");
    assert_eq!(res["payload"]["requestId"], "l1");
    assert!(res["payload"]["error"].is_null());
    let loop_record = &res["payload"]["loop"];
    assert_eq!(loop_record["status"], "running");
    assert_eq!(loop_record["prompt"], "iterate");
    assert_eq!(loop_record["provider"], "claude");
    let id = loop_record["id"].as_str().unwrap().to_string();
    assert!(is_8_hex(&id), "loop id not 8-hex: {id}");
    // "Loop created" log appended at seq 1.
    assert_eq!(loop_record["logs"].as_array().unwrap().len(), 1);
    assert_eq!(loop_record["logs"][0]["seq"], 1);

    // persisted as a bare JSON array
    let raw = std::fs::read_to_string(home.path().join("loops").join("loops.json")).unwrap();
    let stored: Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(stored.as_array().unwrap().len(), 1);
    assert_eq!(stored[0]["id"], id);

    // list
    let res = dispatch(&d, json!({ "type": "loop/list", "requestId": "l2" })).await;
    assert_eq!(res["type"], "loop/list/response");
    let loops = res["payload"]["loops"].as_array().unwrap();
    assert_eq!(loops.len(), 1);
    assert_eq!(loops[0]["id"], id);
    assert_eq!(loops[0]["status"], "running");

    // inspect
    let res = dispatch(
        &d,
        json!({ "type": "loop/inspect", "requestId": "l3", "id": id }),
    )
    .await;
    assert_eq!(res["type"], "loop/inspect/response");
    assert_eq!(res["payload"]["loop"]["id"], id);

    // logs
    let res = dispatch(
        &d,
        json!({ "type": "loop/logs", "requestId": "l4", "id": id }),
    )
    .await;
    assert_eq!(res["type"], "loop/logs/response");
    assert_eq!(res["payload"]["entries"].as_array().unwrap().len(), 1);
    assert_eq!(res["payload"]["nextCursor"], 1);

    // stop (running with no live worker -> stopped)
    let res = dispatch(
        &d,
        json!({ "type": "loop/stop", "requestId": "l5", "id": id }),
    )
    .await;
    assert_eq!(res["type"], "loop/stop/response");
    assert_eq!(res["payload"]["loop"]["status"], "stopped");
    assert!(!res["payload"]["loop"]["completedAt"].is_null());
}
