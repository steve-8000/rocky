//! Chat / schedule / loop session RPC handlers, matching the
//! `dispatchChatScheduleLoopMessage` + `dispatchScheduleMessage` cases in
//! `core/packages/server/src/server/session.ts` (lines ~2127-2193 and the
//! `handleChat*` / `handleSchedule*` / `handleLoop*` bodies at ~8675-9397) and
//! the response shapes in `core/packages/protocol/src/{chat,schedule,loop}/rpc-schemas.ts`.
//!
//! Inner request/response `type` strings are slash-style (`chat/create`,
//! `schedule/create`, `loop/run`, ...) and the payload field names are
//! wire-compatible with the TypeScript daemon. Each response payload carries the
//! `requestId`, the result, and a nullable `error`.
//!
//! Backing services:
//! - chat: a minimal file-backed store over `$ROCKY_HOME/chat/rooms.json`
//!   ([`ChatFileStore`]), mirroring `FileBackedChatService`
//!   (chat-service.ts:111-465). The on-disk payload is the
//!   `{ rooms, messages }` `ChatStorePayload` shape (chat-service.ts:16-19),
//!   written via `rocky_store::write_json_atomic` and parsed with the read-only
//!   `rocky_store::chat` types, keeping bytes identical to `writeJsonFileAtomic`.
//! - schedule: [`rocky_scheduling::ScheduleService`] over a `ScheduleStore`.
//! - loop: [`rocky_scheduling::LoopService`]. `loop/run` only creates the loop
//!   record (the running side-effect needs the daemon's `LoopExecutor`, which is
//!   not available here); the created record is returned as the TS handler does.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use rand::Rng;
use rocky_scheduling::{
    CreateScheduleInput, LoopService, NewAgentConfigPatch, ScheduleService, UpdateScheduleInput,
};
use rocky_store::{
    write_json_atomic, ChatMessage, ChatRoom, ChatStore, LoopRecord, LoopStatus, ScheduleCadence,
    ScheduleRun, ScheduleTarget, StoredSchedule,
};
use serde_json::{json, Value};
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;

use crate::dispatch::{SessionDispatcher, SessionRpcError};

/// Default loop provider, matching `DEFAULT_LOOP_PROVIDER` (loop-service.ts:25).
const DEFAULT_LOOP_PROVIDER: &str = "claude";

/// Bundle of the backing services/stores the chat/schedule/loop handlers need.
///
/// `ScheduleService` mutates through `&self` (its store is file-backed), but
/// `LoopService` holds in-memory records and requires `&mut self`; both are
/// guarded by a mutex so the async handlers can share them across the
/// dispatcher, matching the single-writer behavior of the TS services.
pub struct ChatScheduleLoopContext {
    pub chat: ChatFileStore,
    pub schedule: Arc<Mutex<ScheduleService>>,
    pub loops: Arc<Mutex<LoopService>>,
}

/// Register every `chat/*`, `schedule/*`, and `loop/*` handler.
pub fn register(dispatcher: &mut SessionDispatcher, ctx: ChatScheduleLoopContext) {
    let ChatScheduleLoopContext {
        chat,
        schedule,
        loops,
    } = ctx;

    // ---- chat ----
    let c = chat.clone();
    dispatcher.register(
        "chat/create",
        Arc::new(move |msg: Value| {
            let c = c.clone();
            async move { c.handle_create(msg) }
        }),
    );
    let c = chat.clone();
    dispatcher.register(
        "chat/list",
        Arc::new(move |msg: Value| {
            let c = c.clone();
            async move { c.handle_list(msg) }
        }),
    );
    let c = chat.clone();
    dispatcher.register(
        "chat/inspect",
        Arc::new(move |msg: Value| {
            let c = c.clone();
            async move { c.handle_inspect(msg) }
        }),
    );
    let c = chat.clone();
    dispatcher.register(
        "chat/delete",
        Arc::new(move |msg: Value| {
            let c = c.clone();
            async move { c.handle_delete(msg) }
        }),
    );
    let c = chat.clone();
    dispatcher.register(
        "chat/post",
        Arc::new(move |msg: Value| {
            let c = c.clone();
            async move { c.handle_post(msg) }
        }),
    );
    let c = chat.clone();
    dispatcher.register(
        "chat/read",
        Arc::new(move |msg: Value| {
            let c = c.clone();
            async move { c.handle_read(msg) }
        }),
    );
    let c = chat;
    dispatcher.register(
        "chat/wait",
        Arc::new(move |msg: Value| {
            let c = c.clone();
            async move { c.handle_wait(msg) }
        }),
    );

    // ---- schedule ----
    let s = schedule.clone();
    dispatcher.register(
        "schedule/create",
        Arc::new(move |msg: Value| {
            let s = s.clone();
            async move { handle_schedule_create(&s, msg) }
        }),
    );
    let s = schedule.clone();
    dispatcher.register(
        "schedule/list",
        Arc::new(move |msg: Value| {
            let s = s.clone();
            async move { handle_schedule_list(&s, msg) }
        }),
    );
    let s = schedule.clone();
    dispatcher.register(
        "schedule/inspect",
        Arc::new(move |msg: Value| {
            let s = s.clone();
            async move { handle_schedule_inspect(&s, msg) }
        }),
    );
    let s = schedule.clone();
    dispatcher.register(
        "schedule/logs",
        Arc::new(move |msg: Value| {
            let s = s.clone();
            async move { handle_schedule_logs(&s, msg) }
        }),
    );
    let s = schedule.clone();
    dispatcher.register(
        "schedule/pause",
        Arc::new(move |msg: Value| {
            let s = s.clone();
            async move { handle_schedule_pause(&s, msg) }
        }),
    );
    let s = schedule.clone();
    dispatcher.register(
        "schedule/resume",
        Arc::new(move |msg: Value| {
            let s = s.clone();
            async move { handle_schedule_resume(&s, msg) }
        }),
    );
    let s = schedule.clone();
    dispatcher.register(
        "schedule/delete",
        Arc::new(move |msg: Value| {
            let s = s.clone();
            async move { handle_schedule_delete(&s, msg) }
        }),
    );
    let s = schedule;
    dispatcher.register(
        "schedule/update",
        Arc::new(move |msg: Value| {
            let s = s.clone();
            async move { handle_schedule_update(&s, msg) }
        }),
    );

    // ---- loop ----
    let l = loops.clone();
    dispatcher.register(
        "loop/run",
        Arc::new(move |msg: Value| {
            let l = l.clone();
            async move { handle_loop_run(&l, msg) }
        }),
    );
    let l = loops.clone();
    dispatcher.register(
        "loop/list",
        Arc::new(move |msg: Value| {
            let l = l.clone();
            async move { handle_loop_list(&l, msg) }
        }),
    );
    let l = loops.clone();
    dispatcher.register(
        "loop/inspect",
        Arc::new(move |msg: Value| {
            let l = l.clone();
            async move { handle_loop_inspect(&l, msg) }
        }),
    );
    let l = loops.clone();
    dispatcher.register(
        "loop/logs",
        Arc::new(move |msg: Value| {
            let l = l.clone();
            async move { handle_loop_logs(&l, msg) }
        }),
    );
    let l = loops;
    dispatcher.register(
        "loop/stop",
        Arc::new(move |msg: Value| {
            let l = l.clone();
            async move { handle_loop_stop(&l, msg) }
        }),
    );
}

// ---------------------------------------------------------------------------
// Shared helpers
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

/// Outer Option = field present? Inner Option = null vs value (nullable patch).
fn opt_nullable_str(msg: &Value, key: &str) -> Option<Option<String>> {
    match msg.get(key) {
        None => None,
        Some(Value::Null) => Some(None),
        Some(Value::String(s)) => Some(Some(s.clone())),
        Some(_) => None,
    }
}

fn opt_i64(msg: &Value, key: &str) -> Option<i64> {
    msg.get(key).and_then(Value::as_i64)
}

fn opt_nullable_i64(msg: &Value, key: &str) -> Option<Option<i64>> {
    match msg.get(key) {
        None => None,
        Some(Value::Null) => Some(None),
        Some(v) => v.as_i64().map(Some),
    }
}

fn opt_bool(msg: &Value, key: &str) -> Option<bool> {
    msg.get(key).and_then(Value::as_bool)
}

fn internal(e: serde_json::Error) -> SessionRpcError {
    SessionRpcError::Handler(format!("serialize: {e}"))
}

/// `new Date().toISOString()`-compatible UTC timestamp with millisecond
/// precision, matching the TS services.
fn now_iso() -> String {
    let now = OffsetDateTime::now_utc();
    // Truncate to whole milliseconds, then format as RFC3339 with `Z`.
    let millis = now.millisecond();
    let trimmed = now.replace_nanosecond(millis as u32 * 1_000_000).unwrap_or(now);
    let formatted = trimmed.format(&Rfc3339).unwrap_or_default();
    // `time` emits `+00:00`; JS emits `Z` with fixed 3-digit subseconds.
    normalize_iso(&formatted)
}

/// Coerce a `time` RFC3339 string into the `YYYY-MM-DDTHH:MM:SS.mmmZ` form
/// JavaScript's `toISOString()` produces.
fn normalize_iso(value: &str) -> String {
    // Replace a trailing `+00:00` with `Z`.
    let base = value.strip_suffix("+00:00").unwrap_or(value);
    let (date_time, _) = match base.find(['Z', '+']) {
        Some(idx) => base.split_at(idx),
        None => (base, ""),
    };
    let date_time = date_time.trim_end_matches('Z');
    // Ensure exactly 3 fractional digits.
    let with_millis = match date_time.split_once('.') {
        Some((head, frac)) => {
            let mut frac = frac.to_string();
            frac.truncate(3);
            while frac.len() < 3 {
                frac.push('0');
            }
            format!("{head}.{frac}")
        }
        None => format!("{date_time}.000"),
    };
    format!("{with_millis}Z")
}

/// Generate a canonical lowercase UUID-v4 string, matching `randomUUID()` used
/// for chat room/message ids (chat-service.ts:46,60).
fn uuid_v4() -> String {
    let mut bytes = [0u8; 16];
    rand::thread_rng().fill(&mut bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
    bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 1
    format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7], bytes[8],
        bytes[9], bytes[10], bytes[11], bytes[12], bytes[13], bytes[14], bytes[15],
    )
}

/// Parse `@mentions` from a message body, matching `parseMentionAgentIds`
/// (chat-service.ts:37-46): a leading word boundary `@` followed by
/// `[A-Za-z0-9][A-Za-z0-9._-]*`, deduplicated and sorted.
fn parse_mention_agent_ids(body: &str) -> Vec<String> {
    let chars: Vec<char> = body.chars().collect();
    let is_boundary = |c: char| c.is_whitespace() || c == '(';
    let is_first = |c: char| c.is_ascii_alphanumeric();
    let is_rest = |c: char| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-');

    let mut mentions = std::collections::BTreeSet::new();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '@' && (i == 0 || is_boundary(chars[i - 1])) {
            let mut j = i + 1;
            if j < chars.len() && is_first(chars[j]) {
                j += 1;
                while j < chars.len() && is_rest(chars[j]) {
                    j += 1;
                }
                let mention: String = chars[i + 1..j].iter().collect();
                mentions.insert(mention);
                i = j;
                continue;
            }
        }
        i += 1;
    }
    mentions.into_iter().collect()
}

fn trim_to_null(value: Option<&str>) -> Option<String> {
    let trimmed = value?.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

// ---------------------------------------------------------------------------
// Chat: minimal file-backed store over $ROCKY_HOME/chat/rooms.json
// ---------------------------------------------------------------------------

/// File-backed chat store mirroring `FileBackedChatService` (chat-service.ts).
///
/// Each operation loads the `{ rooms, messages }` payload, mutates it, and
/// re-persists via `write_json_atomic` (matching `writeJsonFileAtomic`). Writes
/// are serialized by a process-wide mutex so concurrent dispatches do not race
/// the file, matching the single-writer `persistQueue` in TS.
#[derive(Clone)]
pub struct ChatFileStore {
    path: PathBuf,
    lock: Arc<Mutex<()>>,
}

impl ChatFileStore {
    /// Construct a store rooted at `$ROCKY_HOME`, writing
    /// `<rocky_home>/chat/rooms.json` (chat-service.ts:121).
    pub fn new(rocky_home: impl Into<PathBuf>) -> Self {
        let rocky_home = rocky_home.into();
        Self {
            path: rocky_home.join("chat").join("rooms.json"),
            lock: Arc::new(Mutex::new(())),
        }
    }

    fn load(&self) -> ChatStore {
        let Ok(raw) = std::fs::read_to_string(&self.path) else {
            return ChatStore::default();
        };
        serde_json::from_str::<ChatStore>(&raw).unwrap_or_default()
    }

    /// Persist sorted by `createdAt` ascending, matching `persist`
    /// (chat-service.ts:351-368).
    fn persist(&self, mut store: ChatStore) -> Result<(), SessionRpcError> {
        store
            .rooms
            .sort_by(|a, b| a.created_at.cmp(&b.created_at));
        store
            .messages
            .sort_by(|a, b| a.created_at.cmp(&b.created_at));
        write_json_atomic(&self.path, &store)
            .map_err(|e| SessionRpcError::Handler(format!("chat persist: {e}")))
    }

    fn resolve_room<'a>(store: &'a ChatStore, selector: &str) -> Result<&'a ChatRoom, String> {
        let selector = selector.trim();
        if selector.is_empty() {
            return Err("Chat room name or ID is required".to_string());
        }
        if let Some(room) = store.rooms.iter().find(|r| r.id == selector) {
            return Ok(room);
        }
        let normalized = selector.to_lowercase();
        if let Some(room) = store
            .rooms
            .iter()
            .find(|r| r.name.trim().to_lowercase() == normalized)
        {
            return Ok(room);
        }
        Err(format!("Chat room not found: {selector}"))
    }

    fn messages_for<'a>(store: &'a ChatStore, room_id: &str) -> Vec<&'a ChatMessage> {
        store
            .messages
            .iter()
            .filter(|m| m.room_id == room_id)
            .collect()
    }

    /// Project a room to the `ChatRoomDetail` response shape (chat-service.ts
    /// `toRoomDetail`, lines 437-446).
    fn room_detail(store: &ChatStore, room: &ChatRoom) -> Value {
        let messages = Self::messages_for(store, &room.id);
        let last = messages.last().map(|m| m.created_at.clone());
        json!({
            "id": room.id,
            "name": room.name,
            "purpose": room.purpose,
            "createdAt": room.created_at,
            "updatedAt": room.updated_at,
            "messageCount": messages.len(),
            "lastMessageAt": last,
        })
    }

    fn create_response(req_id: &str, room: Result<Value, String>) -> Value {
        match room {
            Ok(r) => json!({ "type": "chat/create/response", "payload": {
                "requestId": req_id, "room": r, "error": Value::Null } }),
            Err(e) => json!({ "type": "chat/create/response", "payload": {
                "requestId": req_id, "room": Value::Null, "error": e } }),
        }
    }

    fn handle_create(&self, msg: Value) -> Result<Value, SessionRpcError> {
        let req_id = request_id(&msg);
        let _guard = self.lock.lock().map_err(|_| poisoned("chat"))?;
        let mut store = self.load();
        let name = opt_str(&msg, "name").unwrap_or_default();
        let name = name.trim().to_string();
        if name.is_empty() {
            return Ok(Self::create_response(
                &req_id,
                Err("Chat room name is required".to_string()),
            ));
        }
        let normalized = name.to_lowercase();
        if store
            .rooms
            .iter()
            .any(|r| r.name.trim().to_lowercase() == normalized)
        {
            return Ok(Self::create_response(
                &req_id,
                Err(format!("Chat room already exists with name: {name}")),
            ));
        }
        let now = now_iso();
        let room = ChatRoom {
            id: uuid_v4(),
            name,
            purpose: trim_to_null(opt_str(&msg, "purpose").as_deref()),
            created_at: now.clone(),
            updated_at: now,
        };
        let detail = Self::room_detail(&store, &room);
        store.rooms.push(room);
        self.persist(store)?;
        Ok(Self::create_response(&req_id, Ok(detail)))
    }

    fn handle_list(&self, msg: Value) -> Result<Value, SessionRpcError> {
        let req_id = request_id(&msg);
        let store = self.load();
        let mut rooms: Vec<&ChatRoom> = store.rooms.iter().collect();
        // sort by updatedAt descending (chat-service.ts:155-159).
        rooms.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        let details: Vec<Value> = rooms
            .iter()
            .map(|r| Self::room_detail(&store, r))
            .collect();
        Ok(json!({ "type": "chat/list/response", "payload": {
            "requestId": req_id, "rooms": details, "error": Value::Null } }))
    }

    fn handle_inspect(&self, msg: Value) -> Result<Value, SessionRpcError> {
        let req_id = request_id(&msg);
        let store = self.load();
        let selector = opt_str(&msg, "room").unwrap_or_default();
        match Self::resolve_room(&store, &selector) {
            Ok(room) => {
                let detail = Self::room_detail(&store, room);
                Ok(json!({ "type": "chat/inspect/response", "payload": {
                    "requestId": req_id, "room": detail, "error": Value::Null } }))
            }
            Err(e) => Ok(json!({ "type": "chat/inspect/response", "payload": {
                "requestId": req_id, "room": Value::Null, "error": e } })),
        }
    }

    fn handle_delete(&self, msg: Value) -> Result<Value, SessionRpcError> {
        let req_id = request_id(&msg);
        let _guard = self.lock.lock().map_err(|_| poisoned("chat"))?;
        let mut store = self.load();
        let selector = opt_str(&msg, "room").unwrap_or_default();
        let room_id = match Self::resolve_room(&store, &selector) {
            Ok(room) => room.id.clone(),
            Err(e) => {
                return Ok(json!({ "type": "chat/delete/response", "payload": {
                    "requestId": req_id, "room": Value::Null, "error": e } }))
            }
        };
        let detail = {
            let room = store.rooms.iter().find(|r| r.id == room_id).unwrap();
            Self::room_detail(&store, room)
        };
        store.rooms.retain(|r| r.id != room_id);
        store.messages.retain(|m| m.room_id != room_id);
        self.persist(store)?;
        Ok(json!({ "type": "chat/delete/response", "payload": {
            "requestId": req_id, "room": detail, "error": Value::Null } }))
    }

    fn handle_post(&self, msg: Value) -> Result<Value, SessionRpcError> {
        let req_id = request_id(&msg);
        let _guard = self.lock.lock().map_err(|_| poisoned("chat"))?;
        let mut store = self.load();
        let selector = opt_str(&msg, "room").unwrap_or_default();
        let room_id = match Self::resolve_room(&store, &selector) {
            Ok(room) => room.id.clone(),
            Err(e) => return Ok(Self::post_error(&req_id, e)),
        };
        let body = opt_str(&msg, "body").unwrap_or_default();
        let body = body.trim().to_string();
        if body.is_empty() {
            return Ok(Self::post_error(
                &req_id,
                "Chat message body is required".to_string(),
            ));
        }
        // TS falls back to the session's clientId; without a live session we
        // require an explicit authorAgentId.
        let author = trim_to_null(opt_str(&msg, "authorAgentId").as_deref());
        let Some(author) = author else {
            return Ok(Self::post_error(
                &req_id,
                "Chat message author is required".to_string(),
            ));
        };
        let reply_to = trim_to_null(opt_str(&msg, "replyToMessageId").as_deref());
        if let Some(ref target) = reply_to {
            let exists = Self::messages_for(&store, &room_id)
                .iter()
                .any(|m| &m.id == target);
            if !exists {
                return Ok(Self::post_error(
                    &req_id,
                    format!("Reply target not found: {target}"),
                ));
            }
        }
        let created_at = now_iso();
        let message = ChatMessage {
            id: uuid_v4(),
            room_id: room_id.clone(),
            author_agent_id: author,
            body: body.clone(),
            reply_to_message_id: reply_to,
            mention_agent_ids: parse_mention_agent_ids(&body),
            created_at: created_at.clone(),
        };
        let message_value = serde_json::to_value(&message).map_err(internal)?;
        store.messages.push(message);
        if let Some(room) = store.rooms.iter_mut().find(|r| r.id == room_id) {
            room.updated_at = created_at;
        }
        self.persist(store)?;
        Ok(json!({ "type": "chat/post/response", "payload": {
            "requestId": req_id, "message": message_value, "error": Value::Null } }))
    }

    fn post_error(req_id: &str, error: String) -> Value {
        json!({ "type": "chat/post/response", "payload": {
            "requestId": req_id, "message": Value::Null, "error": error } })
    }

    fn handle_read(&self, msg: Value) -> Result<Value, SessionRpcError> {
        let req_id = request_id(&msg);
        let store = self.load();
        let selector = opt_str(&msg, "room").unwrap_or_default();
        let room_id = match Self::resolve_room(&store, &selector) {
            Ok(room) => room.id.clone(),
            Err(e) => {
                return Ok(json!({ "type": "chat/read/response", "payload": {
                    "requestId": req_id, "messages": [], "error": e } }))
            }
        };
        let since = trim_to_null(opt_str(&msg, "since").as_deref());
        let author = trim_to_null(opt_str(&msg, "authorAgentId").as_deref());
        // normalizeLimit: default 20, floor at 0 (chat-service.ts:448-454).
        let limit = match opt_i64(&msg, "limit") {
            None => 20usize,
            Some(v) => v.max(0) as usize,
        };
        let mut filtered: Vec<&ChatMessage> = Self::messages_for(&store, &room_id)
            .into_iter()
            .filter(|m| {
                if let Some(ref s) = since {
                    if &m.created_at < s {
                        return false;
                    }
                }
                if let Some(ref a) = author {
                    if &m.author_agent_id != a {
                        return false;
                    }
                }
                true
            })
            .collect();
        if limit != 0 && filtered.len() > limit {
            filtered = filtered.split_off(filtered.len() - limit);
        }
        let messages = serde_json::to_value(&filtered).map_err(internal)?;
        Ok(json!({ "type": "chat/read/response", "payload": {
            "requestId": req_id, "messages": messages, "error": Value::Null } }))
    }

    /// Non-blocking `chat/wait`: returns messages after the cursor when they
    /// already exist, else reports `timedOut`. True long-poll waiting requires a
    /// persistent in-memory waiter (chat-service.ts:236-296), which this
    /// stateless file-backed handler does not own; callers should poll.
    fn handle_wait(&self, msg: Value) -> Result<Value, SessionRpcError> {
        let req_id = request_id(&msg);
        let store = self.load();
        let selector = opt_str(&msg, "room").unwrap_or_default();
        let room_id = match Self::resolve_room(&store, &selector) {
            Ok(room) => room.id.clone(),
            Err(e) => {
                return Ok(json!({ "type": "chat/wait/response", "payload": {
                    "requestId": req_id, "messages": [], "timedOut": false, "error": e } }))
            }
        };
        let after = trim_to_null(opt_str(&msg, "afterMessageId").as_deref());
        let room_messages = Self::messages_for(&store, &room_id);
        let selected: Vec<&ChatMessage> = match after {
            Some(ref cursor) => {
                match room_messages.iter().position(|m| &m.id == cursor) {
                    Some(idx) => room_messages[idx + 1..].to_vec(),
                    None => {
                        return Ok(json!({ "type": "chat/wait/response", "payload": {
                            "requestId": req_id, "messages": [], "timedOut": false,
                            "error": format!("Wait cursor not found: {cursor}") } }))
                    }
                }
            }
            None => room_messages.iter().copied().rev().take(1).collect(),
        };
        let timed_out = selected.is_empty();
        let messages = serde_json::to_value(&selected).map_err(internal)?;
        Ok(json!({ "type": "chat/wait/response", "payload": {
            "requestId": req_id, "messages": messages, "timedOut": timed_out, "error": Value::Null } }))
    }
}

fn poisoned(which: &str) -> SessionRpcError {
    SessionRpcError::Handler(format!("{which} service lock poisoned"))
}

// ---------------------------------------------------------------------------
// Schedule handlers
// ---------------------------------------------------------------------------

type SharedSchedule = Arc<Mutex<ScheduleService>>;

/// Strip `runs` from a `StoredSchedule` JSON object to produce the
/// `ScheduleSummary` shape (session.ts `toScheduleSummary`, lines 9044-9052).
fn schedule_summary(schedule: &StoredSchedule) -> Result<Value, SessionRpcError> {
    let mut value = serde_json::to_value(schedule).map_err(internal)?;
    if let Some(obj) = value.as_object_mut() {
        obj.remove("runs");
    }
    Ok(value)
}

fn parse_target(msg: &Value) -> Result<ScheduleTarget, String> {
    let mut target = msg
        .get("target")
        .cloned()
        .ok_or_else(|| "schedule target is required".to_string())?;
    // session.ts maps `self` -> `agent` (lines 9089-9092).
    if let Some(obj) = target.as_object_mut() {
        if obj.get("type").and_then(Value::as_str) == Some("self") {
            obj.insert("type".to_string(), Value::String("agent".to_string()));
        }
    }
    serde_json::from_value(target).map_err(|e| format!("invalid schedule target: {e}"))
}

fn parse_cadence(msg: &Value) -> Result<ScheduleCadence, String> {
    let cadence = msg
        .get("cadence")
        .cloned()
        .ok_or_else(|| "schedule cadence is required".to_string())?;
    serde_json::from_value(cadence).map_err(|e| format!("invalid schedule cadence: {e}"))
}

fn schedule_resp_summary(
    msg_type: &str,
    req_id: &str,
    schedule: Result<&StoredSchedule, String>,
) -> Result<Value, SessionRpcError> {
    match schedule {
        Ok(s) => {
            let summary = schedule_summary(s)?;
            Ok(json!({ "type": msg_type, "payload": {
                "requestId": req_id, "schedule": summary, "error": Value::Null } }))
        }
        Err(e) => Ok(json!({ "type": msg_type, "payload": {
            "requestId": req_id, "schedule": Value::Null, "error": e } })),
    }
}

fn schedule_resp_full(
    msg_type: &str,
    req_id: &str,
    schedule: Result<&StoredSchedule, String>,
) -> Result<Value, SessionRpcError> {
    match schedule {
        Ok(s) => {
            let full = serde_json::to_value(s).map_err(internal)?;
            Ok(json!({ "type": msg_type, "payload": {
                "requestId": req_id, "schedule": full, "error": Value::Null } }))
        }
        Err(e) => Ok(json!({ "type": msg_type, "payload": {
            "requestId": req_id, "schedule": Value::Null, "error": e } })),
    }
}

fn handle_schedule_create(service: &SharedSchedule, msg: Value) -> Result<Value, SessionRpcError> {
    let req_id = request_id(&msg);
    let cadence = match parse_cadence(&msg) {
        Ok(c) => c,
        Err(e) => return schedule_resp_summary("schedule/create/response", &req_id, Err(e)),
    };
    let target = match parse_target(&msg) {
        Ok(t) => t,
        Err(e) => return schedule_resp_summary("schedule/create/response", &req_id, Err(e)),
    };
    let input = CreateScheduleInput {
        name: opt_str(&msg, "name"),
        prompt: opt_str(&msg, "prompt").unwrap_or_default(),
        cadence,
        target,
        expires_at: opt_str(&msg, "expiresAt"),
        max_runs: opt_i64(&msg, "maxRuns"),
        run_on_create: opt_bool(&msg, "runOnCreate"),
    };
    let svc = service.lock().map_err(|_| poisoned("schedule"))?;
    let result = svc.create_schedule(input).map_err(|e| e.to_string());
    schedule_resp_summary("schedule/create/response", &req_id, result.as_ref().map_err(|e| e.clone()))
}

fn handle_schedule_list(service: &SharedSchedule, msg: Value) -> Result<Value, SessionRpcError> {
    let req_id = request_id(&msg);
    let svc = service.lock().map_err(|_| poisoned("schedule"))?;
    let schedules = svc.list();
    let summaries: Result<Vec<Value>, SessionRpcError> =
        schedules.iter().map(schedule_summary).collect();
    Ok(json!({ "type": "schedule/list/response", "payload": {
        "requestId": req_id, "schedules": summaries?, "error": Value::Null } }))
}

fn handle_schedule_inspect(service: &SharedSchedule, msg: Value) -> Result<Value, SessionRpcError> {
    let req_id = request_id(&msg);
    let id = opt_str(&msg, "scheduleId").unwrap_or_default();
    let svc = service.lock().map_err(|_| poisoned("schedule"))?;
    let result = svc.inspect(&id).map_err(|e| e.to_string());
    schedule_resp_full(
        "schedule/inspect/response",
        &req_id,
        result.as_ref().map_err(|e| e.clone()),
    )
}

fn handle_schedule_logs(service: &SharedSchedule, msg: Value) -> Result<Value, SessionRpcError> {
    let req_id = request_id(&msg);
    let id = opt_str(&msg, "scheduleId").unwrap_or_default();
    let svc = service.lock().map_err(|_| poisoned("schedule"))?;
    match svc.inspect(&id) {
        Ok(schedule) => {
            // logs() sorts runs by startedAt ascending (service.ts:235-238).
            let mut runs: Vec<ScheduleRun> = schedule.runs.clone();
            runs.sort_by(|a, b| a.started_at.cmp(&b.started_at));
            let runs = serde_json::to_value(&runs).map_err(internal)?;
            Ok(json!({ "type": "schedule/logs/response", "payload": {
                "requestId": req_id, "runs": runs, "error": Value::Null } }))
        }
        Err(e) => Ok(json!({ "type": "schedule/logs/response", "payload": {
            "requestId": req_id, "runs": [], "error": e.to_string() } })),
    }
}

fn handle_schedule_pause(service: &SharedSchedule, msg: Value) -> Result<Value, SessionRpcError> {
    let req_id = request_id(&msg);
    let id = opt_str(&msg, "scheduleId").unwrap_or_default();
    let svc = service.lock().map_err(|_| poisoned("schedule"))?;
    let result = svc.pause(&id).map_err(|e| e.to_string());
    schedule_resp_summary(
        "schedule/pause/response",
        &req_id,
        result.as_ref().map_err(|e| e.clone()),
    )
}

fn handle_schedule_resume(service: &SharedSchedule, msg: Value) -> Result<Value, SessionRpcError> {
    let req_id = request_id(&msg);
    let id = opt_str(&msg, "scheduleId").unwrap_or_default();
    let svc = service.lock().map_err(|_| poisoned("schedule"))?;
    let result = svc.resume(&id).map_err(|e| e.to_string());
    schedule_resp_summary(
        "schedule/resume/response",
        &req_id,
        result.as_ref().map_err(|e| e.clone()),
    )
}

fn handle_schedule_delete(service: &SharedSchedule, msg: Value) -> Result<Value, SessionRpcError> {
    let req_id = request_id(&msg);
    let id = opt_str(&msg, "scheduleId").unwrap_or_default();
    let svc = service.lock().map_err(|_| poisoned("schedule"))?;
    match svc.delete(&id) {
        Ok(()) => Ok(json!({ "type": "schedule/delete/response", "payload": {
            "requestId": req_id, "scheduleId": id, "error": Value::Null } })),
        Err(e) => Ok(json!({ "type": "schedule/delete/response", "payload": {
            "requestId": req_id, "scheduleId": id, "error": e.to_string() } })),
    }
}

fn handle_schedule_update(service: &SharedSchedule, msg: Value) -> Result<Value, SessionRpcError> {
    let req_id = request_id(&msg);
    let new_agent_config = msg.get("newAgentConfig").map(|cfg| NewAgentConfigPatch {
        provider: opt_str(cfg, "provider"),
        cwd: opt_str(cfg, "cwd"),
        model: opt_nullable_str(cfg, "model"),
        mode_id: opt_nullable_str(cfg, "modeId"),
    });
    let cadence = match msg.get("cadence") {
        Some(_) => match parse_cadence(&msg) {
            Ok(c) => Some(c),
            Err(e) => return schedule_resp_full("schedule/update/response", &req_id, Err(e)),
        },
        None => None,
    };
    let input = UpdateScheduleInput {
        id: opt_str(&msg, "scheduleId").unwrap_or_default(),
        prompt: opt_str(&msg, "prompt"),
        name: opt_nullable_str(&msg, "name"),
        cadence,
        new_agent_config,
        max_runs: opt_nullable_i64(&msg, "maxRuns"),
        expires_at: opt_nullable_str(&msg, "expiresAt"),
    };
    let svc = service.lock().map_err(|_| poisoned("schedule"))?;
    let result = svc.update(input).map_err(|e| e.to_string());
    schedule_resp_full(
        "schedule/update/response",
        &req_id,
        result.as_ref().map_err(|e| e.clone()),
    )
}

// ---------------------------------------------------------------------------
// Loop handlers
// ---------------------------------------------------------------------------

type SharedLoop = Arc<Mutex<LoopService>>;

/// Resolve `path.resolve(cwd)`: keep absolute paths, otherwise join the process
/// cwd. (Lexical `..`/`.` collapsing is not required for the wire contract.)
fn resolve_cwd(cwd: &str) -> String {
    let path = Path::new(cwd);
    if path.is_absolute() {
        cwd.to_string()
    } else {
        std::env::current_dir()
            .map(|d| d.join(path))
            .unwrap_or_else(|_| path.to_path_buf())
            .to_string_lossy()
            .to_string()
    }
}

fn loop_run_error(req_id: &str, error: String) -> Value {
    json!({ "type": "loop/run/response", "payload": {
        "requestId": req_id, "loop": Value::Null, "error": error } })
}

fn handle_loop_run(service: &SharedLoop, msg: Value) -> Result<Value, SessionRpcError> {
    let req_id = request_id(&msg);

    // Validation mirroring runLoop (loop-service.ts:366-383).
    let prompt = opt_str(&msg, "prompt").unwrap_or_default();
    let prompt = prompt.trim().to_string();
    if prompt.is_empty() {
        return Ok(loop_run_error(&req_id, "prompt cannot be empty".to_string()));
    }
    let verify_prompt = trim_to_null(opt_str(&msg, "verifyPrompt").as_deref());
    let mut verify_checks = Vec::new();
    if let Some(arr) = msg.get("verifyChecks").and_then(Value::as_array) {
        for cmd in arr {
            let trimmed = cmd.as_str().unwrap_or_default().trim().to_string();
            if trimmed.is_empty() {
                return Ok(loop_run_error(
                    &req_id,
                    "verifyChecks cannot contain empty commands".to_string(),
                ));
            }
            verify_checks.push(trimmed);
        }
    }
    if verify_prompt.is_none() && verify_checks.is_empty() {
        return Ok(loop_run_error(
            &req_id,
            "Loop requires --verify or at least one --verify-check".to_string(),
        ));
    }

    // Build the record; LoopService::create assigns id/timestamps/status and
    // appends the "Loop created" log (loop-service.ts:366-430). The running
    // side-effect needs the daemon's LoopExecutor and is not performed here.
    let record = LoopRecord {
        id: String::new(),
        name: trim_to_null(opt_str(&msg, "name").as_deref()),
        prompt,
        cwd: resolve_cwd(&opt_str(&msg, "cwd").unwrap_or_default()),
        provider: opt_str(&msg, "provider").unwrap_or_else(|| DEFAULT_LOOP_PROVIDER.to_string()),
        model: trim_to_null(opt_str(&msg, "model").as_deref()),
        mode_id: trim_to_null(opt_str(&msg, "modeId").as_deref()),
        worker_provider: opt_str(&msg, "workerProvider"),
        worker_model: trim_to_null(opt_str(&msg, "workerModel").as_deref()),
        verifier_provider: opt_str(&msg, "verifierProvider"),
        verifier_model: trim_to_null(opt_str(&msg, "verifierModel").as_deref()),
        verifier_mode_id: trim_to_null(opt_str(&msg, "verifierModeId").as_deref()),
        verify_prompt,
        verify_checks,
        archive: opt_bool(&msg, "archive").unwrap_or(false),
        sleep_ms: opt_i64(&msg, "sleepMs").unwrap_or(0),
        max_iterations: opt_i64(&msg, "maxIterations"),
        max_time_ms: opt_i64(&msg, "maxTimeMs"),
        status: LoopStatus::Running,
        created_at: String::new(),
        updated_at: String::new(),
        started_at: String::new(),
        completed_at: None,
        stop_requested_at: None,
        iterations: Vec::new(),
        logs: Vec::new(),
        next_log_seq: 1,
        active_iteration: None,
        active_worker_agent_id: None,
        active_verifier_agent_id: None,
    };

    let mut svc = service.lock().map_err(|_| poisoned("loop"))?;
    match svc.create(record) {
        Ok(loop_record) => {
            let value = serde_json::to_value(&loop_record).map_err(internal)?;
            Ok(json!({ "type": "loop/run/response", "payload": {
                "requestId": req_id, "loop": value, "error": Value::Null } }))
        }
        Err(e) => Ok(loop_run_error(&req_id, e.to_string())),
    }
}

fn handle_loop_list(service: &SharedLoop, msg: Value) -> Result<Value, SessionRpcError> {
    let req_id = request_id(&msg);
    let mut svc = service.lock().map_err(|_| poisoned("loop"))?;
    match svc.list() {
        Ok(items) => {
            let loops = serde_json::to_value(&items).map_err(internal)?;
            Ok(json!({ "type": "loop/list/response", "payload": {
                "requestId": req_id, "loops": loops, "error": Value::Null } }))
        }
        Err(e) => Ok(json!({ "type": "loop/list/response", "payload": {
            "requestId": req_id, "loops": [], "error": e.to_string() } })),
    }
}

fn handle_loop_inspect(service: &SharedLoop, msg: Value) -> Result<Value, SessionRpcError> {
    let req_id = request_id(&msg);
    let id = opt_str(&msg, "id").unwrap_or_default();
    let mut svc = service.lock().map_err(|_| poisoned("loop"))?;
    match svc.inspect(&id) {
        Ok(record) => {
            let value = serde_json::to_value(&record).map_err(internal)?;
            Ok(json!({ "type": "loop/inspect/response", "payload": {
                "requestId": req_id, "loop": value, "error": Value::Null } }))
        }
        Err(e) => Ok(json!({ "type": "loop/inspect/response", "payload": {
            "requestId": req_id, "loop": Value::Null, "error": e.to_string() } })),
    }
}

fn handle_loop_logs(service: &SharedLoop, msg: Value) -> Result<Value, SessionRpcError> {
    let req_id = request_id(&msg);
    let id = opt_str(&msg, "id").unwrap_or_default();
    let after_seq = opt_i64(&msg, "afterSeq").unwrap_or(0);
    let mut svc = service.lock().map_err(|_| poisoned("loop"))?;
    match svc.inspect(&id) {
        Ok(record) => {
            // getLoopLogs: entries with seq > afterSeq, nextCursor = nextLogSeq - 1
            // (loop-service.ts:457-466).
            let entries: Vec<&_> = record
                .logs
                .iter()
                .filter(|entry| entry.seq > after_seq)
                .collect();
            let entries = serde_json::to_value(&entries).map_err(internal)?;
            let next_cursor = record.next_log_seq - 1;
            let loop_value = serde_json::to_value(&record).map_err(internal)?;
            Ok(json!({ "type": "loop/logs/response", "payload": {
                "requestId": req_id, "loop": loop_value, "entries": entries,
                "nextCursor": next_cursor, "error": Value::Null } }))
        }
        Err(e) => Ok(json!({ "type": "loop/logs/response", "payload": {
            "requestId": req_id, "loop": Value::Null, "entries": [],
            "nextCursor": 0, "error": e.to_string() } })),
    }
}

fn handle_loop_stop(service: &SharedLoop, msg: Value) -> Result<Value, SessionRpcError> {
    let req_id = request_id(&msg);
    let id = opt_str(&msg, "id").unwrap_or_default();
    let mut svc = service.lock().map_err(|_| poisoned("loop"))?;
    match svc.stop(&id) {
        Ok(record) => {
            let value = serde_json::to_value(&record).map_err(internal)?;
            Ok(json!({ "type": "loop/stop/response", "payload": {
                "requestId": req_id, "loop": value, "error": Value::Null } }))
        }
        Err(e) => Ok(json!({ "type": "loop/stop/response", "payload": {
            "requestId": req_id, "loop": Value::Null, "error": e.to_string() } })),
    }
}
