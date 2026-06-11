//! Daemon bearer authentication, ported from
//! `core/packages/server/src/server/auth.ts`.
//!
//! The daemon password is stored as a bcrypt hash. HTTP requests authenticate
//! with `Authorization: Bearer <token>`; WebSocket upgrades carry the token in
//! the `Sec-WebSocket-Protocol` header as `rocky.bearer.<token>`.

/// bcrypt cost for hashing `ROCKY_PASSWORD`, matching
/// `DAEMON_PASSWORD_BCRYPT_COST` in `auth.ts`.
pub const DAEMON_PASSWORD_BCRYPT_COST: u32 = 12;

/// Hash a plaintext password with bcrypt cost 12, matching
/// `hashDaemonPassword`. Used for the `ROCKY_PASSWORD` env path.
pub fn hash_daemon_password(password: &str) -> Result<String, bcrypt::BcryptError> {
    bcrypt::hash(password, DAEMON_PASSWORD_BCRYPT_COST)
}

/// Validate a bearer token against the configured bcrypt hash.
///
/// Mirrors `isBearerTokenValid`:
/// - no password configured => always valid (auth disabled).
/// - token `None` => invalid.
/// - else bcrypt compare(token, hash).
pub fn is_bearer_token_valid(password: Option<&str>, token: Option<&str>) -> bool {
    let Some(password) = password else {
        return true;
    };
    let Some(token) = token else {
        return false;
    };
    bcrypt::verify(token, password).unwrap_or(false)
}

/// Extract the bearer token from an `Authorization` header value.
///
/// Mirrors `extractHttpBearerToken`: requires exactly scheme `Bearer` plus a
/// single token separated by whitespace; otherwise `None`.
pub fn extract_http_bearer_token(value: Option<&str>) -> Option<String> {
    let value = value?;
    let parts: Vec<&str> = value.split_whitespace().collect();
    if parts.len() != 2 || parts[0] != "Bearer" {
        return None;
    }
    Some(parts[1].to_string())
}

/// Find the `rocky.bearer.<token>` protocol segment in a comma-separated
/// `Sec-WebSocket-Protocol` header value.
///
/// Mirrors `extractWsBearerProtocol`: returns the trimmed segment whose
/// dot-split begins with `["rocky", "bearer", ...]` (>= 3 segments).
pub fn extract_ws_bearer_protocol(value: Option<&str>) -> Option<String> {
    let value = value?;
    for protocol in value.split(',') {
        let trimmed = protocol.trim();
        let segments: Vec<&str> = trimmed.split('.').collect();
        if segments.len() >= 3 && segments[0] == "rocky" && segments[1] == "bearer" {
            return Some(trimmed.to_string());
        }
    }
    None
}

/// Extract the token from a `rocky.bearer.<token>` protocol segment.
///
/// Mirrors `extractWsBearerToken`: segments after `rocky.bearer.` joined by
/// '.' (so tokens containing dots round-trip).
pub fn extract_ws_bearer_token(protocol: Option<&str>) -> Option<String> {
    let protocol = protocol?;
    let segments: Vec<&str> = protocol.split('.').collect();
    if segments.len() < 3 || segments[0] != "rocky" || segments[1] != "bearer" {
        return None;
    }
    Some(segments[2..].join("."))
}

/// Whether bearer auth is bypassed for a request.
///
/// Mirrors `shouldBypassBearerAuth`: OPTIONS always bypasses (CORS preflight);
/// `/api/health` is public.
pub fn should_bypass_bearer_auth(method: &str, path: &str) -> bool {
    method == "OPTIONS" || path == "/api/health"
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hash() -> String {
        hash_daemon_password("hunter2").unwrap()
    }

    #[test]
    fn no_password_bypasses() {
        assert!(is_bearer_token_valid(None, None));
        assert!(is_bearer_token_valid(None, Some("anything")));
    }

    #[test]
    fn valid_token_passes_invalid_fails() {
        let h = hash();
        assert!(is_bearer_token_valid(Some(&h), Some("hunter2")));
        assert!(!is_bearer_token_valid(Some(&h), Some("wrong")));
        assert!(!is_bearer_token_valid(Some(&h), None));
    }

    #[test]
    fn http_bearer_extraction() {
        assert_eq!(
            extract_http_bearer_token(Some("Bearer abc123")).as_deref(),
            Some("abc123")
        );
        assert_eq!(extract_http_bearer_token(Some("Bearer")), None);
        assert_eq!(extract_http_bearer_token(Some("Bearer a b")), None);
        assert_eq!(extract_http_bearer_token(Some("Basic abc")), None);
        assert_eq!(extract_http_bearer_token(None), None);
    }

    #[test]
    fn ws_protocol_and_token_extraction() {
        let header = "json, rocky.bearer.tok.en.parts";
        let proto = extract_ws_bearer_protocol(Some(header));
        assert_eq!(proto.as_deref(), Some("rocky.bearer.tok.en.parts"));
        assert_eq!(
            extract_ws_bearer_token(proto.as_deref()).as_deref(),
            Some("tok.en.parts")
        );
        // No bearer segment present.
        assert_eq!(extract_ws_bearer_protocol(Some("json, foo.bar")), None);
        assert_eq!(extract_ws_bearer_token(None), None);
        // Malformed (too few segments).
        assert_eq!(extract_ws_bearer_token(Some("rocky.bearer")), None);
    }

    #[test]
    fn bypass_rules() {
        assert!(should_bypass_bearer_auth("OPTIONS", "/api/status"));
        assert!(should_bypass_bearer_auth("GET", "/api/health"));
        assert!(!should_bypass_bearer_auth("GET", "/api/status"));
        assert!(!should_bypass_bearer_auth("POST", "/public/x"));
    }
}
