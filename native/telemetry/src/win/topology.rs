//! CPU topology, read from `GetLogicalProcessorInformationEx`.
//!
//! We report only what Windows actually tells us. In particular, "performance"
//! and "efficiency" cores are *not* inferred from frequency, core count or the
//! CPU brand string: they come from `PROCESSOR_RELATIONSHIP::EfficiencyClass`,
//! and when Windows reports a single efficiency class we say the machine is not
//! hybrid rather than guessing.
//!
//! Processor groups are handled throughout. A logical processor is addressed by
//! (group, number-in-group); we also assign a stable flat index that orders
//! group 0 first, so systems with more than 64 logical processors work.

use windows_sys::Win32::System::SystemInformation::{
    GetLogicalProcessorInformationEx, RelationAll,
};

/// Windows `LOGICAL_PROCESSOR_RELATIONSHIP` values we care about.
const RELATION_PROCESSOR_CORE: u32 = 0;
const RELATION_PROCESSOR_PACKAGE: u32 = 3;
const RELATION_GROUP: u32 = 4;

/// Size of `GROUP_AFFINITY` on x64: KAFFINITY (8) + WORD Group + WORD[3].
const GROUP_AFFINITY_SIZE: usize = 16;
/// Size of `PROCESSOR_GROUP_INFO`: 2 BYTEs + BYTE[38] + KAFFINITY.
const PROCESSOR_GROUP_INFO_SIZE: usize = 48;
/// Offset of the `GroupMask` array inside a `PROCESSOR_RELATIONSHIP` record.
const PROCESSOR_RELATIONSHIP_GROUP_MASK_OFFSET: usize = 32;
/// Offset of `GroupCount` inside a `PROCESSOR_RELATIONSHIP` record.
const PROCESSOR_RELATIONSHIP_GROUP_COUNT_OFFSET: usize = 30;
/// Offset of the `GroupInfo` array inside a `GROUP_RELATIONSHIP` record.
const GROUP_RELATIONSHIP_GROUP_INFO_OFFSET: usize = 32;

/// One logical processor, located in the (group, number) address space.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LogicalProcessor {
    /// Stable flat index: group 0 processors first, then group 1, and so on.
    pub index: usize,
    pub group: u16,
    pub number_in_group: u8,
    /// Index into [`Topology::cores`], or `None` when Windows did not report a
    /// core relationship covering this processor.
    pub core_id: Option<usize>,
    /// `PROCESSOR_RELATIONSHIP::EfficiencyClass` of the owning core.
    pub efficiency_class: Option<u8>,
}

/// One physical core.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PhysicalCore {
    pub id: usize,
    /// Windows efficiency class. Higher is more performant. Meaningful only
    /// when the machine reports more than one class.
    pub efficiency_class: u8,
    /// True when `LTP_PC_SMT` is set, i.e. the core has more than one logical
    /// processor (hyper-threading / SMT).
    pub is_smt: bool,
    /// Flat indices of the logical processors on this core.
    pub logical_processors: Vec<usize>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Topology {
    pub package_count: usize,
    pub cores: Vec<PhysicalCore>,
    pub logical_processors: Vec<LogicalProcessor>,
    /// Active processors per group, indexed by group number.
    pub processors_per_group: Vec<usize>,
}

impl Topology {
    pub fn logical_processor_count(&self) -> usize {
        self.logical_processors.len()
    }

    pub fn group_count(&self) -> usize {
        self.processors_per_group.len()
    }

    /// Distinct efficiency classes, ascending.
    pub fn efficiency_classes(&self) -> Vec<u8> {
        let mut classes: Vec<u8> = self.cores.iter().map(|c| c.efficiency_class).collect();
        classes.sort_unstable();
        classes.dedup();
        classes
    }

    /// True only when Windows reports more than one efficiency class.
    pub fn is_hybrid(&self) -> bool {
        self.efficiency_classes().len() > 1
    }

    /// Flat index for a (group, number-in-group) address, if it exists.
    pub fn flat_index(&self, group: u16, number_in_group: u8) -> Option<usize> {
        let preceding: usize = self
            .processors_per_group
            .iter()
            .take(group as usize)
            .sum::<usize>();
        let within = *self.processors_per_group.get(group as usize)?;
        if (number_in_group as usize) < within {
            Some(preceding + number_in_group as usize)
        } else {
            None
        }
    }
}

fn read_u16(buffer: &[u8], offset: usize) -> Option<u16> {
    let bytes = buffer.get(offset..offset + 2)?;
    Some(u16::from_le_bytes([bytes[0], bytes[1]]))
}

fn read_u32(buffer: &[u8], offset: usize) -> Option<u32> {
    let bytes = buffer.get(offset..offset + 4)?;
    Some(u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
}

fn read_u64(buffer: &[u8], offset: usize) -> Option<u64> {
    let bytes = buffer.get(offset..offset + 8)?;
    let mut array = [0u8; 8];
    array.copy_from_slice(bytes);
    Some(u64::from_le_bytes(array))
}

/// A core as read from the buffer, before flat indices have been assigned:
/// its efficiency class, whether it is SMT, and the (group, number) address of
/// each logical processor on it.
type RawCore = (u8, bool, Vec<(u16, u8)>);

/// Raw `GetLogicalProcessorInformationEx(RelationAll)` buffer.
fn logical_processor_information() -> Option<Vec<u8>> {
    let mut length: u32 = 0;
    // SAFETY: passing a null buffer with a zero length is the documented way to
    // ask for the required size; it fails with ERROR_INSUFFICIENT_BUFFER and
    // writes the size to `length`.
    unsafe {
        GetLogicalProcessorInformationEx(RelationAll, std::ptr::null_mut(), &mut length);
    }
    if length == 0 {
        return None;
    }
    let mut buffer = vec![0u8; length as usize];
    // SAFETY: `buffer` holds `length` bytes and we pass exactly that length.
    let ok = unsafe {
        GetLogicalProcessorInformationEx(RelationAll, buffer.as_mut_ptr() as *mut _, &mut length)
    };
    if ok == 0 {
        return None;
    }
    buffer.truncate(length as usize);
    Some(buffer)
}

/// Parse a `RelationAll` buffer into a [`Topology`].
///
/// Exposed separately from the syscall so it can be unit-tested against
/// synthetic buffers, including malformed ones.
pub fn parse_topology(buffer: &[u8]) -> Topology {
    let mut package_count = 0usize;
    let mut processors_per_group: Vec<usize> = Vec::new();
    // (efficiency_class, is_smt, [(group, number_in_group)])
    let mut raw_cores: Vec<RawCore> = Vec::new();

    let mut offset = 0usize;
    while offset + 8 <= buffer.len() {
        let Some(relationship) = read_u32(buffer, offset) else {
            break;
        };
        let Some(size) = read_u32(buffer, offset + 4) else {
            break;
        };
        let size = size as usize;
        // A zero or out-of-range size would make this loop spin or read out of
        // bounds; stop instead.
        if size < 8 || offset + size > buffer.len() {
            break;
        }
        let record = &buffer[offset..offset + size];

        match relationship {
            RELATION_PROCESSOR_PACKAGE => package_count += 1,
            RELATION_PROCESSOR_CORE => {
                let flags = record.get(8).copied().unwrap_or(0);
                let efficiency_class = record.get(9).copied().unwrap_or(0);
                let group_count =
                    read_u16(record, PROCESSOR_RELATIONSHIP_GROUP_COUNT_OFFSET).unwrap_or(0);
                let mut members = Vec::new();
                for g in 0..group_count as usize {
                    let base = PROCESSOR_RELATIONSHIP_GROUP_MASK_OFFSET + g * GROUP_AFFINITY_SIZE;
                    let (Some(mask), Some(group)) =
                        (read_u64(record, base), read_u16(record, base + 8))
                    else {
                        break;
                    };
                    for bit in 0..64u8 {
                        if mask & (1u64 << bit) != 0 {
                            members.push((group, bit));
                        }
                    }
                }
                // LTP_PC_SMT == 1
                raw_cores.push((efficiency_class, flags & 1 != 0, members));
            }
            RELATION_GROUP => {
                let active_group_count = read_u16(record, 10).unwrap_or(0);
                for g in 0..active_group_count as usize {
                    let base = GROUP_RELATIONSHIP_GROUP_INFO_OFFSET + g * PROCESSOR_GROUP_INFO_SIZE;
                    let Some(active) = record.get(base + 1).copied() else {
                        break;
                    };
                    processors_per_group.push(active as usize);
                }
            }
            _ => {}
        }
        offset += size;
    }

    // If the group relationship was missing, derive the group layout from the
    // cores we did see, so we still produce a usable topology.
    if processors_per_group.is_empty() {
        let mut highest_in_group: Vec<usize> = Vec::new();
        for (_, _, members) in &raw_cores {
            for (group, number) in members {
                let group = *group as usize;
                if highest_in_group.len() <= group {
                    highest_in_group.resize(group + 1, 0);
                }
                highest_in_group[group] = highest_in_group[group].max(*number as usize + 1);
            }
        }
        processors_per_group = highest_in_group;
    }

    let group_offsets: Vec<usize> = processors_per_group
        .iter()
        .scan(0usize, |acc, count| {
            let start = *acc;
            *acc += count;
            Some(start)
        })
        .collect();
    let total_logical: usize = processors_per_group.iter().sum();

    let mut logical_processors: Vec<LogicalProcessor> = Vec::with_capacity(total_logical);
    for (group, count) in processors_per_group.iter().enumerate() {
        for number in 0..*count {
            logical_processors.push(LogicalProcessor {
                index: group_offsets[group] + number,
                group: group as u16,
                number_in_group: number as u8,
                core_id: None,
                efficiency_class: None,
            });
        }
    }

    let mut cores: Vec<PhysicalCore> = Vec::with_capacity(raw_cores.len());
    for (core_id, (efficiency_class, is_smt, members)) in raw_cores.into_iter().enumerate() {
        let mut owned = Vec::with_capacity(members.len());
        for (group, number) in members {
            let Some(&group_start) = group_offsets.get(group as usize) else {
                continue;
            };
            let flat = group_start + number as usize;
            if let Some(processor) = logical_processors.get_mut(flat) {
                processor.core_id = Some(core_id);
                processor.efficiency_class = Some(efficiency_class);
                owned.push(flat);
            }
        }
        cores.push(PhysicalCore {
            id: core_id,
            efficiency_class,
            is_smt,
            logical_processors: owned,
        });
    }

    Topology {
        package_count: package_count.max(1),
        cores,
        logical_processors,
        processors_per_group,
    }
}

/// Read the machine topology. Returns a single-processor fallback only if the
/// Windows call fails outright, which should not happen on a supported system.
pub fn read_topology() -> Topology {
    match logical_processor_information() {
        Some(buffer) => {
            let topology = parse_topology(&buffer);
            if topology.logical_processors.is_empty() {
                fallback_topology()
            } else {
                topology
            }
        }
        None => fallback_topology(),
    }
}

fn fallback_topology() -> Topology {
    let count = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(1);
    Topology {
        package_count: 1,
        cores: Vec::new(),
        logical_processors: (0..count)
            .map(|i| LogicalProcessor {
                index: i,
                group: 0,
                number_in_group: i as u8,
                core_id: None,
                efficiency_class: None,
            })
            .collect(),
        processors_per_group: vec![count],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a synthetic RelationAll buffer: one package, one group with
    /// `logical` processors, and `cores` core records.
    /// Borrowed form of [`RawCore`], for building synthetic buffers in tests.
    type CoreSpec<'a> = (u8, bool, &'a [(u16, u8)]);

    fn synthetic(cores: &[CoreSpec<'_>], group_sizes: &[u8]) -> Vec<u8> {
        let mut out = Vec::new();

        // Package record (PROCESSOR_RELATIONSHIP with no group masks used).
        let mut package = vec![0u8; 72];
        package[0..4].copy_from_slice(&RELATION_PROCESSOR_PACKAGE.to_le_bytes());
        package[4..8].copy_from_slice(&72u32.to_le_bytes());
        out.extend_from_slice(&package);

        // Group record.
        let group_size =
            GROUP_RELATIONSHIP_GROUP_INFO_OFFSET + group_sizes.len() * PROCESSOR_GROUP_INFO_SIZE;
        let mut group = vec![0u8; group_size];
        group[0..4].copy_from_slice(&RELATION_GROUP.to_le_bytes());
        group[4..8].copy_from_slice(&(group_size as u32).to_le_bytes());
        group[8..10].copy_from_slice(&(group_sizes.len() as u16).to_le_bytes());
        group[10..12].copy_from_slice(&(group_sizes.len() as u16).to_le_bytes());
        for (i, size) in group_sizes.iter().enumerate() {
            let base = GROUP_RELATIONSHIP_GROUP_INFO_OFFSET + i * PROCESSOR_GROUP_INFO_SIZE;
            group[base] = *size;
            group[base + 1] = *size;
        }
        out.extend_from_slice(&group);

        for (efficiency, smt, members) in cores {
            let mut groups: Vec<u16> = members.iter().map(|(g, _)| *g).collect();
            groups.sort_unstable();
            groups.dedup();
            let size =
                PROCESSOR_RELATIONSHIP_GROUP_MASK_OFFSET + groups.len() * GROUP_AFFINITY_SIZE;
            let mut record = vec![0u8; size];
            record[0..4].copy_from_slice(&RELATION_PROCESSOR_CORE.to_le_bytes());
            record[4..8].copy_from_slice(&(size as u32).to_le_bytes());
            record[8] = u8::from(*smt);
            record[9] = *efficiency;
            record[PROCESSOR_RELATIONSHIP_GROUP_COUNT_OFFSET
                ..PROCESSOR_RELATIONSHIP_GROUP_COUNT_OFFSET + 2]
                .copy_from_slice(&(groups.len() as u16).to_le_bytes());
            for (i, group_number) in groups.iter().enumerate() {
                let mut mask = 0u64;
                for (g, bit) in members.iter() {
                    if g == group_number {
                        mask |= 1u64 << bit;
                    }
                }
                let base = PROCESSOR_RELATIONSHIP_GROUP_MASK_OFFSET + i * GROUP_AFFINITY_SIZE;
                record[base..base + 8].copy_from_slice(&mask.to_le_bytes());
                record[base + 8..base + 10].copy_from_slice(&group_number.to_le_bytes());
            }
            out.extend_from_slice(&record);
        }
        out
    }

    #[test]
    fn parses_a_simple_smt_topology() {
        // 2 cores, each with 2 logical processors, single group of 4.
        let buffer = synthetic(
            &[(0, true, &[(0, 0), (0, 1)]), (0, true, &[(0, 2), (0, 3)])],
            &[4],
        );
        let topology = parse_topology(&buffer);
        assert_eq!(topology.logical_processor_count(), 4);
        assert_eq!(topology.cores.len(), 2);
        assert_eq!(topology.package_count, 1);
        assert_eq!(topology.group_count(), 1);
        assert!(!topology.is_hybrid());
        assert_eq!(topology.logical_processors[1].core_id, Some(0));
        assert_eq!(topology.logical_processors[2].core_id, Some(1));
        assert!(topology.cores[0].is_smt);
    }

    #[test]
    fn reports_hybrid_only_when_windows_reports_two_classes() {
        let buffer = synthetic(
            &[
                (1, false, &[(0, 0)]),
                (1, false, &[(0, 1)]),
                (0, false, &[(0, 2)]),
                (0, false, &[(0, 3)]),
            ],
            &[4],
        );
        let topology = parse_topology(&buffer);
        assert!(topology.is_hybrid());
        assert_eq!(topology.efficiency_classes(), vec![0, 1]);
        assert_eq!(topology.logical_processors[0].efficiency_class, Some(1));
        assert_eq!(topology.logical_processors[3].efficiency_class, Some(0));
    }

    #[test]
    fn assigns_flat_indices_across_multiple_groups() {
        // 96 logical processors: group 0 has 64, group 1 has 32.
        let members_g0: Vec<(u16, u8)> = (0..64u8).map(|b| (0u16, b)).collect();
        let members_g1: Vec<(u16, u8)> = (0..32u8).map(|b| (1u16, b)).collect();
        let buffer = synthetic(
            &[(0, false, &members_g0), (0, false, &members_g1)],
            &[64, 32],
        );
        let topology = parse_topology(&buffer);
        assert_eq!(topology.logical_processor_count(), 96);
        assert_eq!(topology.group_count(), 2);
        assert_eq!(topology.flat_index(0, 0), Some(0));
        assert_eq!(topology.flat_index(1, 0), Some(64));
        assert_eq!(topology.flat_index(1, 31), Some(95));
        assert_eq!(topology.flat_index(1, 32), None);
        assert_eq!(topology.flat_index(2, 0), None);
        assert_eq!(topology.logical_processors[95].group, 1);
        assert_eq!(topology.logical_processors[95].number_in_group, 31);
    }

    #[test]
    fn a_truncated_buffer_does_not_panic_or_loop() {
        let buffer = synthetic(&[(0, true, &[(0, 0), (0, 1)])], &[2]);
        for cut in 0..buffer.len() {
            let _ = parse_topology(&buffer[..cut]);
        }
    }

    #[test]
    fn a_zero_sized_record_terminates_the_walk() {
        let mut buffer = vec![0u8; 64];
        buffer[0..4].copy_from_slice(&RELATION_PROCESSOR_CORE.to_le_bytes());
        // Size = 0 would otherwise spin forever.
        buffer[4..8].copy_from_slice(&0u32.to_le_bytes());
        let topology = parse_topology(&buffer);
        assert_eq!(topology.cores.len(), 0);
    }
}
