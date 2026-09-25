import { dialog, type BrowserWindow } from 'electron';
import type { Logger } from './logger.js';
import type { LaunchOutcome, NativeTelemetryModule } from './native.js';
import { codeLines, type Report } from './process-menu.js';

/**
 * Run new task, as in Windows Task Manager: open whatever was typed the way
 * the Run dialog would, optionally as administrator.
 */

/** Longest command accepted, well past any real command line. */
export const MAX_COMMAND_LENGTH = 2_048;

export interface RunTaskHost {
  native(): NativeTelemetryModule | null;
  logger: Logger | null;
  /** This application is running as administrator. */
  elevated(): boolean;
}

/** Accept a command from a renderer, or null. */
export function readCommand(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const command = value.trim();
  return command.length > 0 && command.length <= MAX_COMMAND_LENGTH ? command : null;
}

export async function runNewTask(
  host: RunTaskHost,
  window: BrowserWindow | null,
  command: string,
  asAdministrator: boolean,
): Promise<void> {
  const native = host.native();
  if (!native) return;
  // Everything an elevated application starts is elevated already, and asking
  // for the prompt again would only show it for nothing.
  const elevate = asAdministrator && !host.elevated();
  const outcome = await native.runCommand(command, elevate);
  if (outcome.outcome === 'started') {
    host.logger?.info('process', `ran "${command}"${elevate ? ' as administrator' : ''}`);
    return;
  }
  if (outcome.outcome === 'declined') {
    host.logger?.info('process', `the administrator prompt for "${command}" was declined`);
    return;
  }
  host.logger?.warn('TM-0014', `could not run "${command}": Windows error ${outcome.win32Error ?? 'unknown'}`);
  const report = reportRunFailure(command, outcome);
  const options: Electron.MessageBoxOptions = {
    type: report.type,
    title: 'Task Manager',
    message: report.message,
    detail: report.detail,
    buttons: ['OK'],
    noLink: true,
  };
  await (window && !window.isDestroyed()
    ? dialog.showMessageBox(window, options)
    : dialog.showMessageBox(options));
}

/** Why a command could not be run, in words. */
export function reportRunFailure(command: string, outcome: LaunchOutcome): Report {
  const error = outcome.win32Error;
  const reason =
    error === 2 || error === 3
      ? `Windows cannot find "${command}".`
      : error === 1155
        ? `No program is set to open "${command}".`
        : `Windows could not start "${command}".`;
  return {
    type: 'warning',
    message: reason,
    detail: `${error === undefined ? '' : `Windows error ${error}.\n\n`}${codeLines('TM-0014')}`,
    code: 'TM-0014',
    offerElevation: false,
  };
}
