import { dialog, type BrowserWindow } from 'electron';
import type { Logger } from './logger.js';
import type { Report } from './process-menu.js';

/**
 * One action at a time, whether on a process or a service.
 *
 * An action may wait on the user or on Windows, and a request that arrives
 * meanwhile is dropped rather than queued. Stacked, a second question would
 * not even be modal: Electron only parents a message box to an enabled window
 * (`message_box_win.cc`), and the first question has disabled it. An
 * unparented question floats free of the application, and an answer meant
 * for one question could land on the other.
 */
export class ActionGate {
  #busy = false;
  #logger: () => Logger | null;

  constructor(logger: () => Logger | null) {
    this.#logger = logger;
  }

  /** Whether an action is waiting on the user or on Windows. */
  get busy(): boolean {
    return this.#busy;
  }

  /** Run `action` unless another is still running, in which case drop it. */
  async run(name: string, action: () => Promise<void>): Promise<void> {
    if (this.#busy) {
      this.#logger()?.info('process', `ignored "${name}": another action is still waiting for an answer`);
      return;
    }
    this.#busy = true;
    try {
      await action();
    } finally {
      this.#busy = false;
    }
  }
}

/** A message box, modal to the window that asked when there is one. */
export function ask(
  window: BrowserWindow | null,
  options: Electron.MessageBoxOptions,
): Promise<Electron.MessageBoxReturnValue> {
  return window && !window.isDestroyed()
    ? dialog.showMessageBox(window, options)
    : dialog.showMessageBox(options);
}

/**
 * Show a report, offering to restart as administrator when that would get
 * past what it reports and the application can do it.
 */
export async function showReport(
  window: BrowserWindow | null,
  report: Report,
  restartElevated?: () => void,
): Promise<void> {
  const elevation = report.offerElevation && restartElevated !== undefined;
  const answer = await ask(window, {
    type: report.type,
    title: 'Task Manager',
    message: report.message,
    detail: report.detail,
    buttons: elevation ? ['Restart as administrator', 'OK'] : ['OK'],
    defaultId: elevation ? 1 : 0,
    cancelId: elevation ? 1 : 0,
    noLink: true,
  });
  if (elevation && answer.response === 0) restartElevated?.();
}
