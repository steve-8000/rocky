//! MCP (Model Context Protocol) server for the `rockyd` agents endpoint.
//!
//! Implements the Streamable HTTP / JSON-RPC 2.0 protocol layer plus the
//! Mission Control + core agent tool subset mounted at `/mcp/agents`. Mirrors
//! `core/packages/server/src/server/agent/mcp-server.ts`.
//!
//! - [`protocol`] owns the JSON-RPC envelope and the [`ToolRegistry`].
//! - [`tools`] registers the mission + core agent tools.
//! - [`server`] exposes [`McpServer::handle_jsonrpc`] and the [`mcp_router`]
//!   axum factory the daemon mounts (auth lives in the HTTP layer).
//! - [`context`] bundles the [`rocky_agents::AgentManager`] and
//!   [`rocky_mission_control::FileBackedMissionControlService`] dependencies.

mod context;
mod protocol;
mod server;
mod tools;

pub use context::{CallCtx, McpContext};
pub use protocol::{
    error_codes, JsonRpcError, JsonRpcRequest, ToolDescriptor, ToolError, ToolRegistry,
    PROTOCOL_VERSION, SERVER_NAME, SERVER_VERSION,
};
pub use server::{mcp_router, McpQuery, McpServer};
