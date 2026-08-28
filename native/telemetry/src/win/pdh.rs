//! A small PDH wrapper for the two counters that no other Windows API exposes:
//! `% Processor Utility` and `% Processor Performance`.
//!
//! Why PDH is worth the cost here: Windows Task Manager does not display
//! idle-time-based CPU utilization. It displays *processor utility*, which
//! scales the busy time by how fast the processor was actually running relative
//! to its nominal frequency. On a machine running below base clock, utility is
//! lower than time utilization; on a machine boosting above base clock it can
//! exceed 100%. Reproducing Task Manager's number without this counter is not
//! possible, and inventing a substitute formula would be exactly the kind of
//! "make the number look right" behaviour this project rejects.
//!
//! Counters are added with `PdhAddEnglishCounterW` so the paths do not depend on
//! the machine display language.
//!
//! All failures degrade to `None`. PDH being unavailable must never stop the
//! rest of the collector.

use windows_sys::Win32::System::Performance::{
    PdhAddEnglishCounterW, PdhCloseQuery, PdhCollectQueryData, PdhGetFormattedCounterValue,
    PdhOpenQueryW, PDH_FMT, PDH_FMT_COUNTERVALUE, PDH_FMT_DOUBLE, PDH_HCOUNTER, PDH_HQUERY,
};

const ERROR_SUCCESS_U32: u32 = 0;

/// `PDH_FMT_NOCAP100` from `pdh.h`. Not present in windows-sys, so it is
/// defined here. Without it PDH clamps percentage counters to 100, which would
/// hide the case we specifically want to see: a CPU running above base clock
/// reporting more than 100% processor utility.
const PDH_FMT_NOCAP100: PDH_FMT = 0x0000_8000;

/// One named counter inside the shared query.
struct Counter {
    handle: PDH_HCOUNTER,
    path: &'static str,
    /// Set once the counter has produced a valid value at least once.
    ever_valid: bool,
}

/// Values PDH produced for the most recent collection.
#[derive(Debug, Clone, Copy, Default)]
pub struct PdhCpuSample {
    /// `\Processor Information(_Total)\% Processor Utility`.
    ///
    /// Not capped at 100: a processor running above its nominal frequency
    /// legitimately reports more, and clamping here would hide the effect.
    pub processor_utility_percent: Option<f64>,
    /// `\Processor Information(_Total)\% Processor Performance`.
    ///
    /// Average frequency during the interval as a percentage of nominal.
    /// Multiply by the base frequency to get the current clock speed, which is
    /// how Task Manager derives the "Speed" figure.
    pub processor_performance_percent: Option<f64>,
    /// `\Processor Information(_Total)\% Processor Time`, kept as an independent
    /// cross-check of our own idle-time calculation.
    pub processor_time_percent: Option<f64>,
}

/// A PDH query holding the CPU counters, collected once per sampling interval.
pub struct PdhCpuQuery {
    query: PDH_HQUERY,
    utility: Option<Counter>,
    performance: Option<Counter>,
    processor_time: Option<Counter>,
    /// PDH rate counters need two collections before they can be formatted.
    collections: u64,
}

// SAFETY: a PDH query handle is not thread-affine; we additionally only ever
// touch it from the single sampling thread that owns the collector.
unsafe impl Send for PdhCpuQuery {}

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

impl PdhCpuQuery {
    /// Open the query and add every counter. Returns `None` when PDH itself is
    /// unavailable; individual counters that fail to add are simply absent.
    pub fn open() -> Option<Self> {
        let mut query: PDH_HQUERY = std::ptr::null_mut();
        // SAFETY: a null data source means "live data from this machine"; the
        // out-parameter points at local storage that outlives the call.
        let status = unsafe { PdhOpenQueryW(std::ptr::null(), 0, &mut query) };
        if status != ERROR_SUCCESS_U32 || query.is_null() {
            return None;
        }
        let mut this = Self {
            query,
            utility: None,
            performance: None,
            processor_time: None,
            collections: 0,
        };
        this.utility = this.add(r"\Processor Information(_Total)\% Processor Utility");
        this.performance = this.add(r"\Processor Information(_Total)\% Processor Performance");
        this.processor_time = this.add(r"\Processor Information(_Total)\% Processor Time");
        if this.utility.is_none() && this.performance.is_none() && this.processor_time.is_none() {
            return None;
        }
        Some(this)
    }

    fn add(&mut self, path: &'static str) -> Option<Counter> {
        let mut handle: PDH_HCOUNTER = std::ptr::null_mut();
        let wide_path = wide(path);
        // SAFETY: `wide_path` is a NUL-terminated UTF-16 buffer that outlives
        // the call; PDH copies the path.
        let status =
            unsafe { PdhAddEnglishCounterW(self.query, wide_path.as_ptr(), 0, &mut handle) };
        if status != ERROR_SUCCESS_U32 || handle.is_null() {
            return None;
        }
        Some(Counter {
            handle,
            path,
            ever_valid: false,
        })
    }

    /// Collect one sample. Call exactly once per sampling interval: PDH derives
    /// rates from the gap between consecutive collections, so calling it more
    /// often than the collector samples would change what the values mean.
    pub fn collect(&mut self) -> PdhCpuSample {
        // SAFETY: `self.query` is a live handle owned by this struct.
        let status = unsafe { PdhCollectQueryData(self.query) };
        if status != ERROR_SUCCESS_U32 {
            return PdhCpuSample::default();
        }
        self.collections += 1;
        if self.collections < 2 {
            // First collection only establishes the baseline; formatting it
            // would return PDH_CSTATUS_INVALID_DATA.
            return PdhCpuSample::default();
        }
        PdhCpuSample {
            processor_utility_percent: read_counter(self.utility.as_mut()),
            processor_performance_percent: read_counter(self.performance.as_mut()),
            processor_time_percent: read_counter(self.processor_time.as_mut()),
        }
    }

    /// Paths of the counters that were successfully registered, for the debug UI.
    pub fn active_counter_paths(&self) -> Vec<&'static str> {
        [
            self.utility.as_ref(),
            self.performance.as_ref(),
            self.processor_time.as_ref(),
        ]
        .into_iter()
        .flatten()
        .map(|c| c.path)
        .collect()
    }
}

impl Drop for PdhCpuQuery {
    fn drop(&mut self) {
        if !self.query.is_null() {
            // SAFETY: closing a live query also frees its counters. Called once,
            // from Drop, so the handle cannot be used afterwards.
            unsafe { PdhCloseQuery(self.query) };
            self.query = std::ptr::null_mut();
        }
    }
}

fn read_counter(counter: Option<&mut Counter>) -> Option<f64> {
    let counter = counter?;
    let mut value = PDH_FMT_COUNTERVALUE::default();
    // PDH_FMT_NOCAP100 keeps values above 100 instead of clamping them, which
    // matters for % Processor Utility on a boosting CPU.
    // SAFETY: `counter.handle` is live for the lifetime of the owning query, and
    // `value` is a properly sized output structure.
    let status = unsafe {
        PdhGetFormattedCounterValue(
            counter.handle,
            PDH_FMT_DOUBLE | PDH_FMT_NOCAP100,
            std::ptr::null_mut(),
            &mut value,
        )
    };
    if status != ERROR_SUCCESS_U32 || value.CStatus != ERROR_SUCCESS_U32 {
        return None;
    }
    counter.ever_valid = true;
    // SAFETY: we requested PDH_FMT_DOUBLE, so the union holds a double.
    let raw = unsafe { value.Anonymous.doubleValue };
    if raw.is_finite() {
        Some(raw)
    } else {
        None
    }
}
