import { useCallback, useEffect, useState } from 'react';
import type { DiagnosticsInfo } from '@shared/ipc';
import { describeErrorCode } from '@shared/error-codes';

/**
 * What went wrong at startup, on screen.
 *
 * The application is deliberately survivable step by step: a settings file that
 * will not parse, a history database that will not open, a tray that will not
 * create should each cost their own feature and nothing else. The risk in that
 * design is the opposite of the one it fixes — an application that is quietly
 * half-broken and never says so.
 *
 * So anything that failed is stated at the top of the window, in full, with the
 * version and the machine alongside it. It is written to be photographed and
 * sent to someone else: everything needed to start diagnosing is in the one
 * rectangle, without asking the person in front of it to find a log file.
 */
export function StartupBanner(): React.JSX.Element | null {
  const [info, setInfo] = useState<DiagnosticsInfo | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    void window.taskManager.getDiagnostics().then(setInfo);
  }, []);

  const report = useCallback(() => {
    if (!info) return '';
    return [
      `Task Manager — ${info.startupFailures.length} startup step(s) failed`,
      '',
      ...info.startupFailures.map((f) => `• ${f.code} ${f.step}: ${f.message}`),
      '',
      `Log: ${info.logDirectory}`,
    ].join('\n');
  }, [info]);

  if (!info || info.startupFailures.length === 0 || dismissed) return null;

  return (
    <div className="border-b border-danger/40 bg-danger/10 px-4 py-2.5">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold text-danger">
            {info.startupFailures.length === 1
              ? 'One part of Task Manager failed to start'
              : `${info.startupFailures.length} parts of Task Manager failed to start`}
          </div>
          <div className="mt-0.5 text-[11px] text-text-secondary">
            The rest is running. Everything below is still measured directly from Windows.
          </div>
          <ul className="selectable mt-1.5 space-y-0.5">
            {info.startupFailures.map((failure, index) => (
              <li key={`${failure.step}-${index}`} className="text-[12px] text-text-primary">
                {/* The code first: it is the part worth reading out or searching
                    for, and it stays the same however the message is reworded. */}
                <span
                  className="mr-1.5 rounded bg-danger/20 px-1 font-mono text-[10px] text-danger"
                  title={describeErrorCode(failure.code)?.meaning ?? ''}
                >
                  {failure.code}
                </span>
                <span className="font-mono text-[11px] text-text-muted">{failure.step}</span>
                {' — '}
                {failure.message}
                {describeErrorCode(failure.code) && (
                  <span className="block pl-1 text-[11px] text-text-secondary">
                    {describeErrorCode(failure.code)?.action}
                  </span>
                )}
              </li>
            ))}
          </ul>
          <div className="selectable mt-1.5 font-mono text-[10px] text-text-muted">
            {info.logDirectory}
          </div>
        </div>
        <div className="flex shrink-0 gap-1.5">
          <button
            type="button"
            onClick={() => {
              void window.taskManager.copyToClipboard(report()).then((ok) => setCopied(ok));
            }}
            className="rounded bg-surface-3 px-2 py-1 text-[11px] text-text-primary transition-colors hover:bg-surface-2"
          >
            {copied ? 'Copied' : 'Copy details'}
          </button>
          <button
            type="button"
            onClick={() => void window.taskManager.openLogFolder()}
            className="rounded bg-surface-3 px-2 py-1 text-[11px] text-text-primary transition-colors hover:bg-surface-2"
          >
            Open logs
          </button>
          <button
            type="button"
            onClick={() => setDismissed(true)}
            aria-label="Dismiss"
            className="rounded bg-surface-3 px-2 py-1 text-[11px] text-text-secondary transition-colors hover:bg-surface-2 hover:text-text-primary"
          >
            Dismiss
          </button>
        </div>
      </div>
    </div>
  );
}
