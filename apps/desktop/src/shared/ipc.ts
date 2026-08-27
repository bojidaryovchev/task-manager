import type { CollectorConfig, HostInfo, SystemSnapshot } from '@task-manager/telemetry-types';

/**
 * The complete IPC surface. Channels are constants so main and preload cannot
 * drift, and the renderer never sees a channel name at all — it only gets the
 * functions the preload bridge chooses to expose.
 */
export const IpcChannel = {
  /** invoke: () => HostInfo */
  GetHostInfo: 'telemetry:getHostInfo',
  /** invoke: () => SystemSnapshot | null — most recent snapshot, if any */
  GetLatestSnapshot: 'telemetry:getLatestSnapshot',
  /** invoke: () => CollectorConfig */
  GetConfig: 'telemetry:getConfig',
  /** invoke: (patch: Partial<CollectorConfig>) => CollectorConfig */
  SetConfig: 'telemetry:setConfig',
  /** invoke: () => NativeStatus */
  GetNativeStatus: 'telemetry:getNativeStatus',
  /** invoke: (wanted: boolean) => void — this window wants the process list */
  SetProcessSubscription: 'telemetry:setProcessSubscription',
  /** main -> renderer push: SystemSnapshot */
  SnapshotEvent: 'telemetry:snapshot',
} as const;

export type IpcChannelName = (typeof IpcChannel)[keyof typeof IpcChannel];

/** Reported when the native module could not be loaded, so the UI can say so. */
export interface NativeStatus {
  loaded: boolean;
  /** Resolved path of the .node binary, when loaded. */
  modulePath: string | null;
  error: string | null;
  /** True once the sampling loop is running. */
  sampling: boolean;
}

/** The exact object exposed on `window.taskManager`. */
export interface TaskManagerApi {
  getHostInfo(): Promise<HostInfo>;
  getLatestSnapshot(): Promise<SystemSnapshot | null>;
  getConfig(): Promise<CollectorConfig>;
  setConfig(patch: Partial<CollectorConfig>): Promise<CollectorConfig>;
  getNativeStatus(): Promise<NativeStatus>;
  /**
   * Declare whether this window needs the process list in its snapshots.
   *
   * The list is by far the largest part of a snapshot and the most expensive
   * thing to collect. Views that do not show processes should not pay to
   * serialise a thousand objects twice a second, and when no window wants it the
   * collector stops gathering it at all.
   */
  setProcessSubscription(wanted: boolean): Promise<void>;
  /** Subscribe to the canonical snapshot stream. Returns an unsubscribe function. */
  onSnapshot(listener: (snapshot: SystemSnapshot) => void): () => void;
}
