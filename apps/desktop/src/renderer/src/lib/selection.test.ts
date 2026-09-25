import { describe, expect, it } from 'vitest';
import {
  clickSelection,
  contextSelection,
  EMPTY_SELECTION,
  moveSelection,
  visibleSelection,
  type Selection,
} from './selection.js';

/**
 * Selection decides what End task ends, so it has to be exactly what the
 * user sees highlighted, however the list moves underneath it.
 */
const order = ['a', 'b', 'c', 'd', 'e'];

function keys(selection: Selection): string[] {
  return [...selection.keys].sort();
}

describe('clicking', () => {
  it('selects just the row clicked', () => {
    const selection = clickSelection(order, EMPTY_SELECTION, 'c', {});
    expect(keys(selection)).toEqual(['c']);
    expect(selection.focus).toBe('c');
  });

  it('adds and removes a row with Ctrl', () => {
    let selection = clickSelection(order, EMPTY_SELECTION, 'b', {});
    selection = clickSelection(order, selection, 'd', { toggle: true });
    expect(keys(selection)).toEqual(['b', 'd']);
    selection = clickSelection(order, selection, 'b', { toggle: true });
    expect(keys(selection)).toEqual(['d']);
  });

  it('takes a range with Shift, in either direction', () => {
    const start = clickSelection(order, EMPTY_SELECTION, 'd', {});
    expect(keys(clickSelection(order, start, 'b', { range: true }))).toEqual(['b', 'c', 'd']);
    expect(keys(clickSelection(order, start, 'e', { range: true }))).toEqual(['d', 'e']);
  });

  it('follows the current order, not the order when the range began', () => {
    // The list re-sorted between the two clicks.
    const start = clickSelection(order, EMPTY_SELECTION, 'a', {});
    expect(keys(clickSelection(['c', 'a', 'e', 'b'], start, 'e', { range: true }))).toEqual([
      'a',
      'e',
    ]);
  });
});

describe('right-clicking', () => {
  it('keeps a selection it lands inside, so the menu acts on all of it', () => {
    const selection = clickSelection(order, clickSelection(order, EMPTY_SELECTION, 'a', {}), 'c', {
      range: true,
    });
    expect(keys(contextSelection(selection, 'b'))).toEqual(['a', 'b', 'c']);
  });

  it('selects just the row it lands on otherwise', () => {
    const selection = clickSelection(order, EMPTY_SELECTION, 'a', {});
    expect(keys(contextSelection(selection, 'e'))).toEqual(['e']);
  });
});

describe('the keyboard', () => {
  it('moves by one and stops at the ends', () => {
    let selection = moveSelection(order, EMPTY_SELECTION, 1, false);
    expect(selection.focus).toBe('a');
    selection = moveSelection(order, selection, 1, false);
    expect(selection.focus).toBe('b');
    selection = moveSelection(order, moveSelection(order, selection, 'last', false), 1, false);
    expect(selection.focus).toBe('e');
    expect(moveSelection(order, selection, 'first', false).focus).toBe('a');
  });

  it('extends from the anchor with Shift', () => {
    const start = clickSelection(order, EMPTY_SELECTION, 'b', {});
    const extended = moveSelection(order, moveSelection(order, start, 1, true), 1, true);
    expect(keys(extended)).toEqual(['b', 'c', 'd']);
  });
});

describe('what is actually selected', () => {
  it('leaves out rows that have left the list, in list order', () => {
    const selection = clickSelection(order, clickSelection(order, EMPTY_SELECTION, 'd', {}), 'a', {
      toggle: true,
    });
    expect(visibleSelection(['d', 'x', 'a'], selection)).toEqual(['d', 'a']);
    expect(visibleSelection(['x'], selection)).toEqual([]);
  });
});
