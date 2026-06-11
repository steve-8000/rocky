//! In-crate integration tests for the Phase 2 HTTP router. Exercises the full
//! middleware stack via `tower::ServiceExt::oneshot` against a fresh router.

use std::collections::HashSet;
use std::sync::Arc;

use axum::body::Body;
use axum::http::{header, Request, StatusCode};
use tower::ServiceExt;

use crate::auth::hash_daemon_password;
use crate::http::{build_router, ServerContext};

fn base_ctx() -> ServerContext {
    ServerContext {
        server_id: "srv_test".into(),
        hostname: "testhost".into(),
        version: serde_json::Value::String("0.1.0".into()),
        listen: "127.0.0.1:7767".into(),
        is_tcp: true,
        password: None,
        allowed_origins: HashSet::new(),
        hostnames: None,
        webui_dir: None,
        public_dir: std::path::PathBuf::from("/nonexistent-public"),
        session_dispatcher: None,
        agent_manager: None,
    }
}

async fn body_string(resp: axum::response::Response) -> String {
    let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
        .await
        .unwrap();
    String::from_utf8(bytes.to_vec()).unwrap()
}

#[tokio::test]
async fn health_is_public_200() {
    let app = build_router(Arc::new(base_ctx()));
    let resp = app
        .oneshot(
            Request::builder()
                .uri("/api/health")
                .header(header::HOST, "localhost:7767")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let body = body_string(resp).await;
    assert!(body.contains("\"status\":\"ok\""), "{body}");
}

#[tokio::test]
async fn status_requires_auth_when_password_set() {
    let mut ctx = base_ctx();
    ctx.password = Some(hash_daemon_password("secret").unwrap());
    let app = build_router(Arc::new(ctx));

    // No bearer -> 401.
    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/status")
                .header(header::HOST, "localhost:7767")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    let body = body_string(resp).await;
    assert!(body.contains("\"error\":\"Unauthorized\""), "{body}");
}

#[tokio::test]
async fn status_passes_with_valid_bearer() {
    let mut ctx = base_ctx();
    ctx.password = Some(hash_daemon_password("secret").unwrap());
    let app = build_router(Arc::new(ctx));

    let resp = app
        .oneshot(
            Request::builder()
                .uri("/api/status")
                .header(header::HOST, "localhost:7767")
                .header(header::AUTHORIZATION, "Bearer secret")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let body = body_string(resp).await;
    assert!(body.contains("\"status\":\"server_info\""), "{body}");
    assert!(body.contains("\"serverId\":\"srv_test\""), "{body}");
    assert!(body.contains("\"listen\":\"127.0.0.1:7767\""), "{body}");
}

#[tokio::test]
async fn invalid_host_header_403_for_tcp() {
    let app = build_router(Arc::new(base_ctx()));
    let resp = app
        .oneshot(
            Request::builder()
                .uri("/api/health")
                .header(header::HOST, "evil.com")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::FORBIDDEN);
    let body = body_string(resp).await;
    assert!(body.contains("Invalid Host header"), "{body}");
}

#[tokio::test]
async fn unix_listener_skips_host_validation() {
    let mut ctx = base_ctx();
    ctx.is_tcp = false;
    let app = build_router(Arc::new(ctx));
    let resp = app
        .oneshot(
            Request::builder()
                .uri("/api/health")
                .header(header::HOST, "evil.com")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
}

#[tokio::test]
async fn spa_index_served_for_deep_route() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("index.html"), "<!doctype html><title>rocky</title>").unwrap();
    let mut ctx = base_ctx();
    ctx.webui_dir = Some(dir.path().to_path_buf());
    let app = build_router(Arc::new(ctx));

    let resp = app
        .oneshot(
            Request::builder()
                .uri("/some/deep/route")
                .header(header::HOST, "localhost:7767")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let body = body_string(resp).await;
    assert!(body.contains("<!doctype html>"), "{body}");
}

#[tokio::test]
async fn root_returns_index_with_webui() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("index.html"), "INDEX").unwrap();
    let mut ctx = base_ctx();
    ctx.webui_dir = Some(dir.path().to_path_buf());
    let app = build_router(Arc::new(ctx));

    let resp = app
        .oneshot(
            Request::builder()
                .uri("/")
                .header(header::HOST, "localhost:7767")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    assert_eq!(body_string(resp).await, "INDEX");
}

#[tokio::test]
async fn reserved_prefix_not_spa_fallback() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("index.html"), "INDEX").unwrap();
    let mut ctx = base_ctx();
    ctx.webui_dir = Some(dir.path().to_path_buf());
    let app = build_router(Arc::new(ctx));

    // /download/x is reserved -> must NOT return index.html (404, no handler).
    let resp = app
        .oneshot(
            Request::builder()
                .uri("/download/x")
                .header(header::HOST, "localhost:7767")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn cors_preflight_options_204_with_headers() {
    let mut ctx = base_ctx();
    ctx.allowed_origins.insert("http://localhost:7767".into());
    let app = build_router(Arc::new(ctx));

    let resp = app
        .oneshot(
            Request::builder()
                .method("OPTIONS")
                .uri("/api/status")
                .header(header::HOST, "localhost:7767")
                .header(header::ORIGIN, "http://localhost:7767")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::NO_CONTENT);
    let acao = resp
        .headers()
        .get(header::ACCESS_CONTROL_ALLOW_ORIGIN)
        .and_then(|v| v.to_str().ok());
    assert_eq!(acao, Some("http://localhost:7767"));
    assert_eq!(
        resp.headers()
            .get(header::ACCESS_CONTROL_ALLOW_CREDENTIALS)
            .and_then(|v| v.to_str().ok()),
        Some("true")
    );
}

#[tokio::test]
async fn public_static_after_auth() {
    // Password set: /public requires auth (served AFTER bearer middleware).
    let public = tempfile::tempdir().unwrap();
    std::fs::write(public.path().join("file.txt"), "PUBLIC").unwrap();
    let mut ctx = base_ctx();
    ctx.password = Some(hash_daemon_password("secret").unwrap());
    ctx.public_dir = public.path().to_path_buf();
    let app = build_router(Arc::new(ctx));

    // Without auth -> 401.
    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/public/file.txt")
                .header(header::HOST, "localhost:7767")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);

    // With auth -> 200 + contents.
    let resp = app
        .oneshot(
            Request::builder()
                .uri("/public/file.txt")
                .header(header::HOST, "localhost:7767")
                .header(header::AUTHORIZATION, "Bearer secret")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    assert_eq!(body_string(resp).await, "PUBLIC");
}

#[tokio::test]
async fn reserved_prefix_miss_401_when_unauthenticated() {
    // Password set, no bearer: /download/x is reserved (no SPA) and unrouted.
    // The fallback must enforce bearer auth -> 401, not leak a 404.
    let mut ctx = base_ctx();
    ctx.password = Some(hash_daemon_password("secret").unwrap());
    let app = build_router(Arc::new(ctx));

    let resp = app
        .oneshot(
            Request::builder()
                .uri("/download/x")
                .header(header::HOST, "localhost:7767")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    let body = body_string(resp).await;
    assert!(body.contains("\"error\":\"Unauthorized\""), "{body}");
}

#[tokio::test]
async fn mcp_prefix_miss_401_when_unauthenticated() {
    let mut ctx = base_ctx();
    ctx.password = Some(hash_daemon_password("secret").unwrap());
    let app = build_router(Arc::new(ctx));

    let resp = app
        .oneshot(
            Request::builder()
                .uri("/mcp/y")
                .header(header::HOST, "localhost:7767")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn reserved_prefix_miss_404_when_authorized() {
    // Valid bearer: auth passes, so the fallback reveals the real 404.
    let mut ctx = base_ctx();
    ctx.password = Some(hash_daemon_password("secret").unwrap());
    let app = build_router(Arc::new(ctx));

    let resp = app
        .oneshot(
            Request::builder()
                .uri("/download/x")
                .header(header::HOST, "localhost:7767")
                .header(header::AUTHORIZATION, "Bearer secret")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn reserved_prefix_miss_404_when_no_password() {
    // No password configured: auth disabled, fallback returns 404 directly.
    let app = build_router(Arc::new(base_ctx()));

    let resp = app
        .oneshot(
            Request::builder()
                .uri("/download/x")
                .header(header::HOST, "localhost:7767")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn health_public_even_when_password_set() {
    let mut ctx = base_ctx();
    ctx.password = Some(hash_daemon_password("secret").unwrap());
    let app = build_router(Arc::new(ctx));

    let resp = app
        .oneshot(
            Request::builder()
                .uri("/api/health")
                .header(header::HOST, "localhost:7767")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
}

#[tokio::test]
async fn root_index_public_when_password_set() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("index.html"), "INDEX").unwrap();
    let mut ctx = base_ctx();
    ctx.password = Some(hash_daemon_password("secret").unwrap());
    ctx.webui_dir = Some(dir.path().to_path_buf());
    let app = build_router(Arc::new(ctx));

    let resp = app
        .oneshot(
            Request::builder()
                .uri("/")
                .header(header::HOST, "localhost:7767")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    assert_eq!(body_string(resp).await, "INDEX");
}

#[tokio::test]
async fn static_asset_public_when_password_set() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir(dir.path().join("assets")).unwrap();
    std::fs::write(dir.path().join("assets/app.js"), "ASSET").unwrap();
    std::fs::write(dir.path().join("index.html"), "INDEX").unwrap();
    let mut ctx = base_ctx();
    ctx.password = Some(hash_daemon_password("secret").unwrap());
    ctx.webui_dir = Some(dir.path().to_path_buf());
    let app = build_router(Arc::new(ctx));

    let resp = app
        .oneshot(
            Request::builder()
                .uri("/assets/app.js")
                .header(header::HOST, "localhost:7767")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    assert_eq!(body_string(resp).await, "ASSET");
}
