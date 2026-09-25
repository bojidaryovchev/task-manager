import { describe, expect, it } from 'vitest';
import { DEFAULT_PROCESS_COLUMNS, normaliseProcessColumns, PROCESS_COLUMNS } from './process-columns.js';

describe('choosing process columns', () => {
  it('falls back to the columns the page always showed', () => {
    expect(normaliseProcessColumns(undefined)).toEqual(DEFAULT_PROCESS_COLUMNS);
    expect(normaliseProcessColumns('cpu')).toEqual(DEFAULT_PROCESS_COLUMNS);
  });

  it('keeps known columns in layout order, whatever order they arrive in', () => {
    expect(normaliseProcessColumns(['user', 'pid', 'cpu'])).toEqual(['pid', 'cpu', 'user']);
  });

  it('drops anything it does not know, and duplicates', () => {
    expect(normaliseProcessColumns(['pid', 'pid', 'password', 7, null])).toEqual(['pid']);
  });

  it('allows showing no optional columns at all, since Name always shows', () => {
    expect(normaliseProcessColumns([])).toEqual([]);
  });

  it('names every column once', () => {
    const ids = PROCESS_COLUMNS.map((column) => column.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
