//! Push notification payload builder + sender abstraction.
//!
//! The payload shape and the title/body/data derivation are a Rust port of
//! `core/packages/protocol/src/agent-attention-notification.ts`
//! (`buildAgentAttentionNotificationPayload`). The Expo send path
//! (`core/packages/server/src/server/push/push-service.ts`) is modeled behind
//! the [`PushSender`] trait so the daemon can wire a real HTTPS sender later
//! without this crate depending on a network stack.

use std::collections::BTreeMap;

use async_trait::async_trait;
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::sync::OnceLock;

/// Matches `NOTIFICATION_PREVIEW_LIMIT` in the TS module.
const NOTIFICATION_PREVIEW_LIMIT: usize = 220;

/// Attention reason, mirroring TS `AgentAttentionReason`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AttentionReason {
    Finished,
    Error,
    Permission,
}

impl AttentionReason {
    fn as_str(self) -> &'static str {
        match self {
            AttentionReason::Finished => "finished",
            AttentionReason::Error => "error",
            AttentionReason::Permission => "permission",
        }
    }
}

/// Pending permission detail used to build a permission notification body.
/// Mirrors TS `NotificationPermissionRequest` (only the fields the body builder
/// reads are modeled; unknown fields are irrelevant here).
#[derive(Debug, Clone, Default)]
pub struct PermissionRequest {
    pub name: String,
    pub kind: String,
    pub title: Option<String>,
    pub description: Option<String>,
    /// `input` preview source (already-serialized JSON object), used only when
    /// title/description are absent. Mirrors `safeStringify(request.input)`.
    pub input: Option<serde_json::Value>,
    /// `metadata` preview source, used when title/description/input are absent.
    pub metadata: Option<serde_json::Value>,
}

/// A push notification payload: `{ title, body, data }`. Matches TS
/// `AgentAttentionNotificationPayload` / `PushPayload`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PushNotification {
    pub title: String,
    pub body: String,
    /// Arbitrary string-keyed data. For attention events this is
    /// `{ serverId, agentId, reason }`.
    pub data: BTreeMap<String, String>,
}

impl PushNotification {
    /// Build an attention notification, mirroring
    /// `buildAgentAttentionNotificationPayload`.
    pub fn attention(
        reason: AttentionReason,
        server_id: impl Into<String>,
        agent_id: impl Into<String>,
        assistant_message: Option<&str>,
        permission_request: Option<&PermissionRequest>,
    ) -> Self {
        let server_id = server_id.into();
        let agent_id = agent_id.into();
        let title = resolve_title(reason).to_string();
        let preview = resolve_preview(reason, assistant_message, permission_request);
        let body = preview.unwrap_or_else(|| resolve_fallback_body(reason).to_string());

        let mut data = BTreeMap::new();
        data.insert("serverId".to_string(), server_id);
        data.insert("agentId".to_string(), agent_id);
        data.insert("reason".to_string(), reason.as_str().to_string());

        Self { title, body, data }
    }
}

fn resolve_title(reason: AttentionReason) -> &'static str {
    match reason {
        AttentionReason::Permission => "Agent needs permission",
        AttentionReason::Error => "Agent needs attention",
        AttentionReason::Finished => "Agent finished",
    }
}

fn resolve_fallback_body(reason: AttentionReason) -> &'static str {
    match reason {
        AttentionReason::Permission => "Permission requested.",
        AttentionReason::Error => "Encountered an error.",
        AttentionReason::Finished => "Finished working.",
    }
}

fn resolve_preview(
    reason: AttentionReason,
    assistant_message: Option<&str>,
    permission_request: Option<&PermissionRequest>,
) -> Option<String> {
    match reason {
        AttentionReason::Finished => build_notification_preview(assistant_message),
        AttentionReason::Permission => {
            let details = build_permission_details(permission_request);
            build_notification_preview(details.as_deref())
        }
        AttentionReason::Error => None,
    }
}

fn build_permission_details(request: Option<&PermissionRequest>) -> Option<String> {
    let request = request?;
    let title = request.title.as_deref().map(str::trim).filter(|s| !s.is_empty());
    let description = request
        .description
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());

    let mut details: Vec<&str> = Vec::new();
    if let Some(title) = title {
        details.push(title);
    }
    if let Some(description) = description {
        if Some(description) != title {
            details.push(description);
        }
    }
    if !details.is_empty() {
        return Some(details.join(" - "));
    }

    if let Some(input) = &request.input {
        if let Some(s) = safe_stringify(input) {
            return Some(s);
        }
    }
    if let Some(metadata) = &request.metadata {
        if let Some(s) = safe_stringify(metadata) {
            return Some(s);
        }
    }

    let name = request.name.trim();
    if !name.is_empty() {
        Some(name.to_string())
    } else {
        Some(request.kind.clone())
    }
}

fn safe_stringify(value: &serde_json::Value) -> Option<String> {
    serde_json::to_string(value).ok()
}

fn build_notification_preview(text: Option<&str>) -> Option<String> {
    let text = text?;
    let normalized = normalize_notification_text(&strip_markdown_to_text(text));
    if normalized.is_empty() {
        return None;
    }
    Some(truncate_notification_text(&normalized, NOTIFICATION_PREVIEW_LIMIT))
}

fn normalize_notification_text(text: &str) -> String {
    static WS: OnceLock<Regex> = OnceLock::new();
    let ws = WS.get_or_init(|| Regex::new(r"\s+").unwrap());
    ws.replace_all(text, " ").trim().to_string()
}

fn truncate_notification_text(text: &str, limit: usize) -> String {
    // TS operates on UTF-16 code units via `String.length`/`slice`. The Rust
    // daemon's notification text is ASCII/markdown in practice; we slice on
    // char boundaries to stay panic-safe while preserving the same shape.
    let chars: Vec<char> = text.chars().collect();
    if chars.len() <= limit {
        return text.to_string();
    }
    let take = limit.saturating_sub(3);
    let trimmed: String = chars[..take].iter().collect();
    let trimmed = trimmed.trim_end();
    if !trimmed.is_empty() {
        format!("{trimmed}...")
    } else {
        chars[..limit].iter().collect()
    }
}

fn strip_markdown_to_text(markdown: &str) -> String {
    macro_rules! re {
        ($cell:ident, $pat:literal) => {{
            static $cell: OnceLock<Regex> = OnceLock::new();
            $cell.get_or_init(|| Regex::new($pat).unwrap())
        }};
    }

    let mut text = markdown.replace("\r\n", "\n");

    // Strip fenced code markers but keep the code content itself.
    text = re!(FENCE_BACKTICK, r"(?m)^\s*```[^\n]*$")
        .replace_all(&text, "")
        .into_owned();
    text = re!(FENCE_TILDE, r"(?m)^\s*~~~[^\n]*$")
        .replace_all(&text, "")
        .into_owned();

    // Markdown images/links.
    text = re!(IMG, r"!\[([^\]]*)\]\((?:[^()\\]|\\.)*\)")
        .replace_all(&text, "$1")
        .into_owned();
    text = re!(LINK, r"\[([^\]]+)\]\((?:[^()\\]|\\.)*\)")
        .replace_all(&text, "$1")
        .into_owned();

    // Structural prefixes.
    text = re!(HEADING, r"(?m)^\s{0,3}#{1,6}\s+")
        .replace_all(&text, "")
        .into_owned();
    text = re!(QUOTE, r"(?m)^\s{0,3}>+\s?")
        .replace_all(&text, "")
        .into_owned();
    text = re!(LIST, r"(?m)^\s{0,3}(?:[*+-]|\d+\.)\s+")
        .replace_all(&text, "")
        .into_owned();
    text = re!(RULE, r"(?m)^\s{0,3}(?:[-*_]\s*){3,}$")
        .replace_all(&text, "")
        .into_owned();

    // Inline markers.
    text = re!(CODE, r"`([^`]+)`")
        .replace_all(&text, "$1")
        .into_owned();
    text = re!(BOLD_STAR, r"\*\*([^*]+)\*\*")
        .replace_all(&text, "$1")
        .into_owned();
    text = re!(BOLD_UNDER, r"__([^_]+)__")
        .replace_all(&text, "$1")
        .into_owned();
    text = re!(ITALIC_STAR, r"\*([^*\n]+)\*")
        .replace_all(&text, "$1")
        .into_owned();
    text = re!(ITALIC_UNDER, r"_([^_\n]+)_")
        .replace_all(&text, "$1")
        .into_owned();
    text = re!(STRIKE, r"~~([^~]+)~~")
        .replace_all(&text, "$1")
        .into_owned();

    // Angle-bracketed URL autolinks.
    text = re!(AUTOLINK, r"<([^>\n]+)>")
        .replace_all(&text, "$1")
        .into_owned();

    text
}

/// Outcome of attempting to send a push notification.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SendReport {
    /// Whether the notification was actually delivered to the push provider.
    pub delivered: bool,
    /// Machine-readable status, e.g. `"sent"`, `"not_configured"`, `"no_tokens"`.
    pub status: SendStatus,
    /// Number of tokens targeted.
    pub token_count: usize,
    /// Human-readable explanation (always populated for non-delivered states).
    pub detail: String,
}

/// Send status, distinguishing a real delivery from explicit non-delivery
/// states. `NotConfigured` is NOT a success — callers must treat it as such.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SendStatus {
    Sent,
    NoTokens,
    NotConfigured,
}

/// Abstraction over the Expo push send path. Implementors perform the actual
/// HTTPS POST; this crate ships only a not-configured implementation so the
/// daemon never reports a fake success.
#[async_trait]
pub trait PushSender: Send + Sync {
    async fn send(
        &self,
        tokens: &[String],
        notif: &PushNotification,
    ) -> anyhow::Result<SendReport>;
}

/// Sender used until a real Expo HTTP sender is wired. Returns a structured
/// not-configured result; it NEVER fabricates a successful send.
#[derive(Debug, Clone, Default)]
pub struct NotConfiguredSender;

#[async_trait]
impl PushSender for NotConfiguredSender {
    async fn send(
        &self,
        tokens: &[String],
        _notif: &PushNotification,
    ) -> anyhow::Result<SendReport> {
        Ok(SendReport {
            delivered: false,
            status: SendStatus::NotConfigured,
            token_count: tokens.len(),
            detail: "Push sender is not configured; no Expo HTTP sender is wired.".to_string(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_finished_notification_from_markdown() {
        let notif = PushNotification::attention(
            AttentionReason::Finished,
            "srv-1",
            "agent-1",
            Some("Done. Updated `README.md` and [link](https://example.com)."),
            None,
        );
        assert_eq!(notif.title, "Agent finished");
        assert_eq!(notif.body, "Done. Updated README.md and link.");
        assert_eq!(notif.data.get("serverId").unwrap(), "srv-1");
        assert_eq!(notif.data.get("agentId").unwrap(), "agent-1");
        assert_eq!(notif.data.get("reason").unwrap(), "finished");
    }

    #[test]
    fn builds_permission_notification_from_request() {
        let request = PermissionRequest {
            name: "shell".to_string(),
            kind: "tool".to_string(),
            title: Some("**Approve command**".to_string()),
            description: Some("Run `git push`".to_string()),
            ..Default::default()
        };
        let notif = PushNotification::attention(
            AttentionReason::Permission,
            "srv-2",
            "agent-2",
            None,
            Some(&request),
        );
        assert_eq!(notif.title, "Agent needs permission");
        assert_eq!(notif.body, "Approve command - Run git push");
        assert_eq!(notif.data.get("reason").unwrap(), "permission");
    }

    #[test]
    fn permission_falls_back_to_fallback_body_without_details() {
        // No title/description/input/metadata, blank name -> kind, then preview.
        let request = PermissionRequest {
            name: "exec".to_string(),
            kind: "tool".to_string(),
            ..Default::default()
        };
        let notif = PushNotification::attention(
            AttentionReason::Permission,
            "srv",
            "agent",
            None,
            Some(&request),
        );
        // name preview wins over fallback.
        assert_eq!(notif.body, "exec");
    }

    #[test]
    fn permission_without_request_uses_fallback_body() {
        let notif = PushNotification::attention(
            AttentionReason::Permission,
            "srv",
            "agent",
            None,
            None,
        );
        assert_eq!(notif.body, "Permission requested.");
    }

    #[test]
    fn error_uses_fallback_body() {
        let notif =
            PushNotification::attention(AttentionReason::Error, "srv-3", "agent-3", None, None);
        assert_eq!(notif.title, "Agent needs attention");
        assert_eq!(notif.body, "Encountered an error.");
        assert_eq!(notif.data.get("reason").unwrap(), "error");
    }

    #[test]
    fn finished_without_message_uses_fallback_body() {
        let notif =
            PushNotification::attention(AttentionReason::Finished, "srv", "agent", None, None);
        assert_eq!(notif.body, "Finished working.");
    }

    #[tokio::test]
    async fn not_configured_sender_does_not_fake_success() {
        let sender = NotConfiguredSender;
        let notif =
            PushNotification::attention(AttentionReason::Finished, "srv", "agent", None, None);
        let report = sender
            .send(&["tok-a".to_string(), "tok-b".to_string()], &notif)
            .await
            .unwrap();
        assert!(!report.delivered);
        assert_eq!(report.status, SendStatus::NotConfigured);
        assert_eq!(report.token_count, 2);
        assert!(!report.detail.is_empty());
    }
}
