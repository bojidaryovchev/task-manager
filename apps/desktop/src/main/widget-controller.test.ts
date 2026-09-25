import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MenuItemConstructorOptions } from 'electron';
import { describe, expect, it } from 'vitest';
import { SettingsStore } from './settings-store.js';
import { WidgetController } from './widget-controller.js';

/**
 * The tray menu is the one menu everybody opens, so its order is a decision
 * rather than an accident. It once led with seven settings for a widget that
 * was not showing, and "Show widget" sat so far down that it went unnoticed.
 */

function controller(enabled: boolean): WidgetController {
  const store = new SettingsStore(join(mkdtempSync(join(tmpdir(), 'tm-menu-')), 'settings.json'));
  store.updateWidget({ enabled });
  return new WidgetController({
    settings: store,
    preloadPath: '',
    onShowMainWindow: () => {},
    onQuit: () => {},
    onWidgetClosed: () => {},
    onSettingsChanged: () => {},
  });
}

function labels(items: MenuItemConstructorOptions[]): string[] {
  return items.map((item) => (item.type === 'separator' ? '---' : String(item.label)));
}

describe('the tray menu', () => {
  it('leads with the window and the widget', () => {
    const menu = controller(false).buildMenuTemplate('tray');
    expect(labels(menu).slice(0, 2)).toEqual(['Open Task Manager', 'Show widget']);
  });

  it('says what the widget entry will do rather than showing a state', () => {
    expect(labels(controller(true).buildMenuTemplate('tray'))[1]).toBe('Hide widget');
  });

  it('keeps the widget settings in a submenu', () => {
    const menu = controller(false).buildMenuTemplate('tray');
    const widget = menu.find((item) => item.label === 'Widget');
    expect(labels(widget?.submenu as MenuItemConstructorOptions[])).toContain('Click through');
    expect(labels(menu)).not.toContain('Click through');
  });

  it('gathers the tray options in their own submenu and ends with Exit', () => {
    const menu = controller(false).buildMenuTemplate('tray', {
      options: [{ label: 'Close to tray' }],
      actions: [{ label: 'Run new task…' }],
    });
    const options = menu.find((item) => item.label === 'Options');
    expect(labels(options?.submenu as MenuItemConstructorOptions[])).toEqual(['Close to tray']);
    expect(labels(menu).slice(-3)).toEqual(['Run new task…', '---', 'Exit Task Manager']);
  });
});

describe("the widget's own menu", () => {
  it('shows its settings directly, since the widget is what was clicked', () => {
    const menu = labels(controller(true).buildMenuTemplate('widget'));
    expect(menu).toContain('Click through');
    expect(menu).toContain('Hide widget');
    expect(menu.at(-1)).toBe('Exit Task Manager');
  });
});
