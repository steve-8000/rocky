//! Domain handler groups that register session RPC handlers onto a
//! [`crate::SessionDispatcher`].
//!
//! Each submodule wires one domain's inner message types to the backing Rust
//! service crate, matching the `dispatch*Message` groups in `session.ts`.

pub mod mission;
pub mod agent;
pub mod workspace;
pub mod chat_schedule_loop;
pub mod checkout;
pub mod files;
pub mod daemon_read;
