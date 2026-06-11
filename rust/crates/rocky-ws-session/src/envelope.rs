use serde_json::{json, Value};
use thiserror::Error;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum SessionEnvelopeError {
    #[error("not a session envelope (expected type=session)")]
    NotSession,
    #[error("session envelope missing inner message")]
    MissingMessage,
    #[error("session message missing string `type`")]
    MissingType,
}

/// Unwrap a top-level `{type:"session", message:{...}}` envelope, returning the
/// inner message object and its `type` string.
///
/// Mirrors the inbound wrapping in `websocket-server.ts` / `messages.ts`.
pub fn unwrap_session_message(envelope: &Value) -> Result<(String, Value), SessionEnvelopeError> {
    if envelope.get("type").and_then(Value::as_str) != Some("session") {
        return Err(SessionEnvelopeError::NotSession);
    }
    let message = envelope
        .get("message")
        .filter(|m| m.is_object())
        .ok_or(SessionEnvelopeError::MissingMessage)?;
    let msg_type = message
        .get("type")
        .and_then(Value::as_str)
        .ok_or(SessionEnvelopeError::MissingType)?
        .to_string();
    Ok((msg_type, message.clone()))
}

/// Wrap an inner session message as a top-level outbound envelope, matching
/// `wrapSessionMessage` (`messages.ts`).
pub fn wrap_session_message(message: Value) -> Value {
    json!({ "type": "session", "message": message })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unwraps_valid_envelope() {
        let env = json!({
            "type": "session",
            "message": { "type": "mission.list.request", "requestId": "r1" }
        });
        let (t, msg) = unwrap_session_message(&env).unwrap();
        assert_eq!(t, "mission.list.request");
        assert_eq!(msg["requestId"], "r1");
    }

    #[test]
    fn rejects_non_session() {
        let env = json!({ "type": "ping" });
        assert_eq!(
            unwrap_session_message(&env).unwrap_err(),
            SessionEnvelopeError::NotSession
        );
    }

    #[test]
    fn rejects_missing_message() {
        let env = json!({ "type": "session" });
        assert_eq!(
            unwrap_session_message(&env).unwrap_err(),
            SessionEnvelopeError::MissingMessage
        );
    }

    #[test]
    fn wrap_roundtrips() {
        let inner = json!({ "type": "mission.list.response", "payload": { "missions": [] } });
        let env = wrap_session_message(inner.clone());
        assert_eq!(env["type"], "session");
        let (t, msg) = unwrap_session_message(&env).unwrap();
        assert_eq!(t, "mission.list.response");
        assert_eq!(msg, inner);
    }
}
