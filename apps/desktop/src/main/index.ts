import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { release } from 'node:os';
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import type { CollectorConfig } from '@task-manager/telemetry-types';
import { IpcChannel, type DiagnosticsInfo, type StartupFailure } from '@shared/ipc';
import type { ErrorCode } from '@shared/error-codes.js';
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
/** Startup steps that failed, with why, so the interface can show them. */
const startupFailures: StartupFailure[] = [];
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

/**
 * Run one startup step, surviving its failure.
 *
 * Startup used to be a single unguarded sequence with the window created at the
 * end, so a throw anywhere in it - a corrupt settings file, a history database
 * that will not open, a native module misbehaving on an unfamiliar machine -
 * killed the whole application before anything was on screen. The crash handler
 * then relaunched it, the same step failed again, and after a few attempts the
 * loop guard stopped it for good. From the outside that is a spinner and then
 * nothing, permanently, on a machine where most of the application would have
 * worked fine.
 *
 * That also contradicted the rule the rest of the application follows: when a
 * subsystem cannot do its job, say so and carry on rather than showing nothing.
 * Every step is now individually survivable, and the window is created first, so
 * there is always something on screen to carry the explanation.
 */
function step<T>(code: ErrorCode, name: string, run: () => T): T | null {
  try {
    return run();
  } catch (error) {
    logger?.error(code, `${name} failed; continuing without it`, error);
    startupFailures.push({
      code,
      step: name,
      message: error instanceof Error ? error.message : String(error),
      detail: error instanceof Error ? (error.stack ?? '') : '',
    });
    return null;
  }
}

/**
 * Everything worth knowing about a startup that went wrong.
 *
 * Written to be screenshotted and sent to someone else, so it names the
 * application version, the machine and every failed step rather than assuming
 * whoever reads it can run a debugger.
 */
function startupFailureReport(): string {
  const lines = [
    `Task Manager ${app.getVersion()}`,
    `Electron ${process.versions.electron} · Windows ${release()} · ${process.arch}`,
    '',
    `${startupFailures.length} startup step(s) failed:`,
    '',
  ];
  for (const failure of startupFailures) {
    lines.push(`• ${failure.step}: ${failure.message}`);
  }
  lines.push('', `Full log: ${logger?.path ?? '(logging unavailable)'}`);
  return lines.join('\n');
}

/**
 * Show the failure without a renderer.
 *
 * `dialog.showErrorBox` draws a plain Win32 message box, so it works when the
 * window, the GPU process or the whole renderer could not be brought up - the
 * cases where the application would otherwise appear to do nothing at all.
 */
function reportStartupFailureNatively(): void {
  try {
    dialog.showErrorBox('Task Manager could not start properly', startupFailureReport());
  } catch {
    // Nothing left to report with. The log still has it.
  }
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
    startupFailures,
  }));
  ipcMain.handle(IpcChannel.OpenLogFolder, () => {
    if (logger) void shell.openPath(logger.directory);
  });
  ipcMain.handle(
    IpcChannel.ReportRendererError,
    (_event, message: unknown, stack: unknown, kind: unknown) => {
      // The renderer cannot write to disk, so an error there would otherwise
      // live only in a devtools console nobody has open.
      logger?.error(
        String(kind).includes('rejection') ? 'TM-8002' : 'TM-8001',
        `${String(kind)}: ${String(message)}`,
        String(stack),
      );
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
// The log is opened before anything else, including the single-instance check,
// so that every way this process can exit leaves a trace. It previously started
// after that check, which meant the one exit path that produces no window and no
// message also produced no evidence - the symptom being a spinner and then
// nothing at all, with nowhere to look.
logger = new Logger();

if (!app.requestSingleInstanceLock()) {
  // Not an error: a second launch is meant to surface the running window rather
  // than start a second sampling engine. It is logged because from the outside
  // it is indistinguishable from a silent failure to start, and because a stale
  // lock held by a process that is wedged looks exactly the same.
  logger.info(
    'app',
    'another instance already holds the single-instance lock; asking it to show itself and exiting',
  );
  app.quit();
} else {
  // Crash handling comes next, before any of the work that could fail. A crash
  // during startup is the one most worth having a record of, and the crash
  // reporter has to be started before the app is ready to catch it.
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
    step('TM-1001', 'app id', () => app.setAppUserModelId('dev.taskmanager.app'));

    // The window comes first, before anything that can fail. Whatever else goes
    // wrong below, there is something on screen to say so - which is the whole
    // difference between an application that reports a problem and one that
    // appears not to start at all.
    mainWindow = step('TM-1002', 'main window', () => createMainWindow());

    settings = step('TM-1003', 'settings', () => new SettingsStore());
    // The store falls back to defaults rather than refusing to start, so a
    // corrupt or unwritable settings file never reaches the step above as a
    // throw. It reports what it swallowed instead.
    for (const problem of settings?.takeProblems() ?? []) {
      logger?.warn(problem.code, 'settings could not be read or written', problem.message);
      startupFailures.push({
        code: problem.code,
        step: 'settings',
        message: problem.message,
      });
    }
    telemetry = step('TM-1004', 'telemetry service', () => new TelemetryService());

    if (settings) {
      widget = step('TM-1005', 'widget controller', () => new WidgetController({
        settings: settings as SettingsStore,
        preloadPath,
        onShowMainWindow: showMainWindow,
        onQuit: quit,
        onWidgetClosed: (webContentsId) => telemetry?.releaseWindow(webContentsId),
        onSettingsChanged: () => tray?.refreshMenu(),
        onWindowCreated: (window) => resilience?.watchWindow(window, 'widget'),
      }));
    }

    // Ask Windows to bring the application back if it crashes hard enough that
    // nothing in this process survives to do it. Costs nothing while healthy.
    step('TM-1006', 'restart registration', () => {
      const native = loadNative().module;
      if (!native) return;
      restartRegistered = native.registerForRestart(WINDOWS_RESTART_ARGUMENT);
      logger?.info(
        'crash',
        restartRegistered
          ? 'registered with the Windows Restart Manager'
          : 'Windows declined the restart registration; the application will not relaunch itself after a hard crash',
      );
    });

    // A collector thread that dies leaves the process healthy and the numbers
    // frozen, so it is reported rather than left to look like a working app.
    telemetry?.onCollectorDeath((message) => {
      resilience?.recordCollectorFailure(message);
    });

    if (telemetry && widget) {
      step('TM-1007', 'ipc', () => registerIpc(telemetry as TelemetryService, widget as WidgetController));
    }
    // History before start, so the very first sample is recorded. A database
    // that will not open must not stop the application from measuring anything.
    step('TM-1008', 'history', () => telemetry?.setHistory(historyPath(), settings?.history.enabled ?? false));
    step('TM-1009', 'sampling', () => telemetry?.start());

    step('TM-1010', 'tray', () => {
      if (!widget) return;
      tray = new AppTray({ widget, onShowMainWindow: showMainWindow });
      tray.create(iconPath());
      // The tray tooltip consumes the same snapshots as every other presentation.
      telemetry?.subscribe((snapshot) => tray?.update(snapshot));
    });

    step('TM-1011', 'widget restore', () => widget?.restore());

    if (startupFailures.length > 0) {
      logger?.warn(
        'TM-1012',
        `started with ${startupFailures.length} failed step(s): ${startupFailures.map((f) => f.step).join(', ')}`,
      );
      // When the window itself could not be created there is no interface to
      // carry the message, and a native message box is the only thing left that
      // can. It needs no renderer, no GPU and no window, which is exactly the
      // situation it exists for - and it can be screenshotted and sent on.
      if (!mainWindow) reportStartupFailureNatively();
    } else {
      logger?.info('startup', 'all startup steps completed');
    }

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
      logger?.warn('TM-1006', 'could not cancel the restart registration', error);
    }
    telemetry?.stop();
    tray?.destroy();
    settings?.flush();
    for (const problem of settings?.takeProblems() ?? []) {
      logger?.warn(problem.code, 'settings could not be saved on the way out', problem.message);
    }
    logger?.info('app', 'shutting down cleanly');
  });
}
