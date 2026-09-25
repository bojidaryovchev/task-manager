import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { SettingsStore } from './settings-store.js';

/**
 * The settings file is read at every launch and may have been written by an
 * older version, edited by hand, or damaged. Whatever is in it, the store has
 * to come up with something sensible - and say so when it could not read it.
 */

let directory: string;
let path: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'tm-settings-'));
  path = join(directory, 'settings.json');
});

describe('tray settings', () => {
  it('default to how Windows Task Manager behaves', () => {
    const store = new SettingsStore(path);
    expect(store.tray).toEqual({ liveIcon: true, hideWhenMinimized: true, closeToTray: true });
  });

  it('are picked up by a settings file written before they existed', () => {
    // An upgrade must not switch a new feature off just because the old file
    // never mentioned it.
    writeFileSync(path, JSON.stringify({ widget: {}, history: { enabled: true } }), 'utf8');
    expect(new SettingsStore(path).tray).toEqual({
      liveIcon: true,
      hideWhenMinimized: true,
      closeToTray: true,
    });
  });

  it('respect an explicit choice to turn either one off', () => {
    writeFileSync(path, JSON.stringify({ tray: { liveIcon: false, closeToTray: false } }), 'utf8');
    expect(new SettingsStore(path).tray).toEqual({
      liveIcon: false,
      hideWhenMinimized: true,
      closeToTray: false,
    });
  });

  it('only switch off for a real false, not a stray value', () => {
    writeFileSync(
      path,
      JSON.stringify({ tray: { liveIcon: 'no', hideWhenMinimized: 0, closeToTray: null } }),
      'utf8',
    );
    expect(new SettingsStore(path).tray).toEqual({
      liveIcon: true,
      hideWhenMinimized: true,
      closeToTray: true,
    });
  });

  it('survive a restart', () => {
    const first = new SettingsStore(path);
    first.updateTray({ hideWhenMinimized: false });
    first.flush();
    expect(new SettingsStore(path).tray).toEqual({
      liveIcon: true,
      hideWhenMinimized: false,
      closeToTray: true,
    });
    expect(JSON.parse(readFileSync(path, 'utf8')).tray.hideWhenMinimized).toBe(false);
  });
});

describe('reading the file', () => {
  it('treats a missing file as a first run, not a problem', () => {
    expect(new SettingsStore(path).takeProblems()).toEqual([]);
  });

  it('falls back to defaults on a damaged file and reports it', () => {
    writeFileSync(path, '{ this is not json', 'utf8');
    const store = new SettingsStore(path);
    expect(store.tray.liveIcon).toBe(true);
    const problems = store.takeProblems();
    expect(problems.map((problem) => problem.code)).toEqual(['TM-4001']);
    // Reported once, not every time someone asks.
    expect(store.takeProblems()).toEqual([]);
  });
});
