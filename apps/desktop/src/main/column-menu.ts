import { Menu, type BrowserWindow, type MenuItemConstructorOptions } from 'electron';
import {
  DEFAULT_PROCESS_COLUMNS,
  PROCESS_COLUMNS,
  type ProcessColumnId,
} from '@shared/process-columns.js';
import type { SettingsStore } from './settings-store.js';

/**
 * The Processes page's column chooser: right-click the header, tick a column.
 *
 * A native menu with a checkmark per column, as Windows Task Manager's own
 * header menu is. The choice is kept in settings, and `onChanged` hears about
 * it, which is how reading command lines follows the Command line column.
 */

/** See `process-actions.ts`: a click can land just after the menu reports closing. */
const MENU_SETTLE_MS = 250;

export function showColumnMenu(
  window: BrowserWindow | null,
  settings: SettingsStore,
  onChanged: (columns: ProcessColumnId[]) => void,
): Promise<ProcessColumnId[]> {
  return new Promise((resolve) => {
    const current = settings.processes.columns;
    const choose = (columns: ProcessColumnId[]): void => {
      const saved = settings.updateProcesses({ columns }).columns;
      onChanged(saved);
      resolve(saved);
    };
    const template: MenuItemConstructorOptions[] = [
      // Always shown: a row with no name would not say what it is.
      { label: 'Name', type: 'checkbox', checked: true, enabled: false },
      ...PROCESS_COLUMNS.map<MenuItemConstructorOptions>((column) => ({
        label: column.label,
        type: 'checkbox',
        checked: current.includes(column.id),
        click: () =>
          choose(
            current.includes(column.id)
              ? current.filter((id) => id !== column.id)
              : [...current, column.id],
          ),
      })),
      { type: 'separator' },
      { label: 'Default columns', click: () => choose([...DEFAULT_PROCESS_COLUMNS]) },
    ];
    Menu.buildFromTemplate(template).popup({
      window: window ?? undefined,
      callback: () => setTimeout(() => resolve(settings.processes.columns), MENU_SETTLE_MS),
    });
  });
}
