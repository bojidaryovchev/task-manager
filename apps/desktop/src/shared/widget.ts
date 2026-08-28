/**
 * The desktop widget's settings model, shared by main, preload and renderer.
 *
 * The widget is a second `BrowserWindow` inside this same application, attached
 * to the same `TelemetryService` broadcast as the main window. It computes no
 * telemetry of its own — that is the property the whole architecture exists to
 * protect, and it is what guarantees the widget and the main window can never
 * disagree about what CPU usage is.
 */

/** Available widget layouts. Adding one means adding a case in the renderer. */
export type WidgetLayout = 'minimal' | 'compact' | 'performance' | 'topConsumers';

export const WIDGET_LAYOUTS: readonly WidgetLayout[] = [
  'minimal',
  'compact',
  'performance',
  'topConsumers',
];

export const WIDGET_LAYOUT_LABELS: Record<WidgetLayout, string> = {
  minimal: 'Minimal',
  compact: 'Compact',
  performance: 'Performance',
  topConsumers: 'Top consumers',
};

/** Metrics a user can choose to show. */
export type WidgetMetricId =
  | 'cpuUtilization'
  | 'cpuUtility'
  | 'cpuBusiest'
  | 'memoryPercent'
  | 'memoryUsed'
  | 'gpu'
  | 'vram'
  | 'diskRead'
  | 'diskWrite'
  | 'networkDown'
  | 'networkUp';

export interface WidgetMetricDescriptor {
  id: WidgetMetricId;
  label: string;
  /** What the number means, shown as a tooltip and in the metric picker. */
  definition: string;
  /**
   * False when the collector does not gather this yet. Such metrics stay
   * visible in the picker but cannot be selected, because showing a blank or
   * zeroed tile would imply a measurement that was never taken.
   */
  collected: boolean;
}

/**
 * Every metric the widget knows about, including the ones not collected yet.
 *
 * Listing the uncollected ones is deliberate: it tells the user what the widget
 * will eventually show without pretending it shows it today.
 */
export const WIDGET_METRICS: readonly WidgetMetricDescriptor[] = [
  {
    id: 'cpuUtilization',
    label: 'CPU',
    definition:
      'Aggregate time utilization: the share of all logical processor time not spent idle.',
    collected: true,
  },
  {
    id: 'cpuUtility',
    label: 'CPU utility',
    definition:
      'Processor utility — the figure Windows Task Manager shows. Busy time weighted by delivered performance, so it can exceed 100%.',
    collected: true,
  },
  {
    id: 'cpuBusiest',
    label: 'Busiest CPU',
    definition: 'The highest utilization of any single logical processor.',
    collected: true,
  },
  {
    id: 'memoryPercent',
    label: 'RAM %',
    definition: 'Physical memory in use as a percentage of the memory usable by Windows.',
    collected: true,
  },
  {
    id: 'memoryUsed',
    label: 'RAM used',
    definition: 'Physical memory in use, in bytes.',
    collected: true,
  },
  {
    id: 'gpu',
    label: 'GPU',
    definition:
      'Utilisation of the busiest hardware adapter — the maximum across its engine types, never a sum.',
    collected: true,
  },
  {
    id: 'vram',
    label: 'VRAM',
    definition: 'Dedicated video memory in use on the busiest hardware adapter.',
    collected: true,
  },
  {
    id: 'diskRead',
    label: 'Disk read',
    definition: 'Bytes per second read across all physical disks.',
    collected: true,
  },
  {
    id: 'diskWrite',
    label: 'Disk write',
    definition: 'Bytes per second written across all physical disks.',
    collected: true,
  },
  {
    id: 'networkDown',
    label: 'Net down',
    definition: 'Bytes received per second across non-loopback adapters.',
    collected: true,
  },
  {
    id: 'networkUp',
    label: 'Net up',
    definition: 'Bytes sent per second across non-loopback adapters.',
    collected: true,
  },
];

export const COLLECTED_WIDGET_METRICS: readonly WidgetMetricId[] = WIDGET_METRICS.filter(
  (metric) => metric.collected,
).map((metric) => metric.id);

export interface WidgetBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WidgetSettings {
  /** Whether the widget window exists at all. */
  enabled: boolean;
  layout: WidgetLayout;
  /** Which metrics to show, in display order. Only collected metrics are kept. */
  metrics: WidgetMetricId[];
  alwaysOnTop: boolean;
  /**
   * Mouse events pass straight through to whatever is underneath.
   *
   * Always reversible from the tray menu, which is why the tray exists: a
   * click-through, always-on-top, frameless window with no other escape hatch
   * would be unmanageable.
   */
  clickThrough: boolean;
  /** Prevents dragging, so the widget cannot be nudged out of place. */
  locked: boolean;
  /** 0.25 to 1. Clamped on the way in. */
  opacity: number;
  /** Snap to the nearest screen edge or corner when released. */
  snapToEdges: boolean;
  /**
   * Show a temperature column between each metric's label and its value.
   *
   * Off by default would hide a real measurement; on by default costs about 34
   * pixels of width. A metric with no sensor behind it shows an em dash rather
   * than being omitted, so the column never implies a reading that was not
   * taken.
   */
  showTemperatures: boolean;
  /** Last position and size, or null before the widget has ever been placed. */
  bounds: WidgetBounds | null;
}

export const DEFAULT_WIDGET_SETTINGS: WidgetSettings = {
  enabled: false,
  layout: 'compact',
  metrics: ['cpuUtilization', 'memoryPercent'],
  alwaysOnTop: true,
  clickThrough: false,
  locked: false,
  opacity: 0.95,
  snapToEdges: true,
  showTemperatures: true,
  bounds: null,
};

/**
 * Natural size for a layout showing a given number of metrics.
 *
 * The widget window is sized to its content rather than to a fixed guess: it is
 * frameless and transparent, so any window larger than what is drawn shows as a
 * dead transparent margin inside the widget's own outline, and any window
 * smaller clips it. The constants below track the row heights in the layout
 * components.
 */
export function widgetLayoutSize(
  layout: WidgetLayout,
  metricCount: number,
  showTemperatures = false,
): { width: number; height: number } {
  const count = Math.max(1, metricCount);
  // Width of the temperature column plus its gap, matching TEMPERATURE_COLUMN
  // in the layout components. Zero when the column is not drawn, so turning
  // temperatures off gives the width straight back rather than leaving a gap.
  const temperature = showTemperatures ? 34 : 0;
  switch (layout) {
    case 'minimal':
      // One line. This is the only layout whose width depends on the text it
      // happens to be showing, so this is a deliberately generous *starting*
      // estimate: the widget measures itself and reports its real width, and
      // main uses that instead (see `useContentWidth`). Erring wide means the
      // worst case before that report arrives is a little empty space rather
      // than clipped values.
      return {
        width: Math.min(28 + count * (88 + temperature), 520 + temperature),
        height: 40,
      };
    case 'compact':
      // 20px row plus a 6px gap, inside 8px vertical padding. Wide enough for
      // the label column, a readable bar and a right-aligned value.
      return { width: 248 + temperature, height: 12 + count * 26 };
    case 'performance':
      // 15px label plus a 30px chart plus a 6px gap, inside 8px padding.
      return { width: 262 + temperature, height: 12 + count * 51 };
    case 'topConsumers':
      // Two fixed sections of three rows; independent of the metric selection,
      // and showing processes rather than the metrics a temperature attaches to.
      return { width: 262, height: 176 };
  }
}

export const WIDGET_OPACITY_MIN = 0.25;
export const WIDGET_OPACITY_MAX = 1;

/**
 * Coerce arbitrary input into valid settings.
 *
 * Used both when reading the settings file, which a user may have edited by
 * hand, and when accepting a change from the renderer. Anything unrecognised
 * falls back to the default rather than being trusted.
 */
export function normaliseWidgetSettings(input: unknown): WidgetSettings {
  const source = (typeof input === 'object' && input !== null ? input : {}) as Partial<
    Record<keyof WidgetSettings, unknown>
  >;
  const layout = WIDGET_LAYOUTS.includes(source.layout as WidgetLayout)
    ? (source.layout as WidgetLayout)
    : DEFAULT_WIDGET_SETTINGS.layout;

  const metrics = Array.isArray(source.metrics)
    ? source.metrics.filter((id): id is WidgetMetricId =>
        COLLECTED_WIDGET_METRICS.includes(id as WidgetMetricId),
      )
    : [];

  const opacity =
    typeof source.opacity === 'number' && Number.isFinite(source.opacity)
      ? Math.min(Math.max(source.opacity, WIDGET_OPACITY_MIN), WIDGET_OPACITY_MAX)
      : DEFAULT_WIDGET_SETTINGS.opacity;

  return {
    enabled: source.enabled === true,
    layout,
    // An empty selection would render an empty widget with no way back, so fall
    // back to the default set.
    metrics: metrics.length > 0 ? dedupe(metrics) : [...DEFAULT_WIDGET_SETTINGS.metrics],
    alwaysOnTop: source.alwaysOnTop !== false,
    clickThrough: source.clickThrough === true,
    locked: source.locked === true,
    opacity,
    snapToEdges: source.snapToEdges !== false,
    showTemperatures: source.showTemperatures !== false,
    bounds: normaliseBounds(source.bounds),
  };
}

function dedupe(metrics: WidgetMetricId[]): WidgetMetricId[] {
  return [...new Set(metrics)];
}

function normaliseBounds(input: unknown): WidgetBounds | null {
  if (typeof input !== 'object' || input === null) return null;
  const candidate = input as Partial<Record<keyof WidgetBounds, unknown>>;
  const numbers = (['x', 'y', 'width', 'height'] as const).map((key) => candidate[key]);
  if (!numbers.every((value) => typeof value === 'number' && Number.isFinite(value))) {
    return null;
  }
  const [x, y, width, height] = numbers as [number, number, number, number];
  // A zero or negative size would create a window that cannot be seen or closed.
  if (width < 80 || height < 30) return null;
  return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
}
