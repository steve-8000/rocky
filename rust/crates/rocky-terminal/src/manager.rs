//! PTY-backed terminal manager.
//!
//! Models the lifecycle subset of
//! `core/packages/server/src/terminal/terminal-manager.ts` (list / create /
//! rename / kill / subscribe / input / capture) on top of `portable-pty`.
//!
//! ## Resize ownership (spec 03 line 111)
//! "Last genuinely interacting client wins; passive render/attach must not
//! resize the PTY." [`TerminalManager::resize`] takes an `interactive` flag:
//! a resize from a passive subscriber (`interactive == false`) is ignored and
//! never reaches the kernel `TIOCSWINSZ`; only interactive resizes mutate the
//! tracked + kernel pty size.
//!
//! ## Output framing
//! Child output is pumped into a per-terminal `tokio::broadcast` channel as
//! encoded [`TerminalStreamOpcode::Output`] frames (see
//! [`crate::frames::encode_terminal_stream_frame`]) so the wire format matches
//! the TS protocol. The raw (unframed) bytes are also accumulated for
//! [`TerminalManager::capture`].

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use portable_pty::{Child, CommandBuilder, MasterPty, PtySize};
use tokio::sync::broadcast;

use crate::frames::{encode_terminal_stream_frame, TerminalStreamOpcode};

/// Default subscriber channel depth (number of buffered Output frames).
const BROADCAST_CAPACITY: usize = 1024;
/// Maximum bytes retained for [`TerminalManager::capture`].
const CAPTURE_LIMIT: usize = 1024 * 1024;

/// Errors surfaced by the terminal manager.
#[derive(Debug, thiserror::Error)]
pub enum TerminalError {
    /// No terminal with the given id exists.
    #[error("terminal not found: {0}")]
    NotFound(String),

    /// A PTY-layer failure (open / spawn / resize / write).
    #[error("pty error: {0}")]
    Pty(String),
}

/// Options for spawning a new terminal.
#[derive(Debug, Clone, Default)]
pub struct CreateTerminalOptions {
    /// Explicit id; a uuid-like value is generated when `None`.
    pub id: Option<String>,
    /// Human-readable name shown in listings.
    pub name: Option<String>,
    /// Working directory for the child.
    pub cwd: Option<String>,
    /// Program to run; defaults to the user's login shell when `None`.
    pub command: Option<String>,
    /// Arguments passed to `command` (ignored when `command` is `None`).
    pub args: Vec<String>,
    /// Extra environment overrides.
    pub env: Vec<(String, String)>,
    /// Initial pty rows (defaults to 24).
    pub rows: Option<u16>,
    /// Initial pty cols (defaults to 80).
    pub cols: Option<u16>,
}

/// Result of [`TerminalManager::create`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CreatedTerminal {
    pub id: String,
    /// Frame slot (`slot & 0xff` on the wire).
    pub slot: u8,
}

/// Listing entry for [`TerminalManager::list`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TerminalInfo {
    pub id: String,
    pub slot: u8,
    pub name: String,
    pub rows: u16,
    pub cols: u16,
    pub cwd: Option<String>,
}

struct Terminal {
    id: String,
    slot: u8,
    name: String,
    rows: u16,
    cols: u16,
    cwd: Option<String>,
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
    output_tx: broadcast::Sender<Vec<u8>>,
    capture: Arc<Mutex<Vec<u8>>>,
}

#[derive(Default)]
struct Inner {
    terminals: HashMap<String, Terminal>,
}

/// PTY-backed terminal manager. Cheap to clone (shared `Arc` state).
#[derive(Clone)]
pub struct TerminalManager {
    inner: Arc<Mutex<Inner>>,
    next_slot: Arc<AtomicU64>,
}

impl Default for TerminalManager {
    fn default() -> Self {
        Self::new()
    }
}

impl TerminalManager {
    #[must_use]
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(Inner::default())),
            next_slot: Arc::new(AtomicU64::new(0)),
        }
    }

    /// Spawn a new PTY-backed terminal and start pumping its output.
    pub fn create(&self, opts: CreateTerminalOptions) -> Result<CreatedTerminal, TerminalError> {
        let rows = opts.rows.unwrap_or(24);
        let cols = opts.cols.unwrap_or(80);
        let size = PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        };

        let pty_system = portable_pty::native_pty_system();
        let pair = pty_system
            .openpty(size)
            .map_err(|err| TerminalError::Pty(err.to_string()))?;

        let mut cmd = match &opts.command {
            Some(program) => {
                let mut builder = CommandBuilder::new(program);
                builder.args(&opts.args);
                builder
            }
            None => CommandBuilder::new_default_prog(),
        };
        if let Some(cwd) = &opts.cwd {
            cmd.cwd(cwd);
        }
        for (key, value) in &opts.env {
            cmd.env(key, value);
        }

        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|err| TerminalError::Pty(err.to_string()))?;
        // The slave handle is no longer needed once the child holds it open.
        drop(pair.slave);

        let writer = pair
            .master
            .take_writer()
            .map_err(|err| TerminalError::Pty(err.to_string()))?;
        let reader = pair
            .master
            .try_clone_reader()
            .map_err(|err| TerminalError::Pty(err.to_string()))?;

        let id = opts.id.unwrap_or_else(generate_id);
        let slot = (self.next_slot.fetch_add(1, Ordering::Relaxed) & 0xff) as u8;
        let name = opts.name.unwrap_or_else(|| format!("terminal-{slot}"));

        let (output_tx, _output_rx) = broadcast::channel::<Vec<u8>>(BROADCAST_CAPACITY);
        let capture = Arc::new(Mutex::new(Vec::<u8>::new()));

        spawn_reader(reader, slot, output_tx.clone(), capture.clone());

        let terminal = Terminal {
            id: id.clone(),
            slot,
            name,
            rows,
            cols,
            cwd: opts.cwd.clone(),
            master: pair.master,
            writer,
            child,
            output_tx,
            capture,
        };

        self.inner
            .lock()
            .expect("terminal manager mutex poisoned")
            .terminals
            .insert(id.clone(), terminal);

        Ok(CreatedTerminal { id, slot })
    }

    /// List all live terminals (insertion order is not guaranteed).
    #[must_use]
    pub fn list(&self) -> Vec<TerminalInfo> {
        let guard = self.inner.lock().expect("terminal manager mutex poisoned");
        guard
            .terminals
            .values()
            .map(|t| TerminalInfo {
                id: t.id.clone(),
                slot: t.slot,
                name: t.name.clone(),
                rows: t.rows,
                cols: t.cols,
                cwd: t.cwd.clone(),
            })
            .collect()
    }

    /// Rename a terminal. Returns `NotFound` when the id is unknown.
    pub fn rename(&self, id: &str, name: &str) -> Result<(), TerminalError> {
        let mut guard = self.inner.lock().expect("terminal manager mutex poisoned");
        let terminal = guard
            .terminals
            .get_mut(id)
            .ok_or_else(|| TerminalError::NotFound(id.to_string()))?;
        terminal.name = name.to_string();
        Ok(())
    }

    /// Write input bytes to the terminal's pty master.
    pub fn write_input(&self, id: &str, bytes: &[u8]) -> Result<(), TerminalError> {
        let mut guard = self.inner.lock().expect("terminal manager mutex poisoned");
        let terminal = guard
            .terminals
            .get_mut(id)
            .ok_or_else(|| TerminalError::NotFound(id.to_string()))?;
        terminal
            .writer
            .write_all(bytes)
            .map_err(|err| TerminalError::Pty(err.to_string()))?;
        terminal
            .writer
            .flush()
            .map_err(|err| TerminalError::Pty(err.to_string()))?;
        Ok(())
    }

    /// Resize the terminal, honouring the ownership rule: a passive
    /// (`interactive == false`) resize is ignored and never touches the kernel.
    /// Returns `Ok(true)` when the resize was applied, `Ok(false)` when it was
    /// ignored as passive.
    pub fn resize(
        &self,
        id: &str,
        rows: u16,
        cols: u16,
        interactive: bool,
    ) -> Result<bool, TerminalError> {
        let mut guard = self.inner.lock().expect("terminal manager mutex poisoned");
        let terminal = guard
            .terminals
            .get_mut(id)
            .ok_or_else(|| TerminalError::NotFound(id.to_string()))?;
        if !interactive {
            // Passive render/attach must not resize the PTY (spec 03 line 111).
            return Ok(false);
        }
        terminal
            .master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|err| TerminalError::Pty(err.to_string()))?;
        terminal.rows = rows;
        terminal.cols = cols;
        Ok(true)
    }

    /// Currently tracked (applied) pty size, for inspection/tests.
    #[must_use]
    pub fn size(&self, id: &str) -> Option<(u16, u16)> {
        let guard = self.inner.lock().expect("terminal manager mutex poisoned");
        guard.terminals.get(id).map(|t| (t.rows, t.cols))
    }

    /// Subscribe to the terminal's Output frame stream. Each item is an encoded
    /// [`TerminalStreamOpcode::Output`] frame.
    pub fn subscribe(&self, id: &str) -> Result<broadcast::Receiver<Vec<u8>>, TerminalError> {
        let guard = self.inner.lock().expect("terminal manager mutex poisoned");
        let terminal = guard
            .terminals
            .get(id)
            .ok_or_else(|| TerminalError::NotFound(id.to_string()))?;
        Ok(terminal.output_tx.subscribe())
    }

    /// Snapshot of all buffered raw output bytes seen so far.
    pub fn capture(&self, id: &str) -> Result<Vec<u8>, TerminalError> {
        let guard = self.inner.lock().expect("terminal manager mutex poisoned");
        let terminal = guard
            .terminals
            .get(id)
            .ok_or_else(|| TerminalError::NotFound(id.to_string()))?;
        let snapshot = terminal
            .capture
            .lock()
            .expect("capture mutex poisoned")
            .clone();
        Ok(snapshot)
    }

    /// Kill the terminal's child process and remove it from the manager.
    pub fn kill(&self, id: &str) -> Result<(), TerminalError> {
        let mut terminal = {
            let mut guard = self.inner.lock().expect("terminal manager mutex poisoned");
            guard
                .terminals
                .remove(id)
                .ok_or_else(|| TerminalError::NotFound(id.to_string()))?
        };
        // Best-effort terminate; reap so the child does not linger as a zombie.
        let _ = terminal.child.kill();
        let _ = terminal.child.wait();
        Ok(())
    }
}

/// Pump pty output into the broadcast channel as Output frames and into the
/// capture buffer. Runs on a dedicated OS thread because the reader is blocking.
fn spawn_reader(
    mut reader: Box<dyn Read + Send>,
    slot: u8,
    output_tx: broadcast::Sender<Vec<u8>>,
    capture: Arc<Mutex<Vec<u8>>>,
) {
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break, // EOF: child closed the pty.
                Ok(n) => {
                    let chunk = &buf[..n];
                    {
                        let mut cap = capture.lock().expect("capture mutex poisoned");
                        cap.extend_from_slice(chunk);
                        if cap.len() > CAPTURE_LIMIT {
                            let overflow = cap.len() - CAPTURE_LIMIT;
                            cap.drain(0..overflow);
                        }
                    }
                    let frame =
                        encode_terminal_stream_frame(TerminalStreamOpcode::Output, slot, chunk);
                    // No subscribers is not an error.
                    let _ = output_tx.send(frame);
                }
                Err(err) if err.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => break,
            }
        }
    });
}

fn generate_id() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let seq = COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("term-{nanos:x}-{seq:x}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::frames::decode_terminal_stream_frame;
    use std::time::Duration;

    fn collect_output(rx: &mut broadcast::Receiver<Vec<u8>>, want: &[u8]) -> Vec<u8> {
        // Drain frames until we observe `want` or the deadline elapses.
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        let mut acc = Vec::new();
        while std::time::Instant::now() < deadline {
            match rx.try_recv() {
                Ok(frame) => {
                    let decoded = decode_terminal_stream_frame(&frame).expect("output frame");
                    assert_eq!(decoded.opcode, TerminalStreamOpcode::Output);
                    acc.extend_from_slice(&decoded.payload);
                    if acc.windows(want.len()).any(|w| w == want) {
                        return acc;
                    }
                }
                Err(broadcast::error::TryRecvError::Empty) => {
                    std::thread::sleep(Duration::from_millis(20));
                }
                Err(broadcast::error::TryRecvError::Lagged(_)) => continue,
                Err(broadcast::error::TryRecvError::Closed) => break,
            }
        }
        acc
    }

    #[tokio::test]
    async fn create_subscribe_receives_output() {
        let mgr = TerminalManager::new();
        let created = mgr
            .create(CreateTerminalOptions {
                command: Some("sh".into()),
                args: vec!["-c".into(), "printf hi".into()],
                ..Default::default()
            })
            .expect("create");
        let mut rx = mgr.subscribe(&created.id).expect("subscribe");
        let out = collect_output(&mut rx, b"hi");
        assert!(
            out.windows(2).any(|w| w == b"hi"),
            "expected 'hi' in output, got {:?}",
            String::from_utf8_lossy(&out)
        );
    }

    #[tokio::test]
    async fn capture_returns_buffered_output() {
        let mgr = TerminalManager::new();
        let created = mgr
            .create(CreateTerminalOptions {
                command: Some("sh".into()),
                args: vec!["-c".into(), "printf marker123".into()],
                ..Default::default()
            })
            .expect("create");
        // Subscribe first so we can wait deterministically for the bytes.
        let mut rx = mgr.subscribe(&created.id).expect("subscribe");
        let _ = collect_output(&mut rx, b"marker123");
        let snapshot = mgr.capture(&created.id).expect("capture");
        assert!(
            snapshot.windows(9).any(|w| w == b"marker123"),
            "capture missing marker, got {:?}",
            String::from_utf8_lossy(&snapshot)
        );
    }

    #[tokio::test]
    async fn rename_updates_listing() {
        let mgr = TerminalManager::new();
        let created = mgr
            .create(CreateTerminalOptions {
                command: Some("sh".into()),
                args: vec!["-c".into(), "sleep 5".into()],
                name: Some("orig".into()),
                ..Default::default()
            })
            .expect("create");
        mgr.rename(&created.id, "renamed").expect("rename");
        let info = mgr
            .list()
            .into_iter()
            .find(|t| t.id == created.id)
            .expect("listed");
        assert_eq!(info.name, "renamed");
        assert!(mgr.rename("nope", "x").is_err());
        mgr.kill(&created.id).expect("kill");
    }

    #[tokio::test]
    async fn interactive_resize_applies_passive_ignored() {
        let mgr = TerminalManager::new();
        let created = mgr
            .create(CreateTerminalOptions {
                command: Some("sh".into()),
                args: vec!["-c".into(), "sleep 5".into()],
                rows: Some(24),
                cols: Some(80),
                ..Default::default()
            })
            .expect("create");

        // Interactive resize applies.
        let applied = mgr.resize(&created.id, 40, 100, true).expect("resize");
        assert!(applied);
        assert_eq!(mgr.size(&created.id), Some((40, 100)));

        // Passive resize is ignored: size stays at the last interactive value.
        let applied = mgr.resize(&created.id, 10, 10, false).expect("resize");
        assert!(!applied);
        assert_eq!(mgr.size(&created.id), Some((40, 100)));

        mgr.kill(&created.id).expect("kill");
    }

    #[tokio::test]
    async fn kill_removes_from_list() {
        let mgr = TerminalManager::new();
        let created = mgr
            .create(CreateTerminalOptions {
                command: Some("sh".into()),
                args: vec!["-c".into(), "sleep 30".into()],
                ..Default::default()
            })
            .expect("create");
        assert!(mgr.list().iter().any(|t| t.id == created.id));
        mgr.kill(&created.id).expect("kill");
        assert!(!mgr.list().iter().any(|t| t.id == created.id));
        assert!(mgr.subscribe(&created.id).is_err());
    }
}
