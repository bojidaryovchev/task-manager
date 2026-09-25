/**
 * Row selection for a list whose order changes under it.
 *
 * Rows are identified by key, never by position: the process list re-sorts
 * twice a second, and a selection held by index would silently move to a
 * different process between one sample and the next. The order is supplied
 * fresh for every gesture that needs one.
 */
export interface Selection {
  keys: ReadonlySet<string>;
  /** The row the keyboard moves from, and whose details are shown. */
  focus: string | null;
  /** Where a Shift-extended range starts. */
  anchor: string | null;
}

export const EMPTY_SELECTION: Selection = { keys: new Set(), focus: null, anchor: null };

function only(key: string): Selection {
  return { keys: new Set([key]), focus: key, anchor: key };
}

function between(order: readonly string[], from: string, to: string): string[] {
  const start = order.indexOf(from);
  const end = order.indexOf(to);
  if (start < 0 || end < 0) return [to];
  return order.slice(Math.min(start, end), Math.max(start, end) + 1);
}

/** A click, with Ctrl adding or removing one row and Shift taking a range. */
export function clickSelection(
  order: readonly string[],
  current: Selection,
  key: string,
  how: { toggle?: boolean; range?: boolean },
): Selection {
  if (how.range && current.anchor) {
    const range = between(order, current.anchor, key);
    const keys = how.toggle ? new Set([...current.keys, ...range]) : new Set(range);
    return { keys, focus: key, anchor: current.anchor };
  }
  if (how.toggle) {
    const keys = new Set(current.keys);
    if (keys.has(key)) keys.delete(key);
    else keys.add(key);
    return { keys, focus: key, anchor: key };
  }
  return only(key);
}

/**
 * A right-click. On a selected row it keeps the whole selection, so the menu
 * acts on all of it; on any other row it selects just that one, as Explorer
 * does.
 */
export function contextSelection(current: Selection, key: string): Selection {
  return current.keys.has(key) ? { ...current, focus: key } : only(key);
}

/** An arrow, Home or End key, with Shift extending from the anchor. */
export function moveSelection(
  order: readonly string[],
  current: Selection,
  to: number | 'first' | 'last',
  extend: boolean,
): Selection {
  if (order.length === 0) return current;
  const from = current.focus ? order.indexOf(current.focus) : -1;
  const index =
    to === 'first'
      ? 0
      : to === 'last'
        ? order.length - 1
        : Math.min(order.length - 1, Math.max(0, from < 0 ? 0 : from + to));
  const key = order[index]!;
  if (extend && current.anchor) {
    return { keys: new Set(between(order, current.anchor, key)), focus: key, anchor: current.anchor };
  }
  return only(key);
}

/** The selected keys that are still in the list, in list order. */
export function visibleSelection(order: readonly string[], current: Selection): string[] {
  return order.filter((key) => current.keys.has(key));
}
