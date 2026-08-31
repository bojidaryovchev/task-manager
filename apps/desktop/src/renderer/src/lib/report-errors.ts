/**
 * Send renderer failures to the main process so they reach the log file.
 *
 * The renderer has no filesystem by design, so an error here would otherwise
 * exist only in a devtools console that nobody has open — which means a user
 * reporting "it went blank" would have nothing to send. Forwarding costs one
 * IPC call per error and makes the log the single place to look.
 *
 * Reporting is deliberately capped. An error inside a render loop can fire
 * thousands of times a second, and a log full of one repeated line is a log with
 * the useful history pushed out of it.
 */

/** Errors forwarded before this session stops reporting. */
const MAX_REPORTS = 25;

let reported = 0;

function send(kind: string, message: string, stack: string): void {
  if (reported >= MAX_REPORTS) return;
  reported += 1;
  const suffix =
    reported === MAX_REPORTS ? ' (further renderer errors this session are not logged)' : '';
  try {
    void window.taskManager.reportRendererError(message + suffix, stack, kind);
  } catch {
    // The bridge is gone, which means the window is being torn down. There is
    // nowhere left to report to and nothing useful to do about it.
  }
}

export function installErrorReporting(): void {
  window.addEventListener('error', (event) => {
    send(
      'uncaught error',
      event.message || String(event.error),
      event.error instanceof Error ? (event.error.stack ?? '') : `${event.filename}:${event.lineno}`,
    );
  });

  window.addEventListener('unhandledrejection', (event) => {
    const reason: unknown = event.reason;
    send(
      'unhandled rejection',
      reason instanceof Error ? reason.message : String(reason),
      reason instanceof Error ? (reason.stack ?? '') : '',
    );
  });
}
