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
import {
  buildProcessTree,
  flattenTree,
  formatBytes,
  formatBytesPerSecond,
  formatCount,
  formatPercent,
  type ProcessAggregate,
  type ProcessTreeNode,
} from '@task-manager/shared';
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
  | 'gpu'
  | 'gpuMemory'
  | 'ioRead'
  | 'ioWrite';

interface Column {
  key: SortKey;
  label: string;
  /** 0 means "take the remaining width". */
  width: number;
  definition: string;
}

const COLUMNS: Column[] = [
  { key: 'name', label: 'Name', width: 0, definition: 'Image name reported by Windows.' },
  {
    key: 'pid',
    label: 'PID',
    width: 70,
    definition:
      'Process identifier. Windows reuses these, so identity is PID plus creation time.',
  },
  {
    key: 'cpu',
    label: 'CPU',
    width: 76,
    definition:
      'Share of total machine capacity. One fully saturated logical processor is 100/N percent, so these sum to roughly the aggregate CPU figure.',
  },
  {
    key: 'memory',
    label: 'Memory',
    width: 96,
    definition:
      'Private working set: physical memory private to this process. The same basis as the Task Manager Memory column, and safe to sum because no page is counted twice.',
  },
  {
    key: 'commit',
    label: 'Commit',
    width: 96,
    definition: 'Private committed bytes — backing store reserved, whether resident or not.',
  },
  { key: 'threads', label: 'Threads', width: 72, definition: 'Threads currently in the process.' },
  {
    key: 'handles',
    label: 'Handles',
    width: 80,
    definition: 'Open kernel handles. A steadily climbing count is a handle leak.',
  },
  {
    key: 'gpu',
    label: 'GPU',
    width: 70,
    definition:
      'Maximum GPU engine utilisation for this process, from the GPU Engine counter set. Engines run concurrently, so this is a maximum rather than a sum.',
  },
  {
    key: 'gpuMemory',
    label: 'GPU mem',
    width: 90,
    definition: 'Dedicated GPU memory attributed to this process.',
  },
  {
    key: 'ioRead',
    label: 'I/O read',
    width: 90,
    definition:
      'Bytes per second from the process I/O counters. Covers file, network and device I/O — not disk alone.',
  },
  { key: 'ioWrite', label: 'I/O write', width: 90, definition: 'As I/O read, for writes.' },
];

const ROW_HEIGHT = 24;
const OVERSCAN = 12;
const INDENT_PER_LEVEL = 14;

/** CPU column mode: two genuinely different normalisations, never mixed. */
type CpuMode = 'machine' | 'core';
type ViewMode = 'flat' | 'tree';

/**
 * One rendered row.
 *
 * In tree mode a row with children shows its *subtree* totals, so a collapsed
 * `chrome.exe` accounts for all of its children. Leaf rows always show their own
 * values, and only additive metrics are ever summed.
 */
interface Row {
  process: ProcessSnapshot;
  depth: number;
  childCount: number;
  descendantCount: number;
  /** Subtree totals, present only when this row has children. */
  totals: ProcessAggregate | null;
}

const EMPTY: ProcessSnapshot[] = [];

export function ProcessesPage(): React.JSX.Element {
  const [sortKey, setSortKey] = useState<SortKey>('cpu');
  const [descending, setDescending] = useState(true);
  const [query, setQuery] = useState('');
  const [cpuMode, setCpuMode] = useState<CpuMode>('machine');
  const [viewMode, setViewMode] = useState<ViewMode>('flat');
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());

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

  const processes = useTelemetry((snapshot) => snapshot?.processes?.processes ?? EMPTY);

  const summary = useTelemetry(
    (snapshot) => ({
      total: snapshot?.processes?.totalCount ?? 0,
      denied: snapshot?.processes?.accessDeniedCount ?? 0,
      durationMs: snapshot?.processes?.collectionDurationMs ?? 0,
      logical: snapshot?.cpu.topology.logicalProcessorCount ?? 1,
    }),
    (a, b) => a.total === b.total && a.denied === b.denied,
  );

  const filtered = useMemo(() => {
    const needle = deferredQuery.trim().toLowerCase();
    if (!needle) return processes;
    return processes.filter(
      (p) =>
        p.name.toLowerCase().includes(needle) ||
        String(p.pid) === needle ||
        (p.imagePath?.toLowerCase().includes(needle) ?? false) ||
        (p.userName?.toLowerCase().includes(needle) ?? false) ||
        (p.productName?.toLowerCase().includes(needle) ?? false),
    );
  }, [processes, deferredQuery]);

  const rows = useMemo<Row[]>(() => {
    if (viewMode === 'flat') {
      const sorted = [...filtered].sort(processComparator(sortKey, descending, cpuMode));
      return sorted.map((process) => ({
        process,
        depth: 0,
        childCount: 0,
        descendantCount: 0,
        totals: null,
      }));
    }
    const tree = buildProcessTree(filtered);
    const compare = nodeComparator(sortKey, descending, cpuMode);
    return flattenTree(tree, compare, collapsed).map((node) => ({
      process: node.process,
      depth: node.depth,
      childCount: node.children.length,
      descendantCount: node.subtotal.processCount - 1,
      totals: node.children.length > 0 ? node.subtotal : null,
    }));
  }, [filtered, viewMode, sortKey, descending, cpuMode, collapsed]);

  const onSort = useCallback((key: SortKey) => {
    setSortKey((currentKey) => {
      if (currentKey === key) {
        setDescending((value) => !value);
        return currentKey;
      }
      // Text sorts ascending, magnitudes descending — what you almost always want.
      setDescending(key !== 'name');
      return key;
    });
  }, []);

  const onToggle = useCallback((key: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const selected = selectedKey
    ? (rows.find((r) => r.process.key === selectedKey)?.process ?? null)
    : null;

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
          <Toggle
            value={viewMode}
            onChange={setViewMode}
            options={[
              ['flat', 'Flat'],
              ['tree', 'Tree'],
            ]}
            title={
              'Flat: every process as its own row.\n' +
              'Tree: processes nested under their parent. A row with children shows the totals for its whole subtree.'
            }
          />
          <Toggle
            value={cpuMode}
            onChange={setCpuMode}
            options={[
              ['machine', 'Machine %'],
              ['core', 'Core %'],
            ]}
            title={
              `Machine: one saturated logical processor is ${(100 / summary.logical).toFixed(2)}% of this ${summary.logical}-processor machine, and values sum to the total CPU figure.\n` +
              'Core equivalent: one saturated logical processor is 100%, so a 4-thread process reads 400%.'
            }
          />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Filter by name, PID, path, user or product"
            spellCheck={false}
            className="w-72 rounded border border-border-subtle bg-surface-2 px-2 py-1 text-xs text-text-primary outline-none placeholder:text-text-muted focus:border-accent-dim"
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
            viewMode={viewMode}
            collapsed={collapsed}
            selectedKey={selectedKey}
            onSelect={setSelectedKey}
            onToggle={onToggle}
            emptyMessage={
              processes.length === 0 ? 'Collecting the process list…' : 'No matching processes.'
            }
          />
        </div>
        {selected && <ProcessDetails process={selected} onClose={() => setSelectedKey(null)} />}
      </div>
    </PageShell>
  );
}

function Toggle<T extends string>({
  value,
  onChange,
  options,
  title,
}: {
  value: T;
  onChange: (value: T) => void;
  options: ReadonlyArray<readonly [T, string]>;
  title: string;
}): React.JSX.Element {
  return (
    <div
      className="flex overflow-hidden rounded border border-border-subtle text-[11px]"
      title={title}
    >
      {options.map(([option, label]) => (
        <button
          key={option}
          type="button"
          onClick={() => onChange(option)}
          className={`px-2 py-1 ${
            value === option
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
          style={column.width === 0 ? undefined : { width: column.width }}
          className={`flex items-center gap-1 px-2 py-1.5 hover:text-text-primary ${
            column.width === 0 ? 'min-w-0 flex-1' : 'justify-end'
          } ${sortKey === column.key ? 'text-text-primary' : ''}`}
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
 * snapshot is proportional to viewport height rather than to process count. Row
 * identity is the process key, so React reuses DOM nodes as the order changes.
 */
function VirtualRows({
  rows,
  cpuMode,
  viewMode,
  collapsed,
  selectedKey,
  onSelect,
  onToggle,
  emptyMessage,
}: {
  rows: Row[];
  cpuMode: CpuMode;
  viewMode: ViewMode;
  collapsed: ReadonlySet<string>;
  selectedKey: string | null;
  onSelect: (key: string) => void;
  onToggle: (key: string) => void;
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
          {visible.map((row) => (
            <ProcessRow
              key={row.process.key}
              row={row}
              cpuMode={cpuMode}
              treeMode={viewMode === 'tree'}
              collapsed={collapsed.has(row.process.key)}
              selected={row.process.key === selectedKey}
              onSelect={onSelect}
              onToggle={onToggle}
            />
          ))}
        </div>
      </div>
      {rows.length === 0 && (
        <div className="p-6 text-center text-xs text-text-muted">{emptyMessage}</div>
      )}
    </div>
  );
}

const ProcessRow = memo(function ProcessRow({
  row,
  cpuMode,
  treeMode,
  collapsed,
  selected,
  onSelect,
  onToggle,
}: {
  row: Row;
  cpuMode: CpuMode;
  treeMode: boolean;
  collapsed: boolean;
  selected: boolean;
  onSelect: (key: string) => void;
  onToggle: (key: string) => void;
}) {
  const { process, totals } = row;
  // PID 0 is the System Idle Process. Its CPU time is real and is what makes the
  // column sum to ~100%, but it measures idleness rather than work, so it is
  // shown muted and labelled rather than silently dropped.
  const isIdle = process.pid === 0;

  const machineCpu = totals
    ? totals.hasCpuMeasurement
      ? totals.cpuMachinePercent
      : undefined
    : process.cpuMachinePercent;
  const cpu =
    machineCpu === undefined
      ? undefined
      : cpuMode === 'machine'
        ? machineCpu
        : totals
          ? machineCpu * coreEquivalentRatio(process)
          : process.cpuCoreEquivalentPercent;

  const memory = totals ? totals.privateWorkingSetBytes : process.privateWorkingSetBytes;
  const commit = totals ? totals.privateCommitBytes : process.privateCommitBytes;
  const threads = totals ? totals.threadCount : process.threadCount;
  const handles = totals ? totals.handleCount : process.handleCount;
  const ioRead = totals ? totals.ioReadBytesPerSecond : process.ioReadBytesPerSecond;
  const ioWrite = totals ? totals.ioWriteBytesPerSecond : process.ioWriteBytesPerSecond;

  return (
    <div
      onClick={() => onSelect(process.key)}
      style={{ height: ROW_HEIGHT }}
      className={`flex cursor-default items-center text-[12px] ${
        selected ? 'bg-accent-dim/25' : 'hover:bg-surface-2'
      }`}
    >
      <div
        className="flex min-w-0 flex-1 items-center gap-1.5 px-2"
        style={treeMode ? { paddingLeft: 8 + row.depth * INDENT_PER_LEVEL } : undefined}
      >
        {treeMode &&
          (row.childCount > 0 ? (
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onToggle(process.key);
              }}
              className="w-3 shrink-0 text-[9px] text-text-muted hover:text-text-primary"
              title={collapsed ? 'Expand' : 'Collapse'}
            >
              {collapsed ? '▶' : '▼'}
            </button>
          ) : (
            <span className="w-3 shrink-0" />
          ))}
        <span
          className={`truncate ${isIdle ? 'text-text-muted' : ''}`}
          title={process.imagePath ?? process.name}
        >
          {process.name}
        </span>
        {totals && (
          <span
            className="shrink-0 rounded bg-surface-3 px-1 text-[10px] text-text-muted"
            title={`Values on this row are totals for this process and its ${row.descendantCount} descendants. Only additive metrics are summed.`}
          >
            +{row.descendantCount}
          </span>
        )}
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
          <span
            className="shrink-0 rounded bg-surface-3 px-1 text-[10px] text-text-muted"
            title="32-bit process running under WOW64"
          >
            32
          </span>
        )}
      </div>
      <Cell width={70}>{process.pid}</Cell>
      <Cell width={76} emphasis={!isIdle && (cpu ?? 0) > 1}>
        {cpu === undefined ? '—' : formatPercent(cpu, cpuMode === 'machine' ? 1 : 0)}
      </Cell>
      <Cell width={96}>{formatBytes(memory)}</Cell>
      <Cell width={96}>{formatBytes(commit)}</Cell>
      <Cell width={72}>{threads}</Cell>
      <Cell width={80}>{formatCount(handles)}</Cell>
      <Cell width={70}>
        {process.gpuPercent === undefined || process.gpuPercent === 0
          ? ''
          : formatPercent(process.gpuPercent, 1)}
      </Cell>
      <Cell width={90}>
        {process.gpuDedicatedMemoryBytes === undefined || process.gpuDedicatedMemoryBytes === 0
          ? ''
          : formatBytes(process.gpuDedicatedMemoryBytes)}
      </Cell>
      <Cell width={90}>{rate(ioRead)}</Cell>
      <Cell width={90}>{rate(ioWrite)}</Cell>
    </div>
  );
});

/**
 * The machine-to-core-equivalent ratio, recovered from the process's own pair of
 * values rather than re-deriving it from the processor count.
 *
 * Falls back to 1 when the process has no CPU measurement, so a subtree total
 * can never divide by zero.
 */
function coreEquivalentRatio(process: ProcessSnapshot): number {
  if (
    process.cpuMachinePercent === undefined ||
    process.cpuCoreEquivalentPercent === undefined ||
    process.cpuMachinePercent === 0
  ) {
    return 1;
  }
  return process.cpuCoreEquivalentPercent / process.cpuMachinePercent;
}

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

/** Value a sort reads from a flat process row. */
function processValue(
  process: ProcessSnapshot,
  key: SortKey,
  cpuMode: CpuMode,
): number | string | undefined {
  switch (key) {
    case 'name':
      return process.name;
    case 'pid':
      return process.pid;
    case 'cpu':
      return cpuMode === 'machine' ? process.cpuMachinePercent : process.cpuCoreEquivalentPercent;
    case 'memory':
      return process.privateWorkingSetBytes;
    case 'commit':
      return process.privateCommitBytes;
    case 'threads':
      return process.threadCount;
    case 'handles':
      return process.handleCount;
    case 'gpu':
      return process.gpuPercent;
    case 'gpuMemory':
      return process.gpuDedicatedMemoryBytes;
    case 'ioRead':
      return process.ioReadBytesPerSecond;
    case 'ioWrite':
      return process.ioWriteBytesPerSecond;
  }
}

/** Value a sort reads from a tree node: the subtree total. */
function nodeValue(
  node: ProcessTreeNode,
  key: SortKey,
  cpuMode: CpuMode,
): number | string | undefined {
  const { subtotal, process } = node;
  switch (key) {
    case 'name':
      return process.name;
    case 'pid':
      return process.pid;
    case 'cpu': {
      if (!subtotal.hasCpuMeasurement) return undefined;
      const machine = subtotal.cpuMachinePercent;
      return cpuMode === 'machine' ? machine : machine * coreEquivalentRatio(process);
    }
    case 'memory':
      return subtotal.privateWorkingSetBytes;
    case 'commit':
      return subtotal.privateCommitBytes;
    case 'threads':
      return subtotal.threadCount;
    case 'handles':
      return subtotal.handleCount;
    // GPU is not summed over a subtree: it is a maximum over concurrent
    // engines, and adding two processes' maxima would not mean anything.
    case 'gpu':
      return process.gpuPercent;
    case 'gpuMemory':
      return process.gpuDedicatedMemoryBytes;
    case 'ioRead':
      return subtotal.ioReadBytesPerSecond;
    case 'ioWrite':
      return subtotal.ioWriteBytesPerSecond;
  }
}

/**
 * Compare two extracted values.
 *
 * An unmeasured value sorts to the bottom in either direction rather than being
 * treated as zero, so "no measurement yet" never outranks a real one.
 */
function compareValues(
  left: number | string | undefined,
  right: number | string | undefined,
  direction: number,
): number {
  if (typeof left === 'string' || typeof right === 'string') {
    return (
      String(left ?? '').localeCompare(String(right ?? ''), undefined, {
        sensitivity: 'base',
      }) * direction
    );
  }
  if (left === undefined && right === undefined) return 0;
  if (left === undefined) return 1;
  if (right === undefined) return -1;
  return (left - right) * direction;
}

function processComparator(
  key: SortKey,
  descending: boolean,
  cpuMode: CpuMode,
): (a: ProcessSnapshot, b: ProcessSnapshot) => number {
  const direction = descending ? -1 : 1;
  return (a, b) =>
    compareValues(processValue(a, key, cpuMode), processValue(b, key, cpuMode), direction);
}

function nodeComparator(
  key: SortKey,
  descending: boolean,
  cpuMode: CpuMode,
): (a: ProcessTreeNode, b: ProcessTreeNode) => number {
  const direction = descending ? -1 : 1;
  return (a, b) =>
    compareValues(nodeValue(a, key, cpuMode), nodeValue(b, key, cpuMode), direction);
}
