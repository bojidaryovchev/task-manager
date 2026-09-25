/**
 * A menu a page describes and the main process shows: a native menu, like
 * every other in the application, for choices that only concern the page -
 * copying, showing a metric in the widget, going to another page. Nothing in
 * one can act on a process; that has its own menu.
 */
export type MenuItemSpec =
  | { type: 'separator' }
  | {
      type?: 'normal' | 'checkbox';
      /** Returned when the item is chosen. */
      id: string;
      label: string;
      checked?: boolean;
      enabled?: boolean;
    };

const MAX_ITEMS = 64;
const MAX_TEXT = 200;

/** Accept a menu description from a renderer, or null if any part is invalid. */
export function readMenuItems(value: unknown): MenuItemSpec[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_ITEMS) return null;
  const items: MenuItemSpec[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) return null;
    const item = entry as Record<string, unknown>;
    if (item.type === 'separator') {
      items.push({ type: 'separator' });
      continue;
    }
    if (item.type !== undefined && item.type !== 'normal' && item.type !== 'checkbox') return null;
    if (typeof item.id !== 'string' || item.id.length === 0 || item.id.length > MAX_TEXT) return null;
    if (typeof item.label !== 'string' || item.label.length === 0 || item.label.length > MAX_TEXT) {
      return null;
    }
    items.push({
      type: item.type === 'checkbox' ? 'checkbox' : 'normal',
      id: item.id,
      label: item.label,
      checked: item.checked === true,
      enabled: item.enabled !== false,
    });
  }
  return items;
}
