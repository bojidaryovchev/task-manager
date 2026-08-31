import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { CRASH_LIMITS, CrashGuard, reloadDelayMs, type CrashRecord } from './crash-guard.js';
import type { Logger } from './logger.js';

/**
 * The restart loop is the hazard this file exists to prevent.
 *
 * Coming back after a crash is the easy half. The half that matters is refusing
 * to: an application that crashes during startup and relaunches forever burns a
 * core doing it and is harder to notice and stop than one that simply stayed
 * down. A monitoring tool doing that would be indefensible, since not being a
 * burden on the machine is the whole premise.
 */

const silent = {
  info: () => {},
  warn: () => {},
  error: () => {},
} as unknown as Logger;

function record(overrides: Partial<CrashRecord> = {}): CrashRecord {
  return {
    atUnixMs: Date.now(),
    source: 'main',
    reason: 'uncaughtException',
    uptimeSeconds: 12,
    fatal: true,
    restarted: true,
    ...overrides,
  };
}

let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'tm-crash-'));
});

describe('restart loop guard', () => {
  it('allows a restart when nothing has crashed recently', () => {
    expect(new CrashGuard(directory, silent).shouldRestart()).toBe(true);
  });

  it('stops restarting once the limit is reached inside the window', () => {
    const guard = new CrashGuard(directory, silent);
    for (let i = 0; i < CRASH_LIMITS.maxRestarts; i += 1) {
      expect(guard.shouldRestart()).toBe(true);
      guard.noteRestart();
    }
    expect(guard.shouldRestart()).toBe(false);
  });

  it('remembers restarts across a restart, which is the entire point', () => {
    // The state has to survive the process it is protecting against, or the
    // count resets to zero on every crash and the guard never fires.
    const first = new CrashGuard(directory, silent);
    for (let i = 0; i < CRASH_LIMITS.maxRestarts; i += 1) first.noteRestart();

    const second = new CrashGuard(directory, silent);
    expect(second.recentRestartCount()).toBe(CRASH_LIMITS.maxRestarts);
    expect(second.shouldRestart()).toBe(false);
  });

  it('forgets restarts that fall outside the window', () => {
    const guard = new CrashGuard(directory, silent);
    const now = Date.now();
    const old = now - CRASH_LIMITS.restartWindowMs - 1000;
    for (let i = 0; i < CRASH_LIMITS.maxRestarts; i += 1) guard.noteRestart(old);
    // Three crashes weeks apart are not a loop.
    expect(guard.recentRestartCount(now)).toBe(0);
    expect(guard.shouldRestart(now)).toBe(true);
  });

  it('clears the history once the application has proved healthy', () => {
    const guard = new CrashGuard(directory, silent);
    guard.noteRestart();
    guard.noteRestart();
    guard.noteHealthy();
    expect(guard.recentRestartCount()).toBe(0);
  });

  it('cannot be disabled by a corrupted state file', () => {
    // The file lives in a directory the user can reach, so it is untrusted.
    for (const contents of ['not json', '{}', '{"restarts":"lots"}', '{"restarts":[1,"x",null]}']) {
      writeFileSync(join(directory, 'crash-state.json'), contents, 'utf8');
      const guard = new CrashGuard(directory, silent);
      expect(() => guard.recentRestartCount()).not.toThrow();
      guard.noteRestart();
      expect(guard.recentRestartCount()).toBeGreaterThan(0);
    }
  });
});

describe('crash reports', () => {
  it('writes a report that carries what a diagnosis needs', () => {
    const guard = new CrashGuard(directory, silent);
    guard.record(record({ detail: 'Error: boom\n  at thing' }));

    const files = readdirSync(directory).filter((n) => n.startsWith('crash-'));
    expect(files).toHaveLength(1);
    const written = JSON.parse(readFileSync(join(directory, files[0]!), 'utf8')) as CrashRecord;
    expect(written.reason).toBe('uncaughtException');
    expect(written.detail).toContain('boom');
    expect(written.uptimeSeconds).toBe(12);
    expect(written.fatal).toBe(true);
  });

  it('reads reports back newest first', () => {
    const guard = new CrashGuard(directory, silent);
    guard.record(record({ atUnixMs: Date.UTC(2026, 0, 1), reason: 'older' }));
    guard.record(record({ atUnixMs: Date.UTC(2026, 0, 2), reason: 'newer' }));
    expect(guard.listReports().map((r) => r.reason)).toEqual(['newer', 'older']);
  });

  it('bounds how many reports accumulate on disk', () => {
    // Same principle as the rotating log: a diagnostic that grows without limit
    // is one the user eventually deletes wholesale.
    const guard = new CrashGuard(directory, silent);
    for (let i = 0; i < CRASH_LIMITS.maxReports + 10; i += 1) {
      guard.record(record({ atUnixMs: Date.UTC(2026, 0, 1) + i * 60_000 }));
    }
    const files = readdirSync(directory).filter((n) => n.startsWith('crash-'));
    expect(files.length).toBeLessThanOrEqual(CRASH_LIMITS.maxReports);
  });

  it('does not mistake its own state file for a crash', () => {
    // It used to be called crash-state.json, which the report reader picked up
    // and rendered as a crash with every field blank.
    const guard = new CrashGuard(directory, silent);
    guard.noteRestart();
    guard.record(record({ reason: 'real' }));
    expect(guard.listReports().map((r) => r.reason)).toEqual(['real']);
  });

  it('ignores a file in the crash namespace that is not a crash record', () => {
    const guard = new CrashGuard(directory, silent);
    guard.record(record({ reason: 'real' }));
    writeFileSync(join(directory, 'crash-2026-01-01-bogus.json'), '{"unrelated":true}', 'utf8');
    // A blank row reads as a crash with no detail rather than as a non-crash.
    expect(guard.listReports().map((r) => r.reason)).toEqual(['real']);
  });

  it('survives an unreadable report rather than losing the readable ones', () => {
    const guard = new CrashGuard(directory, silent);
    guard.record(record({ reason: 'good' }));
    writeFileSync(join(directory, 'crash-2026-01-01-broken.json'), 'not json', 'utf8');
    expect(guard.listReports().map((r) => r.reason)).toEqual(['good']);
  });
});

describe('reloadDelayMs', () => {
  it('reloads the first crash immediately', () => {
    // The user is looking at a blank window; making them wait helps nobody.
    expect(reloadDelayMs(1)).toBe(0);
  });

  it('backs off further on each repeat', () => {
    const delays = [2, 3, 4, 5].map(reloadDelayMs);
    expect(delays).toEqual([...delays].sort((a, b) => a - b));
    expect(new Set(delays).size).toBe(delays.length);
  });

  it('stops growing at a ceiling', () => {
    // Unbounded backoff eventually means "never", which is a silent give-up
    // rather than the explicit one the attempt cap provides.
    expect(reloadDelayMs(50)).toBe(30_000);
    expect(reloadDelayMs(1000)).toBe(30_000);
  });
});
