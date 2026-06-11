//! WebUI bundle resolution + SPA fallback, ported from
//! `core/packages/server/src/server/config.ts` (`resolveWebUiDir`) and
//! `bootstrap.ts:426-443` (static + reserved-prefix SPA fallback).

use std::path::{Path, PathBuf};

/// Env keys that explicitly point at a WebUI bundle, matching
/// `WEB_UI_ENV_KEYS` in `config.ts`.
pub const WEB_UI_ENV_KEYS: [&str; 2] = ["ROCKY_WEB_UI_DIR", "WEB_UI_DIST"];

/// Reserved route prefixes that must NOT receive the SPA fallback, matching
/// `bootstrap.ts:431`.
pub const RESERVED_PREFIXES: [&str; 5] = ["/api", "/public", "/mcp", "/ws", "/download"];

/// Error resolving an explicitly-configured WebUI bundle.
#[derive(Debug, thiserror::Error)]
#[error("Rocky WebUI bundle missing at {dir}. Run: npm run build:webui")]
pub struct WebUiBundleMissing {
    pub dir: String,
}

fn normalize_directory_path(value: &str) -> PathBuf {
    // `normalizeDirectoryPath`: expand `~`, then make absolute.
    let trimmed = value.trim();
    let expanded = if trimmed == "~" {
        std::env::var_os("HOME").map(PathBuf::from)
    } else if let Some(rest) = trimmed.strip_prefix("~/") {
        std::env::var_os("HOME").map(|h| PathBuf::from(h).join(rest))
    } else {
        None
    }
    .unwrap_or_else(|| PathBuf::from(trimmed));

    if expanded.is_absolute() {
        expanded
    } else {
        std::env::current_dir()
            .map(|cwd| cwd.join(&expanded))
            .unwrap_or(expanded)
    }
}

/// Resolve an explicitly-configured WebUI dir from the environment.
///
/// Mirrors `resolveExplicitWebUiDir`: the first set env key is normalized and
/// MUST contain `index.html`, else a hard error. Returns `Ok(None)` when no env
/// key is set.
pub fn resolve_explicit_web_ui_dir(
    env_lookup: impl Fn(&str) -> Option<String>,
) -> Result<Option<PathBuf>, WebUiBundleMissing> {
    for key in WEB_UI_ENV_KEYS {
        let Some(configured) = env_lookup(key) else {
            continue;
        };
        let configured = configured.trim();
        if configured.is_empty() {
            continue;
        }
        let web_ui_dir = normalize_directory_path(configured);
        if !web_ui_dir.join("index.html").exists() {
            return Err(WebUiBundleMissing {
                dir: web_ui_dir.display().to_string(),
            });
        }
        return Ok(Some(web_ui_dir));
    }
    Ok(None)
}

/// Resolve the bundled (dev) WebUI dir for the Rust binary.
///
/// The TS server resolves `app/dist` relative to its own module path; for the
/// Rust binary we walk up from `cwd` looking for `core/packages/app/dist`
/// (repo dev layout). Returns `None` when not found — the daemon then runs
/// API-only, matching `bootstrap.ts:428` (WebUI block is skipped when absent).
pub fn resolve_bundled_web_ui_dir(start: &Path) -> Option<PathBuf> {
    let mut current = Some(start);
    while let Some(dir) = current {
        let candidate = dir.join("core/packages/app/dist");
        if candidate.join("index.html").exists() {
            return Some(candidate);
        }
        current = dir.parent();
    }
    None
}

/// Resolve the effective WebUI dir: explicit env override (hard-fails if set
/// but missing) else the bundled dev candidate (soft-absent). Mirrors
/// `resolveWebUiDir`.
pub fn resolve_web_ui_dir(
    env_lookup: impl Fn(&str) -> Option<String>,
    bundled_start: &Path,
) -> Result<Option<PathBuf>, WebUiBundleMissing> {
    if let Some(explicit) = resolve_explicit_web_ui_dir(&env_lookup)? {
        return Ok(Some(explicit));
    }
    Ok(resolve_bundled_web_ui_dir(bundled_start))
}

/// Whether a request should receive the SPA `index.html` fallback.
///
/// Mirrors `bootstrap.ts:433-442`:
/// - only GET/HEAD,
/// - skip when the path equals a reserved prefix or starts with `<prefix>/`,
/// - skip when the path contains `..`,
/// - otherwise serve `index.html`.
pub fn should_serve_spa_fallback(method: &str, path: &str) -> bool {
    if method != "GET" && method != "HEAD" {
        return false;
    }
    for prefix in RESERVED_PREFIXES {
        if path == prefix || path.starts_with(&format!("{prefix}/")) {
            return false;
        }
    }
    if path.contains("..") {
        return false;
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reserved_prefixes_fall_through() {
        for p in ["/api/health", "/ws", "/public/x", "/mcp/y", "/download/z"] {
            assert!(!should_serve_spa_fallback("GET", p), "{p} should fall through");
        }
        // Exact prefix match also falls through.
        assert!(!should_serve_spa_fallback("GET", "/api"));
        assert!(!should_serve_spa_fallback("GET", "/ws"));
    }

    #[test]
    fn deep_route_serves_index() {
        assert!(should_serve_spa_fallback("GET", "/some/deep/route"));
        assert!(should_serve_spa_fallback("HEAD", "/"));
        // A path that merely shares a prefix word but not the boundary is served.
        assert!(should_serve_spa_fallback("GET", "/apiscope"));
    }

    #[test]
    fn dotdot_rejected() {
        assert!(!should_serve_spa_fallback("GET", "/../etc/passwd"));
        assert!(!should_serve_spa_fallback("GET", "/foo/../bar"));
    }

    #[test]
    fn non_get_skipped() {
        assert!(!should_serve_spa_fallback("POST", "/some/route"));
        assert!(!should_serve_spa_fallback("DELETE", "/x"));
    }

    #[test]
    fn explicit_missing_index_errors() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().to_path_buf();
        let err = resolve_explicit_web_ui_dir(|k| {
            if k == "ROCKY_WEB_UI_DIR" {
                Some(p.display().to_string())
            } else {
                None
            }
        })
        .unwrap_err();
        assert!(err.dir.contains(&p.display().to_string()));
    }

    #[test]
    fn explicit_present_index_resolves() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("index.html"), "<html>").unwrap();
        let p = dir.path().to_path_buf();
        let resolved = resolve_explicit_web_ui_dir(|k| {
            if k == "WEB_UI_DIST" {
                Some(p.display().to_string())
            } else {
                None
            }
        })
        .unwrap();
        assert!(resolved.is_some());
    }

    #[test]
    fn no_env_yields_none() {
        let resolved = resolve_explicit_web_ui_dir(|_| None).unwrap();
        assert!(resolved.is_none());
    }
}
