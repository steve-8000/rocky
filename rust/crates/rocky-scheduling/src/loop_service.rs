//! Loop service over `$ROCKY_HOME/loops/loops.json` (a bare JSON array).
//!
//! Port of the store-mutating surface of
//! `core/packages/server/src/server/loop-service.ts` (`LoopService`). The
//! agent-driven worker/verifier execution (`executeLoop` and friends,
//! loop-service.ts lines 488-820) is a side-effect delegated to a
//! [`LoopExecutor`]; this crate owns the persisted-state operations: create,
//! list, inspect, append_log, append_iteration, stop, and crash recovery.
//!
//! Records are held in memory keyed by id and re-persisted on every mutation,
//! sorted by `createdAt` ascending, matching `LoopService.persist`
//! (loop-service.ts lines 922-935). On-disk bytes go through
//! `rocky-store::write_json_atomic`, identical to `writeJsonFileAtomic`.

use std::collections::HashMap;
use std::future::Future;
use std::path::PathBuf;

use rand::Rng;
use rocky_store::{
    read_loops, write_json_atomic, LoopIterationRecord, LoopListItem, LoopLogEntry, LoopLogLevel,
    LoopLogSource, LoopRecord, LoopStatus,
};

use crate::time_util::to_iso_millis;
use time::OffsetDateTime;

const LOOP_ID_LENGTH: usize = 8;

#[derive(Debug, thiserror::Error)]
pub enum LoopServiceError {
    #[error("Loop id is required")]
    EmptyId,
    #[error("Loop not found: {0}")]
    NotFound(String),
    #[error("Loop id prefix is ambiguous: {0}")]
    AmbiguousPrefix(String),
    #[error(transparent)]
    Write(#[from] rocky_store::AtomicWriteError),
}

/// Side-effecting loop driver (worker + verifier agents). Kept out of this
/// crate so loop bookkeeping stays pure; the daemon implements it and feeds
/// iteration/log records back via the service mutators. Mirrors TS
/// `LoopService.executeLoop` (loop-service.ts lines 488-583).
pub trait LoopExecutor {
    fn drive(&self, loop_id: &str) -> impl Future<Output = anyhow::Result<()>> + Send;
}

type Clock = Box<dyn Fn() -> OffsetDateTime + Send + Sync>;

/// A log entry without the auto-assigned `seq`/`timestamp`, mirroring the
/// `Omit<LoopLogEntry, "seq" | "timestamp">` argument to `appendLog`
/// (loop-service.ts lines 900-908).
#[derive(Debug, Clone)]
pub struct LogInput {
    pub iteration: Option<i64>,
    pub source: LoopLogSource,
    pub level: LoopLogLevel,
    pub text: String,
}

pub struct LoopService {
    store_path: PathBuf,
    loops: HashMap<String, LoopRecord>,
    now: Clock,
    loaded: bool,
}

/// Generate an 8-char id from a UUID-v4 hex prefix, matching
/// `randomUUID().replace(/-/g, "").slice(0, 8)` (loop-service.ts lines 163-165):
/// 8 lowercase hex chars.
fn create_loop_id() -> String {
    let mut rng = rand::thread_rng();
    let mut id = String::with_capacity(LOOP_ID_LENGTH);
    for _ in 0..LOOP_ID_LENGTH {
        let nibble: u8 = rng.gen_range(0..16);
        id.push(char::from_digit(nibble as u32, 16).unwrap());
    }
    id
}

impl LoopService {
    /// Construct a service whose store lives at `<rocky_home>/loops/loops.json`.
    pub fn new(rocky_home: impl Into<PathBuf>) -> Self {
        let rocky_home = rocky_home.into();
        Self {
            store_path: rocky_home.join("loops").join("loops.json"),
            loops: HashMap::new(),
            now: Box::new(OffsetDateTime::now_utc),
            loaded: false,
        }
    }

    /// Construct with an injectable clock for deterministic tests.
    pub fn with_clock(
        rocky_home: impl Into<PathBuf>,
        now: impl Fn() -> OffsetDateTime + Send + Sync + 'static,
    ) -> Self {
        let rocky_home = rocky_home.into();
        Self {
            store_path: rocky_home.join("loops").join("loops.json"),
            loops: HashMap::new(),
            now: Box::new(now),
            loaded: false,
        }
    }

    fn now_iso(&self) -> String {
        to_iso_millis((self.now)())
    }

    /// The directory `<rocky_home>` reconstructed from the store path; used to
    /// feed the read-only `read_loops` parser.
    fn rocky_home(&self) -> PathBuf {
        // store_path = <home>/loops/loops.json
        self.store_path
            .parent()
            .and_then(|p| p.parent())
            .map(PathBuf::from)
            .unwrap_or_default()
    }

    /// Load records from disk and reconcile crash state. Idempotent: subsequent
    /// calls are no-ops once loaded. Mirrors `LoopService.initialize`
    /// (loop-service.ts lines 320-362) including the running-loop recovery, and
    /// re-persists afterward.
    pub fn reconcile_on_startup(&mut self) -> Result<(), LoopServiceError> {
        if self.loaded {
            return Ok(());
        }
        self.loops.clear();
        let records = read_loops(&self.rocky_home());
        for record in records {
            if record.status == LoopStatus::Running {
                let recovered = self.recover_running(record);
                self.loops.insert(recovered.id.clone(), recovered);
            } else {
                self.loops.insert(record.id.clone(), record);
            }
        }
        self.loaded = true;
        self.persist()
    }

    /// Reconcile a single orphaned running loop: status -> stopped, set
    /// completedAt/stopRequestedAt, clear active markers, append an interrupt
    /// log, and mark a trailing running iteration as stopped (loop-service.ts
    /// lines 327-353).
    fn recover_running(&self, mut record: LoopRecord) -> LoopRecord {
        let now = self.now_iso();
        record.status = LoopStatus::Stopped;
        record.updated_at = now.clone();
        record.completed_at = Some(now.clone());
        record.stop_requested_at = Some(now.clone());
        record.active_iteration = None;
        record.active_worker_agent_id = None;
        record.active_verifier_agent_id = None;
        Self::push_log(
            &mut record,
            &now,
            LogInput {
                iteration: None,
                source: LoopLogSource::Loop,
                level: LoopLogLevel::Error,
                text: "Loop was interrupted by daemon restart.".to_string(),
            },
        );
        if let Some(last) = record.iterations.last_mut() {
            if last.status == LoopStatus::Running {
                last.status = LoopStatus::Stopped;
                last.failure_reason = Some("Daemon restarted".to_string());
                last.worker_completed_at = Some(now);
            }
        }
        record
    }

    /// Create a loop record in `running` state and persist it. Mirrors the
    /// record-construction half of `runLoop` (loop-service.ts lines 366-430);
    /// the execution future is the caller's responsibility (see
    /// [`LoopExecutor`]).
    pub fn create(&mut self, mut record: LoopRecord) -> Result<LoopRecord, LoopServiceError> {
        self.reconcile_on_startup()?;
        let now = self.now_iso();
        record.id = self.unique_loop_id();
        record.status = LoopStatus::Running;
        record.created_at = now.clone();
        record.updated_at = now.clone();
        record.started_at = now.clone();
        record.completed_at = None;
        record.stop_requested_at = None;
        record.iterations.clear();
        record.logs.clear();
        record.next_log_seq = 1;
        record.active_iteration = None;
        record.active_worker_agent_id = None;
        record.active_verifier_agent_id = None;
        let created_text = format!("Loop created in {}", record.cwd);
        Self::push_log(
            &mut record,
            &now,
            LogInput {
                iteration: None,
                source: LoopLogSource::Loop,
                level: LoopLogLevel::Info,
                text: created_text,
            },
        );
        let id = record.id.clone();
        self.loops.insert(id.clone(), record);
        self.persist()?;
        Ok(self.loops.get(&id).cloned().expect("just inserted"))
    }

    fn unique_loop_id(&self) -> String {
        loop {
            let id = create_loop_id();
            if !self.loops.contains_key(&id) {
                return id;
            }
        }
    }

    /// List loops sorted by `createdAt` descending, matching `listLoops`
    /// (loop-service.ts lines 432-446). Returns the compact `LoopListItem`.
    pub fn list(&mut self) -> Result<Vec<LoopListItem>, LoopServiceError> {
        self.reconcile_on_startup()?;
        let mut records: Vec<&LoopRecord> = self.loops.values().collect();
        records.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        Ok(records.iter().map(|r| r.to_list_item()).collect())
    }

    /// Inspect a loop by id or unambiguous id prefix (`inspectLoop` /
    /// `requireLoop`, loop-service.ts lines 448-453 + 882-898).
    pub fn inspect(&mut self, id_or_prefix: &str) -> Result<LoopRecord, LoopServiceError> {
        self.reconcile_on_startup()?;
        self.require_loop(id_or_prefix).cloned()
    }

    /// Append a log entry, assigning the next `seq` and a timestamp, and
    /// persist. Mirrors `appendLog` (loop-service.ts lines 900-908).
    pub fn append_log(
        &mut self,
        id_or_prefix: &str,
        entry: LogInput,
    ) -> Result<LoopLogEntry, LoopServiceError> {
        self.reconcile_on_startup()?;
        let now = self.now_iso();
        let id = self.require_loop(id_or_prefix)?.id.clone();
        let appended = {
            let record = self.loops.get_mut(&id).expect("resolved id");
            Self::push_log(record, &now, entry)
        };
        self.persist()?;
        Ok(appended)
    }

    /// Append a completed iteration record and persist. Helper for daemon-side
    /// executors recording iteration outcomes; mirrors the
    /// `loop.iterations.push(...)` paths in `executeLoop`
    /// (loop-service.ts lines 519-525).
    pub fn append_iteration(
        &mut self,
        id_or_prefix: &str,
        iteration: LoopIterationRecord,
    ) -> Result<LoopRecord, LoopServiceError> {
        self.reconcile_on_startup()?;
        let now = self.now_iso();
        let id = self.require_loop(id_or_prefix)?.id.clone();
        {
            let record = self.loops.get_mut(&id).expect("resolved id");
            record.iterations.push(iteration);
            record.updated_at = now;
        }
        self.persist()?;
        Ok(self.loops.get(&id).cloned().expect("resolved id"))
    }

    /// Stop a loop. For a running loop with no live worker (the only case this
    /// crate can resolve without the executor), transition to `stopped` and set
    /// completion timestamps, matching the no-`running` branch of `stopLoop`
    /// (loop-service.ts lines 455-487). Non-running loops are returned
    /// unchanged.
    pub fn stop(&mut self, id_or_prefix: &str) -> Result<LoopRecord, LoopServiceError> {
        self.reconcile_on_startup()?;
        let now = self.now_iso();
        let id = self.require_loop(id_or_prefix)?.id.clone();
        {
            let record = self.loops.get_mut(&id).expect("resolved id");
            if record.status != LoopStatus::Running {
                return Ok(record.clone());
            }
            if record.stop_requested_at.is_none() {
                record.stop_requested_at = Some(now.clone());
            }
            record.updated_at = record.stop_requested_at.clone().unwrap_or(now.clone());
            Self::push_log(
                record,
                &now,
                LogInput {
                    iteration: record.active_iteration,
                    source: LoopLogSource::Loop,
                    level: LoopLogLevel::Info,
                    text: "Stop requested.".to_string(),
                },
            );
            record.status = LoopStatus::Stopped;
            record.completed_at = Some(now.clone());
            record.updated_at = now;
            record.active_iteration = None;
            record.active_worker_agent_id = None;
            record.active_verifier_agent_id = None;
        }
        self.persist()?;
        Ok(self.loops.get(&id).cloned().expect("resolved id"))
    }

    fn require_loop(&self, id_or_prefix: &str) -> Result<&LoopRecord, LoopServiceError> {
        let trimmed = id_or_prefix.trim();
        if trimmed.is_empty() {
            return Err(LoopServiceError::EmptyId);
        }
        if let Some(exact) = self.loops.get(trimmed) {
            return Ok(exact);
        }
        let matches: Vec<&LoopRecord> = self
            .loops
            .values()
            .filter(|r| r.id.starts_with(trimmed))
            .collect();
        match matches.len() {
            1 => Ok(matches[0]),
            0 => Err(LoopServiceError::NotFound(trimmed.to_string())),
            _ => Err(LoopServiceError::AmbiguousPrefix(trimmed.to_string())),
        }
    }

    /// Append a log entry to `record`, bumping `next_log_seq` and `updated_at`.
    fn push_log(record: &mut LoopRecord, now: &str, entry: LogInput) -> LoopLogEntry {
        let appended = LoopLogEntry {
            seq: record.next_log_seq,
            timestamp: now.to_string(),
            iteration: entry.iteration,
            source: entry.source,
            level: entry.level,
            text: entry.text,
        };
        record.logs.push(appended.clone());
        record.next_log_seq += 1;
        record.updated_at = now.to_string();
        appended
    }

    /// Persist all records sorted by `createdAt` ascending (loop-service.ts
    /// lines 922-935).
    fn persist(&self) -> Result<(), LoopServiceError> {
        let mut records: Vec<&LoopRecord> = self.loops.values().collect();
        records.sort_by(|a, b| a.created_at.cmp(&b.created_at));
        write_json_atomic(&self.store_path, &records)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;
    use time::macros::datetime;

    fn base_record() -> LoopRecord {
        LoopRecord {
            id: String::new(),
            name: Some("demo".to_string()),
            prompt: "do work".to_string(),
            cwd: "/work".to_string(),
            provider: "claude".to_string(),
            model: None,
            mode_id: None,
            worker_provider: None,
            worker_model: None,
            verifier_provider: None,
            verifier_model: None,
            verifier_mode_id: None,
            verify_prompt: Some("looks good?".to_string()),
            verify_checks: vec!["cargo test".to_string()],
            archive: false,
            sleep_ms: 0,
            max_iterations: None,
            max_time_ms: None,
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
        }
    }

    fn iteration(index: i64, status: LoopStatus) -> LoopIterationRecord {
        LoopIterationRecord {
            index,
            worker_agent_id: None,
            worker_started_at: "2026-01-01T00:00:00.000Z".to_string(),
            worker_completed_at: None,
            verifier_agent_id: None,
            status,
            worker_outcome: None,
            failure_reason: None,
            verify_checks: Vec::new(),
            verify_prompt: None,
        }
    }

    #[test]
    fn create_assigns_eight_hex_id_and_logs() {
        let dir = tempdir().unwrap();
        let mut svc = LoopService::with_clock(dir.path(), || datetime!(2026-01-01 00:00:00 UTC));
        let created = svc.create(base_record()).unwrap();
        assert_eq!(created.id.len(), 8);
        assert!(created.id.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()));
        assert_eq!(created.status, LoopStatus::Running);
        // "Loop created in /work" log assigned seq 1.
        assert_eq!(created.logs.len(), 1);
        assert_eq!(created.logs[0].seq, 1);
        assert_eq!(created.next_log_seq, 2);
    }

    #[test]
    fn list_and_inspect_round_trip() {
        let dir = tempdir().unwrap();
        let mut svc = LoopService::with_clock(dir.path(), || datetime!(2026-01-01 00:00:00 UTC));
        let a = svc.create(base_record()).unwrap();
        let items = svc.list().unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].id, a.id);
        let inspected = svc.inspect(&a.id).unwrap();
        assert_eq!(inspected.id, a.id);
        // Prefix inspect works.
        let by_prefix = svc.inspect(&a.id[..4]).unwrap();
        assert_eq!(by_prefix.id, a.id);
    }

    #[test]
    fn append_log_assigns_increasing_seq() {
        let dir = tempdir().unwrap();
        let mut svc = LoopService::with_clock(dir.path(), || datetime!(2026-01-01 00:00:00 UTC));
        let created = svc.create(base_record()).unwrap();
        let first = svc
            .append_log(
                &created.id,
                LogInput {
                    iteration: Some(1),
                    source: LoopLogSource::Worker,
                    level: LoopLogLevel::Info,
                    text: "step".to_string(),
                },
            )
            .unwrap();
        let second = svc
            .append_log(
                &created.id,
                LogInput {
                    iteration: Some(1),
                    source: LoopLogSource::Worker,
                    level: LoopLogLevel::Info,
                    text: "step 2".to_string(),
                },
            )
            .unwrap();
        // seq 1 was the creation log; appended logs are 2 then 3.
        assert_eq!(first.seq, 2);
        assert_eq!(second.seq, 3);
    }

    #[test]
    fn append_iteration_records() {
        let dir = tempdir().unwrap();
        let mut svc = LoopService::with_clock(dir.path(), || datetime!(2026-01-01 00:00:00 UTC));
        let created = svc.create(base_record()).unwrap();
        let updated = svc
            .append_iteration(&created.id, iteration(1, LoopStatus::Succeeded))
            .unwrap();
        assert_eq!(updated.iterations.len(), 1);
        assert_eq!(updated.iterations[0].index, 1);
    }

    #[test]
    fn stop_sets_status_stopped() {
        let dir = tempdir().unwrap();
        let mut svc = LoopService::with_clock(dir.path(), || datetime!(2026-01-01 00:00:00 UTC));
        let created = svc.create(base_record()).unwrap();
        let stopped = svc.stop(&created.id).unwrap();
        assert_eq!(stopped.status, LoopStatus::Stopped);
        assert!(stopped.completed_at.is_some());
        assert!(stopped.stop_requested_at.is_some());
        assert_eq!(stopped.active_iteration, None);
        // Stopping a non-running loop returns unchanged.
        let again = svc.stop(&created.id).unwrap();
        assert_eq!(again.status, LoopStatus::Stopped);
    }

    #[test]
    fn reconcile_recovers_orphaned_running_loop() {
        let dir = tempdir().unwrap();
        // Seed a persisted store with a loop left 'running' (crash state).
        let mut seed = LoopService::with_clock(dir.path(), || datetime!(2026-01-01 00:00:00 UTC));
        let mut rec = base_record();
        rec.status = LoopStatus::Running;
        rec.active_iteration = Some(1);
        rec.active_worker_agent_id = Some("worker-1".to_string());
        let created = seed.create(rec).unwrap();
        // Manually inject a running iteration and re-persist via append_iteration.
        seed.append_iteration(&created.id, iteration(1, LoopStatus::Running))
            .unwrap();
        let id = created.id.clone();
        drop(seed);

        // Fresh service loads the same file and reconciles on startup.
        let mut fresh = LoopService::with_clock(dir.path(), || datetime!(2026-01-02 00:00:00 UTC));
        let recovered = fresh.inspect(&id).unwrap();
        assert_eq!(recovered.status, LoopStatus::Stopped);
        assert_eq!(recovered.completed_at.as_deref(), Some("2026-01-02T00:00:00.000Z"));
        assert_eq!(recovered.stop_requested_at.as_deref(), Some("2026-01-02T00:00:00.000Z"));
        assert_eq!(recovered.active_iteration, None);
        assert_eq!(recovered.active_worker_agent_id, None);
        // Interrupt log appended.
        assert!(recovered
            .logs
            .iter()
            .any(|l| l.text == "Loop was interrupted by daemon restart."));
        // Trailing running iteration marked stopped.
        let last = recovered.iterations.last().unwrap();
        assert_eq!(last.status, LoopStatus::Stopped);
        assert_eq!(last.failure_reason.as_deref(), Some("Daemon restarted"));
    }

    #[test]
    fn executor_trait_is_usable() {
        struct Exec;
        impl LoopExecutor for Exec {
            async fn drive(&self, _loop_id: &str) -> anyhow::Result<()> {
                Ok(())
            }
        }
        let rt = tokio::runtime::Builder::new_current_thread().build().unwrap();
        rt.block_on(async { Exec.drive("abc").await.unwrap() });
    }
}
