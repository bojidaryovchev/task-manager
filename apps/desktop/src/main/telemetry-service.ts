import { BrowserWindow } from 'electron';
import type {
  CollectorConfig,
  HistoryResult,
  HostInfo,
  SystemSnapshot,
} from '@task-manager/telemetry-types';
import { IpcChannel, type HistoryStatus, type NativeStatus } from '@shared/ipc';
import { loadNative, type NativeEngine } from './native.js';

/**
 * Owns the single native sampling engine and fans its snapshots out to every
 * presentation - the main window, and later the tray and the desktop widget.
 *
 * There is deliberately no calculation here. Anything that looks like a metric
 * has already been computed in Rust, so the tray, the widget and the main window
 * cannot drift apart: they are literally reading the same numbers.
 */
export class TelemetryService {
  #engine: NativeEngine | null = null;
  #latest: SystemSnapshot | null = null;
  #hostInfo: HostInfo | null = null;
  #status: NativeStatus;
  #subscribers = new Set<(snapshot: SystemSnapshot) => void>();
  /**
   * Windows that asked for the process list, by webContents id.
   *
   * The process list is the largest part of a snapshot and the most expensive
   * part to collect. Windows showing only CPU or memory should not pay to
   * receive it, and when nobody wants it the collector stops gathering it.
   */
  #processSubscribers = new Set<number>();
  #historyPath: string | null = null;
  #historyEnabled = false;
  /**
   * Polls the collector for a panic that killed its sampling thread.
   *
   * A thread that dies takes collection with it while leaving the process
   * healthy, so nothing else would ever notice: the UI would keep showing the
   * last snapshot indefinitely. This is the only way to find out, because the
   * callback that would have reported it is the thing that stopped working.
   */
  #watchdog: NodeJS.Timeout | null = null;
  #onCollectorDeath: ((message: string) => void) | null = null;

  constructor() {
    const native = loadNative();
    this.#status = {
      loaded: native.module !== null,
      modulePath: native.modulePath,
      error: native.error,
      sampling: false,
    };
    if (native.module) {
      try {
        this.#hostInfo = native.module.getHostInfo();
        this.#engine = new native.module.TelemetryEngine(defaultConfig());
      } catch (error) {
        this.#status = {
          ...this.#status,
          loaded: false,
          error: `Native module loaded but failed to initialise: ${(error as Error).message}`,
        };
        this.#engine = null;
      }
    }
  }

  /** Called once if the collector thread dies, with the panic message. */
  onCollectorDeath(listener: (message: string) => void): void {
    this.#onCollectorDeath = listener;
  }

  start(): void {
    if (!this.#engine || this.#status.sampling) return;
    this.#engine.start((snapshot) => {
      this.#latest = snapshot;
      this.#broadcast(snapshot);
    });
    this.#status = { ...this.#status, sampling: true };
    this.#startWatchdog();
  }

  stop(): void {
    if (!this.#engine) return;
    this.#stopWatchdog();
    this.#engine.stop();
    this.#status = { ...this.#status, sampling: false };
  }

  #startWatchdog(): void {
    this.#stopWatchdog();
    // Every few seconds is ample: this is checking for a permanent condition,
    // not a transient one, and the check is a single field read.
    this.#watchdog = setInterval(() => {
      const message = this.#engine?.collectorPanic ?? null;
      if (!message) return;
      this.#stopWatchdog();
      this.#status = {
        ...this.#status,
        sampling: false,
        error: `The telemetry collector stopped: ${message}. Values shown are from before it stopped.`,
      };
      this.#onCollectorDeath?.(message);
    }, 5000);
    this.#watchdog.unref?.();
  }

  #stopWatchdog(): void {
    if (!this.#watchdog) return;
    clearInterval(this.#watchdog);
    this.#watchdog = null;
  }

  /**
   * Turn persistent history on or off.
   *
   * History is the only part of the collector that writes to disk, so with it
   * off no database is opened and nothing is written at all.
   */
  setHistory(path: string, enabled: boolean): HistoryStatus {
    this.#historyPath = path;
    this.#historyEnabled = enabled;
    if (enabled) this.#engine?.enableHistory(path);
    else this.#engine?.disableHistory();
    return this.historyStatus;
  }

  get historyStatus(): HistoryStatus {
    return {
      enabled: this.#historyEnabled,
      path: this.#historyPath ?? '',
      tiers: this.#historyEnabled ? (this.#engine?.historyTiers() ?? []) : [],
    };
  }

  queryHistory(fromUnixMs: number, toUnixMs: number): HistoryResult {
    return (
      this.#engine?.queryHistory(fromUnixMs, toUnixMs) ?? {
        points: [],
        tier: 0,
        resolutionMs: 0,
        available: false,
      }
    );
  }

  /**
   * Record whether a window wants the process list, and switch native process
   * collection on or off to match demand.
   */
  setProcessSubscription(webContentsId: number, wanted: boolean): void {
    if (wanted) this.#processSubscribers.add(webContentsId);
    else this.#processSubscribers.delete(webContentsId);
    this.#syncProcessCollection();
  }

  /** Forget a window that has gone away. */
  releaseWindow(webContentsId: number): void {
    if (this.#processSubscribers.delete(webContentsId)) this.#syncProcessCollection();
  }

  #syncProcessCollection(): void {
    const wanted = this.#processSubscribers.size > 0;
    if (this.getConfig().collectProcesses !== wanted) {
      this.setConfig({ collectProcesses: wanted });
    }
  }

  /**
   * Subscribe a non-window consumer, such as the tray. Returns an unsubscribe
   * function; every caller must use it or the closure leaks.
   */
  subscribe(listener: (snapshot: SystemSnapshot) => void): () => void {
    this.#subscribers.add(listener);
    return () => {
      this.#subscribers.delete(listener);
    };
  }

  get latestSnapshot(): SystemSnapshot | null {
    return this.#latest;
  }

  get hostInfo(): HostInfo | null {
    return this.#hostInfo;
  }

  get nativeStatus(): NativeStatus {
    return this.#status;
  }

  getConfig(): CollectorConfig {
    return this.#engine?.getConfig() ?? defaultConfig();
  }

  setConfig(patch: Partial<CollectorConfig>): CollectorConfig {
    const merged = { ...this.getConfig(), ...patch };
    return this.#engine?.setConfig(merged) ?? merged;
  }

  #broadcast(snapshot: SystemSnapshot): void {
    // Built lazily: most of the time no window wants processes, and when one
    // does there is nothing to strip.
    let withoutProcesses: SystemSnapshot | null = null;

    // Send to every live renderer. A window that is closing may already have a
    // destroyed web contents, which would throw.
    for (const window of BrowserWindow.getAllWindows()) {
      if (window.isDestroyed() || window.webContents.isDestroyed()) continue;
      // A minimised or hidden window has nothing to draw. Collection continues
      // regardless - it happens in the native engine - but pushing snapshots
      // into a renderer nobody can see is pure waste for an application that is
      // expected to sit in the background all day. The renderer re-primes from
      // getLatestSnapshot() when it becomes visible again.
      if (!window.isVisible() || window.isMinimized()) continue;
      const id = window.webContents.id;
      let payload = snapshot;
      if (snapshot.processes && !this.#processSubscribers.has(id)) {
        if (withoutProcesses === null) {
          const { processes: _processes, ...rest } = snapshot;
          withoutProcesses = rest;
        }
        payload = withoutProcesses;
      }
      window.webContents.send(IpcChannel.SnapshotEvent, payload);
    }
    for (const listener of this.#subscribers) {
      try {
        listener(snapshot);
      } catch {
        // A misbehaving consumer must not stop the others from updating.
      }
    }
  }
}

function defaultConfig(): CollectorConfig {
  return {
    intervalMs: 500,
    // Off until a window asks for it. Collecting the process list is ~35 ms per
    // sample and serialising it is more; nothing should pay that while only CPU
    // and memory are on screen.
    collectProcesses: false,
    collectDebug: false,
    collectCommandLines: false,
  };
}
