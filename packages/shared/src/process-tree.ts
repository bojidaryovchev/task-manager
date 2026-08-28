import type { ProcessSnapshot } from '@task-manager/telemetry-types';

/**
 * Process tree construction and subtree aggregation.
 *
 * This lives in TypeScript rather than Rust on purpose. It computes no
 * telemetry: every value it touches was already measured and normalised by the
 * collector. What it does is arrange those values into a shape that depends on a
 * presentation choice - tree vs flat, which grouping - so it belongs with the
 * presentation. The rule it does respect is that there is exactly one
 * implementation, shared by every view that needs it.
 *
 * ## Which fields may be summed
 *
 * Not every metric is additive, and summing a non-additive one produces a
 * confident wrong answer:
 *
 * | Field | Additive | Why |
 * |---|---|---|
 * | `cpuMachinePercent` | yes | Shares of one common denominator, total machine capacity |
 * | `privateWorkingSetBytes` | yes | Private by definition, so no page is counted twice |
 * | `privateCommitBytes` | yes | Also private |
 * | `threadCount`, `handleCount` | yes | Counts of distinct objects |
 * | I/O rates | yes | Independent byte streams |
 * | `workingSetBytes` | **no** | Includes shared pages; summing double-counts them |
 * | `peakWorkingSetBytes` | **no** | A historical maximum, not a quantity |
 * | `virtualSizeBytes` | **no** | Reserved address space, meaningless summed |
 *
 * Only the additive fields are aggregated here. The rest stay per-process.
 */

/** One node in the process tree. */
export interface ProcessTreeNode {
  process: ProcessSnapshot;
  children: ProcessTreeNode[];
  /** How deep this node sits, with roots at 0. */
  depth: number;
  /** This process plus every descendant. */
  subtotal: ProcessAggregate;
}

/** Additive metrics summed over a set of processes. */
export interface ProcessAggregate {
  processCount: number;
  cpuMachinePercent: number;
  /** True when at least one member had a CPU measurement. */
  hasCpuMeasurement: boolean;
  privateWorkingSetBytes: number;
  privateCommitBytes: number;
  threadCount: number;
  handleCount: number;
  ioReadBytesPerSecond: number;
  ioWriteBytesPerSecond: number;
}

export function emptyAggregate(): ProcessAggregate {
  return {
    processCount: 0,
    cpuMachinePercent: 0,
    hasCpuMeasurement: false,
    privateWorkingSetBytes: 0,
    privateCommitBytes: 0,
    threadCount: 0,
    handleCount: 0,
    ioReadBytesPerSecond: 0,
    ioWriteBytesPerSecond: 0,
  };
}

/** Add one process's additive metrics into an aggregate, in place. */
export function addProcess(into: ProcessAggregate, process: ProcessSnapshot): ProcessAggregate {
  into.processCount += 1;
  if (process.cpuMachinePercent !== undefined) {
    into.cpuMachinePercent += process.cpuMachinePercent;
    into.hasCpuMeasurement = true;
  }
  into.privateWorkingSetBytes += process.privateWorkingSetBytes;
  into.privateCommitBytes += process.privateCommitBytes;
  into.threadCount += process.threadCount;
  into.handleCount += process.handleCount;
  into.ioReadBytesPerSecond += process.ioReadBytesPerSecond ?? 0;
  into.ioWriteBytesPerSecond += process.ioWriteBytesPerSecond ?? 0;
  return into;
}

/** Merge one aggregate into another, in place. */
export function addAggregate(into: ProcessAggregate, other: ProcessAggregate): ProcessAggregate {
  into.processCount += other.processCount;
  into.cpuMachinePercent += other.cpuMachinePercent;
  into.hasCpuMeasurement ||= other.hasCpuMeasurement;
  into.privateWorkingSetBytes += other.privateWorkingSetBytes;
  into.privateCommitBytes += other.privateCommitBytes;
  into.threadCount += other.threadCount;
  into.handleCount += other.handleCount;
  into.ioReadBytesPerSecond += other.ioReadBytesPerSecond;
  into.ioWriteBytesPerSecond += other.ioWriteBytesPerSecond;
  return into;
}

/** Sum the additive metrics of a flat list of processes. */
export function aggregateProcesses(processes: readonly ProcessSnapshot[]): ProcessAggregate {
  const total = emptyAggregate();
  for (const process of processes) addProcess(total, process);
  return total;
}

/**
 * Build a forest from `parentKey` links.
 *
 * A process whose parent is absent from this snapshot becomes a root, which is
 * the normal case for services and for anything whose launcher has exited.
 *
 * Cycles cannot occur through legitimate data - the collector only links a
 * parent that was created before its child - but a malformed snapshot must not
 * hang the UI, so the walk tracks visited keys and treats a repeat as a root.
 */
export function buildProcessTree(processes: readonly ProcessSnapshot[]): ProcessTreeNode[] {
  const nodes = new Map<string, ProcessTreeNode>();
  for (const process of processes) {
    // A duplicate key would mean two live processes shared a PID *and* a
    // creation time, which cannot happen; last one wins rather than throwing.
    nodes.set(process.key, {
      process,
      children: [],
      depth: 0,
      subtotal: emptyAggregate(),
    });
  }

  const roots: ProcessTreeNode[] = [];
  for (const node of nodes.values()) {
    const parentKey = node.process.parentKey;
    const parent = parentKey === undefined ? undefined : nodes.get(parentKey);
    if (parent === undefined || parent === node) {
      roots.push(node);
    } else {
      parent.children.push(node);
    }
  }

  // Depth and subtotals in one iterative post-order walk. Iterative rather than
  // recursive so a pathological chain cannot overflow the stack.
  const visited = new Set<ProcessTreeNode>();
  for (const root of roots) {
    const stack: Array<{ node: ProcessTreeNode; expanded: boolean }> = [
      { node: root, expanded: false },
    ];
    root.depth = 0;
    while (stack.length > 0) {
      const frame = stack.pop() as { node: ProcessTreeNode; expanded: boolean };
      const { node } = frame;
      if (!frame.expanded) {
        if (visited.has(node)) {
          // Already reached by another path: malformed data. Do not descend
          // again, which is what stops a cycle from looping forever.
          continue;
        }
        visited.add(node);
        stack.push({ node, expanded: true });
        for (const child of node.children) {
          child.depth = node.depth + 1;
          stack.push({ node: child, expanded: false });
        }
      } else {
        const subtotal = emptyAggregate();
        addProcess(subtotal, node.process);
        for (const child of node.children) addAggregate(subtotal, child.subtotal);
        node.subtotal = subtotal;
      }
    }
  }

  // Any node never reached from a root belongs to a cycle; surface it as a root
  // rather than silently dropping it from the list.
  for (const node of nodes.values()) {
    if (!visited.has(node)) {
      node.depth = 0;
      const subtotal = emptyAggregate();
      addProcess(subtotal, node.process);
      node.subtotal = subtotal;
      roots.push(node);
      visited.add(node);
    }
  }

  return roots;
}

/**
 * Flatten a forest into display order, honouring which nodes are collapsed.
 *
 * `compare` orders siblings at every level. `collapsed` holds the keys whose
 * children are hidden.
 */
export function flattenTree(
  roots: readonly ProcessTreeNode[],
  compare: (a: ProcessTreeNode, b: ProcessTreeNode) => number,
  collapsed: ReadonlySet<string>,
): ProcessTreeNode[] {
  const out: ProcessTreeNode[] = [];
  const walk = (nodes: readonly ProcessTreeNode[]): void => {
    const ordered = [...nodes].sort(compare);
    for (const node of ordered) {
      out.push(node);
      if (node.children.length > 0 && !collapsed.has(node.process.key)) {
        walk(node.children);
      }
    }
  };
  walk(roots);
  return out;
}
