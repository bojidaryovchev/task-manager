import { describe, expect, it } from 'vitest';
import { isMachineWide, readStartupItemId, startupDisplayName } from './startup.js';

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
