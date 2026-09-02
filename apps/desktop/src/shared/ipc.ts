import type {
  CollectorConfig,
  HistoryResult,
  HistoryTier,
  HostInfo,
  SystemSnapshot,
} from '@task-manager/telemetry-types';
import type { WidgetSettings } from './widget.js';

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

  /** invoke: () => WidgetSettings */
  GetWidgetSettings: 'widget:getSettings',
  /** invoke: (patch: Partial<WidgetSettings>) => WidgetSettings */
  SetWidgetSettings: 'widget:setSettings',
  /** invoke: () => void — open the main window and focus it */
  ShowMainWindow: 'widget:showMainWindow',
  /** invoke: (x, y) => void — show the widget context menu at a screen point */
  ShowWidgetMenu: 'widget:showMenu',
  /** main -> renderer push: WidgetSettings */
  WidgetSettingsEvent: 'widget:settings',
  /** invoke: (width: number) => void - the widget's measured natural width */
  ReportWidgetContentWidth: 'widget:contentWidth',

  /** invoke: (fromUnixMs, toUnixMs) => HistoryResult */
  QueryHistory: 'history:query',
  /** invoke: () => HistoryStatus */
  GetHistoryStatus: 'history:getStatus',
  /** invoke: (enabled: boolean) => HistoryStatus */
  SetHistoryEnabled: 'history:setEnabled',

  /** invoke: (suggestedName, contents) => ExportSaveResult */
  SaveExport: 'export:save',
  /** invoke: (text: string) => boolean */
  CopyToClipboard: 'export:copy',

  /** invoke: () => DiagnosticsInfo */
  GetDiagnostics: 'diagnostics:get',
  /** invoke: () => void — reveal the log folder in Explorer */
  OpenLogFolder: 'diagnostics:openLogFolder',
  /** invoke: (message, stack, kind) => void — a renderer error, for the log */
  ReportRendererError: 'diagnostics:rendererError',
} as const;

export type IpcChannelName = (typeof IpcChannel)[keyof typeof IpcChannel];

/** Where history is stored and whether it is running. */
export interface HistoryStatus {
  enabled: boolean;
  /** Absolute path of the database, so the UI can say where the data lives. */
  path: string;
  /** Rows currently held per retention tier. */
  tiers: HistoryTier[];
}

/**
 * A startup step that failed.
 *
 * Startup is deliberately survivable step by step, so the application can be
 * running and useful while one part of it is broken. These are what it shows
 * instead of pretending everything is fine.
 */
export interface StartupFailure {
  /** The error code, e.g. `TM-1008`. Stable, and looked up in the code list. */
  code: string;
  /** Which step: `settings`, `history`, `tray`, `sampling`, and so on. */
  step: string;
  message: string;
  detail?: string;
}

/** One crash the application recorded. */
export interface CrashRecordInfo {
  /** The error code for this crash, e.g. `TM-7001`. Looked up in the code list. */
  code: string;
  atUnixMs: number;
  /** Which part died: `main`, `renderer`, `gpu`, `utility`, `collector`. */
  source: string;
  reason: string;
  detail?: string;
  uptimeSeconds: number;
  /** True when the main process was going down, rather than a recovered child. */
  fatal: boolean;
  /** True when the application relaunched or reloaded because of this. */
  restarted: boolean;
}

/** Where the logs are and what has gone wrong lately. */
export interface DiagnosticsInfo {
  logDirectory: string;
  logFiles: { name: string; bytes: number }[];
  /** Where Electron writes minidumps for native crashes. */
  crashDumpDirectory: string;
  /** Recent crashes, newest first. */
  crashes: CrashRecordInfo[];
  /** Restarts inside the guard's window; at the limit the app stops relaunching. */
  recentRestarts: number;
  maxRestarts: number;
  /** True when Windows will relaunch the application after a hard crash. */
  restartRegistered: boolean;
  /** True when this instance followed a crash, however it was restarted. */
  startedAfterCrash: boolean;
  /**
   * Who restarted it. `self` means the application caught a fatal error and
   * relaunched; `windows` means the process died outright and the Restart
   * Manager brought it back, which is the more serious of the two.
   */
  restartOrigin: 'self' | 'windows' | null;
  /** Startup steps that failed this session. Empty on a clean start. */
  startupFailures: StartupFailure[];
}

/** What happened to a save-to-file request. */
export interface ExportSaveResult {
  /** False when the user dismissed the save dialog. Not an error. */
  saved: boolean;
  /** Where it was written, when it was. */
  path?: string;
  /** Bytes written. */
  byteLength?: number;
  /** Present only when the write itself failed. */
  error?: string;
}

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

  // --- desktop widget ------------------------------------------------------
  getWidgetSettings(): Promise<WidgetSettings>;
  /** Apply a partial change. Returns the settings as they ended up after validation. */
  setWidgetSettings(patch: Partial<WidgetSettings>): Promise<WidgetSettings>;
  /** Bring the main window to the front, creating it if it was closed. */
  showMainWindow(): Promise<void>;
  /** Open the widget's context menu at a point in screen coordinates. */
  showWidgetMenu(x: number, y: number): Promise<void>;
  /** Subscribe to widget settings changes. Returns an unsubscribe function. */
  onWidgetSettings(listener: (settings: WidgetSettings) => void): () => void;
  /**
   * Report the widget's measured natural content width, in CSS pixels.
   *
   * Only the minimal layout uses this. Its width depends on the labels and
   * values it happens to be showing, and no constant can be right for both
   * "CPU 5%" and "DISK READ 126 KB/s" — one wastes space, the other clips. Main
   * sizes that layout's window to what the renderer measured; the fixed-width
   * layouts ignore it.
   */
  reportWidgetContentWidth(width: number): Promise<void>;

  // --- history -------------------------------------------------------------
  /** Read a window of history. The finest tier covering the span answers it. */
  queryHistory(fromUnixMs: number, toUnixMs: number): Promise<HistoryResult>;
  getHistoryStatus(): Promise<HistoryStatus>;
  /** Turn recording on or off. With it off nothing is written to disk. */
  setHistoryEnabled(enabled: boolean): Promise<HistoryStatus>;

  // --- export --------------------------------------------------------------
  /**
   * Write an export to a file the user chooses.
   *
   * The renderer has no filesystem access, so it hands the finished text to
   * main, which owns the save dialog and the write. Dismissing the dialog
   * returns `saved: false` and is not an error.
   */
  saveExport(suggestedName: string, contents: string): Promise<ExportSaveResult>;
  /** Put text on the system clipboard. Returns false if it could not be set. */
  copyToClipboard(text: string): Promise<boolean>;

  // --- diagnostics ---------------------------------------------------------
  /** Where the logs live and what has crashed recently. */
  getDiagnostics(): Promise<DiagnosticsInfo>;
  /** Reveal the log folder in Explorer. */
  openLogFolder(): Promise<void>;
  /**
   * Report a renderer-side error so it reaches the log file.
   *
   * The renderer has no filesystem, and an error that only ever reached its
   * console is an error nobody will find after the fact.
   */
  reportRendererError(message: string, stack: string, kind: string): Promise<void>;
}
