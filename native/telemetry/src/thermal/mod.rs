//! Temperature telemetry.
//!
//! # What Windows actually exposes, and what it does not
//!
//! There is no general "CPU temperature" API on Windows. Three sources are
//! usable by an unelevated process, and this module reports exactly those three
//! and nothing else:
//!
//! | Source | What it measures | Confidence |
//! |---|---|---|
//! | `Thermal Zone Information` (PDH) | An ACPI thermal zone declared by the system firmware | The zone's identity is vendor-defined |
//! | NVML | An NVIDIA GPU's own die sensor | The vendor states what it is |
//! | `IOCTL_STORAGE_QUERY_PROPERTY` | A drive's SMART/health temperature | The device states what it is |
//!
//! Sources deliberately **not** used, because each would either lie or fail:
//!
//! * `MSAcpi_ThermalZoneTemperature` (WMI `root\WMI`) - the same ACPI data as
//!   the PDH counter set, but access is denied without administrator. The
//!   application ships `asInvoker`, so a sensor needing elevation is a sensor it
//!   cannot use.
//! * `Win32_TemperatureProbe` - part of the SMBIOS class. Publishes no instances
//!   on ordinary hardware; it was checked and returned nothing.
//! * MSR reads (Intel `IA32_THERM_STATUS`, AMD `SMU`) - the only route to a true
//!   CPU package sensor, and it requires a kernel-mode driver. Shipping one
//!   would mean an installer, a signed driver and administrator rights, all of
//!   which are excluded by design.
//! * Memory module temperature - SPD hub sensors are behind the SMBus. No
//!   Windows API exposes them at all, so RAM temperature is reported as
//!   unavailable rather than approximated from anything else.
//!
//! # On the ACPI thermal zone
//!
//! An ACPI thermal zone is a real, live sensor: the firmware declares one or
//! more zones, each with a temperature its `_TMP` method evaluates. What a zone
//! is physically attached to is decided by the machine's firmware and is **not**
//! described by ACPI, Windows or the counter set. A zone named `\_TZ.TZ01` is
//! not documented to be the CPU package, and this module never claims it is.
//!
//! On the development machine the hottest zone tracks CPU load closely - idle
//! 65-80 °C, saturated 102-105 °C within a single 500 ms sample, back down
//! within seconds - which is the behaviour of a die sensor rather than a chassis
//! probe. That is evidence, not documentation, so the value is surfaced under
//! the zone's own ACPI name everywhere it appears, and the UI states what it is.
//!
//! # Cadence
//!
//! The zone counters ride on the engine's shared PDH query and cost nothing
//! extra. NVML and the storage IOCTL are real device round-trips, so each has
//! its own refresh interval and readings carry the age of the measurement
//! rather than pretending to be instantaneous.

use std::collections::HashMap;

use crate::disk::DisksSample;
use crate::gpu::GpuSample;
use crate::win::dxgi::GraphicsAdapter;
use crate::win::nvml::Nvml;
use crate::win::pdh::{CounterId, PdhQuery};
use crate::win::storage::{enumerate_physical_drives, PhysicalDrive};

/// How often NVIDIA GPUs are asked for their temperature.
///
/// A die temperature does move fast, but not usefully faster than this, and each
/// query is a driver round-trip rather than a counter read.
const GPU_REFRESH_MS: f64 = 1000.0;

/// How often drives are asked for their temperature.
///
/// A drive has orders of magnitude more thermal mass than a die, and each query
/// is an IOCTL to the storage device. Twice a second would be pointless traffic.
const STORAGE_REFRESH_MS: f64 = 10_000.0;

/// How often the drive list is rebuilt, so a drive plugged in mid-session
/// appears without restarting the application.
const STORAGE_RESCAN_MS: f64 = 60_000.0;

/// Bounds a thermal-zone reading must fall inside to be reported, in Kelvin.
///
/// Firmware that has no reading commonly publishes 0, and a zone that is not
/// implemented publishes a constant well outside any physical range. Both would
/// otherwise be displayed as a temperature. The window is deliberately wide -
/// -73 °C to +227 °C - because it exists to reject non-readings, not to decide
/// which real temperatures are plausible.
const MIN_ZONE_KELVIN: f64 = 200.0;
const MAX_ZONE_KELVIN: f64 = 500.0;

/// Absolute zero in degrees Celsius, for the Kelvin conversion.
const KELVIN_OFFSET: f64 = 273.15;

/// Where a temperature came from. Carried with every reading, because the source
/// is the thing that says how much the number can be trusted.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TemperatureSource {
    /// An ACPI thermal zone, via the `Thermal Zone Information` counter set.
    /// Physical location is defined by the system firmware.
    AcpiThermalZone,
    /// An NVIDIA GPU's on-die sensor, via NVML.
    Nvml,
    /// A drive's own sensor, via `IOCTL_STORAGE_QUERY_PROPERTY`.
    StorageDevice,
}

impl TemperatureSource {
    /// The wire value. These three strings are the `TemperatureSource` union in
    /// `packages/telemetry-types/src/thermal.ts`, and are repeated in the
    /// `ts_type` attribute on `JsTemperatureReading::source` so the generated
    /// declarations carry the union rather than a bare string. A test below
    /// pins them; `tsc` checks the generated union against the published one.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::AcpiThermalZone => "acpiThermalZone",
            Self::Nvml => "nvml",
            Self::StorageDevice => "storageDevice",
        }
    }
}

/// One temperature reading, with everything needed to say what it is.
#[derive(Debug, Clone)]
pub struct TemperatureReading {
    pub celsius: f64,
    pub source: TemperatureSource,
    /// Exactly what reported it: an ACPI zone name, a GPU board name, a drive
    /// model. Never a category like "CPU".
    pub sensor: String,
    /// Where the vendor says throttling begins, when the source publishes it.
    pub warning_celsius: Option<f64>,
    /// Where the vendor says the device is in danger, when it publishes it.
    pub critical_celsius: Option<f64>,
    /// Milliseconds since the value was actually measured. Zero for the zone
    /// counters, which are read on every sample; up to the refresh interval for
    /// the sources that are polled more slowly.
    pub measured_ago_ms: f64,
}

/// One ACPI thermal zone.
#[derive(Debug, Clone)]
pub struct ThermalZoneSample {
    /// The zone's ACPI name as the counter set publishes it, e.g. `\_tz.tz01`.
    pub instance: String,
    pub celsius: f64,
    /// True when the value came from `High Precision Temperature` (tenths of a
    /// Kelvin) rather than `Temperature` (whole Kelvin).
    pub high_precision: bool,
}

/// One NVIDIA GPU's temperature.
#[derive(Debug, Clone)]
pub struct GpuTemperatureSample {
    /// NVML enumeration index.
    pub index: u32,
    /// Board name from NVML, e.g. "NVIDIA GeForce RTX 4080".
    pub name: String,
    /// PCI ids, for joining to a DXGI adapter.
    pub vendor_id: u32,
    pub device_id: u32,
    pub celsius: f64,
    pub slowdown_celsius: Option<f64>,
    pub shutdown_celsius: Option<f64>,
    pub measured_ago_ms: f64,
}

/// One drive's temperature.
#[derive(Debug, Clone)]
pub struct StorageTemperatureSample {
    /// The `N` in `\\.\PhysicalDriveN`, which also leads the `PhysicalDisk` PDH
    /// instance name, so this joins straight onto a disk.
    pub drive_index: u32,
    /// Drive model, when the device published one.
    pub model: Option<String>,
    pub celsius: f64,
    pub warning_celsius: Option<f64>,
    pub critical_celsius: Option<f64>,
    pub measured_ago_ms: f64,
}

/// Everything temperature-related for one interval.
#[derive(Debug, Clone, Default)]
pub struct ThermalSample {
    /// Every ACPI zone currently reporting a physically plausible value,
    /// hottest first.
    pub zones: Vec<ThermalZoneSample>,
    pub gpus: Vec<GpuTemperatureSample>,
    pub drives: Vec<StorageTemperatureSample>,
    /// True when the `Thermal Zone Information` counter set could not be
    /// registered, which is normal on a machine whose firmware declares no zones.
    pub zones_unavailable: bool,
    /// True when no NVIDIA driver is present. Not an error.
    pub nvml_unavailable: bool,
}

impl ThermalSample {
    /// The hottest reporting zone.
    ///
    /// This is what the UI shows next to CPU, and it is labelled with the zone's
    /// own name there rather than as a CPU temperature. The hottest zone is
    /// chosen because on a machine with several zones the thermally interesting
    /// one is the one nearest a limit.
    pub fn primary_zone(&self) -> Option<&ThermalZoneSample> {
        self.zones.first()
    }
}

/// A polled reading and when it was taken.
struct Cached<T> {
    value: Vec<T>,
    measured_at_ms: f64,
}

impl<T> Default for Cached<T> {
    fn default() -> Self {
        Self {
            value: Vec::new(),
            measured_at_ms: f64::NEG_INFINITY,
        }
    }
}

impl<T> Cached<T> {
    fn is_stale(&self, now_ms: f64, refresh_ms: f64) -> bool {
        now_ms - self.measured_at_ms >= refresh_ms
    }

    fn age_ms(&self, now_ms: f64) -> f64 {
        if self.measured_at_ms.is_finite() {
            (now_ms - self.measured_at_ms).max(0.0)
        } else {
            0.0
        }
    }
}

pub struct ThermalCollector {
    /// `\Thermal Zone Information(*)\Temperature`, in Kelvin.
    zone_temperature: Option<CounterId>,
    /// `\Thermal Zone Information(*)\High Precision Temperature`, in tenths of
    /// a Kelvin. Preferred when present.
    zone_high_precision: Option<CounterId>,
    /// `None` on any machine without an NVIDIA driver.
    nvml: Option<Nvml>,
    gpu_cache: Cached<GpuTemperatureSample>,
    drives: Vec<PhysicalDrive>,
    storage_cache: Cached<StorageTemperatureSample>,
    drives_scanned_at_ms: f64,
}

impl ThermalCollector {
    /// A collector for a machine where PDH itself could not be opened. NVML and
    /// the storage IOCTL do not depend on PDH, so they are still attempted.
    pub fn unavailable() -> Self {
        Self {
            zone_temperature: None,
            zone_high_precision: None,
            nvml: Nvml::load(),
            gpu_cache: Cached::default(),
            drives: enumerate_physical_drives(),
            storage_cache: Cached::default(),
            drives_scanned_at_ms: 0.0,
        }
    }

    pub fn register(query: &mut PdhQuery) -> Self {
        Self {
            zone_temperature: query.add(r"\Thermal Zone Information(*)\Temperature"),
            zone_high_precision: query
                .add(r"\Thermal Zone Information(*)\High Precision Temperature"),
            ..Self::unavailable()
        }
    }

    /// True when the ACPI zone counter set registered on this machine.
    pub fn zones_available(&self) -> bool {
        self.zone_temperature.is_some() || self.zone_high_precision.is_some()
    }

    /// True when an NVIDIA driver is present and NVML enumerated at least one GPU.
    pub fn nvml_available(&self) -> bool {
        self.nvml.is_some()
    }

    /// Physical drives currently open, for diagnostics.
    pub fn drive_count(&self) -> usize {
        self.drives.len()
    }

    /// Collect every temperature source. `monotonic_ms` drives the refresh
    /// intervals, so they cannot be distorted by a wall-clock change.
    pub fn sample(&mut self, query: Option<&PdhQuery>, monotonic_ms: f64) -> ThermalSample {
        let zones = query
            .map(|query| self.sample_zones(query))
            .unwrap_or_default();

        if self.gpu_cache.is_stale(monotonic_ms, GPU_REFRESH_MS) {
            self.gpu_cache = Cached {
                value: self.read_gpu_temperatures(),
                measured_at_ms: monotonic_ms,
            };
        }
        let gpu_age = self.gpu_cache.age_ms(monotonic_ms);

        if monotonic_ms - self.drives_scanned_at_ms >= STORAGE_RESCAN_MS {
            self.drives_scanned_at_ms = monotonic_ms;
            // Only rescan when a drive has appeared or disappeared, so the
            // handles - and the "unsupported" flags learned against them - are
            // not thrown away every minute for nothing.
            let current = enumerate_physical_drives();
            let changed = current.len() != self.drives.len()
                || current
                    .iter()
                    .zip(&self.drives)
                    .any(|(a, b)| a.index() != b.index());
            if changed {
                self.drives = current;
                self.storage_cache = Cached::default();
            }
        }
        if self
            .storage_cache
            .is_stale(monotonic_ms, STORAGE_REFRESH_MS)
        {
            self.storage_cache = Cached {
                value: self.read_storage_temperatures(),
                measured_at_ms: monotonic_ms,
            };
        }
        let storage_age = self.storage_cache.age_ms(monotonic_ms);

        ThermalSample {
            zones_unavailable: !self.zones_available(),
            nvml_unavailable: self.nvml.is_none(),
            zones,
            gpus: self
                .gpu_cache
                .value
                .iter()
                .map(|gpu| GpuTemperatureSample {
                    measured_ago_ms: gpu_age,
                    ..gpu.clone()
                })
                .collect(),
            drives: self
                .storage_cache
                .value
                .iter()
                .map(|drive| StorageTemperatureSample {
                    measured_ago_ms: storage_age,
                    ..drive.clone()
                })
                .collect(),
        }
    }

    /// Read the ACPI zones out of the shared PDH query.
    fn sample_zones(&self, query: &PdhQuery) -> Vec<ThermalZoneSample> {
        // Tenths of a Kelvin, when the machine publishes it.
        let mut precise: HashMap<String, f64> = HashMap::new();
        if let Some(id) = self.zone_high_precision {
            for (instance, value) in query.instances(id) {
                precise.insert(instance, value / 10.0);
            }
        }
        let mut whole: HashMap<String, f64> = HashMap::new();
        if let Some(id) = self.zone_temperature {
            for (instance, value) in query.instances(id) {
                whole.insert(instance, value);
            }
        }

        let mut instances: Vec<String> = precise.keys().chain(whole.keys()).cloned().collect();
        instances.sort();
        instances.dedup();

        let mut zones: Vec<ThermalZoneSample> = instances
            .into_iter()
            .filter_map(|instance| {
                // High precision first: same sensor, finer resolution.
                let (kelvin, high_precision) = match precise.get(&instance) {
                    Some(&value) if in_range(value) => (value, true),
                    _ => (*whole.get(&instance).filter(|v| in_range(**v))?, false),
                };
                Some(ThermalZoneSample {
                    instance,
                    celsius: kelvin - KELVIN_OFFSET,
                    high_precision,
                })
            })
            .collect();
        zones.sort_by(|a, b| b.celsius.total_cmp(&a.celsius));
        zones
    }

    fn read_gpu_temperatures(&self) -> Vec<GpuTemperatureSample> {
        let Some(nvml) = self.nvml.as_ref() else {
            return Vec::new();
        };
        nvml.devices()
            .iter()
            .enumerate()
            .filter_map(|(index, device)| {
                Some(GpuTemperatureSample {
                    index: index as u32,
                    name: device.name.clone(),
                    vendor_id: device.vendor_id,
                    device_id: device.device_id,
                    celsius: nvml.temperature_celsius(device)?,
                    slowdown_celsius: device.slowdown_celsius,
                    shutdown_celsius: device.shutdown_celsius,
                    measured_ago_ms: 0.0,
                })
            })
            .collect()
    }

    fn read_storage_temperatures(&mut self) -> Vec<StorageTemperatureSample> {
        let mut samples = Vec::new();
        for drive in &mut self.drives {
            let model = drive.model().map(str::to_owned);
            let Some(reading) = drive.read_temperature() else {
                continue;
            };
            samples.push(StorageTemperatureSample {
                drive_index: reading.drive_index,
                model,
                celsius: reading.celsius,
                warning_celsius: reading.warning_celsius,
                critical_celsius: reading.critical_celsius,
                measured_ago_ms: 0.0,
            });
        }
        samples
    }
}

impl Default for ThermalCollector {
    fn default() -> Self {
        Self::unavailable()
    }
}

fn in_range(kelvin: f64) -> bool {
    kelvin.is_finite() && (MIN_ZONE_KELVIN..=MAX_ZONE_KELVIN).contains(&kelvin)
}

/// Join NVML readings onto DXGI adapters by PCI vendor and device id.
///
/// Returns a map from `(vendor_id, device_id)` to the reading, containing only
/// pairs that identify exactly one NVML device **and** exactly one adapter. Two
/// identical boards in one machine share a PCI device id, and nothing in either
/// NVML's or DXGI's enumeration order is documented to correspond, so matching
/// them by position would risk showing one card's temperature against the other.
/// Ambiguous pairs are left unmatched; the readings still appear under
/// `ThermalSample::gpus`, named by NVML.
pub fn gpu_temperature_by_pci_id(
    gpus: &[GpuTemperatureSample],
    adapter_pci_ids: &[(u32, u32)],
) -> HashMap<(u32, u32), GpuTemperatureSample> {
    let mut counts: HashMap<(u32, u32), usize> = HashMap::new();
    for gpu in gpus {
        *counts.entry((gpu.vendor_id, gpu.device_id)).or_insert(0) += 1;
    }
    let mut adapter_counts: HashMap<(u32, u32), usize> = HashMap::new();
    for pair in adapter_pci_ids {
        *adapter_counts.entry(*pair).or_insert(0) += 1;
    }

    gpus.iter()
        .filter_map(|gpu| {
            let key = (gpu.vendor_id, gpu.device_id);
            (counts.get(&key) == Some(&1) && adapter_counts.get(&key) == Some(&1))
                .then(|| (key, gpu.clone()))
        })
        .collect()
}

/// Attach GPU die temperatures to the adapters they belong to.
///
/// Only unambiguous matches are made - see `gpu_temperature_by_pci_id`. An
/// adapter left without a temperature is one where nothing could be said for
/// certain, not one that is known to have no sensor; the reading is still listed
/// under `ThermalSample::gpus` under the name NVML gave it.
pub fn attach_to_adapters(
    thermal: &ThermalSample,
    described: &[GraphicsAdapter],
    gpu: &mut GpuSample,
) {
    if thermal.gpus.is_empty() {
        return;
    }
    let pci_ids: Vec<(u32, u32)> = described
        .iter()
        .map(|adapter| (adapter.vendor_id, adapter.device_id))
        .collect();
    let matched = gpu_temperature_by_pci_id(&thermal.gpus, &pci_ids);

    for adapter in &mut gpu.adapters {
        // The counter data identifies an adapter only by LUID, so the DXGI
        // entry is what carries the PCI ids NVML can be joined on.
        let Some(entry) = described
            .iter()
            .find(|candidate| candidate.luid_key() == adapter.luid)
        else {
            continue;
        };
        let Some(reading) = matched.get(&(entry.vendor_id, entry.device_id)) else {
            continue;
        };
        adapter.temperature = Some(TemperatureReading {
            celsius: reading.celsius,
            source: TemperatureSource::Nvml,
            sensor: reading.name.clone(),
            warning_celsius: reading.slowdown_celsius,
            critical_celsius: reading.shutdown_celsius,
            measured_ago_ms: reading.measured_ago_ms,
        });
    }
}

/// Attach drive temperatures to the physical disks they belong to.
///
/// `\.\PhysicalDriveN` and the `PhysicalDisk` counter instance `N C: D:`
/// use the same disk number, so this is an exact join rather than a heuristic.
/// The synthesised `_Total` instance is left alone: it is an aggregate, and
/// there is no such thing as the temperature of an aggregate.
pub fn attach_to_disks(thermal: &ThermalSample, disks: &mut DisksSample) {
    if thermal.drives.is_empty() {
        return;
    }
    for disk in &mut disks.disks {
        let Some(index) = disk.index else { continue };
        let Some(reading) = thermal
            .drives
            .iter()
            .find(|drive| drive.drive_index == index)
        else {
            continue;
        };
        disk.temperature = Some(TemperatureReading {
            celsius: reading.celsius,
            source: TemperatureSource::StorageDevice,
            sensor: reading
                .model
                .clone()
                .unwrap_or_else(|| format!("PhysicalDrive{}", reading.drive_index)),
            warning_celsius: reading.warning_celsius,
            critical_celsius: reading.critical_celsius,
            measured_ago_ms: reading.measured_ago_ms,
        });
    }
}

/// The hottest ACPI zone as a reading, for the presentation layers.
pub fn primary_zone_reading(thermal: &ThermalSample) -> Option<TemperatureReading> {
    let zone = thermal.primary_zone()?;
    Some(TemperatureReading {
        celsius: zone.celsius,
        source: TemperatureSource::AcpiThermalZone,
        sensor: zone.instance.clone(),
        // ACPI publishes trip points through `_CRT`/`_PSV`, which the counter
        // set does not expose. Nothing is invented in their place.
        warning_celsius: None,
        critical_celsius: None,
        measured_ago_ms: 0.0,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn gpu(vendor: u32, device: u32, celsius: f64) -> GpuTemperatureSample {
        GpuTemperatureSample {
            index: 0,
            name: "GPU".into(),
            vendor_id: vendor,
            device_id: device,
            celsius,
            slowdown_celsius: None,
            shutdown_celsius: None,
            measured_ago_ms: 0.0,
        }
    }

    #[test]
    fn the_source_strings_are_the_ones_the_published_union_declares() {
        // Changing any of these silently breaks the TypeScript union unless the
        // ts_type attribute in api.rs and thermal.ts change with them.
        assert_eq!(
            TemperatureSource::AcpiThermalZone.as_str(),
            "acpiThermalZone"
        );
        assert_eq!(TemperatureSource::Nvml.as_str(), "nvml");
        assert_eq!(TemperatureSource::StorageDevice.as_str(), "storageDevice");
    }

    #[test]
    fn accepts_a_plausible_zone_reading() {
        // 364 K is 90.9 C - high, but a real reading seen under load.
        assert!(in_range(364.0));
        assert!(in_range(300.0));
    }

    #[test]
    fn rejects_a_zone_that_publishes_no_reading() {
        // Firmware with nothing to report publishes 0, which would otherwise be
        // displayed as -273 C.
        assert!(!in_range(0.0));
        assert!(!in_range(f64::NAN));
    }

    #[test]
    fn rejects_a_reading_outside_any_physical_range() {
        assert!(!in_range(MIN_ZONE_KELVIN - 1.0));
        assert!(!in_range(MAX_ZONE_KELVIN + 1.0));
    }

    #[test]
    fn matches_a_single_nvidia_gpu_to_its_adapter() {
        let gpus = vec![gpu(0x10de, 0x2b85, 48.0)];
        let matched = gpu_temperature_by_pci_id(&gpus, &[(0x10de, 0x2b85), (0x8086, 0x1234)]);
        assert_eq!(matched.len(), 1);
        assert_eq!(matched[&(0x10de, 0x2b85)].celsius, 48.0);
    }

    #[test]
    fn refuses_to_match_two_identical_boards() {
        // Nothing documents NVML's index order as corresponding to DXGI's, so
        // matching by position could show one card's temperature on the other.
        let gpus = vec![gpu(0x10de, 0x2b85, 48.0), gpu(0x10de, 0x2b85, 71.0)];
        let matched = gpu_temperature_by_pci_id(&gpus, &[(0x10de, 0x2b85), (0x10de, 0x2b85)]);
        assert!(matched.is_empty());
    }

    #[test]
    fn refuses_to_match_when_the_adapter_side_is_ambiguous() {
        let gpus = vec![gpu(0x10de, 0x2b85, 48.0)];
        let matched = gpu_temperature_by_pci_id(&gpus, &[(0x10de, 0x2b85), (0x10de, 0x2b85)]);
        assert!(matched.is_empty());
    }

    #[test]
    fn leaves_an_adapter_with_no_nvml_device_unmatched() {
        let matched = gpu_temperature_by_pci_id(&[], &[(0x1002, 0x744c)]);
        assert!(matched.is_empty());
    }

    #[test]
    fn the_primary_zone_is_the_hottest_one() {
        let sample = ThermalSample {
            zones: vec![
                ThermalZoneSample {
                    instance: r"\_tz.tz01".into(),
                    celsius: 90.0,
                    high_precision: true,
                },
                ThermalZoneSample {
                    instance: r"\_tz.tz00".into(),
                    celsius: 40.0,
                    high_precision: true,
                },
            ],
            ..Default::default()
        };
        assert_eq!(sample.primary_zone().unwrap().instance, r"\_tz.tz01");
    }

    #[test]
    fn there_is_no_primary_zone_when_nothing_reports() {
        assert!(ThermalSample::default().primary_zone().is_none());
    }

    #[test]
    fn a_cache_starts_stale_so_the_first_sample_always_reads() {
        let cache: Cached<u8> = Cached::default();
        assert!(cache.is_stale(0.0, 1000.0));
        // And an absent measurement reports no age rather than infinity.
        assert_eq!(cache.age_ms(0.0), 0.0);
    }

    #[test]
    fn a_cache_is_fresh_until_the_refresh_interval_elapses() {
        let cache = Cached {
            value: vec![1u8],
            measured_at_ms: 1000.0,
        };
        assert!(!cache.is_stale(1500.0, 1000.0));
        assert!(cache.is_stale(2000.0, 1000.0));
        assert_eq!(cache.age_ms(1500.0), 500.0);
    }
}
