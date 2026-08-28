//! The N-API surface: transport structures and the conversion from the
//! collectors' domain types.
//!
//! These structures mirror `packages/telemetry-types` exactly. They are plain
//! data with no behaviour: every calculation has already happened in the
//! collectors, so the TypeScript side never recomputes a metric.
//!
//! Note on numeric precision: JavaScript numbers are IEEE-754 doubles, exact
//! only to 2^53. A FILETIME creation timestamp is around 1.3e17 and therefore
//! *cannot* round-trip exactly. That is why process identity travels as the
//! pre-formatted `key` string, computed in Rust from the full-precision value,
//! and `createTime100ns` is documented as display-only.

use napi_derive::napi;

use crate::cpu::{CpuSample, LogicalProcessorSample};
use crate::memory::MemorySample;
use crate::process::{ProcessSample, ProcessesSample};
use crate::win::topology::Topology;

#[napi(object)]
#[derive(Debug, Clone)]
pub struct JsCpuTopology {
    pub package_count: u32,
    pub physical_core_count: u32,
    pub logical_processor_count: u32,
    pub processor_group_count: u32,
    pub logical_processors_per_group: Vec<u32>,
    pub is_hybrid: bool,
    pub efficiency_classes: Vec<u32>,
    pub brand_string: Option<String>,
    pub base_frequency_mhz: Option<f64>,
}

#[napi(object)]
#[derive(Debug, Clone)]
pub struct JsLogicalProcessorSample {
    pub index: u32,
    pub group: u32,
    pub number_in_group: u32,
    pub core_id: Option<u32>,
    pub efficiency_class: Option<u32>,
    pub time_utilization_percent: f64,
    pub dpc_percent: f64,
    pub interrupt_percent: f64,
    pub kernel_percent: f64,
    pub user_percent: f64,
    pub current_frequency_mhz: Option<f64>,
    pub max_frequency_mhz: Option<f64>,
}

#[napi(object)]
#[derive(Debug, Clone)]
pub struct JsGetSystemTimesDelta {
    #[napi(js_name = "idleDelta100ns")]
    pub idle_delta100ns: f64,
    #[napi(js_name = "kernelDelta100ns")]
    pub kernel_delta100ns: f64,
    #[napi(js_name = "userDelta100ns")]
    pub user_delta100ns: f64,
    pub utilization_percent: f64,
}

#[napi(object)]
#[derive(Debug, Clone)]
pub struct JsCpuDebugSample {
    pub interval_ms: f64,
    #[napi(js_name = "idleDelta100ns")]
    pub idle_delta100ns: f64,
    #[napi(js_name = "kernelDelta100ns")]
    pub kernel_delta100ns: f64,
    #[napi(js_name = "userDelta100ns")]
    pub user_delta100ns: f64,
    #[napi(js_name = "totalDelta100ns")]
    pub total_delta100ns: f64,
    #[napi(js_name = "busyDelta100ns")]
    pub busy_delta100ns: f64,
    pub get_system_times: Option<JsGetSystemTimesDelta>,
    pub counter_coverage_ratio: f64,
    pub discarded: bool,
    pub discard_reason: Option<String>,
    /// PDH counter paths that are actually registered on this machine.
    pub pdh_counter_paths: Vec<String>,
}

#[napi(object)]
#[derive(Debug, Clone)]
pub struct JsCpuSnapshot {
    pub aggregate_time_utilization_percent: Option<f64>,
    pub processor_utility_percent: Option<f64>,
    pub processor_performance_percent: Option<f64>,
    pub pdh_processor_time_percent: Option<f64>,
    pub busiest_logical_processor_percent: Option<f64>,
    pub busiest_logical_processor_index: Option<u32>,
    pub average_logical_processor_percent: Option<f64>,
    pub aggregate_dpc_percent: Option<f64>,
    pub aggregate_interrupt_percent: Option<f64>,
    pub current_frequency_mhz: Option<f64>,
    pub per_logical_processor: Vec<JsLogicalProcessorSample>,
    pub topology: JsCpuTopology,
    pub process_count: Option<u32>,
    pub thread_count: Option<u32>,
    pub handle_count: Option<u32>,
    pub uptime_ms: Option<f64>,
    pub debug: Option<JsCpuDebugSample>,
}

#[napi(object)]
#[derive(Debug, Clone)]
pub struct JsMemoryDebugGlobal {
    pub memory_load_percent: f64,
    pub total_phys_bytes: f64,
    pub avail_phys_bytes: f64,
    pub total_page_file_bytes: f64,
    pub avail_page_file_bytes: f64,
    pub total_virtual_bytes: f64,
    pub avail_virtual_bytes: f64,
}

#[napi(object)]
#[derive(Debug, Clone)]
pub struct JsMemoryDebugPerformance {
    pub page_size_bytes: f64,
    pub commit_total_pages: f64,
    pub commit_limit_pages: f64,
    pub commit_peak_pages: f64,
    pub physical_total_pages: f64,
    pub physical_available_pages: f64,
    pub system_cache_pages: f64,
    pub kernel_total_pages: f64,
    pub kernel_paged_pages: f64,
    pub kernel_nonpaged_pages: f64,
    pub handle_count: f64,
    pub process_count: f64,
    pub thread_count: f64,
}

#[napi(object)]
#[derive(Debug, Clone)]
pub struct JsMemoryDebugList {
    pub free_and_zero_bytes: f64,
    pub modified_bytes: f64,
    pub modified_no_write_bytes: f64,
    pub standby_bytes: f64,
    pub standby_by_priority_bytes: Vec<f64>,
}

#[napi(object)]
#[derive(Debug, Clone)]
pub struct JsMemoryDebugSample {
    pub global_memory_status_ex: JsMemoryDebugGlobal,
    pub performance_information: Option<JsMemoryDebugPerformance>,
    pub memory_list: Option<JsMemoryDebugList>,
    pub installed_physical_bytes: Option<f64>,
}

#[napi(object)]
#[derive(Debug, Clone)]
pub struct JsMemorySnapshot {
    pub installed_physical_bytes: Option<f64>,
    pub total_physical_bytes: f64,
    pub available_physical_bytes: f64,
    pub used_physical_bytes: f64,
    pub physical_utilization_percent: f64,
    pub memory_load_percent: f64,
    pub committed_bytes: Option<f64>,
    pub commit_limit_bytes: Option<f64>,
    pub commit_peak_bytes: Option<f64>,
    pub cached_bytes: Option<f64>,
    pub standby_bytes: Option<f64>,
    pub modified_bytes: Option<f64>,
    pub free_bytes: Option<f64>,
    pub paged_pool_bytes: Option<f64>,
    pub non_paged_pool_bytes: Option<f64>,
    pub page_file_total_bytes: Option<f64>,
    pub page_file_used_bytes: Option<f64>,
    pub page_size_bytes: f64,
    pub debug: Option<JsMemoryDebugSample>,
}

#[napi(object)]
#[derive(Debug, Clone)]
pub struct JsProcessSnapshot {
    /// `pid:createTime100ns`. The only safe identity across samples.
    pub key: String,
    pub pid: u32,
    pub parent_pid: u32,
    pub parent_key: Option<String>,
    pub name: String,
    pub image_path: Option<String>,
    pub command_line: Option<String>,
    /// Display only - exceeds the exact integer range of a JS number.
    #[napi(js_name = "createTime100ns")]
    pub create_time100ns: f64,
    pub create_time_unix_ms: f64,
    pub session_id: u32,
    pub is_wow64: Option<bool>,
    pub architecture: Option<String>,
    pub user_name: Option<String>,
    pub is_protected: Option<bool>,
    /// `ProductName` from the image version resource, e.g. "Google Chrome".
    pub product_name: Option<String>,
    /// `CompanyName` from the image version resource.
    pub company_name: Option<String>,
    /// `FileDescription` from the image version resource.
    pub file_description: Option<String>,
    /// Windows package full name, present only for packaged applications.
    pub package_full_name: Option<String>,
    /// Application User Model ID, present only for packaged applications.
    pub application_user_model_id: Option<String>,
    pub base_priority: i32,

    #[napi(js_name = "kernelTime100ns")]
    pub kernel_time100ns: f64,
    #[napi(js_name = "userTime100ns")]
    pub user_time100ns: f64,
    pub cpu_machine_percent: Option<f64>,
    pub cpu_core_equivalent_percent: Option<f64>,

    pub working_set_bytes: f64,
    pub private_working_set_bytes: f64,
    pub private_commit_bytes: f64,
    pub peak_working_set_bytes: f64,
    pub paged_pool_bytes: f64,
    pub non_paged_pool_bytes: f64,
    pub virtual_size_bytes: f64,
    pub page_fault_count: f64,
    pub hard_fault_count: f64,

    pub thread_count: u32,
    pub handle_count: u32,

    pub io_read_bytes: f64,
    pub io_write_bytes: f64,
    pub io_other_bytes: f64,
    pub io_read_operations: f64,
    pub io_write_operations: f64,
    pub io_other_operations: f64,
    pub io_read_bytes_per_second: Option<f64>,
    pub io_write_bytes_per_second: Option<f64>,

    /// Maximum GPU engine utilisation for this process, 0..100. Absent when the
    /// GPU counter set is unavailable or the process used no GPU.
    pub gpu_percent: Option<f64>,
    /// Dedicated (on-board) GPU memory attributed to this process.
    pub gpu_dedicated_memory_bytes: Option<f64>,
    /// Shared (system) GPU memory attributed to this process.
    pub gpu_shared_memory_bytes: Option<f64>,

    /// Reason the handle-derived fields are missing, when they are.
    ///
    /// Declared with an explicit TypeScript union so the generated declaration
    /// is as precise as the values we actually emit, and the published types can
    /// be checked against it exactly.
    #[napi(ts_type = "'accessDenied' | 'processExited' | 'notSupported' | 'pending'")]
    pub detail_failure: Option<String>,
}

#[napi(object)]
#[derive(Debug, Clone)]
pub struct JsProcessesSnapshot {
    pub processes: Vec<JsProcessSnapshot>,
    pub total_count: u32,
    pub access_denied_count: u32,
    pub vanished_count: u32,
    pub collection_duration_ms: f64,
}

#[napi(object)]
#[derive(Debug, Clone)]
pub struct JsCollectorIssue {
    pub subsystem: String,
    pub code: String,
    pub message: String,
}

#[napi(object)]
#[derive(Debug, Clone)]
pub struct JsCollectionDiagnostics {
    pub total_duration_ms: f64,
    pub cpu_duration_ms: f64,
    pub memory_duration_ms: f64,
    pub process_duration_ms: f64,
    /// Disk, network and GPU together: they all read from one PDH query.
    pub device_duration_ms: f64,
    pub issues: Vec<JsCollectorIssue>,
    pub dropped_snapshots: u32,
    /// Number of process identities the collector is tracking, so the
    /// application can watch its own memory behaviour.
    pub tracked_process_count: u32,
}

#[napi(object)]
#[derive(Debug, Clone)]
pub struct JsSystemSnapshot {
    pub sequence: f64,
    pub wall_clock_unix_ms: f64,
    pub monotonic_ms: f64,
    pub interval_ms: Option<f64>,
    pub cpu: JsCpuSnapshot,
    pub memory: JsMemorySnapshot,
    pub processes: Option<JsProcessesSnapshot>,
    pub disks: JsDisksSnapshot,
    pub network: JsNetworkSnapshot,
    pub gpu: JsGpuSnapshot,
    pub diagnostics: JsCollectionDiagnostics,
}

#[napi(object)]
#[derive(Debug, Clone)]
pub struct JsCollectorConfig {
    pub interval_ms: f64,
    pub collect_processes: bool,
    pub collect_debug: bool,
    pub collect_command_lines: bool,
}

#[napi(object)]
#[derive(Debug, Clone)]
pub struct JsHostInfo {
    pub computer_name: String,
    pub os_name: Option<String>,
    pub os_version: String,
    pub os_build: Option<String>,
    pub architecture: String,
    pub is_elevated: bool,
    pub has_debug_privilege: bool,
    pub boot_time_unix_ms: Option<f64>,
    pub native_module_version: String,
}

// --- conversions -----------------------------------------------------------

pub fn topology_to_js(
    topology: &Topology,
    brand_string: Option<&str>,
    base_frequency_mhz: Option<u32>,
) -> JsCpuTopology {
    JsCpuTopology {
        package_count: topology.package_count as u32,
        physical_core_count: topology.cores.len() as u32,
        logical_processor_count: topology.logical_processor_count() as u32,
        processor_group_count: topology.group_count() as u32,
        logical_processors_per_group: topology
            .processors_per_group
            .iter()
            .map(|c| *c as u32)
            .collect(),
        is_hybrid: topology.is_hybrid(),
        efficiency_classes: topology
            .efficiency_classes()
            .into_iter()
            .map(u32::from)
            .collect(),
        brand_string: brand_string.map(str::to_owned),
        base_frequency_mhz: base_frequency_mhz.map(f64::from),
    }
}

fn logical_processor_to_js(sample: &LogicalProcessorSample) -> JsLogicalProcessorSample {
    JsLogicalProcessorSample {
        index: sample.index as u32,
        group: u32::from(sample.group),
        number_in_group: u32::from(sample.number_in_group),
        core_id: sample.core_id.map(|id| id as u32),
        efficiency_class: sample.efficiency_class.map(u32::from),
        time_utilization_percent: sample.time_utilization_percent,
        dpc_percent: sample.dpc_percent,
        interrupt_percent: sample.interrupt_percent,
        kernel_percent: sample.kernel_percent,
        user_percent: sample.user_percent,
        current_frequency_mhz: sample.current_frequency_mhz,
        max_frequency_mhz: sample.max_frequency_mhz,
    }
}

pub struct CpuConversionContext<'a> {
    pub topology: JsCpuTopology,
    pub pdh_counter_paths: &'a [String],
    pub include_debug: bool,
    pub process_count: Option<u32>,
    pub thread_count: Option<u32>,
    pub handle_count: Option<u32>,
    pub uptime_ms: Option<f64>,
}

pub fn cpu_to_js(sample: &CpuSample, context: CpuConversionContext<'_>) -> JsCpuSnapshot {
    JsCpuSnapshot {
        aggregate_time_utilization_percent: sample.aggregate_time_utilization_percent,
        processor_utility_percent: sample.processor_utility_percent,
        processor_performance_percent: sample.processor_performance_percent,
        pdh_processor_time_percent: sample.pdh_processor_time_percent,
        busiest_logical_processor_percent: sample.busiest_logical_processor_percent,
        busiest_logical_processor_index: sample.busiest_logical_processor_index.map(|i| i as u32),
        average_logical_processor_percent: sample.average_logical_processor_percent,
        aggregate_dpc_percent: sample.aggregate_dpc_percent,
        aggregate_interrupt_percent: sample.aggregate_interrupt_percent,
        current_frequency_mhz: sample.derived_current_frequency_mhz,
        per_logical_processor: sample
            .per_logical_processor
            .iter()
            .map(logical_processor_to_js)
            .collect(),
        topology: context.topology,
        process_count: context.process_count,
        thread_count: context.thread_count,
        handle_count: context.handle_count,
        uptime_ms: context.uptime_ms,
        debug: context.include_debug.then(|| JsCpuDebugSample {
            interval_ms: sample.debug.interval_ms,
            idle_delta100ns: sample.debug.idle_delta_100ns,
            kernel_delta100ns: sample.debug.kernel_delta_100ns,
            user_delta100ns: sample.debug.user_delta_100ns,
            total_delta100ns: sample.debug.total_delta_100ns,
            busy_delta100ns: sample.debug.busy_delta_100ns,
            get_system_times: sample
                .debug
                .get_system_times
                .map(|d| JsGetSystemTimesDelta {
                    idle_delta100ns: d.idle_delta_100ns,
                    kernel_delta100ns: d.kernel_delta_100ns,
                    user_delta100ns: d.user_delta_100ns,
                    utilization_percent: d.utilization_percent,
                }),
            counter_coverage_ratio: sample.debug.counter_coverage_ratio,
            discarded: sample.debug.discarded,
            discard_reason: sample.debug.discard_reason.map(str::to_owned),
            pdh_counter_paths: context.pdh_counter_paths.to_vec(),
        }),
    }
}

pub fn memory_to_js(sample: &MemorySample, include_debug: bool) -> JsMemorySnapshot {
    JsMemorySnapshot {
        installed_physical_bytes: sample.installed_physical_bytes.map(|v| v as f64),
        total_physical_bytes: sample.global.total_physical_bytes as f64,
        available_physical_bytes: sample.global.available_physical_bytes as f64,
        used_physical_bytes: sample.used_physical_bytes() as f64,
        physical_utilization_percent: sample.physical_utilization_percent(),
        memory_load_percent: f64::from(sample.global.memory_load_percent),
        committed_bytes: sample.committed_bytes().map(|v| v as f64),
        commit_limit_bytes: sample.commit_limit_bytes().map(|v| v as f64),
        commit_peak_bytes: sample.commit_peak_bytes().map(|v| v as f64),
        cached_bytes: sample.cached_bytes().map(|v| v as f64),
        standby_bytes: sample.memory_list.map(|m| m.standby_bytes as f64),
        modified_bytes: sample
            .memory_list
            .map(|m| (m.modified_bytes + m.modified_no_write_bytes) as f64),
        free_bytes: sample.memory_list.map(|m| m.free_and_zero_bytes as f64),
        paged_pool_bytes: sample.paged_pool_bytes().map(|v| v as f64),
        non_paged_pool_bytes: sample.non_paged_pool_bytes().map(|v| v as f64),
        page_file_total_bytes: sample.page_file_total_bytes().map(|v| v as f64),
        page_file_used_bytes: sample.page_file_used_bytes().map(|v| v as f64),
        page_size_bytes: sample.page_size_bytes as f64,
        debug: include_debug.then(|| JsMemoryDebugSample {
            global_memory_status_ex: JsMemoryDebugGlobal {
                memory_load_percent: f64::from(sample.global.memory_load_percent),
                total_phys_bytes: sample.global.total_physical_bytes as f64,
                avail_phys_bytes: sample.global.available_physical_bytes as f64,
                total_page_file_bytes: sample.global.total_page_file_bytes as f64,
                avail_page_file_bytes: sample.global.available_page_file_bytes as f64,
                total_virtual_bytes: sample.global.total_virtual_bytes as f64,
                avail_virtual_bytes: sample.global.available_virtual_bytes as f64,
            },
            performance_information: sample.performance.map(|p| JsMemoryDebugPerformance {
                page_size_bytes: p.page_size_bytes as f64,
                commit_total_pages: p.commit_total_pages as f64,
                commit_limit_pages: p.commit_limit_pages as f64,
                commit_peak_pages: p.commit_peak_pages as f64,
                physical_total_pages: p.physical_total_pages as f64,
                physical_available_pages: p.physical_available_pages as f64,
                system_cache_pages: p.system_cache_pages as f64,
                kernel_total_pages: p.kernel_total_pages as f64,
                kernel_paged_pages: p.kernel_paged_pages as f64,
                kernel_nonpaged_pages: p.kernel_non_paged_pages as f64,
                handle_count: f64::from(p.handle_count),
                process_count: f64::from(p.process_count),
                thread_count: f64::from(p.thread_count),
            }),
            memory_list: sample.memory_list.map(|m| JsMemoryDebugList {
                free_and_zero_bytes: m.free_and_zero_bytes as f64,
                modified_bytes: m.modified_bytes as f64,
                modified_no_write_bytes: m.modified_no_write_bytes as f64,
                standby_bytes: m.standby_bytes as f64,
                standby_by_priority_bytes: m
                    .standby_by_priority_bytes
                    .iter()
                    .map(|v| *v as f64)
                    .collect(),
            }),
            installed_physical_bytes: sample.installed_physical_bytes.map(|v| v as f64),
        }),
    }
}

fn process_to_js(sample: &ProcessSample) -> JsProcessSnapshot {
    JsProcessSnapshot {
        key: sample.key.to_string_key(),
        pid: sample.pid,
        parent_pid: sample.parent_pid,
        parent_key: sample.parent_key.map(|k| k.to_string_key()),
        name: sample.name.clone(),
        image_path: sample.image_path.clone(),
        command_line: sample.command_line.clone(),
        create_time100ns: sample.create_time_100ns as f64,
        create_time_unix_ms: sample.create_time_unix_ms,
        session_id: sample.session_id,
        is_wow64: sample.is_wow64,
        architecture: sample.architecture.map(str::to_owned),
        user_name: sample.user_name.clone(),
        is_protected: sample.is_protected,
        product_name: sample.product_name.clone(),
        company_name: sample.company_name.clone(),
        file_description: sample.file_description.clone(),
        package_full_name: sample.package_full_name.clone(),
        application_user_model_id: sample.application_user_model_id.clone(),
        base_priority: sample.base_priority,
        kernel_time100ns: sample.kernel_time_100ns as f64,
        user_time100ns: sample.user_time_100ns as f64,
        cpu_machine_percent: sample.cpu_machine_percent,
        cpu_core_equivalent_percent: sample.cpu_core_equivalent_percent,
        working_set_bytes: sample.working_set_bytes as f64,
        private_working_set_bytes: sample.private_working_set_bytes as f64,
        private_commit_bytes: sample.private_commit_bytes as f64,
        peak_working_set_bytes: sample.peak_working_set_bytes as f64,
        paged_pool_bytes: sample.paged_pool_bytes as f64,
        non_paged_pool_bytes: sample.non_paged_pool_bytes as f64,
        virtual_size_bytes: sample.virtual_size_bytes as f64,
        page_fault_count: f64::from(sample.page_fault_count),
        hard_fault_count: f64::from(sample.hard_fault_count),
        thread_count: sample.thread_count,
        handle_count: sample.handle_count,
        io_read_bytes: sample.io_read_bytes as f64,
        io_write_bytes: sample.io_write_bytes as f64,
        io_other_bytes: sample.io_other_bytes as f64,
        io_read_operations: sample.io_read_operations as f64,
        io_write_operations: sample.io_write_operations as f64,
        io_other_operations: sample.io_other_operations as f64,
        io_read_bytes_per_second: sample.io_read_bytes_per_second,
        io_write_bytes_per_second: sample.io_write_bytes_per_second,
        gpu_percent: sample.gpu_percent,
        gpu_dedicated_memory_bytes: sample.gpu_dedicated_memory_bytes,
        gpu_shared_memory_bytes: sample.gpu_shared_memory_bytes,
        detail_failure: sample.detail_failure.map(str::to_owned),
    }
}

pub fn processes_to_js(sample: &ProcessesSample) -> JsProcessesSnapshot {
    JsProcessesSnapshot {
        processes: sample.processes.iter().map(process_to_js).collect(),
        total_count: sample.total_count as u32,
        access_denied_count: sample.access_denied_count as u32,
        vanished_count: sample.vanished_count as u32,
        collection_duration_ms: sample.collection_duration_ms,
    }
}

// --- disk -------------------------------------------------------------------

#[napi(object)]
#[derive(Debug, Clone)]
pub struct JsDiskSnapshot {
    /// PDH instance name, e.g. `0 C: D:`.
    pub instance: String,
    /// Physical disk number, when the instance name carried one.
    pub index: Option<u32>,
    /// Drive letters on this physical disk.
    pub volumes: Vec<String>,
    pub read_bytes_per_second: f64,
    pub write_bytes_per_second: f64,
    pub total_bytes_per_second: f64,
    /// `100 - % Idle Time`, the basis Task Manager uses for "Active time".
    pub active_time_percent: Option<f64>,
    pub average_read_latency_ms: Option<f64>,
    pub average_write_latency_ms: Option<f64>,
    pub queue_length: Option<f64>,
    pub reads_per_second: Option<f64>,
    pub writes_per_second: Option<f64>,
}

#[napi(object)]
#[derive(Debug, Clone)]
pub struct JsDisksSnapshot {
    pub disks: Vec<JsDiskSnapshot>,
    /// The `_Total` instance PDH synthesises, when present.
    pub total: Option<JsDiskSnapshot>,
    /// True when the PhysicalDisk counter set could not be registered.
    pub unavailable: bool,
}

// --- network ----------------------------------------------------------------

#[napi(object)]
#[derive(Debug, Clone)]
pub struct JsNetworkInterfaceSnapshot {
    pub name: String,
    pub received_bytes_per_second: f64,
    pub sent_bytes_per_second: f64,
    pub total_bytes_per_second: f64,
    pub link_speed_bits_per_second: Option<f64>,
    pub received_packets_per_second: Option<f64>,
    pub sent_packets_per_second: Option<f64>,
    pub outbound_discards_per_second: Option<f64>,
    pub is_loopback: bool,
}

#[napi(object)]
#[derive(Debug, Clone)]
pub struct JsNetworkSnapshot {
    pub interfaces: Vec<JsNetworkInterfaceSnapshot>,
    /// Summed over non-loopback interfaces.
    pub received_bytes_per_second: f64,
    pub sent_bytes_per_second: f64,
    pub unavailable: bool,
}

// --- gpu --------------------------------------------------------------------

#[napi(object)]
#[derive(Debug, Clone)]
pub struct JsGpuEngineSnapshot {
    /// Raw engine type from the counter, e.g. `3d`, `videodecode`.
    pub engine: String,
    /// Friendlier label for the same engine.
    pub label: String,
    pub utilisation_percent: f64,
}

#[napi(object)]
#[derive(Debug, Clone)]
pub struct JsGpuAdapterSnapshot {
    /// LUID key matching the PDH instance names, e.g. `0x00000000_0x000194b3`.
    pub luid: String,
    /// Adapter description from DXGI, absent when DXGI could not enumerate.
    pub name: Option<String>,
    pub is_software: bool,
    /// Maximum across engine types - never a sum, because engines run concurrently.
    pub utilisation_percent: Option<f64>,
    pub engines: Vec<JsGpuEngineSnapshot>,
    pub dedicated_memory_used_bytes: Option<f64>,
    pub dedicated_memory_total_bytes: Option<f64>,
    pub shared_memory_used_bytes: Option<f64>,
    pub shared_memory_total_bytes: Option<f64>,
}

#[napi(object)]
#[derive(Debug, Clone)]
pub struct JsGpuSnapshot {
    pub adapters: Vec<JsGpuAdapterSnapshot>,
    /// True when the GPU counter sets could not be registered.
    pub unavailable: bool,
}

pub fn disks_to_js(sample: &crate::disk::DisksSample) -> JsDisksSnapshot {
    JsDisksSnapshot {
        disks: sample.disks.iter().map(disk_to_js).collect(),
        total: sample.total.as_ref().map(disk_to_js),
        unavailable: sample.unavailable,
    }
}

fn disk_to_js(sample: &crate::disk::DiskSample) -> JsDiskSnapshot {
    JsDiskSnapshot {
        instance: sample.instance.clone(),
        index: sample.index,
        volumes: sample.volumes.clone(),
        read_bytes_per_second: sample.read_bytes_per_second,
        write_bytes_per_second: sample.write_bytes_per_second,
        total_bytes_per_second: sample.total_bytes_per_second,
        active_time_percent: sample.active_time_percent,
        average_read_latency_ms: sample.average_read_latency_ms,
        average_write_latency_ms: sample.average_write_latency_ms,
        queue_length: sample.queue_length,
        reads_per_second: sample.reads_per_second,
        writes_per_second: sample.writes_per_second,
    }
}

pub fn network_to_js(sample: &crate::network::NetworkSample) -> JsNetworkSnapshot {
    JsNetworkSnapshot {
        interfaces: sample
            .interfaces
            .iter()
            .map(|item| JsNetworkInterfaceSnapshot {
                name: item.name.clone(),
                received_bytes_per_second: item.received_bytes_per_second,
                sent_bytes_per_second: item.sent_bytes_per_second,
                total_bytes_per_second: item.total_bytes_per_second,
                link_speed_bits_per_second: item.link_speed_bits_per_second,
                received_packets_per_second: item.received_packets_per_second,
                sent_packets_per_second: item.sent_packets_per_second,
                outbound_discards_per_second: item.outbound_discards_per_second,
                is_loopback: item.is_loopback,
            })
            .collect(),
        received_bytes_per_second: sample.received_bytes_per_second,
        sent_bytes_per_second: sample.sent_bytes_per_second,
        unavailable: sample.unavailable,
    }
}

pub fn gpu_to_js(sample: &crate::gpu::GpuSample) -> JsGpuSnapshot {
    JsGpuSnapshot {
        adapters: sample
            .adapters
            .iter()
            .map(|adapter| JsGpuAdapterSnapshot {
                luid: adapter.luid.clone(),
                name: adapter.name.clone(),
                is_software: adapter.is_software,
                utilisation_percent: adapter.utilisation_percent,
                engines: adapter
                    .engines
                    .iter()
                    .map(|engine| JsGpuEngineSnapshot {
                        label: crate::gpu::engine_label(&engine.engine).to_string(),
                        engine: engine.engine.clone(),
                        utilisation_percent: engine.utilisation_percent,
                    })
                    .collect(),
                dedicated_memory_used_bytes: adapter.dedicated_memory_used_bytes,
                dedicated_memory_total_bytes: adapter
                    .dedicated_memory_total_bytes
                    .map(|value| value as f64),
                shared_memory_used_bytes: adapter.shared_memory_used_bytes,
                shared_memory_total_bytes: adapter
                    .shared_memory_total_bytes
                    .map(|value| value as f64),
            })
            .collect(),
        unavailable: sample.unavailable,
    }
}

// --- history ----------------------------------------------------------------

#[napi(object)]
#[derive(Debug, Clone)]
pub struct JsHistoryPoint {
    pub timestamp_unix_ms: f64,
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
    /// Peak within the window, which a mean would otherwise hide.
    pub cpu_time_peak_percent: Option<f64>,
    pub memory_used_peak_bytes: Option<f64>,
    pub disk_total_peak_bytes_per_second: Option<f64>,
}

#[napi(object)]
#[derive(Debug, Clone)]
pub struct JsHistoryTier {
    pub tier: u32,
    pub row_count: u32,
}

#[napi(object)]
#[derive(Debug, Clone)]
pub struct JsHistoryResult {
    pub points: Vec<JsHistoryPoint>,
    /// Which retention tier answered the query.
    pub tier: u32,
    /// Nominal resolution of that tier, in milliseconds.
    pub resolution_ms: f64,
    /// False when history is disabled or the database could not be opened.
    pub available: bool,
}

pub fn history_point_to_js(point: &crate::history::HistoryPoint) -> JsHistoryPoint {
    JsHistoryPoint {
        timestamp_unix_ms: point.timestamp_unix_ms,
        cpu_time_percent: point.sample.cpu_time_percent,
        cpu_utility_percent: point.sample.cpu_utility_percent,
        cpu_busiest_percent: point.sample.cpu_busiest_percent,
        memory_used_bytes: point.sample.memory_used_bytes,
        memory_available_bytes: point.sample.memory_available_bytes,
        memory_committed_bytes: point.sample.memory_committed_bytes,
        disk_read_bytes_per_second: point.sample.disk_read_bytes_per_second,
        disk_write_bytes_per_second: point.sample.disk_write_bytes_per_second,
        disk_active_percent: point.sample.disk_active_percent,
        network_down_bytes_per_second: point.sample.network_down_bytes_per_second,
        network_up_bytes_per_second: point.sample.network_up_bytes_per_second,
        gpu_percent: point.sample.gpu_percent,
        gpu_memory_bytes: point.sample.gpu_memory_bytes,
        process_count: point.sample.process_count,
        thread_count: point.sample.thread_count,
        handle_count: point.sample.handle_count,
        cpu_time_peak_percent: point.cpu_time_peak_percent,
        memory_used_peak_bytes: point.memory_used_peak_bytes,
        disk_total_peak_bytes_per_second: point.disk_total_peak_bytes_per_second,
    }
}
