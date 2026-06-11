//! JSON-RPC 2.0 envelope handling and the MCP tool registry.
//!
//! Mirrors the Streamable HTTP MCP server in
//! `core/packages/server/src/server/agent/mcp-server.ts`: the daemon mounts a
//! JSON-RPC 2.0 endpoint at `/mcp/agents` that speaks `initialize`,
//! `tools/list`, and `tools/call`. This module owns the wire envelope and a
//! name -> {descriptor, handler} registry; the concrete tool set lives in
//! [`crate::tools`].

use std::collections::BTreeMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use serde_json::{json, Value};

use crate::context::CallCtx;

/// Protocol version advertised in `initialize`. Matches the MCP revision the
/// TS server negotiates with the `@modelcontextprotocol/sdk` transport.
pub const PROTOCOL_VERSION: &str = "2024-11-05";

/// Server name reported in `initialize.serverInfo` (the `/mcp/agents` mount).
pub const SERVER_NAME: &str = "rocky-agents";

/// Server version reported in `initialize.serverInfo`.
pub const SERVER_VERSION: &str = env!("CARGO_PKG_VERSION");

/// Standard JSON-RPC 2.0 error codes plus the server-defined range this crate
/// uses for tool execution / wiring failures.
pub mod error_codes {
    /// Invalid JSON was received (`-32700`).
    pub const PARSE_ERROR: i64 = -32700;
    /// The JSON sent is not a valid Request object (`-32600`).
    pub const INVALID_REQUEST: i64 = -32600;
    /// The method / tool does not exist (`-32601`).
    pub const METHOD_NOT_FOUND: i64 = -32601;
    /// Invalid method parameters (`-32602`).
    pub const INVALID_PARAMS: i64 = -32602;
    /// Tool execution failed inside the manager / mission service (`-32000`).
    pub const EXECUTION_ERROR: i64 = -32000;
    /// The tool is recognized but cannot run yet because a runtime dependency
    /// (e.g. a live provider session) is not wired in this build (`-32010`).
    pub const NOT_WIRED: i64 = -32010;
}

/// A parsed JSON-RPC request. `id` is absent for notifications.
#[derive(Debug, Clone)]
pub struct JsonRpcRequest {
    pub method: String,
    pub params: Value,
    pub id: Option<Value>,
}

impl JsonRpcRequest {
    /// Parse a JSON-RPC request from a raw body value. Permissive: tolerates a
    /// missing/non-`"2.0"` `jsonrpc` field but requires a string `method`.
    pub fn from_value(body: &Value) -> Result<Self, JsonRpcError> {
        let obj = body
            .as_object()
            .ok_or_else(|| JsonRpcError::new(error_codes::INVALID_REQUEST, "request must be an object"))?;
        let method = obj
            .get("method")
            .and_then(Value::as_str)
            .ok_or_else(|| JsonRpcError::new(error_codes::INVALID_REQUEST, "missing method"))?
            .to_string();
        let params = obj.get("params").cloned().unwrap_or(Value::Null);
        let id = obj.get("id").cloned();
        Ok(Self { method, params, id })
    }

    /// Whether this is a notification (no `id`, no response expected).
    pub fn is_notification(&self) -> bool {
        self.id.is_none()
    }
}

/// A JSON-RPC error payload.
#[derive(Debug, Clone)]
pub struct JsonRpcError {
    pub code: i64,
    pub message: String,
    pub data: Option<Value>,
}

impl JsonRpcError {
    pub fn new(code: i64, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            data: None,
        }
    }

    pub fn with_data(code: i64, message: impl Into<String>, data: Value) -> Self {
        Self {
            code,
            message: message.into(),
            data: Some(data),
        }
    }

    fn to_value(&self) -> Value {
        let mut obj = serde_json::Map::new();
        obj.insert("code".into(), json!(self.code));
        obj.insert("message".into(), json!(self.message));
        if let Some(data) = &self.data {
            obj.insert("data".into(), data.clone());
        }
        Value::Object(obj)
    }
}

/// Build a JSON-RPC success response envelope.
pub fn success_response(id: Option<Value>, result: Value) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id.unwrap_or(Value::Null),
        "result": result,
    })
}

/// Build a JSON-RPC error response envelope.
pub fn error_response(id: Option<Value>, error: &JsonRpcError) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id.unwrap_or(Value::Null),
        "error": error.to_value(),
    })
}

/// Failure surfaced by a tool handler. Mapped to a JSON-RPC error by the
/// dispatcher.
#[derive(Debug, Clone)]
pub enum ToolError {
    /// Arguments failed validation (bad/missing fields). -> `-32602`.
    InvalidParams(String),
    /// The manager / mission service returned an error. Carries a stable
    /// string `code` surfaced under `error.data.code`. -> `-32000`.
    Execution { code: String, message: String },
    /// The tool exists but a runtime dependency is not wired in this build
    /// (e.g. no live provider). -> `-32010`, never a fake ok.
    NotWired { message: String },
}

impl ToolError {
    pub fn invalid_params(message: impl Into<String>) -> Self {
        ToolError::InvalidParams(message.into())
    }

    pub fn execution(code: impl Into<String>, message: impl Into<String>) -> Self {
        ToolError::Execution {
            code: code.into(),
            message: message.into(),
        }
    }

    pub fn not_wired(message: impl Into<String>) -> Self {
        ToolError::NotWired {
            message: message.into(),
        }
    }

    /// Convert into the JSON-RPC error returned to the client.
    pub fn into_jsonrpc(self) -> JsonRpcError {
        match self {
            ToolError::InvalidParams(message) => {
                JsonRpcError::new(error_codes::INVALID_PARAMS, message)
            }
            ToolError::Execution { code, message } => JsonRpcError::with_data(
                error_codes::EXECUTION_ERROR,
                message,
                json!({ "code": code }),
            ),
            ToolError::NotWired { message } => JsonRpcError::with_data(
                error_codes::NOT_WIRED,
                message,
                json!({ "code": "provider_wiring_required" }),
            ),
        }
    }
}

/// The result returned by a tool handler. Mirrors the MCP `tools/call` content
/// shape used by the TS server: an empty `content` array plus
/// `structuredContent` carrying the typed payload.
pub fn tool_result(structured: Value) -> Value {
    json!({
        "content": [],
        "structuredContent": structured,
    })
}

/// Boxed future returned by a tool handler.
pub type ToolFuture = Pin<Box<dyn Future<Output = Result<Value, ToolError>> + Send>>;

/// A tool handler: parsed JSON arguments + per-request call context -> result.
pub type ToolHandler = Arc<dyn Fn(Value, CallCtx) -> ToolFuture + Send + Sync>;

/// Static metadata for a registered tool (the `tools/list` descriptor).
#[derive(Debug, Clone)]
pub struct ToolDescriptor {
    pub name: String,
    pub title: String,
    pub description: String,
    pub input_schema: Value,
}

impl ToolDescriptor {
    /// Serialize the descriptor for `tools/list` (`name`/`title`/`description`/
    /// `inputSchema`).
    pub fn to_value(&self) -> Value {
        json!({
            "name": self.name,
            "title": self.title,
            "description": self.description,
            "inputSchema": self.input_schema,
        })
    }
}

struct RegisteredTool {
    descriptor: ToolDescriptor,
    handler: ToolHandler,
}

/// A registry of MCP tools, keyed by name. Cheap to clone is not required; the
/// server holds it behind an `Arc`.
#[derive(Default)]
pub struct ToolRegistry {
    tools: BTreeMap<String, RegisteredTool>,
}

impl ToolRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Register a tool. A duplicate name replaces the prior registration.
    pub fn register(&mut self, descriptor: ToolDescriptor, handler: ToolHandler) {
        self.tools.insert(
            descriptor.name.clone(),
            RegisteredTool {
                descriptor,
                handler,
            },
        );
    }

    /// All descriptors, sorted by name (deterministic `tools/list`).
    pub fn descriptors(&self) -> Vec<&ToolDescriptor> {
        self.tools.values().map(|t| &t.descriptor).collect()
    }

    /// Whether a tool with `name` is registered.
    pub fn contains(&self, name: &str) -> bool {
        self.tools.contains_key(name)
    }

    /// Dispatch a `tools/call`. Returns the JSON-RPC error if the tool is
    /// unknown; otherwise runs the handler.
    pub async fn call(
        &self,
        name: &str,
        arguments: Value,
        ctx: CallCtx,
    ) -> Result<Value, ToolError> {
        let tool = self.tools.get(name).ok_or_else(|| {
            ToolError::InvalidParams(format!("unknown tool: {name}"))
        })?;
        (tool.handler)(arguments, ctx).await
    }
}
