import { mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ErrorCode } from '@shared/error-codes.js';
import type { Logger } from './logger.js';

/**
 * Deciding whether to come back after a crash, and recording what happened.
 *
 * # The restart loop is the real hazard
 *
 * Restarting after a crash is easy. The failure mode that matters is an
 * application that crashes during startup, restarts, crashes again, and pins a
 * core doing that forever — which is strictly worse than staying down, because
 * it is harder to notice and harder to stop. A monitor doing it is worse still,
 * since the whole point of the thing is not to be a burden on the machine.
 *
 * So every restart is recorded to disk with its timestamp, the record survives
 * the restart, and once the rate exceeds a threshold the application stops
 * relaunching itself and says why. Recovering from an occasional fault is worth
 * having; hiding a reproducible one is not.
 *
 * # What is written
 *
 * A crash report per event, as JSON, next to the log. It carries the reason,
 * how long the process had been up, and the versions involved — which is what
 * anyone diagnosing it will ask for first. The reports are bounded in number
 * for the same reason the log rotates.
 */

/** Restarts allowed inside the window before the application gives up. */
const MAX_RESTARTS = 3;
/** How far back to count restarts when deciding. */
const RESTART_WINDOW_MS = 5 * 60_000;
/** Crash reports kept on disk, newest first. */
const MAX_REPORTS = 20;

/**
 * A crash the application survived long enough to record.
 *
 * `fatal` distinguishes "the main process is going down" from a renderer or
 * child process that died and was recovered — the second is routine and the
 * first is not.
 */
export interface CrashRecord {
  /**
   * The error code for this kind of crash, e.g. `TM-7001`.
   *
   * Carried on the record rather than only written to the log, so it reaches
   * the crash report on disk and the interface as well - the two places someone
   * actually looks when reporting a problem.
   */
  code: ErrorCode;
  atUnixMs: number;
  /** Which part died: `main`, `renderer`, `gpu`, `utility`, `collector`. */
  source: string;
  /** Electron's reason, or the exception name. */
  reason: string;
  detail?: string;
  /** Seconds the process had been running. Distinguishes a startup crash. */
  uptimeSeconds: number;
  fatal: boolean;
  /** True when the application relaunched itself because of this. */
  restarted: boolean;
}

interface GuardState {
  /** Timestamps of restarts this application performed on itself. */
  restarts: number[];
}

export class CrashGuard {
  #directory: string;
  #statePath: string;
  #logger: Logger;
  #state: GuardState = { restarts: [] };

  constructor(directory: string, logger: Logger) {
    this.#directory = directory;
    // Deliberately not named `crash-*`: that is the namespace the report
    // reader scans, and this file living in it made the guard's own state
    // show up in the UI as a crash with no fields.
    this.#statePath = join(directory, 'restart-state.json');
    this.#logger = logger;
    try {
      mkdirSync(directory, { recursive: true });
    } catch {
      // Reported by the first write that fails.
    }
    this.#state = this.#read();
  }

  #read(): GuardState {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.#statePath, 'utf8'));
      const restarts = (parsed as GuardState | null)?.restarts;
      if (!Array.isArray(restarts)) return { restarts: [] };
      // A hand-edited or corrupted file must not be able to disable the guard.
      return { restarts: restarts.filter((v): v is number => typeof v === 'number' && Number.isFinite(v)) };
    } catch {
      return { restarts: [] };
    }
  }

  #write(): void {
    try {
      // Atomic, like the settings store: a half-written guard state read after
      // the next crash would be worse than none.
      const temporary = `${this.#statePath}.tmp`;
      writeFileSync(temporary, JSON.stringify(this.#state), 'utf8');
      renameSync(temporary, this.#statePath);
    } catch (error) {
      this.#logger.warn('TM-7010', 'could not persist restart state', error);
    }
  }

  /** Restarts inside the current window. */
  recentRestartCount(atUnixMs = Date.now()): number {
    return this.#state.restarts.filter((at) => atUnixMs - at < RESTART_WINDOW_MS).length;
  }

  /**
   * Whether relaunching is still a reasonable thing to do.
   *
   * False means the application has been coming back too fast to be recovering
   * from anything, and staying down is the more useful outcome.
   */
  shouldRestart(atUnixMs = Date.now()): boolean {
    return this.recentRestartCount(atUnixMs) < MAX_RESTARTS;
  }

  /** Record that a restart is being performed. Call before relaunching. */
  noteRestart(atUnixMs = Date.now()): void {
    // Only the window is kept: an old restart says nothing about whether the
    // application is looping now.
    this.#state.restarts = [
      ...this.#state.restarts.filter((at) => atUnixMs - at < RESTART_WINDOW_MS),
      atUnixMs,
    ];
    this.#write();
  }

  /**
   * Clear the restart history.
   *
   * Called once the application has been up long enough to be considered
   * healthy. Without this, three unrelated crashes spread over a week would
   * eventually be treated as a loop.
   */
  noteHealthy(): void {
    if (this.#state.restarts.length === 0) return;
    this.#state.restarts = [];
    this.#write();
    this.#logger.info('crash', 'ran long enough to be considered healthy; restart history cleared');
  }

  /** Write a crash report and return it. */
  record(record: CrashRecord): CrashRecord {
    this.#logger.error(
      record.code,
      `${record.source} ${record.reason} after ${record.uptimeSeconds}s${record.fatal ? ' (fatal)' : ''}`,
      record.detail,
    );
    try {
      const name = `crash-${new Date(record.atUnixMs).toISOString().replace(/[:.]/g, '-')}-${record.source}.json`;
      writeFileSync(join(this.#directory, name), JSON.stringify(record, null, 2), 'utf8');
      this.#pruneReports();
    } catch (error) {
      this.#logger.warn('TM-7009', 'could not write crash report', error);
    }
    return record;
  }

  /** Crash reports on disk, newest first. */
  listReports(limit = MAX_REPORTS): CrashRecord[] {
    try {
      return readdirSync(this.#directory)
        .filter((name) => name.startsWith('crash-') && name.endsWith('.json'))
        .sort()
        .reverse()
        .slice(0, limit)
        .map((name) => {
          try {
            return asCrashRecord(JSON.parse(readFileSync(join(this.#directory, name), 'utf8')));
          } catch {
            return null;
          }
        })
        .filter((record): record is CrashRecord => record !== null);
    } catch {
      return [];
    }
  }

  #pruneReports(): void {
    try {
      const names = readdirSync(this.#directory)
        .filter((name) => name.startsWith('crash-') && name.endsWith('.json'))
        .sort();
      for (const name of names.slice(0, Math.max(0, names.length - MAX_REPORTS))) {
        try {
          unlinkSync(join(this.#directory, name));
        } catch {
          // Already gone, or held open. Not worth reporting.
        }
      }
    } catch {
      // Directory unreadable; the write above will have reported it.
    }
  }
}

/**
 * Accept a parsed file only if it is really a crash record.
 *
 * Anything else in the directory - a file the user dropped there, a report from
 * an older version with a different shape - would otherwise render as a crash
 * row with every field blank, which reads as a crash that has no detail rather
 * than as the non-crash it is.
 */
function asCrashRecord(value: unknown): CrashRecord | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as Partial<CrashRecord>;
  if (typeof candidate.atUnixMs !== 'number') return null;
  if (typeof candidate.source !== 'string' || typeof candidate.reason !== 'string') return null;
  return {
    // A report written by an older version has no code; it is still a real
    // crash and is shown, just without one to look up.
    code: (typeof candidate.code === 'string' ? candidate.code : 'TM-7005') as ErrorCode,
    atUnixMs: candidate.atUnixMs,
    source: candidate.source,
    reason: candidate.reason,
    detail: typeof candidate.detail === 'string' ? candidate.detail : undefined,
    uptimeSeconds: typeof candidate.uptimeSeconds === 'number' ? candidate.uptimeSeconds : 0,
    fatal: candidate.fatal === true,
    restarted: candidate.restarted === true,
  };
}

/**
 * How long a renderer reload should wait, given how many times it has crashed.
 *
 * A renderer that crashes once is worth reloading immediately — the user is
 * looking at a blank window. One crashing repeatedly is probably crashing
 * *because* of what it loads, so each attempt waits longer, up to a ceiling.
 * Exported for its own test because the arithmetic is the whole behaviour.
 */
export function reloadDelayMs(attempt: number): number {
  if (attempt <= 1) return 0;
  return Math.min(1000 * 2 ** (attempt - 2), 30_000);
}

export const CRASH_LIMITS = {
  maxRestarts: MAX_RESTARTS,
  restartWindowMs: RESTART_WINDOW_MS,
  maxReports: MAX_REPORTS,
} as const;
