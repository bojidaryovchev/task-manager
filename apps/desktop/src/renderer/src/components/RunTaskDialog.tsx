import { useEffect, useRef, useState } from 'react';
import { useHostInfo } from '../lib/hooks.js';

/**
 * Run new task, as in Windows Task Manager: type the name of a program,
 * folder, document or website and Windows opens it. The main process does the
 * opening, the way the Run dialog does, and reports anything Windows refuses.
 */
export function RunTaskDialog({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [command, setCommand] = useState('');
  const [asAdministrator, setAsAdministrator] = useState(false);
  const input = useRef<HTMLInputElement | null>(null);
  // Everything an elevated application starts is elevated already.
  const elevated = useHostInfo()?.isElevated ?? false;

  useEffect(() => {
    input.current?.focus();
  }, []);

  const run = (): void => {
    if (command.trim() === '') return;
    void window.taskManager.runNewTask(command, elevated || asAdministrator);
    onClose();
  };

  const browse = (): void => {
    void window.taskManager.browseForProgram().then((path) => {
      if (!path) return;
      // Quoted, so a path with spaces reads as one program.
      setCommand(path.includes(' ') ? `"${path}"` : path);
      input.current?.focus();
    });
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="run-task-title"
        onKeyDown={(event) => {
          if (event.key === 'Escape') onClose();
        }}
        className="w-110 rounded-lg border border-border-subtle bg-surface-1"
      >
        <div className="border-b border-border-subtle px-4 py-3">
          <h2 id="run-task-title" className="text-[13px] font-medium">
            Run new task
          </h2>
          <p className="mt-0.5 text-[11px] text-text-muted">
            Type the name of a program, folder, document or website, and Windows opens it.
          </p>
        </div>

        <form
          className="px-4 py-3"
          onSubmit={(event) => {
            event.preventDefault();
            run();
          }}
        >
          <div className="flex gap-2">
            <input
              ref={input}
              value={command}
              onChange={(event) => setCommand(event.target.value)}
              spellCheck={false}
              aria-label="Program, folder, document or website"
              placeholder="notepad, %TEMP%, https://…"
              className="min-w-0 flex-1 rounded border border-border-subtle bg-surface-2 px-2 py-1 text-[12px] text-text-primary outline-none placeholder:text-text-muted focus:border-accent-dim"
            />
            <button
              type="button"
              onClick={browse}
              className="rounded border border-border-subtle px-3 py-1 text-[12px] text-text-secondary hover:border-border-strong hover:text-text-primary"
            >
              Browse…
            </button>
          </div>
          <label className="mt-3 flex cursor-default items-center gap-2 text-[12px]">
            <input
              type="checkbox"
              checked={elevated || asAdministrator}
              disabled={elevated}
              onChange={(event) => setAsAdministrator(event.target.checked)}
              className="accent-accent"
            />
            Run as administrator
          </label>
          {elevated && (
            <p className="mt-1 text-[11px] text-text-muted">
              Task Manager is running as administrator, so everything it starts is too.
            </p>
          )}

          <div className="mt-4 flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded border border-border-subtle px-3 py-1 text-[12px] text-text-secondary hover:border-border-strong hover:text-text-primary"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={command.trim() === ''}
              className="rounded bg-accent-dim px-3 py-1 text-[12px] text-text-primary hover:bg-accent disabled:cursor-default disabled:opacity-40"
            >
              Run
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
