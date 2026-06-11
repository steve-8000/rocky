//! HTTP router assembly, ported from
//! `core/packages/server/src/server/bootstrap.ts:378-474`.
//!
//! Middleware order matches the TS daemon exactly:
//! 1. Host validation (TCP only) -> 403 `{"error":"Invalid Host header"}`
//! 2. CORS (sets ACAO/etc; OPTIONS -> 204)
//! 3. WebUI static assets + SPA fallback (public, BEFORE auth)
//! 4. Bearer auth (protects everything except the public assets/health)
//! 5. `/public` static (AFTER auth)
//! 6. `/api/health` (public) and `/api/status` (protected)
//! 7. `/ws` upgrade
//!
//! `serviceProxy` (TS step 1) is not part of Phase 2 and is omitted; `/mcp`
//! remains a reserved prefix that falls through (404) until implemented.

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Arc;

use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::{header, HeaderValue, Method, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use rocky_config::HostnamesConfig;
use serde_json::json;

use crate::auth::{extract_http_bearer_token, is_bearer_token_valid, should_bypass_bearer_auth};
use crate::hostnames::is_hostname_allowed;
use crate::webui::should_serve_spa_fallback;

/// Shared per-server context threaded through every handler/middleware.
#[derive(Clone)]
pub struct ServerContext {
    pub server_id: String,
    pub hostname: String,
    /// `version` for `/api/status` and WS `server_info`; `null` is acceptable
    /// for Phase 2 (`bootstrap.ts:471`).
    pub version: serde_json::Value,
    /// Canonical bound listen string for `/api/status`.
    pub listen: String,
    /// Whether the listener is TCP (host validation applies only to TCP).
    pub is_tcp: bool,
    /// bcrypt password hash; `None` disables auth.
    pub password: Option<String>,
    /// Precomputed CORS allowed origin set (may contain `*`).
    pub allowed_origins: HashSet<String>,
    /// Configured hostnames allowlist (`None` => defaults).
    pub hostnames: Option<HostnamesConfig>,
    /// Resolved WebUI bundle dir (`None` => API-only).
    pub webui_dir: Option<PathBuf>,
    /// `/public` static dir (`$ROCKY_HOME/public`).
    pub public_dir: PathBuf,
    /// Session RPC dispatcher mounted on `/ws` after a successful hello.
    /// `None` in API-only/test contexts that do not wire session handlers.
    pub session_dispatcher: Option<Arc<rocky_ws_session::SessionDispatcher>>,
    /// Live agent control plane, used by `/ws` to subscribe to and push
    /// `agent_stream` broadcast events. `None` in API-only/test contexts.
    pub agent_manager: Option<Arc<rocky_agents::AgentManager>>,
    /// Boot-scoped internal MCP token. When set, requests to `/mcp/*` may
    /// authenticate with `?rockyToken=<token>` instead of the daemon password
    /// (mirrors `auth.ts` internal-token handling). Minted fresh on each daemon
    /// start; injected into agent MCP server URLs so their self-calls pass auth.
    pub internal_mcp_token: Option<String>,
}

/// Build the CORS allowed-origin set, matching `bootstrap.ts:396-409`.
pub fn build_allowed_origins(
    configured: &[String],
    is_tcp: bool,
    host: &str,
    port: u16,
) -> HashSet<String> {
    let mut set: HashSet<String> = configured.iter().cloned().collect();
    // Packaged desktop renderers use the custom rocky:// scheme.
    set.insert("rocky://app".to_string());
    if is_tcp {
        set.insert(format!("http://{host}:{port}"));
        set.insert(format!("http://localhost:{port}"));
        set.insert(format!("http://127.0.0.1:{port}"));
    }
    set
}

/// Assemble the Phase 2 router (no MCP surface). Retained for tests and the
/// API-only path.
#[cfg_attr(not(test), allow(dead_code))]
pub fn build_router(ctx: Arc<ServerContext>) -> Router {
    build_router_inner(ctx, None)
}

/// Assemble the router with the agent/mission MCP surface mounted under
/// `/mcp/agents`. The MCP router is nested behind the same bearer middleware as
/// the other protected routes, so host validation + auth (Phase 2 ordering)
/// run before the MCP handler. Auth is bypassed only when no password is set.
pub fn build_router_with_mcp(ctx: Arc<ServerContext>, mcp_router: Router) -> Router {
    build_router_inner(ctx, Some(mcp_router))
}

fn build_router_inner(ctx: Arc<ServerContext>, mcp_router: Option<Router>) -> Router {
    // Protected API routes (`/api/status`) + `/public` static share the bearer
    // middleware; `/api/health` and `/ws` are mounted without it.
    let protected = Router::new()
        .route("/api/status", get(status))
        .route("/public/{*path}", get(serve_public))
        .route_layer(middleware::from_fn_with_state(ctx.clone(), bearer_auth));

    let mut router = Router::new()
        .route("/api/health", get(health))
        .route("/ws", get(crate::ws::ws_handler))
        .merge(protected);

    // Mount the MCP JSON-RPC surface under `/mcp/agents`, behind the bearer
    // middleware so the internal-token / password gate applies before dispatch.
    // `nest_service` is used because the MCP router carries its own state
    // (`McpServer`); the bearer layer binds `ServerContext` independently.
    if let Some(mcp_router) = mcp_router {
        let mcp = Router::new()
            .nest_service("/mcp/agents", mcp_router)
            .route_layer(middleware::from_fn_with_state(ctx.clone(), mcp_auth));
        router = router.merge(mcp);
    }

    let router = router.fallback(webui_fallback).with_state(ctx.clone());

    // Layers wrap inner-to-outer; declare CORS first (inner) then host (outer)
    // so request flow is host -> cors -> routes, matching the TS order.
    router
        .layer(middleware::from_fn_with_state(ctx.clone(), cors))
        .layer(middleware::from_fn_with_state(ctx, host_validation))
}

/// Host allowlist / DNS-rebinding protection (`bootstrap.ts:383-394`).
/// Applied to every request but enforced only for TCP listeners.
async fn host_validation(
    State(ctx): State<Arc<ServerContext>>,
    request: Request,
    next: Next,
) -> Response {
    if ctx.is_tcp {
        let host = request
            .headers()
            .get(header::HOST)
            .and_then(|v| v.to_str().ok());
        if !is_hostname_allowed(host, ctx.hostnames.as_ref()) {
            return (
                StatusCode::FORBIDDEN,
                Json(json!({ "error": "Invalid Host header" })),
            )
                .into_response();
        }
    }
    next.run(request).await
}

/// CORS handling (`bootstrap.ts:411-424`). Sets ACAO headers for an allowed
/// origin and short-circuits OPTIONS preflight with 204.
async fn cors(State(ctx): State<Arc<ServerContext>>, request: Request, next: Next) -> Response {
    let origin = request
        .headers()
        .get(header::ORIGIN)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());
    let is_options = request.method() == Method::OPTIONS;

    let allow_origin: Option<HeaderValue> = origin.as_deref().and_then(|o| {
        if ctx.allowed_origins.contains("*") || ctx.allowed_origins.contains(o) {
            HeaderValue::from_str(o).ok()
        } else {
            None
        }
    });

    let mut response = if is_options {
        (StatusCode::NO_CONTENT, Body::empty()).into_response()
    } else {
        next.run(request).await
    };

    if let Some(value) = allow_origin {
        let headers = response.headers_mut();
        headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, value);
        headers.insert(
            header::ACCESS_CONTROL_ALLOW_METHODS,
            HeaderValue::from_static("GET, POST, DELETE, OPTIONS"),
        );
        headers.insert(
            header::ACCESS_CONTROL_ALLOW_HEADERS,
            HeaderValue::from_static("Content-Type, Authorization"),
        );
        headers.insert(
            header::ACCESS_CONTROL_ALLOW_CREDENTIALS,
            HeaderValue::from_static("true"),
        );
    }

    response
}

/// Shared bearer decision used by both the `bearer_auth` middleware and the
/// WebUI fallback. Returns `true` when the request may proceed (no password,
/// bypassed, or a valid token); `false` when it must be rejected with 401.
///
/// Mirrors `createRequireBearerMiddleware` (`auth.ts`).
fn is_request_authorized(
    ctx: &ServerContext,
    method: &str,
    path: &str,
    auth_header: Option<&str>,
) -> bool {
    if ctx.password.is_none() || should_bypass_bearer_auth(method, path) {
        return true;
    }
    let token = extract_http_bearer_token(auth_header);
    is_bearer_token_valid(ctx.password.as_deref(), token.as_deref())
}

/// The shared 401 response body, matching the TS `{"error":"Unauthorized"}`.
fn unauthorized_response() -> Response {
    (
        StatusCode::UNAUTHORIZED,
        Json(json!({ "error": "Unauthorized" })),
    )
        .into_response()
}

/// Bearer auth middleware (`createRequireBearerMiddleware`, `auth.ts`).
async fn bearer_auth(
    State(ctx): State<Arc<ServerContext>>,
    request: Request,
    next: Next,
) -> Response {
    let method = request.method().as_str();
    let path = request.uri().path();
    let auth_header = request
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok());

    if !is_request_authorized(&ctx, method, path, auth_header) {
        return unauthorized_response();
    }

    next.run(request).await
}

/// Auth middleware for the `/mcp/*` mount. Accepts the daemon password
/// (`Authorization: Bearer`) like every protected route, but ALSO accepts the
/// boot-scoped internal token via `?rockyToken=<token>`. Mirrors `auth.ts`:
/// daemon-injected agent MCP clients carry the token in their server URL, so
/// their self-calls to `/mcp/agents` authenticate without the user password.
async fn mcp_auth(
    State(ctx): State<Arc<ServerContext>>,
    request: Request,
    next: Next,
) -> Response {
    let method = request.method().as_str();
    let path = request.uri().path();
    let auth_header = request
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok());

    if is_request_authorized(&ctx, method, path, auth_header) {
        return next.run(request).await;
    }

    // Fall back to the internal `?rockyToken=` token (constant-time compare).
    let provided = crate::auth::extract_query_param(request.uri().query(), "rockyToken");
    if crate::auth::internal_mcp_token_matches(
        ctx.internal_mcp_token.as_deref(),
        provided.as_deref(),
    ) {
        return next.run(request).await;
    }

    unauthorized_response()
}

/// `GET /api/health` (`bootstrap.ts:462-464`). Public.
async fn health() -> Json<serde_json::Value> {
    Json(json!({
        "status": "ok",
        "timestamp": crate::lifecycle::now_iso8601(),
    }))
}

/// `GET /api/status` (`bootstrap.ts:466-473`). Protected by bearer auth.
async fn status(State(ctx): State<Arc<ServerContext>>) -> Json<serde_json::Value> {
    Json(json!({
        "status": "server_info",
        "serverId": ctx.server_id,
        "hostname": ctx.hostname,
        "version": ctx.version,
        "listen": ctx.listen,
    }))
}

/// `GET /public/{*path}` — static files from `$ROCKY_HOME/public`, AFTER auth
/// (`bootstrap.ts:456`).
async fn serve_public(
    State(ctx): State<Arc<ServerContext>>,
    request: Request,
) -> Response {
    let path = request.uri().path();
    // Strip the `/public/` prefix to get the relative file path.
    let rel = path.strip_prefix("/public/").unwrap_or("");
    if rel.is_empty() || rel.contains("..") {
        return StatusCode::NOT_FOUND.into_response();
    }
    let candidate = ctx.public_dir.join(rel);
    serve_file_or(candidate, StatusCode::NOT_FOUND).await
}

/// WebUI static assets + SPA fallback (`bootstrap.ts:426-443`), then the
/// global bearer gate (`bootstrap.ts:445-454`).
///
/// Public assets and the SPA `index.html` are served BEFORE auth. Everything
/// else (reserved-prefix misses, `..`, non-GET/HEAD) hits the same bearer
/// decision as the global TS middleware: 401 when a password is set and the
/// request is unauthorized (OPTIONS / `/api/health` bypass aside), else 404.
async fn webui_fallback(State(ctx): State<Arc<ServerContext>>, request: Request) -> Response {
    let method = request.method().as_str().to_string();
    let path = request.uri().path().to_string();

    if let Some(webui_dir) = ctx.webui_dir.as_ref() {
        // 1. Serve a real static asset when present (express.static, fallthrough).
        if (method == "GET" || method == "HEAD") && !path.contains("..") {
            let rel = path.trim_start_matches('/');
            if !rel.is_empty() {
                let candidate = webui_dir.join(rel);
                if candidate.is_file() {
                    return serve_file_or(candidate, StatusCode::NOT_FOUND).await;
                }
            }
        }

        // 2. SPA fallback for non-reserved GET/HEAD routes (public).
        if should_serve_spa_fallback(&method, &path) {
            return serve_file_or(webui_dir.join("index.html"), StatusCode::NOT_FOUND).await;
        }
    }

    // 3. Reserved-prefix miss / `..` / non-GET-HEAD: enforce bearer auth before
    //    revealing routability, matching the global TS middleware.
    let auth_header = request
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok());
    if !is_request_authorized(&ctx, &method, &path, auth_header) {
        return unauthorized_response();
    }

    StatusCode::NOT_FOUND.into_response()
}

/// Read and serve a file with a best-effort content-type, else `fallback`.
async fn serve_file_or(path: PathBuf, fallback: StatusCode) -> Response {
    match std::fs::read(&path) {
        Ok(bytes) => {
            let content_type = content_type_for(&path);
            (
                StatusCode::OK,
                [(header::CONTENT_TYPE, content_type)],
                bytes,
            )
                .into_response()
        }
        Err(_) => fallback.into_response(),
    }
}

/// Minimal extension -> content-type map for the bundled WebUI assets.
fn content_type_for(path: &std::path::Path) -> HeaderValue {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let ct = match ext.as_str() {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "map" => "application/json",
        "wasm" => "application/wasm",
        _ => "application/octet-stream",
    };
    HeaderValue::from_static(ct)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allowed_origins_tcp_variants() {
        let set = build_allowed_origins(&["https://app.example".into()], true, "0.0.0.0", 7767);
        assert!(set.contains("https://app.example"));
        assert!(set.contains("rocky://app"));
        assert!(set.contains("http://0.0.0.0:7767"));
        assert!(set.contains("http://localhost:7767"));
        assert!(set.contains("http://127.0.0.1:7767"));
    }

    #[test]
    fn allowed_origins_non_tcp_skips_localhost() {
        let set = build_allowed_origins(&[], false, "unix", 0);
        assert!(set.contains("rocky://app"));
        assert!(!set.contains("http://localhost:0"));
        assert_eq!(set.len(), 1);
    }
}
