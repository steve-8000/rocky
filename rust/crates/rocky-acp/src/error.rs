//! Error types for the ACP transport.

use thiserror::Error;

/// Errors surfaced by the ACP transport and session layer.
#[derive(Debug, Error)]
pub enum AcpError {
    /// The child process could not be spawned.
    #[error("failed to spawn ACP agent process: {0}")]
    Spawn(#[source] std::io::Error),

    /// stdin/stdout pipes were not available on the spawned child.
    #[error("ACP agent process is missing stdio pipes")]
    MissingPipes,

    /// Writing a JSON-RPC frame to the child failed.
    #[error("failed to write ACP frame: {0}")]
    Write(#[source] std::io::Error),

    /// Serializing a JSON-RPC frame failed.
    #[error("failed to serialize ACP frame: {0}")]
    Serialize(#[source] serde_json::Error),

    /// The transport's reader task has stopped; no more responses will arrive.
    #[error("ACP transport closed before response arrived")]
    TransportClosed,

    /// The agent returned a JSON-RPC error object for a request.
    #[error("ACP agent returned JSON-RPC error {code}: {message}")]
    Rpc {
        /// JSON-RPC error code.
        code: i64,
        /// Human-readable error message.
        message: String,
        /// Optional structured error data.
        data: Option<serde_json::Value>,
    },

    /// A request timed out waiting for its response.
    #[error("ACP request '{0}' timed out")]
    Timeout(String),

    /// The session was driven in an invalid order (e.g. prompt before init).
    #[error("ACP session protocol error: {0}")]
    Protocol(String),
}

/// Convenience result alias.
pub type AcpResult<T> = Result<T, AcpError>;
