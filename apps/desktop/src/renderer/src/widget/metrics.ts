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
   * True when the sensor is not the thing the metric's label names.
   *
   * Only the ACPI thermal zone shown beside CPU is indirect: it is a real live
   * sensor, but what it is attached to is defined by the machine's firmware and
   * documented nowhere, so it is not a CPU package reading. Rendered with a
   * dotted underline to mark it as such.
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
 * The ACPI zone shown beside the CPU metrics.
 *
 * This is not a CPU package temperature and is never labelled as one. Windows
 * exposes no CPU package sensor to an unelevated process — that needs an MSR
 * read through a kernel-mode driver — so the honest best is the firmware's own
 * thermal zone, shown under its own name.
 */
function zoneTemperature(snapshot: SystemSnapshot): WidgetTemperature | null {
  return toWidgetTemperature(snapshot.thermal.primaryZone, {
    indirect: true,
    note: 'A thermal zone declared by this machine’s firmware. What it is attached to is vendor-defined, so this is not a CPU package reading.',
  });
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
    case 'cpuUtilization':
    case 'cpuUtility':
    case 'cpuBusiest':
      return zoneTemperature(snapshot);
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
    label: descriptor?.label ?? id,
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
