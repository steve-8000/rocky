//! Live `/ws` handshake tests: bind the Phase 2 router on an ephemeral TCP port
//! and drive it with a real WebSocket client (`tokio-tungstenite`).

use std::collections::HashSet;
use std::sync::Arc;

use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::protocol::Message;

use crate::http::{build_router, ServerContext};

use futures_util::{SinkExt, StreamExt};

fn ctx(port: u16) -> ServerContext {
    ServerContext {
        server_id: "srv_live".into(),
        hostname: "livehost".into(),
        version: serde_json::Value::Null,
        listen: format!("127.0.0.1:{port}"),
        is_tcp: true,
        password: None,
        allowed_origins: HashSet::new(),
        hostnames: None,
        webui_dir: None,
        public_dir: std::path::PathBuf::from("/tmp"),
        session_dispatcher: None,
        agent_manager: None,
    }
}

async fn spawn_server() -> u16 {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let app = build_router(Arc::new(ctx(port)));
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    // Give the server a moment to start accepting.
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    port
}

/// Spawn a server whose `ServerContext` carries a real `SessionDispatcher` with
/// the mission handler group wired to a file-backed Mission Control service
/// rooted at a temp `$ROCKY_HOME`. Returns the bound port and the `TempDir`
/// guard (kept alive for the test's duration).
async fn spawn_server_with_session() -> (u16, tempfile::TempDir) {
    use rocky_mission_control::FileBackedMissionControlService;
    use rocky_ws_session::{handlers::mission, SessionDispatcher};
    use std::sync::Mutex;

    let home = tempfile::tempdir().unwrap();
    let mission_service = FileBackedMissionControlService::new(home.path());
    mission_service.initialize().unwrap();
    let mut dispatcher = SessionDispatcher::new();
    mission::register(&mut dispatcher, Arc::new(Mutex::new(mission_service)));

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let mut c = ctx(port);
    c.session_dispatcher = Some(Arc::new(dispatcher));
    let app = build_router(Arc::new(c));
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    (port, home)
}

#[tokio::test]
async fn session_dispatch_round_trips_mission_rpcs() {
    let (port, _home) = spawn_server_with_session().await;
    let url = format!("ws://127.0.0.1:{port}/ws");
    let (mut socket, _) = connect_async(url).await.unwrap();

    // Hello -> server_info.
    socket
        .send(Message::Text(
            serde_json::json!({
                "type": "hello",
                "clientId": "client-1",
                "clientType": "cli",
                "protocolVersion": 1
            })
            .to_string(),
        ))
        .await
        .unwrap();
    let reply = next_text(&mut socket).await;
    let value: serde_json::Value = serde_json::from_str(&reply).unwrap();
    assert_eq!(value["message"]["payload"]["status"], "server_info");

    // mission.create.request -> mission.create.response with a new mission id.
    socket
        .send(Message::Text(
            serde_json::json!({
                "type": "session",
                "message": {
                    "type": "mission.create.request",
                    "requestId": "r1",
                    "goal": "ws mount e2e"
                }
            })
            .to_string(),
        ))
        .await
        .unwrap();
    let reply = next_text(&mut socket).await;
    let value: serde_json::Value = serde_json::from_str(&reply).unwrap();
    assert_eq!(value["type"], "session");
    assert_eq!(value["message"]["type"], "mission.create.response");
    assert_eq!(value["message"]["payload"]["requestId"], "r1");
    assert_eq!(value["message"]["payload"]["error"], serde_json::Value::Null);
    let mission_id = value["message"]["payload"]["mission"]["id"]
        .as_str()
        .expect("mission id present")
        .to_string();
    assert!(mission_id.starts_with("mis_"), "mission id: {mission_id}");
    assert_eq!(value["message"]["payload"]["mission"]["goal"], "ws mount e2e");

    // mission.list.request -> returns the created mission.
    socket
        .send(Message::Text(
            serde_json::json!({
                "type": "session",
                "message": { "type": "mission.list.request", "requestId": "r2" }
            })
            .to_string(),
        ))
        .await
        .unwrap();
    let reply = next_text(&mut socket).await;
    let value: serde_json::Value = serde_json::from_str(&reply).unwrap();
    assert_eq!(value["message"]["type"], "mission.list.response");
    assert_eq!(value["message"]["payload"]["requestId"], "r2");
    let missions = value["message"]["payload"]["missions"]
        .as_array()
        .expect("missions array");
    assert_eq!(missions.len(), 1);
    assert_eq!(missions[0]["id"], mission_id);
}

#[tokio::test]
async fn hello_returns_server_info() {
    let port = spawn_server().await;
    let url = format!("ws://127.0.0.1:{port}/ws");
    let (mut socket, _) = connect_async(url).await.unwrap();

    socket
        .send(Message::Text(
            serde_json::json!({
                "type": "hello",
                "clientId": "client-1",
                "clientType": "cli",
                "protocolVersion": 1
            })
            .to_string(),
        ))
        .await
        .unwrap();

    let reply = next_text(&mut socket).await;
    let value: serde_json::Value = serde_json::from_str(&reply).unwrap();
    assert_eq!(value["type"], "session");
    assert_eq!(value["message"]["type"], "status");
    assert_eq!(value["message"]["payload"]["status"], "server_info");
    assert_eq!(value["message"]["payload"]["serverId"], "srv_live");
    assert_eq!(
        value["message"]["payload"]["features"]["rewind"],
        serde_json::Value::Bool(true)
    );
}

#[tokio::test]
async fn bad_protocol_version_closes_4003() {
    let port = spawn_server().await;
    let url = format!("ws://127.0.0.1:{port}/ws");
    let (mut socket, _) = connect_async(url).await.unwrap();

    socket
        .send(Message::Text(
            serde_json::json!({
                "type": "hello",
                "clientId": "client-1",
                "clientType": "cli",
                "protocolVersion": 99
            })
            .to_string(),
        ))
        .await
        .unwrap();

    let close = next_close(&mut socket).await;
    assert_eq!(close, Some(4003));
}

#[tokio::test]
async fn ping_returns_pong() {
    let port = spawn_server().await;
    let url = format!("ws://127.0.0.1:{port}/ws");
    let (mut socket, _) = connect_async(url).await.unwrap();

    socket
        .send(Message::Text(
            serde_json::json!({ "type": "ping" }).to_string(),
        ))
        .await
        .unwrap();

    let reply = next_text(&mut socket).await;
    let value: serde_json::Value = serde_json::from_str(&reply).unwrap();
    assert_eq!(value["type"], "pong");
}

#[tokio::test]
async fn wrong_password_closes_4401() {
    // Bind a server WITH a password and connect without a valid bearer protocol.
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let mut c = ctx(port);
    c.password = Some(crate::auth::hash_daemon_password("secret").unwrap());
    let app = build_router(Arc::new(c));
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;

    // Connect carrying a wrong bearer protocol token.
    let url = format!("ws://127.0.0.1:{port}/ws");
    let mut request = url.into_client_request().unwrap();
    request.headers_mut().insert(
        "Sec-WebSocket-Protocol",
        "rocky.bearer.wrongtoken".parse().unwrap(),
    );
    let (mut socket, _) = connect_async(request).await.unwrap();

    let close = next_close(&mut socket).await;
    assert_eq!(close, Some(4401));
}

async fn next_text(
    socket: &mut tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
) -> String {
    loop {
        match socket.next().await {
            Some(Ok(Message::Text(t))) => return t.to_string(),
            Some(Ok(_)) => continue,
            other => panic!("expected text frame, got {other:?}"),
        }
    }
}

async fn next_close(
    socket: &mut tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
) -> Option<u16> {
    loop {
        match socket.next().await {
            Some(Ok(Message::Close(Some(frame)))) => return Some(frame.code.into()),
            Some(Ok(Message::Close(None))) => return None,
            Some(Ok(_)) => continue,
            Some(Err(tokio_tungstenite::tungstenite::Error::Protocol(_))) => return None,
            None => return None,
            other => panic!("expected close frame, got {other:?}"),
        }
    }
}
