import type { MenuItemConstructorOptions } from 'electron';
import type { ServiceSnapshot } from '@task-manager/telemetry-types';
import {
  SERVICE_STATE_LABELS,
  startTypeLabel,
  type ServiceName,
  type ServiceOutcome,
  type ServiceState,
} from '@shared/services.js';
import { codeLines, type Confirmation, type Report } from './process-menu.js';

/**
 * The service menu and everything it says: which commands it offers, when it
 * asks first, and how it reports what happened.
 *
 * Pure, like the process menu, so every label, question and report can be
 * tested without Electron or a real service. `service-actions.ts` supplies the
 * live state and does the work.
 *
 * Stopping a service asks first only when other services would stop with it,
 * as the Services console does. Otherwise it is as reversible as starting.
 */

export interface ServiceMenuModel {
  /** The service as the page shows it. */
  service: ServiceSnapshot;
  /** What Windows says about it right now. */
  state: ServiceState;
  /** This application is running as administrator. */
  elevated: boolean;
}

export interface ServiceMenuHandlers {
  start(): void;
  stop(): void;
  restart(): void;
  goToProcess(): void;
  openServices(): void;
  searchOnline(): void;
  copy(text: string): void;
}

/** Build the menu. */
export function buildServiceMenu(
  model: ServiceMenuModel,
  handlers: ServiceMenuHandlers,
): MenuItemConstructorOptions[] {
  const { service, state, elevated } = model;
  if (state.state === 'notFound') {
    return [
      { label: `${service.displayName} no longer exists`, enabled: false },
      { type: 'separator' },
      copyMenu(service, handlers),
    ];
  }

  const stopped = state.state === 'stopped';
  const running = !stopped && state.state !== 'unknown';
  // An action that rights alone stand in the way of is offered anyway without
  // administrator rights: choosing it explains, and offers the way through.
  // One that is off for another reason says nothing about rights.
  const allowed = (applies: boolean, granted: boolean): { suffix: string; enabled: boolean } => {
    if (!applies) return { suffix: '', enabled: false };
    if (granted) return { suffix: '', enabled: true };
    return elevated
      ? { suffix: ' (Windows refuses)', enabled: false }
      : { suffix: ' (needs administrator)', enabled: true };
  };

  const canStart = allowed(stopped && !state.disabled, state.canStart);
  const start: MenuItemConstructorOptions =
    stopped && state.disabled
      ? { label: 'Start (disabled)', enabled: false }
      : { label: `Start${canStart.suffix}`, enabled: canStart.enabled, click: handlers.start };
  const stoppable = running && state.acceptsStop;
  const canStop = allowed(stoppable, state.canStop);
  const stop: MenuItemConstructorOptions =
    running && !state.acceptsStop
      ? { label: 'Stop (not stoppable)', enabled: false }
      : { label: `Stop${canStop.suffix}`, enabled: canStop.enabled, click: handlers.stop };
  const canRestart = allowed(stoppable && !state.disabled, state.canStop && state.canStart);
  const restart: MenuItemConstructorOptions = {
    label: `Restart${canRestart.suffix}`,
    enabled: canRestart.enabled,
    click: handlers.restart,
  };

  const items: MenuItemConstructorOptions[] = [start, stop, restart, { type: 'separator' }];
  if (state.pid !== undefined) {
    items.push({ label: `Go to process (PID ${state.pid})`, click: handlers.goToProcess });
  }
  items.push(
    { label: 'Open Services', click: handlers.openServices },
    { label: 'Search online', click: handlers.searchOnline },
    { type: 'separator' },
    copyMenu(service, handlers),
  );
  return items;
}

function copyMenu(service: ServiceSnapshot, handlers: ServiceMenuHandlers): MenuItemConstructorOptions {
  const submenu: MenuItemConstructorOptions[] = [
    { label: 'Name', click: () => handlers.copy(service.name) },
    { label: 'Display name', click: () => handlers.copy(service.displayName) },
  ];
  if (service.binaryPath) {
    const path = service.binaryPath;
    submenu.push({ label: 'Path to executable', click: () => handlers.copy(path) });
  }
  if (service.description) {
    const description = service.description;
    submenu.push({ label: 'Description', click: () => handlers.copy(description) });
  }
  submenu.push(
    { type: 'separator' },
    { label: 'All details', click: () => handlers.copy(describeServiceForClipboard(service)) },
  );
  return { label: 'Copy', submenu };
}

/** A service as plain text, for pasting into a message or a bug report. */
export function describeServiceForClipboard(service: ServiceSnapshot): string {
  const lines: [string, string | number | undefined][] = [
    ['Name', service.name],
    ['Display name', service.displayName],
    ['Status', SERVICE_STATE_LABELS[service.state]],
    ['PID', service.pid],
    ['Startup type', startTypeLabel(service)],
    ['Log on as', service.account],
    ['Group', service.group],
    ['Path to executable', service.binaryPath],
    ['Description', service.description],
  ];
  return lines
    .filter(([, value]) => value !== undefined && value !== '')
    .map(([label, value]) => `${label}: ${value}`)
    .join('\n');
}

export type ServiceActionKind = 'start' | 'stop' | 'restart';

/**
 * What to ask before stopping or restarting a service that others depend on,
 * or null when nothing else would stop and there is nothing to ask.
 */
export function confirmStopping(
  kind: 'stop' | 'restart',
  service: ServiceName,
  dependents: ServiceName[],
): Confirmation | null {
  if (dependents.length === 0) return null;
  const listed = dependents.map((dependent) => `• ${dependent.displayName}`).join('\n');
  const count = dependents.length === 1 ? 'this service' : `these ${dependents.length} services`;
  return {
    message:
      kind === 'stop'
        ? `Stopping ${service.displayName} also stops ${count}:`
        : `Restarting ${service.displayName} also restarts ${count}:`,
    detail:
      `${listed}\n\n` +
      (kind === 'stop'
        ? 'They depend on it, so they are stopped first.'
        : 'They depend on it, so they are stopped first and started again afterwards.'),
    confirm: kind === 'stop' ? 'Stop services' : 'Restart services',
    offerDontAsk: false,
  };
}

/**
 * What to tell the user after starting, stopping or restarting a service, or
 * null when it simply worked and the list will show it.
 */
export function reportService(
  kind: ServiceActionKind,
  service: ServiceName,
  outcome: ServiceOutcome,
  elevated: boolean,
): Report | null {
  const name = service.displayName;
  const verb = { start: 'start', stop: 'stop', restart: 'restart' }[kind];
  const alsoStopped =
    outcome.stoppedDependents.length > 0
      ? `\n\nStopped along with it: ${outcome.stoppedDependents.join(', ')}.`
      : '';
  switch (outcome.outcome) {
    case 'done':
      if (outcome.notRestarted.length === 0) return null;
      return {
        type: 'warning',
        message: `${name} restarted, but not everything that depends on it did.`,
        detail: `Not started again: ${outcome.notRestarted.join(', ')}.\n\n${codeLines('TM-0021')}`,
        code: 'TM-0021',
        offerElevation: false,
      };
    case 'accessDenied':
      return {
        type: 'warning',
        message: elevated
          ? `Windows refuses to let any application ${verb} ${name}.`
          : `Only administrators can ${verb} ${name}.`,
        detail: `${codeLines('TM-0015')}${alsoStopped}`,
        code: 'TM-0015',
        offerElevation: !elevated,
      };
    case 'notFound':
      return {
        type: 'info',
        message: `${name} no longer exists.`,
        detail: codeLines('TM-0020'),
        code: 'TM-0020',
        offerElevation: false,
      };
    case 'disabled':
      return {
        type: 'info',
        message: `${name} is disabled, so it cannot be started.`,
        detail: `${codeLines('TM-0018')}${alsoStopped}`,
        code: 'TM-0018',
        offerElevation: false,
      };
    case 'cannotStop':
      return {
        type: 'info',
        message: `${name} does not accept being stopped right now.`,
        detail: `${codeLines('TM-0019')}${alsoStopped}`,
        code: 'TM-0019',
        offerElevation: false,
      };
    case 'timedOut':
      return {
        type: 'warning',
        message: `${name} is still ${outcome.state === 'startPending' ? 'starting' : 'stopping'} after 30 seconds.`,
        detail: `${codeLines('TM-0017')}${alsoStopped}`,
        code: 'TM-0017',
        offerElevation: false,
      };
    case 'stoppedWithError':
      return {
        type: 'error',
        message: `${name} started, then stopped.`,
        detail:
          `${outcome.win32Error === undefined ? 'It did not say why.' : `Windows error ${outcome.win32Error}.`}` +
          `\n\n${codeLines('TM-0016')}${alsoStopped}`,
        code: 'TM-0016',
        offerElevation: false,
      };
    case 'dependentsRunning':
    case 'failed':
      return {
        type: 'error',
        message: `${name} could not be ${kind === 'stop' ? 'stopped' : kind === 'start' ? 'started' : 'restarted'}.`,
        detail:
          `${outcome.win32Error === undefined ? '' : `Windows error ${outcome.win32Error}.\n\n`}` +
          `${codeLines('TM-0016')}${alsoStopped}`,
        code: 'TM-0016',
        offerElevation: false,
      };
  }
}
