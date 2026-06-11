//! NDJSON JSON-RPC 2.0 transport over a child process stdin/stdout.
//!
//! Mirrors `createLoggedNdJsonStream`
//! (`core/packages/server/src/server/agent/providers/acp-agent.ts:206-271`):
//! one JSON object per line, split on `\n`, non-JSON stdout lines are logged
//! and ignored, and outbound frames are serialized one object per line.
//!
//! Response-id normalization mirrors `normalizeACPIncomingMessage`
//! (`acp-agent.ts:186-204`): some agents stringify numeric response ids, so a
//! response whose `id` is a numeric string is correlated as the equivalent
//! integer.

use std::collections::HashMap;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Arc;

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{ChildStdin, ChildStdout};
use tokio::sync::{mpsc, oneshot, Mutex};
use tokio::task::JoinHandle;

use crate::error::{AcpError, AcpResult};

/// An inbound message that the client must observe (and possibly reply to).
#[derive(Debug)]
pub enum Inbound {
    /// Agent -> client notification (no id, no reply expected).
    Notification {
        /// JSON-RPC method, e.g. `session/update`.
        method: String,
        /// Method params (defaults to `null` when absent).
        params: Value,
    },
    /// Agent -> client request (has id, requires a reply via [`Transport::respond`]).
    Request {
        /// JSON-RPC id echoed verbatim in the reply.
        id: Value,
        /// JSON-RPC method, e.g. `session/request_permission`.
        method: String,
        /// Method params (defaults to `null` when absent).
        params: Value,
    },
}

/// Sender half handed back to the caller so it can receive inbound traffic.
pub type InboundReceiver = mpsc::UnboundedReceiver<Inbound>;

type PendingMap = Arc<Mutex<HashMap<i64, oneshot::Sender<AcpResult<Value>>>>>;

/// JSON-RPC transport bound to a single child process.
///
/// Cheaply cloneable: the writer and pending-request table are shared.
#[derive(Clone)]
pub struct Transport {
    stdin: Arc<Mutex<ChildStdin>>,
    pending: PendingMap,
    next_id: Arc<AtomicI64>,
    reader: Arc<JoinHandle<()>>,
}

impl Transport {
    /// Wire a transport to a child's stdin/stdout, spawning the reader task.
    ///
    /// Returns the transport plus the inbound channel for notifications and
    /// agent->client requests.
    pub fn new(stdin: ChildStdin, stdout: ChildStdout) -> (Self, InboundReceiver) {
        let pending: PendingMap = Arc::new(Mutex::new(HashMap::new()));
        let (inbound_tx, inbound_rx) = mpsc::unbounded_channel();

        let reader = tokio::spawn(reader_loop(stdout, pending.clone(), inbound_tx));

        let transport = Self {
            stdin: Arc::new(Mutex::new(stdin)),
            pending,
            next_id: Arc::new(AtomicI64::new(1)),
            reader: Arc::new(reader),
        };
        (transport, inbound_rx)
    }

    /// Send a client->agent request and await the correlated response value.
    ///
    /// The returned `Value` is the JSON-RPC `result`; a JSON-RPC `error`
    /// surfaces as [`AcpError::Rpc`].
    pub async fn request(&self, method: &str, params: Value) -> AcpResult<Value> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(id, tx);

        let frame = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        });
        if let Err(err) = self.write_frame(&frame).await {
            self.pending.lock().await.remove(&id);
            return Err(err);
        }

        match rx.await {
            Ok(result) => result,
            Err(_) => Err(AcpError::TransportClosed),
        }
    }

    /// Send a client->agent notification (no response expected).
    pub async fn notify(&self, method: &str, params: Value) -> AcpResult<()> {
        let frame = json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params,
        });
        self.write_frame(&frame).await
    }

    /// Reply to an agent->client request with a successful result.
    pub async fn respond(&self, id: Value, result: Value) -> AcpResult<()> {
        let frame = json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": result,
        });
        self.write_frame(&frame).await
    }

    /// Reply to an agent->client request with a JSON-RPC error.
    pub async fn respond_error(
        &self,
        id: Value,
        code: i64,
        message: &str,
    ) -> AcpResult<()> {
        let frame = json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": { "code": code, "message": message },
        });
        self.write_frame(&frame).await
    }

    async fn write_frame(&self, frame: &Value) -> AcpResult<()> {
        let mut line = serde_json::to_string(frame).map_err(AcpError::Serialize)?;
        line.push('\n');
        let mut stdin = self.stdin.lock().await;
        stdin
            .write_all(line.as_bytes())
            .await
            .map_err(AcpError::Write)?;
        stdin.flush().await.map_err(AcpError::Write)?;
        Ok(())
    }

    /// Abort the reader task. Called on shutdown after the child exits.
    pub fn shutdown(&self) {
        self.reader.abort();
    }
}

/// Extract a numeric id from a JSON-RPC `id` field, accepting both integers and
/// numeric strings (the `normalizeACPIncomingMessage` compat path).
fn id_as_i64(value: &Value) -> Option<i64> {
    match value {
        Value::Number(n) => n.as_i64(),
        Value::String(s) => s.parse::<i64>().ok(),
        _ => None,
    }
}

async fn reader_loop<R>(
    stdout: R,
    pending: PendingMap,
    inbound_tx: mpsc::UnboundedSender<Inbound>,
) where
    R: tokio::io::AsyncRead + Unpin,
{
    let mut lines = BufReader::new(stdout).lines();
    loop {
        let line = match lines.next_line().await {
            Ok(Some(line)) => line,
            Ok(None) => break,
            Err(err) => {
                tracing::warn!(error = %err, "ACP stdout read error; stopping reader");
                break;
            }
        };
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let message: Value = match serde_json::from_str(trimmed) {
            Ok(value) => value,
            Err(err) => {
                tracing::warn!(
                    error = %err,
                    "ACP agent emitted non-JSON stdout; ignoring line"
                );
                continue;
            }
        };
        dispatch(&pending, &inbound_tx, message).await;
    }

    // Drain any pending requests so callers don't hang once stdout closes.
    let mut pending = pending.lock().await;
    for (_, tx) in pending.drain() {
        let _ = tx.send(Err(AcpError::TransportClosed));
    }
}

async fn dispatch(
    pending: &PendingMap,
    inbound_tx: &mpsc::UnboundedSender<Inbound>,
    message: Value,
) {
    let has_method = message.get("method").map(Value::is_string).unwrap_or(false);
    let id = message.get("id").cloned();

    if has_method {
        // Has method => request (with id) or notification (without id).
        let method = message
            .get("method")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let params = message.get("params").cloned().unwrap_or(Value::Null);
        let inbound = match id {
            Some(id) if !id.is_null() => Inbound::Request { id, method, params },
            _ => Inbound::Notification { method, params },
        };
        let _ = inbound_tx.send(inbound);
        return;
    }

    // No method => response to one of our requests.
    let Some(id_value) = id else {
        tracing::warn!("ACP frame had neither method nor id; ignoring");
        return;
    };
    let Some(numeric_id) = id_as_i64(&id_value) else {
        tracing::warn!(id = %id_value, "ACP response id was not numeric; ignoring");
        return;
    };
    let Some(tx) = pending.lock().await.remove(&numeric_id) else {
        tracing::warn!(id = numeric_id, "ACP response for unknown request id");
        return;
    };

    if let Some(error) = message.get("error") {
        let code = error.get("code").and_then(Value::as_i64).unwrap_or(0);
        let msg = error
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("unknown error")
            .to_string();
        let data = error.get("data").cloned();
        let _ = tx.send(Err(AcpError::Rpc {
            code,
            message: msg,
            data,
        }));
    } else {
        let result = message.get("result").cloned().unwrap_or(Value::Null);
        let _ = tx.send(Ok(result));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn id_as_i64_accepts_integers_and_numeric_strings() {
        assert_eq!(id_as_i64(&json!(7)), Some(7));
        assert_eq!(id_as_i64(&json!("42")), Some(42));
        assert_eq!(id_as_i64(&json!("abc")), None);
        assert_eq!(id_as_i64(&json!(null)), None);
    }

    // Drives reader_loop over an in-memory stream and returns the pending map +
    // inbound channel so framing behavior can be asserted end-to-end.
    async fn run_reader(
        input: &str,
    ) -> (PendingMap, mpsc::UnboundedReceiver<Inbound>, JoinHandle<()>) {
        let pending: PendingMap = Arc::new(Mutex::new(HashMap::new()));
        let (tx, rx) = mpsc::unbounded_channel();
        let cursor = std::io::Cursor::new(input.as_bytes().to_vec());
        let handle = tokio::spawn(reader_loop(cursor, pending.clone(), tx));
        (pending, rx, handle)
    }

    #[tokio::test]
    async fn response_correlates_by_numeric_id() {
        let pending: PendingMap = Arc::new(Mutex::new(HashMap::new()));
        let (otx, orx) = oneshot::channel();
        pending.lock().await.insert(5, otx);
        let (itx, _irx) = mpsc::unbounded_channel();
        dispatch(
            &pending,
            &itx,
            json!({"jsonrpc": "2.0", "id": 5, "result": {"ok": true}}),
        )
        .await;
        let got = orx.await.unwrap().unwrap();
        assert_eq!(got, json!({"ok": true}));
    }

    #[tokio::test]
    async fn response_correlates_by_stringified_numeric_id() {
        let pending: PendingMap = Arc::new(Mutex::new(HashMap::new()));
        let (otx, orx) = oneshot::channel();
        pending.lock().await.insert(9, otx);
        let (itx, _irx) = mpsc::unbounded_channel();
        dispatch(
            &pending,
            &itx,
            json!({"jsonrpc": "2.0", "id": "9", "result": 1}),
        )
        .await;
        assert_eq!(orx.await.unwrap().unwrap(), json!(1));
    }

    #[tokio::test]
    async fn rpc_error_surfaces_to_caller() {
        let pending: PendingMap = Arc::new(Mutex::new(HashMap::new()));
        let (otx, orx) = oneshot::channel();
        pending.lock().await.insert(1, otx);
        let (itx, _irx) = mpsc::unbounded_channel();
        dispatch(
            &pending,
            &itx,
            json!({"jsonrpc": "2.0", "id": 1, "error": {"code": -32000, "message": "boom"}}),
        )
        .await;
        match orx.await.unwrap() {
            Err(AcpError::Rpc { code, message, .. }) => {
                assert_eq!(code, -32000);
                assert_eq!(message, "boom");
            }
            other => panic!("expected rpc error, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn notification_and_request_dispatch_and_non_json_ignored() {
        let input = concat!(
            "not json at all\n",
            "{\"jsonrpc\":\"2.0\",\"method\":\"session/update\",\"params\":{\"x\":1}}\n",
            "{\"jsonrpc\":\"2.0\",\"id\":0,\"method\":\"session/request_permission\",\"params\":{\"y\":2}}\n",
        );
        let (_pending, mut rx, handle) = run_reader(input).await;
        handle.await.unwrap();

        let first = rx.recv().await.unwrap();
        match first {
            Inbound::Notification { method, params } => {
                assert_eq!(method, "session/update");
                assert_eq!(params, json!({"x": 1}));
            }
            other => panic!("expected notification, got {other:?}"),
        }
        let second = rx.recv().await.unwrap();
        match second {
            Inbound::Request { id, method, params } => {
                assert_eq!(id, json!(0));
                assert_eq!(method, "session/request_permission");
                assert_eq!(params, json!({"y": 2}));
            }
            other => panic!("expected request, got {other:?}"),
        }
        // Only two valid frames; the non-JSON line was dropped.
        assert!(rx.recv().await.is_none());
    }

    #[tokio::test]
    async fn closed_stream_drains_pending_requests() {
        let pending: PendingMap = Arc::new(Mutex::new(HashMap::new()));
        let (otx, orx) = oneshot::channel();
        pending.lock().await.insert(3, otx);
        let (tx, _rx) = mpsc::unbounded_channel();
        let cursor = std::io::Cursor::new(Vec::<u8>::new());
        reader_loop(cursor, pending, tx).await;
        assert!(matches!(orx.await.unwrap(), Err(AcpError::TransportClosed)));
    }
}
