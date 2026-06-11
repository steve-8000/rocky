//! The MCP server: JSON-RPC dispatch + an axum router factory.
//!
//! The daemon mounts [`mcp_router`] under `/mcp/agents` (Streamable HTTP
//! transport). Authentication (`?rockyToken=` + `callerAgentId=`) is enforced
//! by the HTTP layer (`rockyd::http`, which reserves `/mcp`); this module only
//! owns the JSON-RPC handler. The caller agent id is read from the
//! `callerAgentId` query parameter and threaded into each tool's [`CallCtx`].

use std::sync::Arc;

use axum::extract::{Query, State};
use axum::routing::post;
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::context::{CallCtx, McpContext};
use crate::protocol::{
    error_codes, error_response, success_response, JsonRpcError, JsonRpcRequest, ToolRegistry,
    PROTOCOL_VERSION, SERVER_NAME, SERVER_VERSION,
};
use crate::tools;

/// The MCP server. Holds the tool registry and shared context behind an `Arc`.
#[derive(Clone)]
pub struct McpServer {
    inner: Arc<ServerInner>,
}

struct ServerInner {
    registry: ToolRegistry,
    ctx: McpContext,
}

impl McpServer {
    /// Build a server with the mission + core agent tool subset registered.
    pub fn new(ctx: McpContext) -> Self {
        let mut registry = ToolRegistry::new();
        tools::register_all(&mut registry);
        Self {
            inner: Arc::new(ServerInner { registry, ctx }),
        }
    }

    /// The underlying tool registry (for introspection / tests).
    pub fn registry(&self) -> &ToolRegistry {
        &self.inner.registry
    }

    /// Handle a single JSON-RPC request. `caller_agent_id` is supplied by the
    /// HTTP layer from the authenticated `callerAgentId=` query parameter.
    ///
    /// Returns the JSON-RPC response envelope. Notifications (no `id`) yield a
    /// JSON `null` the HTTP layer may translate to `202 Accepted` with no body.
    pub async fn handle_jsonrpc(&self, body: Value, caller_agent_id: Option<String>) -> Value {
        let request = match JsonRpcRequest::from_value(&body) {
            Ok(req) => req,
            Err(err) => return error_response(None, &err),
        };
        let id = request.id.clone();

        match request.method.as_str() {
            "initialize" => success_response(id, self.initialize_result()),
            "notifications/initialized" | "notifications/cancelled" => {
                // Acknowledged notifications: no response body required.
                Value::Null
            }
            "tools/list" => success_response(id, self.tools_list_result()),
            "tools/call" => self.handle_tools_call(request, caller_agent_id).await,
            "ping" => success_response(id, json!({})),
            other => {
                if request.is_notification() {
                    return Value::Null;
                }
                error_response(
                    id,
                    &JsonRpcError::new(
                        error_codes::METHOD_NOT_FOUND,
                        format!("unknown method: {other}"),
                    ),
                )
            }
        }
    }

    fn initialize_result(&self) -> Value {
        json!({
            "protocolVersion": PROTOCOL_VERSION,
            "serverInfo": {
                "name": SERVER_NAME,
                "version": SERVER_VERSION,
            },
            "capabilities": {
                "tools": { "listChanged": false },
            },
        })
    }

    fn tools_list_result(&self) -> Value {
        let tools: Vec<Value> = self
            .inner
            .registry
            .descriptors()
            .into_iter()
            .map(|d| d.to_value())
            .collect();
        json!({ "tools": tools })
    }

    async fn handle_tools_call(
        &self,
        request: JsonRpcRequest,
        caller_agent_id: Option<String>,
    ) -> Value {
        let id = request.id.clone();
        let params = request.params.as_object();
        let name = match params.and_then(|p| p.get("name")).and_then(Value::as_str) {
            Some(name) => name,
            None => {
                return error_response(
                    id,
                    &JsonRpcError::new(error_codes::INVALID_PARAMS, "missing tool name"),
                );
            }
        };
        if !self.inner.registry.contains(name) {
            return error_response(
                id,
                &JsonRpcError::new(
                    error_codes::METHOD_NOT_FOUND,
                    format!("unknown tool: {name}"),
                ),
            );
        }
        let arguments = params
            .and_then(|p| p.get("arguments"))
            .cloned()
            .unwrap_or(Value::Null);
        let ctx = CallCtx::new(self.inner.ctx.clone(), caller_agent_id);
        match self.inner.registry.call(name, arguments, ctx).await {
            Ok(result) => success_response(id, result),
            Err(tool_err) => error_response(id, &tool_err.into_jsonrpc()),
        }
    }
}

/// Query parameters the HTTP layer forwards. `caller_agent_id` is the internal
/// MCP caller identity (`callerAgentId=`); token auth is enforced upstream.
#[derive(Debug, Default, Deserialize)]
pub struct McpQuery {
    #[serde(rename = "callerAgentId")]
    pub caller_agent_id: Option<String>,
}

/// Build an axum `Router` exposing the MCP JSON-RPC handler at POST `/`. The
/// daemon mounts this under `/mcp/agents` via `Router::nest`/`merge`.
pub fn mcp_router(ctx: McpContext) -> Router {
    let server = McpServer::new(ctx);
    Router::new()
        .route("/", post(handle_post))
        .with_state(server)
}

async fn handle_post(
    State(server): State<McpServer>,
    Query(query): Query<McpQuery>,
    Json(body): Json<Value>,
) -> Json<Value> {
    let response = server.handle_jsonrpc(body, query.caller_agent_id).await;
    Json(response)
}
