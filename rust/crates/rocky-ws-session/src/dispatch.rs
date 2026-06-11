use std::collections::HashMap;
use std::sync::Arc;

use serde_json::Value;
use thiserror::Error;

use crate::envelope::{unwrap_session_message, wrap_session_message, SessionEnvelopeError};

#[derive(Debug, Error)]
pub enum SessionRpcError {
    #[error(transparent)]
    Envelope(#[from] SessionEnvelopeError),
    #[error("no handler registered for session message type `{0}`")]
    UnknownType(String),
    #[error("handler failed: {0}")]
    Handler(String),
}

/// A handler for one inner session message `type`. Receives the full inner
/// message object and returns the inner response message object (which the
/// dispatcher re-wraps in a session envelope). Async via boxed future so
/// handlers can await the backing Rust services.
pub trait SessionHandler: Send + Sync {
    fn handle<'a>(
        &'a self,
        message: Value,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<Value, SessionRpcError>> + Send + 'a>,
    >;
}

impl<F, Fut> SessionHandler for F
where
    F: Fn(Value) -> Fut + Send + Sync,
    Fut: std::future::Future<Output = Result<Value, SessionRpcError>> + Send + 'static,
{
    fn handle<'a>(
        &'a self,
        message: Value,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<Value, SessionRpcError>> + Send + 'a>,
    > {
        Box::pin(self(message))
    }
}

/// Routes inner session message types to registered handlers and manages the
/// envelope wrap/unwrap. Matches the `dispatch*Message` switch structure in
/// `session.ts`, but as a registry rather than a giant match.
#[derive(Default)]
pub struct SessionDispatcher {
    handlers: HashMap<String, Arc<dyn SessionHandler>>,
}

impl SessionDispatcher {
    pub fn new() -> Self {
        Self {
            handlers: HashMap::new(),
        }
    }

    /// Register a handler for an inner message `type`. Last registration wins.
    pub fn register(&mut self, msg_type: impl Into<String>, handler: Arc<dyn SessionHandler>) {
        self.handlers.insert(msg_type.into(), handler);
    }

    pub fn handles(&self, msg_type: &str) -> bool {
        self.handlers.contains_key(msg_type)
    }

    pub fn registered_types(&self) -> Vec<String> {
        let mut v: Vec<String> = self.handlers.keys().cloned().collect();
        v.sort();
        v
    }

    /// Dispatch a full inbound `{type:"session", message:{...}}` envelope and
    /// return the outbound session envelope, or an error.
    pub async fn dispatch_envelope(&self, envelope: &Value) -> Result<Value, SessionRpcError> {
        let (msg_type, message) = unwrap_session_message(envelope)?;
        let response = self.dispatch_message(&msg_type, message).await?;
        Ok(wrap_session_message(response))
    }

    /// Dispatch an already-unwrapped inner message by its type.
    pub async fn dispatch_message(
        &self,
        msg_type: &str,
        message: Value,
    ) -> Result<Value, SessionRpcError> {
        let handler = self
            .handlers
            .get(msg_type)
            .ok_or_else(|| SessionRpcError::UnknownType(msg_type.to_string()))?
            .clone();
        handler.handle(message).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn dispatches_registered_handler() {
        let mut d = SessionDispatcher::new();
        d.register(
            "echo.request",
            Arc::new(|msg: Value| async move {
                Ok(json!({
                    "type": "echo.response",
                    "payload": { "requestId": msg["requestId"], "echo": msg["text"] }
                }))
            }),
        );
        let env = json!({
            "type": "session",
            "message": { "type": "echo.request", "requestId": "r1", "text": "hi" }
        });
        let out = d.dispatch_envelope(&env).await.unwrap();
        assert_eq!(out["type"], "session");
        assert_eq!(out["message"]["type"], "echo.response");
        assert_eq!(out["message"]["payload"]["echo"], "hi");
        assert_eq!(out["message"]["payload"]["requestId"], "r1");
    }

    #[tokio::test]
    async fn unknown_type_errors() {
        let d = SessionDispatcher::new();
        let env = json!({ "type": "session", "message": { "type": "nope" } });
        let err = d.dispatch_envelope(&env).await.unwrap_err();
        assert!(matches!(err, SessionRpcError::UnknownType(t) if t == "nope"));
    }
}
