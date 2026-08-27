import { describe, expect, it } from 'vitest';
import { RingBuffer, SeriesSet } from './history.js';

describe('RingBuffer', () => {
  it('rejects a nonsensical capacity instead of misbehaving later', () => {
    expect(() => new RingBuffer(0)).toThrow();
    expect(() => new RingBuffer(-1)).toThrow();
    expect(() => new RingBuffer(1.5)).toThrow();
  });

  it('fills up to capacity then discards the oldest sample', () => {
    const buffer = new RingBuffer(3);
    buffer.push(1);
    buffer.push(2);
    buffer.push(3);
    expect(buffer.toArray()).toEqual([1, 2, 3]);
    buffer.push(4);
    // Capacity is a hard bound; a chart cannot grow without limit.
    expect(buffer.length).toBe(3);
    expect(buffer.toArray()).toEqual([2, 3, 4]);
  });

  it('indexes from the oldest retained sample after wrapping', () => {
    const buffer = new RingBuffer(3);
    for (const value of [1, 2, 3, 4, 5]) buffer.push(value);
    expect(buffer.at(0)).toBe(3);
    expect(buffer.at(2)).toBe(5);
    expect(buffer.last).toBe(5);
    expect(buffer.at(-1)).toBeUndefined();
    expect(buffer.at(3)).toBeUndefined();
  });

  it('reports no last value when empty', () => {
    expect(new RingBuffer(4).last).toBeUndefined();
    expect(new RingBuffer(4).toArray()).toEqual([]);
  });

  it('reuses a caller-supplied array so rendering does not allocate per frame', () => {
    const buffer = new RingBuffer(3);
    buffer.push(1);
    buffer.push(2);
    const target: number[] = [];
    const first = buffer.toArray(target);
    expect(first).toBe(target);
    buffer.push(3);
    buffer.push(4);
    const second = buffer.toArray(target);
    expect(second).toBe(target);
    expect(second).toEqual([2, 3, 4]);
  });

  it('reports the maximum over the retained window only', () => {
    const buffer = new RingBuffer(3);
    buffer.push(100);
    buffer.push(1);
    buffer.push(2);
    expect(buffer.max()).toBe(100);
    // Once the spike falls out of the window it no longer scales the chart.
    buffer.push(3);
    expect(buffer.max()).toBe(3);
  });

  it('reports zero maximum when empty', () => {
    expect(new RingBuffer(5).max()).toBe(0);
  });

  it('clears back to empty without reallocating', () => {
    const buffer = new RingBuffer(3);
    buffer.push(1);
    buffer.clear();
    expect(buffer.length).toBe(0);
    expect(buffer.last).toBeUndefined();
    buffer.push(9);
    expect(buffer.toArray()).toEqual([9]);
  });
});

describe('SeriesSet', () => {
  it('advances every series together so they share a time base', () => {
    const set = new SeriesSet(['a', 'b'] as const, 4);
    set.push({ a: 1, b: 2 });
    set.push({ a: 3, b: 4 });
    expect(set.get('a').toArray()).toEqual([1, 3]);
    expect(set.get('b').toArray()).toEqual([2, 4]);
    expect(set.get('a').length).toBe(set.get('b').length);
  });

  it('stores a missing measurement as NaN so charts draw a gap, not a zero', () => {
    const set = new SeriesSet(['a'] as const, 4);
    set.push({ a: 5 });
    set.push({ a: undefined });
    set.push({ a: 7 });
    const values = set.get('a').toArray();
    expect(values[0]).toBe(5);
    expect(Number.isNaN(values[1] as number)).toBe(true);
    expect(values[2]).toBe(7);
    // A gap must not drag the axis toward zero.
    expect(set.get('a').max()).toBe(7);
  });

  it('treats an omitted series in a push as a gap', () => {
    const set = new SeriesSet(['a', 'b'] as const, 4);
    set.push({ a: 1 });
    expect(Number.isNaN(set.get('b').at(0) as number)).toBe(true);
    // Both series still advanced, so indices stay aligned.
    expect(set.get('a').length).toBe(1);
    expect(set.get('b').length).toBe(1);
  });

  it('throws on an unknown series name rather than silently doing nothing', () => {
    const set = new SeriesSet(['a'] as const, 2);
    // @ts-expect-error deliberately wrong name
    expect(() => set.get('nope')).toThrow();
  });

  it('clears every series', () => {
    const set = new SeriesSet(['a', 'b'] as const, 4);
    set.push({ a: 1, b: 2 });
    set.clear();
    expect(set.get('a').length).toBe(0);
    expect(set.get('b').length).toBe(0);
  });
});
