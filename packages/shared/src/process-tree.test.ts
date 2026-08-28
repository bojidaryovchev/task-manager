import { describe, expect, it } from 'vitest';
import type { ProcessSnapshot } from '@task-manager/telemetry-types';
import {
  aggregateProcesses,
  buildProcessTree,
  flattenTree,
  type ProcessTreeNode,
} from './process-tree.js';

/** Minimal process with only the fields these tests care about. */
function proc(
  key: string,
  overrides: Partial<ProcessSnapshot> = {},
): ProcessSnapshot {
  const [pid] = key.split(':');
  return {
    key,
    pid: Number(pid),
    parentPid: 0,
    name: `p${pid}.exe`,
    createTime100ns: 0,
    createTimeUnixMs: 0,
    sessionId: 1,
    basePriority: 8,
    kernelTime100ns: 0,
    userTime100ns: 0,
    workingSetBytes: 0,
    privateWorkingSetBytes: 0,
    privateCommitBytes: 0,
    peakWorkingSetBytes: 0,
    pagedPoolBytes: 0,
    nonPagedPoolBytes: 0,
    virtualSizeBytes: 0,
    pageFaultCount: 0,
    hardFaultCount: 0,
    threadCount: 0,
    handleCount: 0,
    ioReadBytes: 0,
    ioWriteBytes: 0,
    ioOtherBytes: 0,
    ioReadOperations: 0,
    ioWriteOperations: 0,
    ioOtherOperations: 0,
    ...overrides,
  };
}

const byKey = (a: ProcessTreeNode, b: ProcessTreeNode) =>
  a.process.key.localeCompare(b.process.key);

describe('buildProcessTree', () => {
  it('nests children under their parent and reports depth', () => {
    const tree = buildProcessTree([
      proc('1:0'),
      proc('2:0', { parentKey: '1:0' }),
      proc('3:0', { parentKey: '2:0' }),
    ]);
    expect(tree).toHaveLength(1);
    expect(tree[0]?.process.key).toBe('1:0');
    expect(tree[0]?.depth).toBe(0);
    expect(tree[0]?.children[0]?.process.key).toBe('2:0');
    expect(tree[0]?.children[0]?.depth).toBe(1);
    expect(tree[0]?.children[0]?.children[0]?.depth).toBe(2);
  });

  it('treats a process with a missing parent as a root', () => {
    // Normal for services and for anything whose launcher already exited.
    const tree = buildProcessTree([proc('2:0', { parentKey: '99:0' })]);
    expect(tree).toHaveLength(1);
    expect(tree[0]?.process.key).toBe('2:0');
    expect(tree[0]?.depth).toBe(0);
  });

  it('treats a process with no parent link at all as a root', () => {
    const tree = buildProcessTree([proc('1:0'), proc('2:0')]);
    expect(tree).toHaveLength(2);
  });

  it('does not link a process to itself', () => {
    const tree = buildProcessTree([proc('1:0', { parentKey: '1:0' })]);
    expect(tree).toHaveLength(1);
    expect(tree[0]?.children).toHaveLength(0);
  });

  it('survives a cycle in malformed data instead of hanging', () => {
    // The collector cannot produce this - it only links a parent created before
    // its child - but the UI must not be hangable by bad data.
    const tree = buildProcessTree([
      proc('1:0', { parentKey: '2:0' }),
      proc('2:0', { parentKey: '1:0' }),
    ]);
    // Neither is a root by linkage, so both surface as roots rather than being
    // dropped from the list entirely.
    const keys = tree.map((n) => n.process.key).sort();
    expect(keys).toEqual(['1:0', '2:0']);
  });

  it('keeps a recycled PID separate from the original', () => {
    // Same PID, different creation time: two unrelated processes.
    const tree = buildProcessTree([
      proc('100:1000'),
      proc('100:2000'),
      proc('200:3000', { parentKey: '100:2000' }),
    ]);
    const roots = tree.map((n) => n.process.key).sort();
    expect(roots).toEqual(['100:1000', '100:2000']);
    const newer = tree.find((n) => n.process.key === '100:2000');
    expect(newer?.children).toHaveLength(1);
    const older = tree.find((n) => n.process.key === '100:1000');
    expect(older?.children).toHaveLength(0);
  });

  it('does not overflow the stack on a deep chain', () => {
    const processes = [proc('0:0')];
    for (let i = 1; i < 20_000; i += 1) {
      processes.push(proc(`${i}:0`, { parentKey: `${i - 1}:0` }));
    }
    const tree = buildProcessTree(processes);
    expect(tree).toHaveLength(1);
    expect(tree[0]?.subtotal.processCount).toBe(20_000);
  });
});

describe('subtree aggregation', () => {
  it('sums additive metrics over the whole subtree', () => {
    const tree = buildProcessTree([
      proc('1:0', { cpuMachinePercent: 1, privateWorkingSetBytes: 100, threadCount: 2 }),
      proc('2:0', {
        parentKey: '1:0',
        cpuMachinePercent: 2,
        privateWorkingSetBytes: 200,
        threadCount: 3,
      }),
      proc('3:0', {
        parentKey: '2:0',
        cpuMachinePercent: 4,
        privateWorkingSetBytes: 400,
        threadCount: 5,
      }),
    ]);
    const root = tree[0] as ProcessTreeNode;
    expect(root.subtotal.processCount).toBe(3);
    expect(root.subtotal.cpuMachinePercent).toBe(7);
    expect(root.subtotal.privateWorkingSetBytes).toBe(700);
    expect(root.subtotal.threadCount).toBe(10);
    // The middle node covers itself and its own child only.
    expect(root.children[0]?.subtotal.cpuMachinePercent).toBe(6);
  });

  it('treats an unmeasured CPU value as absent rather than as zero', () => {
    const totals = aggregateProcesses([proc('1:0'), proc('2:0')]);
    expect(totals.cpuMachinePercent).toBe(0);
    // Nothing had a measurement, so the sum is not a measurement either.
    expect(totals.hasCpuMeasurement).toBe(false);

    const mixed = aggregateProcesses([proc('1:0'), proc('2:0', { cpuMachinePercent: 3 })]);
    expect(mixed.cpuMachinePercent).toBe(3);
    expect(mixed.hasCpuMeasurement).toBe(true);
  });

  it('aggregates an empty list to zeroes with no measurement', () => {
    const totals = aggregateProcesses([]);
    expect(totals.processCount).toBe(0);
    expect(totals.hasCpuMeasurement).toBe(false);
  });
});

describe('flattenTree', () => {
  const tree = () =>
    buildProcessTree([
      proc('1:0'),
      proc('2:0', { parentKey: '1:0' }),
      proc('3:0', { parentKey: '1:0' }),
      proc('4:0', { parentKey: '2:0' }),
    ]);

  it('emits nodes in depth-first display order', () => {
    const rows = flattenTree(tree(), byKey, new Set());
    expect(rows.map((n) => n.process.key)).toEqual(['1:0', '2:0', '4:0', '3:0']);
  });

  it('hides the children of a collapsed node', () => {
    const rows = flattenTree(tree(), byKey, new Set(['2:0']));
    expect(rows.map((n) => n.process.key)).toEqual(['1:0', '2:0', '3:0']);
  });

  it('collapsing a root hides the whole subtree', () => {
    const rows = flattenTree(tree(), byKey, new Set(['1:0']));
    expect(rows.map((n) => n.process.key)).toEqual(['1:0']);
  });

  it('applies the comparator at every level', () => {
    const descending = (a: ProcessTreeNode, b: ProcessTreeNode) => byKey(b, a);
    const rows = flattenTree(tree(), descending, new Set());
    expect(rows.map((n) => n.process.key)).toEqual(['1:0', '3:0', '2:0', '4:0']);
  });
});
