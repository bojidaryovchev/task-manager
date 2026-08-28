//! GPU telemetry.
//!
//! # How overall GPU utilisation is derived
//!
//! A GPU is not one execution unit. Windows tracks separate engines - 3D,
//! Compute, Copy, Video Decode, Video Encode and others - which run
//! concurrently. Their utilisations therefore **must not be summed**: a workload
//! decoding video while copying buffers would report well over 100% for a GPU
//! that is nowhere near saturated.
//!
//! What this collector reports as the adapter's overall utilisation is the
//! **maximum across engine types**, which is the same rule Windows Task Manager
//! applies. Each engine type's own total is exposed alongside it, so a workload
//! that is entirely video-decode bound is visible as such rather than hidden
//! inside one number.
//!
//! # Instance names
//!
//! The counter sets identify everything by LUID and PID:
//!
//! ```text
//! pid_111056_luid_0x00000000_0x000194b3_phys_0_eng_0_engtype_3d
//! ```
//!
//! Adapter names and total dedicated video memory come from DXGI and are joined
//! to these by LUID. When DXGI is unavailable the adapter still appears, named
//! by its LUID, rather than being dropped.

use std::collections::HashMap;

use crate::win::dxgi::{self, GraphicsAdapter};
use crate::win::pdh::{CounterId, PdhQuery};

/// Engine types Windows reports, normalised from the `engtype_` suffix.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct EngineType(pub String);

/// Utilisation of one engine type on one adapter.
#[derive(Debug, Clone)]
pub struct EngineUtilisation {
    pub engine: String,
    pub utilisation_percent: f64,
}

/// One adapter over one interval.
#[derive(Debug, Clone)]
pub struct AdapterSample {
    /// LUID key, e.g. `0x00000000_0x000194b3`. Always present.
    pub luid: String,
    /// Adapter description from DXGI, when it could be enumerated.
    pub name: Option<String>,
    /// True for software renderers such as the Microsoft Basic Render Driver.
    pub is_software: bool,
    /// Maximum across engine types. Never a sum. Absent when no engine reported.
    pub utilisation_percent: Option<f64>,
    /// Per-engine-type totals, highest first.
    pub engines: Vec<EngineUtilisation>,
    /// Dedicated (on-board) video memory in use, in bytes.
    pub dedicated_memory_used_bytes: Option<f64>,
    /// Total dedicated video memory from DXGI, in bytes.
    pub dedicated_memory_total_bytes: Option<u64>,
    /// System memory the adapter is using.
    pub shared_memory_used_bytes: Option<f64>,
    /// Total system memory the adapter may share, from DXGI.
    pub shared_memory_total_bytes: Option<u64>,
}

/// Per-process GPU usage, keyed by PID.
#[derive(Debug, Clone, Default)]
pub struct ProcessGpuUsage {
    /// Maximum across engine types, summed over adapters the process used.
    pub utilisation_percent: f64,
    pub dedicated_memory_bytes: f64,
    pub shared_memory_bytes: f64,
}

#[derive(Debug, Clone, Default)]
pub struct GpuSample {
    pub adapters: Vec<AdapterSample>,
    /// Per-process usage, keyed by PID. Empty when the counter set is missing.
    pub by_process: HashMap<u32, ProcessGpuUsage>,
    /// True when the GPU counter sets could not be registered at all.
    pub unavailable: bool,
}

pub struct GpuCollector {
    engine: Option<CounterId>,
    dedicated_usage: Option<CounterId>,
    shared_usage: Option<CounterId>,
    process_dedicated: Option<CounterId>,
    process_shared: Option<CounterId>,
    /// Enumerated once: adapters do not come and go while the app runs, and
    /// DXGI enumeration is far too expensive for a 500 ms loop.
    adapters: Vec<GraphicsAdapter>,
}

impl GpuCollector {
    /// A collector for a machine where PDH itself could not be opened.
    pub fn unavailable() -> Self {
        Self {
            engine: None,
            dedicated_usage: None,
            shared_usage: None,
            process_dedicated: None,
            process_shared: None,
            adapters: Vec::new(),
        }
    }

    pub fn register(query: &mut PdhQuery) -> Self {
        Self {
            engine: query.add(r"\GPU Engine(*)\Utilization Percentage"),
            dedicated_usage: query.add(r"\GPU Adapter Memory(*)\Dedicated Usage"),
            shared_usage: query.add(r"\GPU Adapter Memory(*)\Shared Usage"),
            process_dedicated: query.add(r"\GPU Process Memory(*)\Dedicated Usage"),
            process_shared: query.add(r"\GPU Process Memory(*)\Shared Usage"),
            adapters: dxgi::enumerate_adapters(),
        }
    }

    pub fn is_available(&self) -> bool {
        self.engine.is_some()
    }

    /// Adapters as DXGI reported them, for diagnostics.
    pub fn adapters(&self) -> &[GraphicsAdapter] {
        &self.adapters
    }

    pub fn sample(&self, query: &PdhQuery) -> GpuSample {
        if !self.is_available() {
            return GpuSample {
                unavailable: true,
                ..Default::default()
            };
        }

        // (luid, engine type) -> summed utilisation across every process and
        // every physical engine of that type.
        let mut engine_totals: HashMap<(String, String), f64> = HashMap::new();
        // pid -> engine type -> utilisation
        let mut process_engines: HashMap<u32, HashMap<String, f64>> = HashMap::new();

        if let Some(id) = self.engine {
            for (instance, value) in query.instances(id) {
                let Some(parsed) = parse_engine_instance(&instance) else {
                    continue;
                };
                *engine_totals
                    .entry((parsed.luid.clone(), parsed.engine_type.clone()))
                    .or_insert(0.0) += value;
                if let Some(pid) = parsed.pid {
                    *process_engines
                        .entry(pid)
                        .or_default()
                        .entry(parsed.engine_type)
                        .or_insert(0.0) += value;
                }
            }
        }

        let dedicated = self.adapter_memory(query, self.dedicated_usage);
        let shared = self.adapter_memory(query, self.shared_usage);

        // Every LUID seen anywhere, so an adapter with memory allocated but no
        // engine activity still appears.
        let mut luids: Vec<String> = engine_totals
            .keys()
            .map(|(luid, _)| luid.clone())
            .chain(dedicated.keys().cloned())
            .chain(shared.keys().cloned())
            .chain(self.adapters.iter().map(GraphicsAdapter::luid_key))
            .collect();
        luids.sort();
        luids.dedup();

        let mut adapters = Vec::with_capacity(luids.len());
        for luid in luids {
            let described = self
                .adapters
                .iter()
                .find(|adapter| adapter.luid_key() == luid);

            let mut engines: Vec<EngineUtilisation> = engine_totals
                .iter()
                .filter(|((adapter_luid, _), _)| *adapter_luid == luid)
                .map(|((_, engine), value)| EngineUtilisation {
                    engine: engine.clone(),
                    utilisation_percent: *value,
                })
                .collect();
            engines.sort_by(|a, b| b.utilisation_percent.total_cmp(&a.utilisation_percent));

            adapters.push(AdapterSample {
                // The maximum, never the sum: engines run concurrently.
                utilisation_percent: engines.first().map(|e| e.utilisation_percent),
                engines,
                name: described.map(|adapter| adapter.description.clone()),
                is_software: described.is_some_and(|adapter| adapter.is_software),
                dedicated_memory_used_bytes: dedicated.get(&luid).copied(),
                dedicated_memory_total_bytes: described
                    .map(|adapter| adapter.dedicated_video_memory_bytes),
                shared_memory_used_bytes: shared.get(&luid).copied(),
                shared_memory_total_bytes: described
                    .map(|adapter| adapter.shared_system_memory_bytes),
                luid,
            });
        }

        // Real adapters before software renderers, then by utilisation.
        adapters.sort_by(|a, b| {
            a.is_software.cmp(&b.is_software).then(
                b.utilisation_percent
                    .unwrap_or(0.0)
                    .total_cmp(&a.utilisation_percent.unwrap_or(0.0)),
            )
        });

        let mut by_process: HashMap<u32, ProcessGpuUsage> = HashMap::new();
        for (pid, engines) in process_engines {
            let utilisation = engines.values().copied().fold(0.0f64, f64::max);
            by_process.entry(pid).or_default().utilisation_percent = utilisation;
        }
        for (pid, bytes) in self.process_memory(query, self.process_dedicated) {
            by_process.entry(pid).or_default().dedicated_memory_bytes = bytes;
        }
        for (pid, bytes) in self.process_memory(query, self.process_shared) {
            by_process.entry(pid).or_default().shared_memory_bytes = bytes;
        }

        GpuSample {
            adapters,
            by_process,
            unavailable: false,
        }
    }

    /// Sum an adapter-memory counter per LUID.
    fn adapter_memory(&self, query: &PdhQuery, id: Option<CounterId>) -> HashMap<String, f64> {
        let Some(id) = id else {
            return HashMap::new();
        };
        query.instances_grouped(id, parse_luid)
    }

    /// Sum a process-memory counter per PID.
    fn process_memory(&self, query: &PdhQuery, id: Option<CounterId>) -> HashMap<u32, f64> {
        let Some(id) = id else {
            return HashMap::new();
        };
        let mut totals: HashMap<u32, f64> = HashMap::new();
        for (instance, value) in query.instances(id) {
            if let Some(pid) = parse_pid(&instance) {
                *totals.entry(pid).or_insert(0.0) += value;
            }
        }
        totals
    }
}

/// The fields we care about from a `GPU Engine` instance name.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EngineInstance {
    pub pid: Option<u32>,
    pub luid: String,
    pub engine_type: String,
}

/// Parse `pid_111056_luid_0x00000000_0x000194b3_phys_0_eng_0_engtype_3d`.
///
/// Written as a field scan rather than a fixed split because Windows has added
/// fields to these names over time and puts them in a different order for the
/// memory counter sets.
pub fn parse_engine_instance(instance: &str) -> Option<EngineInstance> {
    let luid = parse_luid(instance)?;
    let engine_type = instance
        .split("engtype_")
        .nth(1)
        .map(|value| value.to_ascii_lowercase())?;
    if engine_type.is_empty() {
        return None;
    }
    Some(EngineInstance {
        pid: parse_pid(instance),
        luid,
        engine_type,
    })
}

/// Extract the `luid_0xHIGH_0xLOW` pair from any GPU counter instance name.
///
/// Lower-cased. PDH returns the hex digits in upper case through
/// `PdhGetFormattedCounterArrayW` but lower case in some other surfaces, and the
/// two must produce the same key or an adapter is counted twice: once with its
/// counters and once with its DXGI name.
pub fn parse_luid(instance: &str) -> Option<String> {
    let rest = instance.split("luid_").nth(1)?;
    let mut parts = rest.split('_');
    let high = parts.next()?;
    let low = parts.next()?;
    if !high.starts_with("0x") || !low.starts_with("0x") {
        return None;
    }
    Some(format!("{high}_{low}").to_ascii_lowercase())
}

/// Extract the owning PID from a `pid_1234_...` instance name.
pub fn parse_pid(instance: &str) -> Option<u32> {
    let rest = instance.strip_prefix("pid_")?;
    let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
    digits.parse().ok()
}

/// A friendlier label for an engine type than the raw counter suffix.
pub fn engine_label(engine_type: &str) -> &str {
    match engine_type {
        "3d" => "3D",
        "copy" => "Copy",
        "compute" => "Compute",
        "videodecode" => "Video decode",
        "videoencode" => "Video encode",
        "videoprocessing" => "Video processing",
        "security" => "Security",
        other => other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const REAL: &str = "pid_111056_luid_0x00000000_0x000194b3_phys_0_eng_0_engtype_3d";

    #[test]
    fn parses_a_real_engine_instance_name() {
        let parsed = parse_engine_instance(REAL).expect("parsed");
        assert_eq!(parsed.pid, Some(111_056));
        assert_eq!(parsed.luid, "0x00000000_0x000194b3");
        assert_eq!(parsed.engine_type, "3d");
    }

    #[test]
    fn parses_multi_word_engine_types() {
        let instance = "pid_4_luid_0x00000000_0x0000abcd_phys_0_eng_1_engtype_videodecode";
        let parsed = parse_engine_instance(instance).expect("parsed");
        assert_eq!(parsed.engine_type, "videodecode");
        assert_eq!(engine_label(&parsed.engine_type), "Video decode");
    }

    #[test]
    fn lowercases_the_engine_type_so_case_changes_do_not_split_a_group() {
        let upper = "pid_4_luid_0x00000000_0x0000abcd_phys_0_eng_0_engtype_3D";
        assert_eq!(parse_engine_instance(upper).unwrap().engine_type, "3d");
    }

    #[test]
    fn parses_an_adapter_memory_instance_with_no_pid() {
        // GPU Adapter Memory instances carry no pid_ prefix.
        let instance = "luid_0x00000000_0x000194b3_phys_0";
        assert_eq!(
            parse_luid(instance).as_deref(),
            Some("0x00000000_0x000194b3")
        );
        assert_eq!(parse_pid(instance), None);
    }

    #[test]
    fn parses_a_process_memory_instance() {
        let instance = "pid_235128_luid_0x00000000_0x000194b3_phys_0";
        assert_eq!(parse_pid(instance), Some(235_128));
        assert_eq!(
            parse_luid(instance).as_deref(),
            Some("0x00000000_0x000194b3")
        );
    }

    #[test]
    fn lower_cases_the_luid_so_pdh_and_dxgi_agree() {
        // PDH returns upper-case hex here; DXGI formats lower case. If these
        // produced different keys, every adapter would appear twice.
        let upper = "pid_1_luid_0x00000000_0x000194B3_phys_0_eng_0_engtype_3d";
        let lower = "pid_1_luid_0x00000000_0x000194b3_phys_0_eng_0_engtype_3d";
        assert_eq!(parse_luid(upper), parse_luid(lower));
        assert_eq!(parse_luid(upper).as_deref(), Some("0x00000000_0x000194b3"));
    }

    #[test]
    fn rejects_an_instance_with_no_luid() {
        assert_eq!(parse_luid("pid_1_phys_0"), None);
        assert_eq!(parse_engine_instance("pid_1_phys_0_engtype_3d"), None);
    }

    #[test]
    fn rejects_a_malformed_luid() {
        assert_eq!(parse_luid("luid_zzz_0x1"), None);
        assert_eq!(parse_luid("luid_0x1"), None);
    }

    #[test]
    fn rejects_an_instance_with_no_engine_type() {
        assert_eq!(parse_engine_instance("pid_1_luid_0x0_0x1_phys_0"), None);
    }

    #[test]
    fn tolerates_a_missing_pid_on_an_engine_instance() {
        let instance = "luid_0x00000000_0x000194b3_phys_0_eng_0_engtype_copy";
        let parsed = parse_engine_instance(instance).expect("parsed");
        assert_eq!(parsed.pid, None);
        assert_eq!(parsed.engine_type, "copy");
    }
}
