import type {
  CollectorConfig,
  HostInfo,
  SystemSnapshot,
} from '@task-manager/telemetry-types';
import { RingBuffer, SeriesSet } from '@task-manager/shared';
import type { NativeStatus } from '@shared/ipc';

/**
 * Live samples retained for the in-window charts.
 *
 * 600 samples at the default 500 ms interval is five minutes. This is a display
 * buffer, not the history engine: it is bounded, in memory, and lost on reload.
 */
export const LIVE_HISTORY_SAMPLES = 600;

export type SystemSeriesName =
  | 'cpuTimeUtilization'
  | 'cpuProcessorUtility'
  | 'cpuBusiest'
  | 'memoryPercent'
  | 'memoryUsedBytes'
  | 'memoryCommittedBytes';

/**
 * The renderer's single source of truth for telemetry.
 *
 * Deliberately outside React. A snapshot arrives every 500 ms and most of it is
 * irrelevant to most components; pushing it through React state would re-render
 * the whole tree twice a second. Components subscribe to the slice they need
 * through `useTelemetry`, and React bails out when that slice is unchanged.
 */
export class TelemetryStore {
  #snapshot: SystemSnapshot | null = null;
  #hostInfo: HostInfo | null = null;
  #status: NativeStatus | null = null;
  #config: CollectorConfig | null = null;
  #listeners = new Set<() => void>();
  #version = 0;

  /** System-wide series, advanced once per snapshot. */
  readonly system = new SeriesSet<SystemSeriesName>(
    [
      'cpuTimeUtilization',
      'cpuProcessorUtility',
      'cpuBusiest',
      'memoryPercent',
      'memoryUsedBytes',
      'memoryCommittedBytes',
    ],
    LIVE_HISTORY_SAMPLES,
  );

  /**
   * Per-logical-processor utilization series, created on first sight so the
   * buffers match the machine rather than a guessed maximum.
   */
  readonly perProcessor = new Map<number, RingBuffer>();

  get snapshot(): SystemSnapshot | null {
    return this.#snapshot;
  }

  get hostInfo(): HostInfo | null {
    return this.#hostInfo;
  }

  get nativeStatus(): NativeStatus | null {
    return this.#status;
  }

  get config(): CollectorConfig | null {
    return this.#config;
  }

  /** Increments on every change; charts use it to know when to redraw. */
  get version(): number {
    return this.#version;
  }

  setHostInfo(info: HostInfo | null): void {
    this.#hostInfo = info;
    this.#emit();
  }

  setNativeStatus(status: NativeStatus | null): void {
    this.#status = status;
    this.#emit();
  }

  setConfig(config: CollectorConfig | null): void {
    this.#config = config;
    this.#emit();
  }

  ingest(snapshot: SystemSnapshot): void {
    this.#snapshot = snapshot;
    this.system.push({
      cpuTimeUtilization: snapshot.cpu.aggregateTimeUtilizationPercent,
      cpuProcessorUtility: snapshot.cpu.processorUtilityPercent,
      cpuBusiest: snapshot.cpu.busiestLogicalProcessorPercent,
      memoryPercent: snapshot.memory.physicalUtilizationPercent,
      memoryUsedBytes: snapshot.memory.usedPhysicalBytes,
      memoryCommittedBytes: snapshot.memory.committedBytes,
    });
    for (const processor of snapshot.cpu.perLogicalProcessor) {
      let series = this.perProcessor.get(processor.index);
      if (!series) {
        series = new RingBuffer(LIVE_HISTORY_SAMPLES);
        this.perProcessor.set(processor.index, series);
      }
      series.push(processor.timeUtilizationPercent);
    }
    this.#emit();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  #emit(): void {
    this.#version += 1;
    for (const listener of this.#listeners) listener();
  }
}

export const telemetryStore = new TelemetryStore();
