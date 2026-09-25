import { describe, expect, it } from 'vitest';
import { isServiceName, readServiceMenuRequest, startTypeLabel } from './services.js';

describe('service names from a renderer', () => {
  it('accepts real key names, including per-user instances', () => {
    expect(isServiceName('Audiosrv')).toBe(true);
    expect(isServiceName('CDPUserSvc_6e85261')).toBe(true);
    expect(isServiceName('Steam Client Service')).toBe(true);
  });

  it('refuses what cannot name a service', () => {
    expect(isServiceName('')).toBe(false);
    expect(isServiceName('a'.repeat(257))).toBe(false);
    expect(isServiceName('..\\x')).toBe(false);
    expect(isServiceName('a/b')).toBe(false);
    expect(isServiceName('a\nb')).toBe(false);
    expect(isServiceName(42)).toBe(false);
  });

  it('reads a menu request, or nothing', () => {
    expect(readServiceMenuRequest({ name: 'Audiosrv' })).toEqual({ name: 'Audiosrv' });
    expect(readServiceMenuRequest({ name: '' })).toBeNull();
    expect(readServiceMenuRequest(null)).toBeNull();
    expect(readServiceMenuRequest('Audiosrv')).toBeNull();
  });
});

describe('start types, in the words of the Services console', () => {
  it('adds delayed and trigger starts in brackets', () => {
    expect(startTypeLabel({ startType: 'automatic', delayedAutoStart: true })).toBe(
      'Automatic (Delayed Start)',
    );
    expect(startTypeLabel({ startType: 'manual', triggerStart: true })).toBe('Manual (Trigger Start)');
    expect(
      startTypeLabel({ startType: 'automatic', delayedAutoStart: true, triggerStart: true }),
    ).toBe('Automatic (Delayed Start, Trigger Start)');
  });

  it('never calls a manual service delayed, and says nothing when unread', () => {
    expect(startTypeLabel({ startType: 'manual', delayedAutoStart: true })).toBe('Manual');
    expect(startTypeLabel({})).toBeUndefined();
  });
});
