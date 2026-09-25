import { existsSync } from 'node:fs';
import { BrowserWindow, clipboard, dialog, Menu, shell } from 'electron';
import type { ProcessSnapshot, SystemSnapshot } from '@task-manager/telemetry-types';
import type {
  ActionOutcome,
  PriorityClassName,
  ProcessMenuCommand,
  ProcessMenuRequest,
  ProcessState,
} from '@shared/process-actions.js';
import type { Logger } from './logger.js';
import type { NativeTelemetryModule } from './native.js';
import {
  buildProcessMenu,
  codeLines,
  confirmEnding,
  confirmRealtime,
  confirmShellRestart,
  descendantsOf,
  endingCode,
  priorityLabel,
  reportClosing,
  reportEnding,
  reportSetting,
  reportShellRestart,
  reportSwitching,
  type EndKind,
  type MenuTarget,
  type Report,
} from './process-menu.js';
import type { SettingsStore } from './settings-store.js';

/**
 * Carries out what the process menu offers.
 *
 * The pages never act on a process. They ask for a menu, or for the selection
 * to be ended, and everything after that happens here: the menu itself, the
 * question before anything is ended, the call into Windows, and saying what
 * happened. So a page cannot end a process without a menu the user clicked or
 * a question the user answered.
 *
 * Every call into Windows names its target by PID and creation time; see
 * `native/telemetry/src/win/process_control.rs` for why that cannot hit the
 * wrong process.
 */

export interface ProcessActionsHost {
  native(): NativeTelemetryModule | null;
  latestSnapshot(): SystemSnapshot | null;
  /** This application is running as administrator. */
  elevated(): boolean;
  settings: SettingsStore;
  logger: Logger | null;
  /**
   * Relaunch as administrator, for when that is what would get past a refusal.
   * Absent until the application can do it.
   */
  restartElevated?: () => void;
}

/**
 * How long a menu waits, once closed, for a command a click may still be
 * delivering. Electron can report the menu closing just before the click, and
 * the page should not be told "nothing chosen" when something was.
 */
const MENU_SETTLE_MS = 250;

/** Stands in for an inspection the menu does not need; see `showMenu`. */
const UNINSPECTED: ProcessState = {
  status: 'running',
  canEnd: true,
  canAdjust: true,
  windowCount: 0,
  isShell: false,
};

export class ProcessActions {
  #host: ProcessActionsHost;
  /**
   * Whether an action is waiting on the user or on Windows.
   *
   * Only one runs at a time, and a request that arrives meanwhile is dropped
   * rather than queued. Stacked, a second question would not even be modal:
   * Electron only parents a message box to an enabled window, and the first
   * question has disabled it. An unparented question floats free of the
   * application, and an answer meant for one question could land on the other.
   */
  #busy = false;
  /**
   * The priority each process had before this application put it in
   * Efficiency mode, so turning the mode off can put it back. Forgotten once
   * restored; a process that exits in the meantime leaves one small entry.
   */
  #priorityBefore = new Map<string, PriorityClassName>();

  constructor(host: ProcessActionsHost) {
    this.#host = host;
  }

  /**
   * Show the menu for what a page has selected. Resolves, once the menu has
   * closed, with anything the page itself has to do.
   */
  showMenu(window: BrowserWindow | null, request: ProcessMenuRequest): Promise<ProcessMenuCommand> {
    const native = this.#host.native();
    const processes = this.#processes();
    const byKey = new Map(processes.map((process) => [process.key, process]));
    // A process the latest snapshot no longer lists has exited; the page will
    // catch up on the next sample.
    const chosen = request.keys
      .map((key) => byKey.get(key))
      .filter((process): process is ProcessSnapshot => process !== undefined);
    if (!native || chosen.length === 0 || this.#busy) return Promise.resolve(null);

    // Inspecting costs a few handle opens and a walk of every top-level window,
    // so it is done only when the menu uses the answer: for one process, and
    // for an application's windows. A menu for a selection of hundreds says
    // "End N processes", and each one is still checked when it is ended.
    const inspect = chosen.length === 1 || request.applicationName !== undefined;
    const targets: MenuTarget[] = chosen.map((process) => ({
      process,
      state: inspect ? native.inspectProcess(process.key) : UNINSPECTED,
    }));
    const single = targets.length === 1 ? targets[0]! : null;
    const descendants = single ? descendantsOf(processes, single.process.key) : [];
    const parent = single?.process.parentKey ? byKey.get(single.process.parentKey) : undefined;
    const representative = targets[0]!.process;

    let resolve: (command: ProcessMenuCommand) => void = () => {};
    const chosenCommand = new Promise<ProcessMenuCommand>((settle) => {
      resolve = settle;
    });

    const endKind: EndKind = request.applicationName
      ? 'application'
      : targets.length > 1
        ? 'several'
        : 'task';
    const template = buildProcessMenu(
      {
        targets,
        context: request.context,
        applicationName: request.applicationName,
        descendants,
        parent,
        elevated: this.#host.elevated(),
      },
      {
        end: () =>
          void this.#exclusive('end', () =>
            this.#end(window, endKind, chosen, request.applicationName),
          ),
        endTree: () =>
          void this.#exclusive('end process tree', () =>
            this.#end(window, 'tree', [representative, ...descendants], undefined),
          ),
        closeWindows: () =>
          void this.#exclusive('close windows', () => this.#closeWindows(window, targets)),
        switchTo: () => void this.#exclusive('switch to', () => this.#switchTo(window, targets)),
        openLocation: () =>
          void this.#exclusive('open file location', () =>
            this.#openLocation(window, representative),
          ),
        properties: () =>
          void this.#exclusive('properties', () => this.#properties(window, representative)),
        searchOnline: () => this.#searchOnline(representative),
        copy: (text) => clipboard.writeText(text),
        goToParent: () => {
          if (parent) resolve({ kind: 'goToParent', key: parent.key });
        },
        setPriority: (priority) =>
          void this.#exclusive('set priority', () =>
            this.#setPriority(window, representative, priority),
          ),
        setEfficiency: (enabled) =>
          void this.#exclusive('efficiency mode', () =>
            this.#setEfficiency(window, representative, targets[0]!.state, enabled),
          ),
        restartShell: () =>
          void this.#exclusive('restart Windows Explorer', () => this.#restartShell(window)),
        affinity: () => {
          const { processors, affinity } = targets[0]!.state;
          if (!processors || !affinity) return;
          // The page draws the dialog; the change comes back through
          // setAffinity, which checks everything again.
          resolve({
            kind: 'affinity',
            key: representative.key,
            name: representative.name,
            processors,
            current: affinity,
          });
        },
      },
    );

    Menu.buildFromTemplate(template).popup({
      window: window ?? undefined,
      callback: () => setTimeout(() => resolve(null), MENU_SETTLE_MS),
    });
    return chosenCommand;
  }

  /** The Delete key: end what is selected, asking first. */
  endSelected(window: BrowserWindow | null, keys: string[]): Promise<void> {
    return this.#exclusive('end', () => this.#endSelected(window, keys));
  }

  async #endSelected(window: BrowserWindow | null, keys: string[]): Promise<void> {
    const native = this.#host.native();
    const byKey = new Map(this.#processes().map((process) => [process.key, process]));
    const chosen = keys
      .map((key) => byKey.get(key))
      .filter((process): process is ProcessSnapshot => process !== undefined);
    if (!native || chosen.length === 0) return;

    if (chosen.length === 1) {
      const state = native.inspectProcess(chosen[0]!.key);
      // The menu would not offer these, so the key must not either.
      if (state.isCritical === true || (!state.canEnd && chosen[0]!.isProtected === true)) {
        await this.#show(window, refusalWithoutTrying(chosen[0]!, state));
        return;
      }
    }
    await this.#end(window, chosen.length > 1 ? 'several' : 'task', chosen, undefined);
  }

  /**
   * Restrict a process to some logical processors, from the dialog a page
   * drew after the menu asked for it.
   */
  setAffinity(window: BrowserWindow | null, key: string, processors: number[]): Promise<void> {
    return this.#exclusive('set affinity', async () => {
      const native = this.#host.native();
      const process = this.#processes().find((candidate) => candidate.key === key);
      if (!native || !process) return;
      const outcome = native.setProcessAffinity(key, processors);
      if (outcome.outcome === 'done') {
        this.#host.logger?.info(
          'process',
          `limited ${process.name} (PID ${process.pid}) to logical processors ${(outcome.affinity ?? processors).join(', ')}`,
        );
      }
      await this.#report(window, reportSetting(process, outcome, this.#host.elevated()));
    });
  }

  #processes(): ProcessSnapshot[] {
    return this.#host.latestSnapshot()?.processes?.processes ?? [];
  }

  async #setPriority(
    window: BrowserWindow | null,
    process: ProcessSnapshot,
    priority: PriorityClassName,
  ): Promise<void> {
    const native = this.#host.native();
    if (!native) return;
    if (priority === 'realtime') {
      const question = confirmRealtime(process);
      const answer = await this.#ask(window, {
        type: 'warning',
        title: 'Task Manager',
        message: question.message,
        detail: question.detail,
        buttons: [question.confirm, 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
      });
      this.#host.logger?.info(
        'process',
        `${answer.response === 0 ? 'confirmed' : 'cancelled'}: ${question.message}`,
      );
      if (answer.response !== 0) return;
    }
    const outcome = native.setProcessPriority(process.key, priority);
    if (outcome.outcome === 'done' && outcome.priorityClass) {
      this.#host.logger?.info(
        'process',
        `set ${process.name} (PID ${process.pid}) to ${priorityLabel(outcome.priorityClass)} priority`,
      );
    }
    await this.#report(window, reportSetting(process, outcome, this.#host.elevated(), priority));
  }

  async #setEfficiency(
    window: BrowserWindow | null,
    process: ProcessSnapshot,
    state: ProcessState,
    enabled: boolean,
  ): Promise<void> {
    const native = this.#host.native();
    if (!native) return;
    // Efficiency mode lowers the priority; turning it off puts back whatever
    // was there before, when this application is the one that changed it.
    if (enabled && state.priorityClass) this.#priorityBefore.set(process.key, state.priorityClass);
    const restore = enabled ? undefined : (this.#priorityBefore.get(process.key) ?? null);
    const outcome = native.setEfficiencyMode(process.key, enabled, restore);
    if (outcome.outcome === 'done') {
      if (!enabled) this.#priorityBefore.delete(process.key);
      this.#host.logger?.info(
        'process',
        `efficiency mode ${enabled ? 'on' : 'off'} for ${process.name} (PID ${process.pid})`,
      );
    }
    await this.#report(window, reportSetting(process, outcome, this.#host.elevated()));
  }

  async #restartShell(window: BrowserWindow | null): Promise<void> {
    const native = this.#host.native();
    if (!native) return;
    const question = confirmShellRestart();
    const answer = await this.#ask(window, {
      type: 'warning',
      title: 'Task Manager',
      message: question.message,
      detail: question.detail,
      buttons: [question.confirm, 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    });
    this.#host.logger?.info(
      'process',
      `${answer.response === 0 ? 'confirmed' : 'cancelled'}: ${question.message}`,
    );
    if (answer.response !== 0) return;
    // Elevated, a new Explorer would run elevated and so would everything
    // started from the taskbar, so then only Windows may bring it back.
    const result = await native.restartShell(!this.#host.elevated());
    if (result.outcome === 'restarted' || result.outcome === 'started') {
      this.#host.logger?.info(
        'process',
        result.outcome === 'restarted'
          ? 'restarted Windows Explorer; Windows brought the shell back'
          : 'restarted Windows Explorer; started a new shell after Windows did not',
      );
    }
    await this.#report(window, reportShellRestart(result.outcome, result.win32Error));
  }

  /** Log and show a report, when there is one. */
  async #report(window: BrowserWindow | null, report: Report | null): Promise<void> {
    if (!report) return;
    if (report.code) this.#host.logger?.warn(report.code, report.message);
    await this.#show(window, report);
  }

  async #exclusive(name: string, run: () => Promise<void>): Promise<void> {
    if (this.#busy) {
      this.#host.logger?.info(
        'process',
        `ignored "${name}": another process action is still waiting for an answer`,
      );
      return;
    }
    this.#busy = true;
    try {
      await run();
    } finally {
      this.#busy = false;
    }
  }

  async #end(
    window: BrowserWindow | null,
    kind: EndKind,
    processes: ProcessSnapshot[],
    applicationName: string | undefined,
  ): Promise<void> {
    const native = this.#host.native();
    if (!native || processes.length === 0) return;

    const asking = kind !== 'task' || this.#host.settings.processes.confirmEnd;
    if (asking) {
      const question = confirmEnding(kind, processes, applicationName);
      const answer = await this.#ask(window, {
        type: 'warning',
        title: 'Task Manager',
        message: question.message,
        detail: question.detail,
        buttons: [question.confirm, 'Cancel'],
        // Cancel is the default. These questions open with keyboard focus,
        // so an Enter pressed for something else must never end a process.
        defaultId: 1,
        cancelId: 1,
        noLink: true,
        checkboxLabel: question.offerDontAsk ? "Don't ask again" : undefined,
      });
      // On record either way: a process that disappeared is the first thing
      // anyone asks about afterwards, and the answer is this line.
      this.#host.logger?.info(
        'process',
        `${answer.response === 0 ? 'confirmed' : 'cancelled'}: ${question.message}`,
      );
      if (answer.response !== 0) return;
      if (question.offerDontAsk && answer.checkboxChecked) {
        this.#host.settings.updateProcesses({ confirmEnd: false });
        this.#host.logger?.info('process', 'will no longer ask before ending a single process');
      }
    }

    // A tree's root goes first, and alone: it is the process most likely to
    // restart children as they disappear. Whatever it had already started
    // again has a new identity and is left alone.
    const results: { process: ProcessSnapshot; outcome: ActionOutcome }[] = [];
    const [first, ...rest] = processes;
    if (kind === 'tree') {
      results.push({ process: first!, outcome: await native.endProcess(first!.key) });
    }
    const remaining = kind === 'tree' ? rest : processes;
    const outcomes = await Promise.all(remaining.map((process) => native.endProcess(process.key)));
    remaining.forEach((process, index) => results.push({ process, outcome: outcomes[index]! }));

    for (const { process, outcome } of results) {
      if (outcome.outcome === 'ended') {
        this.#host.logger?.info('process', `ended ${process.name} (PID ${process.pid})`);
      } else if (outcome.outcome !== 'notRunning') {
        this.#host.logger?.warn(
          endingCode(process, outcome),
          `could not end ${process.name} (PID ${process.pid}): ${outcome.outcome}${
            outcome.win32Error === undefined ? '' : `, Windows error ${outcome.win32Error}`
          }`,
        );
      }
    }

    const report = reportEnding(results, this.#host.elevated());
    if (report) await this.#show(window, report);
  }

  async #closeWindows(window: BrowserWindow | null, targets: MenuTarget[]): Promise<void> {
    const native = this.#host.native();
    if (!native) return;
    for (const target of targets.filter((candidate) => candidate.state.windowCount > 0)) {
      const outcome = native.closeProcessWindows(target.process.key);
      if (outcome.outcome === 'requested') {
        this.#host.logger?.info(
          'process',
          `asked ${outcome.count ?? 0} window(s) of ${target.process.name} (PID ${target.process.pid}) to close`,
        );
      }
      const report = reportClosing(target.process, outcome, this.#host.elevated());
      if (report) {
        if (report.code) this.#host.logger?.warn(report.code, report.message);
        await this.#show(window, report);
        return;
      }
    }
  }

  async #switchTo(window: BrowserWindow | null, targets: MenuTarget[]): Promise<void> {
    const native = this.#host.native();
    const target = targets.find((candidate) => candidate.state.windowCount > 0);
    if (!native || !target) return;
    const report = reportSwitching(target.process, native.bringProcessToFront(target.process.key));
    if (report) {
      if (report.code) this.#host.logger?.warn(report.code, report.message);
      await this.#show(window, report);
    }
  }

  async #openLocation(window: BrowserWindow | null, process: ProcessSnapshot): Promise<void> {
    const path = process.imagePath;
    if (path && existsSync(path)) {
      shell.showItemInFolder(path);
      return;
    }
    await this.#fileMissing(window, process);
  }

  async #properties(window: BrowserWindow | null, process: ProcessSnapshot): Promise<void> {
    const path = process.imagePath;
    if (path && existsSync(path) && this.#host.native()?.showFileProperties(path)) return;
    await this.#fileMissing(window, process);
  }

  async #fileMissing(window: BrowserWindow | null, process: ProcessSnapshot): Promise<void> {
    this.#host.logger?.warn('TM-0009', `could not show the file of ${process.name}: ${process.imagePath ?? 'no path'}`);
    await this.#show(window, {
      type: 'info',
      message: `The file for ${process.name} could not be shown.`,
      detail: `${process.imagePath ?? 'Windows did not report where it lives.'}\n\n${codeLines('TM-0009')}`,
      code: 'TM-0009',
      offerElevation: false,
    });
  }

  #searchOnline(process: ProcessSnapshot): void {
    const description = process.fileDescription ?? process.productName;
    const query = description && description !== process.name
      ? `${process.name} ${description}`
      : process.name;
    void shell.openExternal(`https://www.google.com/search?q=${encodeURIComponent(query)}`);
  }

  async #show(window: BrowserWindow | null, report: Report): Promise<void> {
    const elevation = report.offerElevation && this.#host.restartElevated !== undefined;
    const answer = await this.#ask(window, {
      type: report.type,
      title: 'Task Manager',
      message: report.message,
      detail: report.detail,
      buttons: elevation ? ['Restart as administrator', 'OK'] : ['OK'],
      defaultId: elevation ? 1 : 0,
      cancelId: elevation ? 1 : 0,
      noLink: true,
    });
    if (elevation && answer.response === 0) this.#host.restartElevated?.();
  }

  /** A message box, modal to the window that asked when there is one. */
  #ask(
    window: BrowserWindow | null,
    options: Electron.MessageBoxOptions,
  ): Promise<Electron.MessageBoxReturnValue> {
    return window && !window.isDestroyed()
      ? dialog.showMessageBox(window, options)
      : dialog.showMessageBox(options);
  }
}

/** The explanation for a process the menu would not have offered to end. */
function refusalWithoutTrying(process: ProcessSnapshot, state: ProcessState): Report {
  const critical = state.isCritical === true;
  return {
    type: 'warning',
    message: critical
      ? `${process.name} is critical to Windows, so Task Manager will not end it.`
      : `Windows protects ${process.name}, so no application can end it.`,
    detail: codeLines(critical ? 'TM-0004' : 'TM-0002'),
    code: critical ? 'TM-0004' : 'TM-0002',
    offerElevation: false,
  };
}
