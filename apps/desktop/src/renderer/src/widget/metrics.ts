import type { SystemSnapshot } from '@task-manager/telemetry-types';
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
    (a, b) => a.text === b.text && a.fraction === b.fraction,
  );
}
