import type { HistoryResult, HostInfo, SystemSnapshot } from '@task-manager/telemetry-types';
import { describe, expect, it } from 'vitest';
import {
  buildExportDocument,
  exportFileName,
  formatValue,
  renderExportJson,
  renderExportMarkdown,
  type ExportSectionId,
} from './export.js';

/**
 * What an export must guarantee.
 *
 * The reader is an analyst — usually a language model — with no access to this
 * application and no way to ask a follow-up question. Everything it concludes
 * rests on the file alone, so the properties tested here are the ones that stop
 * it concluding something false: every number carries its definition, an
 * unmeasured value stays null rather than becoming zero, a truncated list says
 * it was truncated, and a missing section explains itself instead of vanishing.
 */

function process(overrides: Record<string, unknown> = {}) {
  return {
    key: '100:130000000000000000',
    pid: 100,
    parentPid: 4,
    name: 'chrome.exe',
    createTime100ns: 130000000000000000,
    createTimeUnixMs: 1_700_000_000_000,
    sessionId: 1,
    basePriority: 8,
    kernelTime100ns: 0,
    userTime100ns: 0,
    workingSetBytes: 200_000_000,
    privateWorkingSetBytes: 150_000_000,
    privateCommitBytes: 180_000_000,
    peakWorkingSetBytes: 210_000_000,
    pagedPoolBytes: 0,
    nonPagedPoolBytes: 0,
    virtualSizeBytes: 0,
    pageFaultCount: 0,
    hardFaultCount: 0,
    threadCount: 40,
    handleCount: 900,
    ioReadBytes: 0,
    ioWriteBytes: 0,
    ioOtherBytes: 0,
    ioReadOperations: 0,
    ioWriteOperations: 0,
    ioOtherOperations: 0,
    ...overrides,
  };
}

function snapshot(overrides: Record<string, unknown> = {}): SystemSnapshot {
  return {
    sequence: 42,
    wallClockUnixMs: 1_700_000_000_000,
    monotonicMs: 21_000,
    intervalMs: 500,
    cpu: {
      aggregateTimeUtilizationPercent: 12.5,
      processorUtilityPercent: 21.3,
      perLogicalProcessor: [
        {
          index: 0,
          group: 0,
          numberInGroup: 0,
          timeUtilizationPercent: 30,
          dpcPercent: 1,
          interruptPercent: 0.5,
          kernelPercent: 10,
          userPercent: 20,
        },
      ],
      topology: { logicalProcessorCount: 24, brandString: 'Test CPU' },
    },
    memory: {
      totalPhysicalBytes: 16_000_000_000,
      availablePhysicalBytes: 6_000_000_000,
      usedPhysicalBytes: 10_000_000_000,
      physicalUtilizationPercent: 62.5,
      memoryLoadPercent: 62,
      pageSizeBytes: 4096,
    },
    disks: { disks: [], unavailable: false },
    network: { interfaces: [], receivedBytesPerSecond: 0, sentBytesPerSecond: 0, unavailable: false },
    gpu: { adapters: [], unavailable: false },
    thermal: { zones: [], gpus: [], drives: [], zonesUnavailable: false, nvmlUnavailable: false },
    diagnostics: {
      totalDurationMs: 3.2,
      cpuDurationMs: 0.2,
      memoryDurationMs: 0.1,
      processDurationMs: 2.5,
      deviceDurationMs: 0.4,
      issues: [],
      droppedSnapshots: 0,
      trackedProcessCount: 400,
    },
    ...overrides,
  } as unknown as SystemSnapshot;
}

const HOST = { computerName: 'TESTBOX', osVersion: '10.0.26200', architecture: 'x64' } as HostInfo;

function build(sections: ExportSectionId[], overrides: Record<string, unknown> = {}, maxRows = 0) {
  return buildExportDocument(
    {
      snapshot: snapshot(overrides),
      host: HOST,
      history: null,
      generatedAtUnixMs: 1_700_000_000_000,
      appVersion: '0.1.0',
    },
    { sections, maxRows },
  );
}

describe('every value carries its meaning', () => {
  it('gives every column a definition', () => {
    const doc = build(['cpu', 'memory', 'processes', 'disk', 'network', 'gpu', 'thermal'], {
      processes: { processes: [process()], totalCount: 1 },
    });
    for (const block of doc.blocks) {
      if (block.kind === 'table') {
        for (const column of block.columns) {
          expect(column.definition.length, `${block.id}.${column.key}`).toBeGreaterThan(20);
        }
      }
      if (block.kind === 'facts') {
        for (const f of block.facts) {
          expect(f.definition.length, `${block.id}.${f.key}`).toBeGreaterThan(10);
        }
      }
    }
  });

  it('warns the reader that the two CPU metrics are not interchangeable', () => {
    // The single most likely misreading: 12.5% and 21.3% are the same processor.
    const markdown = renderExportMarkdown(build(['cpu']));
    expect(markdown).toContain('time utilization');
    expect(markdown).toContain('processor utility');
    expect(markdown).toMatch(/exceeds? 100/i);
  });

  it('states that a null is unmeasured rather than zero', () => {
    const json = renderExportJson(build(['cpu']));
    expect(json).toContain('null means the collector did not measure it');
  });
});

describe('nothing is invented', () => {
  it('exports an unmeasured process CPU as null, not zero', () => {
    const doc = build(['processes'], {
      processes: { processes: [process({ cpuMachinePercent: undefined })], totalCount: 1 },
    });
    const table = doc.blocks.find((b) => b.id === 'processes');
    if (table?.kind !== 'table') throw new Error('expected a table');
    const cpuIndex = table.columns.findIndex((c) => c.key === 'cpuMachinePercent');
    expect(table.rows[0]![cpuIndex]).toBeNull();
  });

  it('flags the System Idle Process instead of letting it read as a consumer', () => {
    // PID 0 sorts to the top of a CPU-ordered list and its percentage is idle
    // capacity, not work. Dropping it would stop the CPU column summing to 100,
    // so it stays — but an analyst ranking consumers must not be misled by it.
    const doc = build(['processes'], {
      processes: {
        processes: [
          process({ pid: 0, name: 'System Idle Process', cpuMachinePercent: 80 }),
          process({ pid: 500, name: 'chrome.exe', cpuMachinePercent: 4 }),
        ],
        totalCount: 2,
      },
    });
    const table = doc.blocks.find((b) => b.id === 'processes');
    if (table?.kind !== 'table') throw new Error('expected a table');
    const flag = table.columns.findIndex((c) => c.key === 'isIdleProcess');
    expect(table.rows[0]![flag]).toBe(true);
    expect(table.rows[1]![flag]).toBe(false);
    expect(table.description).toContain('idle capacity, not work');
    expect(table.columns[flag]!.definition).toContain('never be reported as a consumer');
  });

  it('explains a missing section instead of dropping it', () => {
    // Process collection is off unless a view needs it, which is a normal state
    // and not an error — but silence would read as "no processes running".
    const doc = build(['processes']);
    const block = doc.blocks.find((b) => b.id === 'processes');
    expect(block?.kind).toBe('unavailable');
    if (block?.kind !== 'unavailable') throw new Error('expected unavailable');
    expect(block.reason).toContain('not collected');
  });

  it('says a disk section is missing because the counter set is absent', () => {
    const doc = build(['disk'], { disks: { disks: [], unavailable: true } });
    const block = doc.blocks.find((b) => b.id === 'disk');
    if (block?.kind !== 'unavailable') throw new Error('expected unavailable');
    expect(block.reason).toContain('PhysicalDisk');
  });

  it('reports no temperature rather than an invented one', () => {
    const block = build(['thermal']).blocks.find((b) => b.id === 'thermal');
    if (block?.kind !== 'unavailable') throw new Error('expected unavailable');
    expect(block.reason).toContain('unelevated');
  });

  it('never presents the ACPI zone as a CPU temperature', () => {
    const doc = build(['thermal'], {
      thermal: {
        zones: [{ instance: '\\_TZ.TZ01', celsius: 95, highPrecision: true }],
        gpus: [],
        drives: [],
        zonesUnavailable: false,
        nvmlUnavailable: false,
      },
    });
    const markdown = renderExportMarkdown(doc);
    expect(markdown).toContain('NOT a CPU temperature');
    expect(markdown).toContain('NO CPU package temperature');
  });
});

describe('truncation is always disclosed', () => {
  const many = {
    processes: {
      processes: [
        process({ pid: 1, cpuMachinePercent: 1 }),
        process({ pid: 2, cpuMachinePercent: 9 }),
        process({ pid: 3, cpuMachinePercent: 5 }),
      ],
      totalCount: 3,
    },
  };

  it('keeps the busiest rows and records what was cut', () => {
    const doc = build(['processes'], many, 2);
    const table = doc.blocks.find((b) => b.id === 'processes');
    if (table?.kind !== 'table') throw new Error('expected a table');
    expect(table.rows).toHaveLength(2);
    expect(table.rows[0]![0]).toBe(2); // busiest first
    expect(table.truncated).toEqual({ shown: 2, total: 3, orderedBy: 'cpuMachinePercent, descending' });
  });

  it('says so in both renderings', () => {
    const doc = build(['processes'], many, 2);
    expect(renderExportMarkdown(doc)).toContain('Showing 2 of 3 rows');
    expect(renderExportJson(doc)).toContain('"total": 3');
  });

  it('does not claim truncation when nothing was cut', () => {
    const doc = build(['processes'], many, 0);
    const table = doc.blocks.find((b) => b.id === 'processes');
    if (table?.kind !== 'table') throw new Error('expected a table');
    expect(table.truncated).toBeUndefined();
  });
});

describe('history', () => {
  const history: HistoryResult = {
    available: true,
    tier: 1,
    resolutionMs: 5000,
    points: [{ timestampUnixMs: 1_700_000_000_000, cpuTimePercent: 10, cpuTimePeakPercent: 44 }],
  };

  it('emits a row per point with the peak beside the mean', () => {
    const doc = buildExportDocument(
      { snapshot: snapshot(), host: HOST, history, generatedAtUnixMs: 0 },
      { sections: ['history'], maxRows: 0 },
    );
    const table = doc.blocks.find((b) => b.id === 'history');
    if (table?.kind !== 'table') throw new Error('expected a table');
    expect(table.rows).toHaveLength(1);
    const peak = table.columns.findIndex((c) => c.key === 'cpuTimePeakPercent');
    expect(table.rows[0]![peak]).toBe(44);
    expect(table.description).toContain('5 second resolution');
  });

  it('states that per-process history does not exist', () => {
    const doc = buildExportDocument(
      { snapshot: snapshot(), host: HOST, history, generatedAtUnixMs: 0 },
      { sections: ['history'], maxRows: 0 },
    );
    const table = doc.blocks.find((b) => b.id === 'history');
    if (table?.kind !== 'table') throw new Error('expected a table');
    expect(table.description).toContain('Per-process history is NOT collected');
  });

  it('explains an empty history rather than emitting an empty table', () => {
    const cases: [HistoryResult, string][] = [
      [{ ...history, available: false }, 'switched off'],
      [{ ...history, points: [] }, 'no points fall inside'],
    ];
    for (const [result, expected] of cases) {
      const doc = buildExportDocument(
        { snapshot: snapshot(), host: HOST, history: result, generatedAtUnixMs: 0 },
        { sections: ['history'], maxRows: 0 },
      );
      const block = doc.blocks.find((b) => b.id === 'history');
      if (block?.kind !== 'unavailable') throw new Error('expected unavailable');
      expect(block.reason).toContain(expected);
    }
  });
});

describe('rendering', () => {
  it('produces parseable JSON with raw numbers, not formatted strings', () => {
    // An analyst has to be able to compute with these.
    const parsed = JSON.parse(renderExportJson(build(['cpu', 'memory']))) as {
      sections: { id: string; values?: Record<string, unknown> }[];
    };
    const cpu = parsed.sections.find((s) => s.id === 'cpu');
    expect(cpu?.values?.aggregateTimeUtilizationPercent).toBe(12.5);
  });

  it('keeps a Markdown table intact when a value contains a pipe', () => {
    const doc = build(['processes'], {
      processes: { processes: [process({ name: 'a|b.exe' })], totalCount: 1 },
    });
    const dataLine = renderExportMarkdown(doc)
      .split('\n')
      .find((line) => line.includes('a\\|b.exe'));
    expect(dataLine).toBeDefined();
    // Escaped, so the row still has the column count the header promises.
    expect(dataLine).not.toContain('| a|b.exe |');
  });

  it('survives a snapshot that never arrived', () => {
    const doc = buildExportDocument(
      { snapshot: null, host: null, history: null, generatedAtUnixMs: 0 },
      { sections: ['cpu'], maxRows: 0 },
    );
    expect(doc.blocks[0]?.kind).toBe('unavailable');
    expect(() => renderExportMarkdown(doc)).not.toThrow();
    expect(() => JSON.parse(renderExportJson(doc))).not.toThrow();
  });

  it('formats an absent value as an em dash rather than as zero', () => {
    expect(formatValue(null, 'bytes')).toBe('—');
    expect(formatValue(0, 'bytes')).not.toBe('—');
  });

  it('renders an identifier without a thousands separator', () => {
    // A PID of 220,060 cannot be pasted back into anything, and reads as a
    // quantity rather than the identity it is.
    expect(formatValue(220060, 'identifier')).toBe('220060');
    expect(formatValue(220060, 'count')).toContain(',');
  });
});

describe('exportFileName', () => {
  it('sorts chronologically and names its format', () => {
    const name = exportFileName('json', Date.UTC(2026, 7, 28, 15, 4, 5));
    expect(name).toBe('task-manager-2026-08-28T15-04-05-000.json');
    expect(exportFileName('markdown', 0)).toMatch(/\.md$/);
  });

  it('avoids characters Windows forbids in a filename', () => {
    const name = exportFileName('json', Date.UTC(2026, 0, 2, 3, 4, 5));
    expect(name).not.toMatch(/[:*?"<>|]/);
  });
});
