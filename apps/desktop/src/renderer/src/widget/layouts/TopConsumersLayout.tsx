import type { ProcessSnapshot } from '@task-manager/telemetry-types';
import { formatBytes, formatPercent } from '@task-manager/shared';
import { useTelemetry } from '../../lib/hooks.js';

/**
 * Top CPU and memory consumers.
 *
 * This is the one layout that needs the process list, so it is the one that asks
 * the collector for it; every other layout leaves process enumeration switched
 * off entirely. Ranking is a sort of values the collector already produced.
 */

const ROWS = 3;

export function TopConsumersLayout(): React.JSX.Element {
  const top = useTelemetry(
    (snapshot) => {
      const processes = snapshot?.processes?.processes;
      if (!processes) return null;
      // The System Idle Process leads any CPU sort, but its "CPU" is idle
      // capacity rather than work, so it has no place in a consumers list.
      const real = processes.filter((process) => process.pid !== 0);
      return {
        cpu: rank(real, (process) => process.cpuMachinePercent),
        memory: rank(real, (process) => process.privateWorkingSetBytes),
      };
    },
    // Re-render only when the ranking or its displayed values actually change.
    (a, b) => signature(a) === signature(b),
  );

  if (!top) {
    return <div className="widget-unavailable">Collecting the process list…</div>;
  }

  return (
    <div className="flex h-full flex-col gap-2 px-2.5 py-2">
      <Section
        title="Top CPU"
        rows={top.cpu}
        format={(process) => formatPercent(process.cpuMachinePercent, 1)}
        accent="var(--color-cpu)"
      />
      <Section
        title="Top memory"
        rows={top.memory}
        format={(process) => formatBytes(process.privateWorkingSetBytes)}
        accent="var(--color-memory)"
      />
    </div>
  );
}

function Section({
  title,
  rows,
  format,
  accent,
}: {
  title: string;
  rows: ProcessSnapshot[];
  format: (process: ProcessSnapshot) => string;
  accent: string;
}): React.JSX.Element {
  return (
    <div>
      <div className="widget-label mb-0.5">{title}</div>
      {rows.length === 0 && <div className="widget-value-sm text-text-muted">—</div>}
      {rows.map((process) => (
        <div key={process.key} className="flex items-baseline justify-between gap-2">
          <span className="widget-process truncate" title={process.imagePath ?? process.name}>
            {process.name}
          </span>
          <span className="tnum widget-value-sm shrink-0" style={{ color: accent }}>
            {format(process)}
          </span>
        </div>
      ))}
    </div>
  );
}

function rank(
  processes: readonly ProcessSnapshot[],
  value: (process: ProcessSnapshot) => number | undefined,
): ProcessSnapshot[] {
  return [...processes]
    .filter((process) => (value(process) ?? 0) > 0)
    .sort((a, b) => (value(b) ?? 0) - (value(a) ?? 0))
    .slice(0, ROWS);
}

/** Cheap identity for the current ranking, used to skip redundant renders. */
function signature(
  top: { cpu: ProcessSnapshot[]; memory: ProcessSnapshot[] } | null,
): string {
  if (!top) return '';
  const part = (rows: ProcessSnapshot[], value: (p: ProcessSnapshot) => number | undefined) =>
    rows.map((process) => `${process.key}:${(value(process) ?? 0).toFixed(1)}`).join(',');
  return `${part(top.cpu, (p) => p.cpuMachinePercent)}|${part(
    top.memory,
    (p) => Math.round(p.privateWorkingSetBytes / 1048576),
  )}`;
}
