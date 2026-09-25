import { contextBridge, ipcRenderer } from 'electron';
import type { CollectorConfig, SystemSnapshot } from '@task-manager/telemetry-types';
import { IpcChannel, type AppCommand, type TaskManagerApi } from '@shared/ipc';
import type { AppSettingsView } from '@shared/app-settings';
import type { MenuItemSpec } from '@shared/menu';
import type { ProcessMenuRequest } from '@shared/process-actions';
import type { ServiceMenuRequest } from '@shared/services';
import type { StartupItemId } from '@shared/startup';
import type { WidgetSettings } from '@shared/widget';

/**
 * The only bridge between the renderer and the main process.
 *
 * Deliberately a fixed set of functions: the renderer cannot name a channel,
 * cannot invoke an arbitrary channel, and has no access to `ipcRenderer`,
 * `require`, `fs` or `child_process`.
 */
const api: TaskManagerApi = {
  getHostInfo: () => ipcRenderer.invoke(IpcChannel.GetHostInfo),
  getLatestSnapshot: () => ipcRenderer.invoke(IpcChannel.GetLatestSnapshot),
  getConfig: () => ipcRenderer.invoke(IpcChannel.GetConfig),
  setConfig: (patch: Partial<CollectorConfig>) => ipcRenderer.invoke(IpcChannel.SetConfig, patch),
  getNativeStatus: () => ipcRenderer.invoke(IpcChannel.GetNativeStatus),
  setProcessSubscription: (wanted: boolean) =>
    ipcRenderer.invoke(IpcChannel.SetProcessSubscription, wanted === true),
  setServiceSubscription: (wanted: boolean) =>
    ipcRenderer.invoke(IpcChannel.SetServiceSubscription, wanted === true),
  onSnapshot: (listener: (snapshot: SystemSnapshot) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, snapshot: SystemSnapshot): void => {
      listener(snapshot);
    };
    ipcRenderer.on(IpcChannel.SnapshotEvent, handler);
    return () => {
      ipcRenderer.removeListener(IpcChannel.SnapshotEvent, handler);
    };
  },

  onPaused: (listener: (paused: boolean) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, paused: boolean): void => {
      listener(paused === true);
    };
    ipcRenderer.on(IpcChannel.PausedEvent, handler);
    return () => {
      ipcRenderer.removeListener(IpcChannel.PausedEvent, handler);
    };
  },
  getAppSettings: () => ipcRenderer.invoke(IpcChannel.GetAppSettings),
  setAppSettings: (patch: Partial<AppSettingsView>) =>
    ipcRenderer.invoke(IpcChannel.SetAppSettings, patch),
  onAppSettings: (listener: (settings: AppSettingsView) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, settings: AppSettingsView): void => {
      listener(settings);
    };
    ipcRenderer.on(IpcChannel.AppSettingsEvent, handler);
    return () => {
      ipcRenderer.removeListener(IpcChannel.AppSettingsEvent, handler);
    };
  },

  queryHistory: (fromUnixMs: number, toUnixMs: number) =>
    ipcRenderer.invoke(IpcChannel.QueryHistory, fromUnixMs, toUnixMs),
  getHistoryStatus: () => ipcRenderer.invoke(IpcChannel.GetHistoryStatus),
  setHistoryEnabled: (enabled: boolean) =>
    ipcRenderer.invoke(IpcChannel.SetHistoryEnabled, enabled === true),
  clearHistory: () => ipcRenderer.invoke(IpcChannel.ClearHistory),

  saveExport: (suggestedName: string, contents: string) =>
    ipcRenderer.invoke(IpcChannel.SaveExport, String(suggestedName), String(contents)),
  copyToClipboard: (text: string) =>
    ipcRenderer.invoke(IpcChannel.CopyToClipboard, String(text)),

  showProcessMenu: (request: ProcessMenuRequest) =>
    ipcRenderer.invoke(IpcChannel.ShowProcessMenu, request),
  endProcesses: (keys: string[]) => ipcRenderer.invoke(IpcChannel.EndProcesses, keys),
  showServiceMenu: (request: ServiceMenuRequest) =>
    ipcRenderer.invoke(IpcChannel.ShowServiceMenu, request),
  openServicesConsole: () => ipcRenderer.invoke(IpcChannel.OpenServicesConsole),
  getStartupItems: () => ipcRenderer.invoke(IpcChannel.GetStartupItems),
  showStartupMenu: (id: StartupItemId) => ipcRenderer.invoke(IpcChannel.ShowStartupMenu, id),
  setStartupItemEnabled: (id: StartupItemId, enabled: boolean) =>
    ipcRenderer.invoke(IpcChannel.SetStartupItemEnabled, id, enabled === true),
  restartAsAdministrator: () => ipcRenderer.invoke(IpcChannel.RestartAsAdministrator),
  setProcessAffinity: (key: string, processors: number[]) =>
    ipcRenderer.invoke(IpcChannel.SetProcessAffinity, key, processors),
  getProcessColumns: () => ipcRenderer.invoke(IpcChannel.GetProcessColumns),
  showColumnMenu: () => ipcRenderer.invoke(IpcChannel.ShowColumnMenu),
  runNewTask: (command: string, asAdministrator: boolean) =>
    ipcRenderer.invoke(IpcChannel.RunNewTask, String(command), asAdministrator === true),
  browseForProgram: () => ipcRenderer.invoke(IpcChannel.BrowseForProgram),
  showMenu: (items: MenuItemSpec[]) => ipcRenderer.invoke(IpcChannel.ShowMenu, items),
  onAppCommand: (listener: (command: AppCommand) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, command: AppCommand): void => {
      listener(command);
    };
    ipcRenderer.on(IpcChannel.AppCommand, handler);
    return () => {
      ipcRenderer.removeListener(IpcChannel.AppCommand, handler);
    };
  },
  takePendingAppCommand: () => ipcRenderer.invoke(IpcChannel.TakePendingAppCommand),
  onActivity: (listener: (label: string | null) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, label: unknown): void => {
      listener(typeof label === 'string' ? label : null);
    };
    ipcRenderer.on(IpcChannel.ActivityEvent, handler);
    return () => {
      ipcRenderer.removeListener(IpcChannel.ActivityEvent, handler);
    };
  },

  getDiagnostics: () => ipcRenderer.invoke(IpcChannel.GetDiagnostics),
  openLogFolder: () => ipcRenderer.invoke(IpcChannel.OpenLogFolder),
  reportRendererError: (message: string, stack: string, kind: string) =>
    ipcRenderer.invoke(
      IpcChannel.ReportRendererError,
      String(message),
      String(stack),
      String(kind),
    ),

  getWidgetSettings: () => ipcRenderer.invoke(IpcChannel.GetWidgetSettings),
  setWidgetSettings: (patch: Partial<WidgetSettings>) =>
    ipcRenderer.invoke(IpcChannel.SetWidgetSettings, patch),
  showMainWindow: () => ipcRenderer.invoke(IpcChannel.ShowMainWindow),
  showWidgetMenu: (x: number, y: number) =>
    ipcRenderer.invoke(IpcChannel.ShowWidgetMenu, x, y),
  reportWidgetContentWidth: (width: number) =>
    ipcRenderer.invoke(
      IpcChannel.ReportWidgetContentWidth,
      typeof width === 'number' && Number.isFinite(width) ? width : 0,
    ),
  onWidgetSettings: (listener: (settings: WidgetSettings) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, settings: WidgetSettings): void => {
      listener(settings);
    };
    ipcRenderer.on(IpcChannel.WidgetSettingsEvent, handler);
    return () => {
      ipcRenderer.removeListener(IpcChannel.WidgetSettingsEvent, handler);
    };
  },
};

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('taskManager', api);
} else {
  // contextIsolation is always on in this app; this branch exists so a
  // misconfiguration fails loudly rather than silently exposing more.
  throw new Error('contextIsolation must be enabled');
}
