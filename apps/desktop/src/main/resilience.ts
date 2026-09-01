import { app, BrowserWindow, crashReporter, type RenderProcessGoneDetails } from 'electron';
import { CrashGuard, reloadDelayMs, type CrashRecord } from './crash-guard.js';
import type { Logger } from './logger.js';

/**
 * Surviving a crash, and leaving behind enough to explain it.
 *
 * "Crash" covers five different events here, and they are not interchangeable.
 * Treating them as one thing is how an application ends up either restarting
 * when it should not, or sitting dead when it could have recovered.
 *
 * | What died | Detectable in-process | Recoverable in-process | Response |
 * |---|---|---|---|
 * | Renderer | `render-process-gone` | yes | reload the window, backing off |
 * | Renderer hung | `unresponsive` | sometimes | record it; the user decides |
 * | GPU / utility child | `child-process-gone` | Electron re-spawns | record only |
 * | Main, catchable | `uncaughtException` | yes | record, then relaunch |
 * | **Main, hard crash** | **no** | **no** | Windows relaunches it |
 *
 * The last row is the important one. Once a native fault takes the main process
 * down there is nothing left running to restart anything, so it cannot be solved
 * from inside. `RegisterApplicationRestart` in the native module hands that job
 * to the Windows Restart Manager, which costs nothing while the application is
 * healthy and leaves nothing behind if it is uninstalled — unlike the usual
 * answer of shipping a watchdog process.
 *
 * A minidump is written locally for every native crash by Electron's crash
 * reporter, with uploading switched off. Nothing about this machine leaves it.
 */

/**
 * Marker this application passes itself when relaunching after an error it
 * caught. Distinct from the one registered with Windows, because the two mean
 * different things: this one says the fault was catchable and the process shut
 * itself down deliberately.
 */
export const SELF_RESTART_ARGUMENT = '--restarted-after-crash';

/**
 * Marker registered with the Windows Restart Manager.
 *
 * Seeing this means the process died outright - nothing in it survived to
 * relaunch anything, and Windows brought it back. That is a materially worse
 * failure than a caught exception, and worth being able to tell apart.
 */
export const WINDOWS_RESTART_ARGUMENT = '--restarted-by-windows';

/**
 * Argument that makes the application fault on purpose, to prove it recovers.
 *
 * Recovery code that has never actually run is a guess. This is how the restart
 * path gets exercised on a real machine - the same reason the repository ships
 * probes for the telemetry rather than trusting the collectors read correctly.
 *
 * It cannot fire by accident: it needs an explicit command-line argument, and it
 * is stripped before relaunching so the restarted instance comes back healthy
 * instead of faulting again forever.
 */
export const CRASH_TEST_ARGUMENT = '--crash-test';

/**
 * How long Windows requires an application to have been running before it will
 * restart it.
 *
 * Documented behaviour of `RegisterApplicationRestart`: a process that crashes
 * inside its first 60 seconds is **not** restarted, so that Windows does not
 * loop on an application which is broken at startup. That is the same judgement
 * the in-process guard makes, made once more a level up, and it means the
 * Windows path covers a crash during ordinary running rather than one during
 * launch.
 */
export const WINDOWS_RESTART_MINIMUM_UPTIME_MS = 60_000;

/**
 * How long the application must stay up before its restart history is cleared.
 *
 * Long enough that a startup crash loop cannot reach it, short enough that
 * unrelated crashes weeks apart are never mistaken for a loop.
 */
const HEALTHY_AFTER_MS = 5 * 60_000;

export interface ResilienceHost {
  logger: Logger;
  guard: CrashGuard;
  /** Called to stop the collector cleanly before a deliberate relaunch. */
  onBeforeRelaunch: () => void;
}

export class Resilience {
  #host: ResilienceHost;
  #startedAtMs = Date.now();
  /** Renderer crashes per window, so backoff is per-window. */
  #rendererCrashes = new Map<number, number>();
  #healthyTimer: NodeJS.Timeout | null = null;
  #relaunching = false;

  constructor(host: ResilienceHost) {
    this.#host = host;
  }

  get startedAtMs(): number {
    return this.#startedAtMs;
  }

  /**
   * How this instance came to be running, when it followed a crash.
   *
   * `self` - the application caught a fatal error and relaunched itself.
   * `windows` - the process died outright and the Restart Manager brought it
   * back, which means nothing in the process survived to handle it.
   */
  get restartOrigin(): 'self' | 'windows' | null {
    if (process.argv.includes(WINDOWS_RESTART_ARGUMENT)) return 'windows';
    if (process.argv.includes(SELF_RESTART_ARGUMENT)) return 'self';
    return null;
  }

  /** True when this process followed a crash, however it was restarted. */
  get wasRestartedAfterCrash(): boolean {
    return this.restartOrigin !== null;
  }

  /**
   * Start collecting minidumps.
   *
   * Must run before `app.whenReady`, because a crash during startup is exactly
   * the one worth having a dump for.
   */
  startCrashReporter(): void {
    try {
      crashReporter.start({
        // Nothing is uploaded anywhere. The dumps are for whoever is sitting at
        // this machine, and a monitoring tool quietly shipping process names off
        // a user's computer would be indefensible.
        uploadToServer: false,
        compress: false,
        submitURL: '',
      });
      this.#host.logger.info('crash', `minidumps: ${app.getPath('crashDumps')}`);
    } catch (error) {
      this.#host.logger.warn('crash', 'crash reporter could not start', error);
    }
  }

  /** Install the process-level handlers. */
  install(): void {
    process.on('uncaughtException', (error) => {
      this.#onFatal('main', 'uncaughtException', error);
    });
    process.on('unhandledRejection', (reason) => {
      // A rejected promise nobody handled is a bug, but it has not necessarily
      // broken anything, so it is recorded without bringing the application
      // down over it.
      this.#host.guard.record({
        atUnixMs: Date.now(),
        source: 'main',
        reason: 'unhandledRejection',
        detail: reason instanceof Error ? (reason.stack ?? reason.message) : String(reason),
        uptimeSeconds: this.#uptimeSeconds(),
        fatal: false,
        restarted: false,
      });
    });

    app.on('child-process-gone', (_event, details) => {
      // Electron re-spawns these itself; recording is all that is useful, and a
      // clean exit is not a crash.
      if (details.reason === 'clean-exit') return;
      this.#host.guard.record({
        atUnixMs: Date.now(),
        source: details.type,
        reason: details.reason,
        detail: `exit code ${details.exitCode}${details.name ? `, ${details.name}` : ''}`,
        uptimeSeconds: this.#uptimeSeconds(),
        fatal: false,
        restarted: false,
      });
    });

    // Once the application has been up a while, forget past restarts.
    this.#healthyTimer = setTimeout(() => this.#host.guard.noteHealthy(), HEALTHY_AFTER_MS);
    this.#healthyTimer.unref?.();
  }

  /**
   * Watch one window, reloading it if its renderer dies.
   *
   * A dead renderer leaves a blank window that looks like the application has
   * frozen, and it is the one crash that is genuinely cheap to recover from —
   * nothing in the renderer holds state that is not re-derivable from the next
   * snapshot.
   */
  watchWindow(window: BrowserWindow, label: string): void {
    const id = window.webContents.id;

    window.webContents.on('render-process-gone', (_event, details: RenderProcessGoneDetails) => {
      const attempt = (this.#rendererCrashes.get(id) ?? 0) + 1;
      this.#rendererCrashes.set(id, attempt);

      // The user closing the window kills the renderer too; that is not a crash.
      const deliberate = details.reason === 'clean-exit' || this.#relaunching;
      const recoverable = !deliberate && attempt <= 5 && !window.isDestroyed();

      // Checked before recording: a renderer that went down because the
      // application is closing, or because it is being relaunched, did not
      // crash, and filing it as one would put noise in the crash history that
      // looks exactly like a real fault.
      if (deliberate) return;

      this.#host.guard.record({
        atUnixMs: Date.now(),
        source: 'renderer',
        reason: details.reason,
        detail: `${label}, exit code ${details.exitCode}, attempt ${attempt}`,
        uptimeSeconds: this.#uptimeSeconds(),
        fatal: false,
        restarted: recoverable,
      });

      if (!recoverable) {
        this.#host.logger.error(
          'crash',
          `${label} renderer has crashed ${attempt} times; not reloading it again`,
        );
        return;
      }

      const delay = reloadDelayMs(attempt);
      this.#host.logger.warn(
        'crash',
        `reloading ${label} renderer in ${delay}ms after ${details.reason}`,
      );
      const timer = setTimeout(() => {
        if (window.isDestroyed()) return;
        try {
          window.reload();
        } catch (error) {
          this.#host.logger.error('crash', `could not reload ${label}`, error);
        }
      }, delay);
      timer.unref?.();
    });

    window.webContents.on('unresponsive', () => {
      // Not a crash: the renderer is alive but not answering. Recorded because
      // it is what a user reports as "it froze", and the log should agree.
      this.#host.logger.warn('crash', `${label} renderer stopped responding`);
    });
    window.webContents.on('responsive', () => {
      this.#host.logger.info('crash', `${label} renderer is responding again`);
    });

    window.on('closed', () => this.#rendererCrashes.delete(id));
  }

  /** Record a failure the collector reported about itself. */
  recordCollectorFailure(message: string): CrashRecord {
    return this.#host.guard.record({
      atUnixMs: Date.now(),
      source: 'collector',
      reason: 'panic',
      detail: message,
      uptimeSeconds: this.#uptimeSeconds(),
      fatal: false,
      restarted: false,
    });
  }

  /**
   * Fault on purpose if asked to.
   *
   * The delay lets the window appear first, so what is being tested is a crash
   * of a running application rather than one during initialisation. A hard
   * crash waits longer for a reason that is not arbitrary - see
   * `WINDOWS_RESTART_MINIMUM_UPTIME_MS`.
   */
  scheduleCrashTestIfRequested(): void {
    const argument = process.argv.find((value) => value.startsWith(`${CRASH_TEST_ARGUMENT}=`));
    if (!argument) return;
    const kind = argument.slice(CRASH_TEST_ARGUMENT.length + 1);
    const delay = kind === 'hard' ? WINDOWS_RESTART_MINIMUM_UPTIME_MS + 5000 : 3000;
    this.#host.logger.warn(
      'crash',
      `crash test requested: ${kind}; faulting in ${Math.round(delay / 1000)}s on purpose` +
        (kind === 'hard'
          ? ' (waiting past the 60s Windows requires before it will restart anything)'
          : ''),
    );

    const timer = setTimeout(() => {
      if (kind === 'main') {
        // Thrown from a timer so it reaches `uncaughtException` the way a real
        // bug would, rather than being caught by a surrounding try.
        throw new Error('deliberate crash test of the main process');
      }
      if (kind === 'collector') {
        this.recordCollectorFailure('deliberate crash test of the collector');
        return;
      }
      if (kind === 'hard') {
        // A real native abort, not a catchable exception. Nothing in this
        // process handles it, which is precisely the case the Windows Restart
        // Manager exists to cover - and the only way to find out whether that
        // registration actually works.
        this.#host.logger.warn('crash', 'aborting the process; Windows should restart it');
        process.crash();
      }
      this.#host.logger.warn('crash', `unknown crash test kind: ${kind}`);
    }, delay);
    timer.unref?.();
  }

  /** Stop the handlers taking action during a deliberate shutdown. */
  beginShutdown(): void {
    this.#relaunching = true;
    if (this.#healthyTimer) clearTimeout(this.#healthyTimer);
  }

  #uptimeSeconds(): number {
    return Math.round((Date.now() - this.#startedAtMs) / 1000);
  }

  /**
   * Something took the main process down and we caught it.
   *
   * Relaunching is attempted only while the guard allows it. Past that, the
   * application stays down and says so — a process that crashes on startup and
   * restarts forever is worse than one that is simply not running.
   */
  #onFatal(source: string, reason: string, error: unknown): void {
    const allowed = this.#host.guard.shouldRestart();
    this.#host.guard.record({
      atUnixMs: Date.now(),
      source,
      reason,
      detail: error instanceof Error ? (error.stack ?? error.message) : String(error),
      uptimeSeconds: this.#uptimeSeconds(),
      fatal: true,
      restarted: allowed,
    });

    if (!allowed) {
      this.#host.logger.error(
        'crash',
        `restarted ${this.#host.guard.recentRestartCount()} times recently; staying down instead of looping`,
      );
      app.exit(1);
      return;
    }

    this.#host.logger.warn('crash', 'relaunching after a fatal error');
    this.#host.guard.noteRestart();
    this.#relaunching = true;
    try {
      this.#host.onBeforeRelaunch();
    } catch (stopError) {
      this.#host.logger.warn('crash', 'collector did not stop cleanly', stopError);
    }
    // The marker tells the new instance it is a restart rather than a launch.
    const args = process.argv
      .slice(1)
      // Dropped deliberately: a crash test that survived the relaunch would
      // fault again immediately and leave the application permanently down.
      .filter((value) => !value.startsWith(`${CRASH_TEST_ARGUMENT}=`))
      // Not carried forward: whoever restarts next should describe that
      // restart, not inherit the reason for this one.
      .filter((value) => value !== SELF_RESTART_ARGUMENT && value !== WINDOWS_RESTART_ARGUMENT);
    // Release the single-instance lock first. Without this the relaunched
    // process can start while this one is still exiting, fail to take the lock,
    // conclude another instance is already running and quit immediately - so
    // the application appears to have crashed without recovering. It is timing
    // dependent, which is why it survived development and only showed up in the
    // packaged build, where the portable launcher adds enough latency to lose
    // the race every time.
    app.releaseSingleInstanceLock();
    app.relaunch({
      args: [...args, SELF_RESTART_ARGUMENT],
      // In a portable build `process.execPath` is the copy extracted to a
      // temporary directory. Relaunching the original executable keeps the
      // restarted instance the same thing the user actually ran.
      execPath: process.env.PORTABLE_EXECUTABLE_FILE || undefined,
    });
    app.exit(1);
  }
}
