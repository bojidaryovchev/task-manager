import { existsSync } from 'node:fs';
import { BrowserWindow, clipboard, Menu, shell } from 'electron';
import {
  startupDisplayName,
  type StartupItem,
  type StartupItemId,
} from '@shared/startup.js';
import { showReport, type ActionGate } from './action-gate.js';
import type { Logger } from './logger.js';
import type { NativeTelemetryModule } from './native.js';
import { buildStartupMenu, reportStartupChange } from './startup-menu.js';

/**
 * Carries out what the Startup apps page offers. The list is read fresh for
 * every menu and every change, so nothing acts on a stale entry.
 */

export interface StartupActionsHost {
  native(): NativeTelemetryModule | null;
  elevated(): boolean;
  logger: Logger | null;
  restartElevated?: () => void;
  gate: ActionGate;
}

const MENU_SETTLE_MS = 250;

export class StartupActions {
  #host: StartupActionsHost;

  constructor(host: StartupActionsHost) {
    this.#host = host;
  }

  /** Every startup entry, read now. */
  list(): StartupItem[] {
    return this.#host.native()?.listStartupItems() ?? [];
  }

  /**
   * Show the menu for an entry. Resolves once it has closed, true when
   * something was changed and the page should read the list again.
   */
  showMenu(window: BrowserWindow | null, id: StartupItemId): Promise<boolean> {
    const item = this.#find(id);
    if (!item || this.#host.gate.busy) return Promise.resolve(false);
    let changed = false;
    return new Promise((resolve) => {
      const template = buildStartupMenu(
        { item, elevated: this.#host.elevated() },
        {
          setEnabled: (enabled) => {
            void this.setEnabled(window, id, enabled).then((done) => {
              changed = done;
              resolve(changed);
            });
          },
          openLocation: () => {
            const file = this.#fileOf(item);
            if (file) shell.showItemInFolder(file);
          },
          properties: () => {
            const file = this.#fileOf(item);
            if (file) this.#host.native()?.showFileProperties(file);
          },
          searchOnline: () => {
            const query = `${startupDisplayName(item)} ${item.publisher ?? ''} startup`.trim();
            void shell.openExternal(`https://www.google.com/search?q=${encodeURIComponent(query)}`);
          },
          copy: (text) => clipboard.writeText(text),
        },
      );
      Menu.buildFromTemplate(template).popup({
        window: window ?? undefined,
        // A switch resolves when it finishes; anything else, once closed.
        callback: () => setTimeout(() => resolve(changed), MENU_SETTLE_MS),
      });
    });
  }

  /** Turn an entry on or off, saying why when it could not be. */
  async setEnabled(window: BrowserWindow | null, id: StartupItemId, enabled: boolean): Promise<boolean> {
    let changed = false;
    await this.#host.gate.run(enabled ? 'enable startup app' : 'disable startup app', async () => {
      const native = this.#host.native();
      const item = this.#find(id);
      if (!native || !item) return;
      const outcome = native.setStartupItemEnabled(id.source, id.name, enabled);
      const described = `${startupDisplayName(item)} (${id.source}: ${id.name})`;
      if (outcome.outcome === 'done') {
        changed = true;
        this.#host.logger?.info('startup', `${enabled ? 'enabled' : 'disabled'} ${described}`);
        return;
      }
      const report = reportStartupChange(item, enabled, outcome, this.#host.elevated());
      if (!report) return;
      if (report.code) {
        this.#host.logger?.warn(
          report.code,
          `could not ${enabled ? 'enable' : 'disable'} ${described}: ${outcome.outcome}${
            outcome.win32Error === undefined ? '' : `, Windows error ${outcome.win32Error}`
          }`,
        );
      }
      await showReport(window, report, this.#host.restartElevated);
    });
    return changed;
  }

  #find(id: StartupItemId): StartupItem | undefined {
    return this.list().find((item) => item.source === id.source && item.name === id.name);
  }

  /** The file to show for an entry: its program, or the shortcut itself. */
  #fileOf(item: StartupItem): string | undefined {
    const file =
      item.programPath ??
      (item.source === 'userFolder' || item.source === 'commonFolder' ? item.command : undefined);
    return file && existsSync(file) ? file : undefined;
  }
}
