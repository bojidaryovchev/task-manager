//! Native Windows telemetry for Task Manager.
//!
//! Layout mirrors the pipeline:
//!
//! * `win` - raw Windows API access, the only place `unsafe` appears.
//! * `cpu`, `memory`, `process`, `disk`, `network`, `gpu`, `thermal` - collection and
//!   calculation, one module per subsystem, each owning the previous-sample
//!   state its rates need.
//! * `sampling` - the single engine that drives every collector on one cadence.
//! * `api` - the N-API transport structures and conversions.
//!
//! Nothing above `win` contains a Windows call, and nothing below `api` knows
//! that JavaScript exists.

#![cfg(windows)]
#![deny(clippy::undocumented_unsafe_blocks)]

pub mod api;
pub mod clock;
pub mod cpu;
pub mod disk;
pub mod gpu;
pub mod history;
pub mod host;
pub mod memory;
pub mod network;
pub mod process;
pub mod sampling;
pub mod thermal;
pub mod win;

use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};

use napi::bindgen_prelude::*;
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi_derive::napi;

use crate::api::{
    history_point_to_js, JsCollectorConfig, JsHistoryResult, JsHistoryTier, JsHostInfo,
    JsSystemSnapshot,
};
use crate::sampling::engine::{run_loop, EngineState, DEFAULT_INTERVAL_MS};

/// Callback invoked once per sampling interval with a complete snapshot.
///
/// `CalleeHandled = false`: the JS function receives the snapshot directly
/// rather than a Node-style `(error, value)` pair.
type SnapshotCallback = ThreadsafeFunction<JsSystemSnapshot, (), JsSystemSnapshot, Status, false>;

/// The telemetry engine. One instance per application; owns the sampling thread.
#[napi]
pub struct TelemetryEngine {
    state: Arc<EngineState>,
    thread: Option<std::thread::JoinHandle<()>>,
    /// Read-only handle onto the history database, for queries from JavaScript.
    ///
    /// A separate connection from the sampling thread's writer: SQLite in WAL
    /// mode lets a reader run without blocking the writer, which is exactly what
    /// is needed when the UI asks for a week of history mid-sample.
    history_path: Arc<Mutex<Option<String>>>,
}

#[napi]
impl TelemetryEngine {
    #[napi(constructor)]
    pub fn new(config: Option<JsCollectorConfig>) -> Self {
        let config = config.unwrap_or_else(default_config);
        Self {
            state: Arc::new(EngineState::new(&config)),
            thread: None,
            history_path: Arc::new(Mutex::new(None)),
        }
    }

    /// Enable persistent history, writing to `path`.
    ///
    /// Nothing is created and nothing is written until this is called: a run
    /// with history off must not touch the disk on the collector's account.
    #[napi]
    pub fn enable_history(&mut self, path: String) {
        if let Ok(mut guard) = self.state.history_path.lock() {
            *guard = Some(path.clone());
        }
        if let Ok(mut guard) = self.history_path.lock() {
            *guard = Some(path);
        }
    }

    /// Turn history off. Existing rows are left on disk.
    #[napi]
    pub fn disable_history(&mut self) {
        if let Ok(mut guard) = self.state.history_path.lock() {
            *guard = None;
        }
        if let Ok(mut guard) = self.history_path.lock() {
            *guard = None;
        }
    }

    /// Read a window of history, choosing the finest tier that covers the span.
    ///
    /// Opens its own read-only connection rather than sharing the sampling
    /// thread's: WAL mode means this cannot block a write, so the UI asking for
    /// a week of data never stalls the sampler.
    #[napi]
    pub fn query_history(&self, from_unix_ms: f64, to_unix_ms: f64) -> JsHistoryResult {
        let path = self
            .history_path
            .lock()
            .ok()
            .and_then(|guard| guard.clone());
        let tier = history::tier_for_span((to_unix_ms - from_unix_ms).max(0.0));
        let empty = JsHistoryResult {
            points: Vec::new(),
            tier: u32::from(tier),
            resolution_ms: history::tier_resolution_ms(tier),
            available: false,
        };
        let Some(path) = path else { return empty };
        let Ok(store) = history::HistoryStore::open(std::path::Path::new(&path)) else {
            return empty;
        };
        JsHistoryResult {
            points: store
                .query(from_unix_ms, to_unix_ms)
                .iter()
                .map(history_point_to_js)
                .collect(),
            tier: u32::from(tier),
            resolution_ms: history::tier_resolution_ms(tier),
            available: true,
        }
    }

    /// Rows currently stored per tier, for the debug view.
    #[napi]
    pub fn history_tiers(&self) -> Vec<JsHistoryTier> {
        let path = self
            .history_path
            .lock()
            .ok()
            .and_then(|guard| guard.clone());
        let Some(path) = path else { return Vec::new() };
        let Ok(store) = history::HistoryStore::open(std::path::Path::new(&path)) else {
            return Vec::new();
        };
        store
            .row_counts()
            .into_iter()
            .map(|(tier, row_count)| JsHistoryTier {
                tier: u32::from(tier),
                row_count,
            })
            .collect()
    }

    /// Start sampling. `on_snapshot` is called on the JavaScript thread once per
    /// interval. Calling `start` while already running is a no-op.
    #[napi(ts_args_type = "onSnapshot: (snapshot: JsSystemSnapshot) => void")]
    pub fn start(&mut self, on_snapshot: SnapshotCallback) -> Result<()> {
        if self.state.running.swap(true, Ordering::SeqCst) {
            return Ok(());
        }
        if let Ok(mut guard) = self.state.panic_message.lock() {
            *guard = None;
        }
        let state = Arc::clone(&self.state);
        let thread = std::thread::Builder::new()
            .name("task-manager-sampler".into())
            .spawn(move || {
                let panic_state = Arc::clone(&state);
                // A panic here would otherwise unwind this thread and leave the
                // rest of the process running: collection would stop while the
                // application still looked healthy and showed the last snapshot
                // forever. Catching it turns a silent death into a reportable
                // one - `running` is cleared and the message is kept, so the UI
                // can say the collector failed instead of showing stale numbers.
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || {
                    run_loop(state, move |snapshot| {
                        // NonBlocking: if JavaScript has fallen behind, drop the
                        // snapshot rather than stalling the sampling thread and
                        // corrupting the interval of every later sample.
                        on_snapshot.call(snapshot, ThreadsafeFunctionCallMode::NonBlocking)
                            == Status::Ok
                    });
                }));
                if let Err(payload) = result {
                    panic_state.running.store(false, Ordering::SeqCst);
                    if let Ok(mut guard) = panic_state.panic_message.lock() {
                        *guard = Some(describe_panic(&payload));
                    }
                }
            })
            .map_err(|error| {
                Error::new(
                    Status::GenericFailure,
                    format!("failed to start sampling thread: {error}"),
                )
            })?;
        self.thread = Some(thread);
        Ok(())
    }

    /// Stop sampling and join the thread. Safe to call when not running.
    #[napi]
    pub fn stop(&mut self) {
        self.state.running.store(false, Ordering::SeqCst);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }

    #[napi(getter)]
    pub fn is_running(&self) -> bool {
        self.state.running.load(Ordering::Relaxed)
    }

    /// The panic that killed the sampling thread, or `null` if none did.
    ///
    /// Non-null means collection has stopped and every value the application is
    /// showing is stale. It is a getter rather than an event because the
    /// threadsafe function that would carry an event is exactly what stops
    /// working when the sampler dies.
    #[napi(getter)]
    pub fn collector_panic(&self) -> Option<String> {
        self.state
            .panic_message
            .lock()
            .ok()
            .and_then(|guard| guard.clone())
    }

    /// The most recent snapshot, or `null` before the first one completes.
    #[napi]
    pub fn get_latest_snapshot(&self) -> Option<JsSystemSnapshot> {
        self.state.latest.lock().ok().and_then(|l| l.clone())
    }

    #[napi]
    pub fn get_config(&self) -> JsCollectorConfig {
        self.state.config.snapshot()
    }

    /// Apply a configuration change. The interval is clamped to a sane range and
    /// the effective configuration is returned.
    #[napi]
    pub fn set_config(&self, config: JsCollectorConfig) -> JsCollectorConfig {
        self.state.config.apply(&config);
        self.state.config.snapshot()
    }
}

impl Drop for TelemetryEngine {
    fn drop(&mut self) {
        self.stop();
    }
}

fn default_config() -> JsCollectorConfig {
    JsCollectorConfig {
        interval_ms: f64::from(DEFAULT_INTERVAL_MS),
        collect_processes: true,
        collect_debug: false,
        collect_command_lines: false,
    }
}

/// Static information about the machine and our own privileges.
#[napi]
pub fn get_host_info() -> JsHostInfo {
    host::host_info()
}

/// Collect exactly one snapshot without starting the engine.
///
/// Every rate is unavailable in the returned snapshot because a single reading
/// of a cumulative counter carries no rate. Intended for diagnostics and tests,
/// not for polling.
#[napi]
pub fn collect_single_snapshot() -> JsSystemSnapshot {
    let state = EngineState::new(&default_config());
    let mut collectors = sampling::engine::Collectors::new();
    collectors.collect(&state)
}

/// Ask Windows to restart this application if it crashes or stops responding.
///
/// `command_line` is what the restarted process receives, so pass a marker the
/// application can recognise. Returns false when Windows refused, which simply
/// means the application will not come back by itself.
#[napi]
pub fn register_for_restart(command_line: String) -> bool {
    win::restart::register_for_restart(&command_line)
}

/// Cancel the restart registration, so a deliberate quit is never mistaken for
/// a crash.
#[napi]
pub fn unregister_for_restart() -> bool {
    win::restart::unregister_for_restart()
}

/// Turn a panic payload into something worth putting in a log.
fn describe_panic(payload: &Box<dyn std::any::Any + Send>) -> String {
    if let Some(message) = payload.downcast_ref::<&str>() {
        (*message).to_string()
    } else if let Some(message) = payload.downcast_ref::<String>() {
        message.clone()
    } else {
        "collector thread panicked with a non-string payload".to_string()
    }
}

/// Confirms the native module loaded and reports its version.
#[napi]
pub fn native_probe() -> String {
    format!("telemetry-native {}", env!("CARGO_PKG_VERSION"))
}
