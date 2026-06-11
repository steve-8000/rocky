//! Chat rooms/messages projection (read-only).
//!
//! Mirrors:
//! - `ChatStorePayloadSchema` in
//!   `core/packages/server/src/server/chat/chat-service.ts:16-19`
//!   (`{ rooms: ChatRoom[], messages: ChatMessage[] }`)
//! - `ChatRoomSchema` and `ChatMessageSchema` in
//!   `core/packages/protocol/src/chat/types.ts:3-21`
//!
//! The store persists a single JSON object via
//! `writeJsonFileAtomic(this.filePath, payload)` (chat-service.ts:359-368) and
//! loads with `ChatStorePayloadSchema.parse(JSON.parse(raw))` (line 334). The
//! file lives at `$ROCKY_HOME/chat/rooms.json` (chat-service.ts:121).
//!
//! Parsing is permissive: unknown fields are ignored and a missing or
//! malformed file yields an empty store, matching the TS loader's ENOENT
//! tolerance (chat-service.ts:331-348).

use std::path::Path;

use serde::{Deserialize, Serialize};

/// Chat room, matching `ChatRoomSchema` (protocol/chat/types.ts:3-9).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatRoom {
    pub id: String,
    pub name: String,
    pub purpose: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

/// Chat message, matching `ChatMessageSchema` (protocol/chat/types.ts:13-21).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    pub id: String,
    pub room_id: String,
    pub author_agent_id: String,
    pub body: String,
    pub reply_to_message_id: Option<String>,
    #[serde(default)]
    pub mention_agent_ids: Vec<String>,
    pub created_at: String,
}

/// Parsed chat store, matching `ChatStorePayloadSchema` (chat-service.ts:16-19).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChatStore {
    #[serde(default)]
    pub rooms: Vec<ChatRoom>,
    #[serde(default)]
    pub messages: Vec<ChatMessage>,
}

fn chat_store_path(rocky_home: &Path) -> std::path::PathBuf {
    rocky_home.join("chat").join("rooms.json")
}

/// Read `$ROCKY_HOME/chat/rooms.json`, returning an empty store when the file
/// is missing or malformed.
pub fn read_chat_store(rocky_home: &Path) -> ChatStore {
    let path = chat_store_path(rocky_home);
    let Ok(raw) = std::fs::read_to_string(&path) else {
        return ChatStore::default();
    };
    serde_json::from_str::<ChatStore>(&raw).unwrap_or_default()
}

/// All rooms in the store.
pub fn list_rooms(store: &ChatStore) -> &[ChatRoom] {
    &store.rooms
}

/// Messages belonging to `room_id`, matching `ChatMessage.roomId`.
pub fn messages_for_room<'a>(store: &'a ChatStore, room_id: &str) -> Vec<&'a ChatMessage> {
    store
        .messages
        .iter()
        .filter(|message| message.room_id == room_id)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn write_store(dir: &TempDir, body: &str) {
        let path = chat_store_path(dir.path());
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, body).unwrap();
    }

    #[test]
    fn parses_store_with_room_and_messages() {
        let dir = TempDir::new().unwrap();
        write_store(
            &dir,
            r#"{
              "rooms": [
                {
                  "id": "room_1",
                  "name": "general",
                  "purpose": "team chat",
                  "createdAt": "2026-01-01T00:00:00.000Z",
                  "updatedAt": "2026-01-02T00:00:00.000Z"
                }
              ],
              "messages": [
                {
                  "id": "msg_1",
                  "roomId": "room_1",
                  "authorAgentId": "agent_a",
                  "body": "hello @agent_b",
                  "replyToMessageId": null,
                  "mentionAgentIds": ["agent_b"],
                  "createdAt": "2026-01-01T00:01:00.000Z"
                },
                {
                  "id": "msg_2",
                  "roomId": "room_1",
                  "authorAgentId": "agent_b",
                  "body": "hi",
                  "replyToMessageId": "msg_1",
                  "mentionAgentIds": [],
                  "createdAt": "2026-01-01T00:02:00.000Z"
                }
              ]
            }"#,
        );
        let store = read_chat_store(dir.path());
        assert_eq!(store.rooms.len(), 1);
        assert_eq!(store.messages.len(), 2);
        let room = &store.rooms[0];
        assert_eq!(room.id, "room_1");
        assert_eq!(room.name, "general");
        assert_eq!(room.purpose.as_deref(), Some("team chat"));
        assert_eq!(list_rooms(&store).len(), 1);
        assert_eq!(messages_for_room(&store, "room_1").len(), 2);
        assert_eq!(messages_for_room(&store, "missing").len(), 0);
        let first = &store.messages[0];
        assert_eq!(first.mention_agent_ids, vec!["agent_b".to_string()]);
        assert_eq!(first.reply_to_message_id, None);
        assert_eq!(store.messages[1].reply_to_message_id.as_deref(), Some("msg_1"));
    }

    #[test]
    fn missing_file_yields_empty_store() {
        let dir = TempDir::new().unwrap();
        let store = read_chat_store(dir.path());
        assert!(store.rooms.is_empty());
        assert!(store.messages.is_empty());
    }

    #[test]
    fn ignores_unknown_fields() {
        let dir = TempDir::new().unwrap();
        write_store(
            &dir,
            r#"{
              "rooms": [
                {
                  "id": "room_1",
                  "name": "general",
                  "purpose": null,
                  "createdAt": "t",
                  "updatedAt": "t",
                  "futureRoomField": 42
                }
              ],
              "messages": [],
              "futureTopLevel": {"x": 1}
            }"#,
        );
        let store = read_chat_store(dir.path());
        assert_eq!(store.rooms.len(), 1);
        assert_eq!(store.rooms[0].purpose, None);
        assert!(store.messages.is_empty());
    }

    #[test]
    fn malformed_file_yields_empty_store() {
        let dir = TempDir::new().unwrap();
        write_store(&dir, "not json");
        let store = read_chat_store(dir.path());
        assert!(store.rooms.is_empty());
        assert!(store.messages.is_empty());
    }
}
