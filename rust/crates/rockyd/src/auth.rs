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

/// Extract the value of a query-string parameter (`key=value`), application/
/// x-www-form-urlencoded style. Returns the first match, percent-decoding only
/// the minimal set that matters for tokens (`%XX` and `+`). Returns `None` when
/// the param is absent.
pub fn extract_query_param(query: Option<&str>, key: &str) -> Option<String> {
    let query = query?;
    for pair in query.split('&') {
        let Some((k, v)) = pair.split_once('=') else {
            continue;
        };
        if k == key {
            return Some(percent_decode_form(v));
        }
    }
    None
}

fn percent_decode_form(input: &str) -> String {
    let replaced = input.replace('+', " ");
    let bytes = replaced.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(h), Some(l)) = (hex_val(bytes[i + 1]), hex_val(bytes[i + 2])) {
                out.push((h << 4) | l);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn hex_val(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

/// Constant-time equality for the boot-scoped internal MCP token. Mirrors the
/// TS `timingSafeTokenEqual` used for `?rockyToken=` auth (`auth.ts`).
pub fn internal_mcp_token_matches(expected: Option<&str>, provided: Option<&str>) -> bool {
    let (Some(expected), Some(provided)) = (expected, provided) else {
        return false;
    };
    let a = expected.as_bytes();
    let b = provided.as_bytes();
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
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
    #[test]
    fn query_param_extraction() {
        assert_eq!(
            extract_query_param(Some("rockyToken=abc&callerAgentId=x"), "rockyToken").as_deref(),
            Some("abc")
        );
        assert_eq!(
            extract_query_param(Some("callerAgentId=x&rockyToken=abc"), "rockyToken").as_deref(),
            Some("abc")
        );
        assert_eq!(
            extract_query_param(Some("rockyToken=a%2Bb+c"), "rockyToken").as_deref(),
            Some("a+b c")
        );
        assert_eq!(extract_query_param(Some("foo=1"), "rockyToken"), None);
        assert_eq!(extract_query_param(None, "rockyToken"), None);
    }

    #[test]
    fn internal_token_constant_time_match() {
        assert!(internal_mcp_token_matches(Some("tok123"), Some("tok123")));
        assert!(!internal_mcp_token_matches(Some("tok123"), Some("tok124")));
        assert!(!internal_mcp_token_matches(Some("tok123"), Some("tok1234")));
        assert!(!internal_mcp_token_matches(None, Some("tok123")));
        assert!(!internal_mcp_token_matches(Some("tok123"), None));
        assert!(!internal_mcp_token_matches(None, None));
    }
}
