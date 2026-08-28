//! The single sampling engine.
//!
//! There is exactly one timer in this application. CPU, memory and processes are
//! read inside one tick so that every value in a snapshot describes the same
//! interval, and so that a process CPU percentage can be compared against the
//! aggregate CPU percentage without the two having been measured over different
//! windows.
//!
//! The loop runs on its own OS thread. Collection costs a few milliseconds and
//! must not run on the Electron main thread, where it would stall the UI and
//! IPC. Finished snapshots are handed to JavaScript through a threadsafe
//! function, so the main thread only pays for the conversion.
//!
//! # Drift
//!
//! The loop sleeps for `interval - elapsed_work`, so collection cost does not
//! accumulate into the period. It never tries to "catch up" by sampling twice in
//! a row: every rate is divided by the *measured* interval, so a late sample is
//! still correct, just coarser.

use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::api::{
    cpu_to_js, memory_to_js, processes_to_js, topology_to_js, CpuConversionContext,
    JsCollectionDiagnostics, JsCollectorConfig, JsCollectorIssue, JsSystemSnapshot,
};
use crate::clock::{wall_clock_unix_ms, MonotonicClock};
use crate::cpu::CpuCollector;
use crate::memory::MemoryCollector;
use crate::process::ProcessCollector;

use windows_sys::Win32::System::SystemInformation::GetTickCount64;

/// Bounds enforced on the configured interval. Below 100 ms the collector's own
/// cost becomes a meaningful share of the machine; above a minute the counters
/// stop describing anything useful as "current".
pub const MIN_INTERVAL_MS: u32 = 100;
pub const MAX_INTERVAL_MS: u32 = 60_000;
pub const DEFAULT_INTERVAL_MS: u32 = 500;

/// Runtime-adjustable configuration, shared with the sampling thread.
///
/// Stored as atomics rather than behind a lock so the sampling thread never
/// blocks on a UI interaction.
pub struct SharedConfig {
    interval_ms: AtomicU32,
    collect_processes: AtomicBool,
    collect_debug: AtomicBool,
    collect_command_lines: AtomicBool,
}

impl SharedConfig {
    pub fn new(config: &JsCollectorConfig) -> Self {
        let this = Self {
            interval_ms: AtomicU32::new(DEFAULT_INTERVAL_MS),
            collect_processes: AtomicBool::new(true),
            collect_debug: AtomicBool::new(false),
            collect_command_lines: AtomicBool::new(false),
        };
        this.apply(config);
        this
    }

    pub fn apply(&self, config: &JsCollectorConfig) {
        let interval =
            (config.interval_ms.round().max(0.0) as u32).clamp(MIN_INTERVAL_MS, MAX_INTERVAL_MS);
        self.interval_ms.store(interval, Ordering::Relaxed);
        self.collect_processes
            .store(config.collect_processes, Ordering::Relaxed);
        self.collect_debug
            .store(config.collect_debug, Ordering::Relaxed);
        self.collect_command_lines
            .store(config.collect_command_lines, Ordering::Relaxed);
    }

    pub fn snapshot(&self) -> JsCollectorConfig {
        JsCollectorConfig {
            interval_ms: f64::from(self.interval_ms.load(Ordering::Relaxed)),
            collect_processes: self.collect_processes.load(Ordering::Relaxed),
            collect_debug: self.collect_debug.load(Ordering::Relaxed),
            collect_command_lines: self.collect_command_lines.load(Ordering::Relaxed),
        }
    }

    fn interval(&self) -> Duration {
        Duration::from_millis(u64::from(self.interval_ms.load(Ordering::Relaxed)))
    }
}

/// State shared between the sampling thread and the N-API surface.
pub struct EngineState {
    pub config: SharedConfig,
    pub running: AtomicBool,
    pub latest: Mutex<Option<JsSystemSnapshot>>,
    pub sequence: AtomicU64,
    /// Snapshots that could not be delivered because the JS queue was full.
    pub dropped: AtomicU32,
}

impl EngineState {
    pub fn new(config: &JsCollectorConfig) -> Self {
        Self {
            config: SharedConfig::new(config),
            running: AtomicBool::new(false),
            latest: Mutex::new(None),
            sequence: AtomicU64::new(0),
            dropped: AtomicU32::new(0),
        }
    }
}

/// Everything the sampling thread owns exclusively.
pub struct Collectors {
    cpu: CpuCollector,
    memory: MemoryCollector,
    processes: ProcessCollector,
    clock: MonotonicClock,
    last_monotonic_ms: Option<f64>,
}

impl Collectors {
    pub fn new() -> Self {
        let cpu = CpuCollector::new();
        let logical_processor_count = cpu.topology().logical_processor_count();
        Self {
            processes: ProcessCollector::new(logical_processor_count),
            memory: MemoryCollector::new(),
            cpu,
            clock: MonotonicClock::new(),
            last_monotonic_ms: None,
        }
    }

    pub fn logical_processor_count(&self) -> usize {
        self.cpu.topology().logical_processor_count()
    }

    /// Produce one snapshot. Never panics on a Windows failure: a subsystem that
    /// fails contributes an issue and leaves its fields empty.
    pub fn collect(&mut self, state: &EngineState) -> JsSystemSnapshot {
        let started = Instant::now();
        let monotonic_ms = self.clock.elapsed_ms();
        let interval_ms = self
            .last_monotonic_ms
            .map(|previous| monotonic_ms - previous);
        self.last_monotonic_ms = Some(monotonic_ms);

        let include_debug = state.config.collect_debug.load(Ordering::Relaxed);
        let collect_processes = state.config.collect_processes.load(Ordering::Relaxed);
        let collect_command_lines = state.config.collect_command_lines.load(Ordering::Relaxed);
        let mut issues: Vec<JsCollectorIssue> = Vec::new();

        // --- memory (also the source of system-wide process/thread/handle counts)
        let memory_started = Instant::now();
        let memory_sample = self.memory.sample();
        let memory_duration_ms = memory_started.elapsed().as_secs_f64() * 1000.0;
        if memory_sample.is_none() {
            issues.push(JsCollectorIssue {
                subsystem: "memory".into(),
                code: "globalMemoryStatusExFailed".into(),
                message: "GlobalMemoryStatusEx returned FALSE".into(),
            });
        }
        let counts = memory_sample.as_ref().and_then(|m| m.performance);

        // --- cpu
        let cpu_started = Instant::now();
        // The first sample has no predecessor; give the CPU collector the
        // configured interval so its debug view has a sane denominator, but its
        // utilization fields stay empty regardless.
        let cpu_interval_ms = interval_ms
            .unwrap_or_else(|| f64::from(state.config.interval_ms.load(Ordering::Relaxed)));
        let cpu_sample = self.cpu.sample(cpu_interval_ms);
        let cpu_duration_ms = cpu_started.elapsed().as_secs_f64() * 1000.0;
        if let Some(reason) = cpu_sample.debug.discard_reason {
            // A discarded first sample is expected, not a problem worth
            // reporting to the user.
            if !reason.starts_with("first sample") {
                issues.push(JsCollectorIssue {
                    subsystem: "cpu".into(),
                    code: "sampleDiscarded".into(),
                    message: reason.into(),
                });
            }
        }

        // Keep the process collector's normalisation in step with a topology
        // change (processor hot-add), rather than dividing by a stale count.
        self.processes
            .set_logical_processor_count(self.cpu.topology().logical_processor_count());

        // --- processes
        let process_started = Instant::now();
        let processes_sample = if collect_processes {
            Some(self.processes.sample(interval_ms, collect_command_lines))
        } else {
            None
        };
        let process_duration_ms = process_started.elapsed().as_secs_f64() * 1000.0;
        if let Some(sample) = &processes_sample {
            if sample.total_count == 0 {
                issues.push(JsCollectorIssue {
                    subsystem: "process".into(),
                    code: "enumerationFailed".into(),
                    message: "NtQuerySystemInformation(SystemProcessInformation) returned nothing"
                        .into(),
                });
            }
        }

        // (processes, threads, handles) summed from our own enumeration.
        let process_counts = processes_sample.as_ref().map(|sample| {
            let mut threads = 0u32;
            let mut handles = 0u32;
            for process in &sample.processes {
                threads = threads.saturating_add(process.thread_count);
                handles = handles.saturating_add(process.handle_count);
            }
            (sample.total_count as u32, threads, handles)
        });

        let pdh_paths = self.cpu.active_pdh_counters();
        let topology = topology_to_js(
            self.cpu.topology(),
            self.cpu.brand_string(),
            self.cpu.base_frequency_mhz(),
        );
        // SAFETY: GetTickCount64 takes no arguments and cannot fail.
        let uptime_ms = unsafe { GetTickCount64() } as f64;

        let cpu = cpu_to_js(
            &cpu_sample,
            CpuConversionContext {
                topology,
                pdh_counter_paths: &pdh_paths,
                include_debug,
                // Prefer counts derived from the process list we just read, so
                // the totals shown always describe the same list the Processes
                // page shows. GetPerformanceInfo is only refreshed every couple
                // of seconds and is used when process collection is disabled.
                process_count: process_counts
                    .map(|c| c.0)
                    .or(counts.map(|c| c.process_count)),
                thread_count: process_counts
                    .map(|c| c.1)
                    .or(counts.map(|c| c.thread_count)),
                handle_count: process_counts
                    .map(|c| c.2)
                    .or(counts.map(|c| c.handle_count)),
                uptime_ms: Some(uptime_ms),
            },
        );

        let memory = match &memory_sample {
            Some(sample) => memory_to_js(sample, include_debug),
            None => empty_memory_snapshot(),
        };

        let sequence = state.sequence.fetch_add(1, Ordering::Relaxed);

        JsSystemSnapshot {
            sequence: sequence as f64,
            wall_clock_unix_ms: wall_clock_unix_ms(),
            monotonic_ms,
            interval_ms,
            cpu,
            memory,
            processes: processes_sample.as_ref().map(processes_to_js),
            diagnostics: JsCollectionDiagnostics {
                total_duration_ms: started.elapsed().as_secs_f64() * 1000.0,
                cpu_duration_ms,
                memory_duration_ms,
                process_duration_ms,
                issues,
                dropped_snapshots: state.dropped.load(Ordering::Relaxed),
                tracked_process_count: self.processes.tracked_process_count() as u32,
            },
        }
    }
}

impl Default for Collectors {
    fn default() -> Self {
        Self::new()
    }
}

/// A memory snapshot with every value zeroed, used only when Windows refused to
/// answer. The UI shows it as unavailable rather than as "0 bytes used".
fn empty_memory_snapshot() -> crate::api::JsMemorySnapshot {
    crate::api::JsMemorySnapshot {
        installed_physical_bytes: None,
        total_physical_bytes: 0.0,
        available_physical_bytes: 0.0,
        used_physical_bytes: 0.0,
        physical_utilization_percent: 0.0,
        memory_load_percent: 0.0,
        committed_bytes: None,
        commit_limit_bytes: None,
        commit_peak_bytes: None,
        cached_bytes: None,
        standby_bytes: None,
        modified_bytes: None,
        free_bytes: None,
        paged_pool_bytes: None,
        non_paged_pool_bytes: None,
        page_file_total_bytes: None,
        page_file_used_bytes: None,
        page_size_bytes: 0.0,
        debug: None,
    }
}

/// Run the sampling loop until `running` is cleared.
///
/// `deliver` is called with each snapshot; it returns `false` when the consumer
/// could not accept it, which is counted as a dropped snapshot.
pub fn run_loop<F>(state: Arc<EngineState>, mut deliver: F)
where
    F: FnMut(JsSystemSnapshot) -> bool,
{
    let mut collectors = Collectors::new();
    while state.running.load(Ordering::Relaxed) {
        let tick_started = Instant::now();
        let snapshot = collectors.collect(&state);

        if let Ok(mut latest) = state.latest.lock() {
            *latest = Some(snapshot.clone());
        }
        if !deliver(snapshot) {
            state.dropped.fetch_add(1, Ordering::Relaxed);
        }

        // Subtract the work from the period so collection cost does not push the
        // cadence out. If a tick overran the interval, sample again immediately
        // rather than trying to make up the lost time with a burst.
        let interval = state.config.interval();
        let elapsed = tick_started.elapsed();
        if let Some(remaining) = interval.checked_sub(elapsed) {
            // Wake up periodically so a stop request is honoured promptly even
            // when the configured interval is long.
            let mut left = remaining;
            let step = Duration::from_millis(50);
            while left > Duration::ZERO && state.running.load(Ordering::Relaxed) {
                let chunk = left.min(step);
                std::thread::sleep(chunk);
                left -= chunk;
            }
        }
    }
}
