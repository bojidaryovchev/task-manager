import { useEffect, useMemo, useRef, useState } from 'react';
import type { ProcessMenuCommand } from '@shared/process-actions';
import { useTelemetry } from '../lib/hooks.js';

export type AffinityRequest = Extract<NonNullable<ProcessMenuCommand>, { kind: 'affinity' }>;

type CoreKind = 'performance' | 'efficient' | null;

/**
 * Choosing which logical processors a process may run on.
 *
 * The page draws this because it is a form, which a native menu cannot be;
 * the change itself goes back to the main process, which checks the process
 * and the processors again before asking Windows. On a hybrid processor each
 * logical processor is labelled with the kind of core Windows says it belongs
 * to, so "keep this off the efficient cores" is one click rather than a
 * guess about which numbers are which.
 */
export function AffinityDialog({
  request,
  onClose,
}: {
  request: AffinityRequest;
  onClose: () => void;
}): React.JSX.Element {
  const [selected, setSelected] = useState<ReadonlySet<number>>(() => new Set(request.current));
  const confirm = useRef<HTMLButtonElement | null>(null);
  const kinds = useCoreKinds(request.processors);
  const hybrid = [...kinds.values()].some((kind) => kind !== null);

  useEffect(() => {
    confirm.current?.focus();
  }, []);

  const toggle = (index: number): void => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };
  const only = (kind: CoreKind | 'all'): void => {
    setSelected(
      new Set(request.processors.filter((index) => kind === 'all' || kinds.get(index) === kind)),
    );
  };

  const apply = (): void => {
    if (selected.size === 0) return;
    void window.taskManager.setProcessAffinity(request.key, [...selected]);
    onClose();
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
        aria-labelledby="affinity-title"
        onKeyDown={(event) => {
          if (event.key === 'Escape') onClose();
          if (event.key === 'Enter') apply();
        }}
        className="w-110 rounded-lg border border-border-subtle bg-surface-1"
      >
        <div className="border-b border-border-subtle px-4 py-3">
          <h2 id="affinity-title" className="text-[13px] font-medium">
            Processor affinity
          </h2>
          <p className="mt-0.5 text-[11px] text-text-muted">
            Which logical processors may {request.name} run on? This lasts until it exits.
          </p>
        </div>

        <div className="px-4 py-3">
          <div className="mb-3 flex gap-3 text-[11px]">
            <QuickPick onClick={() => only('all')}>All processors</QuickPick>
            {hybrid && (
              <>
                <QuickPick onClick={() => only('performance')}>Performance cores only</QuickPick>
                <QuickPick onClick={() => only('efficient')}>Efficient cores only</QuickPick>
              </>
            )}
          </div>
          <div className="grid grid-cols-4 gap-x-3 gap-y-1.5">
            {request.processors.map((index) => (
              <label key={index} className="flex cursor-default items-center gap-1.5 text-[12px]">
                <input
                  type="checkbox"
                  checked={selected.has(index)}
                  onChange={() => toggle(index)}
                  className="accent-accent"
                />
                <span className="tnum">CPU {index}</span>
                {kinds.get(index) && (
                  <span className="text-[10px] text-text-muted">
                    {kinds.get(index) === 'performance' ? 'P' : 'E'}
                  </span>
                )}
              </label>
            ))}
          </div>
          {hybrid && (
            <p className="mt-3 text-[11px] text-text-muted">
              P and E are the performance and efficient cores Windows reports for this processor.
            </p>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border-subtle px-4 py-3">
          {selected.size === 0 && (
            <span className="mr-auto text-[11px] text-warn">Choose at least one processor.</span>
          )}
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-border-subtle px-3 py-1 text-[12px] text-text-secondary hover:border-border-strong hover:text-text-primary"
          >
            Cancel
          </button>
          <button
            ref={confirm}
            type="button"
            onClick={apply}
            disabled={selected.size === 0}
            className="rounded bg-accent-dim px-3 py-1 text-[12px] text-text-primary hover:bg-accent disabled:cursor-default disabled:opacity-40"
          >
            Apply
          </button>
        </div>
      </div>
    </div>
  );
}

function QuickPick({
  onClick,
  children,
}: {
  onClick: () => void;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <button type="button" onClick={onClick} className="text-accent hover:underline">
      {children}
    </button>
  );
}

/**
 * Which kind of core each logical processor belongs to, as Windows reports it.
 * Only meaningful on a hybrid processor; elsewhere every entry is null.
 */
function useCoreKinds(processors: number[]): Map<number, CoreKind> {
  const logical = useTelemetry((snapshot) => snapshot?.cpu.perLogicalProcessor ?? null);
  const hybrid = useTelemetry((snapshot) => snapshot?.cpu.topology.isHybrid ?? false);
  return useMemo(() => {
    const classes = new Map<number, number>();
    // Affinity is per processor group; on a single-group machine the index
    // within the group is the same as the flat index.
    for (const processor of logical ?? []) {
      if (processor.group === 0 && processor.efficiencyClass !== undefined) {
        classes.set(processor.numberInGroup, processor.efficiencyClass);
      }
    }
    const values = [...classes.values()];
    const lowest = Math.min(...values);
    const highest = Math.max(...values);
    return new Map(
      processors.map((index) => {
        const efficiency = classes.get(index);
        if (!hybrid || efficiency === undefined || lowest === highest) return [index, null];
        return [
          index,
          efficiency === highest ? 'performance' : efficiency === lowest ? 'efficient' : null,
        ];
      }),
    );
  }, [logical, hybrid, processors]);
}
