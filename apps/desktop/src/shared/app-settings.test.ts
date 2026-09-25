import { describe, expect, it } from 'vitest';
import { readAppSettingsPatch, speedForInterval, UPDATE_INTERVALS_MS } from './app-settings.js';

describe('application settings from a renderer', () => {
  it('keeps what it knows, with the right types', () => {
    expect(readAppSettingsPatch({ updateSpeed: 'slow', paused: true, alwaysOnTop: false })).toEqual({
      updateSpeed: 'slow',
      paused: true,
      alwaysOnTop: false,
    });
  });

  it('drops unknown keys and wrong types rather than guessing', () => {
    expect(
      readAppSettingsPatch({ updateSpeed: 'ludicrous', paused: 'yes', intervalMs: 1, closeToTray: 0 }),
    ).toEqual({});
    expect(readAppSettingsPatch(null)).toEqual({});
  });
});

describe('update speeds', () => {
  it('maps each interval back to its speed, and anything else to the default', () => {
    for (const [speed, interval] of Object.entries(UPDATE_INTERVALS_MS)) {
      expect(speedForInterval(interval)).toBe(speed);
    }
    expect(speedForInterval(750)).toBe('fast');
  });
});
