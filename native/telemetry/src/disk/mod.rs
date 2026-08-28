//! Disk telemetry.
//!
//! # What is measured, and what is not
//!
//! System and per-disk figures come from the `PhysicalDisk` counter set, which
//! the kernel maintains per physical device. That is a genuine disk measurement:
//! it counts requests that reached the storage stack.
//!
//! Per-process figures are a different thing entirely and are labelled as such
//! everywhere. Windows' per-process I/O counters
//! (`ProcessSnapshot.ioReadBytesPerSecond`) cover file, network, device and pipe
//! I/O together, so a process streaming from a socket increases them without
//! touching a disk. Attributing real disk I/O to a process requires ETW, which
//! is a later stage; until then this module does not claim to do it.
//!
//! # Why PhysicalDisk rather than LogicalDisk
//!
//! `LogicalDisk` is per volume, so a single physical device carrying three
//! partitions appears three times and the totals double-count. `PhysicalDisk`
//! matches the hardware, which is what "what is my disk doing" means.

use std::collections::HashMap;

use crate::win::pdh::{CounterId, PdhQuery};

/// The `_Total` instance PDH synthesises across all physical disks.
const TOTAL_INSTANCE: &str = "_Total";

/// One physical disk over one interval.
#[derive(Debug, Clone)]
pub struct DiskSample {
    /// PDH instance name, e.g. `0 C: D:` - the disk number and the volumes on it.
    pub instance: String,
    /// Disk number parsed out of the instance name, when it starts with one.
    pub index: Option<u32>,
    /// Drive letters carried by this physical disk, parsed from the instance name.
    pub volumes: Vec<String>,
    pub read_bytes_per_second: f64,
    pub write_bytes_per_second: f64,
    /// Reads plus writes.
    pub total_bytes_per_second: f64,
    /// Fraction of the interval the disk had at least one request outstanding,
    /// 0..100. Derived as `100 - % Idle Time`, which is how Task Manager gets
    /// its "Active time".
    pub active_time_percent: Option<f64>,
    /// Mean seconds per read during the interval, from `Avg. Disk sec/Read`.
    pub average_read_latency_ms: Option<f64>,
    pub average_write_latency_ms: Option<f64>,
    /// Requests outstanding at the end of the interval.
    pub queue_length: Option<f64>,
    pub reads_per_second: Option<f64>,
    pub writes_per_second: Option<f64>,
    /// The drive's own sensor, joined on by `thermal::attach_to_disks`. Absent
    /// for the synthesised `_Total` instance, which is not a device.
    pub temperature: Option<crate::thermal::TemperatureReading>,
}

/// A whole-machine disk sample plus the per-disk breakdown.
#[derive(Debug, Clone, Default)]
pub struct DisksSample {
    /// Per physical disk, excluding the synthesised `_Total` instance.
    pub disks: Vec<DiskSample>,
    /// The `_Total` instance, when PDH published one.
    pub total: Option<DiskSample>,
    /// True when the counter set could not be registered at all.
    pub unavailable: bool,
}

/// Registered disk counters, on top of the engine's shared PDH query.
pub struct DiskCollector {
    read_bytes: Option<CounterId>,
    write_bytes: Option<CounterId>,
    idle_time: Option<CounterId>,
    read_latency: Option<CounterId>,
    write_latency: Option<CounterId>,
    queue_length: Option<CounterId>,
    reads: Option<CounterId>,
    writes: Option<CounterId>,
}

impl DiskCollector {
    /// A collector for a machine where PDH itself could not be opened.
    pub fn unavailable() -> Self {
        Self {
            read_bytes: None,
            write_bytes: None,
            idle_time: None,
            read_latency: None,
            write_latency: None,
            queue_length: None,
            reads: None,
            writes: None,
        }
    }

    pub fn register(query: &mut PdhQuery) -> Self {
        Self {
            read_bytes: query.add(r"\PhysicalDisk(*)\Disk Read Bytes/sec"),
            write_bytes: query.add(r"\PhysicalDisk(*)\Disk Write Bytes/sec"),
            // Active time is the complement of idle time. Windows has no
            // "% Disk Time" that behaves sensibly above one outstanding request,
            // so Task Manager uses this too.
            idle_time: query.add(r"\PhysicalDisk(*)\% Idle Time"),
            read_latency: query.add(r"\PhysicalDisk(*)\Avg. Disk sec/Read"),
            write_latency: query.add(r"\PhysicalDisk(*)\Avg. Disk sec/Write"),
            queue_length: query.add(r"\PhysicalDisk(*)\Current Disk Queue Length"),
            reads: query.add(r"\PhysicalDisk(*)\Disk Reads/sec"),
            writes: query.add(r"\PhysicalDisk(*)\Disk Writes/sec"),
        }
    }

    pub fn is_available(&self) -> bool {
        self.read_bytes.is_some() && self.write_bytes.is_some()
    }

    pub fn sample(&self, query: &PdhQuery) -> DisksSample {
        if !self.is_available() {
            return DisksSample {
                unavailable: true,
                ..Default::default()
            };
        }

        let read = collect(query, self.read_bytes);
        let write = collect(query, self.write_bytes);
        let idle = collect(query, self.idle_time);
        let read_latency = collect(query, self.read_latency);
        let write_latency = collect(query, self.write_latency);
        let queue = collect(query, self.queue_length);
        let reads = collect(query, self.reads);
        let writes = collect(query, self.writes);

        // Instance names are the union of what each counter reported: a disk
        // that appeared between two counters being formatted should still show.
        let mut names: Vec<String> = read.keys().chain(write.keys()).cloned().collect();
        names.sort();
        names.dedup();

        let mut disks = Vec::new();
        let mut total = None;

        for name in names {
            let read_bytes = read.get(&name).copied().unwrap_or(0.0);
            let write_bytes = write.get(&name).copied().unwrap_or(0.0);
            let (index, volumes) = parse_instance(&name);
            let sample = DiskSample {
                index,
                volumes,
                read_bytes_per_second: read_bytes,
                write_bytes_per_second: write_bytes,
                total_bytes_per_second: read_bytes + write_bytes,
                // % Idle Time can exceed 100 over a short interval because it is
                // sampled rather than integrated; clamping keeps "active" in
                // 0..100 without inventing a value.
                active_time_percent: idle
                    .get(&name)
                    .map(|value| (100.0 - value).clamp(0.0, 100.0)),
                // PDH reports these in seconds; milliseconds is what anyone
                // reading disk latency actually wants.
                average_read_latency_ms: read_latency.get(&name).map(|value| value * 1000.0),
                average_write_latency_ms: write_latency.get(&name).map(|value| value * 1000.0),
                queue_length: queue.get(&name).copied(),
                reads_per_second: reads.get(&name).copied(),
                writes_per_second: writes.get(&name).copied(),
                temperature: None,
                instance: name.clone(),
            };
            if name == TOTAL_INSTANCE {
                total = Some(sample);
            } else {
                disks.push(sample);
            }
        }

        // Busiest first: the question being asked is almost always "which disk".
        disks.sort_by(|a, b| {
            b.total_bytes_per_second
                .total_cmp(&a.total_bytes_per_second)
        });

        DisksSample {
            disks,
            total,
            unavailable: false,
        }
    }
}

fn collect(query: &PdhQuery, id: Option<CounterId>) -> HashMap<String, f64> {
    match id {
        Some(id) => query.instances(id).into_iter().collect(),
        None => HashMap::new(),
    }
}

/// Split a `PhysicalDisk` instance name into its disk number and volumes.
///
/// Windows formats these as `0 C:`, `1 D: E:`, or `2` for a disk with no
/// mounted volume. `_Total` and anything unexpected yield no index.
pub fn parse_instance(instance: &str) -> (Option<u32>, Vec<String>) {
    let mut parts = instance.split_whitespace();
    let Some(first) = parts.next() else {
        return (None, Vec::new());
    };
    let index = first.parse::<u32>().ok();
    if index.is_none() {
        return (None, Vec::new());
    }
    let volumes = parts.map(str::to_owned).collect();
    (index, volumes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_disk_with_one_volume() {
        assert_eq!(parse_instance("0 C:"), (Some(0), vec!["C:".to_string()]));
    }

    #[test]
    fn parses_a_disk_with_several_volumes() {
        assert_eq!(
            parse_instance("1 D: E: F:"),
            (Some(1), vec!["D:".into(), "E:".into(), "F:".into()])
        );
    }

    #[test]
    fn parses_a_disk_with_no_mounted_volume() {
        assert_eq!(parse_instance("2"), (Some(2), Vec::<String>::new()));
    }

    #[test]
    fn does_not_treat_the_total_instance_as_a_disk() {
        assert_eq!(parse_instance("_Total"), (None, Vec::<String>::new()));
    }

    #[test]
    fn tolerates_an_unexpected_instance_name() {
        assert_eq!(parse_instance(""), (None, Vec::<String>::new()));
        assert_eq!(parse_instance("weird name"), (None, Vec::<String>::new()));
    }
}
