import { useEffect, useLayoutEffect, useRef } from 'react';
import type { RingBuffer } from '@task-manager/shared';
import { telemetryStore } from '../lib/telemetry-store.js';

export interface ChartSeries {
  buffer: RingBuffer;
  /** CSS colour for the stroke. */
  color: string;
  /** Optional fill under the line, usually the stroke colour at low alpha. */
  fill?: string;
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
        context.strokeStyle = 'rgba(255,255,255,0.06)';
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
        const span = Math.max(2, Math.min(windowSize, buffer.capacity));
        const count = Math.min(buffer.length, span);
        if (count < 2) continue;
        const stepX = width / (span - 1);
        // Index of the first sample we draw, and how many empty slots precede
        // it so that the newest sample lands exactly on the right edge.
        const firstIndex = buffer.length - count;
        const leading = span - count;

        const pointY = (value: number) => clientHeight - ((value - base) / range) * clientHeight;

        if (item.fill) {
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
            context.fillStyle = item.fill;
            context.fill();
          }
        }

        context.beginPath();
        context.strokeStyle = item.color;
        context.lineWidth = 1.5;
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
