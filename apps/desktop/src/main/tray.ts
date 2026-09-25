import { existsSync } from 'node:fs';
import { join } from 'node:path';
import v8 from 'node:v8';
import vm from 'node:vm';
import {
  app,
  Menu,
  nativeImage,
  screen,
  Tray,
  type MenuItemConstructorOptions,
} from 'electron';
import type { SystemSnapshot } from '@task-manager/telemetry-types';
import type { Logger } from './logger.js';
import type { SettingsStore } from './settings-store.js';
import {
  readTrayReadings,
  renderTrayMeter,
  trayIconSize,
  trayTooltip,
  type TrayReadings,
} from './tray-meter.js';
import type { WidgetController } from './widget-controller.js';

/**
 * The system tray icon.
 *
 * Three jobs. It shows CPU, memory and GPU as live bars, the way Windows Task
 * Manager shows CPU in the notification area, with the exact figures in its
 * tooltip. It is where the main window goes when minimised, if the user wants
 * that. And it is the guaranteed way back from a click-through widget: an
 * always-on-top frameless window that ignores the mouse cannot be right-clicked,
 * so without the tray the user would have no way to turn it off.
 *
 * It reads the same snapshots as everything else and computes nothing; the bars
 * are drawn from values the collector already produced.
 *
 * # Why redrawing needs managing
 *
 * Measured, not assumed: every `setImage` leaves 3 GDI objects and 1 USER object
 * alive until V8 collects the `NativeImage` behind it. Electron tells V8 only
 * about the image's few kilobytes of pixels, not about the handles, so V8 sees no
 * reason to hurry. Over a thousand redraws the count climbed by 3,000 GDI objects
 * and stayed there; one forced collection returned all of them. Left alone, a
 * redraw twice a second would walk towards the 10,000-object per-process quota,
 * and running out of GDI objects breaks drawing throughout the process, not just
 * in the tray.
 *
 * So two things keep it bounded. The icon is only redrawn when a bar actually
 * moves by a pixel. And after every `REDRAWS_PER_COLLECTION` redraws a collection
 * is forced, which caps what can be outstanding however lazy the collector is.
 */

/**
 * Redraws between forced collections. Each holds 3 GDI and 1 USER object until
 * collected, so this caps the outstanding cost at 300 GDI and 100 USER objects,
 * against a quota of 10,000 of each - while collecting at most once every fifty
 * seconds at two redraws a second.
 */
const REDRAWS_PER_COLLECTION = 100;

export class AppTray {
  #tray: Tray | null = null;
  #widget: WidgetController;
  #settings: SettingsStore;
  #logger: Logger | null;
  #onShowMainWindow: () => void;
  #iconPath: string | undefined;
  /** Pixel size of the notification area's icons on the primary display. */
  #iconSize = 16;
  /** Last tooltip written, to avoid re-setting an identical string twice a second. */
  #lastTooltip = '';
  /** What the icon currently shows, so an identical redraw can be skipped. */
  #lastFrameKey = '';
  #latest: TrayReadings | null = null;
  #redrawsSinceCollection = 0;
  #reportedCollection = false;
  /** Forces a V8 collection; null when that could not be arranged. */
  #collect: (() => void) | null;
  /** Set once the live icon has failed, so it is not retried twice a second. */
  #liveFailed = false;
  #onDisplayMetricsChanged = (): void => this.#resize();

  constructor(options: {
    widget: WidgetController;
    settings: SettingsStore;
    onShowMainWindow: () => void;
    logger?: Logger | null;
  }) {
    this.#widget = options.widget;
    this.#settings = options.settings;
    this.#onShowMainWindow = options.onShowMainWindow;
    this.#logger = options.logger ?? null;
    this.#collect = obtainCollector();
    if (!this.#collect) {
      this.#logger?.warn(
        'TM-5004',
        'the live tray icon is off: its graphics handles could not be bounded',
      );
    }
  }

  /** True while there is a tray icon to come back through. */
  get isPresent(): boolean {
    return this.#tray !== null && !this.#tray.isDestroyed();
  }

  create(iconPath: string | undefined): void {
    this.#iconPath = iconPath;
    this.#iconSize = trayIconSize(screen.getPrimaryDisplay().scaleFactor);
    const image = loadIcon(iconPath, this.#iconSize);
    // An empty image would produce an invisible tray entry, which is worse than
    // no tray at all because the escape hatch would silently not exist.
    if (image.isEmpty()) return;

    this.#tray = new Tray(image);
    this.#tray.setToolTip('Task Manager');
    this.#tray.on('double-click', () => this.#onShowMainWindow());
    this.#tray.on('click', () => this.#onShowMainWindow());
    // Scaling can change while the application runs. The icon is drawn at an
    // exact pixel size, so it has to follow, or Windows stretches it.
    screen.on('display-metrics-changed', this.#onDisplayMetricsChanged);
    this.refreshMenu();
  }

  /** Rebuild the menu so checkboxes reflect current settings. */
  refreshMenu(): void {
    if (!this.#tray) return;
    this.#tray.setContextMenu(
      Menu.buildFromTemplate(this.#widget.buildMenuTemplate('tray', this.#menuItems())),
    );
  }

  /** Show a snapshot. Formats and draws; calculates nothing. */
  update(snapshot: SystemSnapshot): void {
    if (!this.#tray) return;
    const readings = readTrayReadings(snapshot);
    this.#latest = readings;

    const tooltip = trayTooltip(readings);
    if (tooltip !== this.#lastTooltip) {
      this.#lastTooltip = tooltip;
      this.#tray.setToolTip(tooltip);
    }

    if (this.#liveAvailable() && this.#settings.tray.liveIcon) this.#draw(readings);
  }

  destroy(): void {
    screen.removeListener('display-metrics-changed', this.#onDisplayMetricsChanged);
    this.#tray?.destroy();
    this.#tray = null;
  }

  #liveAvailable(): boolean {
    return this.#collect !== null && !this.#liveFailed;
  }

  #draw(readings: TrayReadings): void {
    if (!this.#tray) return;
    try {
      const frame = renderTrayMeter(readings, this.#iconSize);
      if (frame.key === this.#lastFrameKey) return;
      // A 1x image at exactly the tray's pixel size. Electron builds the tray's
      // icon from the 1x representation and never looks at any other, so this
      // is the only way to get pixels that are not resampled.
      this.#tray.setImage(
        nativeImage.createFromBitmap(frame.pixels, {
          width: this.#iconSize,
          height: this.#iconSize,
        }),
      );
      this.#lastFrameKey = frame.key;
      this.#afterRedraw();
    } catch (error) {
      this.#liveFailed = true;
      this.#logger?.error('TM-5003', 'the live tray icon could not be drawn', error);
      this.#showLogo();
      this.refreshMenu();
    }
  }

  /** Reclaim the handles of past redraws, every so many redraws. */
  #afterRedraw(): void {
    this.#redrawsSinceCollection += 1;
    if (this.#redrawsSinceCollection < REDRAWS_PER_COLLECTION || !this.#collect) return;
    this.#redrawsSinceCollection = 0;
    const started = performance.now();
    this.#collect();
    if (!this.#reportedCollection) {
      // Once, so the log shows the mechanism working and what it costs. Not on
      // every collection: nothing that happens on a timer belongs in the log.
      this.#reportedCollection = true;
      this.#logger?.info(
        'tray',
        `reclaimed the handles of ${REDRAWS_PER_COLLECTION} icon redraws in ${(performance.now() - started).toFixed(1)} ms`,
      );
    }
  }

  #showLogo(): void {
    if (!this.#tray) return;
    const image = loadIcon(this.#iconPath, this.#iconSize);
    if (!image.isEmpty()) this.#tray.setImage(image);
    this.#lastFrameKey = '';
  }

  #setLive(enabled: boolean): void {
    this.#settings.updateTray({ liveIcon: enabled });
    if (enabled && this.#latest) {
      this.#lastFrameKey = '';
      this.#draw(this.#latest);
    } else if (!enabled) {
      this.#showLogo();
    }
    this.refreshMenu();
  }

  #resize(): void {
    const size = trayIconSize(screen.getPrimaryDisplay().scaleFactor);
    if (size === this.#iconSize) return;
    this.#iconSize = size;
    this.#lastFrameKey = '';
    if (this.#liveAvailable() && this.#settings.tray.liveIcon && this.#latest) {
      this.#draw(this.#latest);
    } else {
      this.#showLogo();
    }
  }

  #menuItems(): MenuItemConstructorOptions[] {
    const tray = this.#settings.tray;
    const liveAvailable = this.#liveAvailable();
    return [
      {
        label: liveAvailable ? 'Show usage in tray icon' : 'Show usage in tray icon (unavailable)',
        type: 'checkbox',
        enabled: liveAvailable,
        checked: liveAvailable && tray.liveIcon,
        click: () => this.#setLive(!tray.liveIcon),
      },
      {
        label: 'Close to tray',
        type: 'checkbox',
        checked: tray.closeToTray,
        click: () => {
          this.#settings.updateTray({ closeToTray: !tray.closeToTray });
          this.refreshMenu();
        },
      },
      {
        // Windows Task Manager's own wording for the same option.
        label: 'Hide when minimized',
        type: 'checkbox',
        checked: tray.hideWhenMinimized,
        click: () => {
          this.#settings.updateTray({ hideWhenMinimized: !tray.hideWhenMinimized });
          this.refreshMenu();
        },
      },
    ];
  }
}

/**
 * A way to force a V8 collection, or null if one cannot be had.
 *
 * `--expose_gc` set at runtime exposes the collector to contexts created
 * afterwards, so the function is taken from a fresh one. Verified to reclaim
 * the tray's handles in this Electron version before relying on it.
 */
function obtainCollector(): (() => void) | null {
  try {
    v8.setFlagsFromString('--expose_gc');
    const collect: unknown = vm.runInNewContext('gc');
    return typeof collect === 'function' ? (collect as () => void) : null;
  } catch {
    return null;
  }
}

/**
 * Load the application logo at the tray's pixel size.
 *
 * Sized exactly, for the same reason the live icon is: the tray uses the 1x
 * bitmap as it stands and lets Windows stretch it, so a 16-pixel logo on a 150%
 * display arrives blurred. A packaged build has no `build/` directory, so the
 * icon is read from the resources folder there and from the source tree in
 * development.
 */
function loadIcon(explicitPath: string | undefined, size: number): Electron.NativeImage {
  const candidates = [
    explicitPath,
    join(process.resourcesPath, 'icon.png'),
    join(app.getAppPath(), 'build', 'icon.png'),
  ].filter((candidate): candidate is string => typeof candidate === 'string');

  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    const image = nativeImage.createFromPath(candidate);
    if (!image.isEmpty()) return image.resize({ width: size, height: size, quality: 'best' });
  }
  return nativeImage.createEmpty();
}
