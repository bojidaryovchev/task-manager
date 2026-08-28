import type { SystemSnapshot, TemperatureReading } from '@task-manager/telemetry-types';
import {
  formatBitsPerSecond,
  formatBytes,
  formatBytesPerSecond,
  formatPercent,
} from '@task-manager/shared';
import { WIDGET_METRICS, type WidgetMetricId } from '@shared/widget';
import { useTelemetry } from '../lib/hooks.js';

/**
 * Reading a widget metric out of a snapshot.
 *
 * Formatting only. Every value here was already computed and normalised by the
 * native collector; nothing in this file divides one counter by another.
 */

/**
 * A temperature shown beside a metric.
 *
 * `detail` is the whole provenance — source, sensor name and, where the sensor
 * does not directly name the thing in the metric's label, a statement of what it
 * actually is. It is shown as the tooltip, so a number is never on screen
 * without a way to find out what produced it.
 */
export interface WidgetTemperature {
  celsius: number;
  detail: string;
  /**
   * True when the sensor's own identity does not say what it is measuring.
   *
   * Only the ACPI thermal zone is indirect: it is a real live sensor, but ACPI
   * records no physical attachment for a zone, so all that can honestly be said
   * is which zone reported it. Rendered with a dotted underline to mark it as
   * a reading that needs its tooltip read.
   */
  indirect: boolean;
  /** True when the reading is at or above a threshold the *vendor* published. */
  overThreshold: boolean;
}

export interface WidgetMetricValue {
  label: string;
  definition: string;
  /** Formatted for display, or an em dash when the value was not measured. */
  text: string;
  /**
   * 0..1 for a bar or graph, or null when the metric has no natural full scale
   * (a byte rate has no ceiling) or was not measured.
   */
  fraction: number | null;
  accent: string;
  /**
   * The temperature to show between the label and the value, or null when no
   * sensor exists for this metric. Null is rendered as an em dash — the same
   * convention the rest of the application uses for "not measured" — rather
   * than as a zero or an omitted column.
   */
  temperature: WidgetTemperature | null;
}

const ACCENTS: Partial<Record<WidgetMetricId, string>> = {
  cpuUtilization: 'var(--color-cpu)',
  cpuUtility: 'var(--color-warn)',
  cpuBusiest: 'var(--color-cpu)',
  memoryPercent: 'var(--color-memory)',
  memoryUsed: 'var(--color-memory)',
  gpu: 'var(--color-gpu)',
  vram: 'var(--color-gpu)',
  diskRead: 'var(--color-disk)',
  diskWrite: 'var(--color-network)',
  networkDown: 'var(--color-network)',
  networkUp: 'var(--color-disk)',
  // Deliberately the muted text colour rather than a subsystem accent: a zone
  // is not one of the machine's subsystems and should not read as one.
  thermalZone: 'var(--color-text-secondary)',
};

/** The busiest hardware adapter, which is what a single GPU number means here. */
function busiestAdapter(snapshot: SystemSnapshot) {
  return snapshot.gpu.adapters
    .filter((adapter) => !adapter.isSoftware)
    .reduce<SystemSnapshot['gpu']['adapters'][number] | null>(
      (best, adapter) =>
        (adapter.utilisationPercent ?? -1) > (best?.utilisationPercent ?? -1) ? adapter : best,
      null,
    );
}

const DESCRIPTORS = new Map(WIDGET_METRICS.map((metric) => [metric.id, metric]));

/** Human wording for each source, used in the tooltip. */
const SOURCE_LABELS: Record<TemperatureReading['source'], string> = {
  acpiThermalZone: 'ACPI thermal zone',
  nvml: 'NVIDIA NVML',
  storageDevice: 'drive sensor',
};

/** Turn a reading into what the widget shows, tooltip and all. */
function toWidgetTemperature(
  reading: TemperatureReading | undefined,
  options: { indirect?: boolean; note?: string } = {},
): WidgetTemperature | null {
  if (!reading) return null;
  const threshold = reading.warningCelsius ?? reading.criticalCelsius;
  const parts = [
    `${reading.celsius.toFixed(1)} °C`,
    `${SOURCE_LABELS[reading.source]} — ${reading.sensor}`,
  ];
  if (options.note) parts.push(options.note);
  if (reading.warningCelsius !== undefined) {
    parts.push(`Vendor throttling threshold: ${reading.warningCelsius} °C`);
  }
  if (reading.criticalCelsius !== undefined) {
    parts.push(`Vendor critical threshold: ${reading.criticalCelsius} °C`);
  }
  // A value polled a moment ago should not be presented as instantaneous.
  if (reading.measuredAgoMs >= 1000) {
    parts.push(`Measured ${Math.round(reading.measuredAgoMs / 1000)}s ago`);
  }
  return {
    celsius: reading.celsius,
    detail: parts.join('\n'),
    indirect: options.indirect === true,
    // Only ever true against a threshold the vendor published. Nothing here
    // invents a "hot" level for a sensor that came with no thresholds.
    overThreshold: threshold !== undefined && reading.celsius >= threshold,
  };
}

/**
 * The ACPI thermal zone, shown as its own row under its own name.
 *
 * It deliberately does **not** sit beside CPU. It is a real, live sensor — a
 * read of it through WMI agrees with the performance counter to within a degree
 * — but ACPI does not say what a zone is attached to, and an elevated read of
 * this machine's zone found a passive trip point of 124 °C and a critical trip
 * point of 125 °C, with no fan trip points at all. Firmware guarding a CPU die
 * does not sit its limits 25 °C above the part's own Tjmax. So the zone is
 * reported as a zone, and the CPU rows carry no temperature at all, because
 * Windows exposes no CPU package sensor to an unelevated process.
 */
function zoneTemperature(snapshot: SystemSnapshot): WidgetTemperature | null {
  return toWidgetTemperature(snapshot.thermal.primaryZone, {
    indirect: true,
    note: 'An ACPI thermal zone declared by this machine’s firmware. ACPI does not record what a zone is attached to, and this one’s critical trip point is far above any CPU limit, so it is not a CPU temperature.',
  });
}

/** `\_TZ.TZ01` reads better as `TZ01` in a row that is 74 pixels wide. */
function zoneLabel(snapshot: SystemSnapshot | null): string | null {
  const sensor = snapshot?.thermal.primaryZone?.sensor;
  if (!sensor) return null;
  const leaf = sensor.split('.').pop() ?? sensor;
  return leaf.replace(/^\\+/, '').toUpperCase();
}

/** The hottest drive, for the disk metrics, which are themselves aggregates. */
function hottestDrive(snapshot: SystemSnapshot): WidgetTemperature | null {
  const hottest = snapshot.thermal.drives.reduce<TemperatureReading | undefined>(
    (best, drive) => (best === undefined || drive.celsius > best.celsius ? drive : best),
    undefined,
  );
  return toWidgetTemperature(hottest, {
    note:
      snapshot.thermal.drives.length > 1
        ? `Hottest of ${snapshot.thermal.drives.length} drives reporting a temperature.`
        : undefined,
  });
}

/**
 * The temperature belonging to a metric, or null when nothing measures it.
 *
 * The mapping is deliberately conservative. Memory and network get nothing
 * because nothing on Windows measures them: SPD module sensors sit behind the
 * SMBus with no API in front of them, and a network adapter publishes no
 * temperature at all. Returning null there — rendered as an em dash — says
 * "not measured", which is true, where any number would not be.
 */
function temperatureFor(
  id: WidgetMetricId,
  snapshot: SystemSnapshot,
): WidgetTemperature | null {
  switch (id) {
    case 'thermalZone':
      return zoneTemperature(snapshot);
    // The CPU rows carry no temperature. There is no CPU package sensor
    // available without a kernel-mode driver, and the ACPI zone is not one —
    // putting it here would have implied otherwise, which is why it moved out.
    case 'cpuUtilization':
    case 'cpuUtility':
    case 'cpuBusiest':
      return null;
    case 'gpu':
    case 'vram':
      // The adapter's own sensor, joined on by the collector. Absent for every
      // non-NVIDIA adapter, since neither AMD nor Intel publishes one.
      return toWidgetTemperature(busiestAdapter(snapshot)?.temperature);
    case 'diskRead':
    case 'diskWrite':
      return hottestDrive(snapshot);
    case 'memoryPercent':
    case 'memoryUsed':
    case 'networkDown':
    case 'networkUp':
      return null;
  }
}

/** Pull one metric out of a snapshot. Pure, so it is trivially testable. */
export function readMetric(
  id: WidgetMetricId,
  snapshot: SystemSnapshot | null,
): WidgetMetricValue {
  const descriptor = DESCRIPTORS.get(id);
  const base = {
    // The zone row is named after the sensor itself, so the widget never shows
    // a temperature under a label that does not describe what measured it.
    label: (id === 'thermalZone' ? zoneLabel(snapshot) : null) ?? descriptor?.label ?? id,
    definition: descriptor?.definition ?? '',
    accent: ACCENTS[id] ?? 'var(--color-accent)',
    temperature: snapshot ? temperatureFor(id, snapshot) : null,
  };

  if (!snapshot) return { ...base, text: '—', fraction: null };

  switch (id) {
    case 'cpuUtilization': {
      const value = snapshot.cpu.aggregateTimeUtilizationPercent;
      return { ...base, text: formatPercent(value, 0), fraction: toFraction(value) };
    }
    case 'cpuUtility': {
      const value = snapshot.cpu.processorUtilityPercent;
      // Utility legitimately exceeds 100 on a boosting CPU; the bar clamps but
      // the text does not, so the real number is never hidden.
      return { ...base, text: formatPercent(value, 0), fraction: toFraction(value) };
    }
    case 'cpuBusiest': {
      const value = snapshot.cpu.busiestLogicalProcessorPercent;
      return { ...base, text: formatPercent(value, 0), fraction: toFraction(value) };
    }
    case 'memoryPercent': {
      const value = snapshot.memory.physicalUtilizationPercent;
      return { ...base, text: formatPercent(value, 0), fraction: toFraction(value) };
    }
    case 'memoryUsed': {
      const used = snapshot.memory.usedPhysicalBytes;
      const total = snapshot.memory.totalPhysicalBytes;
      return {
        ...base,
        text: formatBytes(used),
        fraction: total > 0 ? clamp(used / total) : null,
      };
    }
    case 'gpu': {
      const adapter = busiestAdapter(snapshot);
      return {
        ...base,
        text: formatPercent(adapter?.utilisationPercent, 0),
        fraction: toFraction(adapter?.utilisationPercent),
      };
    }
    case 'vram': {
      const adapter = busiestAdapter(snapshot);
      const used = adapter?.dedicatedMemoryUsedBytes;
      const total = adapter?.dedicatedMemoryTotalBytes;
      return {
        ...base,
        text: formatBytes(used),
        fraction: used !== undefined && total ? clamp(used / total) : null,
      };
    }
    // Byte rates have no ceiling, so they carry a value and no bar rather than
    // a bar against an invented maximum.
    case 'diskRead':
      return {
        ...base,
        text: snapshot.disks.unavailable
          ? 'n/a'
          : formatBytesPerSecond(snapshot.disks.total?.readBytesPerSecond),
        fraction: null,
      };
    case 'diskWrite':
      return {
        ...base,
        text: snapshot.disks.unavailable
          ? 'n/a'
          : formatBytesPerSecond(snapshot.disks.total?.writeBytesPerSecond),
        fraction: null,
      };
    case 'networkDown':
      return {
        ...base,
        text: snapshot.network.unavailable
          ? 'n/a'
          : formatBitsPerSecond(snapshot.network.receivedBytesPerSecond),
        fraction: null,
      };
    case 'networkUp':
      return {
        ...base,
        text: snapshot.network.unavailable
          ? 'n/a'
          : formatBitsPerSecond(snapshot.network.sentBytesPerSecond),
        fraction: null,
      };
    case 'thermalZone':
      // The temperature is the whole of this row, and it is rendered in the
      // temperature column. A thermal zone has no utilisation, so the value
      // column carries the same em dash used everywhere for "not applicable"
      // rather than a number invented to fill it.
      return { ...base, text: '—', fraction: null };
  }
}

function toFraction(percent: number | undefined): number | null {
  if (percent === undefined || !Number.isFinite(percent)) return null;
  return clamp(percent / 100);
}

function clamp(value: number): number {
  return Math.min(Math.max(value, 0), 1);
}

/**
 * Subscribe to a single metric.
 *
 * Each tile subscribes to its own value, so a snapshot re-renders a handful of
 * small leaves rather than the whole widget.
 */
export function useWidgetMetric(id: WidgetMetricId): WidgetMetricValue {
  return useTelemetry(
    (snapshot) => readMetric(id, snapshot),
    // The temperature has to take part in this comparison: without it a row
    // whose value has not changed would keep rendering a stale degree reading.
    (a, b) =>
      a.text === b.text &&
      a.fraction === b.fraction &&
      a.temperature?.celsius === b.temperature?.celsius &&
      a.temperature?.overThreshold === b.temperature?.overThreshold,
  );
}
