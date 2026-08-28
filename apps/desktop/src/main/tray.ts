import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { app, Menu, nativeImage, Tray } from 'electron';
import type { SystemSnapshot } from '@task-manager/telemetry-types';
import type { WidgetController } from './widget-controller.js';

/**
 * System tray icon.
 *
 * Two jobs. First, a live tooltip showing the same canonical numbers the rest of
 * the application shows — the tray reads snapshots, it does not compute
 * anything. Second, and more important, it is the guaranteed way back from a
 * click-through widget: an always-on-top frameless window that ignores the mouse
 * cannot be right-clicked, so without the tray the user would have no way to
 * turn it off.
 */
export class AppTray {
  #tray: Tray | null = null;
  #widget: WidgetController;
  #onShowMainWindow: () => void;
  /** Last tooltip written, to avoid re-setting an identical string twice a second. */
  #lastTooltip = '';

  constructor(options: {
    widget: WidgetController;
    onShowMainWindow: () => void;
  }) {
    this.#widget = options.widget;
    this.#onShowMainWindow = options.onShowMainWindow;
  }

  create(iconPath: string | undefined): void {
    const image = loadIcon(iconPath);
    // An empty image would produce an invisible tray entry, which is worse than
    // no tray at all because the escape hatch would silently not exist.
    if (image.isEmpty()) return;

    this.#tray = new Tray(image);
    this.#tray.setToolTip('Task Manager');
    this.#tray.on('double-click', () => this.#onShowMainWindow());
    this.#tray.on('click', () => this.#onShowMainWindow());
    this.refreshMenu();
  }

  /** Rebuild the menu so checkboxes reflect current settings. */
  refreshMenu(): void {
    if (!this.#tray) return;
    this.#tray.setContextMenu(
      Menu.buildFromTemplate(this.#widget.buildMenuTemplate('tray')),
    );
  }

  /** Update the tooltip from a snapshot. Formats only; calculates nothing. */
  update(snapshot: SystemSnapshot): void {
    if (!this.#tray) return;
    const cpu = snapshot.cpu.aggregateTimeUtilizationPercent;
    const memory = snapshot.memory.physicalUtilizationPercent;
    const tooltip =
      `Task Manager\n` +
      `CPU ${cpu === undefined ? '—' : `${cpu.toFixed(0)}%`}   ` +
      `RAM ${memory.toFixed(0)}%`;
    if (tooltip === this.#lastTooltip) return;
    this.#lastTooltip = tooltip;
    this.#tray.setToolTip(tooltip);
  }

  destroy(): void {
    this.#tray?.destroy();
    this.#tray = null;
  }
}

/**
 * Load the tray icon.
 *
 * A packaged build has no `build/` directory, so the icon is read from the
 * resources folder there and from the source tree in development.
 */
function loadIcon(explicitPath: string | undefined): Electron.NativeImage {
  const candidates = [
    explicitPath,
    join(process.resourcesPath, 'icon.png'),
    join(app.getAppPath(), 'build', 'icon.png'),
  ].filter((candidate): candidate is string => typeof candidate === 'string');

  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    const image = nativeImage.createFromPath(candidate);
    if (!image.isEmpty()) {
      // 16px is the tray surface at 100% scaling; Windows picks up the higher
      // resolution representation automatically on scaled displays.
      return image.resize({ width: 16, height: 16 });
    }
  }
  return nativeImage.createEmpty();
}
