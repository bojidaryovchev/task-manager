import type { CpuSnapshot } from './cpu.js';
import type { DisksSnapshot, GpuSnapshot, NetworkSnapshot } from './devices.js';
import type { MemorySnapshot } from './memory.js';
import type { ProcessesSnapshot } from './process.js';
import type { ThermalSnapshot } from './thermal.js';

/** What the collector gathers on each tick. */
export interface CollectorConfig {
  /** Target sampling interval in milliseconds. Clamped to 100..60000. */
  intervalMs: number;
  /** Collect the process list. The most expensive part of a sample. */
  collectProcesses: boolean;
  /** Populate the `debug` payloads with raw counters and deltas. */
  collectDebug: boolean;
  /** Read per-process command lines. One extra query per new process. */
  collectCommandLines: boolean;
}

/** A non-fatal problem encountered while producing a snapshot. */
export interface CollectorIssue {
  subsystem: string;
  code: string;
  message: string;
}

/** What the snapshot cost to produce, so the monitor can monitor itself. */
export interface CollectionDiagnostics {
  /** Wall time inside the native collector for this snapshot. */
  totalDurationMs: number;
  cpuDurationMs: number;
  memoryDurationMs: number;
  processDurationMs: number;
  /** Disk, network, GPU and temperatures together: one shared PDH query. */
  deviceDurationMs: number;
  issues: CollectorIssue[];
  /** Snapshots dropped because JavaScript could not accept them in time. */
  droppedSnapshots: number;
  /** Process identities currently tracked; should track the live process count. */
  trackedProcessCount: number;
}

export interface SystemSnapshot {
  /** Monotonically increasing, starting at 0. */
  sequence: number;
  /**
   * Wall-clock time when the sample completed. For display and persistence
   * only - it can jump backwards and must never reach a rate calculation.
   */
  wallClockUnixMs: number;
  /** Monotonic milliseconds since collector start. Use this for interval maths. */
  monotonicMs: number;
  /**
   * Measured interval since the previous snapshot, from the monotonic clock.
   * Absent on the first snapshot. Every rate in this snapshot was divided by
   * this value, not by the configured interval.
   */
  intervalMs?: number;
  cpu: CpuSnapshot;
  memory: MemorySnapshot;
  /** Absent when process collection is disabled. */
  processes?: ProcessesSnapshot;
  disks: DisksSnapshot;
  network: NetworkSnapshot;
  gpu: GpuSnapshot;
  thermal: ThermalSnapshot;
  diagnostics: CollectionDiagnostics;
}

/** Static facts about the host, read once at startup. */
export interface HostInfo {
  computerName: string;
  /** Marketing name from the registry, corrected to "Windows 11" by build number. */
  osName?: string;
  /** `major.minor.build`. */
  osVersion: string;
  /** `build.UBR`, the display build. */
  osBuild?: string;
  architecture: string;
  /** True when this process is running elevated. Some process details need it. */
  isElevated: boolean;
  /** True when SeDebugPrivilege has been acquired. Not required by anything yet. */
  hasDebugPrivilege: boolean;
  bootTimeUnixMs?: number;
  nativeModuleVersion: string;
}
