//! File-backed Mission Control domain for `rockyd`.
//!
//! A Rust port of the TypeScript Mission Control implementation:
//! - Schemas: `core/packages/protocol/src/mission/types.ts`
//! - Service: `core/packages/server/src/server/mission-control/service.ts`
//!
//! Missions are persisted as one `{missionId}.json` file per mission under
//! `$ROCKY_HOME/missions`, written atomically via `rocky-store`. When a
//! mission's `boardPath` is set, a Markdown team-board projection is written
//! alongside it.

mod board;
mod clock;
mod error;
mod service;
mod types;

pub use board::render_mission_board;
pub use clock::{now_iso8601, trim_to_millis};
pub use error::MissionControlError;
pub use service::{
    CreateMissionInput, CreateMissionTaskInput, FileBackedMissionControlService,
    UpdateMissionInput, UpdateMissionTaskInput,
};
pub use types::{
    MissionEvent, MissionRecord, MissionStatus, MissionTask, MissionTaskIsolation,
    MissionTaskStatus, MissionVerification, MissionVerificationKind, MissionVersion,
};
