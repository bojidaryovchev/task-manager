import { describe, expect, it } from 'vitest';
import { safeFileName } from './export-service.js';

/**
 * The one place a string from a renderer influences a filesystem path.
 *
 * The user still picks the real destination in the save dialog, so this is not
 * the only thing standing between a renderer and the disk — but a name carrying
 * path separators would open that dialog somewhere the user did not expect, and
 * a name of forbidden characters would fail the write for no visible reason.
 */
describe('safeFileName', () => {
  it('keeps the characters real export names are made of', () => {
    // Hyphens and dots carry the timestamp and the extension. Stripping them,
    // as an over-eager filter would, mangles every generated name.
    expect(safeFileName('task-manager-2026-08-28T15-04-05-000.json', 'fallback')).toBe(
      'task-manager-2026-08-28T15-04-05-000.json',
    );
    expect(safeFileName('my export 2.md', 'fallback')).toBe('my export 2.md');
  });

  it('strips any directory component', () => {
    expect(safeFileName('..\\..\\Windows\\System32\\evil.json', 'fallback')).toBe('evil.json');
    expect(safeFileName('/etc/passwd', 'fallback')).toBe('passwd');
  });

  it('removes characters Windows forbids in a filename', () => {
    expect(safeFileName('a<b>c:d"e|f?g*h.json', 'fallback')).toBe('abcdefgh.json');
  });

  it('removes control characters', () => {
    expect(safeFileName(`bad${String.fromCharCode(0)}name.json`, 'fallback')).toBe('badname.json');
    expect(safeFileName(`tab${String.fromCharCode(9)}name.json`, 'fallback')).toBe('tabname.json');
  });

  it('falls back rather than producing a hidden or empty file', () => {
    for (const input of ['', '   ', '...', '/', '<>:"|?*']) {
      expect(safeFileName(input, 'fallback.json')).toBe('fallback.json');
    }
  });

  it('bounds the length', () => {
    expect(safeFileName('x'.repeat(500), 'fallback').length).toBe(200);
  });

  it('tolerates input that is not a string', () => {
    // It crosses an IPC boundary, so it can be anything.
    for (const input of [undefined, null, 42, {}] as unknown as string[]) {
      expect(() => safeFileName(input, 'fallback.json')).not.toThrow();
    }
  });
});
