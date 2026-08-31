import { writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { app, BrowserWindow, clipboard, dialog } from 'electron';
import type { ExportSaveResult } from '@shared/ipc';

/**
 * Delivering an export to the user: a file, or the clipboard.
 *
 * Both live in main because the renderer has neither, by design — it runs with
 * `contextIsolation` on and no Node integration, so it can build the text but
 * cannot write it anywhere. The renderer hands over finished text and a
 * suggested name; nothing here interprets the contents.
 *
 * The suggested name is treated as untrusted, like anything crossing that
 * boundary. It only seeds the dialog — the user picks the real destination —
 * but a name carrying path separators would still let the dialog open
 * somewhere unexpected, so it is reduced to a bare filename first.
 */

/** Extensions the save dialog offers, keyed by what the renderer produced. */
const FILTERS: Record<string, Electron.FileFilter[]> = {
  '.json': [
    { name: 'JSON', extensions: ['json'] },
    { name: 'All files', extensions: ['*'] },
  ],
  '.md': [
    { name: 'Markdown', extensions: ['md'] },
    { name: 'All files', extensions: ['*'] },
  ],
};

/**
 * Reduce a renderer-supplied name to something safe to seed a dialog with.
 *
 * Strips any directory component and the characters Windows forbids in a
 * filename. Exported for its own test: this is the one place a string from a
 * renderer influences a filesystem path.
 */
export function safeFileName(suggested: string, fallback: string): string {
  // Only the characters Windows actually forbids, written as escapes so no
  // literal control byte can end up in this source file. Spaces and hyphens
  // are legal in a filename and are what the generated names are made of.
  // Matching control characters is exactly the point below: they are illegal in
  // an NTFS filename, so a suggested name carrying one needs it stripped rather
  // than the whole write rejected. Hence the rule is switched off for one line.
  // eslint-disable-next-line no-control-regex
  const bare = basename(String(suggested ?? '')).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '');
  const trimmed = bare.replace(/^\.+/, '').trim();
  return trimmed.length > 0 ? trimmed.slice(0, 200) : fallback;
}

export class ExportService {
  /**
   * Ask where to put an export and write it there.
   *
   * A dismissed dialog returns `saved: false`. That is a normal outcome — the
   * user changed their mind — and is deliberately not reported as an error, so
   * the UI does not show a failure for a deliberate cancellation.
   */
  async saveToFile(
    suggestedName: unknown,
    contents: unknown,
    parent: BrowserWindow | null,
  ): Promise<ExportSaveResult> {
    if (typeof contents !== 'string' || contents.length === 0) {
      return { saved: false, error: 'Nothing to write.' };
    }
    const name = safeFileName(String(suggestedName ?? ''), 'task-manager-export.json');
    const extension = extname(name).toLowerCase();

    const result = await (parent
      ? dialog.showSaveDialog(parent, {
          title: 'Export telemetry',
          defaultPath: join(app.getPath('downloads'), name),
          filters: FILTERS[extension] ?? FILTERS['.json']!,
        })
      : dialog.showSaveDialog({
          title: 'Export telemetry',
          defaultPath: join(app.getPath('downloads'), name),
          filters: FILTERS[extension] ?? FILTERS['.json']!,
        }));

    if (result.canceled || !result.filePath) return { saved: false };

    try {
      await writeFile(result.filePath, contents, 'utf8');
      return {
        saved: true,
        path: result.filePath,
        byteLength: Buffer.byteLength(contents, 'utf8'),
      };
    } catch (error) {
      // A real failure: a full disk, a read-only location, a revoked
      // permission. Reported as itself rather than folded into "cancelled".
      return { saved: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * Put text on the clipboard.
   *
   * Asynchronous because Electron's clipboard is: the system clipboard is a
   * shared resource another process can be holding, so writing to it is a
   * request rather than an assignment. The write is read back to confirm it
   * actually took, so the UI can say "copied" only when it is true.
   */
  async copy(text: unknown): Promise<boolean> {
    if (typeof text !== 'string' || text.length === 0) return false;
    try {
      await clipboard.writeText(text);
      return (await clipboard.readText()) === text;
    } catch {
      // Another process holding the clipboard open is the usual cause, and it
      // is a normal thing for the user to hit rather than a fault to surface.
      return false;
    }
  }
}
