import { BrowserWindow, Menu, type MenuItemConstructorOptions } from 'electron';
import { IpcChannel } from '@shared/ipc';
import {
  WIDGET_LAYOUT_LABELS,
  WIDGET_LAYOUTS,
  WIDGET_METRICS,
  type WidgetLayout,
  type WidgetMetricId,
  type WidgetSettings,
} from '@shared/widget.js';
import type { SettingsStore } from './settings-store.js';
import { WidgetWindow } from './widget-window.js';

/** What the tray adds to the shared menu. */
export interface TrayMenuSections {
  /** Settings about the tray and the window, gathered in an Options submenu. */
  options: MenuItemConstructorOptions[];
  /** Things to do, listed at the top level just above Exit. */
  actions: MenuItemConstructorOptions[];
}

/**
 * Owns the widget's settings and window, and builds the menus that drive it.
 *
 * The tray menu and the widget's own right-click menu are built from the same
 * template here. That matters for one reason in particular: click-through makes
 * the widget unable to receive a right-click, so the tray has to be able to turn
 * it back off. Two hand-maintained menus would eventually disagree about that.
 */
export class WidgetController {
  #settings: SettingsStore;
  #window: WidgetWindow;
  #onShowMainWindow: () => void;
  #onQuit: () => void;
  #onSettingsChanged: (settings: WidgetSettings) => void;

  constructor(options: {
    settings: SettingsStore;
    preloadPath: string;
    onShowMainWindow: () => void;
    onQuit: () => void;
    onWidgetClosed: (webContentsId: number) => void;
    onSettingsChanged: (settings: WidgetSettings) => void;
    /** Called whenever the widget window is created, for crash handling. */
    onWindowCreated?: (window: BrowserWindow) => void;
  }) {
    this.#settings = options.settings;
    this.#onShowMainWindow = options.onShowMainWindow;
    this.#onQuit = options.onQuit;
    this.#onSettingsChanged = options.onSettingsChanged;
    this.#window = new WidgetWindow({
      settings: options.settings,
      preloadPath: options.preloadPath,
      onClosed: options.onWidgetClosed,
      onCreated: options.onWindowCreated,
    });
  }

  get settings(): WidgetSettings {
    return this.#settings.widget;
  }

  get webContentsId(): number | null {
    return this.#window.webContentsId;
  }

  /** Open the widget if the stored settings say it should be visible. */
  restore(): void {
    if (this.#settings.widget.enabled) this.#window.open();
  }

  /**
   * Apply a partial settings change.
   *
   * The store normalises and persists, the live window picks up whatever
   * changed, and every renderer is told so open menus and the settings UI stay
   * in step. Returns the settings as they actually ended up.
   */
  update(patch: Partial<WidgetSettings>): WidgetSettings {
    const before = this.#settings.widget;
    const after = this.#settings.updateWidget(patch);

    if (after.enabled && !before.enabled) this.#window.open();
    else if (!after.enabled && before.enabled) this.#window.close();

    // `apply` resizes to the layout's natural size, which depends on the metric
    // count as well as the layout itself.
    if (after.enabled) this.#window.apply(after);

    this.#broadcast(after);
    this.#onSettingsChanged(after);
    return after;
  }

  setEnabled(enabled: boolean): void {
    this.update({ enabled });
  }

  /**
   * The widget reporting how wide its content actually is.
   *
   * Only the minimal layout needs this. Its width is decided by the labels and
   * values it happens to be showing, and no constant can serve both "CPU 5%"
   * and "DISK READ 126 KB/s": one leaves dead space inside the widget's own
   * outline, the other clips. So that layout is sized from a measurement rather
   * than an estimate.
   */
  reportContentWidth(width: number): void {
    this.#window.setMeasuredContentWidth(width, this.#settings.widget);
  }

  close(): void {
    this.#window.close();
  }

  /** Push settings to every renderer, so the widget and any settings UI agree. */
  #broadcast(settings: WidgetSettings): void {
    for (const window of BrowserWindow.getAllWindows()) {
      if (window.isDestroyed() || window.webContents.isDestroyed()) continue;
      window.webContents.send(IpcChannel.WidgetSettingsEvent, settings);
    }
  }

  /**
   * The menu for the tray icon or the widget's own right-click.
   *
   * The two lead differently. Someone right-clicking the widget is looking at
   * it, so its settings come first. Someone right-clicking the tray icon wants
   * the window or the widget, so those come first and the widget's settings
   * wait in a submenu: listed at the top level, seven settings for a widget
   * that is not even showing pushed "Show widget" so far down that it went
   * unnoticed.
   */
  buildMenuTemplate(
    context: 'tray' | 'widget',
    /**
     * What only the tray menu carries, supplied by the tray so this controller
     * does not need to know about it: `options` become an Options submenu, and
     * `actions` sit at the top level just above Exit.
     */
    tray: TrayMenuSections = { options: [], actions: [] },
  ): MenuItemConstructorOptions[] {
    const settings = this.settings;
    const open: MenuItemConstructorOptions = {
      label: 'Open Task Manager',
      click: () => this.#onShowMainWindow(),
    };
    const exit: MenuItemConstructorOptions = {
      label: 'Exit Task Manager',
      click: () => this.#onQuit(),
    };

    if (context === 'widget') {
      return [
        open,
        { type: 'separator' },
        ...this.#widgetSettingsItems(),
        { type: 'separator' },
        { label: 'Hide widget', click: () => this.setEnabled(false) },
        { type: 'separator' },
        exit,
      ];
    }

    const template: MenuItemConstructorOptions[] = [
      open,
      {
        // Says what clicking it will do, rather than a checkbox whose tick
        // has to be read as a state.
        label: settings.enabled ? 'Hide widget' : 'Show widget',
        click: () => this.setEnabled(!settings.enabled),
      },
      { type: 'separator' },
      { label: 'Widget', submenu: this.#widgetSettingsItems() },
    ];
    if (tray.options.length > 0) template.push({ label: 'Options', submenu: tray.options });
    if (tray.actions.length > 0) template.push({ type: 'separator' }, ...tray.actions);
    template.push({ type: 'separator' }, exit);
    return template;
  }

  /** The widget's own settings, as menu items. */
  #widgetSettingsItems(): MenuItemConstructorOptions[] {
    const settings = this.settings;
    return [
      {
        label: 'Layout',
        submenu: WIDGET_LAYOUTS.map<MenuItemConstructorOptions>((layout: WidgetLayout) => ({
          label: WIDGET_LAYOUT_LABELS[layout],
          type: 'radio',
          checked: settings.layout === layout,
          click: () => this.update({ layout }),
        })),
      },
      {
        label: 'Metrics',
        submenu: WIDGET_METRICS.map<MenuItemConstructorOptions>((metric) => ({
          // Metrics the collector does not gather yet are listed but disabled,
          // so the menu says what is coming without offering a blank tile.
          label: metric.collected ? metric.label : `${metric.label} (not yet collected)`,
          type: 'checkbox',
          enabled: metric.collected,
          checked: settings.metrics.includes(metric.id),
          click: () => this.#toggleMetric(metric.id),
        })),
      },
      {
        label: 'Opacity',
        submenu: [1, 0.9, 0.75, 0.6, 0.45, 0.3].map<MenuItemConstructorOptions>((value) => ({
          label: `${Math.round(value * 100)}%`,
          type: 'radio',
          checked: Math.abs(settings.opacity - value) < 0.01,
          click: () => this.update({ opacity: value }),
        })),
      },
      { type: 'separator' },
      {
        label: 'Always on top',
        type: 'checkbox',
        checked: settings.alwaysOnTop,
        click: () => this.update({ alwaysOnTop: !settings.alwaysOnTop }),
      },
      {
        label: 'Click through',
        type: 'checkbox',
        checked: settings.clickThrough,
        // The widget cannot be right-clicked while click-through is on, so the
        // tray is the way back. Say so where the user is about to turn it on.
        toolTip: 'While on, the widget cannot be clicked. Turn it off from the tray icon.',
        click: () => this.update({ clickThrough: !settings.clickThrough }),
      },
      {
        label: 'Lock position',
        type: 'checkbox',
        checked: settings.locked,
        click: () => this.update({ locked: !settings.locked }),
      },
      {
        label: 'Snap to edges',
        type: 'checkbox',
        checked: settings.snapToEdges,
        click: () => this.update({ snapToEdges: !settings.snapToEdges }),
      },
    ];
  }

  popupWidgetMenu(x: number, y: number): void {
    const window = BrowserWindow.getAllWindows().find(
      (candidate) => candidate.webContents.id === this.webContentsId,
    );
    const menu = Menu.buildFromTemplate(this.buildMenuTemplate('widget'));
    menu.popup({
      window,
      x: Math.round(x),
      y: Math.round(y),
    });
  }

  #toggleMetric(id: WidgetMetricId): void {
    const current = this.settings.metrics;
    const next = current.includes(id)
      ? current.filter((metric) => metric !== id)
      : [...current, id];
    // Deselecting the last metric would leave an empty widget with no obvious
    // way to get anything back, so the last one is not removable.
    if (next.length === 0) return;
    this.update({ metrics: next });
  }
}
