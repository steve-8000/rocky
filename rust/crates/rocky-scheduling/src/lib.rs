//! Schedule store/runner + loop service for `rockyd`.
//!
//! Phase 7 write layer over the read-only projections in `rocky-store`. Ported
//! from the TS server:
//! - `core/packages/server/src/server/schedule/store.ts`
//! - `core/packages/server/src/server/schedule/cron.ts`
//! - `core/packages/server/src/server/schedule/service.ts`
//! - `core/packages/server/src/server/loop-service.ts`
//!
//! Agent-launch side-effects are delegated through the [`ScheduleExecutor`] and
//! [`LoopExecutor`] traits; this crate only owns the persisted-state logic.

mod cron;
mod loop_service;
mod schedule_service;
mod schedule_store;
mod time_util;

pub use cron::{next_run_after, validate_cadence, CronError};
pub use loop_service::{LogInput, LoopExecutor, LoopService, LoopServiceError};
pub use schedule_service::{
    CreateScheduleInput, NewAgentConfigPatch, ScheduleExecutor, ScheduleService,
    ScheduleServiceError, UpdateScheduleInput,
};
pub use schedule_store::{ScheduleStore, ScheduleStoreError};
