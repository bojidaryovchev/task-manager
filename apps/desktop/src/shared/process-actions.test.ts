import { describe, expect, it } from 'vitest';
import {
  isProcessKey,
  MAX_KEYS_PER_REQUEST,
  readProcessKeys,
  readProcessMenuRequest,
  readProcessorIndices,
} from './process-actions.js';

/**
 * These are the gate every request to act on a process passes through on its
 * way from a page to the main process, so anything malformed stops here.
 */
describe('process keys', () => {
  it('accepts exactly the pid:createTime shape the snapshots carry', () => {
    expect(isProcessKey('4312:133712345678901234')).toBe(true);
    for (const bad of ['', '4312', '4312:', ':1', 'a:1', '1:1:1', ' 1:1', '-1:1', 1, null, {}]) {
      expect(isProcessKey(bad), String(bad)).toBe(false);
    }
  });

  it('refuses a list with anything else in it, rather than acting on the rest', () => {
    expect(readProcessKeys(['1:1', 'rm -rf'])).toBeNull();
    expect(readProcessKeys('1:1')).toBeNull();
    expect(readProcessKeys([])).toBeNull();
  });

  it('refuses an absurdly long list', () => {
    const many = Array.from({ length: MAX_KEYS_PER_REQUEST + 1 }, (_, index) => `${index * 4}:1`);
    expect(readProcessKeys(many)).toBeNull();
  });

  it('drops duplicates', () => {
    expect(readProcessKeys(['8:1', '8:1', '12:1'])).toEqual(['8:1', '12:1']);
  });
});

describe('processor lists from the affinity dialog', () => {
  it('accepts indices, sorted and without repeats', () => {
    expect(readProcessorIndices([3, 1, 1, 0])).toEqual([0, 1, 3]);
  });

  it('refuses an empty list, since a process must be allowed somewhere', () => {
    expect(readProcessorIndices([])).toBeNull();
  });

  it('refuses anything that is not a processor index', () => {
    for (const bad of [[-1], [64], [1.5], ['0'], [null], 'all', null]) {
      expect(readProcessorIndices(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe('menu requests', () => {
  it('accepts a well-formed request', () => {
    expect(
      readProcessMenuRequest({ keys: ['8:1'], context: 'applications', applicationName: 'Chrome' }),
    ).toEqual({ keys: ['8:1'], context: 'applications', applicationName: 'Chrome' });
  });

  it('accepts a request from the widget', () => {
    expect(readProcessMenuRequest({ keys: ['8:1'], context: 'widget' })).toEqual({
      keys: ['8:1'],
      context: 'widget',
    });
  });

  it('refuses an unknown context or an oversized name', () => {
    expect(readProcessMenuRequest({ keys: ['8:1'], context: 'services' })).toBeNull();
    expect(
      readProcessMenuRequest({ keys: ['8:1'], context: 'processes', applicationName: 'x'.repeat(201) }),
    ).toBeNull();
  });

  it('ignores a blank application name', () => {
    expect(readProcessMenuRequest({ keys: ['8:1'], context: 'processes', applicationName: ' ' })).toEqual({
      keys: ['8:1'],
      context: 'processes',
    });
  });
});
