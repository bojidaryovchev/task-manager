import { join } from 'node:path';
import { BrowserWindow, screen, type Rectangle } from 'electron';
import { widgetLayoutSize, type WidgetBounds, type WidgetSettings } from '@shared/widget.js';
import type { SettingsStore } from './settings-store.js';

/**
 * The desktop widget window.
 *
 * A frameless, transparent, always-on-top `BrowserWindow` belonging to this same
 * application. It receives the same snapshots as the main window through
 * `TelemetryService` and implements no telemetry of its own.
 */

/** How close to a screen edge a release must land to snap to it. */
const SNAP_DISTANCE = 24;

/** Minimum on-screen area, in pixels, for a stored position to be reusable. */
const MIN_VISIBLE_AREA = 40 * 40;

export interface WidgetWindowHost {
  settings: SettingsStore;
  preloadPath: string;
  /** Called when the widget window has gone, so subscriptions can be released. */
  onClosed(webContentsId: number): void;
}

export class WidgetWindow {
  #window: BrowserWindow | null = null;
  #host: WidgetWindowHost;
  #saveTimer: NodeJS.Timeout | null = null;

  constructor(host: WidgetWindowHost) {
    this.#host = host;
  }

  get isOpen(): boolean {
    return this.#window !== null && !this.#window.isDestroyed();
  }

  get webContentsId(): number | null {
    return this.isOpen ? (this.#window as BrowserWindow).webContents.id : null;
  }

  /** Create and show the widget, or focus it if it already exists. */
  open(): void {
    if (this.isOpen) {
      (this.#window as BrowserWindow).show();
      return;
    }
    const settings = this.#host.settings.widget;
    const bounds = resolveBounds(settings);

    const window = new BrowserWindow({
      ...bounds,
      show: false,
      frame: false,
      transparent: true,
      // A transparent window still paints its background colour; fully
      // transparent lets the renderer decide its own shape and opacity.
      backgroundColor: '#00000000',
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: settings.alwaysOnTop,
      // Excluded from screen capture is deliberately NOT set: a monitoring
      // overlay should appear in screenshots the user takes of a problem.
      hasShadow: false,
      acceptFirstMouse: true,
      webPreferences: {
        preload: this.#host.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        webviewTag: false,
        // The widget's whole purpose is to keep updating while unfocused.
        backgroundThrottling: false,
      },
    });

    this.#window = window;
    window.setOpacity(settings.opacity);
    this.applyClickThrough(settings.clickThrough);
    if (settings.alwaysOnTop) {
      // 'screen-saver' keeps it above full-screen windows too, which is what
      // "always on top" means to someone watching a game's frame rate.
      window.setAlwaysOnTop(true, 'screen-saver');
    }
    window.setVisibleOnAllWorkspaces(true);

    window.once('ready-to-show', () => window.showInactive());

    // Persist placement, but not on every pixel of a drag.
    window.on('move', () => this.#schedulePersistBounds());
    window.on('resize', () => this.#schedulePersistBounds());
    window.on('moved', () => this.#onMoved());

    window.on('closed', () => {
      const id = this.webContentsId;
      this.#window = null;
      if (id !== null) this.#host.onClosed(id);
    });

    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event) => event.preventDefault());

    if (process.env.ELECTRON_RENDERER_URL) {
      void window.loadURL(`${process.env.ELECTRON_RENDERER_URL}/widget.html`);
    } else {
      void window.loadFile(join(this.#host.preloadPath, '../../renderer/widget.html'));
    }
  }

  close(): void {
    if (!this.isOpen) return;
    this.#persistBounds();
    (this.#window as BrowserWindow).close();
    this.#window = null;
  }

  /**
   * Apply changed settings to the live window.
   *
   * Called after the store has already normalised and saved them, so the values
   * here are known good.
   */
  apply(settings: WidgetSettings): void {
    if (!this.isOpen) return;
    const window = this.#window as BrowserWindow;
    window.setOpacity(settings.opacity);
    window.setAlwaysOnTop(settings.alwaysOnTop, settings.alwaysOnTop ? 'screen-saver' : 'normal');
    window.setSkipTaskbar(true);
    this.applyClickThrough(settings.clickThrough);
    this.resizeForLayout(settings);
  }

  /**
   * Resize to the layout's natural size, keeping the top-left corner fixed so
   * the widget does not appear to jump when the layout changes.
   */
  resizeForLayout(settings: WidgetSettings): void {
    if (!this.isOpen) return;
    const window = this.#window as BrowserWindow;
    const size = widgetLayoutSize(settings.layout, settings.metrics.length);
    const current = window.getBounds();
    if (current.width === size.width && current.height === size.height) return;
    window.setBounds(
      clampToDisplay({ x: current.x, y: current.y, ...size }),
      false,
    );
    this.#persistBounds();
  }

  applyClickThrough(enabled: boolean): void {
    if (!this.isOpen) return;
    // `forward: true` keeps move events flowing so hover styling still works
    // while clicks pass through to whatever is underneath.
    (this.#window as BrowserWindow).setIgnoreMouseEvents(enabled, { forward: true });
  }

  #onMoved(): void {
    const settings = this.#host.settings.widget;
    if (!settings.snapToEdges || !this.isOpen) {
      this.#persistBounds();
      return;
    }
    const window = this.#window as BrowserWindow;
    const snapped = snapToEdges(window.getBounds());
    const current = window.getBounds();
    if (snapped.x !== current.x || snapped.y !== current.y) {
      window.setBounds(snapped, false);
    }
    this.#persistBounds();
  }

  #schedulePersistBounds(): void {
    if (this.#saveTimer) clearTimeout(this.#saveTimer);
    this.#saveTimer = setTimeout(() => {
      this.#saveTimer = null;
      this.#persistBounds();
    }, 250);
    this.#saveTimer.unref?.();
  }

  #persistBounds(): void {
    if (!this.isOpen) return;
    const bounds = (this.#window as BrowserWindow).getBounds();
    this.#host.settings.updateWidget({ bounds });
  }
}

/**
 * Decide where to put the widget.
 *
 * A stored position is only reused when it still lands on a display that exists
 * now — monitors get unplugged, resolutions change, and scaling changes move the
 * work area. Anything that would leave the widget off-screen, and therefore
 * unreachable, is replaced by a sensible spot on the primary display.
 */
export function resolveBounds(settings: WidgetSettings): WidgetBounds {
  const size = widgetLayoutSize(settings.layout, settings.metrics.length);
  const stored = settings.bounds;
  if (stored) {
    const candidate: WidgetBounds = { ...stored, ...size };
    if (visibleArea(candidate) >= MIN_VISIBLE_AREA) {
      return clampToDisplay(candidate);
    }
  }
  return defaultBounds(size);
}

/** Top-right of the primary display's work area, inset a little. */
function defaultBounds(size: { width: number; height: number }): WidgetBounds {
  const work = screen.getPrimaryDisplay().workArea;
  const margin = 16;
  return {
    x: work.x + work.width - size.width - margin,
    y: work.y + margin,
    width: size.width,
    height: size.height,
  };
}

/** Total area of the rectangle that overlaps any connected display. */
function visibleArea(bounds: WidgetBounds): number {
  let best = 0;
  for (const display of screen.getAllDisplays()) {
    best = Math.max(best, intersectionArea(bounds, display.workArea));
  }
  return best;
}

function intersectionArea(a: WidgetBounds, b: Rectangle): number {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  if (width <= 0 || height <= 0) return 0;
  return width * height;
}

/** Pull a rectangle fully inside the work area of its nearest display. */
export function clampToDisplay(bounds: WidgetBounds): WidgetBounds {
  const display = screen.getDisplayMatching({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
  });
  const work = display.workArea;
  return {
    width: bounds.width,
    height: bounds.height,
    x: Math.min(Math.max(bounds.x, work.x), work.x + work.width - bounds.width),
    y: Math.min(Math.max(bounds.y, work.y), work.y + work.height - bounds.height),
  };
}

/**
 * Snap to whichever screen edges are within reach.
 *
 * Both axes are considered independently, so releasing near a corner snaps to
 * the corner rather than to one edge.
 */
export function snapToEdges(bounds: Rectangle, distance = SNAP_DISTANCE): WidgetBounds {
  const display = screen.getDisplayMatching(bounds);
  const work = display.workArea;
  let { x, y } = bounds;

  if (Math.abs(x - work.x) <= distance) x = work.x;
  else if (Math.abs(x + bounds.width - (work.x + work.width)) <= distance) {
    x = work.x + work.width - bounds.width;
  }

  if (Math.abs(y - work.y) <= distance) y = work.y;
  else if (Math.abs(y + bounds.height - (work.y + work.height)) <= distance) {
    y = work.y + work.height - bounds.height;
  }

  return { x, y, width: bounds.width, height: bounds.height };
}
