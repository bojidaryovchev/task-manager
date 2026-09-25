/**
 * Startup apps: the types main, preload and renderer share.
 *
 * The page lists what Windows starts at sign-in and asks the main process to
 * change it; the main process owns the menu, the write and the report.
 */

/** Where a startup entry is registered. */
export type StartupSource = 'userRun' | 'machineRun' | 'machineRun32' | 'userFolder' | 'commonFolder';

export const STARTUP_SOURCES: readonly StartupSource[] = [
  'userRun',
  'machineRun',
  'machineRun32',
  'userFolder',
  'commonFolder',
];

/** Where each source is, in words. */
export const STARTUP_SOURCE_LABELS: Record<StartupSource, string> = {
  userRun: 'Registry (you)',
  machineRun: 'Registry (all users)',
  machineRun32: 'Registry (all users, 32-bit)',
  userFolder: 'Startup folder (you)',
  commonFolder: 'Startup folder (all users)',
};

/** Changing a source's entries needs administrator rights. */
export function isMachineWide(source: StartupSource): boolean {
  return source === 'machineRun' || source === 'machineRun32' || source === 'commonFolder';
}

/** One program Windows starts when the user signs in. */
export interface StartupItem {
  source: StartupSource;
  /** The Run value's name, or the Startup folder file's name. */
  name: string;
  /** The command as registered; for a Startup folder item, its path. */
  command: string;
  /** The program it starts, when the command names one by full path. */
  programPath?: string;
  /** Whether that program is where the command says. */
  programExists: boolean;
  /** The program's FileDescription, or its ProductName. */
  description?: string;
  /** The program's CompanyName. */
  publisher?: string;
  /** Unknown when Windows' record of it is in a form not seen before. */
  status: 'enabled' | 'disabled' | 'unknown';
  /** When it was turned off, when Windows recorded the time. */
  disabledAtUnixMs?: number;
  /** The first byte of Windows' record, when there is one. */
  approvalFlag?: number;
}

/** What became of turning an entry on or off. */
export interface StartupOutcome {
  outcome: 'done' | 'notFound' | 'accessDenied' | 'failed';
  win32Error?: number;
}

/** Which entry a request is about. */
export interface StartupItemId {
  source: StartupSource;
  name: string;
}

/** Accept an entry id from a renderer, or null if it is not one. */
export function readStartupItemId(value: unknown): StartupItemId | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as Record<string, unknown>;
  const source = STARTUP_SOURCES.find((known) => known === candidate.source);
  const name = candidate.name;
  // A registry value name can hold anything but is at most 16,383
  // characters; a file name cannot hold a separator. Control characters
  // name nothing this page shows.
  if (
    !source ||
    typeof name !== 'string' ||
    name.length === 0 ||
    name.length > 16_383 ||
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u001f]/.test(name)
  ) {
    return null;
  }
  return { source, name };
}

/** The name to show for an entry: its program's own name, when it has one. */
export function startupDisplayName(item: StartupItem): string {
  return item.description?.trim() || item.name;
}
