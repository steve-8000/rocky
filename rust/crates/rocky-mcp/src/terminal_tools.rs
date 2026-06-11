//! Terminal MCP tools: `list_terminals`, `create_terminal`, `kill_terminal`,
//! `capture_terminal`, and `send_terminal_keys`.
//!
//! Mirrors `core/packages/server/src/server/agent/mcp-server.ts`:
//! - `list_terminals` (lines 1621-1667) — list terminals for a cwd or all.
//! - `create_terminal` (lines 1669-1702) — spawn a terminal for a cwd.
//! - `kill_terminal` (lines 1704-1733) — kill an existing terminal.
//! - `capture_terminal` (lines 1735-1777) — capture plain-text output lines.
//! - `send_terminal_keys` (lines 1779-1813) — send literal/special key tokens.
//!
//! The key-token mapping mirrors `resolveTerminalKeyToken` (mcp-server.ts:469-500).
//!
//! All five delegate to the shared [`rocky_terminal::TerminalManager`] wired into
//! the MCP context. When the manager is not configured, every tool returns a
//! `not_wired` error matching the TS guard (`"Terminal manager is not configured"`).

use rocky_terminal::{CreateTerminalOptions, TerminalError};
use serde_json::{json, Value};

use crate::protocol::{tool_result, ToolDescriptor, ToolError, ToolRegistry};
use crate::tools::{as_object, boxed, object_schema, opt_bool, opt_str, req_str};

/// Map a [`TerminalError`] into the tool execution error envelope.
fn terminal_err(e: TerminalError) -> ToolError {
    ToolError::execution("terminal_error", e.to_string())
}

/// Standard not-wired error when the terminal manager is absent.
fn not_wired() -> ToolError {
    ToolError::not_wired("Terminal manager is not configured")
}

/// Register all terminal tools on `registry`.
pub fn register(registry: &mut ToolRegistry) {
    register_list_terminals(registry);
    register_create_terminal(registry);
    register_kill_terminal(registry);
    register_capture_terminal(registry);
    register_send_terminal_keys(registry);
}

/// `list_terminals` (mcp-server.ts:1621-1667). The Rust `TerminalManager` has no
/// per-directory index, so this lists everything and filters by `cwd` in-process.
/// Scoping is permissive: when `all` is true, or no cwd can be resolved (neither
/// the `cwd` arg nor the caller agent's cwd), all terminals are returned rather
/// than erroring — matching the orchestration-friendly intent of the TS tool.
fn register_list_terminals(registry: &mut ToolRegistry) {
    registry.register(
        ToolDescriptor {
            name: "list_terminals".into(),
            title: "List terminals".into(),
            description:
                "List terminals for a working directory or across all working directories.".into(),
            input_schema: object_schema(&[], &[("cwd", "string"), ("all", "boolean")]),
        },
        boxed(|args, ctx| async move {
            let map = as_object(&args)?;
            let services = ctx.services();
            let Some(manager) = services.terminal_manager.as_ref() else {
                return Err(not_wired());
            };

            let all = opt_bool(map, "all")?.unwrap_or(false);
            let cwd_arg = opt_str(map, "cwd")?
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty());

            let resolved_cwd = match cwd_arg {
                Some(cwd) => Some(cwd),
                None => match ctx.caller_agent_id() {
                    Some(id) => ctx.agent_manager().get(id).await.map(|a| a.cwd),
                    None => None,
                },
            };

            let terminals = manager.list();
            let filtered: Vec<Value> = terminals
                .into_iter()
                .filter(|t| match (all, &resolved_cwd) {
                    (true, _) => true,
                    (false, Some(cwd)) => t.cwd.as_deref() == Some(cwd.as_str()),
                    (false, None) => true,
                })
                .map(|t| json!({ "id": t.id, "name": t.name, "cwd": t.cwd }))
                .collect();

            Ok(tool_result(json!({ "terminals": filtered })))
        }),
    );
}

/// `create_terminal` (mcp-server.ts:1669-1702). Resolves the cwd from the `cwd`
/// arg (trimmed) or the caller agent's cwd, erroring when neither is available.
/// `create` returns only id+slot, so the post-create `list()` lookup recovers the
/// manager-assigned name and cwd for the response.
fn register_create_terminal(registry: &mut ToolRegistry) {
    registry.register(
        ToolDescriptor {
            name: "create_terminal".into(),
            title: "Create terminal".into(),
            description: "Create a terminal session for a working directory.".into(),
            input_schema: object_schema(&[], &[("cwd", "string"), ("name", "string")]),
        },
        boxed(|args, ctx| async move {
            let map = as_object(&args)?;
            let services = ctx.services();
            let Some(manager) = services.terminal_manager.as_ref() else {
                return Err(not_wired());
            };

            let cwd_arg = opt_str(map, "cwd")?
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty());
            let resolved_cwd = match cwd_arg {
                Some(cwd) => Some(cwd),
                None => match ctx.caller_agent_id() {
                    Some(id) => ctx.agent_manager().get(id).await.map(|a| a.cwd),
                    None => None,
                },
            };
            let Some(resolved_cwd) = resolved_cwd else {
                return Err(ToolError::invalid_params("cwd is required"));
            };

            let name = opt_str(map, "name")?
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty());

            let created = manager
                .create(CreateTerminalOptions {
                    cwd: Some(resolved_cwd.clone()),
                    name: name.clone(),
                    ..Default::default()
                })
                .map_err(terminal_err)?;

            let listed = manager.list().into_iter().find(|t| t.id == created.id);
            let (out_name, out_cwd) = match listed {
                Some(info) => (info.name, info.cwd),
                None => (
                    name.unwrap_or_else(|| "terminal".to_string()),
                    Some(resolved_cwd),
                ),
            };

            Ok(tool_result(json!({
                "id": created.id,
                "name": out_name,
                "cwd": out_cwd,
            })))
        }),
    );
}

/// `kill_terminal` (mcp-server.ts:1704-1733). The Rust `kill` returns
/// `NotFound` for unknown ids, which the error mapping surfaces directly.
fn register_kill_terminal(registry: &mut ToolRegistry) {
    registry.register(
        ToolDescriptor {
            name: "kill_terminal".into(),
            title: "Kill terminal".into(),
            description: "Kill an existing terminal session.".into(),
            input_schema: object_schema(&[("terminalId", "string")], &[]),
        },
        boxed(|args, ctx| async move {
            let map = as_object(&args)?;
            let services = ctx.services();
            let Some(manager) = services.terminal_manager.as_ref() else {
                return Err(not_wired());
            };

            let id = req_str(map, "terminalId")?;
            manager.kill(&id).map_err(terminal_err)?;
            Ok(tool_result(json!({ "success": true })))
        }),
    );
}

/// `capture_terminal` (mcp-server.ts:1735-1777). `capture` returns ALL buffered
/// raw bytes; we lossily decode to UTF-8, optionally strip ANSI escapes
/// (`stripAnsi` defaults true), split into lines, then apply the `start`/`end`
/// slice. `scrollback` forces `start=0`. `totalLines` is computed before slicing.
fn register_capture_terminal(registry: &mut ToolRegistry) {
    registry.register(
        ToolDescriptor {
            name: "capture_terminal".into(),
            title: "Capture terminal".into(),
            description: "Capture plain-text terminal output lines from a terminal session.".into(),
            input_schema: object_schema(
                &[("terminalId", "string")],
                &[
                    ("start", "number"),
                    ("end", "number"),
                    ("scrollback", "boolean"),
                    ("stripAnsi", "boolean"),
                ],
            ),
        },
        boxed(|args, ctx| async move {
            let map = as_object(&args)?;
            let services = ctx.services();
            let Some(manager) = services.terminal_manager.as_ref() else {
                return Err(not_wired());
            };

            let id = req_str(map, "terminalId")?;
            let scrollback = opt_bool(map, "scrollback")?.unwrap_or(false);
            let strip = opt_bool(map, "stripAnsi")?.unwrap_or(true);
            let start_arg = map.get("start").and_then(Value::as_u64).map(|n| n as usize);
            let end_arg = map.get("end").and_then(Value::as_u64).map(|n| n as usize);

            let bytes = manager.capture(&id).map_err(terminal_err)?;
            let text = String::from_utf8_lossy(&bytes);
            let text = if strip {
                strip_ansi(&text)
            } else {
                text.into_owned()
            };

            let lines: Vec<String> = text
                .split('\n')
                .map(|line| line.strip_suffix('\r').unwrap_or(line).to_string())
                .collect();
            let total = lines.len();

            let start = if scrollback { 0 } else { start_arg.unwrap_or(0) };
            let start = start.min(total);
            let end = end_arg.map_or(total, |e| e.min(total)).max(start);
            let sliced: Vec<String> = lines[start..end].to_vec();

            Ok(tool_result(json!({
                "terminalId": id,
                "lines": sliced,
                "totalLines": total,
            })))
        }),
    );
}

/// `send_terminal_keys` (mcp-server.ts:1779-1813). Resolves the key token via
/// [`resolve_terminal_key_token`] (mirroring `resolveTerminalKeyToken`,
/// mcp-server.ts:469-500), then writes the bytes to the terminal's pty.
fn register_send_terminal_keys(registry: &mut ToolRegistry) {
    registry.register(
        ToolDescriptor {
            name: "send_terminal_keys".into(),
            title: "Send terminal keys".into(),
            description: "Send literal text or special key tokens to a terminal session.".into(),
            input_schema: object_schema(
                &[("terminalId", "string"), ("keys", "string")],
                &[("literal", "boolean")],
            ),
        },
        boxed(|args, ctx| async move {
            let map = as_object(&args)?;
            let services = ctx.services();
            let Some(manager) = services.terminal_manager.as_ref() else {
                return Err(not_wired());
            };

            let id = req_str(map, "terminalId")?;
            let keys = req_str(map, "keys")?;
            let literal = opt_bool(map, "literal")?.unwrap_or(false);

            let token = resolve_terminal_key_token(&keys, literal);
            manager
                .write_input(&id, token.as_bytes())
                .map_err(terminal_err)?;
            Ok(tool_result(json!({ "success": true })))
        }),
    );
}

/// Mirror of TS `resolveTerminalKeyToken` (mcp-server.ts:469-500). When `literal`
/// is set the keys are passed through unchanged; otherwise recognized special
/// tokens are mapped to their control sequences (unknown tokens pass through).
fn resolve_terminal_key_token(keys: &str, literal: bool) -> String {
    if literal {
        return keys.to_string();
    }
    match keys {
        "Enter" => "\r".to_string(),
        "Tab" => "\t".to_string(),
        "Escape" => "\u{1b}".to_string(),
        "Space" => " ".to_string(),
        "BSpace" => "\u{7f}".to_string(),
        "C-c" => "\u{3}".to_string(),
        "C-d" => "\u{4}".to_string(),
        "C-z" => "\u{1a}".to_string(),
        "C-l" => "\u{c}".to_string(),
        "C-a" => "\u{1}".to_string(),
        "C-e" => "\u{5}".to_string(),
        other => other.to_string(),
    }
}

/// Strip ANSI escape sequences from `s`. Handles CSI sequences
/// (`ESC [ ... <final 0x40-0x7e>`) and lone `ESC` escapes via a small state
/// machine over chars. Non-escape text is preserved verbatim.
fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '\u{1b}' {
            out.push(c);
            continue;
        }
        // Saw ESC; inspect what follows.
        match chars.peek().copied() {
            Some('[') => {
                // CSI: consume '[' then params/intermediates until a final byte.
                chars.next();
                while let Some(&next) = chars.peek() {
                    chars.next();
                    if ('\u{40}'..='\u{7e}').contains(&next) {
                        break;
                    }
                }
            }
            Some(_) => {
                // Lone ESC + one following byte (e.g. ESC sequence escape).
                chars.next();
            }
            None => {}
        }
    }
    out
}
