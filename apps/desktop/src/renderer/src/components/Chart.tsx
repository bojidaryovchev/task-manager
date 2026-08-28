import { useEffect, useLayoutEffect, useRef } from 'react';
import type { RingBuffer } from '@task-manager/shared';
import { telemetryStore } from '../lib/telemetry-store.js';

export interface ChartSeries {
  buffer: RingBuffer;
  /**
   * Stroke colour. May be a design token reference such as `var(--color-cpu)`;
   * it is resolved to a concrete colour before it reaches the canvas.
   */
  color: string;
  /**
   * Fill under the line. `true` uses the stroke colour at a default alpha, a
   * number sets that alpha explicitly, and omitting it draws no fill.
   */
  fill?: boolean | number;
  /** Draw as a dashed line, used for secondary/comparison series. */
  dashed?: boolean;
}

export interface ChartProps {
  series: ChartSeries[];
  /** Fixed upper bound. When omitted the chart scales to the data. */
  max?: number;
  /** Lower bound, defaults to 0. */
  min?: number;
  height?: number;
  /** Horizontal gridlines, as fractions of the range. */
  gridLines?: number;
  /**
   * How many samples span the full width. At the default 500 ms interval, 120
   * samples is a one-minute window. The newest sample is always at the right
   * edge and the line grows leftwards, so the time axis never rescales as the
   * buffer fills - a point does not move once it has been drawn.
   */
  windowSamples?: number;
  className?: string;
}

const DEFAULT_FILL_ALPHA = 0.22;
const LINE_WIDTH = 1.75;

/**
 * Resolve a CSS colour to something a canvas will accept.
 *
 * A canvas context silently ignores an unparseable colour and keeps whatever it
 * had, so passing `var(--color-cpu)` straight to `strokeStyle` leaves it at the
 * default black - invisible on a dark background, and invisible in code review
 * too, because nothing throws. Everything is resolved through here instead.
 */
function resolveColor(element: Element, color: string): string {
  const token = color.trim().match(/^var\(\s*(--[\w-]+)\s*(?:,\s*(.+))?\)$/);
  if (!token) return color;
  const [, name, fallback] = token;
  const value = getComputedStyle(element).getPropertyValue(name as string).trim();
  if (value) return value;
  return fallback?.trim() ?? '#ffffff';
}

/** Parse `#rgb`, `#rrggbb`, `rgb()` and `rgba()` into channels. */
function parseChannels(color: string): [number, number, number] | null {
  const value = color.trim();
  if (value.startsWith('#')) {
    let hex = value.slice(1);
    if (hex.length === 3) hex = [...hex].map((c) => c + c).join('');
    if (hex.length < 6) return null;
    const channels = [0, 2, 4].map((offset) => parseInt(hex.slice(offset, offset + 2), 16));
    return channels.every((c) => Number.isFinite(c))
      ? (channels as [number, number, number])
      : null;
  }
  const match = value.match(/^rgba?\(([^)]+)\)$/);
  if (!match) return null;
  const parts = (match[1] as string).split(/[,/\s]+/).filter(Boolean).map(Number);
  if (parts.length < 3 || parts.slice(0, 3).some((c) => !Number.isFinite(c))) return null;
  return parts.slice(0, 3) as [number, number, number];
}

/** The stroke colour at a given alpha, for the area under the line. */
function withAlpha(color: string, alpha: number): string | null {
  const channels = parseChannels(color);
  if (!channels) return null;
  const [r, g, b] = channels;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/**
 * A live line chart drawn straight onto a canvas.
 *
 * It subscribes to the store itself and redraws imperatively, so a new sample
 * never re-renders any React component. With 24 per-processor charts on screen
 * at 500 ms, that difference is the whole reason the CPU page stays cheap.
 */
export function Chart({
  series,
  max,
  min = 0,
  height = 120,
  gridLines = 4,
  windowSamples = 120,
  className,
}: ChartProps): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const propsRef = useRef({ series, max, min, gridLines, windowSamples });
  propsRef.current = { series, max, min, gridLines, windowSamples };
  const scheduleRef = useRef<(() => void) | null>(null);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let frame = 0;
    let disposed = false;
    // Token lookups go through getComputedStyle, so cache them for the lifetime
    // of the chart rather than repeating them on every animation frame.
    const colorCache = new Map<string, string>();
    const resolve = (color: string): string => {
      const cached = colorCache.get(color);
      if (cached !== undefined) return cached;
      const resolved = resolveColor(canvas, color);
      colorCache.set(color, resolved);
      return resolved;
    };

    const draw = () => {
      frame = 0;
      if (disposed) return;
      const context = canvas.getContext('2d');
      if (!context) return;

      const {
        series: active,
        max: fixedMax,
        min: lower,
        gridLines: lines,
        windowSamples: windowSize,
      } = propsRef.current;

      const ratio = window.devicePixelRatio || 1;
      const width = canvas.clientWidth;
      const clientHeight = canvas.clientHeight;
      if (width === 0 || clientHeight === 0) return;
      // Resizing the backing store clears it, so only do it when it changed.
      if (canvas.width !== Math.round(width * ratio)) canvas.width = Math.round(width * ratio);
      if (canvas.height !== Math.round(clientHeight * ratio)) {
        canvas.height = Math.round(clientHeight * ratio);
      }
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, width, clientHeight);

      let upper = fixedMax ?? 0;
      if (fixedMax === undefined) {
        for (const item of active) upper = Math.max(upper, item.buffer.max());
        upper = upper <= 0 ? 1 : upper * 1.1;
      }
      const range = upper - (lower ?? 0) || 1;
      const base = lower ?? 0;

      if (lines > 0) {
        context.strokeStyle = resolve('var(--color-chart-grid)');
        context.lineWidth = 1;
        context.beginPath();
        for (let i = 1; i < lines; i += 1) {
          const y = Math.round((clientHeight / lines) * i) + 0.5;
          context.moveTo(0, y);
          context.lineTo(width, y);
        }
        context.stroke();
      }

      for (const item of active) {
        const { buffer } = item;
        const stroke = resolve(item.color);
        const span = Math.max(2, Math.min(windowSize, buffer.capacity));
        const count = Math.min(buffer.length, span);
        if (count < 2) continue;
        const stepX = width / (span - 1);
        // Index of the first sample we draw, and how many empty slots precede
        // it so that the newest sample lands exactly on the right edge.
        const firstIndex = buffer.length - count;
        const leading = span - count;

        const pointY = (value: number) => clientHeight - ((value - base) / range) * clientHeight;

        const fillAlpha =
          item.fill === true
            ? DEFAULT_FILL_ALPHA
            : typeof item.fill === 'number'
              ? item.fill
              : null;
        const fillStyle = fillAlpha === null ? null : withAlpha(stroke, fillAlpha);

        if (fillStyle) {
          context.beginPath();
          let started = false;
          let firstX = 0;
          let lastX = 0;
          for (let i = 0; i < count; i += 1) {
            const value = buffer.at(firstIndex + i);
            if (value === undefined || Number.isNaN(value)) continue;
            const x = (leading + i) * stepX;
            const y = pointY(value);
            if (!started) {
              firstX = x;
              context.moveTo(x, y);
              started = true;
            } else {
              context.lineTo(x, y);
            }
            lastX = x;
          }
          if (started) {
            context.lineTo(lastX, clientHeight);
            context.lineTo(firstX, clientHeight);
            context.closePath();
            context.fillStyle = fillStyle;
            context.fill();
          }
        }

        context.beginPath();
        context.strokeStyle = stroke;
        context.lineWidth = LINE_WIDTH;
        context.lineJoin = 'round';
        context.setLineDash(item.dashed ? [4, 3] : []);
        let pendingMove = true;
        for (let i = 0; i < count; i += 1) {
          const value = buffer.at(firstIndex + i);
          // NaN marks "no measurement"; break the line rather than draw zero.
          if (value === undefined || Number.isNaN(value)) {
            pendingMove = true;
            continue;
          }
          const x = (leading + i) * stepX;
          const y = pointY(value);
          if (pendingMove) {
            context.moveTo(x, y);
            pendingMove = false;
          } else {
            context.lineTo(x, y);
          }
        }
        context.stroke();
        context.setLineDash([]);
      }
    };

    const schedule = () => {
      if (frame === 0) frame = requestAnimationFrame(draw);
    };
    scheduleRef.current = schedule;

    draw();
    const unsubscribe = telemetryStore.subscribe(schedule);
    const observer = new ResizeObserver(schedule);
    observer.observe(canvas);

    return () => {
      disposed = true;
      scheduleRef.current = null;
      if (frame !== 0) cancelAnimationFrame(frame);
      observer.disconnect();
      unsubscribe();
    };
  }, []);

  // Redraw when the caller swaps the series set, for example on page change.
  useEffect(() => {
    scheduleRef.current?.();
  }, [series]);

  return (
    <canvas
      ref={canvasRef}
      className={className}
      style={{ width: '100%', height, display: 'block' }}
    />
  );
}
