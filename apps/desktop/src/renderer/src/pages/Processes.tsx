import {
  forwardRef,
  memo,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ProcessSnapshot } from '@task-manager/telemetry-types';
import { buildProcessTree, flattenTree, formatCount } from '@task-manager/shared';
import { DEFAULT_PROCESS_COLUMNS, type ProcessColumnId } from '@shared/process-columns';
import { PageShell } from '../components/primitives.js';
import {
  Cell,
  COLUMN_SPECS,
  NAME_DEFINITION,
  nodeComparator,
  processComparator,
  sortsDescending,
  type CpuMode,
  type Row,
  type SortKey,
} from './process-columns.js';
import { useCtrlHeld, useFrozen, useHostInfo, useTelemetry } from '../lib/hooks.js';
import { ProcessDetails } from '../components/ProcessDetails.js';
import { AffinityDialog, type AffinityRequest } from '../components/AffinityDialog.js';
import {
  clickSelection,
  contextSelection,
  EMPTY_SELECTION,
  moveSelection,
  visibleSelection,
  type Selection,
} from '../lib/selection.js';

const ROW_HEIGHT = 24;
const OVERSCAN = 12;
const INDENT_PER_LEVEL = 14;

type ViewMode = 'flat' | 'tree';

const EMPTY: ProcessSnapshot[] = [];

export function ProcessesPage({ onRunNewTask }: { onRunNewTask: () => void }): React.JSX.Element {
  const [sortKey, setSortKey] = useState<SortKey>('cpu');
  const [descending, setDescending] = useState(true);
  const [query, setQuery] = useState('');
  const [cpuMode, setCpuMode] = useState<CpuMode>('machine');
  const [viewMode, setViewMode] = useState<ViewMode>('flat');
  const [selection, setSelection] = useState<Selection>(EMPTY_SELECTION);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  // A request to scroll a row into view. The nonce makes asking twice for the
  // same row scroll twice, which a bare key could not.
  const [reveal, setReveal] = useState<{ key: string; nonce: number } | null>(null);
  const [affinity, setAffinity] = useState<AffinityRequest | null>(null);

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

  // Holding Ctrl freezes the list, values and order, as in Windows Task Manager.
  const ctrlHeld = useCtrlHeld();
  const processes = useFrozen(
    useTelemetry((snapshot) => snapshot?.processes?.processes ?? EMPTY),
    ctrlHeld,
  );

  const liveSummary = useTelemetry(
    (snapshot) => ({
      total: snapshot?.processes?.totalCount ?? 0,
      denied: snapshot?.processes?.accessDeniedCount ?? 0,
      durationMs: snapshot?.processes?.collectionDurationMs ?? 0,
      logical: snapshot?.cpu.topology.logicalProcessorCount ?? 1,
    }),
    (a, b) => a.total === b.total && a.denied === b.denied,
  );
  const summary = useFrozen(liveSummary, ctrlHeld);
  const elevated = useHostInfo()?.isElevated ?? true;

  const filtered = useMemo(() => {
    const needle = deferredQuery.trim().toLowerCase();
    if (!needle) return processes;
    return processes.filter(
      (p) =>
        p.name.toLowerCase().includes(needle) ||
        String(p.pid) === needle ||
        (p.imagePath?.toLowerCase().includes(needle) ?? false) ||
        (p.userName?.toLowerCase().includes(needle) ?? false) ||
        (p.productName?.toLowerCase().includes(needle) ?? false) ||
        (p.services?.some(
          (service) =>
            service.name.toLowerCase().includes(needle) ||
            service.displayName.toLowerCase().includes(needle),
        ) ??
          false),
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
      // Text sorts A to Z first, magnitudes largest first.
      setDescending(sortsDescending(key));
      return key;
    });
  }, []);

  // The optional columns, as chosen from the header's right-click menu.
  const [columns, setColumns] = useState<ProcessColumnId[]>(() => [...DEFAULT_PROCESS_COLUMNS]);
  useEffect(() => {
    void window.taskManager.getProcessColumns().then(setColumns);
  }, []);
  const onColumnMenu = useCallback((event: React.MouseEvent) => {
    event.preventDefault();
    void window.taskManager.showColumnMenu().then(setColumns);
  }, []);
  // Sorting by a column that has just been hidden would order the list by
  // something no longer on screen.
  useEffect(() => {
    if (sortKey !== 'name' && !columns.includes(sortKey)) {
      setSortKey(columns.includes('cpu') ? 'cpu' : 'name');
      setDescending(columns.includes('cpu'));
    }
  }, [columns, sortKey]);

  // The header scrolls sideways with the rows, which own the scrollbar.
  const headerRef = useRef<HTMLDivElement | null>(null);
  const onScrollLeft = useCallback((left: number) => {
    if (headerRef.current && headerRef.current.scrollLeft !== left) {
      headerRef.current.scrollLeft = left;
    }
  }, []);

  const onToggle = useCallback((key: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  // Gestures read the order and the selection as they are at the moment of the
  // gesture. Refs, so the row callbacks keep one identity and memoised rows do
  // not re-render just because the list moved.
  const order = useMemo(() => rows.map((row) => row.process.key), [rows]);
  const orderRef = useRef(order);
  orderRef.current = order;
  const selectionRef = useRef(selection);
  selectionRef.current = selection;

  // Only rows still on screen count: acting on a selected process the filter
  // hides, or one that has exited, would not be acting on what is highlighted.
  const chosen = useMemo(() => visibleSelection(order, selection), [order, selection]);
  const detailed =
    chosen.length === 1 ? (rows.find((row) => row.process.key === chosen[0])?.process ?? null) : null;

  const select = useCallback((next: Selection, scrollTo?: string | null) => {
    setSelection(next);
    if (scrollTo) setReveal({ key: scrollTo, nonce: Date.now() });
  }, []);

  const goTo = useCallback(
    (key: string) => {
      const byKey = new Map(processes.map((process) => [process.key, process]));
      // In tree mode the row only exists once every ancestor is expanded.
      setCollapsed((current) => {
        const next = new Set(current);
        let cursor = byKey.get(key)?.parentKey;
        for (let guard = 0; cursor && guard < byKey.size; guard += 1) {
          next.delete(cursor);
          cursor = byKey.get(cursor)?.parentKey;
        }
        return next;
      });
      // A filter hiding the row would make going there look like it failed.
      if (!filtered.some((process) => process.key === key)) setQuery('');
      select({ keys: new Set([key]), focus: key, anchor: key }, key);
    },
    [processes, filtered, select],
  );

  const openMenu = useCallback(
    (keys: string[]) => {
      if (keys.length === 0) return;
      void window.taskManager.showProcessMenu({ keys, context: 'processes' }).then((command) => {
        if (command?.kind === 'goToParent') goTo(command.key);
        if (command?.kind === 'affinity') setAffinity(command);
      });
    },
    [goTo],
  );

  const onRowClick = useCallback(
    (key: string, event: React.MouseEvent) => {
      select(
        clickSelection(orderRef.current, selectionRef.current, key, {
          toggle: event.ctrlKey || event.metaKey,
          range: event.shiftKey,
        }),
      );
    },
    [select],
  );

  const onRowContextMenu = useCallback(
    (key: string, event: React.MouseEvent) => {
      event.preventDefault();
      const next = contextSelection(selectionRef.current, key);
      select(next);
      openMenu(visibleSelection(orderRef.current, next));
    },
    [select, openMenu],
  );

  const endChosen = useCallback(() => {
    const keys = visibleSelection(orderRef.current, selectionRef.current);
    if (keys.length > 0) void window.taskManager.endProcesses(keys);
  }, []);

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const current = selectionRef.current;
      const move = (to: number | 'first' | 'last'): void => {
        const next = moveSelection(orderRef.current, current, to, event.shiftKey);
        select(next, next.focus);
      };
      const page = Math.max(1, Math.floor(event.currentTarget.clientHeight / ROW_HEIGHT) - 1);
      switch (event.key) {
        case 'ArrowDown':
          move(1);
          break;
        case 'ArrowUp':
          move(-1);
          break;
        case 'PageDown':
          move(page);
          break;
        case 'PageUp':
          move(-page);
          break;
        case 'Home':
          move('first');
          break;
        case 'End':
          move('last');
          break;
        case 'ArrowRight':
        case 'ArrowLeft': {
          // In the tree, right opens a branch and left folds it.
          if (viewMode !== 'tree' || !current.focus) return;
          const expand = event.key === 'ArrowRight';
          const key = current.focus;
          setCollapsed((collapsedNow) => {
            if (collapsedNow.has(key) !== expand) return collapsedNow;
            const next = new Set(collapsedNow);
            if (expand) next.delete(key);
            else next.add(key);
            return next;
          });
          break;
        }
        case 'Delete':
          endChosen();
          break;
        case 'Escape':
          select(EMPTY_SELECTION);
          break;
        case 'ContextMenu':
          openMenu(visibleSelection(orderRef.current, current));
          break;
        case 'F10':
          if (!event.shiftKey) return;
          openMenu(visibleSelection(orderRef.current, current));
          break;
        case 'c':
        case 'C': {
          if (!(event.ctrlKey || event.metaKey)) return;
          const keys = new Set(visibleSelection(orderRef.current, current));
          const lines = processes
            .filter((process) => keys.has(process.key))
            .map((process) => `${process.name}\t${process.pid}`);
          if (lines.length === 0) return;
          void window.taskManager.copyToClipboard(lines.join('\n'));
          break;
        }
        default:
          return;
      }
      event.preventDefault();
    },
    [viewMode, processes, select, openMenu, endChosen],
  );

  return (
    <PageShell
      title="Processes"
      subtitle={
        <span>
          {formatCount(summary.total)} processes · {formatCount(summary.denied)} without detail
          access
          {!elevated && summary.denied > 0 && (
            <>
              {' ('}
              <button
                type="button"
                onClick={() => void window.taskManager.restartAsAdministrator()}
                title="Windows keeps these processes' details, and ending them, to administrators. Protected processes refuse even then."
                className="text-accent hover:underline"
              >
                restart as administrator
              </button>
              {' to see them)'}
            </>
          )}{' '}
          · collected in {summary.durationMs.toFixed(1)} ms
          {ctrlHeld && <span className="text-text-primary"> · paused while Ctrl is held</span>}
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
            placeholder="Filter by name, PID, path, user, product or service"
            spellCheck={false}
            className="w-60 rounded border border-border-subtle bg-surface-2 px-2 py-1 text-xs text-text-primary outline-none placeholder:text-text-muted focus:border-accent-dim"
          />
          <button
            type="button"
            onClick={onRunNewTask}
            title="Open a program, folder, document or website, as Windows' Run dialog does."
            className="rounded border border-border-subtle bg-surface-2 px-2.5 py-1 text-[11px] text-text-primary hover:border-border-strong"
          >
            Run new task
          </button>
          <button
            type="button"
            onClick={endChosen}
            disabled={chosen.length === 0}
            title="End the selected processes (Delete). Right-click a process for everything else."
            className="rounded border border-border-subtle bg-surface-2 px-2.5 py-1 text-[11px] text-text-primary hover:border-border-strong disabled:cursor-default disabled:text-text-muted disabled:hover:border-border-subtle"
          >
            {chosen.length > 1 ? `End ${chosen.length} processes` : 'End task'}
          </button>
        </>
      }
    >
      <div className="flex h-full min-h-0 gap-4">
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-lg border border-border-subtle bg-surface-1">
          <TableHeader
            ref={headerRef}
            columns={columns}
            sortKey={sortKey}
            descending={descending}
            onSort={onSort}
            onColumnMenu={onColumnMenu}
            cpuMode={cpuMode}
          />
          <VirtualRows
            rows={rows}
            columns={columns}
            onScrollLeft={onScrollLeft}
            cpuMode={cpuMode}
            viewMode={viewMode}
            collapsed={collapsed}
            selectedKeys={selection.keys}
            reveal={reveal}
            onRowClick={onRowClick}
            onRowContextMenu={onRowContextMenu}
            onKeyDown={onKeyDown}
            onToggle={onToggle}
            emptyMessage={
              processes.length === 0 ? 'Collecting the process list…' : 'No matching processes.'
            }
          />
        </div>
        {detailed && (
          <ProcessDetails process={detailed} onClose={() => select(EMPTY_SELECTION)} />
        )}
      </div>
      {affinity && <AffinityDialog request={affinity} onClose={() => setAffinity(null)} />}
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

/** The Name column never gets narrower than this; the table scrolls instead. */
const NAME_MIN_WIDTH = 220;

/** The width the whole table needs for the columns showing. */
function tableWidth(columns: readonly ProcessColumnId[]): number {
  return columns.reduce((total, id) => total + COLUMN_SPECS[id].width, NAME_MIN_WIDTH);
}

const TableHeader = forwardRef<
  HTMLDivElement,
  {
    columns: readonly ProcessColumnId[];
    sortKey: SortKey;
    descending: boolean;
    onSort: (key: SortKey) => void;
    onColumnMenu: (event: React.MouseEvent) => void;
    cpuMode: CpuMode;
  }
>(function TableHeader({ columns, sortKey, descending, onSort, onColumnMenu, cpuMode }, ref) {
  const arrow = (key: SortKey): React.ReactNode =>
    sortKey === key && <span>{descending ? '▾' : '▴'}</span>;
  return (
    // Scrolled sideways in step with the rows, which own the scrollbar.
    <div ref={ref} className="shrink-0 overflow-hidden border-b border-border-subtle bg-surface-2">
      <div
        onContextMenu={onColumnMenu}
        title="Right-click to choose columns"
        style={{ minWidth: tableWidth(columns) }}
        className="flex text-[11px] font-medium text-text-secondary"
      >
        <button
          type="button"
          title={NAME_DEFINITION}
          onClick={() => onSort('name')}
          className={`flex min-w-0 flex-1 items-center gap-1 px-2 py-1.5 hover:text-text-primary ${
            sortKey === 'name' ? 'text-text-primary' : ''
          }`}
        >
          Name
          {arrow('name')}
        </button>
        {columns.map((id) => {
          const spec = COLUMN_SPECS[id];
          return (
            <button
              key={id}
              type="button"
              title={spec.definition}
              onClick={() => onSort(id)}
              style={{ width: spec.width }}
              className={`flex shrink-0 items-center gap-1 px-2 py-1.5 hover:text-text-primary ${
                spec.align === 'right' ? 'justify-end' : ''
              } ${sortKey === id ? 'text-text-primary' : ''}`}
            >
              {spec.label(cpuMode)}
              {arrow(id)}
            </button>
          );
        })}
      </div>
    </div>
  );
});

/**
 * Windowed row rendering.
 *
 * Only the visible rows plus a small overscan exist in the DOM, so the cost of a
 * snapshot is proportional to viewport height rather than to process count. Row
 * identity is the process key, so React reuses DOM nodes as the order changes.
 */
function VirtualRows({
  rows,
  columns,
  cpuMode,
  viewMode,
  collapsed,
  selectedKeys,
  reveal,
  onRowClick,
  onRowContextMenu,
  onKeyDown,
  onToggle,
  onScrollLeft,
  emptyMessage,
}: {
  rows: Row[];
  columns: readonly ProcessColumnId[];
  cpuMode: CpuMode;
  viewMode: ViewMode;
  collapsed: ReadonlySet<string>;
  selectedKeys: ReadonlySet<string>;
  reveal: { key: string; nonce: number } | null;
  onRowClick: (key: string, event: React.MouseEvent) => void;
  onRowContextMenu: (key: string, event: React.MouseEvent) => void;
  onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => void;
  onToggle: (key: string) => void;
  /** Sideways scrolling, so the header can follow. */
  onScrollLeft: (left: number) => void;
  emptyMessage: string;
}): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(600);

  const measure = useCallback((node: HTMLDivElement | null) => {
    containerRef.current = node;
    if (node) setViewportHeight(node.clientHeight);
  }, []);

  // Scroll just far enough to show a row the keyboard or "Go to parent" moved
  // to. Runs once per request, so it never fights the user's own scrolling.
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  useEffect(() => {
    const node = containerRef.current;
    if (!reveal || !node) return;
    const index = rowsRef.current.findIndex((row) => row.process.key === reveal.key);
    if (index < 0) return;
    const top = index * ROW_HEIGHT;
    if (top < node.scrollTop) node.scrollTop = top;
    else if (top + ROW_HEIGHT > node.scrollTop + node.clientHeight) {
      node.scrollTop = top + ROW_HEIGHT - node.clientHeight;
    }
  }, [reveal]);

  const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const visibleCount = Math.ceil(viewportHeight / ROW_HEIGHT) + OVERSCAN * 2;
  const last = Math.min(rows.length, first + visibleCount);
  const visible = rows.slice(first, last);

  return (
    <div
      ref={measure}
      role="listbox"
      aria-multiselectable="true"
      aria-label="Processes"
      tabIndex={0}
      onKeyDown={onKeyDown}
      onScroll={(event) => {
        setScrollTop(event.currentTarget.scrollTop);
        onScrollLeft(event.currentTarget.scrollLeft);
      }}
      className="min-h-0 flex-1 overflow-auto outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent-dim"
    >
      <div
        style={{
          height: rows.length * ROW_HEIGHT,
          minWidth: tableWidth(columns),
          position: 'relative',
        }}
      >
        <div style={{ transform: `translateY(${first * ROW_HEIGHT}px)` }}>
          {visible.map((row) => (
            <ProcessRow
              key={row.process.key}
              row={row}
              columns={columns}
              cpuMode={cpuMode}
              treeMode={viewMode === 'tree'}
              collapsed={collapsed.has(row.process.key)}
              selected={selectedKeys.has(row.process.key)}
              onClick={onRowClick}
              onContextMenu={onRowContextMenu}
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
  columns,
  cpuMode,
  treeMode,
  collapsed,
  selected,
  onClick,
  onContextMenu,
  onToggle,
}: {
  row: Row;
  columns: readonly ProcessColumnId[];
  cpuMode: CpuMode;
  treeMode: boolean;
  collapsed: boolean;
  selected: boolean;
  onClick: (key: string, event: React.MouseEvent) => void;
  onContextMenu: (key: string, event: React.MouseEvent) => void;
  onToggle: (key: string) => void;
}) {
  const { process, totals } = row;
  // PID 0 is the System Idle Process. Its CPU time is real and is what makes the
  // column sum to ~100%, but it measures idleness rather than work, so it is
  // shown muted and labelled rather than silently dropped.
  const isIdle = process.pid === 0;

  return (
    <div
      role="option"
      aria-selected={selected}
      onClick={(event) => onClick(process.key, event)}
      onContextMenu={(event) => onContextMenu(process.key, event)}
      style={{ height: ROW_HEIGHT }}
      className={`flex cursor-default select-none items-center text-[12px] ${
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
          className={`truncate ${isIdle ? 'text-text-muted' : ''} ${process.services ? 'shrink-0' : ''}`}
          title={process.imagePath ?? process.name}
        >
          {process.name}
        </span>
        {process.services && (
          // The services a host process runs, so 99 svchost.exe rows each say
          // what they are.
          <span
            className="min-w-0 truncate text-[11px] text-text-muted"
            title={process.services
              .map((service) => `${service.displayName} (${service.name})`)
              .join('\n')}
          >
            {process.services.map((service) => service.displayName).join(', ')}
          </span>
        )}
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
      {columns.map((id) => (
        <Cell key={id} id={id} row={row} cpuMode={cpuMode} />
      ))}
    </div>
  );
});
