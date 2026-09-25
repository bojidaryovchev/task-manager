import type { ServiceSnapshot } from '@task-manager/telemetry-types';

/**
 * Starting and stopping services: the types main, preload and renderer share.
 *
 * As with processes, the page never acts. It asks the main process to show the
 * menu for a service, and the main process owns the menu, any question, the
 * call into Windows and the report of what happened.
 */

/** A service by both of its names. */
export interface ServiceName {
  name: string;
  displayName: string;
}

/** What the service menu needs to know before it is shown. */
export interface ServiceState {
  state:
    | 'stopped'
    | 'startPending'
    | 'stopPending'
    | 'running'
    | 'continuePending'
    | 'pausePending'
    | 'paused'
    | 'unknown'
    | 'notFound';
  /** The process it runs in, when it is running. */
  pid?: number;
  /** Windows would let this application start it. */
  canStart: boolean;
  /** Windows would let this application stop it. */
  canStop: boolean;
  /** It accepts being stopped right now. Some services never do. */
  acceptsStop: boolean;
  /** Its start type is Disabled, so it cannot be started. */
  disabled: boolean;
  /**
   * Running services that would stop with it, in the order they would be
   * stopped. Absent when Windows would not say.
   */
  runningDependents?: ServiceName[];
}

/** What became of starting, stopping or restarting a service. */
export interface ServiceOutcome {
  outcome:
    | 'done'
    | 'accessDenied'
    | 'notFound'
    | 'disabled'
    | 'cannotStop'
    | 'dependentsRunning'
    | 'stoppedWithError'
    | 'timedOut'
    | 'failed';
  win32Error?: number;
  /** The state it was left in, when it could be read. */
  state?: string;
  /** Services stopped along with it, by display name. */
  stoppedDependents: string[];
  /** For a restart: services stopped along with it that did not start again. */
  notRestarted: string[];
}

/** A request from the Services page to show the menu for a service. */
export interface ServiceMenuRequest {
  /** The service's key name. */
  name: string;
}

/**
 * Something the page carries out itself once the menu has closed: going to
 * the process a service runs in, which the page finds by PID among processes
 * created before the service list was read.
 */
export type ServiceMenuCommand = { kind: 'goToProcess'; pid: number } | null;

/**
 * Whether a value could be a service's key name. Windows allows up to 256
 * characters and no slashes; anything else cannot name a service.
 */
export function isServiceName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 256 &&
    !/[\\/]/.test(value) &&
    // eslint-disable-next-line no-control-regex
    !/[\u0000-\u001f]/.test(value)
  );
}

/** The words for a service's state. */
export const SERVICE_STATE_LABELS: Record<ServiceState['state'], string> = {
  stopped: 'Stopped',
  startPending: 'Starting',
  stopPending: 'Stopping',
  running: 'Running',
  continuePending: 'Resuming',
  pausePending: 'Pausing',
  paused: 'Paused',
  unknown: 'Unknown',
  notFound: 'Removed',
};

/**
 * The words the Services console uses for a start type, such as "Automatic
 * (Delayed Start)". Undefined when the configuration was not read.
 */
export function startTypeLabel(
  service: Pick<ServiceSnapshot, 'startType' | 'delayedAutoStart' | 'triggerStart'>,
): string | undefined {
  const base = {
    automatic: 'Automatic',
    manual: 'Manual',
    disabled: 'Disabled',
    boot: 'Boot',
    system: 'System',
    unknown: undefined,
  }[service.startType ?? 'unknown'];
  if (!base) return undefined;
  const notes = [
    service.startType === 'automatic' && service.delayedAutoStart ? 'Delayed Start' : null,
    service.triggerStart ? 'Trigger Start' : null,
  ].filter((note): note is string => note !== null);
  return notes.length > 0 ? `${base} (${notes.join(', ')})` : base;
}

/** Accept a service menu request from a renderer, or null if it is not one. */
export function readServiceMenuRequest(value: unknown): ServiceMenuRequest | null {
  if (typeof value !== 'object' || value === null) return null;
  const name = (value as Record<string, unknown>).name;
  return isServiceName(name) ? { name } : null;
}
