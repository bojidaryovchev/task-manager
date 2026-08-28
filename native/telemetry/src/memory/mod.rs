//! System memory collection.
//!
//! "How much memory is in use" has no single answer, so this module collects the
//! components and leaves the interpretation to the UI:
//!
//! * `GlobalMemoryStatusEx` gives total and available physical bytes. "In use"
//!   is `total - available`, which is exactly what Task Manager shows, but note
//!   that *available* already counts the standby list - pages holding cached
//!   file data that can be reclaimed instantly. So "in use" is not "memory that
//!   processes are actively holding".
//! * `GetPerformanceInfo` gives the commit charge and commit limit in pages,
//!   plus the system-wide process/thread/handle counts.
//! * `NtQuerySystemInformation(SystemMemoryListInformation)` gives the
//!   free/zero/modified/standby breakdown that Task Manager's memory composition
//!   bar is drawn from, and which no documented API exposes.
//! * `GetPhysicallyInstalledSystemMemory` reads the SMBIOS value, which is
//!   larger than the OS-usable total by whatever firmware and hardware reserve.
//!
//! No value here is derived from another to make a number look plausible; each
//! field records where it came from.

use std::time::Instant;

use crate::win::ntdll;

use windows_sys::Win32::System::ProcessStatus::{GetPerformanceInfo, PERFORMANCE_INFORMATION};
use windows_sys::Win32::System::SystemInformation::{
    GetPhysicallyInstalledSystemMemory, GlobalMemoryStatusEx, MEMORYSTATUSEX,
};

#[derive(Debug, Clone, Copy)]
pub struct GlobalMemoryStatus {
    pub memory_load_percent: u32,
    pub total_physical_bytes: u64,
    pub available_physical_bytes: u64,
    /// Total bytes the system can commit: RAM plus the current page file size.
    pub total_page_file_bytes: u64,
    pub available_page_file_bytes: u64,
    pub total_virtual_bytes: u64,
    pub available_virtual_bytes: u64,
}

#[derive(Debug, Clone, Copy)]
pub struct PerformanceCounts {
    pub page_size_bytes: u64,
    pub commit_total_pages: u64,
    pub commit_limit_pages: u64,
    pub commit_peak_pages: u64,
    pub physical_total_pages: u64,
    pub physical_available_pages: u64,
    pub system_cache_pages: u64,
    pub kernel_total_pages: u64,
    pub kernel_paged_pages: u64,
    pub kernel_non_paged_pages: u64,
    pub handle_count: u32,
    pub process_count: u32,
    pub thread_count: u32,
}

#[derive(Debug, Clone, Copy)]
pub struct MemoryListBreakdown {
    pub free_and_zero_bytes: u64,
    pub modified_bytes: u64,
    pub modified_no_write_bytes: u64,
    pub standby_bytes: u64,
    pub standby_by_priority_bytes: [u64; 8],
}

#[derive(Debug, Clone)]
pub struct MemorySample {
    pub global: GlobalMemoryStatus,
    pub performance: Option<PerformanceCounts>,
    pub memory_list: Option<MemoryListBreakdown>,
    pub installed_physical_bytes: Option<u64>,
    pub page_size_bytes: u64,
}

impl MemorySample {
    pub fn used_physical_bytes(&self) -> u64 {
        self.global
            .total_physical_bytes
            .saturating_sub(self.global.available_physical_bytes)
    }

    pub fn physical_utilization_percent(&self) -> f64 {
        if self.global.total_physical_bytes == 0 {
            return 0.0;
        }
        self.used_physical_bytes() as f64 / self.global.total_physical_bytes as f64 * 100.0
    }

    /// Commit charge.
    ///
    /// Derived from `MEMORYSTATUSEX` rather than `GetPerformanceInfo`: the two
    /// were verified to be byte-identical on this platform, and
    /// `GetPerformanceInfo` costs ~2.7 ms per call because it walks the process
    /// list internally, which we already do ourselves.
    pub fn committed_bytes(&self) -> Option<u64> {
        self.global
            .total_page_file_bytes
            .checked_sub(self.global.available_page_file_bytes)
    }

    /// Commit limit: RAM plus the current page file size.
    pub fn commit_limit_bytes(&self) -> Option<u64> {
        Some(self.global.total_page_file_bytes)
    }

    pub fn commit_peak_bytes(&self) -> Option<u64> {
        self.performance
            .map(|p| p.commit_peak_pages.saturating_mul(p.page_size_bytes))
    }

    /// "Cached" as Task Manager labels it: standby plus modified pages.
    pub fn cached_bytes(&self) -> Option<u64> {
        self.memory_list
            .map(|m| m.standby_bytes + m.modified_bytes + m.modified_no_write_bytes)
    }

    pub fn paged_pool_bytes(&self) -> Option<u64> {
        self.performance
            .map(|p| p.kernel_paged_pages.saturating_mul(p.page_size_bytes))
    }

    pub fn non_paged_pool_bytes(&self) -> Option<u64> {
        self.performance
            .map(|p| p.kernel_non_paged_pages.saturating_mul(p.page_size_bytes))
    }

    /// Page file size and usage, excluding RAM.
    ///
    /// `MEMORYSTATUSEX::ullTotalPageFile` is the commit limit, i.e. RAM plus the
    /// page file, so the page file's own size is the difference. Reported only
    /// when that difference is non-negative and physically sensible.
    pub fn page_file_total_bytes(&self) -> Option<u64> {
        self.global
            .total_page_file_bytes
            .checked_sub(self.global.total_physical_bytes)
    }

    pub fn page_file_used_bytes(&self) -> Option<u64> {
        let total = self.page_file_total_bytes()?;
        let committed = self.committed_bytes()?;
        // Commit beyond what RAM could hold must be backed by the page file.
        Some(
            committed
                .saturating_sub(self.global.total_physical_bytes)
                .min(total),
        )
    }
}

fn read_global_memory_status() -> Option<GlobalMemoryStatus> {
    // SAFETY: MEMORYSTATUSEX is plain data with no invalid bit patterns; the
    // API requires dwLength to be set before the call, which happens next.
    let mut status: MEMORYSTATUSEX = unsafe { std::mem::zeroed() };
    status.dwLength = std::mem::size_of::<MEMORYSTATUSEX>() as u32;
    // SAFETY: dwLength is set to the true size of the structure, as required.
    let ok = unsafe { GlobalMemoryStatusEx(&mut status) };
    if ok == 0 {
        return None;
    }
    Some(GlobalMemoryStatus {
        memory_load_percent: status.dwMemoryLoad,
        total_physical_bytes: status.ullTotalPhys,
        available_physical_bytes: status.ullAvailPhys,
        total_page_file_bytes: status.ullTotalPageFile,
        available_page_file_bytes: status.ullAvailPageFile,
        total_virtual_bytes: status.ullTotalVirtual,
        available_virtual_bytes: status.ullAvailVirtual,
    })
}

fn read_performance_counts() -> Option<PerformanceCounts> {
    // SAFETY: PERFORMANCE_INFORMATION is plain data with no invalid bit
    // patterns, and every field is overwritten by a successful call.
    let mut info: PERFORMANCE_INFORMATION = unsafe { std::mem::zeroed() };
    let size = std::mem::size_of::<PERFORMANCE_INFORMATION>() as u32;
    // SAFETY: `cb` is the true size of the structure we pass.
    let ok = unsafe { GetPerformanceInfo(&mut info, size) };
    if ok == 0 {
        return None;
    }
    Some(PerformanceCounts {
        page_size_bytes: info.PageSize as u64,
        commit_total_pages: info.CommitTotal as u64,
        commit_limit_pages: info.CommitLimit as u64,
        commit_peak_pages: info.CommitPeak as u64,
        physical_total_pages: info.PhysicalTotal as u64,
        physical_available_pages: info.PhysicalAvailable as u64,
        system_cache_pages: info.SystemCache as u64,
        kernel_total_pages: info.KernelTotal as u64,
        kernel_paged_pages: info.KernelPaged as u64,
        kernel_non_paged_pages: info.KernelNonpaged as u64,
        handle_count: info.HandleCount,
        process_count: info.ProcessCount,
        thread_count: info.ThreadCount,
    })
}

fn read_installed_physical_bytes() -> Option<u64> {
    let mut kilobytes: u64 = 0;
    // SAFETY: single out-parameter pointing at local storage.
    let ok = unsafe { GetPhysicallyInstalledSystemMemory(&mut kilobytes) };
    if ok == 0 || kilobytes == 0 {
        return None;
    }
    kilobytes.checked_mul(1024)
}

fn read_memory_list(page_size_bytes: u64) -> Option<MemoryListBreakdown> {
    let list = ntdll::query_memory_list().ok()?;
    let pages_to_bytes = |pages: usize| (pages as u64).saturating_mul(page_size_bytes);
    let mut standby_by_priority = [0u64; 8];
    let mut standby_total = 0u64;
    for (index, pages) in list.page_count_by_priority.iter().enumerate() {
        let bytes = pages_to_bytes(*pages);
        standby_by_priority[index] = bytes;
        standby_total += bytes;
    }
    Some(MemoryListBreakdown {
        free_and_zero_bytes: pages_to_bytes(list.free_page_count + list.zero_page_count),
        modified_bytes: pages_to_bytes(list.modified_page_count),
        modified_no_write_bytes: pages_to_bytes(list.modified_no_write_page_count),
        standby_bytes: standby_total,
        standby_by_priority_bytes: standby_by_priority,
    })
}

/// How often `GetPerformanceInfo` is refreshed.
///
/// It is the only expensive call in this module (~2.7 ms, because it enumerates
/// processes internally) and the only values we still need from it - kernel pool
/// sizes, commit peak, system cache - change slowly. Everything a user watches
/// tick by tick comes from `GlobalMemoryStatusEx` and the memory list, which are
/// effectively free.
const PERFORMANCE_REFRESH_MS: u128 = 2_000;

/// Memory collector.
///
/// Every value is an instantaneous reading rather than a rate, so there is no
/// previous sample to difference. The only state is a cache of the one call that
/// is expensive enough to be worth refreshing at a lower cadence.
pub struct MemoryCollector {
    installed_physical_bytes: Option<u64>,
    page_size_bytes: u64,
    cached_performance: Option<PerformanceCounts>,
    last_performance_read: Option<Instant>,
}

impl MemoryCollector {
    pub fn new() -> Self {
        let performance = read_performance_counts();
        Self {
            // SMBIOS-reported installed RAM never changes while running.
            installed_physical_bytes: read_installed_physical_bytes(),
            page_size_bytes: performance.map(|p| p.page_size_bytes).unwrap_or(4096),
            cached_performance: performance,
            last_performance_read: Some(Instant::now()),
        }
    }

    fn performance(&mut self) -> Option<PerformanceCounts> {
        let stale = self
            .last_performance_read
            .map(|at| at.elapsed().as_millis() >= PERFORMANCE_REFRESH_MS)
            .unwrap_or(true);
        if stale {
            if let Some(fresh) = read_performance_counts() {
                self.cached_performance = Some(fresh);
            }
            self.last_performance_read = Some(Instant::now());
        }
        self.cached_performance
    }

    pub fn sample(&mut self) -> Option<MemorySample> {
        let global = read_global_memory_status()?;
        let page_size_bytes = self.page_size_bytes;
        let performance = self.performance();
        Some(MemorySample {
            global,
            performance,
            memory_list: read_memory_list(page_size_bytes),
            installed_physical_bytes: self.installed_physical_bytes,
            page_size_bytes,
        })
    }
}

impl Default for MemoryCollector {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_with(total: u64, available: u64, page_file_total: u64) -> MemorySample {
        MemorySample {
            global: GlobalMemoryStatus {
                memory_load_percent: 0,
                total_physical_bytes: total,
                available_physical_bytes: available,
                total_page_file_bytes: page_file_total,
                available_page_file_bytes: 0,
                total_virtual_bytes: 0,
                available_virtual_bytes: 0,
            },
            performance: Some(PerformanceCounts {
                page_size_bytes: 4096,
                commit_total_pages: 1000,
                commit_limit_pages: 2000,
                commit_peak_pages: 1500,
                physical_total_pages: total / 4096,
                physical_available_pages: available / 4096,
                system_cache_pages: 0,
                kernel_total_pages: 0,
                kernel_paged_pages: 100,
                kernel_non_paged_pages: 50,
                handle_count: 0,
                process_count: 0,
                thread_count: 0,
            }),
            memory_list: None,
            installed_physical_bytes: None,
            page_size_bytes: 4096,
        }
    }

    #[test]
    fn used_is_total_minus_available() {
        let sample = sample_with(64 * 1024 * 1024 * 1024, 16 * 1024 * 1024 * 1024, 0);
        assert_eq!(sample.used_physical_bytes(), 48 * 1024 * 1024 * 1024);
        assert!((sample.physical_utilization_percent() - 75.0).abs() < 1e-9);
    }

    #[test]
    fn available_larger_than_total_does_not_underflow() {
        // Should not happen, but a saturating subtraction beats a panic in a
        // monitoring loop.
        let sample = sample_with(100, 200, 0);
        assert_eq!(sample.used_physical_bytes(), 0);
        assert_eq!(sample.physical_utilization_percent(), 0.0);
    }

    #[test]
    fn zero_total_memory_yields_zero_percent_not_nan() {
        let sample = sample_with(0, 0, 0);
        assert_eq!(sample.physical_utilization_percent(), 0.0);
    }

    #[test]
    fn commit_comes_from_the_memory_status_structure() {
        // total page file is the commit limit; committed is limit minus available.
        let mut sample = sample_with(1024, 512, 8000);
        sample.global.available_page_file_bytes = 3000;
        assert_eq!(sample.commit_limit_bytes(), Some(8000));
        assert_eq!(sample.committed_bytes(), Some(5000));
    }

    #[test]
    fn pool_and_peak_values_are_pages_times_page_size() {
        let sample = sample_with(1024, 512, 0);
        assert_eq!(sample.commit_peak_bytes(), Some(1500 * 4096));
        assert_eq!(sample.paged_pool_bytes(), Some(100 * 4096));
        assert_eq!(sample.non_paged_pool_bytes(), Some(50 * 4096));
    }

    #[test]
    fn an_impossible_commit_reading_yields_no_value() {
        let mut sample = sample_with(1024, 512, 100);
        sample.global.available_page_file_bytes = 200;
        assert_eq!(sample.committed_bytes(), None);
    }

    #[test]
    fn page_file_size_is_commit_limit_minus_ram() {
        let ram = 64u64 * 1024 * 1024 * 1024;
        let sample = sample_with(ram, 0, ram + 8 * 1024 * 1024 * 1024);
        assert_eq!(sample.page_file_total_bytes(), Some(8 * 1024 * 1024 * 1024));
    }

    #[test]
    fn a_disabled_page_file_reports_zero_not_a_negative_size() {
        let ram = 64u64 * 1024 * 1024 * 1024;
        let sample = sample_with(ram, 0, ram);
        assert_eq!(sample.page_file_total_bytes(), Some(0));
        // And a nonsensical total (smaller than RAM) reports nothing at all.
        let sample = sample_with(ram, 0, ram - 1);
        assert_eq!(sample.page_file_total_bytes(), None);
    }

    #[test]
    fn cached_bytes_requires_the_memory_list() {
        let mut sample = sample_with(1024, 512, 0);
        assert_eq!(sample.cached_bytes(), None);
        sample.memory_list = Some(MemoryListBreakdown {
            free_and_zero_bytes: 100,
            modified_bytes: 200,
            modified_no_write_bytes: 50,
            standby_bytes: 700,
            standby_by_priority_bytes: [0; 8],
        });
        assert_eq!(sample.cached_bytes(), Some(950));
    }
}
