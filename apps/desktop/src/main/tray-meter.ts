import type { SystemSnapshot } from '@task-manager/telemetry-types';
import { busiestHardwareAdapter } from '@task-manager/shared';

/**
 * The live tray icon: CPU, memory and GPU as three bars, the way Windows Task
 * Manager shows CPU in the notification area.
 *
 * Everything here is pure - readings in, pixels out - so the whole icon can be
 * tested down to the byte without a tray, a display or Electron.
 *
 * # Three facts this file is built on, all established rather than assumed
 *
 * **The tray uses the 1x bitmap at its native pixel size.** Electron's
 * `Tray::SetImage` calls `NativeImage::GetHICON(GetSystemMetrics(SM_CXSMICON))`,
 * and `GetHICON` ignores that size: it builds the icon from `image_.AsBitmap()`,
 * the 1x representation, and Windows then rescales the result to the
 * notification area. Supplying high-DPI representations does nothing. So the
 * icon is drawn at exactly the notification area's pixel size - 24 at 150%
 * scaling - as a 1x image, and nothing is ever resampled. A 16-pixel icon on a
 * 150% display is stretched to 24, which is why a bar chart drawn that way
 * would arrive blurred.
 *
 * **The pixel format is BGRA with premultiplied alpha.** Verified by writing a
 * known pixel through `createFromBitmap` and reading it back out of the PNG it
 * encodes to. Every pixel here is either fully opaque or fully transparent, so
 * premultiplication changes nothing - provided a transparent pixel is all
 * zeroes, which a test holds it to.
 *
 * **Each redraw costs graphics handles until garbage collection.** That is the
 * tray's concern rather than this file's, and is dealt with in `tray.ts`.
 */

/**
 * Colours, each taken from a design token so the tray matches the rest of the
 * application. `TRAY_PALETTE_TOKENS` names the token, and a test fails if the
 * two ever drift apart.
 */
export const TRAY_PALETTE = {
  /**
   * The outline. A mid grey, because it has to separate the tile from the
   * taskbar behind it whether that taskbar is dark or light: it holds at least
   * 3:1 against both Windows' dark and light base colours.
   */
  frame: '#838c98',
  /**
   * The lines between the bars and the margin around them: the application's
   * white. The bars themselves sit on their own dark tracks, so this changes
   * how the columns are divided without touching what the bars say.
   */
  separator: '#e6eaf0',
  /** The unfilled part of each bar: how much room there is left. */
  track: '#2b323d',
  cpu: '#4a9eff',
  memory: '#a970ff',
  gpu: '#ff6b9d',
} as const;

export const TRAY_PALETTE_TOKENS: Record<keyof typeof TRAY_PALETTE, string> = {
  frame: '--color-text-muted',
  separator: '--color-text-primary',
  track: '--color-chart-grid',
  cpu: '--color-cpu',
  memory: '--color-memory',
  gpu: '--color-gpu',
};

/** The values the icon shows, already computed by the collector. */
export interface TrayReadings {
  /** CPU time utilization, 0..100. Undefined when not measured this interval. */
  cpu: number | undefined;
  /** Physical memory in use, 0..100. Undefined when not measured. */
  memory: number | undefined;
  /**
   * The busiest hardware GPU, 0..100. Undefined when the GPU reported no
   * activity this interval; **null when the machine has no hardware GPU to
   * describe**, in which case the icon has two bars rather than an empty third.
   */
  gpu: number | undefined | null;
}

/**
 * Pick the tray's three values out of a snapshot.
 *
 * The same values the widget's CPU, RAM % and GPU tiles show, chosen the same
 * way, so the tray and the widget cannot disagree.
 */
export function readTrayReadings(snapshot: SystemSnapshot): TrayReadings {
  const adapter = busiestHardwareAdapter(snapshot);
  return {
    cpu: snapshot.cpu.aggregateTimeUtilizationPercent,
    // When Windows refuses GlobalMemoryStatusEx the collector sends a zeroed
    // memory section with a total of zero. That zero is not a measurement, and
    // drawing it as an empty bar would present it as one.
    memory:
      snapshot.memory.totalPhysicalBytes > 0 ? snapshot.memory.physicalUtilizationPercent : undefined,
    gpu: snapshot.gpu.unavailable || adapter === null ? null : adapter.utilisationPercent,
  };
}

/**
 * The notification area's icon size, in physical pixels, for a display scale.
 *
 * Windows draws tray icons at 16 pixels scaled by the display: 20 at 125%, 24
 * at 150%, 32 at 200%.
 */
export function trayIconSize(scaleFactor: number): number {
  if (!Number.isFinite(scaleFactor) || scaleFactor <= 1) return 16;
  return Math.round(16 * scaleFactor);
}

export interface MeterLayout {
  size: number;
  /** Outline thickness. */
  frame: number;
  /** Radius of the transparent cut at each corner. */
  corner: number;
  /** First row of the bars. */
  trackTop: number;
  /** Rows available to each bar: its full-scale height. */
  trackHeight: number;
  bars: { x: number; width: number }[];
}

/**
 * Where the bars go at a given size.
 *
 * The bars have to be the same width and the icon has to be symmetric, and at
 * these sizes one stray pixel is visible - 16 pixels split three ways does not
 * divide evenly unless the gaps and margins are chosen to make it. So a small
 * set of arrangements is tried and the widest bars that still come out
 * symmetric win; on a tie, the one with a margin inside the outline, which
 * reads less cramped.
 */
export function meterLayout(size: number, count: number): MeterLayout {
  const frame = Math.max(1, Math.floor(size / 16));
  const arrangements = [
    { inset: frame, gap: frame },
    { inset: frame, gap: frame + 1 },
    { inset: 0, gap: frame },
    { inset: 0, gap: frame + 1 },
  ];

  type Arrangement = { inset: number; gap: number; width: number; spare: number };
  let best: Arrangement | null = null;
  let fallback: Arrangement | null = null;
  for (const { inset, gap } of arrangements) {
    const available = size - 2 * frame - 2 * inset;
    const width = Math.floor((available - (count - 1) * gap) / count);
    if (width < 2) continue;
    const spare = available - (count * width + (count - 1) * gap);
    const candidate = { inset, gap, width, spare };
    fallback ??= candidate;
    if (spare % 2 !== 0) continue;
    if (best === null || width > best.width) best = candidate;
  }
  // Every size in use has a symmetric arrangement; this only matters for an
  // implausible size, where a slightly lopsided icon beats no icon.
  const chosen = best ?? fallback ?? { inset: 0, gap: 1, width: 1, spare: 0 };

  const left = frame + chosen.inset + Math.floor(chosen.spare / 2);
  const bars = Array.from({ length: count }, (_, index) => ({
    x: left + index * (chosen.width + chosen.gap),
    width: chosen.width,
  }));
  const trackTop = frame + chosen.inset;
  return {
    size,
    frame,
    corner: 2 * frame,
    trackTop,
    trackHeight: size - 2 * trackTop,
    bars,
  };
}

export interface MeterFrame {
  /** size x size pixels, BGRA, premultiplied alpha. */
  pixels: Buffer;
  /** Filled rows per bar, bottom up. */
  fills: number[];
  /**
   * Identifies what was drawn. Two readings that land on the same pixels have
   * the same key, so the tray can skip a redraw that would change nothing.
   */
  key: string;
}

/** How many rows of a bar a value fills. Absent, negative or NaN fills none. */
export function fillRows(value: number | undefined, trackHeight: number): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return 0;
  // Clamped for drawing only: a figure above 100 fills the bar, and the
  // tooltip still carries the real number.
  return Math.round(Math.min(value, 100) / 100 * trackHeight);
}

/** Draw the icon. */
export function renderTrayMeter(readings: TrayReadings, size: number): MeterFrame {
  const series: { value: number | undefined; colour: string }[] = [
    { value: readings.cpu, colour: TRAY_PALETTE.cpu },
    { value: readings.memory, colour: TRAY_PALETTE.memory },
  ];
  if (readings.gpu !== null) series.push({ value: readings.gpu, colour: TRAY_PALETTE.gpu });

  const layout = meterLayout(size, series.length);
  const pixels = Buffer.alloc(size * size * 4);
  const frameColour = bgra(TRAY_PALETTE.frame);
  const separatorColour = bgra(TRAY_PALETTE.separator);
  const trackColour = bgra(TRAY_PALETTE.track);

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      // Left as zeroes: transparent, which in premultiplied alpha means every
      // channel is zero, not merely alpha.
      if (outsideRoundedCorner(x, y, size, layout.corner)) continue;
      const edge =
        x < layout.frame || y < layout.frame || x >= size - layout.frame || y >= size - layout.frame;
      paint(pixels, size, x, y, edge ? frameColour : separatorColour);
    }
  }

  const fills = series.map((entry) => fillRows(entry.value, layout.trackHeight));
  const bottom = layout.trackTop + layout.trackHeight;
  series.forEach((entry, index) => {
    const bar = layout.bars[index]!;
    const colour = bgra(entry.colour);
    const filledFrom = bottom - fills[index]!;
    for (let y = layout.trackTop; y < bottom; y += 1) {
      for (let x = bar.x; x < bar.x + bar.width; x += 1) {
        paint(pixels, size, x, y, y >= filledFrom ? colour : trackColour);
      }
    }
  });

  return { pixels, fills, key: `${size}|${series.length}|${fills.join(',')}` };
}

/**
 * The tray's tooltip: the exact numbers behind the bars.
 *
 * Windows caps a notification tooltip at 127 characters, so this stays short.
 * A value with no reading says so rather than showing a zero.
 */
export function trayTooltip(readings: TrayReadings): string {
  const parts = [`CPU ${percent(readings.cpu)}`, `RAM ${percent(readings.memory)}`];
  if (readings.gpu !== null) parts.push(`GPU ${percent(readings.gpu)}`);
  return `Task Manager\n${parts.join('   ')}`;
}

function percent(value: number | undefined): string {
  return value === undefined || !Number.isFinite(value) ? 'n/a' : `${Math.round(value)}%`;
}

/** Whether a pixel falls in the transparent cut at a rounded corner. */
function outsideRoundedCorner(x: number, y: number, size: number, radius: number): boolean {
  const cx = x < radius ? radius : x >= size - radius ? size - radius : null;
  const cy = y < radius ? radius : y >= size - radius ? size - radius : null;
  if (cx === null || cy === null) return false;
  // Distance from the pixel's centre to the centre of the corner's arc.
  return Math.hypot(x + 0.5 - cx, y + 0.5 - cy) > radius;
}

function bgra(hex: string): [number, number, number, number] {
  const value = Number.parseInt(hex.slice(1), 16);
  return [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, 0xff];
}

function paint(
  pixels: Buffer,
  size: number,
  x: number,
  y: number,
  [b, g, r, a]: [number, number, number, number],
): void {
  const offset = (y * size + x) * 4;
  pixels[offset] = b;
  pixels[offset + 1] = g;
  pixels[offset + 2] = r;
  pixels[offset + 3] = a;
}
