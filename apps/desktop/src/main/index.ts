import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { app, BrowserWindow, ipcMain, shell } from 'electron';
import type { CollectorConfig } from '@task-manager/telemetry-types';
import { IpcChannel } from '@shared/ipc';
import { TelemetryService } from './telemetry-service.js';

/**
 * The main process and preload are bundled as CommonJS.
 *
 * Electron supports ESM in the main process, but CommonJS keeps native addon
 * loading and the preload script on the path with the fewest sharp edges, and
 * nothing here needs ESM-only features.
 */
const directory = __dirname;

let telemetry: TelemetryService | null = null;
let mainWindow: BrowserWindow | null = null;

/**
 * Window icon for development runs.
 *
 * A packaged build takes its window and taskbar icon from the executable's own
 * resources, so this is only needed when running from source, where the host is
 * the generic Electron binary.
 */
function developmentIcon(): string | undefined {
  if (app.isPackaged) return undefined;
  const candidate = join(directory, '../../build/icon.png');
  return existsSync(candidate) ? candidate : undefined;
}

function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 940,
    minHeight: 600,
    show: false,
    backgroundColor: '#0b0d10',
    title: 'Task Manager',
    icon: developmentIcon(),
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(directory, '../preload/index.js'),
      // The renderer gets no Node access at all. Everything it can do goes
      // through the small typed surface in the preload bridge.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: false,
      // Telemetry updates must keep flowing while the window is in the
      // background, otherwise history would have gaps whenever it loses focus.
      backgroundThrottling: false,
    },
  });

  window.once('ready-to-show', () => window.show());
  // A closed window must not keep a process-list subscription alive.
  window.on('closed', () => telemetry?.releaseWindow(webContentsId));
  const webContentsId = window.webContents.id;

  // Never let the renderer navigate away or spawn windows; this application has
  // no reason to open anything except an external link in the real browser.
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event) => event.preventDefault());

  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void window.loadFile(join(directory, '../renderer/index.html'));
  }

  return window;
}

function registerIpc(service: TelemetryService): void {
  ipcMain.handle(IpcChannel.GetHostInfo, () => service.hostInfo);
  ipcMain.handle(IpcChannel.GetLatestSnapshot, () => service.latestSnapshot);
  ipcMain.handle(IpcChannel.GetNativeStatus, () => service.nativeStatus);
  ipcMain.handle(IpcChannel.SetProcessSubscription, (event, wanted: unknown) => {
    service.setProcessSubscription(event.sender.id, wanted === true);
  });
  ipcMain.handle(IpcChannel.GetConfig, () => service.getConfig());
  ipcMain.handle(IpcChannel.SetConfig, (_event, patch: Partial<CollectorConfig>) => {
    // Only known keys are forwarded, so a compromised renderer cannot smuggle
    // arbitrary values into the native configuration.
    const safe: Partial<CollectorConfig> = {};
    if (typeof patch?.intervalMs === 'number') safe.intervalMs = patch.intervalMs;
    if (typeof patch?.collectProcesses === 'boolean')
      safe.collectProcesses = patch.collectProcesses;
    if (typeof patch?.collectDebug === 'boolean') safe.collectDebug = patch.collectDebug;
    if (typeof patch?.collectCommandLines === 'boolean')
      safe.collectCommandLines = patch.collectCommandLines;
    return service.setConfig(safe);
  });
}

// A second instance should focus the running one rather than start a second
// sampling engine against the same machine.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  void app.whenReady().then(() => {
    app.setAppUserModelId('dev.taskmanager.app');

    telemetry = new TelemetryService();
    registerIpc(telemetry);
    telemetry.start();

    mainWindow = createMainWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        mainWindow = createMainWindow();
      }
    });
  });

  app.on('window-all-closed', () => {
    app.quit();
  });

  // Stop the sampling thread before the process goes away so the native module
  // is not torn down while it is mid-callback.
  app.on('before-quit', () => {
    telemetry?.stop();
  });
}
