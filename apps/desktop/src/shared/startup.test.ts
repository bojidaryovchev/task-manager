import { describe, expect, it } from 'vitest';
import {
  APP_USER_MODEL_ID,
  isMachineWide,
  isThisApp,
  readStartupItemId,
  startupDisplayName,
} from './startup.js';

describe("this application's own entry", () => {
  it('is the current user’s Run value named after the app id, and only that', () => {
    expect(isThisApp({ source: 'userRun', name: APP_USER_MODEL_ID })).toBe(true);
    expect(isThisApp({ source: 'machineRun', name: APP_USER_MODEL_ID })).toBe(false);
    expect(isThisApp({ source: 'userRun', name: 'Steam' })).toBe(false);
  });

  it('is shown as Task Manager, whatever the launcher calls itself', () => {
    expect(
      startupDisplayName({
        source: 'userRun',
        name: APP_USER_MODEL_ID,
        command: '"C:\\Tools\\TaskManager-0.1.0-x64.exe" --hidden',
        programExists: true,
        description: 'Task Manager desktop application',
        status: 'enabled',
        thisApp: true,
      }),
    ).toBe('Task Manager');
  });
});

describe('startup entry ids from a renderer', () => {
  it('accepts a known source and a name', () => {
    expect(readStartupItemId({ source: 'userRun', name: 'Steam' })).toEqual({
      source: 'userRun',
      name: 'Steam',
    });
  });

  it('refuses an unknown source, an empty or oversized name, or control characters', () => {
    expect(readStartupItemId({ source: 'services', name: 'Steam' })).toBeNull();
    expect(readStartupItemId({ source: 'userRun', name: '' })).toBeNull();
    expect(readStartupItemId({ source: 'userRun', name: 'x'.repeat(16_384) })).toBeNull();
    expect(readStartupItemId({ source: 'userRun', name: 'a\u0000b' })).toBeNull();
    expect(readStartupItemId(null)).toBeNull();
  });
});

describe('startup entries', () => {
  it('needs administrator rights only for what starts for every user', () => {
    expect(isMachineWide('userRun')).toBe(false);
    expect(isMachineWide('userFolder')).toBe(false);
    expect(isMachineWide('machineRun')).toBe(true);
    expect(isMachineWide('machineRun32')).toBe(true);
    expect(isMachineWide('commonFolder')).toBe(true);
  });

  it('is named by its program when the program names itself', () => {
    const base = {
      source: 'userRun' as const,
      command: 'x',
      programExists: true,
      status: 'enabled' as const,
    };
    expect(startupDisplayName({ ...base, name: 'SecurityHealth', description: 'Windows Security notification icon' })).toBe(
      'Windows Security notification icon',
    );
    expect(startupDisplayName({ ...base, name: 'Steam', description: '  ' })).toBe('Steam');
    expect(startupDisplayName({ ...base, name: 'Steam' })).toBe('Steam');
  });
});
