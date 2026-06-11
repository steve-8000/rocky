//! ACP (Agent Client Protocol) stdio JSON-RPC transport for `rockyd`.
//!
//! This crate is a faithful Rust port of the TypeScript ACP provider in
//! `core/packages/server/src/server/agent/providers/acp-agent.ts` and
//! `generic-acp-agent.ts`. It speaks NDJSON JSON-RPC 2.0 over a child
//! process's stdin/stdout and translates the agent's `session/update`
//! notifications and `session/request_permission` requests into
//! [`rocky_agent_domain::AgentStreamEvent`] values.
//!
//! Layers:
//! - [`transport`]: NDJSON JSON-RPC framing + request/response correlation.
//! - [`process`]: subprocess launch, `__ROCKY_ROOT__` expansion, graceful kill.
//! - [`approval`]: Rocky autonomous-approval normalization + synthetic bypass.
//! - [`tool_detail`]: `mapToolDetail` port (shell/read/edit/write/search/fetch).
//! - [`session`]: [`session::AcpSession`], the lifecycle + event translator.
//!
//! Method names and param/result shapes were verified against the live amaze
//! ACP agent (`bun vendor/amaze/packages/coding-agent/src/cli.ts acp`); see
//! the module-level docs in [`session`] for the captured frame shapes.

pub mod approval;
pub mod error;
pub mod process;
pub mod session;
pub mod tool_detail;
pub mod transport;

pub use error::{AcpError, AcpResult};
pub use process::{expand_rocky_root, AcpProcess, ProcessSpec, ROCKY_ROOT_TOKEN};
pub use session::{
    AcpModel, AcpSelectOption, AcpSession, SessionConfig, SessionInit, ACP_PROVIDER,
    PROTOCOL_VERSION,
};
pub use transport::{Inbound, InboundReceiver, Transport};
