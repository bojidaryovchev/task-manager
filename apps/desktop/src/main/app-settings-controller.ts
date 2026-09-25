import { app, BrowserWindow, type MenuItemConstructorOptions } from 'electron';
import {
  speedForInterval,
  UPDATE_INTERVALS_MS,
  UPDATE_SPEED_LABELS,
  type AppSettingsView,
  type UpdateSpeed,
} from '@shared/app-settings.js';
import { IpcChannel } from '@shared/ipc';
import type { Logger } from './logger.js';
import type { SettingsStore } from './settings-store.js';
import type { TelemetryService } from './telemetry-service.js';
import type { AppTray } from './tray.js';

/**
 * Passed when Windows starts the application at sign-in, so it opens straight
 * into the tray rather than putting a window in front of whatever the user is
 * doing.
 */
export const START_HIDDEN_ARGUMENT = '--hidden';

export interface AppSettingsHost {
  settings: SettingsStore;
  telemetry(): TelemetryService | null;
  mainWindow(): BrowserWindow | null;
  tray(): AppTray | null;
  logger: Logger | null;
}

/**
 * The application's settings, whichever of the Settings page, the tray menu
 * or startup touches them. Each change is saved, applied where it takes
 * effect, and announced to every window and the tray, so no two places can
 * disagree about what is set.
 */
export class AppSettingsController {
  #host: AppSettingsHost;

  constructor(host: AppSettingsHost) {
    this.#host = host;
  }

  get(): AppSettingsView {
    const { settings } = this.#host;
    return {
      updateSpeed: speedForInterval(settings.sampling.intervalMs),
      paused: this.#host.telemetry()?.paused ?? false,
      alwaysOnTop: settings.window.alwaysOnTop,
      startWithWindows: this.#startsWithWindows(),
      confirmEnd: settings.processes.confirmEnd,
      liveTrayIcon: settings.tray.liveIcon,
      closeToTray: settings.tray.closeToTray,
      hideWhenMinimized: settings.tray.hideWhenMinimized,
    };
  }

  /** Apply what was saved, once at startup. */
  applyOnStartup(): void {
    this.#host.telemetry()?.setConfig({ intervalMs: this.#host.settings.sampling.intervalMs });
  }

  /** Apply a validated change and announce the result. */
  update(patch: Partial<AppSettingsView>): AppSettingsView {
    const { settings, logger } = this.#host;
    const telemetry = this.#host.telemetry();
    const tray = this.#host.tray();

    if (patch.updateSpeed !== undefined) {
      const intervalMs = UPDATE_INTERVALS_MS[patch.updateSpeed];
      settings.updateSampling({ intervalMs });
      telemetry?.setConfig({ intervalMs });
    }
    if (patch.paused !== undefined && telemetry) {
      telemetry.setPaused(patch.paused);
      tray?.setPaused(patch.paused);
      logger?.info('app', patch.paused ? 'updates paused' : 'updates resumed');
    }
    if (patch.alwaysOnTop !== undefined) {
      settings.updateWindow({ alwaysOnTop: patch.alwaysOnTop });
      this.#host.mainWindow()?.setAlwaysOnTop(patch.alwaysOnTop);
    }
    if (typeof patch.startWithWindows === 'boolean') this.#setStartsWithWindows(patch.startWithWindows);
    if (patch.confirmEnd !== undefined) settings.updateProcesses({ confirmEnd: patch.confirmEnd });
    if (
      patch.liveTrayIcon !== undefined ||
      patch.closeToTray !== undefined ||
      patch.hideWhenMinimized !== undefined
    ) {
      settings.updateTray({
        ...(patch.liveTrayIcon !== undefined ? { liveIcon: patch.liveTrayIcon } : {}),
        ...(patch.closeToTray !== undefined ? { closeToTray: patch.closeToTray } : {}),
        ...(patch.hideWhenMinimized !== undefined
          ? { hideWhenMinimized: patch.hideWhenMinimized }
          : {}),
      });
      if (patch.liveTrayIcon !== undefined) tray?.applyLiveIcon();
    }

    const view = this.get();
    for (const window of BrowserWindow.getAllWindows()) {
      if (window.isDestroyed() || window.webContents.isDestroyed()) continue;
      window.webContents.send(IpcChannel.AppSettingsEvent, view);
    }
    tray?.refreshMenu();
    return view;
  }

  /** The tray's Options submenu. */
  trayOptions(): MenuItemConstructorOptions[] {
    const view = this.get();
    const liveAvailable = this.#host.tray()?.liveIconAvailable ?? false;
    return [
      {
        label: liveAvailable ? 'Show usage in tray icon' : 'Show usage in tray icon (unavailable)',
        type: 'checkbox',
        enabled: liveAvailable,
        checked: liveAvailable && view.liveTrayIcon,
        click: () => this.update({ liveTrayIcon: !view.liveTrayIcon }),
      },
      {
        label: 'Close to tray',
        type: 'checkbox',
        checked: view.closeToTray,
        click: () => this.update({ closeToTray: !view.closeToTray }),
      },
      {
        // Windows Task Manager's own wording for the same option.
        label: 'Hide when minimized',
        type: 'checkbox',
        checked: view.hideWhenMinimized,
        click: () => this.update({ hideWhenMinimized: !view.hideWhenMinimized }),
      },
      { type: 'separator' },
      {
        label: 'Always on top',
        type: 'checkbox',
        checked: view.alwaysOnTop,
        click: () => this.update({ alwaysOnTop: !view.alwaysOnTop }),
      },
      {
        label: 'Start with Windows',
        type: 'checkbox',
        enabled: view.startWithWindows !== null,
        checked: view.startWithWindows === true,
        click: () => this.update({ startWithWindows: view.startWithWindows !== true }),
      },
    ];
  }

  /** Update speed and pausing, for the top of the tray menu. */
  trayActions(): MenuItemConstructorOptions[] {
    const view = this.get();
    return [
      {
        label: 'Update speed',
        submenu: (Object.keys(UPDATE_INTERVALS_MS) as UpdateSpeed[]).map((speed) => ({
          label: UPDATE_SPEED_LABELS[speed],
          type: 'radio' as const,
          checked: view.updateSpeed === speed,
          click: () => this.update({ updateSpeed: speed }),
        })),
      },
      {
        label: 'Pause updates',
        type: 'checkbox',
        checked: view.paused,
        click: () => this.update({ paused: !view.paused }),
      },
    ];
  }

  /**
   * Where Windows should start the application from at sign-in, or null when
   * this build cannot say. A portable build runs from a temporary folder that
   * is emptied on exit, so only the launcher's own path, which the launcher
   * passes down, is a place worth registering.
   */
  #loginItem(): { path: string; args: string[] } | null {
    const launcher = process.env.PORTABLE_EXECUTABLE_FILE;
    if (!app.isPackaged || !launcher) return null;
    return { path: launcher, args: [START_HIDDEN_ARGUMENT] };
  }

  #startsWithWindows(): boolean | null {
    const item = this.#loginItem();
    if (!item) return null;
    const state = app.getLoginItemSettings({ path: item.path, args: item.args });
    // Registered, and not switched off in Windows' own list of startup apps.
    return state.openAtLogin && state.executableWillLaunchAtLogin;
  }

  #setStartsWithWindows(enabled: boolean): void {
    const item = this.#loginItem();
    if (!item) return;
    app.setLoginItemSettings({ openAtLogin: enabled, enabled, path: item.path, args: item.args });
    this.#host.logger?.info(
      'app',
      enabled ? `will start with Windows, from ${item.path}` : 'will no longer start with Windows',
    );
  }
}
