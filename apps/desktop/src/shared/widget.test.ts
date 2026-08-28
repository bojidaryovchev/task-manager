import { describe, expect, it } from 'vitest';
import {
  COLLECTED_WIDGET_METRICS,
  DEFAULT_WIDGET_SETTINGS,
  WIDGET_METRICS,
  WIDGET_OPACITY_MAX,
  WIDGET_OPACITY_MIN,
  normaliseWidgetSettings,
  widgetLayoutSize,
} from './widget.js';

/**
 * `normaliseWidgetSettings` is the only thing standing between the widget and
 * bad input. It runs over the settings file, which a user may have edited by
 * hand, and over every change arriving from a renderer, so anything it lets
 * through ends up driving a real window.
 */
describe('normaliseWidgetSettings', () => {
  it('returns defaults for input that is not an object', () => {
    for (const input of [undefined, null, 42, 'nope', []]) {
      expect(normaliseWidgetSettings(input)).toEqual(DEFAULT_WIDGET_SETTINGS);
    }
  });

  it('keeps valid settings unchanged', () => {
    const input = {
      enabled: true,
      layout: 'performance' as const,
      metrics: ['cpuUtilization' as const],
      alwaysOnTop: false,
      clickThrough: true,
      locked: true,
      opacity: 0.5,
      snapToEdges: false,
      bounds: { x: 10, y: 20, width: 200, height: 100 },
    };
    expect(normaliseWidgetSettings(input)).toEqual(input);
  });

  it('falls back to the default layout for an unknown one', () => {
    expect(normaliseWidgetSettings({ layout: 'hologram' }).layout).toBe(
      DEFAULT_WIDGET_SETTINGS.layout,
    );
  });

  it('keeps only metrics the collector actually gathers', () => {
    // Driven off the descriptor list rather than hard-coded ids, so wiring a
    // new metric into the collector does not silently break this guarantee:
    // anything not marked collected would render a tile with nothing behind it.
    const uncollected = WIDGET_METRICS.filter((metric) => !metric.collected).map(
      (metric) => metric.id,
    );
    const result = normaliseWidgetSettings({
      metrics: [...COLLECTED_WIDGET_METRICS, ...uncollected],
    });
    expect(result.metrics).toEqual([...COLLECTED_WIDGET_METRICS]);
    expect(result.metrics).not.toContain(uncollected[0]);
  });

  it('accepts every metric the descriptor list marks as collected', () => {
    const result = normaliseWidgetSettings({ metrics: [...COLLECTED_WIDGET_METRICS] });
    expect(result.metrics).toEqual([...COLLECTED_WIDGET_METRICS]);
  });

  it('drops unknown metric ids entirely', () => {
    const result = normaliseWidgetSettings({ metrics: ['cpuUtilization', 'nonsense', 7] });
    expect(result.metrics).toEqual(['cpuUtilization']);
  });

  it('removes duplicate metrics', () => {
    const result = normaliseWidgetSettings({
      metrics: ['cpuUtilization', 'cpuUtilization', 'memoryPercent'],
    });
    expect(result.metrics).toEqual(['cpuUtilization', 'memoryPercent']);
  });

  it('restores the default set rather than leaving an empty widget', () => {
    // An empty selection would render a blank window with no obvious way back.
    for (const metrics of [[], ['no-such-metric'], 'not-an-array']) {
      expect(normaliseWidgetSettings({ metrics }).metrics).toEqual(
        DEFAULT_WIDGET_SETTINGS.metrics,
      );
    }
  });

  it('clamps opacity into a range that stays visible and interactive', () => {
    expect(normaliseWidgetSettings({ opacity: 5 }).opacity).toBe(WIDGET_OPACITY_MAX);
    expect(normaliseWidgetSettings({ opacity: -1 }).opacity).toBe(WIDGET_OPACITY_MIN);
    // Fully transparent would be an invisible always-on-top window.
    expect(normaliseWidgetSettings({ opacity: 0 }).opacity).toBeGreaterThan(0);
  });

  it('ignores a non-numeric or non-finite opacity', () => {
    for (const opacity of [Number.NaN, Number.POSITIVE_INFINITY, '0.5', null]) {
      expect(normaliseWidgetSettings({ opacity }).opacity).toBe(
        DEFAULT_WIDGET_SETTINGS.opacity,
      );
    }
  });

  it('treats booleans strictly, so a stray string cannot enable click-through', () => {
    expect(normaliseWidgetSettings({ clickThrough: 'yes' }).clickThrough).toBe(false);
    expect(normaliseWidgetSettings({ enabled: 1 }).enabled).toBe(false);
    // alwaysOnTop and snapToEdges default to true, so only an explicit false turns them off.
    expect(normaliseWidgetSettings({}).alwaysOnTop).toBe(true);
    expect(normaliseWidgetSettings({ alwaysOnTop: false }).alwaysOnTop).toBe(false);
    expect(normaliseWidgetSettings({ alwaysOnTop: 'no' }).alwaysOnTop).toBe(true);
  });

  it('rejects bounds that are incomplete or not numbers', () => {
    for (const bounds of [
      { x: 1, y: 2, width: 100 },
      { x: 1, y: 2, width: '100', height: 100 },
      { x: Number.NaN, y: 0, width: 100, height: 100 },
      'somewhere',
      null,
    ]) {
      expect(normaliseWidgetSettings({ bounds }).bounds).toBeNull();
    }
  });

  it('rejects bounds too small to see or grab', () => {
    expect(normaliseWidgetSettings({ bounds: { x: 0, y: 0, width: 0, height: 0 } }).bounds)
      .toBeNull();
    expect(normaliseWidgetSettings({ bounds: { x: 0, y: 0, width: 10, height: 10 } }).bounds)
      .toBeNull();
  });

  it('rounds fractional bounds, since window positions are whole pixels', () => {
    expect(
      normaliseWidgetSettings({ bounds: { x: 10.6, y: 20.2, width: 200.4, height: 100.5 } })
        .bounds,
    ).toEqual({ x: 11, y: 20, width: 200, height: 101 });
  });

  it('is idempotent', () => {
    const once = normaliseWidgetSettings({ layout: 'minimal', opacity: 3, metrics: ['gpu'] });
    expect(normaliseWidgetSettings(once)).toEqual(once);
  });
});

describe('widgetLayoutSize', () => {
  it('grows with the metric count for the stacked layouts', () => {
    const one = widgetLayoutSize('compact', 1);
    const three = widgetLayoutSize('compact', 3);
    expect(three.height).toBeGreaterThan(one.height);
    expect(three.width).toBe(one.width);
  });

  it('grows in width rather than height for the single-line layout', () => {
    const one = widgetLayoutSize('minimal', 1);
    const three = widgetLayoutSize('minimal', 3);
    expect(three.width).toBeGreaterThan(one.width);
    expect(three.height).toBe(one.height);
  });

  it('caps the minimal width so it cannot span the screen', () => {
    expect(widgetLayoutSize('minimal', 50).width).toBeLessThanOrEqual(520);
  });

  it('is independent of the metric count for top consumers', () => {
    // That layout shows processes, not the selected metrics.
    expect(widgetLayoutSize('topConsumers', 1)).toEqual(widgetLayoutSize('topConsumers', 5));
  });

  it('never returns a size too small to contain its own border', () => {
    for (const layout of ['minimal', 'compact', 'performance', 'topConsumers'] as const) {
      for (const count of [0, 1, 5]) {
        const size = widgetLayoutSize(layout, count);
        expect(size.width).toBeGreaterThan(80);
        expect(size.height).toBeGreaterThan(30);
      }
    }
  });
});
