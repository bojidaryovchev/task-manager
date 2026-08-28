//! A PDH wrapper for the counters no other Windows API exposes cleanly.
//!
//! PDH is used sparingly and deliberately, for values where the alternative
//! would be inventing a formula:
//!
//! * `% Processor Utility` and `% Processor Performance` - the frequency-aware
//!   CPU figures Windows Task Manager displays. No documented API exposes them.
//! * Physical disk throughput, latency and active time, which the kernel keeps
//!   per-disk and PDH already differences for us.
//! * Network interface throughput per adapter.
//! * GPU engine utilisation and GPU memory, which Windows only publishes through
//!   the `GPU Engine` / `GPU Adapter Memory` counter sets.
//!
//! Counters are added with `PdhAddEnglishCounterW` so the paths do not depend on
//! the machine display language.
//!
//! All failures degrade to absent values. PDH being unavailable, or a counter
//! set being missing on a particular machine, must never stop the rest of the
//! collector.

use std::collections::HashMap;

use windows_sys::Win32::System::Performance::{
    PdhAddEnglishCounterW, PdhCloseQuery, PdhCollectQueryData, PdhGetFormattedCounterArrayW,
    PdhGetFormattedCounterValue, PdhOpenQueryW, PDH_FMT, PDH_FMT_COUNTERVALUE,
    PDH_FMT_COUNTERVALUE_ITEM_W, PDH_FMT_DOUBLE, PDH_HCOUNTER, PDH_HQUERY, PDH_MORE_DATA,
};

const ERROR_SUCCESS_U32: u32 = 0;

/// `PDH_FMT_NOCAP100` from `pdh.h`. Not present in windows-sys, so it is
/// defined here. Without it PDH clamps percentage counters to 100, which would
/// hide the case we specifically want to see: a CPU running above base clock
/// reporting more than 100% processor utility.
const PDH_FMT_NOCAP100: PDH_FMT = 0x0000_8000;

/// Opaque handle to a counter registered in a [`PdhQuery`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct CounterId(usize);

struct Counter {
    handle: PDH_HCOUNTER,
    path: String,
}

/// A PDH query holding any number of counters, collected together.
///
/// One `PdhCollectQueryData` per sampling interval serves every counter in the
/// query, so adding a counter costs a formatting call rather than another
/// collection. PDH derives rates from the gap between consecutive collections,
/// which is why the engine must collect exactly once per interval: calling more
/// often would silently change what every rate in here means.
pub struct PdhQuery {
    query: PDH_HQUERY,
    counters: Vec<Counter>,
    /// Collections performed. PDH rate counters need two before they format.
    collections: u64,
}

// SAFETY: a PDH query handle is not thread-affine, and this type is only ever
// touched from the single sampling thread that owns the collector.
unsafe impl Send for PdhQuery {}

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

impl PdhQuery {
    /// Open a query against live data on this machine.
    pub fn open() -> Option<Self> {
        let mut query: PDH_HQUERY = std::ptr::null_mut();
        // SAFETY: a null data source means "live data from this machine"; the
        // out-parameter points at local storage that outlives the call.
        let status = unsafe { PdhOpenQueryW(std::ptr::null(), 0, &mut query) };
        if status != ERROR_SUCCESS_U32 || query.is_null() {
            return None;
        }
        Some(Self {
            query,
            counters: Vec::new(),
            collections: 0,
        })
    }

    /// Register a counter path.
    ///
    /// Returns `None` when the counter set does not exist on this machine,
    /// which is normal: a machine with no discrete GPU has no GPU engine
    /// counters, and the caller degrades to absent values.
    pub fn add(&mut self, path: &str) -> Option<CounterId> {
        let mut handle: PDH_HCOUNTER = std::ptr::null_mut();
        let wide_path = wide(path);
        // SAFETY: `wide_path` is a NUL-terminated UTF-16 buffer that outlives
        // the call; PDH copies the path.
        let status =
            unsafe { PdhAddEnglishCounterW(self.query, wide_path.as_ptr(), 0, &mut handle) };
        if status != ERROR_SUCCESS_U32 || handle.is_null() {
            return None;
        }
        self.counters.push(Counter {
            handle,
            path: path.to_owned(),
        });
        Some(CounterId(self.counters.len() - 1))
    }

    /// True once enough collections have happened for rates to be meaningful.
    pub fn is_primed(&self) -> bool {
        self.collections >= 2
    }

    /// Collect one sample for every registered counter.
    pub fn collect(&mut self) -> bool {
        // SAFETY: `self.query` is a live handle owned by this struct.
        let status = unsafe { PdhCollectQueryData(self.query) };
        if status != ERROR_SUCCESS_U32 {
            return false;
        }
        self.collections += 1;
        true
    }

    pub fn path(&self, id: CounterId) -> Option<&str> {
        self.counters.get(id.0).map(|counter| counter.path.as_str())
    }

    pub fn registered_paths(&self) -> Vec<&str> {
        self.counters.iter().map(|c| c.path.as_str()).collect()
    }

    /// Read a single-instance counter.
    pub fn value(&self, id: CounterId) -> Option<f64> {
        if !self.is_primed() {
            return None;
        }
        let counter = self.counters.get(id.0)?;
        let mut value = PDH_FMT_COUNTERVALUE::default();
        // PDH_FMT_NOCAP100 keeps values above 100 rather than clamping them,
        // which matters for % Processor Utility on a boosting CPU.
        // SAFETY: the handle is live for the lifetime of the owning query, and
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
        // SAFETY: we requested PDH_FMT_DOUBLE, so the union holds a double.
        let raw = unsafe { value.Anonymous.doubleValue };
        raw.is_finite().then_some(raw)
    }

    /// Read a wildcard counter, returning one value per instance.
    ///
    /// Instance names come back exactly as Windows reports them, including
    /// duplicates such as two adapters with the same description, which PDH
    /// disambiguates with a `#1` suffix.
    pub fn instances(&self, id: CounterId) -> Vec<(String, f64)> {
        if !self.is_primed() {
            return Vec::new();
        }
        let Some(counter) = self.counters.get(id.0) else {
            return Vec::new();
        };

        let format = PDH_FMT_DOUBLE | PDH_FMT_NOCAP100;
        let mut buffer_size: u32 = 0;
        let mut item_count: u32 = 0;
        // SAFETY: a null item buffer with a zero size asks for the required
        // size; the call is expected to fail with PDH_MORE_DATA.
        let status = unsafe {
            PdhGetFormattedCounterArrayW(
                counter.handle,
                format,
                &mut buffer_size,
                &mut item_count,
                std::ptr::null_mut(),
            )
        };
        if status != PDH_MORE_DATA || buffer_size == 0 {
            return Vec::new();
        }
        // Guard against an implausible size rather than trusting it.
        if buffer_size > 8 * 1024 * 1024 {
            return Vec::new();
        }

        // Allocated as a Vec of the item type rather than of bytes, so the
        // buffer is correctly aligned for the pointers PDH writes into it. PDH
        // also packs the instance name strings into the tail of the same
        // allocation, hence the extra capacity.
        let item_size = std::mem::size_of::<PDH_FMT_COUNTERVALUE_ITEM_W>();
        let slots = (buffer_size as usize).div_ceil(item_size) + 1;
        let mut items: Vec<PDH_FMT_COUNTERVALUE_ITEM_W> = vec![Default::default(); slots];

        // SAFETY: the buffer holds `buffer_size` bytes at the alignment the item
        // type requires, and we pass its true size.
        let status = unsafe {
            PdhGetFormattedCounterArrayW(
                counter.handle,
                format,
                &mut buffer_size,
                &mut item_count,
                items.as_mut_ptr(),
            )
        };
        if status != ERROR_SUCCESS_U32 {
            return Vec::new();
        }

        let count = (item_count as usize).min(items.len());
        let mut out = Vec::with_capacity(count);
        for item in items.iter().take(count) {
            if item.szName.is_null() {
                continue;
            }
            if item.FmtValue.CStatus != ERROR_SUCCESS_U32 {
                continue;
            }
            // SAFETY: PDH NUL-terminates each instance name, and the string
            // lives inside `items`, which is alive for this loop.
            let name = unsafe { wide_to_string(item.szName) };
            // SAFETY: we requested PDH_FMT_DOUBLE.
            let value = unsafe { item.FmtValue.Anonymous.doubleValue };
            if !value.is_finite() {
                continue;
            }
            out.push((name, value));
        }
        out
    }

    /// Sum a wildcard counter's instances, grouped by a caller-supplied key.
    ///
    /// Used for counter sets like `GPU Engine`, where the instance name encodes
    /// several fields and the useful number is a total over a subset of them.
    pub fn instances_grouped<F>(&self, id: CounterId, key: F) -> HashMap<String, f64>
    where
        F: Fn(&str) -> Option<String>,
    {
        let mut totals: HashMap<String, f64> = HashMap::new();
        for (name, value) in self.instances(id) {
            if let Some(group) = key(&name) {
                *totals.entry(group).or_insert(0.0) += value;
            }
        }
        totals
    }
}

impl Drop for PdhQuery {
    fn drop(&mut self) {
        if !self.query.is_null() {
            // SAFETY: closing a live query also frees its counters. Called once,
            // from Drop, so the handle cannot be used afterwards.
            unsafe { PdhCloseQuery(self.query) };
            self.query = std::ptr::null_mut();
        }
    }
}

/// # Safety
/// `pointer` must be a NUL-terminated UTF-16 string.
unsafe fn wide_to_string(pointer: *const u16) -> String {
    let mut length = 0usize;
    // Bound the walk so a missing terminator cannot run away.
    while length < 1024 && *pointer.add(length) != 0 {
        length += 1;
    }
    String::from_utf16_lossy(std::slice::from_raw_parts(pointer, length))
}

// --- CPU counters -----------------------------------------------------------

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

/// The CPU counters, on top of the shared query.
pub struct PdhCpuCounters {
    utility: Option<CounterId>,
    performance: Option<CounterId>,
    processor_time: Option<CounterId>,
}

impl PdhCpuCounters {
    pub fn register(query: &mut PdhQuery) -> Self {
        Self {
            utility: query.add(r"\Processor Information(_Total)\% Processor Utility"),
            performance: query.add(r"\Processor Information(_Total)\% Processor Performance"),
            processor_time: query.add(r"\Processor Information(_Total)\% Processor Time"),
        }
    }

    pub fn read(&self, query: &PdhQuery) -> PdhCpuSample {
        PdhCpuSample {
            processor_utility_percent: self.utility.and_then(|id| query.value(id)),
            processor_performance_percent: self.performance.and_then(|id| query.value(id)),
            processor_time_percent: self.processor_time.and_then(|id| query.value(id)),
        }
    }
}
