import { useCallback, useEffect, useState } from 'react';
import type { DiagnosticsInfo } from '@shared/ipc';
import { Field, Note, Panel } from './primitives.js';

/**
 * Crash history and where the logs are.
 *
 * The point of recording a crash is that someone can find it afterwards, and
 * "afterwards" usually means from inside the application that crashed. Showing
 * the log location and the recent failures here is what turns the logging into
 * something a user can act on rather than a file they never learn exists.
 */
export function Diagnostics(): React.JSX.Element {
  const [info, setInfo] = useState<DiagnosticsInfo | null>(null);

  const refresh = useCallback(() => {
    void window.taskManager.getDiagnostics().then(setInfo);
  }, []);

  useEffect(() => {
    refresh();
    // Crashes are rare; polling faster would be noise. This exists so a crash
    // that happens while the page is open still appears without a reload.
    const timer = setInterval(refresh, 10_000);
    return () => clearInterval(timer);
  }, [refresh]);

  if (!info) return <Panel title="Reliability">Reading…</Panel>;

  const atLimit = info.recentRestarts >= info.maxRestarts;

  return (
    <Panel
      title="Reliability"
      hint="What happens if this application crashes"
      actions={
        <button
          type="button"
          onClick={() => void window.taskManager.openLogFolder()}
          className="rounded bg-surface-3 px-2 py-1 text-[11px] text-text-primary transition-colors hover:bg-surface-2"
        >
          Open log folder
        </button>
      }
    >
      <div className="text-[12px]">
        <Field
          label="Restart after a hard crash"
          value={info.restartRegistered ? 'Registered with Windows' : 'Not registered'}
          definition={
            info.restartRegistered
              ? 'Once the main process dies there is nothing left in it to restart anything, so the Windows Restart Manager does it instead. Registered through RegisterApplicationRestart, which costs nothing while the application is healthy and needs no background watchdog process. Windows deliberately does not relaunch after a clean exit, so closing the application keeps it closed.'
              : 'Windows declined the registration, so the application will not come back by itself after a crash that takes the whole process down.'
          }
        />
        <Field
          label="This session"
          value={
            info.restartOrigin === 'windows'
              ? 'Restarted by Windows after a hard crash'
              : info.restartOrigin === 'self'
                ? 'Relaunched itself after a fatal error'
                : 'Started normally'
          }
          definition="How this instance came to be running. A self-relaunch means the error was catchable and the application shut down deliberately. A Windows restart means the process died outright, with nothing left in it to handle the fault — the more serious of the two."
        />
        <Field
          label="Recent self-restarts"
          value={`${info.recentRestarts} of ${info.maxRestarts}`}
          definition="Times the application has relaunched itself inside the guard's window. At the limit it stops relaunching: an application that crashes on startup and restarts forever is worse than one that is simply not running, because it is harder to notice and harder to stop."
        />
        <Field label="Logs" value={info.logDirectory} mono definition="Rotated, and bounded in size." />
        <Field
          label="Crash dumps"
          value={info.crashDumpDirectory}
          mono
          definition="Minidumps for native crashes, written locally by Electron. Uploading is switched off — nothing about this machine leaves it."
        />
        {info.logFiles.length > 0 && (
          <Field
            label="Log files"
            value={info.logFiles
              .map((file) => `${file.name} (${(file.bytes / 1024).toFixed(0)} KB)`)
              .join(', ')}
          />
        )}
      </div>

      {atLimit && (
        <Note>
          The restart limit has been reached, so the application will no longer relaunch itself.
          Whatever is going wrong is reproducible; the crash reports below are the place to start.
        </Note>
      )}

      <div className="mt-3 border-t border-border-subtle pt-3">
        <div className="mb-1 text-[12px] text-text-secondary">
          Recent crashes {info.crashes.length > 0 && `(${info.crashes.length})`}
        </div>
        {info.crashes.length === 0 ? (
          <div className="text-[12px] text-text-muted">
            Nothing recorded. This application has not crashed since the logs were last cleared.
          </div>
        ) : (
          <div className="text-[12px]">
            {info.crashes.map((crash, index) => (
              <div
                key={`${crash.atUnixMs}-${crash.source}-${index}`}
                className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 border-b border-border-subtle py-1.5 last:border-b-0"
              >
                <span className="tnum shrink-0 text-text-muted">
                  {new Date(crash.atUnixMs).toLocaleString()}
                </span>
                <span
                  className={`shrink-0 rounded px-1.5 text-[10px] ${
                    crash.fatal ? 'bg-danger/20 text-danger' : 'bg-surface-3 text-text-secondary'
                  }`}
                  title={
                    crash.fatal
                      ? 'The main process was going down. The application is only still running because it came back.'
                      : 'A child process died and was recovered. The application kept running throughout.'
                  }
                >
                  {crash.source}
                </span>
                <span className="text-text-primary">{crash.reason}</span>
                <span className="text-text-muted">
                  after {crash.uptimeSeconds}s
                  {crash.restarted ? ' · recovered' : ' · not recovered'}
                </span>
                {crash.detail && (
                  <span className="selectable w-full break-words font-mono text-[10px] text-text-muted">
                    {crash.detail.slice(0, 400)}
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <Note>
        A crashed renderer is reloaded automatically, with each attempt waiting longer than the
        last, because a renderer that crashes repeatedly is usually crashing because of what it
        loads. Nothing in the renderer holds state that the next snapshot cannot rebuild, so
        reloading it costs nothing.
      </Note>
    </Panel>
  );
}
