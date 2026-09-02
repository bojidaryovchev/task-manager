import { describe, expect, it } from 'vitest';
import { ERROR_CODES, ERROR_CODE_LIST, describeErrorCode } from './error-codes.js';

/**
 * The registry's promises, enforced.
 *
 * A code is only worth having if it is stable and if it says something useful.
 * These tests hold the registry to both: every entry has to explain what the
 * condition costs and what to do about it, and the numbering has to stay inside
 * the block that identifies its subsystem, so a code can be placed at a glance.
 */
describe('the error code registry', () => {
  it('gives every code a meaning and an action', () => {
    // A code that only names a problem leaves the reader where they started.
    for (const definition of ERROR_CODE_LIST) {
      expect(definition.title.length, definition.code).toBeGreaterThan(10);
      expect(definition.meaning.length, definition.code).toBeGreaterThan(40);
      expect(definition.action.length, definition.code).toBeGreaterThan(15);
    }
  });

  it('uses the numeric block that matches the subsystem', () => {
    // The first digit places a code without looking it up.
    const block: Record<string, string> = {
      startup: '1',
      collector: '2',
      history: '3',
      settings: '4',
      widget: '5',
      export: '6',
      crash: '7',
      renderer: '8',
      logging: '9',
    };
    for (const definition of ERROR_CODE_LIST) {
      const digit = definition.code.replace('TM-', '')[0];
      expect(digit, `${definition.code} (${definition.subsystem})`).toBe(
        block[definition.subsystem],
      );
    }
  });

  it('uses one consistent, greppable format', () => {
    // Short enough to read down a phone line or off a screenshot.
    for (const definition of ERROR_CODE_LIST) {
      expect(definition.code).toMatch(/^TM-\d{4}$/);
    }
  });

  it('has no duplicate codes', () => {
    const codes = ERROR_CODE_LIST.map((d) => d.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('looks a code up', () => {
    expect(describeErrorCode('TM-2001')?.subsystem).toBe('collector');
    expect(describeErrorCode('TM-2001')?.title).toContain('native');
  });

  it('returns null for a code it does not know', () => {
    // A log written by a newer version must not break an older reader.
    expect(describeErrorCode('TM-9999')).toBeNull();
    expect(describeErrorCode('')).toBeNull();
    expect(describeErrorCode('nonsense')).toBeNull();
  });

  it('covers every subsystem that can fail', () => {
    const covered = new Set(ERROR_CODE_LIST.map((d) => d.subsystem));
    for (const subsystem of [
      'startup',
      'collector',
      'history',
      'settings',
      'widget',
      'export',
      'crash',
      'renderer',
      'logging',
    ]) {
      expect(covered.has(subsystem as never), subsystem).toBe(true);
    }
  });

  it('never says only that something went wrong', () => {
    // The phrasing this whole registry exists to replace.
    for (const definition of ERROR_CODE_LIST) {
      expect(definition.meaning.toLowerCase(), definition.code).not.toContain(
        'something went wrong',
      );
      expect(definition.action.toLowerCase(), definition.code).not.toContain('try again later');
    }
  });

  it('exposes the same entries as a list and as a map', () => {
    expect(ERROR_CODE_LIST).toHaveLength(Object.keys(ERROR_CODES).length);
  });
});
