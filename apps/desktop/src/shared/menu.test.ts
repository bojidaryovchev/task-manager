import { describe, expect, it } from 'vitest';
import { readMenuItems } from './menu.js';

describe('menus described by a page', () => {
  it('accepts items and separators, filling in the defaults', () => {
    expect(
      readMenuItems([
        { id: 'copy', label: 'Copy' },
        { type: 'separator' },
        { type: 'checkbox', id: 'cpu', label: 'Show CPU', checked: true },
      ]),
    ).toEqual([
      { type: 'normal', id: 'copy', label: 'Copy', checked: false, enabled: true },
      { type: 'separator' },
      { type: 'checkbox', id: 'cpu', label: 'Show CPU', checked: true, enabled: true },
    ]);
  });

  it('refuses the whole menu if any item is malformed', () => {
    expect(readMenuItems([{ id: 'copy', label: 'Copy' }, { id: '', label: 'x' }])).toBeNull();
    expect(readMenuItems([{ type: 'submenu', id: 'x', label: 'x' }])).toBeNull();
    expect(readMenuItems([{ id: 'x' }])).toBeNull();
    expect(readMenuItems([])).toBeNull();
    expect(readMenuItems('copy')).toBeNull();
  });
});
