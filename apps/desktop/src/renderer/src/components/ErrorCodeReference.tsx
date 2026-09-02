import { useMemo, useState } from 'react';
import { ERROR_CODE_LIST, type ErrorSubsystem } from '@shared/error-codes';
import { Note, Panel } from './primitives.js';

/**
 * The whole error-code registry, in the application.
 *
 * A code is only useful if it can be looked up, and the person who needs to
 * look one up is usually the person whose application is misbehaving — who
 * should not have to find the source, a wiki, or an internet connection to
 * learn what it means. So the registry ships with the thing that emits it.
 */

const SUBSYSTEM_LABELS: Record<ErrorSubsystem, string> = {
  startup: 'Startup',
  collector: 'Collector',
  history: 'History',
  settings: 'Settings',
  widget: 'Widget',
  export: 'Export',
  crash: 'Crash handling',
  renderer: 'Interface',
  logging: 'Logging',
};

export function ErrorCodeReference(): React.JSX.Element {
  const [filter, setFilter] = useState('');

  const matches = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return ERROR_CODE_LIST;
    return ERROR_CODE_LIST.filter((definition) =>
      [definition.code, definition.title, definition.meaning, definition.subsystem]
        .join(' ')
        .toLowerCase()
        .includes(needle),
    );
  }, [filter]);

  return (
    <Panel
      title="Error codes"
      hint={`${ERROR_CODE_LIST.length} states this application can report`}
      actions={
        <input
          type="text"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder="Search, e.g. TM-2001"
          className="w-52 rounded border border-border-subtle bg-surface-0 px-2 py-1 text-[11px] text-text-primary placeholder:text-text-muted"
        />
      }
    >
      <div className="text-[12px]">
        {matches.length === 0 && (
          <div className="text-text-muted">
            No code matches that. A code this version does not know comes from a newer build.
          </div>
        )}
        {matches.map((definition) => (
          <div
            key={definition.code}
            className="border-b border-border-subtle py-2 last:border-b-0"
          >
            <div className="flex flex-wrap items-baseline gap-2">
              <span className="selectable rounded bg-surface-3 px-1.5 font-mono text-[11px] text-text-primary">
                {definition.code}
              </span>
              <span className="text-[10px] uppercase tracking-wide text-text-muted">
                {SUBSYSTEM_LABELS[definition.subsystem]}
              </span>
              <span className="text-text-primary">{definition.title}</span>
            </div>
            <div className="mt-0.5 leading-relaxed text-text-secondary">{definition.meaning}</div>
            <div className="mt-0.5 leading-relaxed text-text-muted">
              <span className="text-text-secondary">What to do: </span>
              {definition.action}
            </div>
          </div>
        ))}
      </div>
      <Note>
        Codes never change meaning. One that stops applying is retired rather than reused, so a
        code quoted from an old screenshot or an old log still means what it meant then.
      </Note>
    </Panel>
  );
}
