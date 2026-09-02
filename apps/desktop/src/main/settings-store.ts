import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { app } from 'electron';
import {
  DEFAULT_WIDGET_SETTINGS,
  normaliseWidgetSettings,
  type WidgetSettings,
} from '@shared/widget.js';

/**
 * Persisted application settings.
 *
 * Stored as JSON under the per-user application data directory. A monitoring
 * tool that is expected to sit running for days should not lose the user's
 * widget placement because it was closed abruptly, so writes are atomic: the
 * file is written to a temporary name and renamed over the target, which on
 * NTFS cannot leave a half-written file behind.
 *
 * Writes are debounced because dragging the widget produces a stream of move
 * events, and none of them is worth a synchronous disk write on its own.
 */

export interface HistorySettings {
  /** Whether telemetry is recorded to disk at all. */
  enabled: boolean;
}

export interface AppSettings {
  widget: WidgetSettings;
  history: HistorySettings;
}

const DEFAULTS: AppSettings = {
  widget: { ...DEFAULT_WIDGET_SETTINGS },
  // On by default: history is what makes "why did this happen five minutes ago"
  // answerable, and it costs one small buffered write every few seconds.
  history: { enabled: true },
};

const WRITE_DEBOUNCE_MS = 400;

/** The codes this store can raise. */
export type SettingsProblemCode = 'TM-4001' | 'TM-4002';

/** A first run has no settings file, which is not a problem worth reporting. */
function isMissingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT';
}

export class SettingsStore {
  #path: string;
  #settings: AppSettings;
  #writeTimer: NodeJS.Timeout | null = null;
  /**
   * Failures this store swallowed, so someone else can report them.
   *
   * Falling back to defaults rather than refusing to start is the right
   * behaviour, but doing it silently is not: preferences vanish and nothing
   * anywhere says why. The store keeps working on its own and hands the reason
   * to whoever owns the log.
   */
  #problems: { code: SettingsProblemCode; message: string }[] = [];

  constructor(filePath?: string) {
    this.#path = filePath ?? join(app.getPath('userData'), 'settings.json');
    this.#settings = this.#read();
  }

  get path(): string {
    return this.#path;
  }

  /** Problems encountered so far, and cleared once read. */
  takeProblems(): { code: SettingsProblemCode; message: string }[] {
    const problems = this.#problems;
    this.#problems = [];
    return problems;
  }

  get widget(): WidgetSettings {
    return this.#settings.widget;
  }

  get history(): HistorySettings {
    return this.#settings.history;
  }

  setHistoryEnabled(enabled: boolean): HistorySettings {
    this.#settings.history = { enabled: enabled === true };
    this.#scheduleWrite();
    return this.#settings.history;
  }

  /** Merge a partial change into the widget settings and schedule a save. */
  updateWidget(patch: Partial<WidgetSettings>): WidgetSettings {
    // Normalising the merged object rather than the patch means a bad value
    // cannot get in even if it arrives from the renderer.
    this.#settings.widget = normaliseWidgetSettings({ ...this.#settings.widget, ...patch });
    this.#scheduleWrite();
    return this.#settings.widget;
  }

  /** Flush any pending write immediately. Called before the app quits. */
  flush(): void {
    if (this.#writeTimer) {
      clearTimeout(this.#writeTimer);
      this.#writeTimer = null;
    }
    this.#write();
  }

  #read(): AppSettings {
    try {
      const raw = readFileSync(this.#path, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      const source = (typeof parsed === 'object' && parsed !== null ? parsed : {}) as {
        widget?: unknown;
        history?: { enabled?: unknown };
      };
      return {
        widget: normaliseWidgetSettings(source.widget),
        history: { enabled: source.history?.enabled !== false },
      };
    } catch (error) {
      // Missing on first run, and unreadable or corrupt if something went wrong.
      // Either way the right answer is defaults rather than refusing to start -
      // but only a first run is unremarkable, so the rest is reported.
      if (!isMissingFile(error)) {
        this.#problems.push({
          code: 'TM-4001',
          message: `${this.#path}: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
      return { widget: { ...DEFAULTS.widget }, history: { ...DEFAULTS.history } };
    }
  }

  #scheduleWrite(): void {
    if (this.#writeTimer) clearTimeout(this.#writeTimer);
    this.#writeTimer = setTimeout(() => {
      this.#writeTimer = null;
      this.#write();
    }, WRITE_DEBOUNCE_MS);
    // A pending settings write must not hold the process open at exit.
    this.#writeTimer.unref?.();
  }

  #write(): void {
    try {
      mkdirSync(dirname(this.#path), { recursive: true });
      const temporary = `${this.#path}.tmp`;
      writeFileSync(temporary, JSON.stringify(this.#settings, null, 2), 'utf8');
      renameSync(temporary, this.#path);
    } catch (error) {
      // Losing a settings write is not worth taking the application down for,
      // but it does mean everything the user changes this session disappears
      // when they close it, which they should be told rather than discover.
      this.#problems.push({
        code: 'TM-4002',
        message: `${this.#path}: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }
}
