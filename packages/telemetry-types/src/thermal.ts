/**
 * Temperature models.
 *
 * Windows has no general "CPU temperature" API. Exactly three sources are
 * readable by an unelevated process, and the collector reports those three and
 * nothing else. Because they differ enormously in how much they can be trusted,
 * every reading carries the source that produced it and the name of the sensor
 * that reported it — never a category label like "CPU".
 *
 * What is deliberately absent:
 *
 * - **CPU package temperature.** The only route to a true package sensor is an
 *   MSR read, which needs a kernel-mode driver, an installer and administrator
 *   rights. The nearest available thing is an ACPI thermal zone, which is a real
 *   live sensor whose physical location is defined by the machine's firmware and
 *   documented nowhere. It is reported under its own zone name, and never
 *   relabelled as the CPU's.
 * - **Memory temperature.** Module sensors sit behind the SMBus and no Windows
 *   API exposes them. Nothing is approximated in their place.
 * - **AMD and Intel GPU temperature.** Neither vendor publishes it through a
 *   Windows API or PDH counter set, and their SDKs are not present on an
 *   end-user machine. Those adapters report no temperature.
 */

/**
 * Where a reading came from. This is what says how much the number means.
 *
 * - `nvml` — an NVIDIA GPU's own die sensor, through the library `nvidia-smi`
 *   is built on. The vendor states what it measures.
 * - `storageDevice` — a drive's own sensor, through
 *   `IOCTL_STORAGE_QUERY_PROPERTY`. For NVMe this is the controller's composite
 *   temperature; for SATA, the SMART temperature attribute.
 * - `acpiThermalZone` — a thermal zone declared by the system firmware, through
 *   the `Thermal Zone Information` counter set. A real sensor, but **what it is
 *   attached to is vendor-defined and undocumented.**
 */
export type TemperatureSource = 'acpiThermalZone' | 'nvml' | 'storageDevice';

/** One temperature, with everything needed to say what it actually is. */
export interface TemperatureReading {
  celsius: number;
  source: TemperatureSource;
  /**
   * Exactly what reported it: an ACPI zone name such as `\_TZ.TZ01`, a GPU
   * board name, a drive model. Displayed wherever the reading is, so a value is
   * never shown without its provenance.
   */
  sensor: string;
  /** Where the vendor says throttling begins, when the source publishes it. */
  warningCelsius?: number;
  /** Where the vendor says the device is in danger, when it publishes one. */
  criticalCelsius?: number;
  /**
   * Age of the measurement in milliseconds. Zero for the thermal-zone counters,
   * which are read on every sample; up to a second for GPUs and up to ten for
   * drives, which are polled more slowly because each query is a device
   * round-trip. Carried rather than hidden so a stale value is never presented
   * as instantaneous.
   */
  measuredAgoMs: number;
}

/** One ACPI thermal zone. */
export interface ThermalZoneSnapshot {
  /** The zone's ACPI name as the counter set publishes it, e.g. `\_TZ.TZ01`. */
  instance: string;
  celsius: number;
  /**
   * True when the value came from `High Precision Temperature` (tenths of a
   * Kelvin) rather than `Temperature` (whole Kelvin). Same sensor either way.
   */
  highPrecision: boolean;
}

export interface ThermalSnapshot {
  /**
   * Every zone reporting a physically plausible value, hottest first. Zones
   * that publish nothing — firmware commonly returns 0 K — are excluded rather
   * than shown as −273 °C.
   */
  zones: ThermalZoneSnapshot[];
  /**
   * The hottest zone, as a reading.
   *
   * **This is not a CPU package temperature.** It is presented alongside CPU in
   * the interface because on tested hardware it tracks CPU load closely, but it
   * is always labelled with its own ACPI zone name and never as the CPU's.
   */
  primaryZone?: TemperatureReading;
  /**
   * Every GPU a vendor library reported, whether or not it could be joined to a
   * specific adapter. A GPU that was joined also appears as
   * `GpuAdapterSnapshot.temperature`.
   */
  gpus: TemperatureReading[];
  /** Every drive that reports a temperature, in disk-number order. */
  drives: TemperatureReading[];
  /**
   * True when the `Thermal Zone Information` counter set is absent, which is
   * normal on a machine whose firmware declares no zones.
   */
  zonesUnavailable: boolean;
  /** True when no NVIDIA driver is present. Not an error. */
  nvmlUnavailable: boolean;
}
