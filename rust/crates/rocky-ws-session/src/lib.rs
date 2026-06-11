//! WebSocket session RPC dispatch for `rockyd`.
//!
//! The production WebUI/app speaks to the daemon over `/ws` using a wrapped
//! "session" envelope (`core/packages/server/src/server/session.ts`):
//!
//! ```json
//! { "type": "session", "message": { "type": "<rpc>", "requestId": "...", ... } }
//! ```
//!
//! This crate decodes that envelope, dispatches the inner `message.type` to a
//! registered handler, and re-wraps the handler's response as an outbound
//! session message. Handlers are grouped by domain (mission, chat, schedule,
//! loop, agent lifecycle, workspace/git/terminal, provider) and delegate to the
//! already-implemented Rust crates (`rocky-agents`, `rocky-mission-control`,
//! `rocky-scheduling`, ...).
//!
//! Wire compatibility is the contract: inner message `type` strings and
//! response payload shapes MUST match the TypeScript daemon exactly so existing
//! clients are unaffected.

mod dispatch;
mod envelope;

pub mod handlers;

pub use dispatch::{SessionDispatcher, SessionHandler, SessionRpcError};
pub use envelope::{unwrap_session_message, wrap_session_message, SessionEnvelopeError};
