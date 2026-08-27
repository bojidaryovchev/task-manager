/**
 * Fixed-capacity ring buffers for live charts.
 *
 * Charts must never grow without bound. Every series here allocates once and
 * overwrites in place, so enabling a chart costs a constant amount of memory no
 * matter how long the application runs.
 */

/** A fixed-capacity series of numbers, oldest to newest. */
export class RingBuffer {
  readonly capacity: number;
  #values: Float64Array;
  #start = 0;
  #length = 0;

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new Error(`RingBuffer capacity must be a positive integer, got ${capacity}`);
    }
    this.capacity = capacity;
    this.#values = new Float64Array(capacity);
  }

  get length(): number {
    return this.#length;
  }

  /** Append a value, discarding the oldest once full. */
  push(value: number): void {
    const index = (this.#start + this.#length) % this.capacity;
    this.#values[index] = value;
    if (this.#length < this.capacity) {
      this.#length += 1;
    } else {
      this.#start = (this.#start + 1) % this.capacity;
    }
  }

  /** Value at `index`, where 0 is the oldest retained sample. */
  at(index: number): number | undefined {
    if (index < 0 || index >= this.#length) return undefined;
    return this.#values[(this.#start + index) % this.capacity];
  }

  /** Most recent value, or undefined when empty. */
  get last(): number | undefined {
    return this.at(this.#length - 1);
  }

  /**
   * Copy into a contiguous array, oldest first.
   *
   * Pass `into` to reuse an array across frames and avoid allocating one per
   * render; it is resized only when the length changes.
   */
  toArray(into?: number[]): number[] {
    const out = into ?? [];
    out.length = this.#length;
    for (let i = 0; i < this.#length; i += 1) {
      out[i] = this.#values[(this.#start + i) % this.capacity] as number;
    }
    return out;
  }

  /** Largest retained value, or 0 when empty. */
  max(): number {
    let max = 0;
    for (let i = 0; i < this.#length; i += 1) {
      const value = this.#values[(this.#start + i) % this.capacity] as number;
      if (value > max) max = value;
    }
    return max;
  }

  clear(): void {
    this.#start = 0;
    this.#length = 0;
  }
}

/**
 * A named group of ring buffers that all advance together, so every series in a
 * chart has the same number of points and the same time base.
 */
export class SeriesSet<Name extends string> {
  readonly capacity: number;
  readonly #series: Map<Name, RingBuffer> = new Map();

  constructor(names: readonly Name[], capacity: number) {
    this.capacity = capacity;
    for (const name of names) {
      this.#series.set(name, new RingBuffer(capacity));
    }
  }

  get(name: Name): RingBuffer {
    const series = this.#series.get(name);
    if (!series) throw new Error(`Unknown series "${name}"`);
    return series;
  }

  /**
   * Append one sample per series. A series whose value is undefined receives
   * `NaN`, which chart code renders as a gap rather than as zero.
   */
  push(values: Partial<Record<Name, number | undefined>>): void {
    for (const [name, series] of this.#series) {
      const value = values[name];
      series.push(value === undefined || value === null ? Number.NaN : value);
    }
  }

  clear(): void {
    for (const series of this.#series.values()) series.clear();
  }
}
