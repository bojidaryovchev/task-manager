import type { ReactNode } from 'react';
import type { ProcessSnapshot } from '@task-manager/telemetry-types';
import {
  formatBytes,
  formatBytesPerSecond,
  formatCount,
  formatPercent,
  type ProcessAggregate,
  type ProcessTreeNode,
} from '@task-manager/shared';
import type { ProcessColumnId } from '@shared/process-columns';

/**
 * How each column of the Processes page reads, sorts and draws a process.
 *
 * In tree mode a row with children shows its subtree totals, but only for
 * metrics that add up honestly: private memory, commit, threads, handles, CPU
 * time and I/O rates. Everything else - a working set that counts shared
 * pages, a GPU maximum, a name - shows the row's own value.
 */

/** CPU column mode: two genuinely different normalisations, never mixed. */
export type CpuMode = 'machine' | 'core';

/** One rendered row. */
export interface Row {
  process: ProcessSnapshot;
  depth: number;
  childCount: number;
  descendantCount: number;
  /** Subtree totals, present only when this row has children. */
  totals: ProcessAggregate | null;
}

export type SortKey = 'name' | ProcessColumnId;

type Value = number | string | undefined;

interface ColumnSpec {
  label(cpuMode: CpuMode): string;
  width: number;
  align: 'left' | 'right';
  /** Text sorts A to Z first; magnitudes largest first. */
  text: boolean;
  definition: string;
  value(process: ProcessSnapshot, cpuMode: CpuMode): Value;
  /** Tree rows sort by their subtree total where the column sums. */
  nodeValue?(node: ProcessTreeNode, cpuMode: CpuMode): Value;
  render(row: Row, cpuMode: CpuMode): ReactNode;
  /** Drawn in the primary text colour, to stand out. */
  emphasis?(row: Row, cpuMode: CpuMode): boolean;
}

export const NAME_DEFINITION =
  'Image name reported by Windows, and the Windows services the process hosts.';

/** Windows' base priority for each class, as Task Manager names them. */
const PRIORITY_NAMES: Record<number, string> = {
  4: 'Low',
  6: 'Below normal',
  8: 'Normal',
  10: 'Above normal',
  13: 'High',
  24: 'Realtime',
};

function own<T>(pick: (process: ProcessSnapshot) => T): (row: Row) => T {
  return (row) => pick(row.process);
}

function text(
  label: string,
  width: number,
  definition: string,
  pick: (process: ProcessSnapshot) => string | undefined,
): ColumnSpec {
  return {
    label: () => label,
    width,
    align: 'left',
    text: true,
    definition,
    value: pick,
    render: (row) => pick(row.process) ?? '',
  };
}

function bytes(
  label: string,
  width: number,
  definition: string,
  pick: (process: ProcessSnapshot) => number,
): ColumnSpec {
  return {
    label: () => label,
    width,
    align: 'right',
    text: false,
    definition,
    value: pick,
    render: (row) => formatBytes(pick(row.process)),
  };
}

function count(
  label: string,
  width: number,
  definition: string,
  pick: (process: ProcessSnapshot) => number,
): ColumnSpec {
  return {
    label: () => label,
    width,
    align: 'right',
    text: false,
    definition,
    value: pick,
    render: (row) => formatCount(pick(row.process)),
  };
}

/**
 * The machine-to-core-equivalent ratio, recovered from the process's own pair
 * of values rather than re-derived from the processor count. Falls back to 1
 * when the process has no CPU measurement, so a subtree total can never divide
 * by zero.
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

function cpuOf(row: Row, cpuMode: CpuMode): number | undefined {
  const { process, totals } = row;
  const machine = totals
    ? totals.hasCpuMeasurement
      ? totals.cpuMachinePercent
      : undefined
    : process.cpuMachinePercent;
  if (machine === undefined) return undefined;
  if (cpuMode === 'machine') return machine;
  return totals ? machine * coreEquivalentRatio(process) : process.cpuCoreEquivalentPercent;
}

function rate(value: number | undefined): string {
  if (value === undefined) return '—';
  if (value < 1024) return '';
  return formatBytesPerSecond(value);
}

function startedAt(process: ProcessSnapshot): string {
  const started = new Date(process.createTimeUnixMs);
  const today = new Date();
  return started.toDateString() === today.toDateString()
    ? started.toLocaleTimeString()
    : started.toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });
}

export const COLUMN_SPECS: Record<ProcessColumnId, ColumnSpec> = {
  pid: {
    label: () => 'PID',
    width: 70,
    align: 'right',
    text: false,
    definition:
      'Process identifier. Windows reuses these, so identity is PID plus creation time.',
    value: (process) => process.pid,
    render: own((process) => process.pid),
  },
  cpu: {
    label: (cpuMode) => (cpuMode === 'machine' ? 'CPU' : 'CPU (core)'),
    width: 76,
    align: 'right',
    text: false,
    definition:
      'Share of total machine capacity. One fully saturated logical processor is 100/N percent, so these sum to roughly the aggregate CPU figure.',
    value: (process, cpuMode) =>
      cpuMode === 'machine' ? process.cpuMachinePercent : process.cpuCoreEquivalentPercent,
    nodeValue: (node, cpuMode) => {
      if (!node.subtotal.hasCpuMeasurement) return undefined;
      const machine = node.subtotal.cpuMachinePercent;
      return cpuMode === 'machine' ? machine : machine * coreEquivalentRatio(node.process);
    },
    render: (row, cpuMode) => {
      const cpu = cpuOf(row, cpuMode);
      return cpu === undefined ? '—' : formatPercent(cpu, cpuMode === 'machine' ? 1 : 0);
    },
    emphasis: (row, cpuMode) => row.process.pid !== 0 && (cpuOf(row, cpuMode) ?? 0) > 1,
  },
  memory: {
    label: () => 'Memory',
    width: 96,
    align: 'right',
    text: false,
    definition:
      'Private working set: physical memory private to this process. The same basis as the Task Manager Memory column, and safe to sum because no page is counted twice.',
    value: (process) => process.privateWorkingSetBytes,
    nodeValue: (node) => node.subtotal.privateWorkingSetBytes,
    render: (row) =>
      formatBytes(row.totals ? row.totals.privateWorkingSetBytes : row.process.privateWorkingSetBytes),
  },
  commit: {
    label: () => 'Commit',
    width: 96,
    align: 'right',
    text: false,
    definition: 'Private committed bytes: backing store reserved, whether resident or not.',
    value: (process) => process.privateCommitBytes,
    nodeValue: (node) => node.subtotal.privateCommitBytes,
    render: (row) =>
      formatBytes(row.totals ? row.totals.privateCommitBytes : row.process.privateCommitBytes),
  },
  threads: {
    label: () => 'Threads',
    width: 72,
    align: 'right',
    text: false,
    definition: 'Threads currently in the process.',
    value: (process) => process.threadCount,
    nodeValue: (node) => node.subtotal.threadCount,
    render: (row) => (row.totals ? row.totals.threadCount : row.process.threadCount),
  },
  handles: {
    label: () => 'Handles',
    width: 80,
    align: 'right',
    text: false,
    definition: 'Open kernel handles. A steadily climbing count is a handle leak.',
    value: (process) => process.handleCount,
    nodeValue: (node) => node.subtotal.handleCount,
    render: (row) => formatCount(row.totals ? row.totals.handleCount : row.process.handleCount),
  },
  gpu: {
    label: () => 'GPU',
    width: 70,
    align: 'right',
    text: false,
    definition:
      'Maximum GPU engine utilisation for this process, from the GPU Engine counter set. Engines run concurrently, so this is a maximum rather than a sum, and it is never added up over a tree.',
    value: (process) => process.gpuPercent,
    render: own((process) =>
      process.gpuPercent === undefined || process.gpuPercent === 0
        ? ''
        : formatPercent(process.gpuPercent, 1),
    ),
  },
  gpuMemory: {
    label: () => 'GPU mem',
    width: 90,
    align: 'right',
    text: false,
    definition: 'Dedicated GPU memory attributed to this process.',
    value: (process) => process.gpuDedicatedMemoryBytes,
    render: own((process) =>
      process.gpuDedicatedMemoryBytes === undefined || process.gpuDedicatedMemoryBytes === 0
        ? ''
        : formatBytes(process.gpuDedicatedMemoryBytes),
    ),
  },
  ioRead: {
    label: () => 'I/O read',
    width: 90,
    align: 'right',
    text: false,
    definition:
      'Bytes per second from the process I/O counters. Covers file, network and device I/O, not disk alone.',
    value: (process) => process.ioReadBytesPerSecond,
    nodeValue: (node) => node.subtotal.ioReadBytesPerSecond,
    render: (row) =>
      rate(row.totals ? row.totals.ioReadBytesPerSecond : row.process.ioReadBytesPerSecond),
  },
  ioWrite: {
    label: () => 'I/O write',
    width: 90,
    align: 'right',
    text: false,
    definition: 'As I/O read, for writes.',
    value: (process) => process.ioWriteBytesPerSecond,
    nodeValue: (node) => node.subtotal.ioWriteBytesPerSecond,
    render: (row) =>
      rate(row.totals ? row.totals.ioWriteBytesPerSecond : row.process.ioWriteBytesPerSecond),
  },
  user: text('User', 150, 'The account the process runs as.', (process) => process.userName),
  priority: {
    label: () => 'Priority',
    width: 96,
    align: 'left',
    text: false,
    definition:
      "The process's base priority class, as Windows reports it. Change it from the right-click menu.",
    value: (process) => process.basePriority,
    // The System Idle Process reports 0, which is no priority class at all.
    render: own((process) =>
      process.basePriority === 0
        ? ''
        : (PRIORITY_NAMES[process.basePriority] ?? String(process.basePriority)),
    ),
  },
  started: {
    label: () => 'Started',
    width: 140,
    align: 'left',
    text: false,
    definition: 'When the process was created, in local time.',
    value: (process) => process.createTimeUnixMs,
    render: own(startedAt),
  },
  description: text(
    'Description',
    200,
    "The file description from the executable's version resource, which is what Explorer shows.",
    (process) => process.fileDescription,
  ),
  publisher: text(
    'Publisher',
    160,
    "The company named in the executable's version resource. Declared by the publisher, not verified.",
    (process) => process.companyName,
  ),
  architecture: text(
    'Architecture',
    92,
    'The processor architecture the process runs as. A 32-bit process on 64-bit Windows runs under WOW64.',
    (process) => process.architecture,
  ),
  session: {
    label: () => 'Session',
    width: 64,
    align: 'right',
    text: false,
    definition:
      'The Windows session. Session 0 is where services and Windows itself run; signed-in users get 1 and up.',
    value: (process) => process.sessionId,
    render: own((process) => process.sessionId),
  },
  workingSet: bytes(
    'Working set',
    96,
    'All physical memory the process has mapped, shared pages included, so it is never added up over a tree.',
    (process) => process.workingSetBytes,
  ),
  peakWorkingSet: bytes(
    'Peak WS',
    96,
    'The largest the working set has been since the process started.',
    (process) => process.peakWorkingSetBytes,
  ),
  pagedPool: bytes(
    'Paged pool',
    96,
    'Kernel paged pool charged to this process.',
    (process) => process.pagedPoolBytes,
  ),
  nonPagedPool: bytes(
    'NP pool',
    90,
    'Kernel non-paged pool charged to this process. It can never be paged out.',
    (process) => process.nonPagedPoolBytes,
  ),
  virtualSize: bytes(
    'Virtual size',
    104,
    'Address space the process has reserved. Mostly not backed by memory at all.',
    (process) => process.virtualSizeBytes,
  ),
  pageFaults: count(
    'Page faults',
    96,
    'Page faults since the process started, including soft faults satisfied from memory.',
    (process) => process.pageFaultCount,
  ),
  hardFaults: count(
    'Hard faults',
    90,
    'Page faults that needed a disk read. A rising count under memory pressure is thrashing.',
    (process) => process.hardFaultCount,
  ),
  path: text('Path', 280, 'The full path of the executable.', (process) => process.imagePath),
  commandLine: text(
    'Command line',
    320,
    'The command line the process was started with. Read only while this column is showing.',
    (process) => process.commandLine,
  ),
};

/** Whether a column sorts largest first when first chosen. */
export function sortsDescending(key: SortKey): boolean {
  return key !== 'name' && !COLUMN_SPECS[key].text;
}

/** Compare two values; unmeasured sorts last in either direction. */
function compareValues(left: Value, right: Value, direction: number): number {
  if (typeof left === 'string' || typeof right === 'string') {
    if (left === undefined) return 1;
    if (right === undefined) return -1;
    return String(left).localeCompare(String(right), undefined, { sensitivity: 'base' }) * direction;
  }
  if (left === undefined && right === undefined) return 0;
  if (left === undefined) return 1;
  if (right === undefined) return -1;
  return (left - right) * direction;
}

export function processComparator(
  key: SortKey,
  descending: boolean,
  cpuMode: CpuMode,
): (a: ProcessSnapshot, b: ProcessSnapshot) => number {
  const direction = descending ? -1 : 1;
  const read = (process: ProcessSnapshot): Value =>
    key === 'name' ? process.name : COLUMN_SPECS[key].value(process, cpuMode);
  return (a, b) => compareValues(read(a), read(b), direction);
}

export function nodeComparator(
  key: SortKey,
  descending: boolean,
  cpuMode: CpuMode,
): (a: ProcessTreeNode, b: ProcessTreeNode) => number {
  const direction = descending ? -1 : 1;
  const read = (node: ProcessTreeNode): Value => {
    if (key === 'name') return node.process.name;
    const spec = COLUMN_SPECS[key];
    return spec.nodeValue ? spec.nodeValue(node, cpuMode) : spec.value(node.process, cpuMode);
  };
  return (a, b) => compareValues(read(a), read(b), direction);
}

/** One cell. Text cells truncate, with the whole value on hover. */
export function Cell({
  id,
  row,
  cpuMode,
}: {
  id: ProcessColumnId;
  row: Row;
  cpuMode: CpuMode;
}): React.JSX.Element {
  const spec = COLUMN_SPECS[id];
  const content = spec.render(row, cpuMode);
  const emphasis = spec.emphasis?.(row, cpuMode) ?? false;
  return (
    <div
      style={{ width: spec.width }}
      title={spec.text && typeof content === 'string' ? content : undefined}
      className={`tnum shrink-0 truncate px-2 ${spec.align === 'right' ? 'text-right' : 'text-left'} ${
        emphasis ? 'text-text-primary' : 'text-text-secondary'
      }`}
    >
      {content}
    </div>
  );
}
