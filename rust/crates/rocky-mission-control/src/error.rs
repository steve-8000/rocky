//! Error type for Mission Control, mirroring the TS `MissionControlError`
//! string codes in
//! `core/packages/server/src/server/mission-control/service.ts` (lines 18-26).
//!
//! The TS class carries a `code` string set at each throw site:
//! - `"invalid_mission_input"` (requireText, service.ts lines 87-93)
//! - `"mission_not_found"` (readMissionFile ENOENT, service.ts lines 327-345)
//! - `"mission_task_not_found"` (updateTask, service.ts lines 277-282)
//! - `"invalid_mission_id"` (filePathFor, service.ts lines 347-353)

use thiserror::Error;

/// Failure modes for Mission Control operations. Variants map 1:1 to the TS
/// `MissionControlError` codes; `code()` returns the exact string the TS daemon
/// would set on `error.code`.
#[derive(Debug, Error)]
pub enum MissionControlError {
    /// A mission file does not exist (TS code `mission_not_found`).
    #[error("Mission not found: {0}")]
    MissionNotFound(String),

    /// A mission task id was not found in the mission (TS code
    /// `mission_task_not_found`).
    #[error("Mission task not found: {0}")]
    MissionTaskNotFound(String),

    /// A mission id contains a path separator (TS code `invalid_mission_id`).
    #[error("Invalid mission id: {0}")]
    InvalidMissionId(String),

    /// A required text field was empty after trimming (TS code
    /// `invalid_mission_input`).
    #[error("{0} is required")]
    InvalidMissionInput(String),

    /// An on-disk mission file could not be parsed as a `MissionRecord`.
    #[error("failed to parse mission file: {0}")]
    Parse(#[from] serde_json::Error),

    /// An atomic write of a mission file or board projection failed.
    #[error(transparent)]
    Write(#[from] rocky_store::AtomicWriteError),

    /// An unexpected filesystem error (anything other than ENOENT on read).
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

impl MissionControlError {
    /// The stable string code matching the TS `MissionControlError.code`.
    /// Variants without a TS analogue map to the closest daemon code.
    pub fn code(&self) -> &'static str {
        match self {
            MissionControlError::MissionNotFound(_) => "mission_not_found",
            MissionControlError::MissionTaskNotFound(_) => "mission_task_not_found",
            MissionControlError::InvalidMissionId(_) => "invalid_mission_id",
            MissionControlError::InvalidMissionInput(_) => "invalid_mission_input",
            MissionControlError::Parse(_) => "mission_parse_error",
            MissionControlError::Write(_) => "mission_write_error",
            MissionControlError::Io(_) => "mission_io_error",
        }
    }
}
