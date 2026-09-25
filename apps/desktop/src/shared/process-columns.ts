/**
 * The columns the Processes page can show, as main and renderer both need
 * them: main to build the column menu and keep the choice in settings, the
 * renderer to draw them. How each column renders lives with the page.
 *
 * Every column shows something the collector already measures; choosing one
 * adds no collection cost, except Command line, which turns on reading
 * command lines (one extra query per new process).
 */

export const PROCESS_COLUMNS = [
  { id: 'pid', label: 'PID' },
  { id: 'cpu', label: 'CPU' },
  { id: 'memory', label: 'Memory' },
  { id: 'commit', label: 'Commit' },
  { id: 'threads', label: 'Threads' },
  { id: 'handles', label: 'Handles' },
  { id: 'gpu', label: 'GPU' },
  { id: 'gpuMemory', label: 'GPU memory' },
  { id: 'ioRead', label: 'I/O read' },
  { id: 'ioWrite', label: 'I/O write' },
  { id: 'user', label: 'User' },
  { id: 'priority', label: 'Priority' },
  { id: 'started', label: 'Started' },
  { id: 'description', label: 'Description' },
  { id: 'publisher', label: 'Publisher' },
  { id: 'architecture', label: 'Architecture' },
  { id: 'session', label: 'Session' },
  { id: 'workingSet', label: 'Working set' },
  { id: 'peakWorkingSet', label: 'Peak working set' },
  { id: 'pagedPool', label: 'Paged pool' },
  { id: 'nonPagedPool', label: 'Non-paged pool' },
  { id: 'virtualSize', label: 'Virtual size' },
  { id: 'pageFaults', label: 'Page faults' },
  { id: 'hardFaults', label: 'Hard faults' },
  { id: 'path', label: 'Path' },
  { id: 'commandLine', label: 'Command line' },
] as const;

/** A column that can be shown or hidden. Name is always shown. */
export type ProcessColumnId = (typeof PROCESS_COLUMNS)[number]['id'];

/** What the page showed before columns could be chosen. */
export const DEFAULT_PROCESS_COLUMNS: readonly ProcessColumnId[] = [
  'pid',
  'cpu',
  'memory',
  'commit',
  'threads',
  'handles',
  'gpu',
  'gpuMemory',
  'ioRead',
  'ioWrite',
];

const KNOWN = new Set<string>(PROCESS_COLUMNS.map((column) => column.id));

/**
 * Accept a column choice from a renderer or a settings file, or fall back to
 * the defaults. Unknown columns are dropped, and the result is in the order
 * the page lays columns out, whatever order they arrived in.
 */
export function normaliseProcessColumns(value: unknown): ProcessColumnId[] {
  if (!Array.isArray(value)) return [...DEFAULT_PROCESS_COLUMNS];
  const wanted = new Set(value.filter((id): id is string => typeof id === 'string' && KNOWN.has(id)));
  return PROCESS_COLUMNS.map((column) => column.id).filter((id) => wanted.has(id));
}
