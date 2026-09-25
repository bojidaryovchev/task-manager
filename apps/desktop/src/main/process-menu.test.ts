import type { MenuItemConstructorOptions } from 'electron';
import type { ProcessSnapshot } from '@task-manager/telemetry-types';
import { describe, expect, it, vi } from 'vitest';
import type { ProcessState } from '@shared/process-actions.js';
import {
  buildProcessMenu,
  confirmEnding,
  confirmRealtime,
  descendantsOf,
  describeForClipboard,
  reportClosing,
  reportEnding,
  reportSetting,
  reportShellRestart,
  reportSwitching,
  type MenuTarget,
  type ProcessMenuHandlers,
  type ProcessMenuModel,
} from './process-menu.js';

/**
 * The process menu is where this application can do real damage, so what it
 * offers, how it asks and what it says afterwards are all pinned down here.
 */

let nextPid = 1000;
function process(overrides: Partial<ProcessSnapshot> = {}): ProcessSnapshot {
  const pid = overrides.pid ?? (nextPid += 4);
  return {
    key: `${pid}:133700000000000000`,
    pid,
    parentPid: 4,
    name: 'app.exe',
    createTime100ns: 133700000000000000,
    createTimeUnixMs: 1_700_000_000_000,
    sessionId: 1,
    basePriority: 8,
    kernelTime100ns: 0,
    userTime100ns: 0,
    workingSetBytes: 0,
    privateWorkingSetBytes: 0,
    privateCommitBytes: 0,
    peakWorkingSetBytes: 0,
    pagedPoolBytes: 0,
    nonPagedPoolBytes: 0,
    virtualSizeBytes: 0,
    pageFaultCount: 0,
    hardFaultCount: 0,
    threadCount: 1,
    handleCount: 1,
    ioReadBytes: 0,
    ioWriteBytes: 0,
    ioOtherBytes: 0,
    ioReadOperations: 0,
    ioWriteOperations: 0,
    ioOtherOperations: 0,
    imagePath: 'C:\\Program Files\\App\\app.exe',
    ...overrides,
  };
}

function state(overrides: Partial<ProcessState> = {}): ProcessState {
  return {
    status: 'running',
    canEnd: true,
    canAdjust: true,
    isCritical: false,
    windowCount: 0,
    isShell: false,
    priorityClass: 'normal',
    ...overrides,
  };
}

function target(processOverrides: Partial<ProcessSnapshot> = {}, stateOverrides: Partial<ProcessState> = {}): MenuTarget {
  return { process: process(processOverrides), state: state(stateOverrides) };
}

function handlers(): ProcessMenuHandlers {
  return {
    end: vi.fn(),
    endTree: vi.fn(),
    closeWindows: vi.fn(),
    switchTo: vi.fn(),
    openLocation: vi.fn(),
    properties: vi.fn(),
    searchOnline: vi.fn(),
    copy: vi.fn(),
    goToParent: vi.fn(),
    setPriority: vi.fn(),
    setEfficiency: vi.fn(),
    affinity: vi.fn(),
    restartShell: vi.fn(),
  };
}

function model(targets: MenuTarget[], overrides: Partial<ProcessMenuModel> = {}): ProcessMenuModel {
  return { targets, context: 'processes', descendants: [], elevated: false, ...overrides };
}

function labels(items: MenuItemConstructorOptions[]): string[] {
  return items.filter((item) => item.type !== 'separator').map((item) => String(item.label));
}

function item(items: MenuItemConstructorOptions[], label: string): MenuItemConstructorOptions {
  const found = items.find((entry) => entry.label === label);
  if (!found) throw new Error(`no "${label}" in ${labels(items).join(', ')}`);
  return found;
}

describe('the process menu', () => {
  it('offers ending a process it may end, with the Delete key shown', () => {
    const menu = buildProcessMenu(model([target()]), handlers());
    const end = item(menu, 'End task');
    expect(end.enabled).not.toBe(false);
    expect(end.accelerator).toBe('Delete');
    // Shown only: the page handles Delete itself, even with the menu closed.
    expect(end.registerAccelerator).toBe(false);
  });

  it('refuses outright to end a process critical to Windows', () => {
    const menu = buildProcessMenu(model([target({}, { isCritical: true, canEnd: true })]), handlers());
    expect(item(menu, 'End task (critical to Windows)').enabled).toBe(false);
  });

  it('says a protected process cannot be ended by anyone', () => {
    const menu = buildProcessMenu(
      model([target({ isProtected: true }, { canEnd: false })], { elevated: true }),
      handlers(),
    );
    expect(item(menu, 'End task (protected by Windows)').enabled).toBe(false);
  });

  it('still offers a process that needs administrator, so choosing it can explain', () => {
    const menu = buildProcessMenu(model([target({}, { canEnd: false })]), handlers());
    expect(item(menu, 'End task (needs administrator)').enabled).not.toBe(false);
  });

  it('offers switching and closing only for a process with windows', () => {
    expect(labels(buildProcessMenu(model([target()]), handlers()))).not.toContain('Switch to');
    const withWindows = buildProcessMenu(model([target({}, { windowCount: 2 })]), handlers());
    expect(labels(withWindows)).toContain('Switch to');
    expect(labels(withWindows)).toContain('Close 2 windows');
  });

  it('offers the process tree with its size, when the process started others', () => {
    const menu = buildProcessMenu(
      model([target()], { descendants: [process(), process()] }),
      handlers(),
    );
    expect(labels(menu)).toContain('End process tree (3 processes)');
    expect(labels(buildProcessMenu(model([target()]), handlers()))).not.toContain(
      'End process tree (1 processes)',
    );
  });

  it('names the count when several processes are selected', () => {
    const menu = buildProcessMenu(model([target(), target(), target()]), handlers());
    expect(labels(menu)).toContain('End 3 processes');
    // File commands are about one file; with three selected there is no one file.
    expect(labels(menu)).not.toContain('Properties');
  });

  it('names the application when the menu is for one', () => {
    const menu = buildProcessMenu(
      model([target(), target()], { context: 'applications', applicationName: 'Google Chrome' }),
      handlers(),
    );
    expect(labels(menu)).toContain('End Google Chrome');
  });

  it('offers only copying for a process that has gone', () => {
    const menu = buildProcessMenu(model([target({ name: 'gone.exe' }, { status: 'notRunning' })]), handlers());
    expect(labels(menu)).toEqual(['gone.exe is no longer running', 'Copy']);
  });

  it('disables file commands when the path could not be read', () => {
    const menu = buildProcessMenu(model([target({ imagePath: undefined })]), handlers());
    expect(item(menu, 'Open file location').enabled).toBe(false);
    expect(item(menu, 'Properties').enabled).toBe(false);
    expect(item(menu, 'Search online').enabled).not.toBe(false);
  });

  it('goes to the parent by name, and only on the Processes page', () => {
    const parent = process({ name: 'explorer.exe' });
    expect(labels(buildProcessMenu(model([target()], { parent }), handlers()))).toContain(
      'Go to parent (explorer.exe)',
    );
    expect(
      labels(buildProcessMenu(model([target()], { parent, context: 'applications' }), handlers())),
    ).not.toContain('Go to parent (explorer.exe)');
  });

  it('copies exactly what each entry says', () => {
    const calls = handlers();
    const menu = buildProcessMenu(model([target({ name: 'x.exe', pid: 4242 })]), calls);
    const copy = item(menu, 'Copy').submenu as MenuItemConstructorOptions[];
    item(copy, 'PID').click?.({} as never, undefined, {} as never);
    expect(calls.copy).toHaveBeenCalledWith('4242');
  });
});

describe('priority, Efficiency mode and affinity', () => {
  it("lists the priorities in Task Manager's order, with the current one ticked", () => {
    const menu = buildProcessMenu(model([target({}, { priorityClass: 'high' })]), handlers());
    const submenu = item(menu, 'Set priority').submenu as MenuItemConstructorOptions[];
    expect(labels(submenu)).toEqual(['Realtime', 'High', 'Above normal', 'Normal', 'Below normal', 'Low']);
    expect(submenu.filter((entry) => entry.checked).map((entry) => entry.label)).toEqual(['High']);
  });

  it('ticks Efficiency mode when it is on, and turns it off from there', () => {
    const calls = handlers();
    const menu = buildProcessMenu(model([target({}, { efficiencyMode: true })]), calls);
    const efficiency = item(menu, 'Efficiency mode');
    expect(efficiency.checked).toBe(true);
    efficiency.click?.({} as never, undefined, {} as never);
    expect(calls.setEfficiency).toHaveBeenCalledWith(false);
  });

  it('keeps Efficiency mode away from services and parts of Windows, as Task Manager does', () => {
    const menu = buildProcessMenu(
      model([target({ sessionId: 0 }, { efficiencyMode: false })]),
      handlers(),
    );
    expect(item(menu, 'Efficiency mode (part of Windows)').enabled).toBe(false);
  });

  it('says when changing a process needs administrator', () => {
    const menu = buildProcessMenu(model([target({}, { canAdjust: false })]), handlers());
    expect(item(menu, 'Set priority (needs administrator)').enabled).toBe(false);
    expect(item(menu, 'Set affinity… (needs administrator)').enabled).toBe(false);
  });

  it('offers affinity only when the processors could be read', () => {
    const readable = buildProcessMenu(
      model([target({}, { affinity: [0, 1], processors: [0, 1, 2, 3] })]),
      handlers(),
    );
    expect(item(readable, 'Set affinity…').enabled).toBe(true);
    const unreadable = buildProcessMenu(model([target()]), handlers());
    expect(item(unreadable, 'Set affinity…').enabled).toBe(false);
  });

  it('asks before realtime, and says why it is dangerous', () => {
    const asked = confirmRealtime(process({ name: 'game.exe' }));
    expect(asked.message).toBe('Run game.exe at realtime priority?');
    expect(asked.detail).toContain('mouse');
  });

  it('says so when Windows applies a lower priority than asked', () => {
    const report = reportSetting(
      process(),
      { outcome: 'done', priorityClass: 'high' },
      false,
      'realtime',
    );
    expect(report?.code).toBe('TM-0012');
    expect(report?.message).toBe('Windows applied High instead of Realtime.');
    expect(report?.offerElevation).toBe(true);
    expect(reportSetting(process(), { outcome: 'done', priorityClass: 'high' }, false, 'high')).toBeNull();
  });

  it('explains a refused change and offers administrator', () => {
    const report = reportSetting(process(), { outcome: 'accessDenied' }, false);
    expect(report?.code).toBe('TM-0001');
    expect(report?.offerElevation).toBe(true);
  });
});

describe('restarting Windows Explorer', () => {
  it('is offered for the shell, and only the shell', () => {
    expect(labels(buildProcessMenu(model([target({}, { isShell: true })]), handlers()))).toContain('Restart');
    expect(labels(buildProcessMenu(model([target()]), handlers()))).not.toContain('Restart');
  });

  it('is quiet when the shell comes back, and explains when it does not', () => {
    expect(reportShellRestart('restarted')).toBeNull();
    expect(reportShellRestart('started')).toBeNull();
    expect(reportShellRestart('notStarted')?.code).toBe('TM-0013');
  });
});

describe('asking before ending', () => {
  it('names the process, where it lives and what is lost', () => {
    const asked = confirmEnding('task', [
      process({ name: 'notepad.exe', pid: 12, fileDescription: 'Notepad', imagePath: 'C:\\n.exe' }),
    ]);
    expect(asked.message).toBe('End notepad.exe?');
    expect(asked.detail).toContain('Notepad · PID 12');
    expect(asked.detail).toContain('C:\\n.exe');
    expect(asked.detail).toContain('not saved is lost');
    expect(asked.offerDontAsk).toBe(true);
  });

  it('never offers "don\'t ask again" for more than one process', () => {
    for (const kind of ['tree', 'several', 'application'] as const) {
      expect(confirmEnding(kind, [process(), process()], 'App').offerDontAsk).toBe(false);
    }
  });

  it('counts what a tree takes with it, grouped by name', () => {
    const asked = confirmEnding('tree', [
      process({ name: 'chrome.exe' }),
      process({ name: 'chrome.exe' }),
      process({ name: 'chrome.exe' }),
      process({ name: 'crashpad.exe' }),
    ]);
    expect(asked.message).toBe('End chrome.exe and the 3 processes it started?');
    expect(asked.detail).toContain('chrome.exe × 3');
    expect(asked.detail).toContain('crashpad.exe');
  });

  it('keeps a long list readable', () => {
    const many = Array.from({ length: 12 }, (_, index) => process({ name: `p${index}.exe` }));
    expect(confirmEnding('several', many).detail).toContain('and 4 more');
  });

  it('cautions about services and parts of Windows, as Task Manager does', () => {
    expect(confirmEnding('task', [process({ sessionId: 0 })]).detail).toContain(
      'may make Windows unstable',
    );
    expect(confirmEnding('task', [process({ sessionId: 1 })]).detail).not.toContain('unstable');
    expect(
      confirmEnding('several', [process({ sessionId: 0 }), process({ sessionId: 1 })]).detail,
    ).toContain('1 of them are part of Windows or services, and ending it may make');
  });

  it('uses no dashes in anything it says', () => {
    const asked = confirmEnding('application', [process(), process()], 'App');
    expect(`${asked.message}${asked.detail}${asked.confirm}`).not.toMatch(/[–—]/);
  });
});

describe('reporting what happened', () => {
  it('says nothing when everything is gone', () => {
    expect(
      reportEnding(
        [
          { process: process(), outcome: { outcome: 'ended' } },
          { process: process(), outcome: { outcome: 'notRunning' } },
        ],
        false,
      ),
    ).toBeNull();
  });

  it('explains a refusal and offers administrator only when it would help', () => {
    const refused = reportEnding([{ process: process(), outcome: { outcome: 'accessDenied' } }], false);
    expect(refused?.code).toBe('TM-0001');
    expect(refused?.offerElevation).toBe(true);
    const already = reportEnding([{ process: process(), outcome: { outcome: 'accessDenied' } }], true);
    expect(already?.offerElevation).toBe(false);
  });

  it('tells a protected process apart from one that needs administrator', () => {
    const report = reportEnding(
      [{ process: process({ isProtected: true }), outcome: { outcome: 'accessDenied' } }],
      false,
    );
    expect(report?.code).toBe('TM-0002');
    expect(report?.offerElevation).toBe(false);
  });

  it('gives each outcome its own code', () => {
    const cases = [
      ['identityChanged', 'TM-0003'],
      ['critical', 'TM-0004'],
      ['stillExiting', 'TM-0005'],
      ['failed', 'TM-0006'],
    ] as const;
    for (const [outcome, code] of cases) {
      expect(reportEnding([{ process: process(), outcome: { outcome } }], false)?.code).toBe(code);
    }
  });

  it('summarises several failures by cause', () => {
    const report = reportEnding(
      [
        { process: process(), outcome: { outcome: 'ended' } },
        { process: process({ name: 'svc.exe' }), outcome: { outcome: 'accessDenied' } },
        { process: process({ name: 'svc.exe' }), outcome: { outcome: 'accessDenied' } },
      ],
      false,
    );
    expect(report?.message).toBe('Ended 1 of 3 processes.');
    expect(report?.detail).toContain('TM-0001');
    expect(report?.detail).toContain('svc.exe × 2');
    expect(report?.offerElevation).toBe(true);
  });

  it('stays quiet after a close request, since the program decides the rest', () => {
    expect(reportClosing(process(), { outcome: 'requested', count: 1 }, false)).toBeNull();
    expect(reportClosing(process(), { outcome: 'accessDenied' }, false)?.code).toBe('TM-0008');
  });

  it('reports a window Windows would not bring forward', () => {
    expect(reportSwitching(process(), { outcome: 'done' })).toBeNull();
    expect(reportSwitching(process(), { outcome: 'refused' })?.code).toBe('TM-0007');
  });
});

describe('a process tree', () => {
  it('follows parent links through every generation', () => {
    const root = process({ name: 'root.exe' });
    const child = process({ parentKey: root.key });
    const grandchild = process({ parentKey: child.key });
    const unrelated = process();
    expect(descendantsOf([root, child, grandchild, unrelated], root.key)).toEqual([child, grandchild]);
  });

  it('cannot loop, even on links that do', () => {
    const a = process();
    const b = process({ parentKey: a.key });
    const looped = { ...a, parentKey: b.key };
    expect(descendantsOf([looped, b], a.key)).toEqual([b]);
  });
});

describe('copying a process', () => {
  it('writes only the fields it knows', () => {
    const text = describeForClipboard(process({ name: 'a.exe', pid: 8, userName: undefined }));
    expect(text).toContain('Name: a.exe');
    expect(text).toContain('PID: 8');
    expect(text).not.toContain('User:');
  });
});
