//! Native Windows telemetry for Task Manager.
//!
//! Layout mirrors the pipeline:
//!
//! * `win` - raw Windows API access, the only place `unsafe` appears.
//! * `cpu`, `memory`, `process` - collection and calculation, one module per
//!   subsystem, each owning the previous-sample state its rates need.
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
pub mod host;
pub mod memory;
pub mod process;
pub mod sampling;
pub mod win;

use std::sync::atomic::Ordering;
use std::sync::Arc;

use napi::bindgen_prelude::*;
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi_derive::napi;

use crate::api::{JsCollectorConfig, JsHostInfo, JsSystemSnapshot};
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
}

#[napi]
impl TelemetryEngine {
    #[napi(constructor)]
    pub fn new(config: Option<JsCollectorConfig>) -> Self {
        let config = config.unwrap_or_else(default_config);
        Self {
            state: Arc::new(EngineState::new(&config)),
            thread: None,
        }
    }

    /// Start sampling. `on_snapshot` is called on the JavaScript thread once per
    /// interval. Calling `start` while already running is a no-op.
    #[napi(ts_args_type = "onSnapshot: (snapshot: JsSystemSnapshot) => void")]
    pub fn start(&mut self, on_snapshot: SnapshotCallback) -> Result<()> {
        if self.state.running.swap(true, Ordering::SeqCst) {
            return Ok(());
        }
        let state = Arc::clone(&self.state);
        let thread = std::thread::Builder::new()
            .name("task-manager-sampler".into())
            .spawn(move || {
                run_loop(state, move |snapshot| {
                    // NonBlocking: if JavaScript has fallen behind, drop the
                    // snapshot rather than stalling the sampling thread and
                    // corrupting the interval of every later sample.
                    on_snapshot.call(snapshot, ThreadsafeFunctionCallMode::NonBlocking)
                        == Status::Ok
                });
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

/// Confirms the native module loaded and reports its version.
#[napi]
pub fn native_probe() -> String {
    format!("telemetry-native {}", env!("CARGO_PKG_VERSION"))
}
