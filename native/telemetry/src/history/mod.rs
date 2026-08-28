//! Historical telemetry.
//!
//! # What this is for
//!
//! Answering questions after the fact: why did the machine stall five minutes
//! ago, what allocated ten gigabytes, when did the disk saturate. That means
//! history has to survive the application being closed, and it has to keep fine
//! detail for the recent past without growing without bound.
//!
//! # Tiered retention
//!
//! Four tiers, each an aggregate of the interval below it:
//!
//! | Tier | Resolution | Retention | Rows |
//! |---|---|---|---|
//! | 0 | every sample (500 ms) | 10 minutes | ~1200 |
//! | 1 | 5 seconds | 1 hour | 720 |
//! | 2 | 1 minute | 24 hours | 1440 |
//! | 3 | 5 minutes | 7 days | 2016 |
//!
//! Around 5400 rows in total, so the database stays a few hundred kilobytes
//! however long the application runs.
//!
//! # How a tier is built
//!
//! Not by re-reading and re-aggregating the finer tier, which would need
//! bookkeeping to know what had already been rolled up. Instead every tier keeps
//! an in-memory accumulator that each sample is added to; when a tier's window
//! elapses it writes one row and resets. Each row is therefore an exact mean
//! over its window, computed from every sample, not a mean of means.
//!
//! Peaks are kept alongside means, because an average hides exactly the spike
//! that a forensic question is about.
//!
//! # Write behaviour
//!
//! Tier 0 rows are buffered and flushed in one transaction every few seconds, so
//! a monitoring tool left running does not keep the disk busy on its own
//! account. With history disabled nothing is opened and nothing is written.

use std::path::{Path, PathBuf};

use rusqlite::{params, Connection};

/// Resolution and retention of each tier.
const TIERS: [TierConfig; 4] = [
    TierConfig {
        index: 0,
        window_ms: 0,
        retention_ms: 10 * 60 * 1000,
    },
    TierConfig {
        index: 1,
        window_ms: 5_000,
        retention_ms: 60 * 60 * 1000,
    },
    TierConfig {
        index: 2,
        window_ms: 60_000,
        retention_ms: 24 * 60 * 60 * 1000,
    },
    TierConfig {
        index: 3,
        window_ms: 300_000,
        retention_ms: 7 * 24 * 60 * 60 * 1000,
    },
];

/// How often buffered rows are written, and how often old rows are pruned.
const FLUSH_INTERVAL_MS: f64 = 5_000.0;
const PRUNE_INTERVAL_MS: f64 = 60_000.0;

#[derive(Debug, Clone, Copy)]
struct TierConfig {
    index: u8,
    /// Aggregation window. Zero means "one row per sample".
    window_ms: u64,
    retention_ms: u64,
}

/// The values history keeps. Deliberately a fixed, small set: these are the
/// system-wide figures a post-hoc investigation starts from.
#[derive(Debug, Clone, Copy, Default)]
pub struct HistorySample {
    pub cpu_time_percent: Option<f64>,
    pub cpu_utility_percent: Option<f64>,
    pub cpu_busiest_percent: Option<f64>,
    pub memory_used_bytes: Option<f64>,
    pub memory_available_bytes: Option<f64>,
    pub memory_committed_bytes: Option<f64>,
    pub disk_read_bytes_per_second: Option<f64>,
    pub disk_write_bytes_per_second: Option<f64>,
    pub disk_active_percent: Option<f64>,
    pub network_down_bytes_per_second: Option<f64>,
    pub network_up_bytes_per_second: Option<f64>,
    pub gpu_percent: Option<f64>,
    pub gpu_memory_bytes: Option<f64>,
    pub process_count: Option<f64>,
    pub thread_count: Option<f64>,
    pub handle_count: Option<f64>,
}

/// One stored point: the mean over its window, plus the peaks within it.
#[derive(Debug, Clone, Default)]
pub struct HistoryPoint {
    pub timestamp_unix_ms: f64,
    pub sample: HistorySample,
    /// Peak CPU, memory and disk within the window. An average over five
    /// minutes hides the spike that caused the problem.
    pub cpu_time_peak_percent: Option<f64>,
    pub memory_used_peak_bytes: Option<f64>,
    pub disk_total_peak_bytes_per_second: Option<f64>,
}

/// Running mean and peak for one field.
#[derive(Debug, Clone, Copy, Default)]
struct Running {
    sum: f64,
    count: u32,
    peak: f64,
}

impl Running {
    fn add(&mut self, value: Option<f64>) {
        let Some(value) = value else { return };
        if !value.is_finite() {
            return;
        }
        self.sum += value;
        self.count += 1;
        if self.count == 1 || value > self.peak {
            self.peak = value;
        }
    }

    /// Mean, or `None` when nothing in the window was measured. Absent stays
    /// absent rather than becoming zero.
    fn mean(&self) -> Option<f64> {
        (self.count > 0).then(|| self.sum / f64::from(self.count))
    }

    fn peak(&self) -> Option<f64> {
        (self.count > 0).then_some(self.peak)
    }
}

/// Accumulator for one tier.
#[derive(Debug, Default)]
struct Accumulator {
    started_at_ms: Option<f64>,
    cpu_time: Running,
    cpu_utility: Running,
    cpu_busiest: Running,
    memory_used: Running,
    memory_available: Running,
    memory_committed: Running,
    disk_read: Running,
    disk_write: Running,
    disk_active: Running,
    network_down: Running,
    network_up: Running,
    gpu: Running,
    gpu_memory: Running,
    processes: Running,
    threads: Running,
    handles: Running,
    /// Peak of read+write together, which is the number a disk spike is seen in.
    disk_total_peak: Running,
}

impl Accumulator {
    fn add(&mut self, timestamp_ms: f64, sample: &HistorySample) {
        if self.started_at_ms.is_none() {
            self.started_at_ms = Some(timestamp_ms);
        }
        self.cpu_time.add(sample.cpu_time_percent);
        self.cpu_utility.add(sample.cpu_utility_percent);
        self.cpu_busiest.add(sample.cpu_busiest_percent);
        self.memory_used.add(sample.memory_used_bytes);
        self.memory_available.add(sample.memory_available_bytes);
        self.memory_committed.add(sample.memory_committed_bytes);
        self.disk_read.add(sample.disk_read_bytes_per_second);
        self.disk_write.add(sample.disk_write_bytes_per_second);
        self.disk_active.add(sample.disk_active_percent);
        self.network_down.add(sample.network_down_bytes_per_second);
        self.network_up.add(sample.network_up_bytes_per_second);
        self.gpu.add(sample.gpu_percent);
        self.gpu_memory.add(sample.gpu_memory_bytes);
        self.processes.add(sample.process_count);
        self.threads.add(sample.thread_count);
        self.handles.add(sample.handle_count);
        match (
            sample.disk_read_bytes_per_second,
            sample.disk_write_bytes_per_second,
        ) {
            (None, None) => {}
            (read, write) => self
                .disk_total_peak
                .add(Some(read.unwrap_or(0.0) + write.unwrap_or(0.0))),
        }
    }

    fn take(&mut self) -> Option<HistoryPoint> {
        let started = self.started_at_ms?;
        let point = HistoryPoint {
            timestamp_unix_ms: started,
            sample: HistorySample {
                cpu_time_percent: self.cpu_time.mean(),
                cpu_utility_percent: self.cpu_utility.mean(),
                cpu_busiest_percent: self.cpu_busiest.mean(),
                memory_used_bytes: self.memory_used.mean(),
                memory_available_bytes: self.memory_available.mean(),
                memory_committed_bytes: self.memory_committed.mean(),
                disk_read_bytes_per_second: self.disk_read.mean(),
                disk_write_bytes_per_second: self.disk_write.mean(),
                disk_active_percent: self.disk_active.mean(),
                network_down_bytes_per_second: self.network_down.mean(),
                network_up_bytes_per_second: self.network_up.mean(),
                gpu_percent: self.gpu.mean(),
                gpu_memory_bytes: self.gpu_memory.mean(),
                process_count: self.processes.mean(),
                thread_count: self.threads.mean(),
                handle_count: self.handles.mean(),
            },
            cpu_time_peak_percent: self.cpu_time.peak(),
            memory_used_peak_bytes: self.memory_used.peak(),
            disk_total_peak_bytes_per_second: self.disk_total_peak.peak(),
        };
        self.reset();
        Some(point)
    }

    fn reset(&mut self) {
        *self = Self::default();
    }
}

/// Persistent history, backed by SQLite.
pub struct HistoryStore {
    connection: Connection,
    path: PathBuf,
    accumulators: [Accumulator; 4],
    /// Tier 0 rows waiting to be written in one transaction.
    pending: Vec<(u8, HistoryPoint)>,
    last_flush_ms: f64,
    last_prune_ms: f64,
    /// Set after a write failure so a broken database stops costing us anything.
    failed: bool,
}

impl HistoryStore {
    /// Open, creating the schema when needed.
    pub fn open(path: &Path) -> rusqlite::Result<Self> {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let connection = Connection::open(path)?;
        // WAL keeps a reader from blocking the sampling thread's writes, and
        // NORMAL is the right durability trade for telemetry: losing the last
        // few seconds after a power cut is acceptable, stalling the sampler on
        // every commit is not.
        connection.pragma_update(None, "journal_mode", "WAL")?;
        connection.pragma_update(None, "synchronous", "NORMAL")?;
        connection.execute_batch(SCHEMA)?;
        Ok(Self {
            connection,
            path: path.to_path_buf(),
            accumulators: Default::default(),
            pending: Vec::new(),
            last_flush_ms: 0.0,
            last_prune_ms: 0.0,
            failed: false,
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn has_failed(&self) -> bool {
        self.failed
    }

    /// Record one sample into every tier.
    ///
    /// `monotonic_ms` drives the windows and `wall_clock_unix_ms` is what gets
    /// stored, so a clock adjustment cannot make a bucket close early or a row
    /// land out of order.
    pub fn record(&mut self, monotonic_ms: f64, wall_clock_unix_ms: f64, sample: &HistorySample) {
        if self.failed {
            return;
        }
        for (index, config) in TIERS.iter().enumerate() {
            let accumulator = &mut self.accumulators[index];
            accumulator.add(wall_clock_unix_ms, sample);
            let elapsed = accumulator
                .started_at_ms
                .map(|started| wall_clock_unix_ms - started)
                .unwrap_or(0.0);
            let complete = config.window_ms == 0 || elapsed >= config.window_ms as f64;
            if complete {
                if let Some(point) = accumulator.take() {
                    self.pending.push((config.index, point));
                }
            }
        }

        if monotonic_ms - self.last_flush_ms >= FLUSH_INTERVAL_MS {
            self.last_flush_ms = monotonic_ms;
            self.flush();
        }
        if monotonic_ms - self.last_prune_ms >= PRUNE_INTERVAL_MS {
            self.last_prune_ms = monotonic_ms;
            self.prune(wall_clock_unix_ms);
        }
    }

    /// Write every buffered row in one transaction.
    pub fn flush(&mut self) {
        if self.failed || self.pending.is_empty() {
            return;
        }
        let rows = std::mem::take(&mut self.pending);
        let result = (|| -> rusqlite::Result<()> {
            let transaction = self.connection.unchecked_transaction()?;
            {
                let mut statement = transaction.prepare_cached(INSERT)?;
                for (tier, point) in &rows {
                    statement.execute(params![
                        tier,
                        point.timestamp_unix_ms,
                        point.sample.cpu_time_percent,
                        point.sample.cpu_utility_percent,
                        point.sample.cpu_busiest_percent,
                        point.sample.memory_used_bytes,
                        point.sample.memory_available_bytes,
                        point.sample.memory_committed_bytes,
                        point.sample.disk_read_bytes_per_second,
                        point.sample.disk_write_bytes_per_second,
                        point.sample.disk_active_percent,
                        point.sample.network_down_bytes_per_second,
                        point.sample.network_up_bytes_per_second,
                        point.sample.gpu_percent,
                        point.sample.gpu_memory_bytes,
                        point.sample.process_count,
                        point.sample.thread_count,
                        point.sample.handle_count,
                        point.cpu_time_peak_percent,
                        point.memory_used_peak_bytes,
                        point.disk_total_peak_bytes_per_second,
                    ])?;
                }
            }
            transaction.commit()
        })();
        if result.is_err() {
            // A database that cannot be written is not worth retrying twice a
            // second; stop touching it and report it as unavailable.
            self.failed = true;
        }
    }

    /// Drop rows past each tier's retention.
    fn prune(&mut self, now_unix_ms: f64) {
        for config in TIERS.iter() {
            let cutoff = now_unix_ms - config.retention_ms as f64;
            if self
                .connection
                .execute(
                    "DELETE FROM samples WHERE tier = ?1 AND ts < ?2",
                    params![config.index, cutoff],
                )
                .is_err()
            {
                self.failed = true;
                return;
            }
        }
    }

    /// Read back a window, choosing the finest tier that covers it.
    pub fn query(&self, from_unix_ms: f64, to_unix_ms: f64) -> Vec<HistoryPoint> {
        if self.failed {
            return Vec::new();
        }
        let span_ms = (to_unix_ms - from_unix_ms).max(0.0);
        let tier = tier_for_span(span_ms);
        let mut statement = match self.connection.prepare_cached(SELECT) {
            Ok(statement) => statement,
            Err(_) => return Vec::new(),
        };
        let rows = statement.query_map(params![tier, from_unix_ms, to_unix_ms], |row| {
            Ok(HistoryPoint {
                timestamp_unix_ms: row.get(0)?,
                sample: HistorySample {
                    cpu_time_percent: row.get(1)?,
                    cpu_utility_percent: row.get(2)?,
                    cpu_busiest_percent: row.get(3)?,
                    memory_used_bytes: row.get(4)?,
                    memory_available_bytes: row.get(5)?,
                    memory_committed_bytes: row.get(6)?,
                    disk_read_bytes_per_second: row.get(7)?,
                    disk_write_bytes_per_second: row.get(8)?,
                    disk_active_percent: row.get(9)?,
                    network_down_bytes_per_second: row.get(10)?,
                    network_up_bytes_per_second: row.get(11)?,
                    gpu_percent: row.get(12)?,
                    gpu_memory_bytes: row.get(13)?,
                    process_count: row.get(14)?,
                    thread_count: row.get(15)?,
                    handle_count: row.get(16)?,
                },
                cpu_time_peak_percent: row.get(17)?,
                memory_used_peak_bytes: row.get(18)?,
                disk_total_peak_bytes_per_second: row.get(19)?,
            })
        });
        match rows {
            Ok(rows) => rows.filter_map(Result::ok).collect(),
            Err(_) => Vec::new(),
        }
    }

    /// Rows currently stored per tier, for the debug view.
    pub fn row_counts(&self) -> Vec<(u8, u32)> {
        TIERS
            .iter()
            .map(|config| {
                let count: u32 = self
                    .connection
                    .query_row(
                        "SELECT COUNT(*) FROM samples WHERE tier = ?1",
                        params![config.index],
                        |row| row.get(0),
                    )
                    .unwrap_or(0);
                (config.index, count)
            })
            .collect()
    }
}

/// Nominal resolution of a tier, in milliseconds. Tier 0 is one row per sample.
pub fn tier_resolution_ms(tier: u8) -> f64 {
    TIERS
        .iter()
        .find(|config| config.index == tier)
        .map(|config| config.window_ms as f64)
        .unwrap_or(0.0)
}

/// Pick the finest tier whose retention covers the requested span.
///
/// Asking for seven days at half-second resolution would return a million
/// points that no chart can draw; asking for the last minute from the five
/// minute tier would return one. This picks the tier that actually has data for
/// the window.
pub fn tier_for_span(span_ms: f64) -> u8 {
    for config in TIERS.iter() {
        if span_ms <= config.retention_ms as f64 {
            return config.index;
        }
    }
    // Longer than anything retained: the coarsest tier is all there is.
    TIERS[TIERS.len() - 1].index
}

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS samples (
  tier INTEGER NOT NULL,
  ts REAL NOT NULL,
  cpu_time REAL, cpu_utility REAL, cpu_busiest REAL,
  mem_used REAL, mem_available REAL, mem_committed REAL,
  disk_read REAL, disk_write REAL, disk_active REAL,
  net_down REAL, net_up REAL,
  gpu_util REAL, gpu_mem REAL,
  processes REAL, threads REAL, handles REAL,
  cpu_time_peak REAL, mem_used_peak REAL, disk_total_peak REAL,
  PRIMARY KEY (tier, ts)
) WITHOUT ROWID;
";

const INSERT: &str = "
INSERT OR REPLACE INTO samples (
  tier, ts, cpu_time, cpu_utility, cpu_busiest,
  mem_used, mem_available, mem_committed,
  disk_read, disk_write, disk_active,
  net_down, net_up, gpu_util, gpu_mem,
  processes, threads, handles,
  cpu_time_peak, mem_used_peak, disk_total_peak
) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21)
";

const SELECT: &str = "
SELECT ts, cpu_time, cpu_utility, cpu_busiest,
       mem_used, mem_available, mem_committed,
       disk_read, disk_write, disk_active,
       net_down, net_up, gpu_util, gpu_mem,
       processes, threads, handles,
       cpu_time_peak, mem_used_peak, disk_total_peak
FROM samples WHERE tier = ?1 AND ts >= ?2 AND ts <= ?3 ORDER BY ts
";

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(cpu: f64, memory: f64) -> HistorySample {
        HistorySample {
            cpu_time_percent: Some(cpu),
            memory_used_bytes: Some(memory),
            ..Default::default()
        }
    }

    fn store() -> HistoryStore {
        // An in-memory database exercises exactly the same SQL as a file.
        let mut store = HistoryStore::open(Path::new(":memory:")).expect("open");
        store.last_prune_ms = f64::MAX / 2.0;
        store
    }

    #[test]
    fn tier_selection_picks_the_finest_tier_covering_the_span() {
        assert_eq!(tier_for_span(60_000.0), 0); // one minute -> raw
        assert_eq!(tier_for_span(10.0 * 60_000.0), 0); // exactly ten minutes
        assert_eq!(tier_for_span(30.0 * 60_000.0), 1); // half an hour -> 5s
        assert_eq!(tier_for_span(6.0 * 3_600_000.0), 2); // six hours -> 1m
        assert_eq!(tier_for_span(3.0 * 86_400_000.0), 3); // three days -> 5m
    }

    #[test]
    fn a_span_longer_than_any_retention_uses_the_coarsest_tier() {
        assert_eq!(tier_for_span(365.0 * 86_400_000.0), 3);
    }

    #[test]
    fn every_sample_produces_a_raw_row() {
        let mut store = store();
        for i in 0..5 {
            store.record(
                i as f64 * 500.0,
                1_000.0 + i as f64 * 500.0,
                &sample(10.0, 100.0),
            );
        }
        store.flush();
        // A short window selects tier 0, which holds one row per sample.
        let points = store.query(0.0, 60_000.0);
        assert_eq!(points.len(), 5);
    }

    #[test]
    fn a_span_beyond_the_raw_retention_reads_a_coarser_tier() {
        // Recording only raw rows and then asking for a week returns nothing,
        // because the week-long tier has not accumulated a row yet. That is the
        // intended behaviour: a query is answered from the tier that actually
        // covers the requested span, never by upsampling a coarse one or
        // returning a million raw points a chart cannot draw.
        let mut store = store();
        store.record(0.0, 1_000.0, &sample(10.0, 100.0));
        store.flush();
        assert_eq!(store.query(0.0, 60_000.0).len(), 1);
        assert_eq!(store.query(0.0, 7.0 * 86_400_000.0).len(), 0);
    }

    #[test]
    fn a_coarser_tier_averages_over_its_window_and_keeps_the_peak() {
        let mut store = store();
        // Ten samples 1s apart: tier 1 has a 5s window, so two rows.
        for i in 0..11 {
            let cpu = if i == 3 { 90.0 } else { 10.0 };
            store.record(i as f64 * 1000.0, i as f64 * 1000.0, &sample(cpu, 100.0));
        }
        store.flush();
        let tier1 = store.query(0.0, 30.0 * 60_000.0);
        // Queried over half an hour, so this reads tier 1.
        assert!(!tier1.is_empty(), "expected tier 1 rows");
        let first = &tier1[0];
        // Mean of five 10s and one 90 is well above 10 but far below 90.
        let mean = first.sample.cpu_time_percent.expect("mean");
        assert!(mean > 10.0 && mean < 90.0, "mean was {mean}");
        // The spike survives as a peak even though the mean smoothed it away.
        assert_eq!(first.cpu_time_peak_percent, Some(90.0));
    }

    #[test]
    fn an_unmeasured_field_stays_absent_rather_than_becoming_zero() {
        let mut store = store();
        // cpu present, gpu never measured.
        for i in 0..3 {
            store.record(i as f64 * 500.0, i as f64 * 500.0, &sample(50.0, 100.0));
        }
        store.flush();
        let points = store.query(0.0, 1e12);
        assert!(points.iter().all(|p| p.sample.gpu_percent.is_none()));
        assert!(points.iter().all(|p| p.sample.cpu_time_percent.is_some()));
    }

    #[test]
    fn a_running_mean_ignores_absent_and_non_finite_values() {
        let mut running = Running::default();
        running.add(None);
        running.add(Some(f64::NAN));
        running.add(Some(f64::INFINITY));
        assert_eq!(running.mean(), None);
        running.add(Some(4.0));
        running.add(Some(6.0));
        assert_eq!(running.mean(), Some(5.0));
        assert_eq!(running.peak(), Some(6.0));
    }

    #[test]
    fn pruning_drops_rows_past_retention() {
        let mut store = store();
        // A row well outside tier 0's ten-minute retention.
        store.record(0.0, 0.0, &sample(10.0, 100.0));
        store.flush();
        assert_eq!(store.query(0.0, 60_000.0).len(), 1);
        // An hour later, that row is past tier 0's ten-minute retention.
        store.prune(60.0 * 60_000.0);
        assert_eq!(store.query(0.0, 60_000.0).len(), 0);
    }

    #[test]
    fn a_query_window_excludes_rows_outside_it() {
        let mut store = store();
        for i in 0..10 {
            store.record(i as f64 * 500.0, i as f64 * 1000.0, &sample(10.0, 100.0));
        }
        store.flush();
        // Both queries span under ten minutes, so both read tier 0.
        let all = store.query(0.0, 600_000.0).len();
        let window = store.query(3000.0, 6000.0).len();
        assert!(
            window < all,
            "window {window} was not smaller than all {all}"
        );
        assert_eq!(window, 4); // 3000, 4000, 5000, 6000
    }
}
