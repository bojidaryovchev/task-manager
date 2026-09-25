import type { SystemSnapshot } from '@task-manager/telemetry-types';
import { describe, expect, it } from 'vitest';
import { TelemetryStore } from './telemetry-store.js';

/**
 * The live charts are one point per sample. The same sample can reach the
 * page twice - fetched again when the window comes back into view, or re-sent
 * frozen while updates are paused - and must not draw twice.
 */
function snapshot(sequence: number, cpu: number): SystemSnapshot {
  return {
    sequence,
    cpu: {
      aggregateTimeUtilizationPercent: cpu,
      processorUtilityPercent: cpu,
      busiestLogicalProcessorPercent: cpu,
      perLogicalProcessor: [],
    },
    memory: { physicalUtilizationPercent: 50, usedPhysicalBytes: 1, committedBytes: 1 },
    disks: { total: undefined },
    network: { unavailable: true },
    gpu: { adapters: [] },
  } as unknown as SystemSnapshot;
}

describe('the telemetry store', () => {
  it('adds one chart point per sample, however often the sample arrives', () => {
    const store = new TelemetryStore();
    store.ingest(snapshot(1, 10));
    store.ingest(snapshot(1, 10));
    store.ingest(snapshot(2, 20));
    expect(store.system.get('cpuTimeUtilization').length).toBe(2);
  });

  it('still takes the values of a repeated sample', () => {
    const store = new TelemetryStore();
    store.ingest(snapshot(1, 10));
    const again = snapshot(1, 10);
    store.ingest(again);
    expect(store.snapshot).toBe(again);
  });

  it('knows when updates are paused', () => {
    const store = new TelemetryStore();
    expect(store.paused).toBe(false);
    store.setPaused(true);
    expect(store.paused).toBe(true);
  });
});
