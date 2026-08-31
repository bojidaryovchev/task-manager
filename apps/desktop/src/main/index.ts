import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { app, BrowserWindow, ipcMain, shell } from 'electron';
import type { CollectorConfig } from '@task-manager/telemetry-types';
import { IpcChannel, type DiagnosticsInfo } from '@shared/ipc';
import type { WidgetSettings } from '@shared/widget.js';
import { CRASH_LIMITS, CrashGuard } from './crash-guard.js';
import { ExportService } from './export-service.js';
import { Logger } from './logger.js';
import { loadNative } from './native.js';
import { Resilience, WINDOWS_RESTART_ARGUMENT } from './resilience.js';
import { SettingsStore } from './settings-store.js';
import { TelemetryService } from './telemetry-service.js';
import { AppTray } from './tray.js';
import { WidgetController } from './widget-controller.js';

/**
 * The main process and preload are bundled as CommonJS.
 *
 * Electron supports ESM in the main process, but CommonJS keeps native addon
 * loading and the preload script on the path with the fewest sharp edges, and
 * nothing here needs ESM-only features.
 */
const directory = __dirname;
const preloadPath = join(directory, '../preload/index.js');

let telemetry: TelemetryService | null = null;
let settings: SettingsStore | null = null;
let widget: WidgetController | null = null;
let tray: AppTray | null = null;
let mainWindow: BrowserWindow | null = null;
let logger: Logger | null = null;
let resilience: Resilience | null = null;
let guard: CrashGuard | null = null;
/** Whether Windows accepted the restart registration, for the diagnostics view. */
let restartRegistered = false;
/** Set on the way out so window close handlers do not fight the quit. */
let quitting = false;

/**
 * Application icon path, or undefined when it cannot be found.
 *
 * A packaged build takes its window and taskbar icon from the executable's own
 * resources; this is for development, where the host is the generic Electron
 * binary, and for the tray, which needs a bitmap either way.
 */
function iconPath(): string | undefined {
  const candidates = [
    join(process.resourcesPath, 'icon.png'),
    join(directory, '../../build/icon.png'),
  ];
  return candidates.find((candidate) => existsSync(candidate));
}

/** Where the history database lives: alongside the other per-user app data. */
function historyPath(): string {
  return join(app.getPath('userData'), 'history.db');
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
    icon: app.isPackaged ? undefined : iconPath(),
    autoHideMenuBar: true,
    webPreferences: {
      preload: preloadPath,
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

  const webContentsId = window.webContents.id;
  resilience?.watchWindow(window, 'main window');
  window.once('ready-to-show', () => window.show());
  // A closed window must not keep a process-list subscription alive.
  window.on('closed', () => {
    telemetry?.releaseWindow(webContentsId);
    mainWindow = null;
  });

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

/** Bring the main window forward, recreating it if it has been closed. */
function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    mainWindow = createMainWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function quit(): void {
  quitting = true;
  app.quit();
}

function registerIpc(service: TelemetryService, controller: WidgetController): void {
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

  ipcMain.handle(IpcChannel.QueryHistory, (_event, from: unknown, to: unknown) =>
    service.queryHistory(typeof from === 'number' ? from : 0, typeof to === 'number' ? to : 0),
  );
  ipcMain.handle(IpcChannel.GetHistoryStatus, () => service.historyStatus);
  ipcMain.handle(IpcChannel.SetHistoryEnabled, (_event, enabled: unknown) => {
    const wanted = enabled === true;
    settings?.setHistoryEnabled(wanted);
    return service.setHistory(historyPath(), wanted);
  });

  const exports = new ExportService();
  ipcMain.handle(IpcChannel.SaveExport, (event, name: unknown, contents: unknown) =>
    // Parented to the window that asked, so the dialog is modal to it rather
    // than floating free of the application.
    exports.saveToFile(name, contents, BrowserWindow.fromWebContents(event.sender)),
  );
  ipcMain.handle(IpcChannel.CopyToClipboard, (_event, text: unknown) => exports.copy(text));

  ipcMain.handle(IpcChannel.GetDiagnostics, (): DiagnosticsInfo => ({
    logDirectory: logger?.directory ?? '',
    logFiles: logger?.listFiles() ?? [],
    crashDumpDirectory: app.getPath('crashDumps'),
    crashes: guard?.listReports() ?? [],
    recentRestarts: guard?.recentRestartCount() ?? 0,
    maxRestarts: CRASH_LIMITS.maxRestarts,
    restartRegistered,
    startedAfterCrash: resilience?.wasRestartedAfterCrash ?? false,
    restartOrigin: resilience?.restartOrigin ?? null,
  }));
  ipcMain.handle(IpcChannel.OpenLogFolder, () => {
    if (logger) void shell.openPath(logger.directory);
  });
  ipcMain.handle(
    IpcChannel.ReportRendererError,
    (_event, message: unknown, stack: unknown, kind: unknown) => {
      // The renderer cannot write to disk, so an error there would otherwise
      // live only in a devtools console nobody has open.
      logger?.error('renderer', `${String(kind)}: ${String(message)}`, String(stack));
    },
  );

  ipcMain.handle(IpcChannel.GetWidgetSettings, () => controller.settings);
  ipcMain.handle(IpcChannel.SetWidgetSettings, (_event, patch: unknown) => {
    // The store normalises whatever arrives, so a renderer cannot write an
    // invalid layout, an out-of-range opacity or an uncollected metric.
    return controller.update((patch ?? {}) as Partial<WidgetSettings>);
  });
  ipcMain.handle(IpcChannel.ReportWidgetContentWidth, (_event, width: unknown) => {
    controller.reportContentWidth(typeof width === 'number' ? width : 0);
  });
  ipcMain.handle(IpcChannel.ShowMainWindow, () => showMainWindow());
  ipcMain.handle(IpcChannel.ShowWidgetMenu, (_event, x: unknown, y: unknown) => {
    controller.popupWidgetMenu(
      typeof x === 'number' ? x : 0,
      typeof y === 'number' ? y : 0,
    );
  });
}

// A second instance should focus the running one rather than start a second
// sampling engine against the same machine.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // Logging and crash handling come first, before any of the work that could
  // fail. A crash during startup is the one most worth having a record of, and
  // the crash reporter has to be started before the app is ready to catch it.
  logger = new Logger();
  guard = new CrashGuard(logger.directory, logger);
  resilience = new Resilience({
    logger,
    guard,
    onBeforeRelaunch: () => telemetry?.stop(),
  });
  resilience.startCrashReporter();
  resilience.install();
  logger.info(
    'app',
    `starting ${app.getVersion()} (electron ${process.versions.electron}, node ${process.versions.node})` +
      (resilience.restartOrigin === 'windows'
        ? ' — restarted by Windows after the process died outright'
        : resilience.restartOrigin === 'self'
          ? ' — relaunched itself after catching a fatal error'
          : ''),
  );
  app.on('second-instance', () => showMainWindow());

  void app.whenReady().then(() => {
    app.setAppUserModelId('dev.taskmanager.app');

    settings = new SettingsStore();
    telemetry = new TelemetryService();

    widget = new WidgetController({
      settings,
      preloadPath,
      onShowMainWindow: showMainWindow,
      onQuit: quit,
      onWidgetClosed: (webContentsId) => telemetry?.releaseWindow(webContentsId),
      onSettingsChanged: () => tray?.refreshMenu(),
      onWindowCreated: (window) => resilience?.watchWindow(window, 'widget'),
    });

    // Ask Windows to bring the application back if it crashes hard enough that
    // nothing in this process survives to do it. Costs nothing while healthy.
    const native = loadNative().module;
    if (native) {
      restartRegistered = native.registerForRestart(WINDOWS_RESTART_ARGUMENT);
      const registered = restartRegistered;
      logger?.info(
        'crash',
        registered
          ? 'registered with the Windows Restart Manager'
          : 'Windows declined the restart registration; the application will not relaunch itself after a hard crash',
      );
    }

    // A collector thread that dies leaves the process healthy and the numbers
    // frozen, so it is reported rather than left to look like a working app.
    telemetry.onCollectorDeath((message) => {
      resilience?.recordCollectorFailure(message);
    });

    registerIpc(telemetry, widget);
    // History before start, so the very first sample is recorded.
    telemetry.setHistory(historyPath(), settings.history.enabled);
    telemetry.start();

    tray = new AppTray({ widget, onShowMainWindow: showMainWindow });
    tray.create(iconPath());
    // The tray tooltip consumes the same snapshots as every other presentation.
    telemetry.subscribe((snapshot) => tray?.update(snapshot));

    mainWindow = createMainWindow();
    widget.restore();

    // Only when explicitly asked on the command line; see resilience.ts.
    resilience?.scheduleCrashTestIfRequested();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) showMainWindow();
    });
  });

  // The widget and tray are meant to outlive the main window: closing the main
  // window while the widget is showing should leave the widget running rather
  // than quit the application out from under it.
  app.on('window-all-closed', () => {
    if (quitting) return;
    if (widget?.settings.enabled) return;
    app.quit();
  });

  // Stop the sampling thread before the process goes away so the native module
  // is not torn down while it is mid-callback, and make sure the last settings
  // change reaches disk.
  app.on('before-quit', () => {
    quitting = true;
    resilience?.beginShutdown();
    // Without this, Windows could bring the application back after a quit it
    // happened to observe as abnormal - a session ending abruptly, say.
    try {
      loadNative().module?.unregisterForRestart();
    } catch (error) {
      logger?.warn('crash', 'could not cancel the restart registration', error);
    }
    telemetry?.stop();
    tray?.destroy();
    settings?.flush();
    logger?.info('app', 'shutting down cleanly');
  });
}
