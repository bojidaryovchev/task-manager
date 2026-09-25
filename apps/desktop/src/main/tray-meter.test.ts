import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SystemSnapshot } from '@task-manager/telemetry-types';
import { describe, expect, it } from 'vitest';
import {
  TRAY_PALETTE,
  TRAY_PALETTE_TOKENS,
  fillRows,
  meterLayout,
  readTrayReadings,
  renderTrayMeter,
  trayIconSize,
  trayTooltip,
  type TrayReadings,
} from './tray-meter.js';

/**
 * The tray icon is small enough that every pixel is a decision, and it is
 * redrawn twice a second for as long as the application runs. These tests pin
 * down what it draws, byte by byte.
 */

/** Every tray size Windows uses, 100% through 300% scaling. */
const SIZES = [16, 20, 24, 28, 32, 36, 40, 48];

function pixel(frame: Buffer, size: number, x: number, y: number): number[] {
  const offset = (y * size + x) * 4;
  return [...frame.subarray(offset, offset + 4)];
}

/** A colour as the BGRA bytes it should appear as. */
function bytes(hex: string): number[] {
  const value = Number.parseInt(hex.slice(1), 16);
  return [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, 255];
}

const FULL: TrayReadings = { cpu: 100, memory: 100, gpu: 100 };
const EMPTY: TrayReadings = { cpu: 0, memory: 0, gpu: 0 };

describe('layout', () => {
  for (const size of SIZES) {
    for (const count of [2, 3]) {
      it(`${count} bars at ${size}px are equal, separate and symmetric`, () => {
        const layout = meterLayout(size, count);
        const widths = layout.bars.map((bar) => bar.width);
        expect(new Set(widths).size).toBe(1);
        expect(widths[0]).toBeGreaterThanOrEqual(2);

        for (let i = 1; i < layout.bars.length; i += 1) {
          const previous = layout.bars[i - 1]!;
          expect(layout.bars[i]!.x).toBeGreaterThan(previous.x + previous.width);
        }

        // A one-pixel lean is visible at this size, so the margins must match.
        const first = layout.bars[0]!;
        const last = layout.bars.at(-1)!;
        const leftMargin = first.x;
        const rightMargin = size - (last.x + last.width);
        expect(leftMargin).toBe(rightMargin);
        expect(layout.trackTop).toBe(size - (layout.trackTop + layout.trackHeight));

        // Bars sit inside the outline.
        expect(first.x).toBeGreaterThanOrEqual(layout.frame);
        expect(layout.trackTop).toBeGreaterThanOrEqual(layout.frame);
      });
    }
  }

  it('gives each bar the most room the size allows', () => {
    // At 16px three 4px bars with 1px gaps fill the inside of the outline
    // exactly; anything narrower would be wasting the one resource there is.
    expect(meterLayout(16, 3).bars.map((bar) => bar.width)).toEqual([4, 4, 4]);
    // 150% scaling, which is what the development machine runs at.
    expect(meterLayout(24, 3).bars.map((bar) => bar.width)).toEqual([6, 6, 6]);
  });
});

describe('filling a bar', () => {
  it('fills nothing for no value, zero, a negative or NaN', () => {
    for (const value of [undefined, 0, -5, Number.NaN]) {
      expect(fillRows(value, 20)).toBe(0);
    }
  });

  it('fills in proportion, rounded to whole rows', () => {
    expect(fillRows(50, 20)).toBe(10);
    expect(fillRows(100, 20)).toBe(20);
    expect(fillRows(12, 20)).toBe(2);
  });

  it('fills the whole bar above 100 without drawing outside it', () => {
    // CPU utility and GPU engine sums can exceed 100; the tooltip keeps the
    // real figure.
    expect(fillRows(160, 20)).toBe(20);
  });
});

describe('the drawn icon', () => {
  it('is size by size BGRA', () => {
    for (const size of SIZES) {
      expect(renderTrayMeter(FULL, size).pixels.length).toBe(size * size * 4);
    }
  });

  it('writes colours in BGRA byte order', () => {
    // Established by round-tripping a pixel through Electron: bytes 10 20 F0
    // came back as red F0. Written the other way round, blue CPU bars would
    // arrive orange.
    const size = 24;
    const { pixels } = renderTrayMeter(FULL, size);
    const layout = meterLayout(size, 3);
    const bottom = layout.trackTop + layout.trackHeight - 1;
    expect(pixel(pixels, size, layout.bars[0]!.x, bottom)).toEqual(bytes(TRAY_PALETTE.cpu));
    expect(pixel(pixels, size, layout.bars[1]!.x, bottom)).toEqual(bytes(TRAY_PALETTE.memory));
    expect(pixel(pixels, size, layout.bars[2]!.x, bottom)).toEqual(bytes(TRAY_PALETTE.gpu));
  });

  it('keeps every pixel either fully opaque or entirely zero', () => {
    // The format is premultiplied: a transparent pixel carrying any colour at
    // all is invalid and shows up as a fringe.
    for (const size of SIZES) {
      const { pixels } = renderTrayMeter({ cpu: 37, memory: 64, gpu: 9 }, size);
      for (let i = 0; i < pixels.length; i += 4) {
        const alpha = pixels[i + 3];
        if (alpha === 0) {
          expect([pixels[i], pixels[i + 1], pixels[i + 2]]).toEqual([0, 0, 0]);
        } else {
          expect(alpha).toBe(255);
        }
      }
    }
  });

  it('rounds its corners and outlines its edge', () => {
    const size = 24;
    const { pixels } = renderTrayMeter(EMPTY, size);
    for (const [x, y] of [
      [0, 0],
      [size - 1, 0],
      [0, size - 1],
      [size - 1, size - 1],
    ]) {
      expect(pixel(pixels, size, x!, y!)).toEqual([0, 0, 0, 0]);
    }
    expect(pixel(pixels, size, size / 2, 0)).toEqual(bytes(TRAY_PALETTE.frame));
    expect(pixel(pixels, size, 0, size / 2)).toEqual(bytes(TRAY_PALETTE.frame));
  });

  it('draws the exact number of filled rows from the bottom up', () => {
    const size = 24;
    const layout = meterLayout(size, 3);
    const { pixels, fills } = renderTrayMeter({ cpu: 50, memory: 0, gpu: 100 }, size);
    expect(fills).toEqual([layout.trackHeight / 2, 0, layout.trackHeight]);

    const x = layout.bars[0]!.x;
    const coloured = [];
    for (let y = layout.trackTop; y < layout.trackTop + layout.trackHeight; y += 1) {
      coloured.push(pixel(pixels, size, x, y)[0] === bytes(TRAY_PALETTE.cpu)[0]);
    }
    // Empty track above, fill below, and nothing in between.
    expect(coloured).toEqual([
      ...Array<boolean>(layout.trackHeight / 2).fill(false),
      ...Array<boolean>(layout.trackHeight / 2).fill(true),
    ]);
  });

  it('shows an unmeasured value as an empty track, not a filled one', () => {
    const size = 24;
    const layout = meterLayout(size, 3);
    const { pixels } = renderTrayMeter({ cpu: undefined, memory: 40, gpu: 5 }, size);
    const bottom = layout.trackTop + layout.trackHeight - 1;
    expect(pixel(pixels, size, layout.bars[0]!.x, bottom)).toEqual(bytes(TRAY_PALETTE.track));
  });

  it('drops the GPU bar entirely on a machine with no GPU', () => {
    // An empty third bar would read as an idle GPU that is not there.
    expect(renderTrayMeter({ cpu: 10, memory: 20, gpu: null }, 24).fills).toHaveLength(2);
    expect(renderTrayMeter({ cpu: 10, memory: 20, gpu: undefined }, 24).fills).toHaveLength(3);
  });

  it('keys identical pictures identically, so the tray can skip a redraw', () => {
    const size = 24;
    const trackHeight = meterLayout(size, 3).trackHeight;
    const a = renderTrayMeter({ cpu: 50, memory: 50, gpu: 50 }, size);
    // Less than half a row away: the same pixels.
    const nudge = 100 / trackHeight / 4;
    const b = renderTrayMeter({ cpu: 50 + nudge, memory: 50, gpu: 50 }, size);
    const c = renderTrayMeter({ cpu: 70, memory: 50, gpu: 50 }, size);
    expect(b.key).toBe(a.key);
    expect(c.key).not.toBe(a.key);
    expect(renderTrayMeter({ cpu: 50, memory: 50, gpu: 50 }, 20).key).not.toBe(a.key);
  });
});

describe('palette', () => {
  it('uses exactly the design tokens the rest of the application uses', () => {
    // The CSS is the source of truth; the tray lives in the main process where
    // there is no CSS, so its copy is checked rather than trusted.
    const css = readFileSync(
      join(__dirname, '..', 'renderer', 'src', 'styles.css'),
      'utf8',
    );
    for (const [name, token] of Object.entries(TRAY_PALETTE_TOKENS)) {
      const match = css.match(new RegExp(`${token}:\\s*(#[0-9a-fA-F]{6})\\s*;`));
      expect(match, token).not.toBeNull();
      expect(TRAY_PALETTE[name as keyof typeof TRAY_PALETTE].toLowerCase(), name).toBe(
        match![1]!.toLowerCase(),
      );
    }
  });
});

describe('icon size', () => {
  it('matches the notification area at each scale', () => {
    expect(trayIconSize(1)).toBe(16);
    expect(trayIconSize(1.25)).toBe(20);
    expect(trayIconSize(1.5)).toBe(24);
    expect(trayIconSize(2)).toBe(32);
  });

  it('never goes below 16 or fails on a bad scale', () => {
    for (const scale of [0, 0.5, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(trayIconSize(scale)).toBe(16);
    }
  });
});

describe('tooltip', () => {
  it('gives the exact numbers the bars round away', () => {
    expect(trayTooltip({ cpu: 23.4, memory: 61.6, gpu: 9 })).toBe(
      'Task Manager\nCPU 23%   RAM 62%   GPU 9%',
    );
  });

  it('says a value was not measured rather than showing zero', () => {
    expect(trayTooltip({ cpu: undefined, memory: 40, gpu: 5 })).toContain('CPU n/a');
  });

  it('leaves GPU out on a machine without one', () => {
    expect(trayTooltip({ cpu: 10, memory: 20, gpu: null })).not.toContain('GPU');
  });

  it('fits the 127 characters Windows allows and uses no dashes', () => {
    const tooltip = trayTooltip({ cpu: 100, memory: 100, gpu: 100 });
    expect(tooltip.length).toBeLessThanOrEqual(127);
    expect(tooltip).not.toMatch(/[–—]/);
  });
});

describe('reading a snapshot', () => {
  function snapshot(overrides: Record<string, unknown> = {}): SystemSnapshot {
    return {
      cpu: { aggregateTimeUtilizationPercent: 12 },
      memory: { physicalUtilizationPercent: 55, totalPhysicalBytes: 16e9 },
      gpu: {
        unavailable: false,
        adapters: [
          { luid: 'a', isSoftware: false, engines: [], utilisationPercent: 30 },
          { luid: 'b', isSoftware: true, engines: [], utilisationPercent: 80 },
        ],
      },
      ...overrides,
    } as unknown as SystemSnapshot;
  }

  it('takes the same values the widget shows', () => {
    expect(readTrayReadings(snapshot())).toEqual({ cpu: 12, memory: 55, gpu: 30 });
  });

  it('treats the zeroed memory section of a failed read as unmeasured', () => {
    // The collector sends zeros with a total of zero when Windows refuses the
    // call; an empty bar would present that as a measurement.
    const readings = readTrayReadings(
      snapshot({ memory: { physicalUtilizationPercent: 0, totalPhysicalBytes: 0 } }),
    );
    expect(readings.memory).toBeUndefined();
  });

  it('has no GPU when the counters are missing or only a software renderer exists', () => {
    expect(readTrayReadings(snapshot({ gpu: { unavailable: true, adapters: [] } })).gpu).toBeNull();
    expect(
      readTrayReadings(
        snapshot({
          gpu: {
            unavailable: false,
            adapters: [{ luid: 'b', isSoftware: true, engines: [], utilisationPercent: 80 }],
          },
        }),
      ).gpu,
    ).toBeNull();
  });
});
