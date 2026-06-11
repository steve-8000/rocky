//! Minimal cwd resolution mirroring
//! `core/packages/server/src/server/path-utils.ts`.
//!
//! Only the pieces the create flow needs are ported: `expandUserPath`,
//! `resolvePathFromBase`, and the child-agent cwd policy from
//! `create-agent/create.ts` (`resolveChildAgentCwd`, lines 379-396).

use std::path::{Component, Path, PathBuf};

fn has_home_prefix(value: &str) -> bool {
    value == "~" || value.starts_with("~/")
}

fn home_dir() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/"))
}

/// Lexically normalize a path (resolve `.`/`..`) without touching the
/// filesystem — matches Node `path.resolve` semantics closely enough for cwd
/// strings. Absolute inputs keep their root; relative inputs are joined onto
/// the process cwd first.
fn normalize(path: &Path) -> String {
    let abs = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("/"))
            .join(path)
    };
    let mut out = PathBuf::new();
    for comp in abs.components() {
        match comp {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out.to_string_lossy().into_owned()
}

/// Port of `expandUserPath`: expand a leading `~`, then resolve to an absolute
/// normalized path.
pub fn expand_user_path(value: &str) -> String {
    let trimmed = value.trim();
    if has_home_prefix(trimmed) {
        let rest = trimmed.strip_prefix('~').unwrap_or("");
        let rest = rest.strip_prefix('/').unwrap_or(rest);
        return normalize(&home_dir().join(rest));
    }
    normalize(Path::new(trimmed))
}

/// Port of `resolvePathFromBase`: absolute / home-prefixed requests resolve
/// independently; relative requests resolve against `base_cwd`.
pub fn resolve_path_from_base(base_cwd: &str, requested: &str) -> String {
    let trimmed = requested.trim();
    if has_home_prefix(trimmed) || Path::new(trimmed).is_absolute() {
        return expand_user_path(trimmed);
    }
    normalize(&Path::new(base_cwd).join(trimmed))
}

/// Port of `resolveChildAgentCwd` (create.ts lines 379-396).
pub fn resolve_child_agent_cwd(
    parent_cwd: &str,
    requested_cwd: Option<&str>,
    locked_cwd: Option<&str>,
    allow_custom_cwd: bool,
) -> String {
    if let Some(locked) = locked_cwd.map(str::trim).filter(|s| !s.is_empty()) {
        return expand_user_path(locked);
    }
    let requested = requested_cwd.map(str::trim).filter(|s| !s.is_empty());
    match requested {
        Some(req) if allow_custom_cwd => resolve_path_from_base(parent_cwd, req),
        _ => parent_cwd.to_string(),
    }
}
