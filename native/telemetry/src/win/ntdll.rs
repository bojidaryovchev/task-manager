//! Dynamically-resolved `ntdll.dll` entry points and the native structures we
//! read from them.
//!
//! Why NT APIs at all: `NtQuerySystemInformation` is the only way to obtain
//! several values that Task Manager itself displays and that no documented Win32
//! API exposes - per-logical-processor idle/kernel/user/DPC/interrupt time, the
//! standby/modified page breakdown, and per-process *private working set*.
//! The alternative (opening a handle to every process every 500 ms) is both
//! slower and less complete because it fails with ACCESS_DENIED on protected
//! processes.
//!
//! Everything here is resolved with `GetProcAddress` rather than linked, so a
//! missing export degrades one metric instead of failing to load the module.
//!
//! # Safety
//! The structure layouts below are the layouts that have been stable since
//! Windows 7 and are the ones Sysinternals tooling reads. Every reader checks
//! the returned length before dereferencing, and all parsing is bounds-checked.

use std::ffi::c_void;
use std::sync::OnceLock;

use windows_sys::core::PCSTR;
use windows_sys::Win32::Foundation::{HMODULE, NTSTATUS, UNICODE_STRING};
use windows_sys::Win32::System::LibraryLoader::{GetModuleHandleA, GetProcAddress};

pub const STATUS_SUCCESS: NTSTATUS = 0;
pub const STATUS_INFO_LENGTH_MISMATCH: NTSTATUS = 0xC000_0004_u32 as NTSTATUS;
pub const STATUS_NOT_IMPLEMENTED: NTSTATUS = 0xC000_0002_u32 as NTSTATUS;

// --- SYSTEM_INFORMATION_CLASS values we use ---------------------------------

/// `SystemProcessInformation` - one entry per process, threads inline.
pub const SYSTEM_PROCESS_INFORMATION_CLASS: i32 = 5;
/// `SystemProcessorPerformanceInformation` - per logical processor CPU times.
pub const SYSTEM_PROCESSOR_PERFORMANCE_INFORMATION_CLASS: i32 = 8;
/// `SystemMemoryListInformation` - free/zero/modified/standby page counts.
pub const SYSTEM_MEMORY_LIST_INFORMATION_CLASS: i32 = 80;

/// `SYSTEM_PROCESSOR_PERFORMANCE_INFORMATION`.
///
/// `KernelTime` **includes** `IdleTime`, and `DpcTime` / `InterruptTime` are
/// also accounted inside `KernelTime`. All values are cumulative 100ns units.
#[repr(C)]
#[derive(Debug, Clone, Copy, Default)]
pub struct SystemProcessorPerformanceInformation {
    pub idle_time: i64,
    pub kernel_time: i64,
    pub user_time: i64,
    pub dpc_time: i64,
    pub interrupt_time: i64,
    pub interrupt_count: u32,
    _padding: u32,
}

/// `SYSTEM_MEMORY_LIST_INFORMATION`, counts are in pages.
#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct SystemMemoryListInformation {
    pub zero_page_count: usize,
    pub free_page_count: usize,
    pub modified_page_count: usize,
    pub modified_no_write_page_count: usize,
    pub bad_page_count: usize,
    /// Standby pages, split by cache priority 0..=7.
    pub page_count_by_priority: [usize; 8],
    pub repurposed_pages_by_priority: [usize; 8],
    pub modified_page_count_page_file: usize,
}

/// `SYSTEM_PROCESS_INFORMATION` (Windows 7+ layout, x64).
///
/// Followed in memory by `number_of_threads` x `SYSTEM_THREAD_INFORMATION`.
/// `next_entry_offset` is a byte offset to the following process entry, or 0
/// at the end of the list.
#[repr(C)]
#[derive(Clone, Copy)]
pub struct SystemProcessInformation {
    pub next_entry_offset: u32,
    pub number_of_threads: u32,
    /// Private working set in bytes - the value the Task Manager "Memory"
    /// column is derived from. Available since Windows Vista.
    pub working_set_private_size: i64,
    pub hard_fault_count: u32,
    pub number_of_threads_high_watermark: u32,
    pub cycle_time: u64,
    pub create_time: i64,
    pub user_time: i64,
    pub kernel_time: i64,
    pub image_name: UNICODE_STRING,
    pub base_priority: i32,
    pub unique_process_id: isize,
    pub inherited_from_unique_process_id: isize,
    pub handle_count: u32,
    pub session_id: u32,
    pub unique_process_key: usize,
    pub peak_virtual_size: usize,
    pub virtual_size: usize,
    pub page_fault_count: u32,
    pub peak_working_set_size: usize,
    pub working_set_size: usize,
    pub quota_peak_paged_pool_usage: usize,
    pub quota_paged_pool_usage: usize,
    pub quota_peak_non_paged_pool_usage: usize,
    pub quota_non_paged_pool_usage: usize,
    /// Private committed bytes (the Task Manager "Commit size" column).
    pub pagefile_usage: usize,
    pub peak_pagefile_usage: usize,
    pub private_page_count: usize,
    pub read_operation_count: i64,
    pub write_operation_count: i64,
    pub other_operation_count: i64,
    pub read_transfer_count: i64,
    pub write_transfer_count: i64,
    pub other_transfer_count: i64,
}

/// `SYSTEM_THREAD_INFORMATION`, immediately following each process entry.
#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct SystemThreadInformation {
    pub kernel_time: i64,
    pub user_time: i64,
    pub create_time: i64,
    pub wait_time: u32,
    _padding: u32,
    pub start_address: usize,
    pub client_id_process: isize,
    pub client_id_thread: isize,
    pub priority: i32,
    pub base_priority: i32,
    pub context_switches: u32,
    pub thread_state: u32,
    pub wait_reason: u32,
    _padding2: u32,
}

type NtQuerySystemInformationFn = unsafe extern "system" fn(
    system_information_class: i32,
    system_information: *mut c_void,
    system_information_length: u32,
    return_length: *mut u32,
) -> NTSTATUS;

type NtQuerySystemInformationExFn = unsafe extern "system" fn(
    system_information_class: i32,
    input_buffer: *const c_void,
    input_buffer_length: u32,
    system_information: *mut c_void,
    system_information_length: u32,
    return_length: *mut u32,
) -> NTSTATUS;

/// `NtQueryInformationProcess`, used for the two process facts with no Win32
/// equivalent that does not require reading the target address space:
/// `ProcessCommandLineInformation` and the extended basic information flags.
pub type NtQueryInformationProcessFn = unsafe extern "system" fn(
    process_handle: windows_sys::Win32::Foundation::HANDLE,
    process_information_class: u32,
    process_information: *mut c_void,
    process_information_length: u32,
    return_length: *mut u32,
) -> NTSTATUS;

struct NtDll {
    query: Option<NtQuerySystemInformationFn>,
    query_ex: Option<NtQuerySystemInformationExFn>,
    query_process: Option<NtQueryInformationProcessFn>,
}

// SAFETY: the resolved pointers point into ntdll.dll, which is mapped for the
// lifetime of the process and never unloaded, so sharing them across threads is
// sound.
// SAFETY: see the comment above - the pointers are into a permanently mapped
// module and are only ever read.
unsafe impl Send for NtDll {}
// SAFETY: as above. `NtDll` is immutable once initialised, so concurrent shared
// access cannot observe a torn or dangling pointer.
unsafe impl Sync for NtDll {}

static NTDLL: OnceLock<NtDll> = OnceLock::new();

fn ntdll() -> &'static NtDll {
    NTDLL.get_or_init(|| {
        // SAFETY: ntdll.dll is mapped into every Win32 process. GetModuleHandleA
        // does not take a reference, and we only read function pointers from it.
        unsafe {
            let module: HMODULE = GetModuleHandleA(c"ntdll.dll".as_ptr() as PCSTR);
            if module.is_null() {
                return NtDll {
                    query: None,
                    query_ex: None,
                    query_process: None,
                };
            }
            let query =
                GetProcAddress(module, c"NtQuerySystemInformation".as_ptr() as PCSTR).map(|f| {
                    std::mem::transmute::<
                        unsafe extern "system" fn() -> isize,
                        NtQuerySystemInformationFn,
                    >(f)
                });
            let query_ex = GetProcAddress(module, c"NtQuerySystemInformationEx".as_ptr() as PCSTR)
                .map(|f| {
                    std::mem::transmute::<
                        unsafe extern "system" fn() -> isize,
                        NtQuerySystemInformationExFn,
                    >(f)
                });
            let query_process =
                GetProcAddress(module, c"NtQueryInformationProcess".as_ptr() as PCSTR).map(|f| {
                    std::mem::transmute::<
                        unsafe extern "system" fn() -> isize,
                        NtQueryInformationProcessFn,
                    >(f)
                });
            NtDll {
                query,
                query_ex,
                query_process,
            }
        }
    })
}

/// True when the basic query entry point resolved.
pub fn is_available() -> bool {
    ntdll().query.is_some()
}

/// True when the group-aware query entry point resolved (Windows 7+).
pub fn is_ex_available() -> bool {
    ntdll().query_ex.is_some()
}

/// The resolved `NtQueryInformationProcess`, if ntdll exported it.
pub fn query_information_process() -> Option<NtQueryInformationProcessFn> {
    ntdll().query_process
}

/// Query a system information class, growing the buffer until the call succeeds.
///
/// `initial_capacity` should be a good guess; the buffer grows on
/// `STATUS_INFO_LENGTH_MISMATCH`, which happens routinely for the process list
/// because processes are created between the size probe and the read.
pub fn query(class: i32, initial_capacity: usize) -> Result<Vec<u8>, NTSTATUS> {
    let Some(func) = ntdll().query else {
        return Err(STATUS_NOT_IMPLEMENTED);
    };
    let mut capacity = initial_capacity.max(1024);
    // 16 growth rounds from any sane start reaches far beyond any real system.
    for _ in 0..16 {
        let mut buffer = vec![0u8; capacity];
        let mut return_length: u32 = 0;
        // SAFETY: buffer holds `capacity` bytes and we pass exactly that length,
        // so the kernel cannot write past the end.
        let status = unsafe {
            func(
                class,
                buffer.as_mut_ptr() as *mut c_void,
                capacity as u32,
                &mut return_length,
            )
        };
        if status == STATUS_SUCCESS {
            let used = (return_length as usize).min(capacity);
            buffer.truncate(if used == 0 { capacity } else { used });
            return Ok(buffer);
        }
        if status != STATUS_INFO_LENGTH_MISMATCH {
            return Err(status);
        }
        capacity = if return_length as usize > capacity {
            // Add headroom: the system keeps changing between calls.
            (return_length as usize) + (return_length as usize / 4) + 4096
        } else {
            capacity * 2
        };
    }
    Err(STATUS_INFO_LENGTH_MISMATCH)
}

fn parse_processor_performance(buffer: &[u8]) -> Vec<SystemProcessorPerformanceInformation> {
    let entry_size = std::mem::size_of::<SystemProcessorPerformanceInformation>();
    let count = buffer.len() / entry_size;
    let mut out = Vec::with_capacity(count);
    for i in 0..count {
        // SAFETY: `(i + 1) * entry_size <= buffer.len()` by construction of
        // `count`; `read_unaligned` tolerates any alignment of the source.
        let value = unsafe {
            std::ptr::read_unaligned(
                buffer.as_ptr().add(i * entry_size) as *const SystemProcessorPerformanceInformation
            )
        };
        out.push(value);
    }
    out
}

/// Query per-processor performance information for one processor group.
///
/// `NtQuerySystemInformation` alone only reports the processors in the calling
/// thread group, so machines with more than 64 logical processors need the `Ex`
/// form with the group number as input.
pub fn query_processor_performance_for_group(
    group: u16,
    processors_in_group: usize,
) -> Result<Vec<SystemProcessorPerformanceInformation>, NTSTATUS> {
    let Some(func) = ntdll().query_ex else {
        return Err(STATUS_NOT_IMPLEMENTED);
    };
    let entry_size = std::mem::size_of::<SystemProcessorPerformanceInformation>();
    let mut out = vec![SystemProcessorPerformanceInformation::default(); processors_in_group];
    let mut return_length: u32 = 0;
    // SAFETY: the input for this class is a single USHORT group number; the
    // output buffer holds exactly `processors_in_group` entries and we pass its
    // true byte length.
    let status = unsafe {
        func(
            SYSTEM_PROCESSOR_PERFORMANCE_INFORMATION_CLASS,
            &group as *const u16 as *const c_void,
            std::mem::size_of::<u16>() as u32,
            out.as_mut_ptr() as *mut c_void,
            (entry_size * processors_in_group) as u32,
            &mut return_length,
        )
    };
    if status != STATUS_SUCCESS {
        return Err(status);
    }
    let returned = (return_length as usize) / entry_size;
    out.truncate(returned.min(processors_in_group));
    Ok(out)
}

/// Query per-processor performance information for the calling thread group.
pub fn query_processor_performance(
    logical_processor_count: usize,
) -> Result<Vec<SystemProcessorPerformanceInformation>, NTSTATUS> {
    let entry_size = std::mem::size_of::<SystemProcessorPerformanceInformation>();
    let buffer = query(
        SYSTEM_PROCESSOR_PERFORMANCE_INFORMATION_CLASS,
        entry_size * logical_processor_count.max(1),
    )?;
    Ok(parse_processor_performance(&buffer))
}

/// Query the free / zero / modified / standby page breakdown.
pub fn query_memory_list() -> Result<SystemMemoryListInformation, NTSTATUS> {
    let size = std::mem::size_of::<SystemMemoryListInformation>();
    let buffer = query(SYSTEM_MEMORY_LIST_INFORMATION_CLASS, size)?;
    if buffer.len() < size {
        return Err(STATUS_INFO_LENGTH_MISMATCH);
    }
    // SAFETY: verified the buffer holds at least one whole structure.
    Ok(unsafe { std::ptr::read_unaligned(buffer.as_ptr() as *const SystemMemoryListInformation) })
}

/// Query a system information class into a caller-owned buffer that is reused
/// across calls.
///
/// This matters more than it looks for the process list. The kernel walks every
/// process *and every thread* to service the call, and it does that walk again
/// if the buffer was too small. On a machine with ~1000 processes the list is
/// around 2.5 MiB, and getting the size wrong costs roughly 15 ms per sample -
/// half the total cost of the call. Reusing the buffer keeps the capacity from
/// the previous sample, so the steady state is a single walk into an allocation
/// that is already the right size.
pub fn query_into(
    class: i32,
    buffer: &mut Vec<u8>,
    minimum_capacity: usize,
) -> Result<(), NTSTATUS> {
    let Some(func) = ntdll().query else {
        return Err(STATUS_NOT_IMPLEMENTED);
    };
    let mut capacity = buffer.capacity().max(minimum_capacity).max(1024);
    for _ in 0..16 {
        buffer.clear();
        buffer.resize(capacity, 0);
        let mut return_length: u32 = 0;
        // SAFETY: the buffer holds `capacity` bytes and we pass exactly that
        // length, so the kernel cannot write past the end.
        let status = unsafe {
            func(
                class,
                buffer.as_mut_ptr() as *mut c_void,
                capacity as u32,
                &mut return_length,
            )
        };
        if status == STATUS_SUCCESS {
            let used = (return_length as usize).min(capacity);
            buffer.truncate(if used == 0 { capacity } else { used });
            return Ok(());
        }
        if status != STATUS_INFO_LENGTH_MISMATCH {
            return Err(status);
        }
        capacity = if return_length as usize > capacity {
            (return_length as usize) + (return_length as usize / 4) + 4096
        } else {
            capacity * 2
        };
    }
    Err(STATUS_INFO_LENGTH_MISMATCH)
}

/// Query the whole process list into a reusable buffer.
///
/// Walk the result with [`ProcessListIter`].
pub fn query_process_list_into(buffer: &mut Vec<u8>) -> Result<(), NTSTATUS> {
    // Enough for a busy desktop on the very first call; afterwards the buffer's
    // own capacity takes over.
    query_into(SYSTEM_PROCESS_INFORMATION_CLASS, buffer, 4 * 1024 * 1024)
}

/// Bounds-checked walk over the `SYSTEM_PROCESS_INFORMATION` linked list.
pub struct ProcessListIter<'a> {
    buffer: &'a [u8],
    offset: usize,
    finished: bool,
}

impl<'a> ProcessListIter<'a> {
    pub fn new(buffer: &'a [u8]) -> Self {
        Self {
            buffer,
            offset: 0,
            finished: false,
        }
    }
}

/// One process entry plus a view of its inline thread array.
pub struct ProcessEntry<'a> {
    pub info: SystemProcessInformation,
    /// Raw bytes of the inline `SYSTEM_THREAD_INFORMATION` array.
    pub threads_bytes: &'a [u8],
}

impl<'a> ProcessEntry<'a> {
    /// Decode the inline thread array. Bounds-checked; a truncated tail is
    /// simply not returned.
    pub fn threads(&self) -> Vec<SystemThreadInformation> {
        let size = std::mem::size_of::<SystemThreadInformation>();
        let count = (self.threads_bytes.len() / size).min(self.info.number_of_threads as usize);
        let mut out = Vec::with_capacity(count);
        for i in 0..count {
            // SAFETY: `(i + 1) * size <= threads_bytes.len()` by construction.
            out.push(unsafe {
                std::ptr::read_unaligned(
                    self.threads_bytes.as_ptr().add(i * size) as *const SystemThreadInformation
                )
            });
        }
        out
    }
}

impl<'a> Iterator for ProcessListIter<'a> {
    type Item = ProcessEntry<'a>;

    fn next(&mut self) -> Option<Self::Item> {
        if self.finished {
            return None;
        }
        let header_size = std::mem::size_of::<SystemProcessInformation>();
        if self.offset.checked_add(header_size)? > self.buffer.len() {
            self.finished = true;
            return None;
        }
        // SAFETY: bounds checked immediately above.
        let info = unsafe {
            std::ptr::read_unaligned(
                self.buffer.as_ptr().add(self.offset) as *const SystemProcessInformation
            )
        };

        let entry_end = if info.next_entry_offset == 0 {
            self.buffer.len()
        } else {
            match self.offset.checked_add(info.next_entry_offset as usize) {
                Some(end) if end <= self.buffer.len() && end > self.offset => end,
                // A malformed or truncated link ends the walk rather than
                // wrapping around or reading out of bounds.
                _ => {
                    self.finished = true;
                    self.buffer.len()
                }
            }
        };
        let threads_start = self.offset + header_size;
        let threads_bytes = if threads_start <= entry_end {
            &self.buffer[threads_start..entry_end]
        } else {
            &[]
        };

        if info.next_entry_offset == 0 {
            self.finished = true;
        } else {
            self.offset = entry_end;
        }

        Some(ProcessEntry {
            info,
            threads_bytes,
        })
    }
}

/// Copy a `UNICODE_STRING` out of a buffer we own, defensively.
///
/// # Safety
/// `s.Buffer` must either be null or point to `s.Length` readable bytes. The
/// kernel guarantees this for strings inside a `SYSTEM_PROCESS_INFORMATION`
/// buffer, where `Buffer` points back into the same allocation.
pub unsafe fn unicode_string_to_string(s: &UNICODE_STRING) -> Option<String> {
    if s.Buffer.is_null() || s.Length == 0 {
        return None;
    }
    let len_u16 = (s.Length / 2) as usize;
    // Guard against an implausible length rather than trusting it blindly.
    if len_u16 > 32 * 1024 {
        return None;
    }
    let slice = std::slice::from_raw_parts(s.Buffer, len_u16);
    Some(String::from_utf16_lossy(slice))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn processor_performance_struct_has_expected_size() {
        // 5 x LARGE_INTEGER + ULONG + padding to 8-byte alignment.
        assert_eq!(
            std::mem::size_of::<SystemProcessorPerformanceInformation>(),
            48
        );
    }

    #[test]
    fn parsing_a_truncated_processor_buffer_yields_whole_entries_only() {
        let entry_size = std::mem::size_of::<SystemProcessorPerformanceInformation>();
        let buffer = vec![0u8; entry_size * 2 + 7];
        assert_eq!(parse_processor_performance(&buffer).len(), 2);
    }

    #[test]
    fn process_list_iter_stops_on_a_self_referential_link() {
        // next_entry_offset == 0 terminates; a zeroed buffer must not loop.
        let buffer = vec![0u8; std::mem::size_of::<SystemProcessInformation>() * 2];
        let count = ProcessListIter::new(&buffer).count();
        assert_eq!(count, 1);
    }

    #[test]
    fn process_list_iter_stops_on_an_out_of_range_link() {
        let header = std::mem::size_of::<SystemProcessInformation>();
        let mut buffer = vec![0u8; header * 2];
        // Point the first entry far past the end of the buffer.
        buffer[0..4].copy_from_slice(&u32::MAX.to_le_bytes());
        let count = ProcessListIter::new(&buffer).count();
        assert_eq!(count, 1);
    }
}
