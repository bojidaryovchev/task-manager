/**
 * Presentation helpers. Pure functions only - no telemetry is calculated here,
 * these just turn numbers the collector produced into strings.
 */

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'] as const;

/**
 * Format a byte count using binary multiples with decimal-style labels, which is
 * the convention Windows itself uses ("GB" meaning 1024^3).
 */
export function formatBytes(bytes: number | null | undefined, fractionDigits?: number): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return '—';
  const sign = bytes < 0 ? '-' : '';
  let value = Math.abs(bytes);
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = fractionDigits ?? (unit === 0 ? 0 : value >= 100 ? 0 : value >= 10 ? 1 : 2);
  return `${sign}${value.toFixed(digits)} ${BYTE_UNITS[unit]}`;
}

/** Bytes per second, e.g. "12.4 MB/s". */
export function formatBytesPerSecond(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  if (value < 1) return '0 B/s';
  return `${formatBytes(value)}/s`;
}

/** Bits per second in network conventions, e.g. "8.2 Mbps". */
export function formatBitsPerSecond(bytesPerSecond: number | null | undefined): string {
  if (
    bytesPerSecond === null ||
    bytesPerSecond === undefined ||
    !Number.isFinite(bytesPerSecond)
  ) {
    return '—';
  }
  const bits = bytesPerSecond * 8;
  const units = ['bps', 'Kbps', 'Mbps', 'Gbps'];
  let value = bits;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return `${value.toFixed(value >= 100 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

/**
 * Format a percentage. `undefined` renders as an em dash rather than "0%",
 * because a missing measurement is not a measurement of zero.
 */
export function formatPercent(
  value: number | null | undefined,
  fractionDigits = 1,
): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return `${value.toFixed(fractionDigits)}%`;
}

/** Frequency in MHz, rendered as GHz above 1000. */
export function formatFrequency(mhz: number | null | undefined): string {
  if (mhz === null || mhz === undefined || !Number.isFinite(mhz)) return '—';
  if (mhz >= 1000) return `${(mhz / 1000).toFixed(2)} GHz`;
  return `${mhz.toFixed(0)} MHz`;
}

/** A duration in milliseconds as `d:hh:mm:ss`, used for uptime and process age. */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return '—';
  const totalSeconds = Math.floor(ms / 1000);
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (n: number) => n.toString().padStart(2, '0');
  const clock = `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
  return days > 0 ? `${days}:${clock}` : clock;
}

/** Integer with thousands separators. */
export function formatCount(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return Math.round(value).toLocaleString();
}

/** Milliseconds with a fixed precision, for the diagnostics view. */
export function formatMilliseconds(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return `${value.toFixed(digits)} ms`;
}

/**
 * A large counter value, grouped for readability. Used in the debug view where
 * the raw 100ns deltas matter.
 */
export function formatRaw(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return Math.round(value).toLocaleString();
}

/** Local wall-clock time, seconds precision. */
export function formatTimeOfDay(unixMs: number | null | undefined): string {
  if (unixMs === null || unixMs === undefined || !Number.isFinite(unixMs)) return '—';
  return new Date(unixMs).toLocaleTimeString(undefined, { hour12: false });
}
