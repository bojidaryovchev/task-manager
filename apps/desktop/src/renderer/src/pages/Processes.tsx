import {
  memo,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ProcessSnapshot } from '@task-manager/telemetry-types';
import { formatBytes, formatBytesPerSecond, formatCount, formatPercent } from '@task-manager/shared';
import { PageShell } from '../components/primitives.js';
import { useTelemetry } from '../lib/hooks.js';
import { ProcessDetails } from '../components/ProcessDetails.js';

type SortKey =
  | 'name'
  | 'pid'
  | 'cpu'
  | 'memory'
  | 'commit'
  | 'threads'
  | 'handles'
  | 'diskRead'
  | 'diskWrite';

interface Column {
  key: SortKey;
  label: string;
  width: number;
  align?: 'right';
  definition: string;
}

const COLUMNS: Column[] = [
  { key: 'name', label: 'Name', width: 260, definition: 'Image name reported by Windows.' },
  { key: 'pid', label: 'PID', width: 70, align: 'right', definition: 'Process identifier. Reused by Windows after a process exits.' },
  {
    key: 'cpu',
    label: 'CPU',
    width: 76,
    align: 'right',
    definition:
      'Share of total machine capacity. One fully saturated logical processor is 100/N percent. These values sum to roughly the aggregate CPU figure.',
  },
  {
    key: 'memory',
    label: 'Memory',
    width: 96,
    align: 'right',
    definition:
      'Private working set: physical memory private to this process. The same basis as the Task Manager Memory column.',
  },
  {
    key: 'commit',
    label: 'Commit',
    width: 96,
    align: 'right',
    definition: 'Private committed bytes — memory the process has reserved backing store for.',
  },
  { key: 'threads', label: 'Threads', width: 72, align: 'right', definition: 'Threads currently in the process.' },
  { key: 'handles', label: 'Handles', width: 80, align: 'right', definition: 'Open kernel handles. A steadily climbing count is a handle leak.' },
  {
    key: 'diskRead',
    label: 'I/O read',
    width: 90,
    align: 'right',
    definition: 'Bytes read per second from the process I/O counters. Includes file, network and device I/O, not disk alone.',
  },
  {
    key: 'diskWrite',
    label: 'I/O write',
    width: 90,
    align: 'right',
    definition: 'Bytes written per second from the process I/O counters. Includes file, network and device I/O, not disk alone.',
  },
];

const ROW_HEIGHT = 24;
const OVERSCAN = 12;

/** CPU column mode: two genuinely different normalisations, never mixed. */
type CpuMode = 'machine' | 'core';

export function ProcessesPage(): React.JSX.Element {
  const [sortKey, setSortKey] = useState<SortKey>('cpu');
  const [descending, setDescending] = useState(true);
  const [query, setQuery] = useState('');
  const [cpuMode, setCpuMode] = useState<CpuMode>('machine');
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  // Typing must not block the 500 ms snapshot pipeline on a 1000-row re-filter.
  const deferredQuery = useDeferredValue(query);

  // Only this page needs the process list, so only this page asks for it. While
  // no window is asking, the collector does not gather it at all.
  useEffect(() => {
    void window.taskManager.setProcessSubscription(true);
    return () => {
      void window.taskManager.setProcessSubscription(false);
    };
  }, []);

  const processes = useTelemetry(
    (snapshot) => snapshot?.processes?.processes ?? EMPTY,
    // The array identity changes every snapshot by design; compare by sequence
    // through length plus first key, which is cheap and correct enough to skip
    // renders when nothing arrived.
    (a, b) => a === b,
  );

  const summary = useTelemetry(
    (snapshot) => ({
      total: snapshot?.processes?.totalCount ?? 0,
      denied: snapshot?.processes?.accessDeniedCount ?? 0,
      durationMs: snapshot?.processes?.collectionDurationMs ?? 0,
      logical: snapshot?.cpu.topology.logicalProcessorCount ?? 1,
    }),
    (a, b) => a.total === b.total && a.denied === b.denied,
  );

  const rows = useMemo(() => {
    const needle = deferredQuery.trim().toLowerCase();
    const filtered = needle
      ? processes.filter(
          (p) =>
            p.name.toLowerCase().includes(needle) ||
            String(p.pid) === needle ||
            (p.imagePath?.toLowerCase().includes(needle) ?? false) ||
            (p.userName?.toLowerCase().includes(needle) ?? false),
        )
      : processes.slice();
    filtered.sort(comparatorFor(sortKey, descending, cpuMode));
    return filtered;
  }, [processes, deferredQuery, sortKey, descending, cpuMode]);

  const onSort = useCallback(
    (key: SortKey) => {
      setSortKey((currentKey) => {
        if (currentKey === key) {
          setDescending((value) => !value);
          return currentKey;
        }
        // Text sorts ascending, magnitudes descending — what you almost always want.
        setDescending(key !== 'name');
        return key;
      });
    },
    [],
  );

  const selected = selectedKey ? rows.find((p) => p.key === selectedKey) ?? null : null;

  return (
    <PageShell
      title="Processes"
      subtitle={
        <span>
          {formatCount(summary.total)} processes · {formatCount(summary.denied)} without detail
          access · collected in {summary.durationMs.toFixed(1)} ms
        </span>
      }
      actions={
        <>
          <CpuModeToggle mode={cpuMode} onChange={setCpuMode} logical={summary.logical} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Filter by name, PID, path or user"
            spellCheck={false}
            className="w-64 rounded border border-border-subtle bg-surface-2 px-2 py-1 text-xs text-text-primary outline-none placeholder:text-text-muted focus:border-accent-dim"
          />
        </>
      }
    >
      <div className="flex h-full min-h-0 gap-4">
        <div className="flex min-w-0 flex-1 flex-col rounded-lg border border-border-subtle bg-surface-1">
          <TableHeader
            sortKey={sortKey}
            descending={descending}
            onSort={onSort}
            cpuMode={cpuMode}
          />
          <VirtualRows
            rows={rows}
            cpuMode={cpuMode}
            selectedKey={selectedKey}
            onSelect={setSelectedKey}
            emptyMessage={
              processes.length === 0
                ? 'Collecting the process list…'
                : 'No matching processes.'
            }
          />
        </div>
        {selected && (
          <ProcessDetails process={selected} onClose={() => setSelectedKey(null)} />
        )}
      </div>
    </PageShell>
  );
}

const EMPTY: ProcessSnapshot[] = [];

function CpuModeToggle({
  mode,
  onChange,
  logical,
}: {
  mode: CpuMode;
  onChange: (mode: CpuMode) => void;
  logical: number;
}): React.JSX.Element {
  return (
    <div
      className="flex overflow-hidden rounded border border-border-subtle text-[11px]"
      title={
        `Machine: one saturated logical processor is ${(100 / logical).toFixed(2)}% of this ${logical}-processor machine, ` +
        'and process values sum to the total CPU figure.\n' +
        'Core equivalent: one saturated logical processor is 100%, so a 4-thread process reads 400%.'
      }
    >
      {(
        [
          ['machine', 'Machine %'],
          ['core', 'Core %'],
        ] as const
      ).map(([value, label]) => (
        <button
          key={value}
          type="button"
          onClick={() => onChange(value)}
          className={`px-2 py-1 ${
            mode === value
              ? 'bg-surface-3 text-text-primary'
              : 'bg-surface-1 text-text-muted hover:text-text-secondary'
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function TableHeader({
  sortKey,
  descending,
  onSort,
  cpuMode,
}: {
  sortKey: SortKey;
  descending: boolean;
  onSort: (key: SortKey) => void;
  cpuMode: CpuMode;
}): React.JSX.Element {
  return (
    <div className="flex shrink-0 border-b border-border-subtle bg-surface-2 text-[11px] font-medium text-text-secondary">
      {COLUMNS.map((column) => (
        <button
          key={column.key}
          type="button"
          title={column.definition}
          onClick={() => onSort(column.key)}
          style={{ width: column.key === 'name' ? undefined : column.width }}
          className={`flex items-center gap-1 px-2 py-1.5 hover:text-text-primary ${
            column.key === 'name' ? 'min-w-0 flex-1' : ''
          } ${column.align === 'right' ? 'justify-end' : ''} ${
            sortKey === column.key ? 'text-text-primary' : ''
          }`}
        >
          {column.key === 'cpu' ? (cpuMode === 'machine' ? 'CPU' : 'CPU (core)') : column.label}
          {sortKey === column.key && <span>{descending ? '▾' : '▴'}</span>}
        </button>
      ))}
    </div>
  );
}

/**
 * Windowed row rendering.
 *
 * Only the visible rows plus a small overscan exist in the DOM, so the cost of a
 * snapshot is proportional to the height of the viewport rather than to the
 * number of processes. Row identity is the process key, so React reuses DOM
 * nodes even as the sort order changes.
 */
function VirtualRows({
  rows,
  cpuMode,
  selectedKey,
  onSelect,
  emptyMessage,
}: {
  rows: ProcessSnapshot[];
  cpuMode: CpuMode;
  selectedKey: string | null;
  onSelect: (key: string) => void;
  emptyMessage: string;
}): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(600);

  const measure = useCallback((node: HTMLDivElement | null) => {
    containerRef.current = node;
    if (node) setViewportHeight(node.clientHeight);
  }, []);

  const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const visibleCount = Math.ceil(viewportHeight / ROW_HEIGHT) + OVERSCAN * 2;
  const last = Math.min(rows.length, first + visibleCount);
  const visible = rows.slice(first, last);

  return (
    <div
      ref={measure}
      onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
      className="min-h-0 flex-1 overflow-y-auto"
    >
      <div style={{ height: rows.length * ROW_HEIGHT, position: 'relative' }}>
        <div style={{ transform: `translateY(${first * ROW_HEIGHT}px)` }}>
          {visible.map((process) => (
            <Row
              key={process.key}
              process={process}
              cpuMode={cpuMode}
              selected={process.key === selectedKey}
              onSelect={onSelect}
            />
          ))}
        </div>
      </div>
      {rows.length === 0 && (
        <div className="p-6 text-center text-xs text-text-muted">
          {emptyMessage}
        </div>
      )}
    </div>
  );
}

const Row = memo(function Row({
  process,
  cpuMode,
  selected,
  onSelect,
}: {
  process: ProcessSnapshot;
  cpuMode: CpuMode;
  selected: boolean;
  onSelect: (key: string) => void;
}) {
  const cpu = cpuMode === 'machine' ? process.cpuMachinePercent : process.cpuCoreEquivalentPercent;
  // PID 0 is the System Idle Process. Its CPU time is real and is what makes the
  // process column sum to ~100%, but it measures idleness rather than work, so
  // it is shown muted and labelled instead of being silently dropped.
  const isIdle = process.pid === 0;
  return (
    <div
      onClick={() => onSelect(process.key)}
      style={{ height: ROW_HEIGHT }}
      className={`flex cursor-default items-center text-[12px] ${
        selected ? 'bg-accent-dim/25' : 'hover:bg-surface-2'
      }`}
    >
      <div className="flex min-w-0 flex-1 items-center gap-2 px-2">
        <span
          className={`truncate ${isIdle ? 'text-text-muted' : ''}`}
          title={process.imagePath ?? process.name}
        >
          {process.name}
        </span>
        {isIdle && (
          <span
            className="shrink-0 rounded bg-surface-3 px-1 text-[10px] text-text-muted"
            title={
              'The System Idle Process is not a program. Its CPU time is the time each logical ' +
              'processor spent doing nothing, so this percentage is idle capacity, not work. ' +
              'It and the aggregate CPU utilization add up to roughly 100%.'
            }
          >
            idle
          </span>
        )}
        {process.isWow64 && (
          <span className="shrink-0 rounded bg-surface-3 px-1 text-[10px] text-text-muted">
            32
          </span>
        )}
      </div>
      <Cell width={70}>{process.pid}</Cell>
      <Cell width={76} emphasis={!isIdle && (cpu ?? 0) > 1}>
        {cpu === undefined ? '—' : formatPercent(cpu, cpuMode === 'machine' ? 1 : 0)}
      </Cell>
      <Cell width={96}>{formatBytes(process.privateWorkingSetBytes)}</Cell>
      <Cell width={96}>{formatBytes(process.privateCommitBytes)}</Cell>
      <Cell width={72}>{process.threadCount}</Cell>
      <Cell width={80}>{formatCount(process.handleCount)}</Cell>
      <Cell width={90}>{rate(process.ioReadBytesPerSecond)}</Cell>
      <Cell width={90}>{rate(process.ioWriteBytesPerSecond)}</Cell>
    </div>
  );
});

function rate(value: number | undefined): string {
  if (value === undefined) return '—';
  if (value < 1024) return '';
  return formatBytesPerSecond(value);
}

function Cell({
  width,
  children,
  emphasis,
}: {
  width: number;
  children: React.ReactNode;
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

function comparatorFor(
  key: SortKey,
  descending: boolean,
  cpuMode: CpuMode,
): (a: ProcessSnapshot, b: ProcessSnapshot) => number {
  const direction = descending ? -1 : 1;
  const numeric = (selector: (p: ProcessSnapshot) => number | undefined) =>
    (a: ProcessSnapshot, b: ProcessSnapshot) => {
      // Unmeasured values sort to the bottom in either direction rather than
      // being treated as zero.
      const left = selector(a);
      const right = selector(b);
      if (left === undefined && right === undefined) return 0;
      if (left === undefined) return 1;
      if (right === undefined) return -1;
      return (left - right) * direction;
    };

  switch (key) {
    case 'name':
      return (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) * direction;
    case 'pid':
      return numeric((p) => p.pid);
    case 'cpu':
      return numeric((p) =>
        cpuMode === 'machine' ? p.cpuMachinePercent : p.cpuCoreEquivalentPercent,
      );
    case 'memory':
      return numeric((p) => p.privateWorkingSetBytes);
    case 'commit':
      return numeric((p) => p.privateCommitBytes);
    case 'threads':
      return numeric((p) => p.threadCount);
    case 'handles':
      return numeric((p) => p.handleCount);
    case 'diskRead':
      return numeric((p) => p.ioReadBytesPerSecond);
    case 'diskWrite':
      return numeric((p) => p.ioWriteBytesPerSecond);
  }
}
