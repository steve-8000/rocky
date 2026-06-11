//! Markdown team-board projection, an exact port of `renderMissionBoard` /
//! `escapeBoardCell` in
//! `core/packages/server/src/server/mission-control/service.ts` (lines
//! 138-156).

use crate::types::{MissionRecord, MissionTaskIsolation, MissionTaskStatus};

/// Escape a single board-table cell, matching `escapeBoardCell` (service.ts
/// lines 138-140): `value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim()`.
/// Pipes become `\|`, CRLF/LF runs collapse to single spaces, then the result
/// is trimmed of surrounding ASCII/Unicode whitespace (matching JS `String#trim`).
fn escape_board_cell(value: &str) -> String {
    // Order matches the TS chain: escape pipes first, then collapse newlines.
    let escaped = value.replace('|', "\\|");
    // `/\r?\n/g` matches a bare `\n` or a `\r\n` pair; replace each with one space.
    let collapsed = escaped.replace("\r\n", " ").replace('\n', " ");
    collapsed.trim().to_string()
}

fn isolation_str(isolation: MissionTaskIsolation) -> &'static str {
    match isolation {
        MissionTaskIsolation::Shared => "shared",
        MissionTaskIsolation::Worktree => "worktree",
        MissionTaskIsolation::ReadOnly => "read-only",
    }
}

fn status_str(status: MissionTaskStatus) -> &'static str {
    match status {
        MissionTaskStatus::Todo => "todo",
        MissionTaskStatus::Running => "running",
        MissionTaskStatus::Blocked => "blocked",
        MissionTaskStatus::Failed => "failed",
        MissionTaskStatus::Done => "done",
        MissionTaskStatus::Canceled => "canceled",
    }
}

/// Render the mission team board as Markdown, an exact port of
/// `renderMissionBoard` (service.ts lines 142-156).
///
/// The output is the header line, a blank line, the table header and separator,
/// one row per task, and a trailing blank line — joined with `\n` (so the
/// string ends with a trailing newline, matching the TS `[...].join("\n")` with
/// an empty last element).
pub fn render_mission_board(mission: &MissionRecord) -> String {
    let mut lines: Vec<String> = Vec::with_capacity(mission.tasks.len() + 5);
    lines.push(format!("# Team Board — {}", mission.goal));
    lines.push(String::new());
    lines.push("| # | Task | Owner (agent id) | Isolation | Status | Result |".to_string());
    lines.push("|---|------|------------------|-----------|--------|--------|".to_string());
    for (index, task) in mission.tasks.iter().enumerate() {
        let owner = task.owner_agent_id.as_deref().unwrap_or("unassigned");
        let result = task.result.as_deref().unwrap_or("");
        lines.push(format!(
            "| {} | {} | {} | {} | {} | {} |",
            index + 1,
            escape_board_cell(&task.title),
            escape_board_cell(owner),
            isolation_str(task.isolation),
            status_str(task.status),
            escape_board_cell(result),
        ));
    }
    lines.push(String::new());
    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escapes_pipes_and_newlines() {
        assert_eq!(escape_board_cell("a|b"), "a\\|b");
        assert_eq!(escape_board_cell("line1\nline2"), "line1 line2");
        assert_eq!(escape_board_cell("line1\r\nline2"), "line1 line2");
        assert_eq!(escape_board_cell("  trimmed  "), "trimmed");
        assert_eq!(escape_board_cell("a|b\nc"), "a\\|b c");
    }
}
