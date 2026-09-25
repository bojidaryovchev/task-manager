import type { MenuItemConstructorOptions } from 'electron';
import {
  STARTUP_SOURCE_LABELS,
  isMachineWide,
  startupDisplayName,
  type StartupItem,
  type StartupOutcome,
} from '@shared/startup.js';
import { codeLines, type Report } from './process-menu.js';

/**
 * The Startup apps menu and what it reports, pure so it can be tested
 * without Electron or the registry. `startup-actions.ts` does the work.
 *
 * Turning an entry off asks nothing, as in Windows Task Manager: it is
 * undone by turning it back on, and nothing runs or stops until the next
 * sign-in.
 */

export interface StartupMenuModel {
  item: StartupItem;
  elevated: boolean;
}

export interface StartupMenuHandlers {
  setEnabled(enabled: boolean): void;
  openLocation(): void;
  properties(): void;
  searchOnline(): void;
  copy(text: string): void;
}

export function buildStartupMenu(
  model: StartupMenuModel,
  handlers: StartupMenuHandlers,
): MenuItemConstructorOptions[] {
  const { item, elevated } = model;
  // Offered anyway without administrator rights: choosing it explains, and
  // offers the way through.
  const suffix = isMachineWide(item.source) && !elevated ? ' (needs administrator)' : '';
  const switches: MenuItemConstructorOptions[] = [];
  // When Windows' record is in an unknown form, neither is assumed, so both
  // are offered: choosing one writes a form it is known to read.
  if (item.status !== 'enabled') {
    switches.push({ label: `Enable${suffix}`, click: () => handlers.setEnabled(true) });
  }
  if (item.status !== 'disabled') {
    switches.push({ label: `Disable${suffix}`, click: () => handlers.setEnabled(false) });
  }
  const file = item.programPath ?? (isFolderItem(item) ? item.command : undefined);
  const fileKnown = file !== undefined && (item.programExists || isFolderItem(item));
  return [
    ...switches,
    { type: 'separator' },
    { label: 'Open file location', enabled: fileKnown, click: handlers.openLocation },
    { label: 'Search online', click: handlers.searchOnline },
    { label: 'Properties', enabled: fileKnown, click: handlers.properties },
    { type: 'separator' },
    {
      label: 'Copy',
      submenu: [
        { label: 'Name', click: () => handlers.copy(startupDisplayName(item)) },
        { label: 'Command', click: () => handlers.copy(item.command) },
        { type: 'separator' },
        { label: 'All details', click: () => handlers.copy(describeStartupItem(item)) },
      ],
    },
  ];
}

function isFolderItem(item: StartupItem): boolean {
  return item.source === 'userFolder' || item.source === 'commonFolder';
}

/** A startup entry as plain text. */
export function describeStartupItem(item: StartupItem): string {
  const lines: [string, string | undefined][] = [
    ['Name', startupDisplayName(item)],
    ['Entry', item.name],
    ['Publisher', item.publisher],
    [
      'Status',
      item.status === 'disabled' && item.disabledAtUnixMs !== undefined
        ? `Disabled on ${new Date(item.disabledAtUnixMs).toISOString()}`
        : { enabled: 'Enabled', disabled: 'Disabled', unknown: 'Unknown' }[item.status],
    ],
    ['Location', STARTUP_SOURCE_LABELS[item.source]],
    ['Command', item.command],
    ['Program', item.programPath],
  ];
  return lines
    .filter(([, value]) => value !== undefined && value !== '')
    .map(([label, value]) => `${label}: ${value}`)
    .join('\n');
}

/** What to tell the user after turning an entry on or off, or null. */
export function reportStartupChange(
  item: StartupItem,
  enabled: boolean,
  outcome: StartupOutcome,
  elevated: boolean,
): Report | null {
  const name = startupDisplayName(item);
  switch (outcome.outcome) {
    case 'done':
      return null;
    case 'accessDenied':
      return {
        type: 'warning',
        message: elevated
          ? `Windows refused to ${enabled ? 'enable' : 'disable'} ${name}.`
          : `Only administrators can ${enabled ? 'enable' : 'disable'} ${name}, because it starts for every user.`,
        detail: codeLines('TM-0023'),
        code: 'TM-0023',
        offerElevation: !elevated,
      };
    case 'notFound':
      return {
        type: 'info',
        message: `${name} is no longer set to start with Windows.`,
        detail: codeLines('TM-0024'),
        code: 'TM-0024',
        offerElevation: false,
      };
    case 'failed':
      return {
        type: 'error',
        message: `${name} could not be ${enabled ? 'enabled' : 'disabled'}.`,
        detail: `Windows error ${outcome.win32Error ?? 'unknown'}.\n\n${codeLines('TM-0025')}`,
        code: 'TM-0025',
        offerElevation: false,
      };
  }
}
