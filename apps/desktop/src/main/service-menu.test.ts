import type { MenuItemConstructorOptions } from 'electron';
import type { ServiceSnapshot } from '@task-manager/telemetry-types';
import { describe, expect, it, vi } from 'vitest';
import type { ServiceOutcome, ServiceState } from '@shared/services.js';
import {
  buildServiceMenu,
  confirmStopping,
  describeServiceForClipboard,
  reportService,
  type ServiceMenuHandlers,
  type ServiceMenuModel,
} from './service-menu.js';

/**
 * Stopping the wrong service, or stopping others along with it unasked, is
 * the damage this menu could do, so what it offers and asks is pinned here.
 */

function service(overrides: Partial<ServiceSnapshot> = {}): ServiceSnapshot {
  return {
    name: 'Audiosrv',
    displayName: 'Windows Audio',
    state: 'running',
    pid: 4242,
    startType: 'automatic',
    delayedAutoStart: false,
    triggerStart: false,
    group: 'LocalServiceNetworkRestricted',
    binaryPath: 'C:\\WINDOWS\\System32\\svchost.exe -k LocalServiceNetworkRestricted -p',
    account: 'NT AUTHORITY\\LocalService',
    description: 'Manages audio for Windows-based programs.',
    ...overrides,
  };
}

function state(overrides: Partial<ServiceState> = {}): ServiceState {
  return {
    state: 'running',
    pid: 4242,
    canStart: true,
    canStop: true,
    acceptsStop: true,
    disabled: false,
    runningDependents: [],
    ...overrides,
  };
}

function handlers(): ServiceMenuHandlers {
  return {
    start: vi.fn(),
    stop: vi.fn(),
    restart: vi.fn(),
    goToProcess: vi.fn(),
    openServices: vi.fn(),
    searchOnline: vi.fn(),
    copy: vi.fn(),
  };
}

function menu(
  stateOverrides: Partial<ServiceState> = {},
  model: Partial<ServiceMenuModel> = {},
  serviceOverrides: Partial<ServiceSnapshot> = {},
): MenuItemConstructorOptions[] {
  return buildServiceMenu(
    { service: service(serviceOverrides), state: state(stateOverrides), elevated: true, ...model },
    handlers(),
  );
}

function labels(items: MenuItemConstructorOptions[]): string[] {
  return items.filter((item) => item.type !== 'separator').map((item) => String(item.label));
}

function item(items: MenuItemConstructorOptions[], label: string): MenuItemConstructorOptions {
  const found = items.find((entry) => entry.label === label);
  if (!found) throw new Error(`no "${label}" in ${labels(items).join(', ')}`);
  return found;
}

describe('the service menu', () => {
  it('offers stopping and restarting a running service, not starting it', () => {
    const items = menu();
    expect(item(items, 'Start').enabled).toBe(false);
    expect(item(items, 'Stop').enabled).toBe(true);
    expect(item(items, 'Restart').enabled).toBe(true);
  });

  it('offers only starting a stopped one', () => {
    const items = menu({ state: 'stopped', pid: undefined, acceptsStop: false });
    expect(item(items, 'Start').enabled).toBe(true);
    expect(item(items, 'Stop').enabled).toBe(false);
    expect(item(items, 'Restart').enabled).toBe(false);
  });

  it('says a disabled service cannot be started', () => {
    const items = menu({ state: 'stopped', disabled: true, acceptsStop: false });
    expect(item(items, 'Start (disabled)').enabled).toBe(false);
  });

  it('says a service that does not accept stopping cannot be stopped', () => {
    const items = menu({ acceptsStop: false });
    expect(item(items, 'Stop (not stoppable)').enabled).toBe(false);
    expect(item(items, 'Restart').enabled).toBe(false);
  });

  it('still offers what needs administrator, so choosing it can explain', () => {
    const items = menu({ canStop: false, canStart: false }, { elevated: false });
    expect(item(items, 'Stop (needs administrator)').enabled).toBe(true);
    expect(item(items, 'Restart (needs administrator)').enabled).toBe(true);
    // Starting a running service is off for another reason, and says nothing
    // about rights.
    expect(item(items, 'Start').enabled).toBe(false);
  });

  it('says nothing about rights for what the service itself rules out', () => {
    const items = menu({ canStop: false, canStart: false, acceptsStop: false }, { elevated: false });
    expect(item(items, 'Stop (not stoppable)').enabled).toBe(false);
    expect(item(items, 'Restart').enabled).toBe(false);
  });

  it('greys out what Windows refuses even to an administrator', () => {
    const items = menu({ canStop: false }, { elevated: true });
    expect(item(items, 'Stop (Windows refuses)').enabled).toBe(false);
  });

  it('goes to the process only when there is one', () => {
    expect(labels(menu())).toContain('Go to process (PID 4242)');
    expect(labels(menu({ state: 'stopped', pid: undefined }))).not.toContain(
      'Go to process (PID 4242)',
    );
  });

  it('offers only copying for a service that has been removed', () => {
    expect(labels(menu({ state: 'notFound' }))).toEqual(['Windows Audio no longer exists', 'Copy']);
  });

  it('copies exactly what each entry says', () => {
    const calls = handlers();
    const items = buildServiceMenu({ service: service(), state: state(), elevated: true }, calls);
    const copy = item(items, 'Copy').submenu as MenuItemConstructorOptions[];
    item(copy, 'Name').click?.({} as never, undefined, {} as never);
    expect(calls.copy).toHaveBeenCalledWith('Audiosrv');
  });
});

describe('asking before stopping', () => {
  const audio = { name: 'Audiosrv', displayName: 'Windows Audio' };

  it('asks nothing when no other service would stop', () => {
    expect(confirmStopping('stop', audio, [])).toBeNull();
  });

  it('names every service that would stop with it', () => {
    const question = confirmStopping('stop', audio, [
      { name: 'a', displayName: 'Alpha' },
      { name: 'b', displayName: 'Beta' },
    ]);
    expect(question?.message).toBe('Stopping Windows Audio also stops these 2 services:');
    expect(question?.detail).toContain('• Alpha\n• Beta');
    expect(question?.confirm).toBe('Stop services');
  });

  it('says a restart brings them back', () => {
    const question = confirmStopping('restart', audio, [{ name: 'a', displayName: 'Alpha' }]);
    expect(question?.message).toBe('Restarting Windows Audio also restarts this service:');
    expect(question?.detail).toContain('started again afterwards');
  });
});

describe('reporting what happened', () => {
  const audio = { name: 'Audiosrv', displayName: 'Windows Audio' };
  const outcome = (overrides: Partial<ServiceOutcome>): ServiceOutcome => ({
    outcome: 'done',
    stoppedDependents: [],
    notRestarted: [],
    ...overrides,
  });

  it('says nothing when it simply worked', () => {
    expect(reportService('stop', audio, outcome({}), false)).toBeNull();
  });

  it('offers administrator rights for a refusal, when it would help', () => {
    const report = reportService('stop', audio, outcome({ outcome: 'accessDenied' }), false);
    expect(report?.message).toBe('Only administrators can stop Windows Audio.');
    expect(report?.code).toBe('TM-0015');
    expect(report?.offerElevation).toBe(true);
    const elevated = reportService('stop', audio, outcome({ outcome: 'accessDenied' }), true);
    expect(elevated?.offerElevation).toBe(false);
  });

  it('names the dependents that did not come back after a restart', () => {
    const report = reportService('restart', audio, outcome({ notRestarted: ['Alpha'] }), true);
    expect(report?.code).toBe('TM-0021');
    expect(report?.detail).toContain('Not started again: Alpha.');
  });

  it('gives the Windows error when a service stops right after starting', () => {
    const report = reportService(
      'start',
      audio,
      outcome({ outcome: 'stoppedWithError', win32Error: 1067 }),
      true,
    );
    expect(report?.message).toBe('Windows Audio started, then stopped.');
    expect(report?.detail).toContain('Windows error 1067.');
    expect(report?.code).toBe('TM-0016');
  });

  it('says which way a timed-out service was going', () => {
    const starting = reportService('start', audio, outcome({ outcome: 'timedOut', state: 'startPending' }), true);
    expect(starting?.message).toBe('Windows Audio is still starting after 30 seconds.');
    const stopping = reportService('stop', audio, outcome({ outcome: 'timedOut', state: 'stopPending' }), true);
    expect(stopping?.message).toBe('Windows Audio is still stopping after 30 seconds.');
  });

  it('lists what was stopped along the way when something failed', () => {
    const report = reportService(
      'stop',
      audio,
      outcome({ outcome: 'cannotStop', stoppedDependents: ['Alpha'] }),
      true,
    );
    expect(report?.detail).toContain('Stopped along with it: Alpha.');
  });
});

describe('copying a service', () => {
  it('writes every known detail, and skips what is not known', () => {
    const text = describeServiceForClipboard(
      service({ delayedAutoStart: true, triggerStart: true, account: undefined }),
    );
    expect(text).toContain('Name: Audiosrv');
    expect(text).toContain('Startup type: Automatic (Delayed Start, Trigger Start)');
    expect(text).not.toContain('Log on as');
  });
});
