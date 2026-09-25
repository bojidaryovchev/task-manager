import type { MenuItemConstructorOptions } from 'electron';
import type { ProcessSnapshot } from '@task-manager/telemetry-types';
import { describeErrorCode, type ErrorCode } from '@shared/error-codes.js';
import type { ShellOutcome } from './native.js';
import type {
  ActionOutcome,
  PriorityClassName,
  ProcessMenuContext,
  ProcessState,
  SettingOutcome,
} from '@shared/process-actions.js';

/**
 * The process menu and everything it says: which commands it offers, how it
 * asks before ending anything, and how it reports what happened.
 *
 * Pure - processes in, menu items and text out - so every label, every
 * confirmation and every report can be tested without Electron, a window or a
 * real process. `process-actions.ts` supplies the live state and does the
 * work.
 */

/** A process the menu is about, with what Windows says about it right now. */
export interface MenuTarget {
  process: ProcessSnapshot;
  state: ProcessState;
}

export interface ProcessMenuModel {
  targets: MenuTarget[];
  context: ProcessMenuContext;
  /** Set when the menu is for a whole application on the Applications page. */
  applicationName?: string;
  /** Processes the single target started, directly or through others. */
  descendants: ProcessSnapshot[];
  /** The single target's parent, when it is in the list to go to. */
  parent?: ProcessSnapshot;
  /** This application is running as administrator. */
  elevated: boolean;
}

export interface ProcessMenuHandlers {
  /** Open the main window on the process's row; offered from the widget. */
  showInTaskManager(): void;
  end(): void;
  endTree(): void;
  closeWindows(): void;
  switchTo(): void;
  openLocation(): void;
  properties(): void;
  searchOnline(): void;
  copy(text: string): void;
  goToParent(): void;
  setPriority(priority: PriorityClassName): void;
  setEfficiency(enabled: boolean): void;
  affinity(): void;
  restartShell(): void;
}

/** Windows Task Manager's order and names for the priority classes. */
export const PRIORITY_MENU: readonly (readonly [PriorityClassName, string])[] = [
  ['realtime', 'Realtime'],
  ['high', 'High'],
  ['aboveNormal', 'Above normal'],
  ['normal', 'Normal'],
  ['belowNormal', 'Below normal'],
  ['idle', 'Low'],
];

/** The name a person reads for a priority class. */
export function priorityLabel(priority: PriorityClassName): string {
  return PRIORITY_MENU.find(([value]) => value === priority)?.[1] ?? priority;
}

/** Build the menu. */
export function buildProcessMenu(
  model: ProcessMenuModel,
  handlers: ProcessMenuHandlers,
): MenuItemConstructorOptions[] {
  const { targets } = model;
  const single = targets.length === 1 ? targets[0]! : null;
  const reachable = targets.filter((target) => target.state.status === 'running');

  // A process that has gone since the page drew it can only be copied.
  if (reachable.length === 0) {
    return [
      {
        label: single ? `${single.process.name} is no longer running` : 'These processes are no longer running',
        enabled: false,
      },
      { type: 'separator' },
      copyMenu(targets.map((target) => target.process), handlers),
    ];
  }

  const items: MenuItemConstructorOptions[] = [];
  // The widget's way to everything its short menu leaves out.
  if (model.context === 'widget') {
    items.push(
      { label: 'Show in Task Manager', click: handlers.showInTaskManager },
      { type: 'separator' },
    );
  }
  const windows = reachable.reduce((total, target) => total + target.state.windowCount, 0);
  if (windows > 0 && (single || model.applicationName)) {
    items.push(
      { label: 'Switch to', click: handlers.switchTo },
      { label: windows === 1 ? 'Close window' : `Close ${windows} windows`, click: handlers.closeWindows },
      { type: 'separator' },
    );
  }

  // Windows Task Manager's one restart: the shell, which is what people
  // restart when the taskbar or the desktop stops responding.
  if (single?.state.isShell && single.state.canEnd) {
    items.push({ label: 'Restart', click: handlers.restartShell });
  }
  items.push(endItem(model, handlers));
  if (single && model.descendants.length > 0 && model.context === 'processes') {
    items.push({
      label: `End process tree (${model.descendants.length + 1} processes)`,
      enabled: single.state.isCritical !== true,
      click: handlers.endTree,
    });
  }

  if (single && single.state.status === 'running') {
    items.push({ type: 'separator' }, ...tuningItems(single, model, handlers));
  }

  const representative = single?.process ?? (model.applicationName ? targets[0]!.process : null);
  if (representative) {
    items.push(
      { type: 'separator' },
      {
        label: 'Open file location',
        enabled: Boolean(representative.imagePath),
        click: handlers.openLocation,
      },
      { label: 'Search online', click: handlers.searchOnline },
      {
        label: 'Properties',
        enabled: Boolean(representative.imagePath),
        click: handlers.properties,
      },
    );
  }

  items.push({ type: 'separator' }, copyMenu(targets.map((target) => target.process), handlers));

  if (single && model.parent && model.context === 'processes') {
    items.push(
      { type: 'separator' },
      { label: `Go to parent (${model.parent.name})`, click: handlers.goToParent },
    );
  }
  return items;
}

/** Priority, Efficiency mode and affinity, for one process. */
function tuningItems(
  target: MenuTarget,
  model: ProcessMenuModel,
  handlers: ProcessMenuHandlers,
): MenuItemConstructorOptions[] {
  const { process, state } = target;
  const refused = !state.canAdjust;
  const why = refused ? (model.elevated ? ' (Windows refuses)' : ' (needs administrator)') : '';
  // Windows Task Manager greys Efficiency mode out for what it calls core
  // Windows processes. Critical processes and everything in session 0, where
  // services run, are treated the same way here.
  const partOfWindows = state.isCritical === true || process.sessionId === 0;
  return [
    {
      label: `Set priority${why}`,
      enabled: !refused && state.priorityClass !== undefined,
      submenu: PRIORITY_MENU.map(([value, label]) => ({
        label,
        type: 'radio' as const,
        checked: state.priorityClass === value,
        click: () => handlers.setPriority(value),
      })),
    },
    {
      label: partOfWindows ? 'Efficiency mode (part of Windows)' : `Efficiency mode${why}`,
      type: 'checkbox',
      checked: state.efficiencyMode === true,
      enabled: !refused && !partOfWindows && state.efficiencyMode !== undefined,
      click: () => handlers.setEfficiency(state.efficiencyMode !== true),
    },
    // A dialog the page draws, and the widget has no room for one.
    ...(model.context === 'widget'
      ? []
      : [
          {
            label: `Set affinity…${why}`,
            enabled: !refused && state.processors !== undefined && state.affinity !== undefined,
            click: handlers.affinity,
          },
        ]),
  ];
}

function endItem(model: ProcessMenuModel, handlers: ProcessMenuHandlers): MenuItemConstructorOptions {
  const { targets } = model;
  // Shown, not registered: the page handles the key itself, and a registered
  // accelerator would fire even with the menu closed. The widget takes no keys.
  const shortcut =
    model.context === 'widget'
      ? {}
      : ({ accelerator: 'Delete', registerAccelerator: false } as const);

  if (model.applicationName) {
    return { label: `End ${model.applicationName}`, click: handlers.end };
  }
  if (targets.length > 1) {
    return { label: `End ${targets.length} processes`, click: handlers.end, ...shortcut };
  }

  const { process, state } = targets[0]!;
  if (state.isCritical === true) {
    return { label: 'End task (critical to Windows)', enabled: false };
  }
  if (!state.canEnd && process.isProtected === true) {
    return { label: 'End task (protected by Windows)', enabled: false };
  }
  if (!state.canEnd && !model.elevated) {
    // Offered anyway: choosing it explains why, and offers the way through.
    return { label: 'End task (needs administrator)', click: handlers.end };
  }
  return { label: 'End task', click: handlers.end, ...shortcut };
}

function copyMenu(
  processes: ProcessSnapshot[],
  handlers: ProcessMenuHandlers,
): MenuItemConstructorOptions {
  if (processes.length > 1) {
    return {
      label: 'Copy',
      submenu: [
        {
          label: 'Names and PIDs',
          click: () =>
            handlers.copy(processes.map((process) => `${process.name}\t${process.pid}`).join('\n')),
        },
      ],
    };
  }
  const process = processes[0]!;
  const submenu: MenuItemConstructorOptions[] = [
    { label: 'Name', click: () => handlers.copy(process.name) },
    { label: 'PID', click: () => handlers.copy(String(process.pid)) },
  ];
  if (process.imagePath) {
    const path = process.imagePath;
    submenu.push({ label: 'Path', click: () => handlers.copy(path) });
  }
  if (process.commandLine) {
    const commandLine = process.commandLine;
    submenu.push({ label: 'Command line', click: () => handlers.copy(commandLine) });
  }
  submenu.push(
    { type: 'separator' },
    { label: 'All details', click: () => handlers.copy(describeForClipboard(process)) },
  );
  return { label: 'Copy', submenu };
}

/**
 * Every process `key` started, directly or through others, nearest first.
 *
 * Follows `parentKey`, which the collector only sets when the parent was
 * created before the child, so a recycled PID never makes an unrelated
 * process part of the tree. A visited set guards against a loop regardless.
 */
export function descendantsOf(processes: ProcessSnapshot[], key: string): ProcessSnapshot[] {
  const children = new Map<string, ProcessSnapshot[]>();
  for (const candidate of processes) {
    if (!candidate.parentKey) continue;
    const siblings = children.get(candidate.parentKey) ?? [];
    siblings.push(candidate);
    children.set(candidate.parentKey, siblings);
  }
  const found: ProcessSnapshot[] = [];
  const seen = new Set([key]);
  const queue = [key];
  while (queue.length > 0) {
    for (const child of children.get(queue.shift()!) ?? []) {
      if (seen.has(child.key)) continue;
      seen.add(child.key);
      found.push(child);
      queue.push(child.key);
    }
  }
  return found;
}

/** A process as plain text, for pasting into a message or a bug report. */
export function describeForClipboard(process: ProcessSnapshot): string {
  const lines: [string, string | number | undefined][] = [
    ['Name', process.name],
    ['PID', process.pid],
    ['Description', process.fileDescription],
    ['Product', process.productName],
    ['Company', process.companyName],
    ['Path', process.imagePath],
    ['Command line', process.commandLine],
    ['User', process.userName],
    ['Started', new Date(process.createTimeUnixMs).toISOString()],
    ['Parent PID', process.parentPid],
    ['Architecture', process.architecture],
  ];
  return lines
    .filter(([, value]) => value !== undefined && value !== '')
    .map(([label, value]) => `${label}: ${value}`)
    .join('\n');
}

// --- asking first -------------------------------------------------------------

export type EndKind = 'task' | 'tree' | 'several' | 'application';

export interface Confirmation {
  message: string;
  detail: string;
  /** The button that goes ahead. */
  confirm: string;
  /** Whether "Don't ask again" is offered. Only ever for a single process. */
  offerDontAsk: boolean;
}

/**
 * What to ask before ending processes.
 *
 * `processes` is everything that will be ended; for a tree, the first entry is
 * the process that was chosen.
 */
export function confirmEnding(
  kind: EndKind,
  processes: ProcessSnapshot[],
  applicationName?: string,
): Confirmation {
  // Session 0 is where services and Windows' own background processes run.
  // Windows Task Manager gives the same caution for system processes.
  const system = processes.filter((process) => process.sessionId === 0).length;
  const who = system === processes.length ? 'They are' : `${system} of them are`;
  const caution =
    system === 0
      ? ''
      : processes.length === 1
        ? '\n\nIt is part of Windows or a service, and ending it may make Windows unstable.'
        : `\n\n${who} part of Windows or services, and ending ${system === 1 ? 'it' : 'them'} may make Windows unstable.`;
  const lost =
    (processes.length === 1
      ? 'It closes at once, and anything it has not saved is lost.'
      : 'They close at once, and anything they have not saved is lost.') + caution;
  const first = processes[0]!;
  switch (kind) {
    case 'task':
      return {
        message: `End ${first.name}?`,
        detail: `${identify(first)}\n\n${lost}`,
        confirm: 'End task',
        offerDontAsk: true,
      };
    case 'tree': {
      const started = processes.length - 1;
      return {
        message: `End ${first.name} and ${started === 1 ? 'the process' : `the ${started} processes`} it started?`,
        detail: `${summarise(processes)}\n\n${lost}`,
        confirm: 'End process tree',
        offerDontAsk: false,
      };
    }
    case 'several':
      return {
        message: `End ${processes.length} processes?`,
        detail: `${summarise(processes)}\n\n${lost}`,
        confirm: 'End processes',
        offerDontAsk: false,
      };
    case 'application':
      return {
        message: `End ${applicationName ?? first.name}?`,
        detail: `This ends ${processes.length === 1 ? 'its only process' : `all ${processes.length} of its processes`}:\n${summarise(processes)}\n\n${lost}`,
        confirm: 'End all',
        offerDontAsk: false,
      };
  }
}

/** A process as a person would recognise it. */
function identify(process: ProcessSnapshot): string {
  const description = process.fileDescription ?? process.productName;
  const heading = description && description !== process.name
    ? `${description} · PID ${process.pid}`
    : `PID ${process.pid}`;
  return process.imagePath ? `${heading}\n${process.imagePath}` : heading;
}

/** Names with counts, most common first, capped so the dialog stays readable. */
function summarise(processes: ProcessSnapshot[], limit = 8): string {
  const counts = new Map<string, number>();
  for (const process of processes) counts.set(process.name, (counts.get(process.name) ?? 0) + 1);
  const sorted = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const lines = sorted
    .slice(0, limit)
    .map(([name, count]) => (count === 1 ? name : `${name} × ${count}`));
  const rest = sorted.slice(limit).reduce((total, [, count]) => total + count, 0);
  if (rest > 0) lines.push(`and ${rest} more`);
  return lines.join('\n');
}

// --- saying what happened -------------------------------------------------------

export interface Report {
  type: 'info' | 'warning' | 'error';
  message: string;
  detail: string;
  code?: ErrorCode;
  /** Offer to restart Task Manager as administrator, which would get past this. */
  offerElevation: boolean;
}

/** The code and what to do about it, in the words the registry uses. */
export function codeLines(code: ErrorCode): string {
  const definition = describeErrorCode(code);
  return definition ? `${code} · ${definition.title}\nWhat to do: ${definition.action}` : code;
}

/** Outcomes that mean the process is gone, which is what ending it was for. */
function isGone(outcome: ActionOutcome['outcome']): boolean {
  return outcome === 'ended' || outcome === 'notRunning';
}

/**
 * What to tell the user after ending processes, or null when every one of
 * them is gone and there is nothing to say.
 */
export function reportEnding(
  results: { process: ProcessSnapshot; outcome: ActionOutcome }[],
  elevated: boolean,
): Report | null {
  const failures = results.filter((result) => !isGone(result.outcome.outcome));
  if (failures.length === 0) return null;

  if (results.length === 1) {
    return reportOne(failures[0]!.process, failures[0]!.outcome, elevated);
  }

  const ended = results.length - failures.length;
  const groups = new Map<ErrorCode, ProcessSnapshot[]>();
  for (const failure of failures) {
    const code = endingCode(failure.process, failure.outcome);
    groups.set(code, [...(groups.get(code) ?? []), failure.process]);
  }
  const sections = [...groups].map(
    ([code, processes]) => `${codeLines(code)}\n${summarise(processes, 5)}`,
  );
  return {
    type: 'warning',
    message: `Ended ${ended} of ${results.length} processes.`,
    detail: `${failures.length} could not be ended.\n\n${sections.join('\n\n')}`,
    offerElevation: !elevated && groups.has('TM-0001'),
  };
}

/** The code for a process that could not be ended. */
export function endingCode(process: ProcessSnapshot, outcome: ActionOutcome): ErrorCode {
  switch (outcome.outcome) {
    case 'accessDenied':
      return process.isProtected === true ? 'TM-0002' : 'TM-0001';
    case 'identityChanged':
      return 'TM-0003';
    case 'critical':
      return 'TM-0004';
    case 'stillExiting':
      return 'TM-0005';
    default:
      return 'TM-0006';
  }
}

function reportOne(process: ProcessSnapshot, outcome: ActionOutcome, elevated: boolean): Report {
  const code = endingCode(process, outcome);
  const name = process.name;
  switch (code) {
    case 'TM-0001':
      return {
        type: 'warning',
        message: `Windows won't let Task Manager end ${name}.`,
        detail: `${name} runs with more privileges than Task Manager${elevated ? '' : ', which is running without administrator rights'}.\n\n${codeLines(code)}`,
        code,
        offerElevation: !elevated,
      };
    case 'TM-0002':
      return {
        type: 'warning',
        message: `Windows protects ${name}, so no application can end it.`,
        detail: codeLines(code),
        code,
        offerElevation: false,
      };
    case 'TM-0003':
      return {
        type: 'info',
        message: `${name} had already exited.`,
        detail: `Windows had given its PID to another program, so nothing was done.\n\n${codeLines(code)}`,
        code,
        offerElevation: false,
      };
    case 'TM-0004':
      return {
        type: 'warning',
        message: `${name} is critical to Windows, so Task Manager will not end it.`,
        detail: codeLines(code),
        code,
        offerElevation: false,
      };
    case 'TM-0005':
      return {
        type: 'info',
        message: `${name} is still exiting.`,
        detail: codeLines(code),
        code,
        offerElevation: false,
      };
    default:
      return {
        type: 'error',
        message: `${name} could not be ended.`,
        detail: `Windows error ${outcome.win32Error ?? 'unknown'}.\n\n${codeLines('TM-0006')}`,
        code: 'TM-0006',
        offerElevation: false,
      };
  }
}

/** What to tell the user after asking a program's windows to close, if anything. */
export function reportClosing(process: ProcessSnapshot, outcome: ActionOutcome, elevated: boolean): Report | null {
  switch (outcome.outcome) {
    case 'requested':
      // The program decides what happens next, and may ask to save first.
      return null;
    case 'noWindows':
      return {
        type: 'info',
        message: `${process.name} has no windows to close.`,
        detail: 'It may have closed them already.',
        offerElevation: false,
      };
    case 'accessDenied':
      return {
        type: 'warning',
        message: `Windows won't deliver the request to ${process.name}.`,
        detail: codeLines('TM-0008'),
        code: 'TM-0008',
        offerElevation: !elevated,
      };
    case 'notRunning':
    case 'identityChanged':
      return goneReport(process, outcome);
    default:
      return failedReport(process, outcome);
  }
}

/** What to tell the user after switching to a program, if anything. */
export function reportSwitching(process: ProcessSnapshot, outcome: ActionOutcome): Report | null {
  switch (outcome.outcome) {
    case 'done':
      return null;
    case 'noWindows':
      return {
        type: 'info',
        message: `${process.name} has no window to switch to.`,
        detail: 'It may have closed it, or it may only run in the background.',
        offerElevation: false,
      };
    case 'refused':
      return {
        type: 'info',
        message: `Windows would not bring ${process.name} to the front.`,
        detail: codeLines('TM-0007'),
        code: 'TM-0007',
        offerElevation: false,
      };
    case 'notRunning':
    case 'identityChanged':
      return goneReport(process, outcome);
    default:
      return failedReport(process, outcome);
  }
}

/** What to ask before restarting Windows Explorer. */
export function confirmShellRestart(): Confirmation {
  return {
    message: 'Restart Windows Explorer?',
    detail:
      'The taskbar, the desktop and every open File Explorer window close, and come back a few seconds later. Programs you have open are not affected.',
    confirm: 'Restart',
    offerDontAsk: false,
  };
}

/** What to tell the user after restarting Explorer, or null when it came back. */
export function reportShellRestart(outcome: ShellOutcome['outcome'], win32Error?: number): Report | null {
  switch (outcome) {
    case 'restarted':
    case 'started':
      return null;
    case 'noShell':
      return {
        type: 'info',
        message: 'Windows Explorer is not running as the shell right now.',
        detail: 'There was no taskbar to restart.',
        offerElevation: false,
      };
    case 'accessDenied':
      return {
        type: 'warning',
        message: "Windows won't let Task Manager restart Explorer.",
        detail: codeLines('TM-0001'),
        code: 'TM-0001',
        offerElevation: false,
      };
    default:
      return {
        type: 'warning',
        message: 'Windows Explorer did not come back.',
        detail: `${win32Error === undefined ? '' : `Windows error ${win32Error}.\n\n`}${codeLines('TM-0013')}`,
        code: 'TM-0013',
        offerElevation: false,
      };
  }
}

/** What to ask before running a process at realtime priority. */
export function confirmRealtime(process: ProcessSnapshot): Confirmation {
  return {
    message: `Run ${process.name} at realtime priority?`,
    detail:
      "A realtime process runs ahead of every other process, Windows' own included. Microsoft's documentation warns that one busy for more than a moment can stop the mouse from responding and disk caches from flushing.",
    confirm: 'Use realtime',
    offerDontAsk: false,
  };
}

/**
 * What to tell the user after changing a process's priority, Efficiency mode
 * or affinity, or null when it simply worked.
 *
 * `asked` is the priority that was asked for, when one was: Windows can apply
 * a lower one, and saying nothing would leave the user believing otherwise.
 */
export function reportSetting(
  process: ProcessSnapshot,
  outcome: SettingOutcome,
  elevated: boolean,
  asked?: PriorityClassName,
): Report | null {
  switch (outcome.outcome) {
    case 'done':
      if (asked && outcome.priorityClass && outcome.priorityClass !== asked) {
        return {
          type: 'info',
          message: `Windows applied ${priorityLabel(outcome.priorityClass)} instead of ${priorityLabel(asked)}.`,
          detail: `${asked === 'realtime' ? 'Realtime priority needs a privilege only administrators hold. ' : ''}${process.name} is now running at ${priorityLabel(outcome.priorityClass)} priority.\n\n${codeLines('TM-0012')}`,
          code: 'TM-0012',
          offerElevation: asked === 'realtime' && !elevated,
        };
      }
      return null;
    case 'accessDenied':
      return {
        type: 'warning',
        message: `Windows won't let Task Manager change ${process.name}.`,
        detail: `${process.name} runs with more privileges than Task Manager${elevated ? '' : ', which is running without administrator rights'}.\n\n${codeLines('TM-0001')}`,
        code: 'TM-0001',
        offerElevation: !elevated,
      };
    case 'notRunning':
    case 'identityChanged':
      return goneReport(process, { outcome: outcome.outcome });
    default:
      return failedReport(process, { outcome: 'failed', win32Error: outcome.win32Error });
  }
}

function goneReport(process: ProcessSnapshot, outcome: ActionOutcome): Report {
  if (outcome.outcome === 'identityChanged') {
    return {
      type: 'info',
      message: `${process.name} had already exited.`,
      detail: `Windows had given its PID to another program, so nothing was done.\n\n${codeLines('TM-0003')}`,
      code: 'TM-0003',
      offerElevation: false,
    };
  }
  return {
    type: 'info',
    message: `${process.name} is no longer running.`,
    detail: 'It exited before the command reached it.',
    offerElevation: false,
  };
}

function failedReport(process: ProcessSnapshot, outcome: ActionOutcome): Report {
  return {
    type: 'error',
    message: `That did not work for ${process.name}.`,
    detail: `Windows error ${outcome.win32Error ?? 'unknown'}.\n\n${codeLines('TM-0006')}`,
    code: 'TM-0006',
    offerElevation: false,
  };
}
