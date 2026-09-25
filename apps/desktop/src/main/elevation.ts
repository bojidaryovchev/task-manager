import { app, dialog, type BrowserWindow } from 'electron';
import type { Logger } from './logger.js';
import type { NativeTelemetryModule } from './native.js';
import { codeLines } from './process-menu.js';

/**
 * Restarting as administrator.
 *
 * Without administrator rights, Windows refuses this application access to
 * services, to other accounts' processes and to anything running as
 * administrator: 192 of 639 processes on the machine this was measured on.
 * Restarting elevated gets past that for everything except protected
 * processes, which refuse even administrators.
 *
 * # The sequence, and why each step is there
 *
 * 1. **The single-instance lock is released first.** The new copy asks for it
 *    as it starts, and would otherwise find it held, conclude another copy is
 *    running and quit - leaving nothing running at all.
 * 2. **The copy is started through the elevation prompt,** from the executable
 *    this copy is already running rather than from the portable launcher. The
 *    launcher would unpack itself into the same folder this copy is running
 *    from, while this copy still has it open.
 * 3. **If the prompt is declined** the lock is taken back and nothing else
 *    changes.
 * 4. **If it is accepted, the portable launcher is stopped before this copy
 *    exits.** The launcher waits for the application and then deletes the folder
 *    it unpacked (electron-builder's `portable.nsi`: `ExecWait`, then
 *    `RMDir /r`), which is now the folder the administrator copy is running
 *    from. The next launch empties that folder before unpacking into it, so
 *    nothing is left behind for long.
 */

/** Marks a copy started this way, so its log says why it is elevated. */
export const RESTARTED_AS_ADMINISTRATOR_ARGUMENT = '--restarted-as-administrator';

export interface ElevationHost {
  native(): NativeTelemetryModule | null;
  logger: Logger | null;
  /** Quit this copy cleanly. */
  quit(): void;
  /** The window to parent a message to, if there is one. */
  window(): BrowserWindow | null;
}

let restarting = false;

/** Restart this application as administrator, asking Windows first. */
export async function restartAsAdministrator(host: ElevationHost): Promise<void> {
  const native = host.native();
  // One prompt at a time: a second click while the first prompt is up would
  // otherwise release a lock this copy no longer holds.
  if (!native || restarting) return;
  restarting = true;
  try {
    const parameters = app.isPackaged
      ? RESTARTED_AS_ADMINISTRATOR_ARGUMENT
      : `${quote(app.getAppPath())} ${RESTARTED_AS_ADMINISTRATOR_ARGUMENT}`;

    app.releaseSingleInstanceLock();
    const result = await native.launchElevated(process.execPath, parameters);

    if (result.outcome === 'started') {
      host.logger?.info('app', 'restarting as administrator');
      stopPortableLauncher(native, host.logger);
      host.quit();
      return;
    }

    // Still the only copy: take the lock back and carry on as before.
    if (!app.requestSingleInstanceLock()) {
      host.logger?.info('app', 'another copy started while the administrator prompt was up');
    }
    if (result.outcome === 'declined') {
      host.logger?.info('app', 'the administrator prompt was declined');
      return;
    }
    host.logger?.warn(
      'TM-0010',
      `could not restart as administrator: Windows error ${result.win32Error ?? 'unknown'}`,
    );
    const options: Electron.MessageBoxOptions = {
      type: 'error',
      title: 'Task Manager',
      message: 'Task Manager could not restart as administrator.',
      detail: `Windows error ${result.win32Error ?? 'unknown'}.\n\n${codeLines('TM-0010')}`,
      buttons: ['OK'],
      noLink: true,
    };
    const parent = host.window();
    await (parent && !parent.isDestroyed()
      ? dialog.showMessageBox(parent, options)
      : dialog.showMessageBox(options));
  } finally {
    restarting = false;
  }
}

/**
 * Stop the portable build's launcher so it does not delete the folder the
 * administrator copy is running from. Only when this process really is its
 * child: the launcher sets `PORTABLE_EXECUTABLE_FILE` to its own path, and the
 * parent's executable has to be that file.
 */
function stopPortableLauncher(native: NativeTelemetryModule, logger: Logger | null): void {
  const launcher = process.env.PORTABLE_EXECUTABLE_FILE;
  if (!launcher) return;
  const parentPath = native.processImagePath(process.ppid);
  if (!parentPath || parentPath.toLowerCase() !== launcher.toLowerCase()) {
    logger?.info('app', 'the portable launcher is not this process\'s parent; leaving it alone');
    return;
  }
  try {
    process.kill(process.ppid);
    logger?.info('app', 'stopped the portable launcher so it keeps the unpacked files');
  } catch (error) {
    logger?.warn('TM-0010', 'could not stop the portable launcher; the administrator copy may lose files', error);
  }
}

/** Quote one command-line argument for Windows. */
function quote(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}
