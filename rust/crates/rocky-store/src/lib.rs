//! Persistence primitives for `rockyd`: atomic JSON writes and the daemon
//! singleton pid-lock.
//!
//! Source baseline:
//! - `core/packages/server/src/server/pid-lock.ts`
//! - `core/packages/server/src/server/atomic-file.ts`

mod atomic;
mod pid_lock;
mod server_id;

// Phase 3 read-only projections of `$ROCKY_HOME` data. Each module parses an
// existing on-disk format permissively (unknown fields ignored) so the Rust
// daemon can reconstruct UI state from a real home in place.
pub mod agents;
pub mod chat;
pub mod keypair;
pub mod loops;
pub mod registry;
pub mod schedules;

pub use atomic::{write_file_atomic, write_json_atomic, AtomicWriteError};
pub use pid_lock::{
    acquire_pid_lock, get_pid_lock_info, is_locked, is_pid_running, release_pid_lock,
    update_pid_lock, LockState, PidLockError, PidLockInfo,
};
pub use server_id::get_or_create_server_id;
pub use chat::{
    list_rooms, messages_for_room, read_chat_store, ChatMessage, ChatRoom, ChatStore,
};
pub use registry::{
    read_projects, read_workspaces, PersistedProjectRecord, PersistedWorkspaceRecord, ProjectKind,
};
pub use agents::{
    list_agent_records, parse_stored_agent_record, project_dir_name_from_cwd, read_agent_record,
    AgentStatus, AttentionReason, PersistenceHandle, RuntimeInfo, SerializableAgentConfig,
    StoredAgentRecord,
};
pub use keypair::{read_daemon_keypair, StoredKeyPair};
pub use loops::{
    read_loops, LoopIterationRecord, LoopListItem, LoopLogEntry, LoopLogLevel, LoopLogSource,
    LoopRecord, LoopStatus, LoopVerifyCheckResult, LoopVerifyPromptResult, LoopWorkerOutcome,
};
pub use schedules::{
    list_schedules, read_schedule, ScheduleCadence, ScheduleNewAgentConfig, ScheduleRun,
    ScheduleRunStatus, ScheduleStatus, ScheduleTarget, StoredSchedule,
};
