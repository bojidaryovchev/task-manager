import { describe, expect, it } from 'vitest';
import {
  formatBitsPerSecond,
  formatBytes,
  formatBytesPerSecond,
  formatCount,
  formatDuration,
  formatFrequency,
  formatMilliseconds,
  formatPercent,
} from './format.js';

describe('formatBytes', () => {
  it('uses binary multiples with the labels Windows uses', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1023)).toBe('1023 B');
    expect(formatBytes(1024)).toBe('1.00 KB');
    expect(formatBytes(1024 * 1024)).toBe('1.00 MB');
    expect(formatBytes(1024 ** 3)).toBe('1.00 GB');
    expect(formatBytes(1024 ** 4)).toBe('1.00 TB');
  });

  it('reduces precision as the number grows so columns stay narrow', () => {
    expect(formatBytes(1.5 * 1024 ** 3)).toBe('1.50 GB');
    expect(formatBytes(15.5 * 1024 ** 3)).toBe('15.5 GB');
    expect(formatBytes(155.5 * 1024 ** 3)).toBe('156 GB');
  });

  it('renders a missing measurement as an em dash rather than zero', () => {
    // "we did not measure this" and "we measured zero" are different facts.
    expect(formatBytes(undefined)).toBe('—');
    expect(formatBytes(null)).toBe('—');
    expect(formatBytes(Number.NaN)).toBe('—');
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe('—');
    expect(formatBytes(0)).toBe('0 B');
  });

  it('keeps the sign of a negative delta', () => {
    expect(formatBytes(-1024 * 1024)).toBe('-1.00 MB');
  });

  it('does not run past the largest unit', () => {
    expect(formatBytes(1024 ** 7)).toMatch(/PB$/);
  });
});

describe('formatPercent', () => {
  it('formats with one decimal by default', () => {
    expect(formatPercent(14.28)).toBe('14.3%');
    expect(formatPercent(0)).toBe('0.0%');
  });

  it('does not clamp above 100, because processor utility legitimately exceeds it', () => {
    expect(formatPercent(117.9)).toBe('117.9%');
  });

  it('distinguishes an absent value from zero', () => {
    expect(formatPercent(undefined)).toBe('—');
    expect(formatPercent(0)).toBe('0.0%');
  });
});

describe('formatBytesPerSecond', () => {
  it('shows a rate below one byte per second as zero rather than a tiny fraction', () => {
    expect(formatBytesPerSecond(0.4)).toBe('0 B/s');
  });

  it('formats real rates', () => {
    expect(formatBytesPerSecond(1024 * 1024 * 12.5)).toBe('12.5 MB/s');
  });

  it('distinguishes absent from zero', () => {
    expect(formatBytesPerSecond(undefined)).toBe('—');
  });
});

describe('formatBitsPerSecond', () => {
  it('converts bytes to bits and uses decimal multiples, as networking does', () => {
    // 1 MB/s = 8 Mbit/s, and network units are powers of 1000.
    expect(formatBitsPerSecond(1_000_000)).toBe('8.0 Mbps');
    // 125 B/s is exactly 1000 bps, which promotes to the next unit.
    expect(formatBitsPerSecond(125)).toBe('1.0 Kbps');
    expect(formatBitsPerSecond(124)).toBe('992 bps');
  });
});

describe('formatFrequency', () => {
  it('switches to GHz at 1000 MHz', () => {
    expect(formatFrequency(999)).toBe('999 MHz');
    expect(formatFrequency(1000)).toBe('1.00 GHz');
    expect(formatFrequency(5036)).toBe('5.04 GHz');
  });
});

describe('formatDuration', () => {
  it('formats a clock, adding days only when there are any', () => {
    expect(formatDuration(0)).toBe('00:00:00');
    expect(formatDuration(61_000)).toBe('00:01:01');
    expect(formatDuration(3_661_000)).toBe('01:01:01');
    expect(formatDuration(90_061_000)).toBe('1:01:01:01');
  });

  it('rejects a negative or absent duration', () => {
    expect(formatDuration(-1)).toBe('—');
    expect(formatDuration(undefined)).toBe('—');
  });
});

describe('formatCount and formatMilliseconds', () => {
  it('groups counts and rounds them', () => {
    expect(formatCount(1234567)).toBe((1234567).toLocaleString());
    expect(formatCount(undefined)).toBe('—');
  });

  it('formats millisecond durations at fixed precision', () => {
    expect(formatMilliseconds(501.837)).toBe('501.84 ms');
    expect(formatMilliseconds(501.837, 0)).toBe('502 ms');
    expect(formatMilliseconds(undefined)).toBe('—');
  });
});
