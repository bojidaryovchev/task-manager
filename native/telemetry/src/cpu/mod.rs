//! CPU collection.
//!
//! # Which number is "CPU usage"?
//!
//! Windows can answer that question in at least three incompatible ways, and
//! this collector produces all of them rather than picking one silently:
//!
//! 1. **Time utilization** - the fraction of each logical processor's elapsed
//!    time that was not spent in the idle thread. Derived from per-processor
//!    idle/kernel/user counters. This is what `GetSystemTimes` measures and what
//!    most cross-platform monitors report. It says nothing about how fast the
//!    processor was running while it was busy.
//! 2. **Processor utility** - time utilization scaled by the processor's actual
//!    delivered performance relative to its nominal frequency. This is the
//!    number Windows Task Manager displays. It can exceed 100%.
//! 3. **Busiest logical processor** - the maximum of (1) across processors. A
//!    single-threaded process pinning one core of 24 produces ~4% by (1) and
//!    ~100% here. Tools that report "CPU 95%" for a single-threaded workload are
//!    usually reporting this, and that discrepancy is one of the things this
//!    application exists to make visible.
//!
//! Aggregate time utilization is computed by summing the per-processor deltas
//! rather than by calling `GetSystemTimes` separately, so the total and the
//! per-processor list are guaranteed to be consistent with each other. The
//! `GetSystemTimes` result is still collected, as an independent cross-check
//! surfaced in the debug view.

pub mod frequency;

use crate::win::ntdll::{self, SystemProcessorPerformanceInformation};
use crate::win::pdh::{PdhCpuQuery, PdhCpuSample};
use crate::win::topology::{read_topology, Topology};

use windows_sys::Win32::Foundation::FILETIME;
use windows_sys::Win32::System::Threading::GetSystemTimes;

/// Utilization of one logical processor over one interval.
#[derive(Debug, Clone, Copy, Default)]
pub struct LogicalProcessorSample {
    pub index: usize,
    pub group: u16,
    pub number_in_group: u8,
    pub core_id: Option<usize>,
    pub efficiency_class: Option<u8>,
    pub time_utilization_percent: f64,
    pub kernel_percent: f64,
    pub user_percent: f64,
    pub dpc_percent: f64,
    pub interrupt_percent: f64,
    pub current_frequency_mhz: Option<f64>,
    pub max_frequency_mhz: Option<f64>,
}

/// Raw inputs and intermediate values behind the aggregate CPU number.
#[derive(Debug, Clone, Copy, Default)]
pub struct CpuDebugSample {
    pub interval_ms: f64,
    pub idle_delta_100ns: f64,
    pub kernel_delta_100ns: f64,
    pub user_delta_100ns: f64,
    pub total_delta_100ns: f64,
    pub busy_delta_100ns: f64,
    pub get_system_times: Option<GetSystemTimesDelta>,
    pub counter_coverage_ratio: f64,
    pub discarded: bool,
    pub discard_reason: Option<&'static str>,
}

#[derive(Debug, Clone, Copy, Default)]
pub struct GetSystemTimesDelta {
    pub idle_delta_100ns: f64,
    pub kernel_delta_100ns: f64,
    pub user_delta_100ns: f64,
    pub utilization_percent: f64,
}

/// A complete CPU sample for one interval.
#[derive(Debug, Clone, Default)]
pub struct CpuSample {
    pub aggregate_time_utilization_percent: Option<f64>,
    pub processor_utility_percent: Option<f64>,
    pub processor_performance_percent: Option<f64>,
    pub pdh_processor_time_percent: Option<f64>,
    pub average_logical_processor_percent: Option<f64>,
    /// Machine-wide share of time spent servicing DPCs. A subset of kernel time,
    /// and notably *not* charged to any process, which is part of why process
    /// CPU shares sum to slightly less than the aggregate.
    pub aggregate_dpc_percent: Option<f64>,
    /// Machine-wide share of time spent servicing interrupts. Also a subset of
    /// kernel time and also not charged to any process.
    pub aggregate_interrupt_percent: Option<f64>,
    pub busiest_logical_processor_index: Option<usize>,
    pub busiest_logical_processor_percent: Option<f64>,
    pub per_logical_processor: Vec<LogicalProcessorSample>,
    /// Base frequency x (% Processor Performance / 100), the way Task Manager
    /// derives the displayed speed. `None` when PDH is unavailable.
    pub derived_current_frequency_mhz: Option<f64>,
    pub debug: CpuDebugSample,
}

fn filetime_to_100ns(value: FILETIME) -> u64 {
    ((value.dwHighDateTime as u64) << 32) | (value.dwLowDateTime as u64)
}

/// Stateful CPU collector. Holds the previous counter values so a rate can be
/// derived; owns the PDH query for its whole lifetime.
pub struct CpuCollector {
    topology: Topology,
    /// Previous per-processor counters, in flat index order.
    previous: Option<Vec<SystemProcessorPerformanceInformation>>,
    previous_system_times: Option<(u64, u64, u64)>,
    pdh: Option<PdhCpuQuery>,
    frequency: frequency::FrequencyReader,
    base_frequency_mhz: Option<u32>,
    brand_string: Option<String>,
    /// True when the machine has more than one processor group, which requires
    /// the per-group query form.
    multi_group: bool,
}

impl CpuCollector {
    pub fn new() -> Self {
        let topology = read_topology();
        let multi_group = topology.group_count() > 1;
        Self {
            frequency: frequency::FrequencyReader::new(topology.logical_processor_count()),
            base_frequency_mhz: frequency::read_base_frequency_mhz(),
            brand_string: frequency::read_processor_brand_string(),
            pdh: PdhCpuQuery::open(),
            previous: None,
            previous_system_times: None,
            multi_group,
            topology,
        }
    }

    pub fn topology(&self) -> &Topology {
        &self.topology
    }

    pub fn base_frequency_mhz(&self) -> Option<u32> {
        self.base_frequency_mhz
    }

    pub fn brand_string(&self) -> Option<&str> {
        self.brand_string.as_deref()
    }

    pub fn pdh_available(&self) -> bool {
        self.pdh.is_some()
    }

    pub fn active_pdh_counters(&self) -> Vec<&'static str> {
        self.pdh
            .as_ref()
            .map(|p| p.active_counter_paths())
            .unwrap_or_default()
    }

    /// Read the per-processor counters, handling multi-group machines.
    fn read_processor_counters(&self) -> Option<Vec<SystemProcessorPerformanceInformation>> {
        if self.multi_group && ntdll::is_ex_available() {
            let mut all = Vec::with_capacity(self.topology.logical_processor_count());
            for (group, count) in self.topology.processors_per_group.iter().enumerate() {
                match ntdll::query_processor_performance_for_group(group as u16, *count) {
                    Ok(mut values) => {
                        // A group that returns fewer entries than expected must
                        // not shift every later processor's identity, so pad.
                        values.resize(*count, SystemProcessorPerformanceInformation::default());
                        all.extend(values);
                    }
                    Err(_) => return None,
                }
            }
            Some(all)
        } else {
            ntdll::query_processor_performance(self.topology.logical_processor_count()).ok()
        }
    }

    fn read_system_times(&self) -> Option<(u64, u64, u64)> {
        let mut idle = FILETIME {
            dwLowDateTime: 0,
            dwHighDateTime: 0,
        };
        let mut kernel = idle;
        let mut user = idle;
        // SAFETY: three out-parameters pointing at local storage.
        let ok = unsafe { GetSystemTimes(&mut idle, &mut kernel, &mut user) };
        if ok == 0 {
            return None;
        }
        Some((
            filetime_to_100ns(idle),
            filetime_to_100ns(kernel),
            filetime_to_100ns(user),
        ))
    }

    /// Produce a sample for the interval that just elapsed.
    ///
    /// `interval_ms` must come from a monotonic clock and be the *measured*
    /// elapsed time, not the configured interval.
    ///
    /// The first call establishes a baseline and returns a sample whose
    /// utilization fields are `None`: a cumulative counter cannot yield a rate
    /// without a predecessor, and reporting the process-lifetime average as
    /// "current" would be wrong.
    pub fn sample(&mut self, interval_ms: f64) -> CpuSample {
        // PDH must be collected once per interval regardless of what else
        // succeeds, or its own rate window drifts away from ours.
        let pdh_sample = self
            .pdh
            .as_mut()
            .map(|p| p.collect())
            .unwrap_or(PdhCpuSample::default());

        let frequencies = self.frequency.read();
        let current = self.read_processor_counters();
        let system_times = self.read_system_times();

        let mut sample = CpuSample {
            processor_utility_percent: pdh_sample.processor_utility_percent,
            processor_performance_percent: pdh_sample.processor_performance_percent,
            pdh_processor_time_percent: pdh_sample.processor_time_percent,
            derived_current_frequency_mhz: match (
                self.base_frequency_mhz,
                pdh_sample.processor_performance_percent,
            ) {
                (Some(base), Some(percent)) => Some(base as f64 * percent / 100.0),
                _ => None,
            },
            ..Default::default()
        };
        sample.debug.interval_ms = interval_ms;

        let Some(current) = current else {
            sample.debug.discarded = true;
            sample.debug.discard_reason = Some("processor performance query failed");
            return sample;
        };

        // GetSystemTimes cross-check, computed independently of the per-processor path.
        if let (Some(previous), Some(now)) = (self.previous_system_times, system_times) {
            let idle = now.0.wrapping_sub(previous.0) as f64;
            let kernel = now.1.wrapping_sub(previous.1) as f64;
            let user = now.2.wrapping_sub(previous.2) as f64;
            let total = kernel + user;
            if total > 0.0 && idle >= 0.0 && idle <= total {
                sample.debug.get_system_times = Some(GetSystemTimesDelta {
                    idle_delta_100ns: idle,
                    kernel_delta_100ns: kernel,
                    user_delta_100ns: user,
                    utilization_percent: ((total - idle) / total) * 100.0,
                });
            }
        }
        self.previous_system_times = system_times;

        let previous = match self.previous.take() {
            Some(previous) if previous.len() == current.len() => previous,
            Some(_) => {
                // Processor count changed (hot-add, group change). Rebase and
                // report nothing for this interval rather than emitting a
                // meaningless delta against a different set of processors.
                self.previous = Some(current);
                sample.debug.discarded = true;
                sample.debug.discard_reason = Some("logical processor count changed");
                return sample;
            }
            None => {
                self.previous = Some(current);
                sample.debug.discarded = true;
                sample.debug.discard_reason = Some("first sample: no previous counters");
                return sample;
            }
        };

        let mut per_processor = Vec::with_capacity(current.len());
        let mut sum_busy = 0.0f64;
        let mut sum_total = 0.0f64;
        let mut sum_idle = 0.0f64;
        let mut sum_kernel = 0.0f64;
        let mut sum_user = 0.0f64;
        let mut sum_dpc = 0.0f64;
        let mut sum_interrupt = 0.0f64;
        let mut regression = false;

        for (index, (now, before)) in current.iter().zip(previous.iter()).enumerate() {
            let idle = (now.idle_time - before.idle_time) as f64;
            let kernel = (now.kernel_time - before.kernel_time) as f64;
            let user = (now.user_time - before.user_time) as f64;
            let dpc = (now.dpc_time - before.dpc_time) as f64;
            let interrupt = (now.interrupt_time - before.interrupt_time) as f64;

            // These counters are monotonic; a negative delta means the machine
            // resumed from sleep, the processor was parked and re-reported, or
            // we read a torn value. Any of those makes the whole interval
            // untrustworthy.
            if idle < 0.0 || kernel < 0.0 || user < 0.0 {
                regression = true;
            }

            let total = kernel + user;
            let busy = (total - idle).max(0.0);

            let descriptor = self.topology.logical_processors.get(index);
            let percent = |value: f64| -> f64 {
                if total > 0.0 {
                    (value / total * 100.0).clamp(0.0, 100.0)
                } else {
                    0.0
                }
            };

            per_processor.push(LogicalProcessorSample {
                index,
                group: descriptor.map(|d| d.group).unwrap_or(0),
                number_in_group: descriptor.map(|d| d.number_in_group).unwrap_or(index as u8),
                core_id: descriptor.and_then(|d| d.core_id),
                efficiency_class: descriptor.and_then(|d| d.efficiency_class),
                time_utilization_percent: percent(busy),
                kernel_percent: percent((kernel - idle).max(0.0)),
                user_percent: percent(user),
                dpc_percent: percent(dpc),
                interrupt_percent: percent(interrupt),
                current_frequency_mhz: frequencies
                    .get(index)
                    .and_then(|f| f.current_mhz)
                    .map(f64::from),
                max_frequency_mhz: frequencies.get(index).and_then(|f| f.max_mhz).map(f64::from),
            });

            sum_busy += busy;
            sum_total += total;
            sum_dpc += dpc.max(0.0);
            sum_interrupt += interrupt.max(0.0);
            sum_idle += idle.max(0.0);
            sum_kernel += kernel;
            sum_user += user;
        }

        self.previous = Some(current);

        sample.debug.idle_delta_100ns = sum_idle;
        sample.debug.kernel_delta_100ns = sum_kernel;
        sample.debug.user_delta_100ns = sum_user;
        sample.debug.total_delta_100ns = sum_total;
        sample.debug.busy_delta_100ns = sum_busy;
        // Expected counter movement for the interval: one 100ns tick per
        // processor per 100ns of wall time.
        let expected = interval_ms * 10_000.0 * per_processor.len() as f64;
        sample.debug.counter_coverage_ratio = if expected > 0.0 {
            sum_total / expected
        } else {
            0.0
        };

        if regression {
            sample.debug.discarded = true;
            sample.debug.discard_reason = Some("counter went backwards (sleep/resume?)");
            return sample;
        }
        if sum_total <= 0.0 {
            sample.debug.discarded = true;
            sample.debug.discard_reason = Some("zero total counter delta");
            return sample;
        }

        let aggregate = (sum_busy / sum_total * 100.0).clamp(0.0, 100.0);
        let average = per_processor
            .iter()
            .map(|p| p.time_utilization_percent)
            .sum::<f64>()
            / per_processor.len() as f64;
        let busiest = per_processor
            .iter()
            .max_by(|a, b| {
                a.time_utilization_percent
                    .total_cmp(&b.time_utilization_percent)
            })
            .map(|p| (p.index, p.time_utilization_percent));

        sample.aggregate_time_utilization_percent = Some(aggregate);
        sample.average_logical_processor_percent = Some(average);
        sample.aggregate_dpc_percent = Some((sum_dpc / sum_total * 100.0).clamp(0.0, 100.0));
        sample.aggregate_interrupt_percent =
            Some((sum_interrupt / sum_total * 100.0).clamp(0.0, 100.0));
        sample.busiest_logical_processor_index = busiest.map(|b| b.0);
        sample.busiest_logical_processor_percent = busiest.map(|b| b.1);
        sample.per_logical_processor = per_processor;
        sample
    }
}

impl Default for CpuCollector {
    fn default() -> Self {
        Self::new()
    }
}

/// Pure utilization maths, separated from the Windows calls so it can be tested
/// exhaustively against hand-built counter values.
pub mod calc {
    /// Per-processor utilization from one pair of counter readings.
    ///
    /// Returns `None` when the interval carries no information (zero total
    /// delta) or the counters moved backwards.
    ///
    /// `kernel` includes `idle`, which is why busy is `kernel + user - idle`
    /// and not `kernel + user`.
    pub fn utilization_percent(
        idle_delta: f64,
        kernel_delta: f64,
        user_delta: f64,
    ) -> Option<f64> {
        if idle_delta < 0.0 || kernel_delta < 0.0 || user_delta < 0.0 {
            return None;
        }
        let total = kernel_delta + user_delta;
        if total <= 0.0 {
            return None;
        }
        let busy = (total - idle_delta).max(0.0);
        Some((busy / total * 100.0).clamp(0.0, 100.0))
    }

    /// Share of total machine capacity used by a process.
    ///
    /// One fully saturated logical processor on an N-processor machine is
    /// `100 / N` percent.
    pub fn process_machine_percent(
        cpu_time_delta_100ns: f64,
        interval_ms: f64,
        logical_processor_count: usize,
    ) -> Option<f64> {
        if cpu_time_delta_100ns < 0.0 || interval_ms <= 0.0 || logical_processor_count == 0 {
            return None;
        }
        let available_100ns = interval_ms * 10_000.0 * logical_processor_count as f64;
        if available_100ns <= 0.0 {
            return None;
        }
        Some((cpu_time_delta_100ns / available_100ns * 100.0).clamp(0.0, 100.0))
    }

    /// Same measurement expressed so that one saturated logical processor is 100%.
    pub fn process_core_equivalent_percent(
        machine_percent: f64,
        logical_processor_count: usize,
    ) -> f64 {
        machine_percent * logical_processor_count as f64
    }
}

#[cfg(test)]
mod tests {
    use super::calc::*;

    /// 100ns ticks in one millisecond.
    const MS: f64 = 10_000.0;

    #[test]
    fn a_fully_idle_processor_reports_zero() {
        // Every tick of the interval went to the idle thread.
        let interval = 500.0 * MS;
        assert_eq!(utilization_percent(interval, interval, 0.0), Some(0.0));
    }

    #[test]
    fn a_fully_busy_processor_reports_one_hundred() {
        let interval = 500.0 * MS;
        assert_eq!(utilization_percent(0.0, 0.0, interval), Some(100.0));
        // All the busy time in kernel mode is equally 100%.
        assert_eq!(utilization_percent(0.0, interval, 0.0), Some(100.0));
    }

    #[test]
    fn a_half_busy_processor_reports_fifty() {
        let interval = 500.0 * MS;
        let idle = interval / 2.0;
        // kernel includes idle, so kernel = idle here and user carries the rest.
        let value = utilization_percent(idle, idle, interval / 2.0).unwrap();
        assert!((value - 50.0).abs() < 1e-9, "got {value}");
    }

    #[test]
    fn a_zero_length_interval_yields_no_value() {
        assert_eq!(utilization_percent(0.0, 0.0, 0.0), None);
    }

    #[test]
    fn a_counter_regression_yields_no_value() {
        assert_eq!(utilization_percent(-1.0, 100.0, 100.0), None);
        assert_eq!(utilization_percent(0.0, -100.0, 100.0), None);
    }

    #[test]
    fn very_large_counters_do_not_lose_the_result() {
        // Counters near the top of a 64-bit FILETIME still divide correctly
        // because we work on deltas, not absolute values.
        let big = 9.0e18f64;
        let value = utilization_percent(big / 2.0, big / 2.0, big / 2.0).unwrap();
        assert!((value - 50.0).abs() < 1e-6, "got {value}");
    }

    #[test]
    fn idle_exceeding_total_is_clamped_rather_than_negative() {
        // Can happen when the kernel updates idle and kernel counters at
        // slightly different instants.
        let value = utilization_percent(1000.0, 900.0, 0.0).unwrap();
        assert_eq!(value, 0.0);
    }

    #[test]
    fn one_saturated_processor_of_twenty_four_is_four_point_one_seven_percent() {
        // 500 ms of CPU time on a 24-logical-processor machine over 500 ms.
        let value = process_machine_percent(500.0 * MS, 500.0, 24).unwrap();
        assert!((value - 100.0 / 24.0).abs() < 1e-9, "got {value}");
        assert!((value - 4.1666).abs() < 0.001, "got {value}");
        // Expressed per core it is exactly one saturated processor.
        assert!((process_core_equivalent_percent(value, 24) - 100.0).abs() < 1e-9);
    }

    #[test]
    fn a_process_using_four_processors_reports_four_hundred_core_equivalent() {
        let value = process_machine_percent(4.0 * 500.0 * MS, 500.0, 24).unwrap();
        assert!((process_core_equivalent_percent(value, 24) - 400.0).abs() < 1e-9);
    }

    #[test]
    fn a_brand_new_process_with_no_cpu_time_reports_zero_not_null() {
        // A zero delta is a real measurement of "used no CPU"; only a missing
        // predecessor makes the value unavailable, which the collector models
        // by not calling this at all.
        assert_eq!(process_machine_percent(0.0, 500.0, 24), Some(0.0));
    }

    #[test]
    fn a_stalled_sampler_uses_the_measured_interval() {
        // 500 ms of CPU time measured over an 822 ms interval is not 100%.
        let value = process_machine_percent(500.0 * MS, 822.0, 1).unwrap();
        assert!((value - 60.827).abs() < 0.01, "got {value}");
    }

    #[test]
    fn a_negative_or_impossible_interval_yields_no_value() {
        assert_eq!(process_machine_percent(100.0, 0.0, 24), None);
        assert_eq!(process_machine_percent(100.0, -5.0, 24), None);
        assert_eq!(process_machine_percent(100.0, 500.0, 0), None);
        assert_eq!(process_machine_percent(-1.0, 500.0, 24), None);
    }
}
