import { appendFileSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';

/**
 * The application's log file.
 *
 * # Why writes are synchronous
 *
 * This log exists to explain a crash, and the lines that matter most are the
 * last ones written before the process died. A buffered or asynchronous write
 * loses exactly those. So every line is appended synchronously and is on disk
 * before the call returns.
 *
 * That is only affordable because the volume is deliberately tiny: lifecycle
 * events, failures, and crash detail. Nothing per-snapshot is ever logged — a
 * monitor sampling twice a second must not write twice a second, and a log that
 * grows with uptime is a log nobody keeps.
 *
 * # Bounded on disk
 *
 * The file rotates at a size cap and only a few generations are kept, so the
 * log occupies a fixed maximum however long the application runs. This is the
 * same principle the history database follows.
 */

/** Rotate once the active file passes this. */
const MAX_BYTES = 1_000_000;
/** Rotated generations kept besides the active file. */
const MAX_GENERATIONS = 3;

export type LogLevel = 'info' | 'warn' | 'error';

export class Logger {
  #directory: string;
  #path: string;
  /** Set when logging itself fails, so a broken log cannot crash the app. */
  #disabled = false;

  constructor(directory?: string) {
    this.#directory = directory ?? join(app.getPath('userData'), 'logs');
    this.#path = join(this.#directory, 'main.log');
    try {
      mkdirSync(this.#directory, { recursive: true });
    } catch {
      // A log that cannot be written must never stop the application from
      // running. Everything below degrades to console output.
      this.#disabled = true;
    }
  }

  get path(): string {
    return this.#path;
  }

  get directory(): string {
    return this.#directory;
  }

  info(category: string, message: string, detail?: unknown): void {
    this.#write('info', category, message, detail);
  }

  warn(category: string, message: string, detail?: unknown): void {
    this.#write('warn', category, message, detail);
  }

  error(category: string, message: string, detail?: unknown): void {
    this.#write('error', category, message, detail);
  }

  #write(level: LogLevel, category: string, message: string, detail?: unknown): void {
    const line = formatLine(level, category, message, detail);
    // Always mirror to stdout: when someone runs the application from a
    // terminal to find out what is wrong, that is where they are looking.
    if (level === 'error') console.error(line);
    else console.log(line);

    if (this.#disabled) return;
    try {
      this.#rotateIfNeeded();
      appendFileSync(this.#path, `${line}\n`, 'utf8');
    } catch {
      // Disk full, file locked, directory removed underneath us. Stop trying
      // rather than throwing from inside an error handler, which is where this
      // is most likely to be called from.
      this.#disabled = true;
    }
  }

  #rotateIfNeeded(): void {
    let size = 0;
    try {
      size = statSync(this.#path).size;
    } catch {
      // No file yet, which is the normal first-run case.
      return;
    }
    if (size < MAX_BYTES) return;

    // Shift generations down, dropping the oldest. Done oldest-first so no
    // rename overwrites a file that has not been moved yet.
    try {
      unlinkSync(join(this.#directory, `main.${MAX_GENERATIONS}.log`));
    } catch {
      // Nothing to drop yet.
    }
    for (let generation = MAX_GENERATIONS - 1; generation >= 1; generation -= 1) {
      try {
        renameSync(
          join(this.#directory, `main.${generation}.log`),
          join(this.#directory, `main.${generation + 1}.log`),
        );
      } catch {
        // That generation does not exist yet.
      }
    }
    try {
      renameSync(this.#path, join(this.#directory, 'main.1.log'));
    } catch {
      // Another process holding it open, most likely. The size check will try
      // again on the next write rather than giving up permanently.
    }
  }

  /** Every log file currently on disk, newest first, for the UI. */
  listFiles(): { name: string; bytes: number }[] {
    try {
      return readdirSync(this.#directory)
        .filter((name) => name.endsWith('.log'))
        .map((name) => {
          let bytes = 0;
          try {
            bytes = statSync(join(this.#directory, name)).size;
          } catch {
            bytes = 0;
          }
          return { name, bytes };
        })
        .sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      return [];
    }
  }
}

/**
 * One log line.
 *
 * ISO timestamps because a crash log is read alongside Windows Event Viewer and
 * whatever else, and a local-format timestamp makes correlating them guesswork.
 */
export function formatLine(
  level: LogLevel,
  category: string,
  message: string,
  detail?: unknown,
): string {
  const parts = [new Date().toISOString(), level.toUpperCase().padEnd(5), category, message];
  if (detail !== undefined) parts.push(describeDetail(detail));
  return parts.join(' | ');
}

/**
 * Render a detail value onto a single line.
 *
 * An Error is unwrapped to its stack, because a crash log containing
 * `[object Object]` where the stack should be is the specific failure this
 * function exists to prevent.
 */
export function describeDetail(detail: unknown): string {
  if (detail instanceof Error) {
    return (detail.stack ?? `${detail.name}: ${detail.message}`).replace(/\r?\n\s*/g, ' ↵ ');
  }
  if (typeof detail === 'string') return detail;
  try {
    return JSON.stringify(detail);
  } catch {
    // Circular structures reach here; the type is still worth recording.
    return `[unserialisable ${typeof detail}]`;
  }
}
