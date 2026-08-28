import { describe, expect, it } from 'vitest';
import { clampMeasuredWidth } from './widget-window.js';

/**
 * The one place a number from a renderer becomes a window dimension.
 *
 * The widget is frameless, transparent and always on top. A window a few pixels
 * wide cannot be grabbed and a window wider than the desktop cannot be moved
 * off it, so a bad value here leaves the widget genuinely unusable rather than
 * merely wrong.
 */
describe('clampMeasuredWidth', () => {
  it('rounds a plausible measurement to whole pixels', () => {
    expect(clampMeasuredWidth(372.4)).toBe(372);
    expect(clampMeasuredWidth(372.6)).toBe(373);
  });

  it('refuses anything that is not a usable number', () => {
    for (const value of [undefined, null, 'wide', {}, Number.NaN, Number.POSITIVE_INFINITY, 0, -5]) {
      expect(clampMeasuredWidth(value)).toBeNull();
    }
  });

  it('never returns a window too narrow to grab', () => {
    expect(clampMeasuredWidth(1)).toBe(120);
    expect(clampMeasuredWidth(119)).toBe(120);
  });

  it('never returns a window that would span the desktop', () => {
    expect(clampMeasuredWidth(99_999)).toBe(1200);
  });

  it('leaves a width inside the range alone', () => {
    expect(clampMeasuredWidth(120)).toBe(120);
    expect(clampMeasuredWidth(656)).toBe(656);
    expect(clampMeasuredWidth(1200)).toBe(1200);
  });
});
