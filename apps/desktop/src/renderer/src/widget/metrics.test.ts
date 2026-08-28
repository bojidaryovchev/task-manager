import type { SystemSnapshot, TemperatureReading } from '@task-manager/telemetry-types';
import { describe, expect, it } from 'vitest';
import { readMetric } from './metrics.js';

/**
 * Which metrics get a temperature, and what that temperature claims to be.
 *
 * This is the guarantee worth testing here. The widget is the surface where a
 * degree reading sits next to a label like "CPU", and the whole risk is that a
 * number ends up next to a label that does not describe what measured it.
 *
 * The CPU rows carry no temperature at all. An elevated read of this machine's
 * ACPI zone found a passive trip point of 124 C and a critical trip point of
 * 125 C with no fan trip points — firmware guarding a CPU die does not sit its
 * limits 25 C above the part's own Tjmax — so the zone is reported as a zone,
 * under its own name, and never as the CPU's temperature.
 */

const ZONE: TemperatureReading = {
  celsius: 94.1,
  source: 'acpiThermalZone',
  sensor: '\\_TZ.TZ01',
  measuredAgoMs: 0,
};

const GPU: TemperatureReading = {
  celsius: 46,
  source: 'nvml',
  sensor: 'NVIDIA GeForce RTX 5090 Laptop GPU',
  warningCelsius: 100,
  criticalCelsius: 103,
  measuredAgoMs: 0,
};

const DRIVE: TemperatureReading = {
  celsius: 49,
  source: 'storageDevice',
  sensor: 'NVMe HFS002TEJ9X125N',
  measuredAgoMs: 4000,
};

/**
 * A snapshot carrying only what these tests read.
 *
 * The full `SystemSnapshot` is large and every field of it is already checked
 * against the native module at compile time by `native-contract.ts`, so a
 * narrow fixture here costs nothing and keeps the tests about the mapping.
 */
function snapshot(thermal: Partial<SystemSnapshot['thermal']> = {}): SystemSnapshot {
  return {
    cpu: {
      aggregateTimeUtilizationPercent: 12,
      processorUtilityPercent: 20,
      busiestLogicalProcessorPercent: 40,
    },
    memory: { physicalUtilizationPercent: 61, usedPhysicalBytes: 8e9, totalPhysicalBytes: 16e9 },
    disks: { unavailable: false, disks: [], total: { readBytesPerSecond: 0, writeBytesPerSecond: 0 } },
    network: { unavailable: false, receivedBytesPerSecond: 0, sentBytesPerSecond: 0 },
    gpu: {
      unavailable: false,
      adapters: [
        {
          luid: '0x0_0x1',
          isSoftware: false,
          utilisationPercent: 30,
          engines: [],
          temperature: GPU,
        },
      ],
    },
    thermal: {
      zones: [],
      gpus: [],
      drives: [],
      zonesUnavailable: false,
      nvmlUnavailable: false,
      ...thermal,
    },
  } as unknown as SystemSnapshot;
}

describe('temperatures beside widget metrics', () => {
  it('never puts a temperature on a CPU metric', () => {
    // The regression this exists to prevent: the ACPI zone used to sit in the
    // CPU row, which read as a CPU temperature to anyone not hovering it.
    const state = snapshot({ primaryZone: ZONE });
    for (const id of ['cpuUtilization', 'cpuUtility', 'cpuBusiest'] as const) {
      expect(readMetric(id, state).temperature).toBeNull();
    }
  });

  it('reports the zone as its own row, named after the zone', () => {
    const metric = readMetric('thermalZone', snapshot({ primaryZone: ZONE }));
    expect(metric.label).toBe('TZ01');
    expect(metric.temperature?.celsius).toBe(94.1);
    // Marked so the reading is not taken at face value.
    expect(metric.temperature?.indirect).toBe(true);
    expect(metric.temperature?.detail).toContain('\\_TZ.TZ01');
    expect(metric.temperature?.detail).toContain('not a CPU temperature');
    // A thermal zone has no utilisation, so the value column says so.
    expect(metric.text).toBe('—');
  });

  it('falls back to a generic label when no zone is reporting', () => {
    const metric = readMetric('thermalZone', snapshot());
    expect(metric.label).toBe('Zone');
    expect(metric.temperature).toBeNull();
  });

  it('shows the GPU die temperature without marking it indirect', () => {
    // NVML says what it measures, so this needs no qualification.
    const temperature = readMetric('gpu', snapshot()).temperature;
    expect(temperature?.celsius).toBe(46);
    expect(temperature?.indirect).toBe(false);
    expect(temperature?.detail).toContain('NVIDIA GeForce RTX 5090 Laptop GPU');
  });

  it('never shows a temperature for memory or network', () => {
    // No Windows API exposes either. An em dash is rendered instead, which says
    // "not measured" rather than implying a reading of zero.
    const state = snapshot({ primaryZone: ZONE, drives: [DRIVE] });
    for (const id of ['memoryPercent', 'memoryUsed', 'networkDown', 'networkUp'] as const) {
      expect(readMetric(id, state).temperature).toBeNull();
    }
  });

  it('shows the hottest drive beside the disk metrics and says so', () => {
    const cooler: TemperatureReading = { ...DRIVE, celsius: 45, sensor: 'NVMe HFS001TFM9X186N' };
    const state = snapshot({ drives: [cooler, DRIVE] });
    const temperature = readMetric('diskRead', state).temperature;
    expect(temperature?.celsius).toBe(49);
    expect(temperature?.detail).toContain('Hottest of 2 drives');
  });

  it('does not claim to be picking the hottest when only one drive reports', () => {
    const temperature = readMetric('diskWrite', snapshot({ drives: [DRIVE] })).temperature;
    expect(temperature?.detail).not.toContain('Hottest of');
  });

  it('has no temperature at all when nothing reports one', () => {
    const state = snapshot();
    expect(readMetric('thermalZone', state).temperature).toBeNull();
    expect(readMetric('diskRead', state).temperature).toBeNull();
  });

  it('marks a reading hot only against a threshold the vendor published', () => {
    const state = snapshot({ primaryZone: { ...ZONE, celsius: 200 } });
    // The ACPI zone comes with no thresholds through this counter set, so there
    // is nothing to be above, however high the number is.
    expect(readMetric('thermalZone', state).temperature?.overThreshold).toBe(false);
    expect(readMetric('gpu', snapshot()).temperature?.overThreshold).toBe(false);
  });

  it('marks a GPU at its vendor throttling threshold as hot', () => {
    const hot = snapshot();
    hot.gpu.adapters[0]!.temperature = { ...GPU, celsius: 100 };
    expect(readMetric('gpu', hot).temperature?.overThreshold).toBe(true);
  });

  it('discloses the age of a reading that was not taken this sample', () => {
    // Drives are polled every ten seconds; presenting that as instantaneous
    // would be a small lie repeated twice a second.
    const temperature = readMetric('diskRead', snapshot({ drives: [DRIVE] })).temperature;
    expect(temperature?.detail).toContain('Measured 4s ago');
  });

  it('reports no temperature before the first snapshot arrives', () => {
    expect(readMetric('thermalZone', null).temperature).toBeNull();
    expect(readMetric('gpu', null).temperature).toBeNull();
  });
});
