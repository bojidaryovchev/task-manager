/** A service's state, as the Service Control Manager reports it. */
export type ServiceStateName =
  | 'stopped'
  | 'startPending'
  | 'stopPending'
  | 'running'
  | 'continuePending'
  | 'pausePending'
  | 'paused'
  | 'unknown';

/** When Windows starts a service. Boot and system apply only to drivers. */
export type ServiceStartType = 'automatic' | 'manual' | 'disabled' | 'boot' | 'system' | 'unknown';

/** One Windows service. */
export interface ServiceSnapshot {
  /** The key name, e.g. `Audiosrv`. */
  name: string;
  /** The name people read, e.g. `Windows Audio`. */
  displayName: string;
  state: ServiceStateName;
  /** The process it runs in. Absent when it is not running. */
  pid?: number;
  /**
   * Absent, like everything below, when the configuration could not be read
   * or has not been read yet.
   */
  startType?: ServiceStartType;
  /** Automatic, but started shortly after the other automatic services. */
  delayedAutoStart?: boolean;
  /** Also started or stopped by an event, such as a device arriving. */
  triggerStart?: boolean;
  /**
   * The svchost group it shares a process with: what follows `-k` in its
   * command line. Absent for a service with a program of its own.
   */
  group?: string;
  /** What it runs. */
  binaryPath?: string;
  /** The account it runs as. */
  account?: string;
  /** What it says it does. */
  description?: string;
}

/** Every Windows service, present only while a window asks for it. */
export interface ServicesSnapshot {
  /** Every Win32 service, running or not. Empty when the list could not be read. */
  services: ServiceSnapshot[];
  /** When the list was read. It is read every few seconds, not every sample. */
  readAtUnixMs: number;
  /** The Windows error that stopped the list being read, if one did. */
  failureWin32Error?: number;
}
