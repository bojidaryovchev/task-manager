import type { MenuItemConstructorOptions } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import type { StartupItem } from '@shared/startup.js';
import {
  buildStartupMenu,
  describeStartupItem,
  reportStartupChange,
  type StartupMenuHandlers,
} from './startup-menu.js';

function item(overrides: Partial<StartupItem> = {}): StartupItem {
  return {
    source: 'userRun',
    name: 'Steam',
    command: '"C:\\Program Files (x86)\\Steam\\steam.exe" -silent',
    programPath: 'C:\\Program Files (x86)\\Steam\\steam.exe',
    programExists: true,
    description: 'Steam',
    publisher: 'Valve Corporation',
    status: 'enabled',
    ...overrides,
  };
}

function handlers(): StartupMenuHandlers {
  return {
    setEnabled: vi.fn(),
    openLocation: vi.fn(),
    properties: vi.fn(),
    searchOnline: vi.fn(),
    copy: vi.fn(),
  };
}

function labels(items: MenuItemConstructorOptions[]): string[] {
  return items.filter((entry) => entry.type !== 'separator').map((entry) => String(entry.label));
}

function find(items: MenuItemConstructorOptions[], label: string): MenuItemConstructorOptions {
  const found = items.find((entry) => entry.label === label);
  if (!found) throw new Error(`no "${label}" in ${labels(items).join(', ')}`);
  return found;
}

describe('the startup menu', () => {
  it('offers the opposite of what an entry is', () => {
    expect(labels(buildStartupMenu({ item: item(), elevated: false }, handlers()))[0]).toBe('Disable');
    expect(
      labels(buildStartupMenu({ item: item({ status: 'disabled' }), elevated: false }, handlers()))[0],
    ).toBe('Enable');
  });

  it('offers both when Windows’ record is in an unknown form', () => {
    const menu = buildStartupMenu({ item: item({ status: 'unknown' }), elevated: false }, handlers());
    expect(labels(menu).slice(0, 2)).toEqual(['Enable', 'Disable']);
  });

  it('says a machine-wide entry needs administrator, and still offers it', () => {
    const menu = buildStartupMenu(
      { item: item({ source: 'machineRun' }), elevated: false },
      handlers(),
    );
    expect(find(menu, 'Disable (needs administrator)').enabled).not.toBe(false);
    const elevated = buildStartupMenu({ item: item({ source: 'machineRun' }), elevated: true }, handlers());
    expect(labels(elevated)[0]).toBe('Disable');
  });

  it('cannot show a program that is not there', () => {
    const menu = buildStartupMenu(
      { item: item({ programExists: false }), elevated: false },
      handlers(),
    );
    expect(find(menu, 'Open file location').enabled).toBe(false);
    expect(find(menu, 'Properties').enabled).toBe(false);
  });

  it('shows a Startup folder item by its own file', () => {
    const menu = buildStartupMenu(
      {
        item: item({
          source: 'userFolder',
          name: 'Notes.lnk',
          command: 'C:\\Users\\a\\Start Menu\\Programs\\Startup\\Notes.lnk',
          programPath: undefined,
          programExists: false,
        }),
        elevated: false,
      },
      handlers(),
    );
    expect(find(menu, 'Open file location').enabled).toBe(true);
  });

  it('switches the way it says', () => {
    const calls = handlers();
    const menu = buildStartupMenu({ item: item(), elevated: false }, calls);
    find(menu, 'Disable').click?.({} as never, undefined, {} as never);
    expect(calls.setEnabled).toHaveBeenCalledWith(false);
  });
});

describe('reporting a change', () => {
  it('says nothing when it worked', () => {
    expect(reportStartupChange(item(), false, { outcome: 'done' }, false)).toBeNull();
  });

  it('explains a machine-wide refusal and offers administrator rights', () => {
    const report = reportStartupChange(item({ source: 'machineRun' }), false, { outcome: 'accessDenied' }, false);
    expect(report?.message).toBe('Only administrators can disable Steam, because it starts for every user.');
    expect(report?.code).toBe('TM-0023');
    expect(report?.offerElevation).toBe(true);
  });

  it('gives the Windows error when the write failed', () => {
    const report = reportStartupChange(item(), true, { outcome: 'failed', win32Error: 1018 }, true);
    expect(report?.detail).toContain('Windows error 1018.');
    expect(report?.code).toBe('TM-0025');
  });
});

describe('copying an entry', () => {
  it('writes when it was disabled, and what it runs', () => {
    const text = describeStartupItem(
      item({ status: 'disabled', disabledAtUnixMs: Date.UTC(2025, 8, 20, 15, 45, 42) }),
    );
    expect(text).toContain('Status: Disabled on 2025-09-20T15:45:42.000Z');
    expect(text).toContain('Location: Registry (you)');
    expect(text).toContain('Command: "C:\\Program Files (x86)\\Steam\\steam.exe" -silent');
  });
});
