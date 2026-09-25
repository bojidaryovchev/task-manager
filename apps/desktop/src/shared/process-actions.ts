/**
 * Acting on processes: the types main, preload and renderer share.
 *
 * The renderer never acts on a process itself. It asks the main process to show
 * a menu, or to end what is selected, and the main process owns everything
 * after that: the menu, the confirmation, the call into Windows and the report
 * of what happened. So nothing on a page can end a process without a menu the
 * user clicked or a question the user answered.
 */

/** Whether a process can be reached under the identity the caller saw. */
export type ProcessReachability = 'running' | 'notRunning' | 'identityChanged' | 'accessDenied';

/** Windows priority classes, from lowest to highest. */
export const PRIORITY_CLASSES = [
  'idle',
  'belowNormal',
  'normal',
  'aboveNormal',
  'high',
  'realtime',
] as const;

export type PriorityClassName = (typeof PRIORITY_CLASSES)[number];

/** What the process menu needs to know before it is shown. */
export interface ProcessState {
  status: ProcessReachability;
  /** Windows would let this application end it. */
  canEnd: boolean;
  /** Windows would let this application change its priority, efficiency mode or affinity. */
  canAdjust: boolean;
  /** Windows would let this application read its memory for a dump. */
  canDump: boolean;
  /** Ending it would stop Windows. Absent when that could not be read. */
  isCritical?: boolean;
  /** Its windows on the taskbar. */
  windowCount: number;
  /** It is the Windows shell: the Explorer that owns the taskbar. */
  isShell: boolean;
  priorityClass?: PriorityClassName;
  /** Whether it runs as EcoQoS, which is what Efficiency mode sets. */
  efficiencyMode?: boolean;
  /** The logical processors it may run on, by index. */
  affinity?: number[];
  /** The logical processors the system offers it, by index. */
  processors?: number[];
}

/**
 * What changing a setting did, with what Windows actually applied read back:
 * the priority class in effect can differ from the one asked for.
 */
export interface SettingOutcome {
  outcome: 'done' | 'notRunning' | 'identityChanged' | 'accessDenied' | 'failed';
  win32Error?: number;
  priorityClass?: PriorityClassName;
  efficiencyMode?: boolean;
  affinity?: number[];
}

export type ActionOutcomeName =
  | 'ended'
  | 'stillExiting'
  | 'critical'
  | 'requested'
  | 'noWindows'
  | 'done'
  | 'refused'
  | 'notRunning'
  | 'identityChanged'
  | 'accessDenied'
  | 'failed';

/** What an action did. */
export interface ActionOutcome {
  outcome: ActionOutcomeName;
  /** The Windows error code, when a call failed for a reason worth reporting. */
  win32Error?: number;
  /** How many things the action touched, for the actions that touch several. */
  count?: number;
}

/** What became of writing a memory dump. */
export interface DumpOutcome {
  outcome: 'written' | 'notRunning' | 'identityChanged' | 'accessDenied' | 'failed';
  /** The error `MiniDumpWriteDump` (an HRESULT) or the file system gave. */
  win32Error?: number;
  /** The size of the file written. */
  bytes?: number;
  /** Whether the process's handles are in it; that needs more access. */
  withHandles: boolean;
}

/**
 * Where a process menu was opened, which decides what it offers. The widget
 * has no page to draw a dialog on or go to a row in, so its menu leaves those
 * out and offers to show the process in Task Manager instead.
 */
export type ProcessMenuContext = 'processes' | 'applications' | 'widget';

const PROCESS_MENU_CONTEXTS: readonly ProcessMenuContext[] = ['processes', 'applications', 'widget'];

/** A request from a page to show the menu for one or more processes. */
export interface ProcessMenuRequest {
  /** Identity keys (`pid:createTime100ns`) of the processes the menu is for. */
  keys: string[];
  context: ProcessMenuContext;
  /**
   * The application's name when the menu is for a whole application on the
   * Applications page, so the menu can say "End Google Chrome" rather than
   * listing processes.
   */
  applicationName?: string;
}

/**
 * Something the page carries out itself once the menu has closed, because it
 * is about what the page shows rather than about the process.
 */
export type ProcessMenuCommand =
  | { kind: 'goToParent'; key: string }
  /** Open the Services page on the services the process hosts, by key name. */
  | { kind: 'goToServices'; names: string[] }
  | {
      /** Open the affinity dialog, which the page draws. */
      kind: 'affinity';
      key: string;
      name: string;
      /** Every logical processor the process could be given, by index. */
      processors: number[];
      /** The ones it may use now. */
      current: number[];
    }
  | null;

/** Upper bound on how many processes one request may name. */
export const MAX_KEYS_PER_REQUEST = 2_000;

/** Whether a value is a process identity key, `pid:createTime100ns`. */
export function isProcessKey(value: unknown): value is string {
  return typeof value === 'string' && /^\d{1,10}:\d{1,19}$/.test(value);
}

/**
 * Accept a list of process keys from a renderer, or null if it is not one.
 *
 * Duplicates are removed rather than refused: a page selecting the same row
 * twice is not an attack, just untidy.
 */
export function readProcessKeys(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_KEYS_PER_REQUEST) {
    return null;
  }
  if (!value.every(isProcessKey)) return null;
  return [...new Set(value)];
}

/** Longest application name a menu request may carry. */
const MAX_APPLICATION_NAME = 200;

/** Accept a menu request from a renderer, or null if it is not a valid one. */
export function readProcessMenuRequest(value: unknown): ProcessMenuRequest | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as Record<string, unknown>;
  const keys = readProcessKeys(candidate.keys);
  if (!keys) return null;
  const context = PROCESS_MENU_CONTEXTS.find((known) => known === candidate.context);
  if (!context) return null;
  const name = candidate.applicationName;
  if (name !== undefined && (typeof name !== 'string' || name.length > MAX_APPLICATION_NAME)) {
    return null;
  }
  return {
    keys,
    context,
    ...(typeof name === 'string' && name.trim() !== '' ? { applicationName: name } : {}),
  };
}

/** Accept a list of logical processor indices from a renderer, or null. */
export function readProcessorIndices(value: unknown): number[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > 64) return null;
  if (!value.every((index) => Number.isInteger(index) && index >= 0 && index < 64)) return null;
  return [...new Set(value as number[])].sort((a, b) => a - b);
}
