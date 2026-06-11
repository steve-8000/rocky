//! Filesystem + config-read session RPC handlers, matching the file-explorer,
//! directory-suggestion, project-icon, file-download, and editor cases in
//! `core/packages/server/src/server/session.ts` (dispatch table lines
//! ~2017-2093) and the response payload shapes in
//! `core/packages/protocol/src/messages.ts`.
//!
//! These back onto direct filesystem reads (no daemon services). Paths are
//! sandboxed to the requested workspace `cwd` exactly like
//! `resolveScopedPath` in `core/packages/server/src/server/file-explorer/
//! service.ts` (lines 275-302): the resolved real path must stay within the
//! resolved real root, else `Access outside of workspace is not allowed`.
//!
//! ## Ownership note
//! `read_project_config_request` is owned by the `daemon_read` track and is NOT
//! registered here.
//!
//! Request -> response `type` strings handled here:
//! - `file_explorer_request` -> `file_explorer_response`
//! - `directory_suggestions_request` -> `directory_suggestions_response`
//! - `project_icon_request` -> `project_icon_response`
//! - `file_download_token_request` -> `file_download_token_response`
//! - `list_available_editors_request` -> `list_available_editors_response`
//! - `open_in_editor_request` -> `open_in_editor_response`

use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::UNIX_EPOCH;

use serde_json::{json, Value};
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;

use crate::dispatch::{SessionDispatcher, SessionRpcError};

const ACCESS_OUTSIDE_WORKSPACE_MESSAGE: &str = "Access outside of workspace is not allowed";
const MAX_ICON_SIZE: u64 = 32 * 1024;
const FILE_TYPE_SAMPLE_BYTES: usize = 8192;

/// Icon file names searched top-level, in priority order
/// (`ICON_PATTERNS`, project-icon.ts:8-23; the `icon-*.png` glob is matched by
/// prefix/suffix here).
const ICON_PATTERNS: &[&str] = &[
    "favicon.ico",
    "favicon.png",
    "favicon.svg",
    "favico.ico",
    "favico.png",
    "favico.svg",
    "icon.png",
    "icon.svg",
    "app-icon.png",
    "app-icon.svg",
    "apple-touch-icon.png",
    "logo.png",
    "logo.svg",
];

/// In-memory download-token store. The actual `/download` HTTP endpoint that
/// consumes these tokens lives at the transport layer; this only mints tokens
/// (`DownloadTokenStore.issueToken` in the TS daemon). Tokens are random
/// 32-hex-char strings keyed to an absolute path.
#[derive(Clone, Default)]
pub struct DownloadTokenStore {
    inner: Arc<Mutex<std::collections::HashMap<String, DownloadTokenEntry>>>,
}

/// A minted download token's resolved file facts.
#[derive(Clone)]
pub struct DownloadTokenEntry {
    pub absolute_path: String,
    pub path: String,
    pub file_name: String,
    pub mime_type: String,
    pub size: u64,
}

impl DownloadTokenStore {
    pub fn new() -> Self {
        Self::default()
    }

    /// Mint a token for `entry`, returning the opaque token string.
    pub fn issue_token(&self, entry: DownloadTokenEntry) -> String {
        let token = random_token();
        if let Ok(mut map) = self.inner.lock() {
            map.insert(token.clone(), entry);
        }
        token
    }

    /// Look up a previously-minted token (used by the download endpoint).
    pub fn lookup(&self, token: &str) -> Option<DownloadTokenEntry> {
        self.inner.lock().ok().and_then(|m| m.get(token).cloned())
    }
}

fn random_token() -> String {
    use rand::Rng;
    let mut bytes = [0u8; 16];
    rand::thread_rng().fill(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Shared services the file handlers need.
#[derive(Clone)]
pub struct FilesContext {
    /// `$ROCKY_HOME`; reserved for config-derived resolution.
    pub rocky_home: PathBuf,
    /// In-memory download-token store shared with the download endpoint.
    pub download_tokens: DownloadTokenStore,
}

impl FilesContext {
    /// Construct a context with a fresh in-memory token store.
    pub fn new(rocky_home: PathBuf) -> Self {
        Self {
            rocky_home,
            download_tokens: DownloadTokenStore::new(),
        }
    }
}

/// Register all filesystem/config-read handlers onto the dispatcher.
///
/// Does NOT register `read_project_config_request` (owned by `daemon_read`).
pub fn register(dispatcher: &mut SessionDispatcher, ctx: FilesContext) {
    macro_rules! reg {
        ($name:expr, $f:ident) => {{
            let ctx = ctx.clone();
            dispatcher.register(
                $name,
                Arc::new(move |msg: Value| {
                    let ctx = ctx.clone();
                    async move { $f(&ctx, msg).await }
                }),
            );
        }};
    }

    reg!("file_explorer_request", handle_file_explorer);
    reg!("directory_suggestions_request", handle_directory_suggestions);
    reg!("project_icon_request", handle_project_icon);
    reg!("file_download_token_request", handle_file_download_token);
    reg!("list_available_editors_request", handle_list_editors);
    reg!("open_in_editor_request", handle_open_in_editor);
}

// ---------------------------------------------------------------------------
// Parse / path helpers.
// ---------------------------------------------------------------------------

fn request_id(msg: &Value) -> String {
    msg.get("requestId")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

fn opt_str(msg: &Value, key: &str) -> Option<String> {
    msg.get(key).and_then(Value::as_str).map(|s| s.to_string())
}

/// Expand a leading `~`/`~/` to `$HOME` (`expandUserPath`).
fn expand_user_path(path: &str) -> String {
    if path == "~" {
        if let Ok(home) = std::env::var("HOME") {
            return home;
        }
        return path.to_string();
    }
    if let Some(rest) = path.strip_prefix("~/") {
        if let Ok(home) = std::env::var("HOME") {
            return format!("{home}/{rest}");
        }
    }
    path.to_string()
}

/// `mtime` of `meta` as an ISO-8601 millisecond string (`Date#toISOString`).
fn modified_iso(meta: &std::fs::Metadata) -> String {
    let st = meta.modified().unwrap_or(UNIX_EPOCH);
    match OffsetDateTime::from(st).format(&Rfc3339) {
        Ok(s) => trim_to_millis(&s),
        Err(_) => "1970-01-01T00:00:00.000Z".to_string(),
    }
}

/// Trim a fractional-seconds RFC3339 string to millisecond precision with a
/// trailing `Z`, matching `Date.prototype.toISOString` (mirrors the helper in
/// workspace.rs).
fn trim_to_millis(rfc3339: &str) -> String {
    let normalized = rfc3339.replace("+00:00", "Z");
    let Some((datetime, _tz)) = normalized.split_once('Z') else {
        return normalized;
    };
    if let Some((head, frac)) = datetime.split_once('.') {
        let mut millis: String = frac.chars().take(3).collect();
        while millis.len() < 3 {
            millis.push('0');
        }
        format!("{head}.{millis}Z")
    } else {
        format!("{datetime}.000Z")
    }
}

/// Resolved scoped path: the requested path (relative to root, possibly
/// non-existent) and the real resolved path.
struct ScopedPath {
    requested_rel: String,
    resolved: PathBuf,
}

/// Resolve `relative_path` against `root`, enforcing the workspace sandbox
/// exactly like `resolveScopedPath` (service.ts:275-302). Returns the relative
/// path (normalized, posix-ish) and the resolved real path. Errors with the
/// access-outside message on traversal escapes.
fn resolve_scoped_path(root: &str, relative_path: &str) -> Result<ScopedPath, String> {
    let normalized_root = expand_user_path(root);
    let root_path = PathBuf::from(&normalized_root);
    let requested = if relative_path.is_empty() || relative_path == "." {
        root_path.clone()
    } else {
        root_path.join(relative_path)
    };

    // Lexical containment check on the requested (pre-realpath) path.
    let rel = lexical_relative(&root_path, &requested);
    if let Some(rel) = &rel {
        if rel.starts_with("..") {
            return Err(ACCESS_OUTSIDE_WORKSPACE_MESSAGE.to_string());
        }
    } else {
        return Err(ACCESS_OUTSIDE_WORKSPACE_MESSAGE.to_string());
    }

    let real_root = std::fs::canonicalize(&root_path).map_err(|e| e.to_string())?;
    match std::fs::canonicalize(&requested) {
        Ok(real_path) => {
            let real_rel = lexical_relative(&real_root, &real_path);
            match &real_rel {
                Some(r) if !r.starts_with("..") => Ok(ScopedPath {
                    requested_rel: normalize_rel(root, &requested),
                    resolved: real_path,
                }),
                _ => Err(ACCESS_OUTSIDE_WORKSPACE_MESSAGE.to_string()),
            }
        }
        // Missing entry: fall back to the (contained) requested path.
        Err(_) => Ok(ScopedPath {
            requested_rel: normalize_rel(root, &requested),
            resolved: requested,
        }),
    }
}

/// Lexical relative path of `target` from `base` (no filesystem access),
/// resolving `.`/`..` segments. `None` when on different prefixes.
fn lexical_relative(base: &Path, target: &Path) -> Option<String> {
    let base = lexical_normalize(base);
    let target = lexical_normalize(target);
    let base_comps: Vec<_> = base.components().collect();
    let target_comps: Vec<_> = target.components().collect();
    let common = base_comps
        .iter()
        .zip(&target_comps)
        .take_while(|(a, b)| a == b)
        .count();
    if common == 0 && !base_comps.is_empty() {
        // Different roots/prefixes.
        if base_comps.first() != target_comps.first() {
            return None;
        }
    }
    let ups = base_comps.len().saturating_sub(common);
    let mut parts: Vec<String> = std::iter::repeat_n("..".to_string(), ups).collect();
    for comp in &target_comps[common.min(target_comps.len())..] {
        parts.push(comp.as_os_str().to_string_lossy().into_owned());
    }
    Some(parts.join("/"))
}

/// Resolve `.`/`..` lexically without touching the filesystem.
fn lexical_normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for comp in path.components() {
        match comp {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// Normalize the requested path to a root-relative posix-style string
/// (`normalizeRelativePath`); `.` for the root itself.
fn normalize_rel(root: &str, target: &Path) -> String {
    let root_path = PathBuf::from(expand_user_path(root));
    match lexical_relative(&root_path, target) {
        Some(rel) if rel.is_empty() => ".".to_string(),
        Some(rel) => rel,
        None => ".".to_string(),
    }
}

const IMAGE_MIME_TYPES: &[(&str, &str)] = &[
    ("png", "image/png"),
    ("jpg", "image/jpeg"),
    ("jpeg", "image/jpeg"),
    ("gif", "image/gif"),
    ("webp", "image/webp"),
    ("svg", "image/svg+xml"),
    ("ico", "image/x-icon"),
];

fn image_mime(ext: &str) -> Option<&'static str> {
    IMAGE_MIME_TYPES
        .iter()
        .find(|(e, _)| *e == ext)
        .map(|(_, m)| *m)
}

fn ext_lower(path: &Path) -> String {
    path.extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default()
}

/// `textMimeTypeForExtension` (service.ts:344-346): only `.json` is special.
fn text_mime_for_ext(ext: &str) -> &'static str {
    if ext == "json" {
        "application/json"
    } else {
        "text/plain"
    }
}

/// `isLikelyBinary` (service.ts:348-372): NUL byte => binary; otherwise >30%
/// suspicious control bytes => binary.
fn is_likely_binary(bytes: &[u8]) -> bool {
    if bytes.is_empty() {
        return false;
    }
    let mut suspicious = 0usize;
    for &byte in bytes {
        if byte == 0 {
            return true;
        }
        let is_control = byte < 32 && byte != 9 && byte != 10 && byte != 13;
        if is_control || byte == 127 {
            suspicious += 1;
        }
    }
    (suspicious as f64) / (bytes.len() as f64) > 0.3
}

// ---------------------------------------------------------------------------
// file_explorer_request.
// ---------------------------------------------------------------------------

/// `file_explorer_request` -> `file_explorer_response`
/// (session.ts:5712-5820; messages.ts:3434-3445). `mode: "list"` lists a
/// directory's entries; `mode: "file"` reads a single file (text/image/binary).
async fn handle_file_explorer(ctx: &FilesContext, msg: Value) -> Result<Value, SessionRpcError> {
    let _ = ctx;
    let req_id = request_id(&msg);
    let workspace_cwd = opt_str(&msg, "cwd").unwrap_or_default();
    let requested_path = opt_str(&msg, "path").unwrap_or_else(|| ".".to_string());
    let mode = opt_str(&msg, "mode").unwrap_or_else(|| "list".to_string());
    let cwd = workspace_cwd.trim().to_string();

    if cwd.is_empty() {
        return Ok(file_explorer_error(
            &workspace_cwd,
            &requested_path,
            &mode,
            &req_id,
            "cwd is required",
        ));
    }

    let result = if mode == "file" {
        read_explorer_file(&cwd, &requested_path)
            .map(|file| (Value::Null, file, normalize_rel(&cwd, &PathBuf::from(&cwd))))
    } else {
        list_directory(&cwd, &requested_path)
            .map(|(dir, path)| (dir, Value::Null, path))
    };

    match result {
        Ok((directory, file, path)) => Ok(json!({ "type": "file_explorer_response", "payload": {
            "cwd": cwd, "path": path, "mode": mode,
            "directory": directory, "file": file,
            "error": Value::Null, "requestId": req_id } })),
        Err(message) => Ok(file_explorer_error(
            &cwd,
            &requested_path,
            &mode,
            &req_id,
            &message,
        )),
    }
}

fn file_explorer_error(cwd: &str, path: &str, mode: &str, req_id: &str, message: &str) -> Value {
    json!({ "type": "file_explorer_response", "payload": {
        "cwd": cwd, "path": path, "mode": mode,
        "directory": Value::Null, "file": Value::Null,
        "error": message, "requestId": req_id } })
}

/// List a directory's entries (`listDirectoryEntries`, service.ts:89-137):
/// entries sorted by mtime desc then name; returns `(directory, normalizedPath)`.
fn list_directory(root: &str, relative_path: &str) -> Result<(Value, String), String> {
    let scoped = resolve_scoped_path(root, relative_path)?;
    let meta = std::fs::metadata(&scoped.resolved).map_err(|e| e.to_string())?;
    if !meta.is_dir() {
        return Err("Requested path is not a directory".to_string());
    }
    let read_dir = std::fs::read_dir(&scoped.resolved).map_err(|e| e.to_string())?;
    let mut entries: Vec<(String, Value)> = Vec::new();
    for dirent in read_dir.flatten() {
        let name = dirent.file_name().to_string_lossy().into_owned();
        let target_rel = if scoped.requested_rel == "." {
            name.clone()
        } else {
            format!("{}/{}", scoped.requested_rel, name)
        };
        // buildEntryPayload re-scopes the entry; dangling links are skipped.
        let entry_scoped = match resolve_scoped_path(root, &target_rel) {
            Ok(s) => s,
            Err(_) => continue,
        };
        let entry_meta = match std::fs::metadata(&entry_scoped.resolved) {
            Ok(m) => m,
            Err(_) => continue, // missing/dangling entry: skip.
        };
        let kind = if entry_meta.is_dir() {
            "directory"
        } else {
            "file"
        };
        let modified = modified_iso(&entry_meta);
        entries.push((
            modified.clone(),
            json!({
                "name": name,
                "path": entry_scoped.requested_rel,
                "kind": kind,
                "size": entry_meta.len(),
                "modifiedAt": modified,
            }),
        ));
    }
    // Sort by modifiedAt desc, then by name asc.
    entries.sort_by(|a, b| {
        b.0.cmp(&a.0).then_with(|| {
            a.1["name"]
                .as_str()
                .unwrap_or("")
                .cmp(b.1["name"].as_str().unwrap_or(""))
        })
    });
    let entry_values: Vec<Value> = entries.into_iter().map(|(_, v)| v).collect();
    let path = normalize_rel(root, &scoped.resolved);
    Ok((
        json!({ "path": path.clone(), "entries": entry_values }),
        path,
    ))
}

/// Read a single file (`readExplorerFile`, service.ts:139-177): text => utf-8
/// content; image => base64 content; binary => no content.
fn read_explorer_file(root: &str, relative_path: &str) -> Result<Value, String> {
    let scoped = resolve_scoped_path(root, relative_path)?;
    let meta = std::fs::metadata(&scoped.resolved).map_err(|e| e.to_string())?;
    if !meta.is_file() {
        return Err("Requested path is not a file".to_string());
    }
    let bytes = std::fs::read(&scoped.resolved).map_err(|e| e.to_string())?;
    let ext = ext_lower(&scoped.resolved);
    let path = scoped.requested_rel.clone();
    let size = meta.len();
    let modified = modified_iso(&meta);

    if let Some(mime) = image_mime(&ext) {
        // Any IMAGE_MIME extension (including svg) is returned base64-encoded.
        return Ok(json!({
            "path": path, "kind": "image", "encoding": "base64",
            "content": base64_encode(&bytes), "mimeType": mime,
            "size": size, "modifiedAt": modified,
        }));
    }

    if is_likely_binary(&bytes) {
        return Ok(json!({
            "path": path, "kind": "binary", "encoding": "none",
            "mimeType": "application/octet-stream",
            "size": size, "modifiedAt": modified,
        }));
    }

    Ok(json!({
        "path": path, "kind": "text", "encoding": "utf-8",
        "content": String::from_utf8_lossy(&bytes),
        "mimeType": text_mime_for_ext(&ext),
        "size": size, "modifiedAt": modified,
    }))
}

/// Minimal standard base64 encoder (no external dep), matching
/// `Buffer.toString("base64")`.
fn base64_encode(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as usize;
        let b1 = chunk.get(1).copied().unwrap_or(0) as usize;
        let b2 = chunk.get(2).copied().unwrap_or(0) as usize;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(ALPHABET[(n >> 18) & 63] as char);
        out.push(ALPHABET[(n >> 12) & 63] as char);
        if chunk.len() > 1 {
            out.push(ALPHABET[(n >> 6) & 63] as char);
        } else {
            out.push('=');
        }
        if chunk.len() > 2 {
            out.push(ALPHABET[n & 63] as char);
        } else {
            out.push('=');
        }
    }
    out
}

// ---------------------------------------------------------------------------
// directory_suggestions_request.
// ---------------------------------------------------------------------------

/// `directory_suggestions_request` -> `directory_suggestions_response`
/// (session.ts:4723-4767; messages.ts:3379-3395). Suggests immediate child
/// directories (and optionally files) of `cwd` whose names match `query`.
async fn handle_directory_suggestions(
    ctx: &FilesContext,
    msg: Value,
) -> Result<Value, SessionRpcError> {
    let _ = ctx;
    let req_id = request_id(&msg);
    let query = opt_str(&msg, "query").unwrap_or_default();
    let cwd = opt_str(&msg, "cwd").map(|c| c.trim().to_string());
    let include_files = msg
        .get("includeFiles")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let include_directories = msg
        .get("includeDirectories")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    // `normalizeLimit`: default 30, clamped to [1, 100].
    let limit = msg
        .get("limit")
        .and_then(Value::as_u64)
        .map(|n| n as usize)
        .unwrap_or(30)
        .clamp(1, 100);
    // `matchMode`: "fuzzy" (default) | "suffix"; only meaningful with a cwd.
    let match_mode = match opt_str(&msg, "matchMode").as_deref() {
        Some("suffix") => MatchMode::Suffix,
        _ => MatchMode::Fuzzy,
    };

    // The home-tree BFS does heavy synchronous filesystem I/O (up to 20k dirs),
    // so run it on a blocking thread to avoid stalling the async executor.
    let query = query.clone();
    let result = tokio::task::spawn_blocking(move || {
        suggest_entries(
            cwd.as_deref(),
            &query,
            include_files,
            include_directories,
            limit,
            match_mode,
        )
    })
    .await
    .unwrap_or_else(|e| Err(format!("directory suggestion task failed: {e}")));

    match result {
        Ok(entries) => {
            let directories: Vec<Value> = entries
                .iter()
                .filter(|e| e["kind"] == "directory")
                .map(|e| e["path"].clone())
                .collect();
            Ok(json!({ "type": "directory_suggestions_response", "payload": {
                "directories": directories, "entries": entries,
                "error": Value::Null, "requestId": req_id } }))
        }
        Err(message) => Ok(json!({ "type": "directory_suggestions_response", "payload": {
            "directories": Value::Array(vec![]), "entries": Value::Array(vec![]),
            "error": message, "requestId": req_id } })),
    }
}

/// Directory-suggestion match mode (`WorkspaceMatchMode`, directory-suggestions.ts:31).
#[derive(Clone, Copy, PartialEq, Eq)]
enum MatchMode {
    Fuzzy,
    Suffix,
}

const SUGGEST_MAX_DEPTH: usize = 12;
const SUGGEST_MAX_SCANNED: usize = 20_000;
const NO_SEGMENT_INDEX: usize = usize::MAX;
const NO_MATCH_OFFSET: usize = usize::MAX;
const NO_FUZZY_SCORE: i64 = i64::MAX;
const NO_WORKSPACE_MATCH_TIER: u8 = 5;
/// Directory names skipped by the workspace search (directory-suggestions.ts:81-90).
const WORKSPACE_IGNORED_DIRECTORY_NAMES: &[&str] = &[
    "node_modules",
    "dist",
    "build",
    "target",
    "out",
    "coverage",
    "vendor",
    "__pycache__",
];

/// A directory/file suggestion ranked for sort order. Lower tuple sorts first
/// (matches `compareRanked*` in directory-suggestions.ts).
struct RankedEntry {
    path: String,
    kind: &'static str,
    match_tier: u8,
    segment_index: usize,
    match_offset: usize,
    fuzzy_score: i64,
    depth: usize,
}

/// Parsed query split into a parent path component and a trailing search term
/// (`QueryParts`, directory-suggestions.ts:40-44).
struct QueryParts {
    is_path_query: bool,
    parent_part: String,
    search_term: String,
}

/// `directory_suggestions` search. With a workspace `cwd` this scans inside that
/// root (file-explorer suggestions); without one it scans under `$HOME` (the
/// project-picker "new workspace" folder search). Mirrors session.ts:4728-4743.
fn suggest_entries(
    cwd: Option<&str>,
    query: &str,
    include_files: bool,
    include_directories: bool,
    limit: usize,
    match_mode: MatchMode,
) -> Result<Vec<Value>, String> {
    match cwd {
        Some(c) if !c.is_empty() => {
            search_workspace_entries(c, query, include_files, include_directories, limit, match_mode)
        }
        _ => {
            let home = std::env::var("HOME").map_err(|_| "HOME is not set".to_string())?;
            let dirs = search_home_directories(&home, query, limit);
            Ok(dirs
                .into_iter()
                .map(|p| json!({ "path": p, "kind": "directory" }))
                .collect())
        }
    }
}

/// `searchHomeDirectories` (directory-suggestions.ts:92-127). Returns absolute
/// directory paths under `$HOME`. Empty/invalid query => empty (NOT a full
/// listing). Path-style queries (rooted with `~`, `/`, or `./`) browse within
/// the parent directory; bare terms search recursively across the home tree.
fn search_home_directories(home_dir: &str, query: &str, limit: usize) -> Vec<String> {
    if query.trim().is_empty() {
        return Vec::new();
    }
    let Some(home_root) = resolve_directory(Path::new(home_dir)) else {
        return Vec::new();
    };
    let Some(parts) = normalize_query_parts(query, &home_root, true) else {
        return Vec::new();
    };

    let ranked = if parts.is_path_query {
        let parent_path = lexical_join(&home_root, if parts.parent_part.is_empty() { "." } else { &parts.parent_part });
        let Some(parent_root) = resolve_directory(&parent_path) else {
            return Vec::new();
        };
        if !is_path_inside_root(&home_root, &parent_root) {
            return Vec::new();
        }
        let needle = parts.search_term.to_lowercase();
        list_child_directories(&parent_root, &home_root)
            .into_iter()
            .filter(|abs| {
                needle.is_empty()
                    || file_name_lower(abs).contains(&needle)
            })
            .map(|abs| rank_entry(&abs, &home_root, "directory", &needle, false))
            .collect::<Vec<_>>()
    } else {
        search_across_tree(
            &home_root,
            &parts.search_term,
            true,
            false,
            MatchMode::Fuzzy,
            false,
        )
    };

    dedupe_and_sort(ranked)
        .into_iter()
        .map(|e| e.path)
        .take(limit)
        .collect()
}

/// `searchWorkspaceEntries` (directory-suggestions.ts:139-185). Scans within a
/// workspace root, honoring include flags and match mode.
fn search_workspace_entries(
    cwd: &str,
    query: &str,
    include_files: bool,
    include_directories: bool,
    limit: usize,
    match_mode: MatchMode,
) -> Result<Vec<Value>, String> {
    if !include_directories && !include_files {
        return Ok(Vec::new());
    }
    let expanded = expand_user_path(cwd);
    let Some(ws_root) = resolve_directory(Path::new(&expanded)) else {
        return Ok(Vec::new());
    };
    let Some(parts) = normalize_query_parts(query, &ws_root, false) else {
        return Ok(Vec::new());
    };

    let ranked = if parts.is_path_query && match_mode != MatchMode::Suffix {
        let parent_path = lexical_join(&ws_root, if parts.parent_part.is_empty() { "." } else { &parts.parent_part });
        let Some(parent_root) = resolve_directory(&parent_path) else {
            return Ok(Vec::new());
        };
        if !is_path_inside_root(&ws_root, &parent_root) {
            return Ok(Vec::new());
        }
        let needle = parts.search_term.to_lowercase();
        list_workspace_child_entries(&parent_root, &ws_root)
            .into_iter()
            .filter(|(_, kind)| {
                (*kind == "directory" && include_directories) || (*kind == "file" && include_files)
            })
            .filter_map(|(abs, kind)| {
                let entry = rank_entry(&abs, &ws_root, kind, &needle, true);
                if !needle.is_empty() && entry.match_tier == NO_WORKSPACE_MATCH_TIER {
                    None
                } else {
                    Some(entry)
                }
            })
            .collect::<Vec<_>>()
    } else {
        let search_term = if match_mode == MatchMode::Suffix {
            [parts.parent_part.as_str(), parts.search_term.as_str()]
                .into_iter()
                .filter(|s| !s.is_empty())
                .collect::<Vec<_>>()
                .join("/")
        } else {
            parts.search_term.clone()
        };
        search_across_tree(
            &ws_root,
            &search_term,
            include_directories,
            include_files,
            match_mode,
            true,
        )
    };

    Ok(dedupe_and_sort(ranked)
        .into_iter()
        .take(limit)
        .map(|e| json!({ "path": e.path, "kind": e.kind }))
        .collect())
}

/// BFS across a root tree (`searchAcrossHomeTree` / `searchWorkspaceAcrossTree`,
/// directory-suggestions.ts:232-288 / 334-418). `workspace` selects ignored-dir
/// filtering, file inclusion, and relative-vs-absolute output paths.
fn search_across_tree(
    root: &Path,
    search_term: &str,
    include_directories: bool,
    include_files: bool,
    match_mode: MatchMode,
    workspace: bool,
) -> Vec<RankedEntry> {
    let needle = search_term.to_lowercase();
    let mut queue: Vec<(PathBuf, usize)> = vec![(root.to_path_buf(), 0)];
    let mut visited: std::collections::HashSet<PathBuf> =
        std::collections::HashSet::from([root.to_path_buf()]);
    let mut ranked: Vec<RankedEntry> = Vec::new();
    let mut scanned = 0usize;
    let mut qi = 0usize;

    while qi < queue.len() && scanned < SUGGEST_MAX_SCANNED {
        let (dir, depth) = queue[qi].clone();
        qi += 1;
        let entries: Vec<(PathBuf, &'static str)> = if workspace {
            list_workspace_child_entries(&dir, root)
        } else {
            list_child_directories(&dir, root)
                .into_iter()
                .map(|p| (p, "directory"))
                .collect()
        };

        for (abs, kind) in entries {
            scanned += 1;
            if kind == "directory"
                && !visited.contains(&abs)
                && depth < SUGGEST_MAX_DEPTH
                && scanned < SUGGEST_MAX_SCANNED
            {
                visited.insert(abs.clone());
                queue.push((abs.clone(), depth + 1));
            }
            if kind == "directory" && !include_directories {
                continue;
            }
            if kind == "file" && !include_files {
                continue;
            }
            if match_mode == MatchMode::Suffix
                && !workspace_entry_matches_suffix(&abs, root, search_term)
            {
                continue;
            }
            let relative_lower = normalize_relative_path(root, &abs).to_lowercase();
            // Non-suffix home BFS only keeps entries whose relative path or name
            // contains the needle (directory-suggestions.ts:268-271).
            if match_mode != MatchMode::Suffix
                && !needle.is_empty()
                && !relative_lower.contains(&needle)
                && !file_name_lower(&abs).contains(&needle)
            {
                continue;
            }
            let entry = rank_entry(&abs, root, kind, &needle, workspace);
            if match_mode != MatchMode::Suffix
                && !needle.is_empty()
                && workspace
                && entry.match_tier == NO_WORKSPACE_MATCH_TIER
            {
                continue;
            }
            ranked.push(entry);
        }
    }
    ranked
}

/// `workspaceEntryMatchesSuffixQuery` (directory-suggestions.ts:420-446).
fn workspace_entry_matches_suffix(abs: &Path, root: &Path, query: &str) -> bool {
    let query_segments: Vec<String> = query
        .trim()
        .replace('\\', "/")
        .trim_start_matches("./")
        .split('/')
        .filter(|s| !s.is_empty())
        .map(str::to_lowercase)
        .collect();
    if query_segments.is_empty() {
        return false;
    }
    let path_segments: Vec<String> = normalize_relative_path(root, abs)
        .split('/')
        .filter(|s| !s.is_empty())
        .map(str::to_lowercase)
        .collect();
    if query_segments.len() > path_segments.len() {
        return false;
    }
    let offset = path_segments.len() - query_segments.len();
    query_segments
        .iter()
        .enumerate()
        .all(|(i, seg)| path_segments[offset + i] == *seg)
}

/// `rankDirectory` / `rankWorkspaceEntry` (directory-suggestions.ts:523-635).
/// Output `path` is the relative path for workspace entries, absolute for home.
fn rank_entry(
    abs: &Path,
    root: &Path,
    kind: &'static str,
    search_lower: &str,
    workspace: bool,
) -> RankedEntry {
    let relative = normalize_relative_path(root, abs);
    let relative_lower = relative.to_lowercase();
    let depth = if relative == "." {
        0
    } else {
        relative.split('/').count()
    };
    let path = if workspace {
        relative.clone()
    } else {
        abs.to_string_lossy().into_owned()
    };
    let no_match_tier = if workspace { NO_WORKSPACE_MATCH_TIER } else { 4 };
    if search_lower.is_empty() {
        return RankedEntry {
            path,
            kind,
            match_tier: 3,
            segment_index: NO_SEGMENT_INDEX,
            match_offset: 0,
            fuzzy_score: NO_FUZZY_SCORE,
            depth,
        };
    }
    let segments: Vec<&str> = if relative_lower == "." {
        Vec::new()
    } else {
        relative_lower.split('/').collect()
    };
    let exact = segment_match_index(&segments, |s| s == search_lower);
    let prefix = segment_match_index(&segments, |s| s.starts_with(search_lower));
    let partial = segment_match_index(&segments, |s| s.contains(search_lower));
    let match_offset = relative_lower.find(search_lower);
    let basename = segments.last().copied().unwrap_or("");
    let fuzzy = score_fuzzy_subsequence(search_lower, basename);

    let mut match_tier = no_match_tier;
    let mut segment_index = NO_SEGMENT_INDEX;
    if let Some(i) = exact {
        match_tier = 0;
        segment_index = i;
    } else if let Some(i) = prefix {
        match_tier = 1;
        segment_index = i;
    } else if let Some(i) = partial {
        match_tier = 2;
        segment_index = i;
    } else if relative_lower.starts_with(search_lower) {
        match_tier = 3;
    } else if workspace && fuzzy.is_some() {
        match_tier = 4;
    }

    RankedEntry {
        path,
        kind,
        match_tier,
        segment_index,
        match_offset: match_offset.unwrap_or(NO_MATCH_OFFSET),
        fuzzy_score: fuzzy.unwrap_or(NO_FUZZY_SCORE),
        depth,
    }
}

/// `scoreFuzzySubsequence` (directory-suggestions.ts:637-671). `None` when the
/// query is not a subsequence of the candidate.
fn score_fuzzy_subsequence(query: &str, candidate: &str) -> Option<i64> {
    if query.is_empty() {
        return Some(0);
    }
    let q: Vec<char> = query.chars().collect();
    let c: Vec<char> = candidate.chars().collect();
    let mut qi = 0usize;
    let mut first_match: i64 = -1;
    let mut prev_match: i64 = -1;
    let mut gap_score: i64 = 0;
    let mut ci = 0usize;
    while ci < c.len() && qi < q.len() {
        if c[ci] == q[qi] {
            if first_match == -1 {
                first_match = ci as i64;
            }
            if prev_match >= 0 {
                gap_score += ci as i64 - prev_match - 1;
            }
            prev_match = ci as i64;
            qi += 1;
        }
        ci += 1;
    }
    if qi != q.len() || first_match == -1 {
        return None;
    }
    Some(first_match + gap_score)
}

fn segment_match_index(segments: &[&str], predicate: impl Fn(&str) -> bool) -> Option<usize> {
    segments
        .iter()
        .position(|s| !s.is_empty() && predicate(s))
}

/// `dedupeAndSort*` (directory-suggestions.ts:448-521). Keeps the best-ranked
/// entry per (kind,path) and sorts by the tuple ordering.
fn dedupe_and_sort(ranked: Vec<RankedEntry>) -> Vec<RankedEntry> {
    use std::collections::HashMap;
    let mut best: HashMap<String, RankedEntry> = HashMap::new();
    for entry in ranked {
        let key = format!("{}:{}", entry.kind, entry.path);
        match best.get(&key) {
            Some(existing) if compare_ranked(&entry, existing) >= 0 => {}
            _ => {
                best.insert(key, entry);
            }
        }
    }
    let mut out: Vec<RankedEntry> = best.into_values().collect();
    out.sort_by(|a, b| match compare_ranked(a, b) {
        n if n < 0 => std::cmp::Ordering::Less,
        n if n > 0 => std::cmp::Ordering::Greater,
        _ => std::cmp::Ordering::Equal,
    });
    out
}

/// Tuple comparison shared by both ranking variants
/// (`compareRankedDirectories` / `compareRankedWorkspaceEntries`).
fn compare_ranked(left: &RankedEntry, right: &RankedEntry) -> i32 {
    if left.match_tier != right.match_tier {
        return left.match_tier as i32 - right.match_tier as i32;
    }
    if left.segment_index != right.segment_index {
        return if left.segment_index < right.segment_index { -1 } else { 1 };
    }
    if left.match_offset != right.match_offset {
        return if left.match_offset < right.match_offset { -1 } else { 1 };
    }
    if left.fuzzy_score != right.fuzzy_score {
        return if left.fuzzy_score < right.fuzzy_score { -1 } else { 1 };
    }
    if left.depth != right.depth {
        return if left.depth < right.depth { -1 } else { 1 };
    }
    if left.kind != right.kind {
        return if left.kind == "directory" { -1 } else { 1 };
    }
    left.path.cmp(&right.path) as i32
}

/// Directories directly under `$HOME` that the home-tree folder search skips.
/// These are macOS TCC-protected (`Desktop`/`Documents`/`Downloads`) — a
/// launchd-spawned daemon without Full Disk Access blocks indefinitely (at 0%
/// CPU) on `read_dir`/`canonicalize` of them — plus large system trees that are
/// never project roots. Skipping them keeps the project-picker search fast and
/// deadlock-free regardless of the daemon's TCC grants.
const HOME_ROOT_IGNORED_DIRECTORY_NAMES: &[&str] = &[
    "Desktop",
    "Documents",
    "Downloads",
    "Library",
    "Movies",
    "Music",
    "Pictures",
    "Public",
    "Applications",
];

/// List immediate child directories (and dir symlinks) of `dir`, skipping
/// hidden names; absolute paths kept inside `root` (`listChildDirectories`).
fn list_child_directories(dir: &Path, root: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let Ok(rd) = std::fs::read_dir(dir) else {
        return out;
    };
    // Only the home root itself carries the TCC/heavy-dir skip list; nested
    // directories with these names (e.g. a project's own `Documents/`) are fine.
    let at_home_root = dir == root;
    for d in rd.flatten() {
        let name = d.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue;
        }
        if at_home_root && HOME_ROOT_IGNORED_DIRECTORY_NAMES.contains(&name.as_str()) {
            continue;
        }
        let Ok(ft) = d.file_type() else { continue };
        let candidate = dir.join(&name);
        if ft.is_dir() {
            let resolved = lexical_normalize(&candidate);
            if is_path_inside_root(root, &resolved) {
                out.push(resolved);
            }
        } else if ft.is_symlink() {
            if let Some(resolved) = resolve_directory(&candidate) {
                if is_path_inside_root(root, &resolved) {
                    out.push(resolved);
                }
            }
        }
    }
    out
}

/// List immediate child dirs/files of `dir`, skipping hidden + ignored names
/// (`listWorkspaceChildEntries`).
fn list_workspace_child_entries(dir: &Path, root: &Path) -> Vec<(PathBuf, &'static str)> {
    let mut out = Vec::new();
    let Ok(rd) = std::fs::read_dir(dir) else {
        return out;
    };
    for d in rd.flatten() {
        let name = d.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') || WORKSPACE_IGNORED_DIRECTORY_NAMES.contains(&name.as_str()) {
            continue;
        }
        let Ok(ft) = d.file_type() else { continue };
        let candidate = dir.join(&name);
        if ft.is_dir() {
            let resolved = lexical_normalize(&candidate);
            if is_path_inside_root(root, &resolved) {
                out.push((resolved, "directory"));
            }
        } else if ft.is_file() {
            let resolved = lexical_normalize(&candidate);
            if is_path_inside_root(root, &resolved) {
                out.push((resolved, "file"));
            }
        } else if ft.is_symlink() {
            if let Ok(resolved) = std::fs::canonicalize(&candidate) {
                if is_path_inside_root(root, &resolved) {
                    if resolved.is_dir() {
                        out.push((resolved, "directory"));
                    } else if resolved.is_file() {
                        out.push((resolved, "file"));
                    }
                }
            }
        }
    }
    out
}

/// `normalizeQueryParts` / `normalizeWorkspaceQueryParts`
/// (directory-suggestions.ts:702-797). `require_root` distinguishes the home
/// variant (only `~`/`/`/`./`-rooted queries are treated as paths) from the
/// workspace variant (any slash makes it a path query).
fn normalize_query_parts(query: &str, root: &Path, require_root: bool) -> Option<QueryParts> {
    let typed = query.trim().replace('\\', "/");
    let mut normalized = typed.clone();
    if normalized.is_empty() {
        // Home variant: empty query is already filtered upstream; treat as None.
        // Workspace variant: empty query browses the root (parent="", term="").
        if require_root {
            return None;
        }
        return Some(QueryParts {
            is_path_query: true,
            parent_part: String::new(),
            search_term: String::new(),
        });
    }
    let mut is_rooted = false;
    if let Some(rest) = normalized.strip_prefix('~') {
        is_rooted = true;
        normalized = rest.strip_prefix('/').unwrap_or(rest).to_string();
    }
    if Path::new(&normalized).is_absolute() {
        is_rooted = true;
        let absolute = lexical_normalize(Path::new(&normalized));
        if !is_path_inside_root(root, &absolute) {
            return None;
        }
        normalized = normalize_relative_path(root, &absolute);
    }
    if normalized.starts_with("./") {
        is_rooted = true;
    }
    normalized = collapse_slashes(normalized.trim_start_matches("./"));
    if normalized.is_empty() {
        if require_root {
            if typed == "~" || typed == "~/" {
                return Some(QueryParts {
                    is_path_query: true,
                    parent_part: String::new(),
                    search_term: String::new(),
                });
            }
            return None;
        }
        return Some(QueryParts {
            is_path_query: true,
            parent_part: String::new(),
            search_term: String::new(),
        });
    }

    let is_path_query = if require_root {
        is_rooted && normalized.contains('/')
    } else {
        normalized.contains('/')
    };
    if !is_path_query {
        return Some(QueryParts {
            is_path_query: false,
            parent_part: String::new(),
            search_term: normalized,
        });
    }
    let slash = normalized.rfind('/').unwrap();
    Some(QueryParts {
        is_path_query: true,
        parent_part: normalized[..slash].to_string(),
        search_term: normalized[slash + 1..].to_string(),
    })
}

/// Collapse runs of `/` into a single separator (matches `replace(/\/{2,}/g, "/")`).
fn collapse_slashes(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut prev_slash = false;
    for ch in s.chars() {
        if ch == '/' {
            if !prev_slash {
                out.push(ch);
            }
            prev_slash = true;
        } else {
            out.push(ch);
            prev_slash = false;
        }
    }
    out
}

/// Lexically join `rel` onto `base` and normalize.
fn lexical_join(base: &Path, rel: &str) -> PathBuf {
    lexical_normalize(&base.join(rel))
}

/// `resolveDirectory` (directory-suggestions.ts:799-810): realpath + must be dir.
fn resolve_directory(p: &Path) -> Option<PathBuf> {
    let resolved = std::fs::canonicalize(p).ok()?;
    if resolved.is_dir() {
        Some(resolved)
    } else {
        None
    }
}

/// `isPathInsideRoot` (directory-suggestions.ts:697-700).
fn is_path_inside_root(root: &Path, target: &Path) -> bool {
    target == root || target.starts_with(root)
}

/// `normalizeRelativePath` (directory-suggestions.ts:689-695): `/`-joined
/// relative path, or `.` when equal to root.
fn normalize_relative_path(root: &Path, abs: &Path) -> String {
    match abs.strip_prefix(root) {
        Ok(rel) if rel.as_os_str().is_empty() => ".".to_string(),
        Ok(rel) => rel
            .components()
            .map(|c| c.as_os_str().to_string_lossy().into_owned())
            .collect::<Vec<_>>()
            .join("/"),
        Err(_) => abs.to_string_lossy().into_owned(),
    }
}

fn file_name_lower(p: &Path) -> String {
    p.file_name()
        .map(|n| n.to_string_lossy().to_lowercase())
        .unwrap_or_default()
}

// ---------------------------------------------------------------------------
// project_icon_request.
// ---------------------------------------------------------------------------

/// `project_icon_request` -> `project_icon_response`
/// (session.ts:5825-5852; messages.ts:3447-3460). Reads a top-level icon file if
/// present (`{data, mimeType}` base64), else `icon: null`. Square-image
/// validation (which the TS handler does via image-header parsing) is not
/// computed here; a present, small icon is returned as-is.
async fn handle_project_icon(ctx: &FilesContext, msg: Value) -> Result<Value, SessionRpcError> {
    let _ = ctx;
    let req_id = request_id(&msg);
    let cwd = opt_str(&msg, "cwd").unwrap_or_default();

    let icon = match find_and_read_icon(&cwd) {
        Ok(icon) => icon,
        Err(message) => {
            return Ok(json!({ "type": "project_icon_response", "payload": {
                "cwd": cwd, "icon": Value::Null, "error": message, "requestId": req_id } }));
        }
    };
    Ok(json!({ "type": "project_icon_response", "payload": {
        "cwd": cwd, "icon": icon, "error": Value::Null, "requestId": req_id } }))
}

fn find_and_read_icon(cwd: &str) -> Result<Value, String> {
    if cwd.trim().is_empty() {
        return Ok(Value::Null);
    }
    let dir = PathBuf::from(expand_user_path(cwd));
    // Exact-name patterns first, then any `icon-*.png`.
    let mut candidate: Option<PathBuf> = None;
    for pattern in ICON_PATTERNS {
        let p = dir.join(pattern);
        if p.is_file() {
            candidate = Some(p);
            break;
        }
    }
    if candidate.is_none() {
        if let Ok(read_dir) = std::fs::read_dir(&dir) {
            for dirent in read_dir.flatten() {
                let name = dirent.file_name().to_string_lossy().into_owned();
                if name.starts_with("icon-") && name.ends_with(".png") {
                    candidate = Some(dir.join(name));
                    break;
                }
            }
        }
    }
    let Some(icon_path) = candidate else {
        return Ok(Value::Null);
    };
    let meta = std::fs::metadata(&icon_path).map_err(|e| e.to_string())?;
    if meta.len() > MAX_ICON_SIZE {
        return Ok(Value::Null);
    }
    let bytes = std::fs::read(&icon_path).map_err(|e| e.to_string())?;
    let ext = ext_lower(&icon_path);
    let mime = image_mime(&ext).unwrap_or("application/octet-stream");
    Ok(json!({ "data": base64_encode(&bytes), "mimeType": mime }))
}

// ---------------------------------------------------------------------------
// file_download_token_request.
// ---------------------------------------------------------------------------

/// `file_download_token_request` -> `file_download_token_response`
/// (session.ts:5857-5928; messages.ts:3462-3474). Resolves the file, mints an
/// in-memory token, and returns it; the `/download` endpoint consumes it.
async fn handle_file_download_token(
    ctx: &FilesContext,
    msg: Value,
) -> Result<Value, SessionRpcError> {
    let req_id = request_id(&msg);
    let workspace_cwd = opt_str(&msg, "cwd").unwrap_or_default();
    let requested_path = opt_str(&msg, "path").unwrap_or_default();
    let cwd = workspace_cwd.trim().to_string();

    if cwd.is_empty() {
        return Ok(download_token_error(
            &workspace_cwd,
            &requested_path,
            &req_id,
            "cwd is required",
        ));
    }

    match downloadable_file_info(&cwd, &requested_path) {
        Ok((rel_path, absolute_path, file_name, mime_type, size)) => {
            let token = ctx.download_tokens.issue_token(DownloadTokenEntry {
                absolute_path,
                path: rel_path.clone(),
                file_name: file_name.clone(),
                mime_type: mime_type.clone(),
                size,
            });
            Ok(json!({ "type": "file_download_token_response", "payload": {
                "cwd": cwd, "path": rel_path, "token": token,
                "fileName": file_name, "mimeType": mime_type, "size": size,
                "error": Value::Null, "requestId": req_id } }))
        }
        Err(message) => Ok(download_token_error(
            &cwd,
            &requested_path,
            &req_id,
            &message,
        )),
    }
}

fn download_token_error(cwd: &str, path: &str, req_id: &str, message: &str) -> Value {
    json!({ "type": "file_download_token_response", "payload": {
        "cwd": cwd, "path": path, "token": Value::Null,
        "fileName": Value::Null, "mimeType": Value::Null, "size": Value::Null,
        "error": message, "requestId": req_id } })
}

/// `getDownloadableFileInfo` (service.ts:233-273): resolve a scoped file and
/// classify its mime type from a leading sample.
fn downloadable_file_info(
    root: &str,
    relative_path: &str,
) -> Result<(String, String, String, String, u64), String> {
    let scoped = resolve_scoped_path(root, relative_path)?;
    let meta = std::fs::metadata(&scoped.resolved).map_err(|e| e.to_string())?;
    if !meta.is_file() {
        return Err("Requested path is not a file".to_string());
    }
    let ext = ext_lower(&scoped.resolved);
    let mime_type = if let Some(mime) = image_mime(&ext) {
        mime.to_string()
    } else {
        let bytes = std::fs::read(&scoped.resolved).map_err(|e| e.to_string())?;
        let sample = &bytes[..bytes.len().min(FILE_TYPE_SAMPLE_BYTES)];
        if is_likely_binary(sample) {
            "application/octet-stream".to_string()
        } else {
            text_mime_for_ext(&ext).to_string()
        }
    };
    let file_name = scoped
        .resolved
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let absolute_path = scoped.resolved.to_string_lossy().into_owned();
    Ok((
        scoped.requested_rel,
        absolute_path,
        file_name,
        mime_type,
        meta.len(),
    ))
}

// ---------------------------------------------------------------------------
// Editor detection / open.
// ---------------------------------------------------------------------------

/// Known editor launchers, by id, with a human label and the CLI binary to
/// detect on PATH.
const KNOWN_EDITORS: &[(&str, &str, &str)] = &[
    ("vscode", "Visual Studio Code", "code"),
    ("cursor", "Cursor", "cursor"),
    ("windsurf", "Windsurf", "windsurf"),
    ("zed", "Zed", "zed"),
];

/// `list_available_editors_request` -> `list_available_editors_response`
/// (messages.ts:2625-2637). Detects installed editor CLIs on PATH (best-effort;
/// an empty list is acceptable).
async fn handle_list_editors(ctx: &FilesContext, msg: Value) -> Result<Value, SessionRpcError> {
    let _ = ctx;
    let req_id = request_id(&msg);
    let editors: Vec<Value> = KNOWN_EDITORS
        .iter()
        .filter(|(_, _, bin)| binary_on_path(bin).is_some())
        .map(|(id, label, _)| json!({ "id": id, "label": label }))
        .collect();
    Ok(json!({ "type": "list_available_editors_response", "payload": {
        "requestId": req_id, "editors": editors, "error": Value::Null } }))
}

/// `open_in_editor_request` -> `open_in_editor_response`
/// (messages.ts:2639-2645). Spawns the requested editor CLI against the path, or
/// returns a structured error when the editor is unknown / not installed.
async fn handle_open_in_editor(ctx: &FilesContext, msg: Value) -> Result<Value, SessionRpcError> {
    let _ = ctx;
    let req_id = request_id(&msg);
    let editor_id = opt_str(&msg, "editorId").unwrap_or_default();
    let target = opt_str(&msg, "path").unwrap_or_default();

    let error = open_in_editor(&editor_id, &target);
    Ok(json!({ "type": "open_in_editor_response", "payload": {
        "requestId": req_id, "error": error } }))
}

/// Returns `Value::Null` on success, or a string error.
fn open_in_editor(editor_id: &str, target: &str) -> Value {
    if target.trim().is_empty() {
        return Value::String("path is required".to_string());
    }
    let Some((_, _, bin)) = KNOWN_EDITORS.iter().find(|(id, _, _)| *id == editor_id) else {
        return Value::String(format!("Unknown editor: {editor_id}"));
    };
    let Some(bin_path) = binary_on_path(bin) else {
        return Value::String(format!("Editor '{editor_id}' is not installed"));
    };
    let expanded = expand_user_path(target);
    match std::process::Command::new(bin_path).arg(&expanded).spawn() {
        Ok(_) => Value::Null,
        Err(e) => Value::String(format!("Failed to launch editor: {e}")),
    }
}

/// Resolve a binary name against `$PATH`, returning its absolute path.
fn binary_on_path(bin: &str) -> Option<PathBuf> {
    let path_var = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path_var) {
        let candidate = dir.join(bin);
        if is_executable_file(&candidate) {
            return Some(candidate);
        }
    }
    None
}

fn is_executable_file(path: &Path) -> bool {
    let Ok(meta) = std::fs::metadata(path) else {
        return false;
    };
    if !meta.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        meta.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}