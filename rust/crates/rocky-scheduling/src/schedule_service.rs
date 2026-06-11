//! Schedule service: lifecycle + due-detection over a [`ScheduleStore`].
//!
//! Port of `core/packages/server/src/server/schedule/service.ts`. The agent
//! launch side-effect (TS `executeSchedule`) is intentionally *not* performed
//! here; it is delegated to a [`ScheduleExecutor`] supplied by the daemon. This
//! module covers the pure store-mutating logic: create / list / inspect /
//! update / pause / resume / delete, run recording with completion + expiry
//! transitions (`finishRun`, service.ts lines 469-512), and due detection.

use std::future::Future;

use rocky_store::{
    ScheduleCadence, ScheduleRun, ScheduleStatus, ScheduleTarget, StoredSchedule,
};
use time::OffsetDateTime;

use crate::cron::{next_run_after, validate_cadence, CronError};
use crate::schedule_store::{ScheduleStore, ScheduleStoreError};
use crate::time_util::{parse_iso, to_iso_millis};

#[derive(Debug, thiserror::Error)]
pub enum ScheduleServiceError {
    #[error("Schedule not found: {0}")]
    NotFound(String),
    #[error("Schedule prompt is required")]
    EmptyPrompt,
    #[error("maxRuns must be a positive integer")]
    InvalidMaxRuns,
    #[error("provider cannot be empty")]
    EmptyProvider,
    #[error("cwd cannot be empty")]
    EmptyCwd,
    #[error("Schedule {0} is already completed")]
    AlreadyCompleted(String),
    #[error("new-agent config updates are only valid for new-agent target schedules")]
    NotNewAgentTarget,
    #[error(transparent)]
    Cron(#[from] CronError),
    #[error(transparent)]
    Store(#[from] ScheduleStoreError),
}

/// Side-effecting agent launcher for a fired schedule. The service never calls
/// this during store mutations; the daemon's tick loop invokes it and feeds the
/// resulting [`ScheduleRun`] back through [`ScheduleService::record_run`].
///
/// Mirrors TS `ScheduleService.executeSchedule` (service.ts lines 514-606),
/// kept out of this crate so scheduling logic stays pure and testable.
pub trait ScheduleExecutor {
    fn run_target(
        &self,
        target: &ScheduleTarget,
    ) -> impl Future<Output = anyhow::Result<ScheduleRun>> + Send;
}

type Clock = Box<dyn Fn() -> OffsetDateTime + Send + Sync>;

/// Input for [`ScheduleService::create_schedule`], mirroring TS
/// `CreateScheduleInput` (service.ts `create`, lines 185-210).
#[derive(Debug, Clone)]
pub struct CreateScheduleInput {
    pub name: Option<String>,
    pub prompt: String,
    pub cadence: ScheduleCadence,
    pub target: ScheduleTarget,
    pub expires_at: Option<String>,
    pub max_runs: Option<i64>,
    /// Defaults to `cadence == every` when `None`, matching
    /// `runOnCreate ?? input.cadence.type === "every"` (service.ts line 188).
    pub run_on_create: Option<bool>,
}

/// Patch for a `new-agent` target, mirroring `applyNewAgentConfig`
/// (service.ts lines 51-86). Each `Some` field is applied; `Some(None)` clears
/// an optional field (model / modeId).
#[derive(Debug, Clone, Default)]
pub struct NewAgentConfigPatch {
    pub provider: Option<String>,
    pub cwd: Option<String>,
    pub model: Option<Option<String>>,
    pub mode_id: Option<Option<String>>,
}

/// Input for [`ScheduleService::update`], mirroring TS `UpdateScheduleInput`
/// (service.ts `update`, lines 268-318). Outer `Option` = "field present";
/// inner `Option` (where applicable) = nullable value.
#[derive(Debug, Clone, Default)]
pub struct UpdateScheduleInput {
    pub id: String,
    pub prompt: Option<String>,
    pub name: Option<Option<String>>,
    pub cadence: Option<ScheduleCadence>,
    pub new_agent_config: Option<NewAgentConfigPatch>,
    pub max_runs: Option<Option<i64>>,
    pub expires_at: Option<Option<String>>,
}

pub struct ScheduleService {
    store: ScheduleStore,
    now: Clock,
}

/// Port of `normalizePrompt` (service.ts lines 44-50).
fn normalize_prompt(prompt: &str) -> Result<String, ScheduleServiceError> {
    let trimmed = prompt.trim();
    if trimmed.is_empty() {
        return Err(ScheduleServiceError::EmptyPrompt);
    }
    Ok(trimmed.to_string())
}

/// Port of `trimOptionalName` (service.ts lines 29-36).
fn trim_optional_name(value: Option<&str>) -> Option<String> {
    let trimmed = value?.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

/// Port of `normalizeMaxRuns` (service.ts lines 88-96).
fn normalize_max_runs(value: Option<i64>) -> Result<Option<i64>, ScheduleServiceError> {
    match value {
        None => Ok(None),
        Some(v) if v > 0 => Ok(Some(v)),
        Some(_) => Err(ScheduleServiceError::InvalidMaxRuns),
    }
}

/// Timezone string for a cadence (only cron carries one).
fn cadence_tz(cadence: &ScheduleCadence) -> Option<&str> {
    match cadence {
        ScheduleCadence::Cron { timezone, .. } => timezone.as_deref(),
        ScheduleCadence::Every { .. } => None,
    }
}

/// Port of `countCompletedRuns` (service.ts lines 98-100): runs whose status is
/// not `running`.
fn count_completed_runs(schedule: &StoredSchedule) -> i64 {
    schedule
        .runs
        .iter()
        .filter(|run| !matches!(run.status, rocky_store::ScheduleRunStatus::Running))
        .count() as i64
}

/// Port of `shouldCompleteSchedule` (service.ts lines 102-110).
fn should_complete(schedule: &StoredSchedule, now: OffsetDateTime) -> bool {
    if let Some(expires) = schedule.expires_at.as_deref() {
        if let Some(expires_at) = parse_iso(expires) {
            if expires_at <= now {
                return true;
            }
        }
    }
    match schedule.max_runs {
        None => false,
        Some(max) => count_completed_runs(schedule) >= max,
    }
}

/// Port of `completeSchedule` (service.ts lines 112-120).
fn complete_schedule(mut schedule: StoredSchedule, now: OffsetDateTime) -> StoredSchedule {
    schedule.status = ScheduleStatus::Completed;
    schedule.next_run_at = None;
    schedule.paused_at = None;
    schedule.updated_at = to_iso_millis(now);
    schedule
}

impl ScheduleService {
    /// Construct a service over `store` using the system clock.
    pub fn new(store: ScheduleStore) -> Self {
        Self {
            store,
            now: Box::new(OffsetDateTime::now_utc),
        }
    }

    /// Construct a service with an injectable clock (for tests / determinism),
    /// matching the TS `now` option.
    pub fn with_clock(
        store: ScheduleStore,
        now: impl Fn() -> OffsetDateTime + Send + Sync + 'static,
    ) -> Self {
        Self {
            store,
            now: Box::new(now),
        }
    }

    fn now(&self) -> OffsetDateTime {
        (self.now)()
    }

    /// Create + persist a schedule (service.ts `create`, lines 185-210).
    pub fn create_schedule(
        &self,
        input: CreateScheduleInput,
    ) -> Result<StoredSchedule, ScheduleServiceError> {
        let now = self.now();
        let prompt = normalize_prompt(&input.prompt)?;
        validate_cadence(&input.cadence)?;
        let run_on_create = input
            .run_on_create
            .unwrap_or(matches!(input.cadence, ScheduleCadence::Every { .. }));
        let next_run_at = if run_on_create {
            now
        } else {
            next_run_after(&input.cadence, now, cadence_tz(&input.cadence))?
        };
        let now_iso = to_iso_millis(now);
        let record = StoredSchedule {
            id: String::new(),
            name: trim_optional_name(input.name.as_deref()),
            prompt,
            cadence: input.cadence,
            target: input.target,
            status: ScheduleStatus::Active,
            created_at: now_iso.clone(),
            updated_at: now_iso,
            next_run_at: Some(to_iso_millis(next_run_at)),
            last_run_at: None,
            paused_at: None,
            expires_at: input.expires_at,
            max_runs: normalize_max_runs(input.max_runs)?,
            runs: Vec::new(),
        };
        Ok(self.store.create(record)?)
    }

    /// List schedules sorted by `createdAt` ascending.
    pub fn list(&self) -> Vec<StoredSchedule> {
        self.store.list()
    }

    /// Fetch a schedule or error (service.ts `inspect`, lines 216-222).
    pub fn inspect(&self, id: &str) -> Result<StoredSchedule, ScheduleServiceError> {
        self.store
            .get(id)?
            .ok_or_else(|| ScheduleServiceError::NotFound(id.to_string()))
    }

    /// Pause an active schedule (service.ts `pause`, lines 229-247): clears
    /// `nextRunAt`, sets `pausedAt`. Completed schedules error; already-paused
    /// schedules are returned unchanged.
    pub fn pause(&self, id: &str) -> Result<StoredSchedule, ScheduleServiceError> {
        let schedule = self.inspect(id)?;
        match schedule.status {
            ScheduleStatus::Completed => {
                return Err(ScheduleServiceError::AlreadyCompleted(id.to_string()))
            }
            ScheduleStatus::Paused => return Ok(schedule),
            ScheduleStatus::Active => {}
        }
        let now = self.now();
        let now_iso = to_iso_millis(now);
        let paused = StoredSchedule {
            status: ScheduleStatus::Paused,
            next_run_at: None,
            paused_at: Some(now_iso.clone()),
            updated_at: now_iso,
            ..schedule
        };
        self.store.put(&paused)?;
        Ok(paused)
    }

    /// Resume a paused schedule (service.ts `resume`, lines 249-266):
    /// recomputes `nextRunAt`, clears `pausedAt`.
    pub fn resume(&self, id: &str) -> Result<StoredSchedule, ScheduleServiceError> {
        let schedule = self.inspect(id)?;
        match schedule.status {
            ScheduleStatus::Completed => {
                return Err(ScheduleServiceError::AlreadyCompleted(id.to_string()))
            }
            ScheduleStatus::Active => return Ok(schedule),
            ScheduleStatus::Paused => {}
        }
        let now = self.now();
        let next = next_run_after(&schedule.cadence, now, cadence_tz(&schedule.cadence))?;
        let now_iso = to_iso_millis(now);
        let resumed = StoredSchedule {
            status: ScheduleStatus::Active,
            paused_at: None,
            next_run_at: Some(to_iso_millis(next)),
            updated_at: now_iso,
            ..schedule
        };
        self.store.put(&resumed)?;
        Ok(resumed)
    }

    /// Apply an update (service.ts `update`, lines 268-318).
    pub fn update(
        &self,
        input: UpdateScheduleInput,
    ) -> Result<StoredSchedule, ScheduleServiceError> {
        let mut updated = self.inspect(&input.id)?;
        let now = self.now();

        if let Some(prompt) = input.prompt {
            updated.prompt = normalize_prompt(&prompt)?;
        }
        if let Some(name) = input.name {
            updated.name = trim_optional_name(name.as_deref());
        }
        if let Some(cadence) = input.cadence {
            validate_cadence(&cadence)?;
            updated.next_run_at = if updated.status == ScheduleStatus::Active {
                Some(to_iso_millis(next_run_after(&cadence, now, cadence_tz(&cadence))?))
            } else {
                None
            };
            updated.cadence = cadence;
        }
        if let Some(patch) = input.new_agent_config {
            updated.target = apply_new_agent_config(updated.target, patch)?;
        }
        if let Some(max_runs) = input.max_runs {
            updated.max_runs = normalize_max_runs(max_runs)?;
        }
        if let Some(expires_at) = input.expires_at {
            updated.expires_at = expires_at;
        }

        updated.updated_at = to_iso_millis(now);
        self.store.put(&updated)?;
        Ok(updated)
    }

    /// Delete a schedule (service.ts `delete`, lines 320-322).
    pub fn delete(&self, id: &str) -> Result<(), ScheduleServiceError> {
        Ok(self.store.delete(id)?)
    }

    /// Append a completed run and advance lifecycle, mirroring the non-manual
    /// path of `finishRun` (service.ts lines 469-512): record `lastRunAt`, then
    /// complete (maxRuns / expiresAt), clear `nextRunAt` if paused, or advance
    /// `nextRunAt` past `now`.
    pub fn record_run(
        &self,
        id: &str,
        run: ScheduleRun,
    ) -> Result<StoredSchedule, ScheduleServiceError> {
        let schedule = self.inspect(id)?;
        let now = self.now();
        let now_iso = to_iso_millis(now);

        // `after` baseline for cadence advancement uses the pre-update nextRunAt
        // (service.ts line 506), captured before we mutate the record.
        let prior_next = schedule.next_run_at.clone();

        let mut updated = schedule;
        updated.runs.push(run);
        updated.last_run_at = Some(now_iso.clone());
        updated.updated_at = now_iso.clone();

        if should_complete(&updated, now) {
            updated = complete_schedule(updated, now);
        } else if updated.status == ScheduleStatus::Paused {
            updated.next_run_at = None;
        } else {
            let after = prior_next
                .as_deref()
                .and_then(parse_iso)
                .unwrap_or(now);
            let tz = cadence_tz(&updated.cadence).map(str::to_string);
            let mut next = next_run_after(&updated.cadence, after, tz.as_deref())?;
            while next <= now {
                next = next_run_after(&updated.cadence, next, tz.as_deref())?;
            }
            updated.next_run_at = Some(to_iso_millis(next));
        }

        self.store.put(&updated)?;
        Ok(updated)
    }

    /// Schedules that are active and due (`nextRunAt <= now`), mirroring the
    /// tick gate (service.ts `tick`, lines 358-376). Completion/expiry are not
    /// applied here; callers run them via [`Self::record_run`].
    pub fn due_schedules(&self, now: OffsetDateTime) -> Vec<StoredSchedule> {
        self.store
            .list()
            .into_iter()
            .filter(|schedule| schedule.status == ScheduleStatus::Active)
            .filter(|schedule| {
                schedule
                    .next_run_at
                    .as_deref()
                    .and_then(parse_iso)
                    .is_some_and(|next| next <= now)
            })
            .collect()
    }

    /// Borrow the backing store.
    pub fn store(&self) -> &ScheduleStore {
        &self.store
    }
}

/// Port of `applyNewAgentConfig` (service.ts lines 51-86).
fn apply_new_agent_config(
    target: ScheduleTarget,
    patch: NewAgentConfigPatch,
) -> Result<ScheduleTarget, ScheduleServiceError> {
    let ScheduleTarget::NewAgent { mut config } = target else {
        return Err(ScheduleServiceError::NotNewAgentTarget);
    };
    if let Some(provider) = patch.provider {
        let trimmed = provider.trim();
        if trimmed.is_empty() {
            return Err(ScheduleServiceError::EmptyProvider);
        }
        config.provider = trimmed.to_string();
    }
    if let Some(cwd) = patch.cwd {
        let trimmed = cwd.trim();
        if trimmed.is_empty() {
            return Err(ScheduleServiceError::EmptyCwd);
        }
        config.cwd = trimmed.to_string();
    }
    if let Some(model) = patch.model {
        config.model = model
            .and_then(|m| {
                let t = m.trim().to_string();
                if t.is_empty() {
                    None
                } else {
                    Some(t)
                }
            });
    }
    if let Some(mode_id) = patch.mode_id {
        config.mode_id = mode_id.and_then(|m| {
            let t = m.trim().to_string();
            if t.is_empty() {
                None
            } else {
                Some(t)
            }
        });
    }
    Ok(ScheduleTarget::NewAgent { config })
}

#[cfg(test)]
mod tests {
    use super::*;
    use rocky_store::ScheduleRunStatus;
    use tempfile::tempdir;
    use time::macros::datetime;

    fn agent_target() -> ScheduleTarget {
        ScheduleTarget::Agent {
            agent_id: "agent-1".to_string(),
        }
    }

    fn fixed_service(now: OffsetDateTime) -> (tempfile::TempDir, ScheduleService) {
        let dir = tempdir().unwrap();
        let store = ScheduleStore::new(dir.path().join("schedules"));
        let service = ScheduleService::with_clock(store, move || now);
        (dir, service)
    }

    fn every_input() -> CreateScheduleInput {
        CreateScheduleInput {
            name: Some("hourly".to_string()),
            prompt: "tick".to_string(),
            cadence: ScheduleCadence::Every { every_ms: 3_600_000 },
            target: agent_target(),
            expires_at: None,
            max_runs: None,
            run_on_create: Some(false),
        }
    }

    fn run(status: ScheduleRunStatus) -> ScheduleRun {
        ScheduleRun {
            id: "run-1".to_string(),
            scheduled_for: "2026-01-01T00:00:00.000Z".to_string(),
            started_at: "2026-01-01T00:00:00.000Z".to_string(),
            ended_at: Some("2026-01-01T00:00:05.000Z".to_string()),
            status,
            agent_id: Some("agent-1".to_string()),
            output: Some("done".to_string()),
            error: None,
        }
    }

    #[test]
    fn create_sets_next_run_and_active() {
        let now = datetime!(2026-01-01 00:00:00 UTC);
        let (_d, service) = fixed_service(now);
        let created = service.create_schedule(every_input()).unwrap();
        assert_eq!(created.status, ScheduleStatus::Active);
        // run_on_create=false => next is now + everyMs.
        assert_eq!(created.next_run_at.as_deref(), Some("2026-01-01T01:00:00.000Z"));
        assert_eq!(created.id.len(), 8);
    }

    #[test]
    fn empty_prompt_rejected() {
        let now = datetime!(2026-01-01 00:00:00 UTC);
        let (_d, service) = fixed_service(now);
        let mut input = every_input();
        input.prompt = "   ".to_string();
        assert!(matches!(
            service.create_schedule(input),
            Err(ScheduleServiceError::EmptyPrompt)
        ));
    }

    #[test]
    fn due_schedules_only_active_past_due() {
        let now = datetime!(2026-01-01 02:00:00 UTC);
        let dir = tempdir().unwrap();
        let store = ScheduleStore::new(dir.path().join("schedules"));
        // Build via a service whose clock is 01:00 so nextRunAt = 02:00 (due at now).
        let early = datetime!(2026-01-01 01:00:00 UTC);
        let svc_early = ScheduleService::with_clock(store.clone(), move || early);
        let due = svc_early.create_schedule(every_input()).unwrap();
        // A future schedule: clock at 02:00, next = 03:00 (not due).
        let svc_now = ScheduleService::with_clock(store.clone(), move || now);
        let future = svc_now.create_schedule(every_input()).unwrap();
        // A paused schedule (not due regardless).
        let paused = svc_now.create_schedule(every_input()).unwrap();
        svc_now.pause(&paused.id).unwrap();

        let result = svc_now.due_schedules(now);
        let ids: Vec<&str> = result.iter().map(|s| s.id.as_str()).collect();
        assert!(ids.contains(&due.id.as_str()));
        assert!(!ids.contains(&future.id.as_str()));
        assert!(!ids.contains(&paused.id.as_str()));
    }

    #[test]
    fn record_run_appends_and_advances() {
        let now = datetime!(2026-01-01 01:00:30 UTC);
        let dir = tempdir().unwrap();
        let store = ScheduleStore::new(dir.path().join("schedules"));
        let early = datetime!(2026-01-01 00:00:00 UTC);
        let svc_early = ScheduleService::with_clock(store.clone(), move || early);
        let created = svc_early.create_schedule(every_input()).unwrap(); // next = 01:00:00
        let svc = ScheduleService::with_clock(store, move || now);
        let updated = svc.record_run(&created.id, run(ScheduleRunStatus::Succeeded)).unwrap();
        assert_eq!(updated.runs.len(), 1);
        assert_eq!(updated.last_run_at.as_deref(), Some("2026-01-01T01:00:30.000Z"));
        // after = prior next (01:00) + everyMs = 02:00, which is > now.
        assert_eq!(updated.next_run_at.as_deref(), Some("2026-01-01T02:00:00.000Z"));
        assert_eq!(updated.status, ScheduleStatus::Active);
    }

    #[test]
    fn max_runs_reached_completes() {
        let now = datetime!(2026-01-01 01:00:30 UTC);
        let dir = tempdir().unwrap();
        let store = ScheduleStore::new(dir.path().join("schedules"));
        let early = datetime!(2026-01-01 00:00:00 UTC);
        let mut input = every_input();
        input.max_runs = Some(1);
        let svc_early = ScheduleService::with_clock(store.clone(), move || early);
        let created = svc_early.create_schedule(input).unwrap();
        let svc = ScheduleService::with_clock(store, move || now);
        let updated = svc.record_run(&created.id, run(ScheduleRunStatus::Succeeded)).unwrap();
        assert_eq!(updated.status, ScheduleStatus::Completed);
        assert_eq!(updated.next_run_at, None);
    }

    #[test]
    fn expires_at_past_completes() {
        let now = datetime!(2026-01-01 01:00:30 UTC);
        let dir = tempdir().unwrap();
        let store = ScheduleStore::new(dir.path().join("schedules"));
        let early = datetime!(2026-01-01 00:00:00 UTC);
        let mut input = every_input();
        input.expires_at = Some("2026-01-01T00:30:00.000Z".to_string());
        let svc_early = ScheduleService::with_clock(store.clone(), move || early);
        let created = svc_early.create_schedule(input).unwrap();
        let svc = ScheduleService::with_clock(store, move || now);
        let updated = svc.record_run(&created.id, run(ScheduleRunStatus::Succeeded)).unwrap();
        assert_eq!(updated.status, ScheduleStatus::Completed);
    }

    #[test]
    fn pause_then_resume_transitions() {
        let now = datetime!(2026-01-01 00:00:00 UTC);
        let (_d, service) = fixed_service(now);
        let created = service.create_schedule(every_input()).unwrap();
        let paused = service.pause(&created.id).unwrap();
        assert_eq!(paused.status, ScheduleStatus::Paused);
        assert_eq!(paused.next_run_at, None);
        assert!(paused.paused_at.is_some());
        // Pausing again is idempotent.
        let again = service.pause(&created.id).unwrap();
        assert_eq!(again.status, ScheduleStatus::Paused);
        let resumed = service.resume(&created.id).unwrap();
        assert_eq!(resumed.status, ScheduleStatus::Active);
        assert_eq!(resumed.paused_at, None);
        assert_eq!(resumed.next_run_at.as_deref(), Some("2026-01-01T01:00:00.000Z"));
    }

    #[test]
    fn paused_record_run_clears_next() {
        let now = datetime!(2026-01-01 01:00:30 UTC);
        let dir = tempdir().unwrap();
        let store = ScheduleStore::new(dir.path().join("schedules"));
        let early = datetime!(2026-01-01 00:00:00 UTC);
        let svc_early = ScheduleService::with_clock(store.clone(), move || early);
        let created = svc_early.create_schedule(every_input()).unwrap();
        svc_early.pause(&created.id).unwrap();
        let svc = ScheduleService::with_clock(store, move || now);
        let updated = svc.record_run(&created.id, run(ScheduleRunStatus::Failed)).unwrap();
        // Paused + not complete => nextRunAt cleared.
        assert_eq!(updated.status, ScheduleStatus::Paused);
        assert_eq!(updated.next_run_at, None);
    }

    #[test]
    fn executor_trait_is_usable() {
        // Compile-time + runtime check that ScheduleExecutor can be implemented
        // and the returned run threaded through record_run.
        struct Exec;
        impl ScheduleExecutor for Exec {
            async fn run_target(&self, _target: &ScheduleTarget) -> anyhow::Result<ScheduleRun> {
                Ok(run(ScheduleRunStatus::Succeeded))
            }
        }
        let now = datetime!(2026-01-01 00:00:00 UTC);
        let (_d, service) = fixed_service(now);
        let created = service.create_schedule(every_input()).unwrap();
        let rt = tokio::runtime::Builder::new_current_thread().build().unwrap();
        let produced = rt.block_on(async { Exec.run_target(&created.target).await.unwrap() });
        let updated = service.record_run(&created.id, produced).unwrap();
        assert_eq!(updated.runs.len(), 1);
    }
}
