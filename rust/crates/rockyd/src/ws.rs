//! `/ws` WebSocket handshake, ported from
//! `core/packages/server/src/server/websocket-server.ts`.
//!
//! Flow (matching the TS server):
//! - origin check before upgrade (403 when disallowed),
//! - upgrade-time password auth via `Sec-WebSocket-Protocol` (close 4401),
//! - client sends `hello`; protocol mismatch closes 4003, empty clientId
//!   closes 4002, missing hello within 15s closes 4001,
//! - valid hello -> wrapped session `status` message with `server_info`,
//! - JSON `{type:'ping'}` -> `{type:'pong'}`.

use std::sync::Arc;
use std::time::Duration;

use axum::extract::ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use serde_json::json;
use tracing::warn;

use crate::auth::{extract_ws_bearer_protocol, extract_ws_bearer_token, is_bearer_token_valid};
use crate::http::ServerContext;

/// Protocol version, matching `WS_PROTOCOL_VERSION` in `websocket-server.ts`.
pub const WS_PROTOCOL_VERSION: i64 = 1;

/// Hello timeout, matching `HELLO_TIMEOUT_MS`.
pub const HELLO_TIMEOUT: Duration = Duration::from_millis(15_000);

/// Close codes, matching `websocket-server.ts`.
pub const WS_CLOSE_HELLO_TIMEOUT: u16 = 4001;
pub const WS_CLOSE_INVALID_HELLO: u16 = 4002;
pub const WS_CLOSE_INCOMPATIBLE_PROTOCOL: u16 = 4003;
pub const WS_CLOSE_DAEMON_AUTH_FAILED: u16 = 4401;

/// Client `hello` message, matching `WSHelloMessageSchema`. Unknown fields
/// (`appVersion`, `capabilities`, ...) are ignored for Phase 2.
#[derive(Debug, Deserialize)]
pub struct HelloMessage {
    #[serde(rename = "clientId", default)]
    pub client_id: String,
    #[serde(rename = "protocolVersion", default)]
    pub protocol_version: i64,
}

/// Outcome of evaluating a client `hello`, matching `handleHello`.
#[derive(Debug, PartialEq, Eq)]
pub enum HelloDecision {
    /// Valid hello — reply with the wrapped `server_info` status message.
    Reply,
    /// Reject — close the socket with this code and reason.
    Close(u16, &'static str),
}

/// Pure hello-decision, matching `handleHello` (`websocket-server.ts:973-1000`):
/// protocol mismatch -> 4003, empty clientId -> 4002, else accept.
pub fn decide_hello(message: &HelloMessage) -> HelloDecision {
    if message.protocol_version != WS_PROTOCOL_VERSION {
        return HelloDecision::Close(
            WS_CLOSE_INCOMPATIBLE_PROTOCOL,
            "Incompatible protocol version",
        );
    }
    if message.client_id.trim().is_empty() {
        return HelloDecision::Close(WS_CLOSE_INVALID_HELLO, "Invalid hello");
    }
    HelloDecision::Reply
}

/// Build the `server_info` status payload, matching
/// `buildServerInfoStatusPayload` (`websocket-server.ts:1059-1081`).
pub fn build_server_info(ctx: &ServerContext) -> serde_json::Value {
    json!({
        "status": "server_info",
        "serverId": ctx.server_id,
        "hostname": ctx.hostname,
        "version": ctx.version,
        "features": {
            "providersSnapshot": true,
            "checkoutGithubSetAutoMerge": true,
            "daemonStatusRpc": true,
            "terminal-restore-modes": true,
            "rewind": true,
            "checkoutRefresh": true,
        },
    })
}

/// Wrapped session `status` message, matching `createServerInfoMessage`
/// (`websocket-server.ts:1083-1091`): `{type:'session', message:{type:'status',
/// payload: <server_info>}}`.
fn server_info_message(ctx: &ServerContext) -> serde_json::Value {
    json!({
        "type": "session",
        "message": {
            "type": "status",
            "payload": build_server_info(ctx),
        },
    })
}

/// Whether a WS connection is allowed by origin, matching `verifyWsUpgrade`
/// origin logic (`websocket-server.ts:601-612`): allowed if no origin, set has
/// '*', set has origin, or same-origin (`http(s)://<host header>`).
fn is_ws_origin_allowed(ctx: &ServerContext, origin: Option<&str>, host: Option<&str>) -> bool {
    let Some(origin) = origin else {
        return true;
    };
    if ctx.allowed_origins.contains("*") || ctx.allowed_origins.contains(origin) {
        return true;
    }
    if let Some(host) = host {
        if origin == format!("http://{host}") || origin == format!("https://{host}") {
            return true;
        }
    }
    false
}

/// axum `/ws` upgrade handler.
pub async fn ws_handler(
    State(ctx): State<Arc<ServerContext>>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Response {
    let header_str = |name: &str| -> Option<String> {
        headers
            .get(name)
            .and_then(|v| v.to_str().ok())
            .map(|s| s.to_string())
    };
    let origin = header_str("origin");
    let host = header_str("host");

    if !is_ws_origin_allowed(&ctx, origin.as_deref(), host.as_deref()) {
        warn!(origin = ?origin, "Rejected WebSocket connection from origin");
        return (StatusCode::FORBIDDEN, "Origin not allowed").into_response();
    }

    let protocol_header = header_str("sec-websocket-protocol");
    // Echo the client's offered subprotocols so the handshake completes; the
    // `ws` library (Node) negotiates the offered subprotocol, and clients send
    // `rocky.bearer.<token>` as a subprotocol. axum selects the first offered
    // protocol that we list here.
    let offered: Vec<String> = protocol_header
        .as_deref()
        .map(|h| h.split(',').map(|s| s.trim().to_string()).collect())
        .unwrap_or_default();
    let ws = ws.protocols(offered);
    ws.on_upgrade(move |socket| handle_socket(socket, ctx, protocol_header))
}

async fn handle_socket(mut socket: WebSocket, ctx: Arc<ServerContext>, protocol_header: Option<String>) {
    // Upgrade-time password auth (`attachAuthenticatedSocket`,
    // `websocket-server.ts:615-637`).
    if let Some(password) = ctx.password.as_deref() {
        let protocol = extract_ws_bearer_protocol(protocol_header.as_deref());
        let token = extract_ws_bearer_token(protocol.as_deref());
        if !is_bearer_token_valid(Some(password), token.as_deref()) {
            let reason = if token.is_none() {
                "Password required"
            } else {
                "Incorrect password"
            };
            close(&mut socket, WS_CLOSE_DAEMON_AUTH_FAILED, reason).await;
            return;
        }
    }

    // Hello handshake with a 15s timeout.
    loop {
        let next = tokio::time::timeout(HELLO_TIMEOUT, socket.recv()).await;
        let msg = match next {
            Err(_) => {
                close(&mut socket, WS_CLOSE_HELLO_TIMEOUT, "Hello timeout").await;
                return;
            }
            Ok(None) => return, // client disconnected
            Ok(Some(Err(_))) => return,
            Ok(Some(Ok(msg))) => msg,
        };

        let text = match msg {
            Message::Text(t) => t.to_string(),
            Message::Binary(_) => continue, // ignore pre-hello binary frames
            Message::Ping(_) | Message::Pong(_) => continue,
            Message::Close(_) => return,
        };

        let value: serde_json::Value = match serde_json::from_str(&text) {
            Ok(v) => v,
            Err(_) => {
                close(&mut socket, WS_CLOSE_INVALID_HELLO, "Invalid hello").await;
                return;
            }
        };

        match value.get("type").and_then(|t| t.as_str()) {
            Some("ping") => {
                let _ = socket
                    .send(Message::Text(json!({"type":"pong"}).to_string().into()))
                    .await;
                continue;
            }
            Some("hello") => {
                let hello: HelloMessage = match serde_json::from_value(value) {
                    Ok(h) => h,
                    Err(_) => {
                        close(&mut socket, WS_CLOSE_INVALID_HELLO, "Invalid hello").await;
                        return;
                    }
                };
                match decide_hello(&hello) {
                    HelloDecision::Close(code, reason) => {
                        close(&mut socket, code, reason).await;
                        return;
                    }
                    HelloDecision::Reply => {
                        let _ = socket
                            .send(Message::Text(server_info_message(&ctx).to_string().into()))
                            .await;
                        // Hand off to the session loop: ping/pong plus session
                        // RPC dispatch via the wired dispatcher.
                        session_loop(&mut socket, &ctx).await;
                        return;
                    }
                }
            }
            _ => {
                close(&mut socket, WS_CLOSE_INVALID_HELLO, "Session message before hello").await;
                return;
            }
        }
    }
}

/// After a successful hello, run the session loop. Answers `{type:"ping"}` with
/// `{type:"pong"}` and dispatches `{type:"session", message:{...}}` envelopes
/// through the wired [`SessionDispatcher`], sending the wrapped response back.
/// Unlike the hello handshake, this loop has no timeout. Mirrors the inbound
/// handling in `session.ts` / `websocket-server.ts`.
async fn session_loop(socket: &mut WebSocket, ctx: &Arc<ServerContext>) {
    // Subscribe to the agent broadcast (if wired) so live `agent_stream`
    // events are pushed to this client, matching the TS daemon's per-session
    // stream fan-out. We `tokio::select!` between client input and broadcasts.
    let mut stream_rx = ctx.agent_manager.as_ref().map(|m| m.subscribe());
    loop {
        tokio::select! {
            incoming = socket.recv() => {
                let Some(Ok(msg)) = incoming else { return };
                match msg {
                    Message::Text(t) => {
                        if !handle_session_text(socket, ctx, &t).await {
                            // (no-op; errors are handled inline)
                        }
                    }
                    Message::Close(_) => return,
                    _ => {}
                }
            }
            broadcast = recv_stream(stream_rx.as_mut()) => {
                if let Some(envelope) = broadcast {
                    let _ = socket
                        .send(Message::Text(envelope.to_string().into()))
                        .await;
                }
            }
        }
    }
}

/// Await the next broadcast event mapped to an `agent_stream` session envelope.
/// When there is no subscription, never resolves (so `select!` ignores it).
async fn recv_stream(
    rx: Option<&mut tokio::sync::broadcast::Receiver<rocky_agents::AgentStreamBroadcast>>,
) -> Option<serde_json::Value> {
    match rx {
        None => std::future::pending().await,
        Some(rx) => loop {
            match rx.recv().await {
                Ok(b) => {
                    if let Some(env) = agent_stream_envelope(&b) {
                        return Some(env);
                    }
                    // Unserializable event: skip, keep waiting.
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                    return std::future::pending().await
                }
            }
        },
    }
}

/// Map an `AgentStreamBroadcast` to the WebUI `agent_stream` session message
/// (`messages.ts:2476-2486`): `{type:"session", message:{type:"agent_stream",
/// payload:{agentId, event, timestamp, seq?, epoch?}}}`.
fn agent_stream_envelope(b: &rocky_agents::AgentStreamBroadcast) -> Option<serde_json::Value> {
    let event = serde_json::to_value(&b.event).ok()?;
    let mut payload = json!({
        "agentId": b.agent_id,
        "event": event,
        "timestamp": b.timestamp.clone().unwrap_or_else(crate::lifecycle::now_iso8601),
    });
    if let Some(seq) = b.seq {
        payload["seq"] = json!(seq);
    }
    if let Some(epoch) = b.epoch.as_ref() {
        payload["epoch"] = json!(epoch);
    }
    Some(json!({
        "type": "session",
        "message": { "type": "agent_stream", "payload": payload }
    }))
}

/// Handle one inbound text frame in the session loop. Returns `true` if handled.
async fn handle_session_text(socket: &mut WebSocket, ctx: &Arc<ServerContext>, t: &str) -> bool {
    let value: serde_json::Value = match serde_json::from_str(t) {
        Ok(v) => v,
        Err(_) => return false,
    };
    match value.get("type").and_then(|x| x.as_str()) {
        Some("ping") => {
            let _ = socket
                .send(Message::Text(json!({"type":"pong"}).to_string().into()))
                .await;
        }
        Some("session") => {
            if let Some(dispatcher) = ctx.session_dispatcher.as_ref() {
                match dispatcher.dispatch_envelope(&value).await {
                    Ok(response) => {
                        let _ = socket
                            .send(Message::Text(response.to_string().into()))
                            .await;
                    }
                    Err(err) => {
                        // Unknown/failed inner type: reply with a session-wrapped
                        // `rpc_error` so the client is not left hanging
                        // (session.ts:1674-1690).
                        if let Some(reply) = session_error_reply(&value, &err) {
                            let _ = socket
                                .send(Message::Text(reply.to_string().into()))
                                .await;
                        } else {
                            warn!(error = %err, "session dispatch failed");
                        }
                    }
                }
            } else {
                warn!("session message received but no dispatcher wired");
            }
        }
        _ => {}
    }
    true
}

/// Build a session-wrapped `rpc_error` for a failed dispatch, carrying the inner
/// request's `requestId`/`type` when present (matching the `rpc_error` payload
/// shape in `messages.ts:2191-2199`). Returns `None` when the inner request is
/// malformed enough that no useful error can be addressed back.
fn session_error_reply(
    envelope: &serde_json::Value,
    err: &rocky_ws_session::SessionRpcError,
) -> Option<serde_json::Value> {
    let inner = envelope.get("message")?;
    let request_id = inner.get("requestId").and_then(|v| v.as_str())?;
    let request_type = inner.get("type").and_then(|v| v.as_str());
    let mut payload = json!({
        "requestId": request_id,
        "error": err.to_string(),
    });
    if let Some(rt) = request_type {
        payload["requestType"] = json!(rt);
    }
    Some(json!({
        "type": "session",
        "message": { "type": "rpc_error", "payload": payload },
    }))
}

async fn close(socket: &mut WebSocket, code: u16, reason: &str) {
    let _ = socket
        .send(Message::Close(Some(CloseFrame {
            code,
            reason: reason.to_string().into(),
        })))
        .await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    fn ctx() -> ServerContext {
        ServerContext {
            server_id: "srv_test".into(),
            hostname: "host".into(),
            version: serde_json::Value::Null,
            listen: "127.0.0.1:7767".into(),
            is_tcp: true,
            password: None,
            allowed_origins: HashSet::new(),
            hostnames: None,
            webui_dir: None,
            public_dir: std::path::PathBuf::from("/tmp/public"),
            session_dispatcher: None,
            agent_manager: None,
            internal_mcp_token: None,
        }
    }

    #[test]
    fn hello_accepts_valid() {
        let m = HelloMessage {
            client_id: "abc".into(),
            protocol_version: 1,
        };
        assert_eq!(decide_hello(&m), HelloDecision::Reply);
    }

    #[test]
    fn hello_rejects_bad_protocol() {
        let m = HelloMessage {
            client_id: "abc".into(),
            protocol_version: 2,
        };
        assert_eq!(
            decide_hello(&m),
            HelloDecision::Close(WS_CLOSE_INCOMPATIBLE_PROTOCOL, "Incompatible protocol version")
        );
    }

    #[test]
    fn hello_rejects_empty_client_id() {
        let m = HelloMessage {
            client_id: "   ".into(),
            protocol_version: 1,
        };
        assert_eq!(
            decide_hello(&m),
            HelloDecision::Close(WS_CLOSE_INVALID_HELLO, "Invalid hello")
        );
    }

    #[test]
    fn server_info_has_all_features_true() {
        let info = build_server_info(&ctx());
        assert_eq!(info["status"], "server_info");
        assert_eq!(info["serverId"], "srv_test");
        let features = &info["features"];
        for key in [
            "providersSnapshot",
            "checkoutGithubSetAutoMerge",
            "daemonStatusRpc",
            "terminal-restore-modes",
            "rewind",
            "checkoutRefresh",
        ] {
            assert_eq!(features[key], true, "feature {key} must be true");
        }
    }

    #[test]
    fn wrapped_message_shape() {
        let msg = server_info_message(&ctx());
        assert_eq!(msg["type"], "session");
        assert_eq!(msg["message"]["type"], "status");
        assert_eq!(msg["message"]["payload"]["status"], "server_info");
    }

    #[test]
    fn origin_rules() {
        let mut c = ctx();
        // No origin -> allowed.
        assert!(is_ws_origin_allowed(&c, None, Some("localhost:7767")));
        // Same-origin -> allowed.
        assert!(is_ws_origin_allowed(
            &c,
            Some("http://localhost:7767"),
            Some("localhost:7767")
        ));
        // Disallowed.
        assert!(!is_ws_origin_allowed(&c, Some("http://evil.com"), Some("localhost:7767")));
        // Wildcard.
        c.allowed_origins.insert("*".into());
        assert!(is_ws_origin_allowed(&c, Some("http://evil.com"), None));
    }
}
