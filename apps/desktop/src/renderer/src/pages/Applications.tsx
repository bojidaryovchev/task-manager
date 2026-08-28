import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import type { ProcessSnapshot } from '@task-manager/telemetry-types';
import {
  formatBytes,
  formatCount,
  formatPercent,
  groupIntoApplications,
  type ApplicationGroup,
  type ApplicationGroupBasis,
} from '@task-manager/shared';
import { Note, PageShell } from '../components/primitives.js';
import { useTelemetry } from '../lib/hooks.js';
import { ProcessDetails } from '../components/ProcessDetails.js';

const EMPTY: ProcessSnapshot[] = [];

type SortKey = 'name' | 'processes' | 'cpu' | 'memory' | 'commit';

/** How a group was formed, explained in the UI rather than left implicit. */
const BASIS_LABEL: Record<ApplicationGroupBasis, string> = {
  packageIdentity: 'Windows package identity',
  publisherAndProduct: 'Publisher and product name',
  executablePath: 'Executable path',
  imageName: 'Image name only',
};

const BASIS_EXPLANATION: Record<ApplicationGroupBasis, string> = {
  packageIdentity:
    'Grouped by the package identity Windows assigns to a packaged application. Authoritative, not inferred.',
  publisherAndProduct:
    'Grouped by the CompanyName and ProductName the publisher declared in the executable version resource.',
  executablePath:
    'The image declares no product name, so each distinct executable is its own application. Grouping by file name alone would merge unrelated programs.',
  imageName:
    'The executable path could not be read — usually a process this application lacks rights to open — so only the image name was available.',
};

export function ApplicationsPage(): React.JSX.Element {
  const [sortKey, setSortKey] = useState<SortKey>('cpu');
  const [descending, setDescending] = useState(true);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [selected, setSelected] = useState<ProcessSnapshot | null>(null);

  // This page needs the process list; grouping is derived from it.
  useEffect(() => {
    void window.taskManager.setProcessSubscription(true);
    return () => {
      void window.taskManager.setProcessSubscription(false);
    };
  }, []);

  const processes = useTelemetry((snapshot) => snapshot?.processes?.processes ?? EMPTY);
  const logical = useTelemetry((s) => s?.cpu.topology.logicalProcessorCount ?? 1);

  const groups = useMemo(() => {
    // The System Idle Process is not an application; its CPU time is idleness.
    const real = processes.filter((p) => p.pid !== 0);
    const grouped = groupIntoApplications(real);
    grouped.sort(comparator(sortKey, descending));
    for (const group of grouped) {
      group.processes.sort(
        (a, b) => (b.cpuMachinePercent ?? 0) - (a.cpuMachinePercent ?? 0),
      );
    }
    return grouped;
  }, [processes, sortKey, descending]);

  const onSort = useCallback((key: SortKey) => {
    setSortKey((current) => {
      if (current === key) {
        setDescending((value) => !value);
        return current;
      }
      setDescending(key !== 'name');
      return key;
    });
  }, []);

  const onToggle = useCallback((key: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const grouped = groups.reduce((total, group) => total + group.processes.length, 0);

  return (
    <PageShell
      title="Applications"
      subtitle={
        <span>
          {formatCount(groups.length)} applications from {formatCount(grouped)} processes ·
          grouped only from signals Windows provides
        </span>
      }
    >
      <div className="flex h-full min-h-0 gap-4">
        <div className="flex min-w-0 flex-1 flex-col rounded-lg border border-border-subtle bg-surface-1">
          <div className="flex shrink-0 border-b border-border-subtle bg-surface-2 text-[11px] font-medium text-text-secondary">
            <HeaderCell
              label="Application"
              sortKey="name"
              active={sortKey}
              descending={descending}
              onSort={onSort}
              grow
            />
            <HeaderCell
              label="Processes"
              sortKey="processes"
              active={sortKey}
              descending={descending}
              onSort={onSort}
              width={86}
            />
            <HeaderCell
              label="CPU"
              sortKey="cpu"
              active={sortKey}
              descending={descending}
              onSort={onSort}
              width={80}
              title={`Sum of the member processes' machine shares. One saturated logical processor is ${(100 / logical).toFixed(2)}% here.`}
            />
            <HeaderCell
              label="Memory"
              sortKey="memory"
              active={sortKey}
              descending={descending}
              onSort={onSort}
              width={100}
              title="Sum of private working sets. Safe to add because private pages are never shared."
            />
            <HeaderCell
              label="Commit"
              sortKey="commit"
              active={sortKey}
              descending={descending}
              onSort={onSort}
              width={100}
            />
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {groups.length === 0 && (
              <div className="p-6 text-center text-xs text-text-muted">
                Collecting the process list…
              </div>
            )}
            {groups.map((group) => (
              <GroupRows
                key={group.key}
                group={group}
                expanded={expanded.has(group.key)}
                onToggle={onToggle}
                onSelect={setSelected}
                selectedKey={selected?.key ?? null}
              />
            ))}
          </div>
        </div>
        {selected && <ProcessDetails process={selected} onClose={() => setSelected(null)} />}
      </div>

      <Note>
        Grouping is deliberately conservative and uses only what Windows reports: package identity
        first, then the publisher and product declared in the executable, then the executable path.
        There is no built-in database of application names, and two identically named executables
        from different paths stay separate. Expand any row to see the raw processes underneath.
      </Note>
    </PageShell>
  );
}

function HeaderCell({
  label,
  sortKey,
  active,
  descending,
  onSort,
  width,
  grow,
  title,
}: {
  label: string;
  sortKey: SortKey;
  active: SortKey;
  descending: boolean;
  onSort: (key: SortKey) => void;
  width?: number;
  grow?: boolean;
  title?: string;
}): React.JSX.Element {
  return (
    <button
      type="button"
      title={title}
      onClick={() => onSort(sortKey)}
      style={width ? { width } : undefined}
      className={`flex items-center gap-1 px-2 py-1.5 hover:text-text-primary ${
        grow ? 'min-w-0 flex-1' : 'justify-end'
      } ${active === sortKey ? 'text-text-primary' : ''}`}
    >
      {label}
      {active === sortKey && <span>{descending ? '▾' : '▴'}</span>}
    </button>
  );
}

const GroupRows = memo(function GroupRows({
  group,
  expanded,
  onToggle,
  onSelect,
  selectedKey,
}: {
  group: ApplicationGroup;
  expanded: boolean;
  onToggle: (key: string) => void;
  onSelect: (process: ProcessSnapshot) => void;
  selectedKey: string | null;
}) {
  const { totals } = group;
  return (
    <>
      <div
        onClick={() => onToggle(group.key)}
        className="flex h-7 cursor-default items-center border-b border-border-subtle/40 text-[12px] hover:bg-surface-2"
      >
        <div className="flex min-w-0 flex-1 items-center gap-1.5 px-2">
          <span className="w-3 shrink-0 text-[9px] text-text-muted">
            {group.processes.length > 1 ? (expanded ? '▼' : '▶') : ''}
          </span>
          <span className="truncate font-medium" title={group.imagePath ?? group.name}>
            {group.name}
          </span>
          {group.publisher && (
            <span className="shrink-0 truncate text-[11px] text-text-muted">
              {group.publisher}
            </span>
          )}
          <span
            className="shrink-0 rounded bg-surface-3 px-1 text-[10px] text-text-muted"
            title={BASIS_EXPLANATION[group.basis]}
          >
            {BASIS_LABEL[group.basis]}
          </span>
        </div>
        <Cell width={86}>{group.processes.length}</Cell>
        <Cell width={80} emphasis={totals.cpuMachinePercent > 1}>
          {totals.hasCpuMeasurement ? formatPercent(totals.cpuMachinePercent) : '—'}
        </Cell>
        <Cell width={100}>{formatBytes(totals.privateWorkingSetBytes)}</Cell>
        <Cell width={100}>{formatBytes(totals.privateCommitBytes)}</Cell>
      </div>

      {expanded &&
        group.processes.map((process) => (
          <div
            key={process.key}
            onClick={() => onSelect(process)}
            className={`flex h-6 cursor-default items-center text-[12px] ${
              process.key === selectedKey ? 'bg-accent-dim/25' : 'hover:bg-surface-2'
            }`}
          >
            <div className="flex min-w-0 flex-1 items-center gap-2 pl-8 pr-2">
              <span className="truncate text-text-secondary" title={process.imagePath}>
                {process.name}
              </span>
              <span className="tnum shrink-0 text-[11px] text-text-muted">{process.pid}</span>
            </div>
            <Cell width={86} />
            <Cell width={80}>{formatPercent(process.cpuMachinePercent)}</Cell>
            <Cell width={100}>{formatBytes(process.privateWorkingSetBytes)}</Cell>
            <Cell width={100}>{formatBytes(process.privateCommitBytes)}</Cell>
          </div>
        ))}
    </>
  );
});

function Cell({
  width,
  children,
  emphasis,
}: {
  width: number;
  children?: React.ReactNode;
  emphasis?: boolean;
}): React.JSX.Element {
  return (
    <div
      style={{ width }}
      className={`tnum shrink-0 px-2 text-right ${
        emphasis ? 'text-text-primary' : 'text-text-secondary'
      }`}
    >
      {children}
    </div>
  );
}

function comparator(
  key: SortKey,
  descending: boolean,
): (a: ApplicationGroup, b: ApplicationGroup) => number {
  const direction = descending ? -1 : 1;
  return (a, b) => {
    switch (key) {
      case 'name':
        return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) * direction;
      case 'processes':
        return (a.processes.length - b.processes.length) * direction;
      case 'cpu':
        return (a.totals.cpuMachinePercent - b.totals.cpuMachinePercent) * direction;
      case 'memory':
        return (
          (a.totals.privateWorkingSetBytes - b.totals.privateWorkingSetBytes) * direction
        );
      case 'commit':
        return (a.totals.privateCommitBytes - b.totals.privateCommitBytes) * direction;
    }
  };
}
