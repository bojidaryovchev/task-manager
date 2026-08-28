//! Process collection.
//!
//! # Why one syscall instead of a thousand handles
//!
//! The obvious implementation - enumerate PIDs, `OpenProcess` each one, then
//! call `GetProcessTimes` / `GetProcessMemoryInfo` - costs several thousand
//! syscalls every 500 ms and still fails with `ERROR_ACCESS_DENIED` on system
//! and protected processes. `NtQuerySystemInformation(SystemProcessInformation)`
//! returns CPU times, memory (including *private working set*, which no Win32
//! API exposes), handle counts, thread counts and I/O counters for every process
//! on the machine in a single call, with no handle required.
//!
//! Fields that genuinely need a handle - image path, command line,
//! architecture, owning user, protection status - are static for the lifetime of
//! a process, so they are resolved once and cached against the process identity.
//!
//! # Identity
//!
//! A PID is reused. Everything that must survive across samples is keyed on
//! `(pid, create_time)`. Without that, a CPU delta could be computed between two
//! completely different programs that happened to share a PID, which would show
//! up as an enormous spike.

mod details;
mod metadata;

use std::collections::HashMap;

use crate::clock::filetime_100ns_to_unix_ms;
use crate::cpu::calc;
use crate::win::ntdll::{self, ProcessListIter};

pub use details::ProcessDetails;
pub use metadata::{ImageMetadata, PackageIdentity};

/// Stable identity for a process across samples.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct ProcessKey {
    pub pid: u32,
    pub create_time_100ns: i64,
}

impl ProcessKey {
    pub fn to_string_key(self) -> String {
        format!("{}:{}", self.pid, self.create_time_100ns)
    }
}

/// One process as observed in a single sample.
#[derive(Debug, Clone)]
pub struct ProcessSample {
    pub key: ProcessKey,
    pub pid: u32,
    pub parent_pid: u32,
    pub parent_key: Option<ProcessKey>,
    pub name: String,
    pub create_time_100ns: i64,
    pub create_time_unix_ms: f64,
    pub session_id: u32,
    pub base_priority: i32,
    pub thread_count: u32,
    pub handle_count: u32,

    pub kernel_time_100ns: i64,
    pub user_time_100ns: i64,
    pub cpu_machine_percent: Option<f64>,
    pub cpu_core_equivalent_percent: Option<f64>,

    pub working_set_bytes: u64,
    pub private_working_set_bytes: u64,
    pub private_commit_bytes: u64,
    pub peak_working_set_bytes: u64,
    pub paged_pool_bytes: u64,
    pub non_paged_pool_bytes: u64,
    pub virtual_size_bytes: u64,
    pub page_fault_count: u32,
    pub hard_fault_count: u32,

    pub io_read_bytes: u64,
    pub io_write_bytes: u64,
    pub io_other_bytes: u64,
    pub io_read_operations: u64,
    pub io_write_operations: u64,
    pub io_other_operations: u64,
    pub io_read_bytes_per_second: Option<f64>,
    pub io_write_bytes_per_second: Option<f64>,

    // Static per-process facts, resolved lazily and cached.
    pub image_path: Option<String>,
    pub command_line: Option<String>,
    pub user_name: Option<String>,
    pub architecture: Option<&'static str>,
    pub is_wow64: Option<bool>,
    pub is_protected: Option<bool>,
    /// Version-resource metadata, used for application grouping.
    pub product_name: Option<String>,
    pub company_name: Option<String>,
    pub file_description: Option<String>,
    /// Windows package identity, for packaged applications.
    pub package_full_name: Option<String>,
    pub application_user_model_id: Option<String>,
    /// Why a handle-derived field is missing, when it is.
    pub detail_failure: Option<&'static str>,
}

/// Result of one process collection pass.
#[derive(Debug, Clone, Default)]
pub struct ProcessesSample {
    pub processes: Vec<ProcessSample>,
    pub total_count: usize,
    /// Processes whose handle-derived details could not be read.
    pub access_denied_count: usize,
    /// Entries that disappeared between enumeration and detail resolution.
    pub vanished_count: usize,
    pub collection_duration_ms: f64,
}

/// Cumulative counters carried between samples, per process identity.
#[derive(Debug, Clone, Copy)]
struct PreviousCounters {
    cpu_time_100ns: i64,
    io_read_bytes: u64,
    io_write_bytes: u64,
    /// Sequence number of the sample that last saw this process, used to evict
    /// entries for processes that have exited.
    last_seen: u64,
}

pub struct ProcessCollector {
    previous: HashMap<ProcessKey, PreviousCounters>,
    details: details::DetailCache,
    sequence: u64,
    logical_processor_count: usize,
    /// Reused across samples so the kernel does not have to walk the process
    /// list twice because the buffer was too small.
    buffer: Vec<u8>,
    /// Reused set of live identities, to avoid allocating one per sample.
    live_keys: std::collections::HashSet<ProcessKey>,
}

impl ProcessCollector {
    pub fn new(logical_processor_count: usize) -> Self {
        Self {
            previous: HashMap::with_capacity(512),
            details: details::DetailCache::new(),
            sequence: 0,
            logical_processor_count: logical_processor_count.max(1),
            buffer: Vec::new(),
            live_keys: std::collections::HashSet::with_capacity(512),
        }
    }

    pub fn set_logical_processor_count(&mut self, count: usize) {
        self.logical_processor_count = count.max(1);
    }

    /// Collect every process. `interval_ms` is the measured monotonic interval
    /// since the previous collection; pass `None` on the first sample.
    pub fn sample(
        &mut self,
        interval_ms: Option<f64>,
        collect_command_lines: bool,
    ) -> ProcessesSample {
        let started = std::time::Instant::now();
        self.sequence += 1;

        self.details.begin_tick();

        let mut buffer = std::mem::take(&mut self.buffer);
        let query_result = ntdll::query_process_list_into(&mut buffer);
        if query_result.is_err() {
            self.buffer = buffer;
            return ProcessesSample {
                collection_duration_ms: started.elapsed().as_secs_f64() * 1000.0,
                ..Default::default()
            };
        }

        // First pass: decode every entry and record identities, so parents can
        // be resolved against creation times in the second pass.
        let mut raw: Vec<ProcessSample> = Vec::with_capacity(512);
        let mut identity_by_pid: HashMap<u32, (i64, ProcessKey)> = HashMap::with_capacity(512);

        for entry in ProcessListIter::new(&buffer) {
            let info = &entry.info;
            let pid = info.unique_process_id as u32;
            let key = ProcessKey {
                pid,
                create_time_100ns: info.create_time,
            };
            // SAFETY: the UNICODE_STRING buffer points inside `buffer`, which is
            // alive for this whole loop.
            let name =
                unsafe { ntdll::unicode_string_to_string(&info.image_name) }.unwrap_or_else(|| {
                    if pid == 0 {
                        "System Idle Process".to_string()
                    } else {
                        format!("PID {pid}")
                    }
                });

            identity_by_pid.insert(pid, (info.create_time, key));

            raw.push(ProcessSample {
                key,
                pid,
                parent_pid: info.inherited_from_unique_process_id as u32,
                parent_key: None,
                name,
                create_time_100ns: info.create_time,
                create_time_unix_ms: filetime_100ns_to_unix_ms(info.create_time),
                session_id: info.session_id,
                base_priority: info.base_priority,
                thread_count: info.number_of_threads,
                handle_count: info.handle_count,
                kernel_time_100ns: info.kernel_time,
                user_time_100ns: info.user_time,
                cpu_machine_percent: None,
                cpu_core_equivalent_percent: None,
                working_set_bytes: info.working_set_size as u64,
                private_working_set_bytes: info.working_set_private_size.max(0) as u64,
                private_commit_bytes: info.pagefile_usage as u64,
                peak_working_set_bytes: info.peak_working_set_size as u64,
                paged_pool_bytes: info.quota_paged_pool_usage as u64,
                non_paged_pool_bytes: info.quota_non_paged_pool_usage as u64,
                virtual_size_bytes: info.virtual_size as u64,
                page_fault_count: info.page_fault_count,
                hard_fault_count: info.hard_fault_count,
                io_read_bytes: info.read_transfer_count.max(0) as u64,
                io_write_bytes: info.write_transfer_count.max(0) as u64,
                io_other_bytes: info.other_transfer_count.max(0) as u64,
                io_read_operations: info.read_operation_count.max(0) as u64,
                io_write_operations: info.write_operation_count.max(0) as u64,
                io_other_operations: info.other_operation_count.max(0) as u64,
                io_read_bytes_per_second: None,
                io_write_bytes_per_second: None,
                image_path: None,
                command_line: None,
                user_name: None,
                architecture: None,
                is_wow64: None,
                is_protected: None,
                product_name: None,
                company_name: None,
                file_description: None,
                package_full_name: None,
                application_user_model_id: None,
                detail_failure: None,
            });
        }

        let total_count = raw.len();
        let mut access_denied_count = 0usize;

        for sample in raw.iter_mut() {
            // Parent resolution: only accept a parent that already existed when
            // this process was created. A PID that was recycled after our child
            // started is a different process and must not be linked.
            // PID 0 is the System Idle Process, which is not anyone's parent
            // even though Windows reports it as the parent of System.
            if sample.parent_pid != 0 {
                if let Some((parent_create_time, parent_key)) =
                    identity_by_pid.get(&sample.parent_pid)
                {
                    if *parent_create_time <= sample.create_time_100ns
                        && sample.parent_pid != sample.pid
                    {
                        sample.parent_key = Some(*parent_key);
                    }
                }
            }

            // Rates, only when we have a predecessor for this exact identity.
            let cpu_time = sample
                .kernel_time_100ns
                .saturating_add(sample.user_time_100ns);
            if let (Some(previous), Some(interval_ms)) =
                (self.previous.get(&sample.key), interval_ms)
            {
                let cpu_delta = cpu_time - previous.cpu_time_100ns;
                if cpu_delta >= 0 {
                    if let Some(machine) = calc::process_machine_percent(
                        cpu_delta as f64,
                        interval_ms,
                        self.logical_processor_count,
                    ) {
                        sample.cpu_machine_percent = Some(machine);
                        sample.cpu_core_equivalent_percent =
                            Some(calc::process_core_equivalent_percent(
                                machine,
                                self.logical_processor_count,
                            ));
                    }
                }
                if interval_ms > 0.0 {
                    let seconds = interval_ms / 1000.0;
                    sample.io_read_bytes_per_second = Some(
                        sample.io_read_bytes.saturating_sub(previous.io_read_bytes) as f64
                            / seconds,
                    );
                    sample.io_write_bytes_per_second = Some(
                        sample
                            .io_write_bytes
                            .saturating_sub(previous.io_write_bytes) as f64
                            / seconds,
                    );
                }
            }

            self.previous.insert(
                sample.key,
                PreviousCounters {
                    cpu_time_100ns: cpu_time,
                    io_read_bytes: sample.io_read_bytes,
                    io_write_bytes: sample.io_write_bytes,
                    last_seen: self.sequence,
                },
            );

            // Static details, resolved once per identity and subject to a
            // per-tick budget. A process still awaiting resolution simply has
            // empty detail fields for a tick or two.
            if let Some(detail) = self.details.get(sample.key, collect_command_lines) {
                sample.image_path = detail.image_path.clone();
                sample.command_line = detail.command_line.clone();
                sample.user_name = detail.user_name.clone();
                sample.architecture = detail.architecture;
                sample.is_wow64 = detail.is_wow64;
                sample.is_protected = detail.is_protected;
                sample.product_name = detail.image_metadata.product_name.clone();
                sample.company_name = detail.image_metadata.company_name.clone();
                sample.file_description = detail.image_metadata.file_description.clone();
                sample.package_full_name = detail.package.package_full_name.clone();
                sample.application_user_model_id = detail.package.application_user_model_id.clone();
                sample.detail_failure = detail.failure;
                if detail.failure == Some("accessDenied") {
                    access_denied_count += 1;
                }
            } else {
                sample.detail_failure = Some("pending");
            }
        }

        // Evict identities we no longer see, so the maps track live processes
        // rather than growing for the lifetime of the application.
        let sequence = self.sequence;
        self.previous.retain(|_, v| v.last_seen == sequence);
        self.live_keys.clear();
        self.live_keys.extend(self.previous.keys().copied());
        self.details.retain_seen(&self.live_keys);

        // Hand the buffer back for the next sample to reuse.
        self.buffer = buffer;

        ProcessesSample {
            total_count,
            processes: raw,
            access_denied_count,
            vanished_count: 0,
            collection_duration_ms: started.elapsed().as_secs_f64() * 1000.0,
        }
    }

    /// Number of identities currently cached, exposed so the application can
    /// watch its own memory behaviour.
    pub fn tracked_process_count(&self) -> usize {
        self.previous.len()
    }

    pub fn cached_detail_count(&self) -> usize {
        self.details.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn process_keys_distinguish_reused_pids() {
        let first = ProcessKey {
            pid: 4242,
            create_time_100ns: 100,
        };
        let second = ProcessKey {
            pid: 4242,
            create_time_100ns: 200,
        };
        assert_ne!(first, second);
        assert_ne!(first.to_string_key(), second.to_string_key());
        let mut map = HashMap::new();
        map.insert(first, 1);
        map.insert(second, 2);
        assert_eq!(map.len(), 2);
    }

    #[test]
    fn key_string_is_stable_and_parseable() {
        let key = ProcessKey {
            pid: 1234,
            create_time_100ns: 133_000_000_000_000_000,
        };
        assert_eq!(key.to_string_key(), "1234:133000000000000000");
    }
}
