import { contextBridge, ipcRenderer } from 'electron';
import type { CollectorConfig, SystemSnapshot } from '@task-manager/telemetry-types';
import { IpcChannel, type TaskManagerApi } from '@shared/ipc';
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
  onSnapshot: (listener: (snapshot: SystemSnapshot) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, snapshot: SystemSnapshot): void => {
      listener(snapshot);
    };
    ipcRenderer.on(IpcChannel.SnapshotEvent, handler);
    return () => {
      ipcRenderer.removeListener(IpcChannel.SnapshotEvent, handler);
    };
  },

  getWidgetSettings: () => ipcRenderer.invoke(IpcChannel.GetWidgetSettings),
  setWidgetSettings: (patch: Partial<WidgetSettings>) =>
    ipcRenderer.invoke(IpcChannel.SetWidgetSettings, patch),
  showMainWindow: () => ipcRenderer.invoke(IpcChannel.ShowMainWindow),
  showWidgetMenu: (x: number, y: number) =>
    ipcRenderer.invoke(IpcChannel.ShowWidgetMenu, x, y),
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
