//! Port of the ACP tool-call snapshot -> `ToolCallDetail` mapper.
//!
//! Mirrors `acp-agent.ts`:
//! - `ACPToolSnapshot` (lines 336-345)
//! - `mergeToolSnapshot` (lines 2464-2479)
//! - `mapToolStatus` (lines 2528-2539)
//! - `mapToolDetail` + `build*ToolDetail` (lines 2551-2682)
//! - `extractToolText` / `extractDiffContent` (lines 2684-2707)
//! - `readString` / `readNumber` / `buildShellCommand` (lines 2791-2829)
//!
//! Terminal content (`extractTerminalContent`, lines 2709-2734) depends on the
//! client-side terminal registry; the Rust transport resolves terminal output
//! through the same `rawOutput`/content channels, so terminal-specific fields
//! fall back to `rawInput`/`rawOutput`/text content here.

use rocky_agent_domain::{ToolCallDetail, ToolCallStatus};
use serde::Deserialize;
use serde_json::Value;

/// Permissive snapshot of an ACP `tool_call` / `tool_call_update` payload.
/// Mirrors `ACPToolSnapshot` (`acp-agent.ts:336-345`).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpToolSnapshot {
    #[serde(default)]
    pub tool_call_id: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub kind: Option<String>,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub content: Option<Vec<Value>>,
    #[serde(default)]
    pub locations: Option<Vec<ToolLocation>>,
    #[serde(default)]
    pub raw_input: Option<Value>,
    #[serde(default)]
    pub raw_output: Option<Value>,
}

/// A `locations[]` entry (only `path` is consumed).
#[derive(Debug, Clone, Deserialize)]
pub struct ToolLocation {
    #[serde(default)]
    pub path: String,
}

impl AcpToolSnapshot {
    /// Merge an update over a previous snapshot, mirroring `mergeToolSnapshot`
    /// (`acp-agent.ts:2464-2479`): newer defined fields win, otherwise keep the
    /// previous value.
    pub fn merge(tool_call_id: &str, update: AcpToolSnapshot, previous: Option<&AcpToolSnapshot>) -> Self {
        let prev = previous.cloned().unwrap_or_default();
        AcpToolSnapshot {
            tool_call_id: tool_call_id.to_string(),
            title: update.title.or(prev.title),
            kind: update.kind.or(prev.kind),
            status: update.status.or(prev.status),
            content: update.content.or(prev.content),
            locations: update.locations.or(prev.locations),
            raw_input: update.raw_input.or(prev.raw_input),
            raw_output: update.raw_output.or(prev.raw_output),
        }
    }

    fn title_str(&self) -> String {
        self.title.clone().unwrap_or_else(|| self.tool_call_id.clone())
    }

    fn first_location(&self) -> Option<String> {
        self.locations
            .as_ref()
            .and_then(|locs| locs.first())
            .map(|loc| loc.path.clone())
    }
}

/// Map an ACP status string to the domain `ToolCallStatus`.
/// Mirrors `mapToolStatus` (`acp-agent.ts:2528-2539`).
pub fn map_tool_status(status: Option<&str>) -> ToolCallStatus {
    match status {
        Some("completed") => ToolCallStatus::Completed,
        Some("failed") => ToolCallStatus::Failed,
        // "pending", "in_progress", anything else => running.
        _ => ToolCallStatus::Running,
    }
}

/// Map a tool snapshot to a normalized `ToolCallDetail`.
/// Mirrors `mapToolDetail` (`acp-agent.ts:2551-2594`).
pub fn map_tool_detail(snapshot: &AcpToolSnapshot) -> ToolCallDetail {
    match snapshot.kind.as_deref() {
        Some("read") => build_read(snapshot),
        Some("edit") | Some("delete") => build_edit(snapshot),
        Some("search") => build_search(snapshot),
        Some("execute") => build_shell(snapshot),
        Some("fetch") => build_fetch(snapshot),
        Some("think") => ToolCallDetail::PlainText {
            label: snapshot.title.clone(),
            icon: Some("brain".to_string()),
            text: extract_tool_text(snapshot)
                .or_else(|| stringify_unknown(snapshot.raw_output.as_ref())),
        },
        Some("switch_mode") => ToolCallDetail::PlainText {
            label: snapshot.title.clone(),
            icon: Some("sparkles".to_string()),
            text: extract_tool_text(snapshot)
                .or_else(|| stringify_unknown(snapshot.raw_input.as_ref())),
        },
        _ => build_default(snapshot),
    }
}

/// `buildReadToolDetail` (`acp-agent.ts:2596-2605`).
fn build_read(s: &AcpToolSnapshot) -> ToolCallDetail {
    ToolCallDetail::Read {
        file_path: s
            .first_location()
            .or_else(|| read_string(s.raw_input.as_ref(), &["path", "filePath", "file"]))
            .unwrap_or_else(|| s.title_str()),
        content: extract_tool_text(s)
            .or_else(|| read_string(s.raw_output.as_ref(), &["content", "text"])),
        offset: read_number(s.raw_input.as_ref(), &["offset", "line"]),
        limit: read_number(s.raw_input.as_ref(), &["limit"]),
    }
}

/// `buildEditToolDetail` (`acp-agent.ts:2607-2619`).
fn build_edit(s: &AcpToolSnapshot) -> ToolCallDetail {
    let diff = extract_diff(s);
    let new_string = if s.kind.as_deref() == Some("delete") {
        Some(String::new())
    } else {
        diff.as_ref()
            .map(|d| d.new_text.clone())
            .or_else(|| read_string(s.raw_input.as_ref(), &["newText", "newString"]))
    };
    ToolCallDetail::Edit {
        file_path: s
            .first_location()
            .or_else(|| read_string(s.raw_input.as_ref(), &["path", "filePath", "file"]))
            .unwrap_or_else(|| s.title_str()),
        old_string: diff
            .as_ref()
            .and_then(|d| d.old_text.clone())
            .or_else(|| read_string(s.raw_input.as_ref(), &["oldText", "oldString"])),
        new_string,
        unified_diff: extract_tool_text(s),
    }
}

/// `buildSearchAcpToolDetail` (`acp-agent.ts:2621-2630`).
fn build_search(s: &AcpToolSnapshot) -> ToolCallDetail {
    ToolCallDetail::Search {
        query: read_string(s.raw_input.as_ref(), &["query", "pattern"]).unwrap_or_else(|| s.title_str()),
        tool_name: Some("search".to_string()),
        content: extract_tool_text(s)
            .or_else(|| read_string(s.raw_output.as_ref(), &["content", "text"])),
        file_paths: s
            .locations
            .as_ref()
            .map(|locs| locs.iter().map(|l| l.path.clone()).collect()),
        web_results: None,
        annotations: None,
        num_files: None,
        num_matches: None,
        duration_ms: None,
        duration_seconds: None,
        truncated: None,
        mode: None,
    }
}

/// `buildShellToolDetail` (`acp-agent.ts:2632-2645`).
fn build_shell(s: &AcpToolSnapshot) -> ToolCallDetail {
    ToolCallDetail::Shell {
        command: build_shell_command(s.raw_input.as_ref())
            .or_else(|| read_string(s.raw_input.as_ref(), &["command"]))
            .unwrap_or_else(|| s.title_str()),
        cwd: read_string(s.raw_input.as_ref(), &["cwd"]),
        output: extract_tool_text(s)
            .or_else(|| read_string(s.raw_output.as_ref(), &["output", "text"])),
        exit_code: read_number(s.raw_output.as_ref(), &["exitCode"]),
    }
}

/// `buildFetchToolDetail` (`acp-agent.ts:2647-2656`).
fn build_fetch(s: &AcpToolSnapshot) -> ToolCallDetail {
    ToolCallDetail::Fetch {
        url: read_string(s.raw_input.as_ref(), &["url"]).unwrap_or_else(|| s.title_str()),
        prompt: read_string(s.raw_input.as_ref(), &["prompt"]),
        result: extract_tool_text(s)
            .or_else(|| read_string(s.raw_output.as_ref(), &["result", "text", "content"])),
        code: read_number(s.raw_output.as_ref(), &["status", "code"]),
        code_text: None,
        bytes: None,
        duration_ms: None,
    }
}

/// `buildDefaultToolDetail` (`acp-agent.ts:2658-2682`).
fn build_default(s: &AcpToolSnapshot) -> ToolCallDetail {
    if let Some(text) = extract_tool_text(s) {
        return ToolCallDetail::PlainText {
            label: s.title.clone(),
            text: Some(text),
            icon: Some("wrench".to_string()),
        };
    }
    ToolCallDetail::Unknown {
        input: s.raw_input.clone().unwrap_or(Value::Null),
        output: s.raw_output.clone().unwrap_or(Value::Null),
    }
}

struct DiffContent {
    old_text: Option<String>,
    new_text: String,
}

/// `extractDiffContent` (`acp-agent.ts:2700-2707`).
fn extract_diff(s: &AcpToolSnapshot) -> Option<DiffContent> {
    let content = s.content.as_ref()?;
    let diff = content.iter().find(|item| {
        item.get("type").and_then(Value::as_str) == Some("diff")
    })?;
    Some(DiffContent {
        old_text: diff
            .get("oldText")
            .and_then(Value::as_str)
            .map(str::to_string),
        new_text: diff
            .get("newText")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
    })
}

/// `extractToolText` (`acp-agent.ts:2684-2698`): join the text of every
/// `{ type: "content" }` block.
fn extract_tool_text(s: &AcpToolSnapshot) -> Option<String> {
    let content = s.content.as_ref()?;
    let mut parts = Vec::new();
    for item in content {
        if item.get("type").and_then(Value::as_str) == Some("content") {
            if let Some(inner) = item.get("content") {
                if let Some(text) = content_block_to_text(inner) {
                    if !text.is_empty() {
                        parts.push(text);
                    }
                }
            }
        }
    }
    if parts.is_empty() {
        None
    } else {
        Some(parts.join("\n"))
    }
}

/// `contentBlockToText` (`acp-agent.ts:2435-2452`).
fn content_block_to_text(block: &Value) -> Option<String> {
    match block.get("type").and_then(Value::as_str) {
        Some("text") => block.get("text").and_then(Value::as_str).map(str::to_string),
        Some("resource_link") => Some(
            block
                .get("title")
                .and_then(Value::as_str)
                .or_else(|| block.get("uri").and_then(Value::as_str))
                .unwrap_or_default()
                .to_string(),
        ),
        Some("resource") => {
            let resource = block.get("resource");
            if let Some(text) = resource.and_then(|r| r.get("text")).and_then(Value::as_str) {
                Some(text.to_string())
            } else {
                let mime = resource
                    .and_then(|r| r.get("mimeType"))
                    .and_then(Value::as_str)
                    .unwrap_or("binary");
                Some(format!("[resource:{mime}]"))
            }
        }
        Some("image") => Some("[image]".to_string()),
        Some("audio") => Some("[audio]".to_string()),
        _ => Some(String::new()),
    }
}

/// `readString` (`acp-agent.ts:2791-2802`): first non-empty string at any key.
fn read_string(record: Option<&Value>, keys: &[&str]) -> Option<String> {
    let record = record?;
    for key in keys {
        if let Some(value) = record.get(key).and_then(Value::as_str) {
            if !value.trim().is_empty() {
                return Some(value.to_string());
            }
        }
    }
    None
}

/// `readNumber` (`acp-agent.ts:2804-2815`): first finite number at any key.
fn read_number(record: Option<&Value>, keys: &[&str]) -> Option<i64> {
    let record = record?;
    for key in keys {
        if let Some(n) = record.get(key).and_then(Value::as_i64) {
            return Some(n);
        }
        if let Some(f) = record.get(key).and_then(Value::as_f64) {
            if f.is_finite() {
                return Some(f as i64);
            }
        }
    }
    None
}

/// `buildShellCommand` (`acp-agent.ts:2817-2829`): `command` plus space-joined
/// string `args`.
fn build_shell_command(record: Option<&Value>) -> Option<String> {
    let record = record?;
    let command = read_string(Some(record), &["command"])?;
    let args: Vec<String> = record
        .get("args")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    if args.is_empty() {
        Some(command)
    } else {
        Some(format!("{command} {}", args.join(" ")))
    }
}

/// `stringifyUnknown` (`acp-agent.ts:2839-2851`).
fn stringify_unknown(value: Option<&Value>) -> Option<String> {
    let value = value?;
    if value.is_null() {
        return None;
    }
    if let Some(s) = value.as_str() {
        return Some(s.to_string());
    }
    serde_json::to_string(value).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn snapshot_from(update: Value) -> AcpToolSnapshot {
        serde_json::from_value(update).unwrap()
    }

    #[test]
    fn maps_shell_from_real_execute_frame() {
        // From the live amaze agent: session/update tool_call, kind=execute.
        let s = snapshot_from(json!({
            "toolCallId": "toolu_018wnvZbbkUqcryb356Qe91S",
            "title": "Running echo command",
            "kind": "execute",
            "status": "pending",
            "rawInput": { "command": "echo hello-rocky" },
            "content": [{ "type": "content", "content": { "type": "text", "text": "$ echo hello-rocky" } }]
        }));
        assert_eq!(map_tool_status(s.status.as_deref()), ToolCallStatus::Running);
        match map_tool_detail(&s) {
            ToolCallDetail::Shell { command, output, .. } => {
                assert_eq!(command, "echo hello-rocky");
                assert_eq!(output.as_deref(), Some("$ echo hello-rocky"));
            }
            other => panic!("expected shell, got {other:?}"),
        }
    }

    #[test]
    fn shell_command_joins_args() {
        let s = snapshot_from(json!({
            "toolCallId": "t1",
            "kind": "execute",
            "rawInput": { "command": "ls", "args": ["-la", "/tmp"] }
        }));
        match map_tool_detail(&s) {
            ToolCallDetail::Shell { command, .. } => assert_eq!(command, "ls -la /tmp"),
            other => panic!("expected shell, got {other:?}"),
        }
    }

    #[test]
    fn maps_read_with_location_and_ranges() {
        let s = snapshot_from(json!({
            "toolCallId": "t2",
            "kind": "read",
            "rawInput": { "offset": 10, "limit": 50 },
            "locations": [{ "path": "/repo/src/lib.rs" }],
            "content": [{ "type": "content", "content": { "type": "text", "text": "file body" } }]
        }));
        match map_tool_detail(&s) {
            ToolCallDetail::Read { file_path, content, offset, limit } => {
                assert_eq!(file_path, "/repo/src/lib.rs");
                assert_eq!(content.as_deref(), Some("file body"));
                assert_eq!(offset, Some(10));
                assert_eq!(limit, Some(50));
            }
            other => panic!("expected read, got {other:?}"),
        }
    }

    #[test]
    fn maps_edit_with_diff_content() {
        let s = snapshot_from(json!({
            "toolCallId": "t3",
            "kind": "edit",
            "locations": [{ "path": "/repo/a.txt" }],
            "content": [{ "type": "diff", "oldText": "old", "newText": "new" }]
        }));
        match map_tool_detail(&s) {
            ToolCallDetail::Edit { file_path, old_string, new_string, .. } => {
                assert_eq!(file_path, "/repo/a.txt");
                assert_eq!(old_string.as_deref(), Some("old"));
                assert_eq!(new_string.as_deref(), Some("new"));
            }
            other => panic!("expected edit, got {other:?}"),
        }
    }

    #[test]
    fn delete_kind_maps_to_edit_with_empty_new_string() {
        let s = snapshot_from(json!({
            "toolCallId": "t4",
            "kind": "delete",
            "locations": [{ "path": "/repo/gone.txt" }]
        }));
        match map_tool_detail(&s) {
            ToolCallDetail::Edit { new_string, .. } => {
                assert_eq!(new_string.as_deref(), Some(""));
            }
            other => panic!("expected edit, got {other:?}"),
        }
    }

    #[test]
    fn maps_search_with_locations() {
        let s = snapshot_from(json!({
            "toolCallId": "t5",
            "kind": "search",
            "rawInput": { "query": "needle" },
            "locations": [{ "path": "a.rs" }, { "path": "b.rs" }]
        }));
        match map_tool_detail(&s) {
            ToolCallDetail::Search { query, tool_name, file_paths, .. } => {
                assert_eq!(query, "needle");
                assert_eq!(tool_name.as_deref(), Some("search"));
                assert_eq!(file_paths, Some(vec!["a.rs".to_string(), "b.rs".to_string()]));
            }
            other => panic!("expected search, got {other:?}"),
        }
    }

    #[test]
    fn maps_fetch_with_status_code() {
        let s = snapshot_from(json!({
            "toolCallId": "t6",
            "kind": "fetch",
            "rawInput": { "url": "https://example.com", "prompt": "summarize" },
            "rawOutput": { "status": 200, "result": "body" }
        }));
        match map_tool_detail(&s) {
            ToolCallDetail::Fetch { url, prompt, result, code, .. } => {
                assert_eq!(url, "https://example.com");
                assert_eq!(prompt.as_deref(), Some("summarize"));
                assert_eq!(result.as_deref(), Some("body"));
                assert_eq!(code, Some(200));
            }
            other => panic!("expected fetch, got {other:?}"),
        }
    }

    #[test]
    fn unknown_kind_without_text_falls_back_to_unknown() {
        let s = snapshot_from(json!({
            "toolCallId": "t7",
            "kind": "mystery",
            "rawInput": { "foo": 1 },
            "rawOutput": { "bar": 2 }
        }));
        match map_tool_detail(&s) {
            ToolCallDetail::Unknown { input, output } => {
                assert_eq!(input, json!({ "foo": 1 }));
                assert_eq!(output, json!({ "bar": 2 }));
            }
            other => panic!("expected unknown, got {other:?}"),
        }
    }

    #[test]
    fn unknown_kind_with_text_becomes_plain_text() {
        let s = snapshot_from(json!({
            "toolCallId": "t8",
            "kind": "mystery",
            "title": "Mystery tool",
            "content": [{ "type": "content", "content": { "type": "text", "text": "hi" } }]
        }));
        match map_tool_detail(&s) {
            ToolCallDetail::PlainText { label, text, icon } => {
                assert_eq!(label.as_deref(), Some("Mystery tool"));
                assert_eq!(text.as_deref(), Some("hi"));
                assert_eq!(icon.as_deref(), Some("wrench"));
            }
            other => panic!("expected plain_text, got {other:?}"),
        }
    }

    #[test]
    fn merge_keeps_previous_fields_when_update_omits_them() {
        let prev = snapshot_from(json!({
            "toolCallId": "t9",
            "kind": "execute",
            "rawInput": { "command": "echo hi" },
            "status": "pending"
        }));
        let update = snapshot_from(json!({
            "toolCallId": "t9",
            "status": "completed",
            "rawOutput": { "exitCode": 0 }
        }));
        let merged = AcpToolSnapshot::merge("t9", update, Some(&prev));
        assert_eq!(merged.kind.as_deref(), Some("execute"));
        assert_eq!(merged.status.as_deref(), Some("completed"));
        match map_tool_detail(&merged) {
            ToolCallDetail::Shell { command, exit_code, .. } => {
                assert_eq!(command, "echo hi");
                assert_eq!(exit_code, Some(0));
            }
            other => panic!("expected shell, got {other:?}"),
        }
    }
}
