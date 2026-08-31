import type {
  HistoryResult,
  HostInfo,
  ProcessSnapshot,
  SystemSnapshot,
} from '@task-manager/telemetry-types';
import { groupIntoApplications } from './applications.js';
import {
  formatBytes,
  formatBytesPerSecond,
  formatCount,
  formatFrequency,
  formatMilliseconds,
  formatPercent,
} from './format.js';

/**
 * Building an export of what the collector measured.
 *
 * # Who this is for
 *
 * The intended reader is a language model being asked to analyse the data, so
 * the governing constraint is not compactness or prettiness — it is that a
 * reader with no access to this application can tell what every number means.
 *
 * A bare `cpu: 95` is worse than useless to an analyst: on this machine that
 * could be time utilization (0..100, frequency-independent) or processor
 * utility (which legitimately exceeds 100 on a boosting CPU), and the two
 * differ by a factor of 1.6 here. So **every column carries its own definition
 * and unit**, stated once, and every export opens with a preamble saying what
 * was measured and over what interval.
 *
 * # Nothing is invented to fill a gap
 *
 * The same rule the rest of the application follows applies to what leaves it.
 * A value the collector did not measure is exported as `null`, never as zero,
 * and a section with no data says so rather than being quietly dropped. Where a
 * table is capped, the cap and the ordering are stated in the output, so a
 * reader can never mistake a truncated list for a complete one.
 *
 * # Shape
 *
 * Everything reduces to two block types — `facts` (a labelled key/value list)
 * and `table` (columns plus rows). Two renderers consume that model: JSON for
 * completeness and machine parsing, Markdown for pasting into a conversation.
 * Tables are `columns` + `rows` rather than an array of objects because a
 * thousand-process export repeats its keys a thousand times otherwise, which is
 * roughly three times the tokens for no extra information.
 */

/** Which parts of the machine an export covers. */
export type ExportSectionId =
  | 'host'
  | 'cpu'
  | 'memory'
  | 'processes'
  | 'applications'
  | 'disk'
  | 'network'
  | 'gpu'
  | 'thermal'
  | 'diagnostics'
  | 'history';

/** How a value should be rendered for a human. JSON always emits it raw. */
export type ExportValueFormat =
  | 'text'
  /**
   * A number that identifies something rather than counting it: a PID, a
   * processor index, a session id. Rendered raw, because a thousands separator
   * in an identifier is both wrong and impossible to paste back anywhere.
   */
  | 'identifier'
  | 'count'
  | 'bytes'
  | 'bytesPerSecond'
  | 'percent'
  | 'milliseconds'
  | 'megahertz'
  | 'celsius'
  | 'timestamp'
  | 'boolean';

export type ExportValue = string | number | boolean | null;

export interface ExportColumn {
  key: string;
  label: string;
  /** What the number means and which Windows source produced it. */
  definition: string;
  unit?: string;
  format: ExportValueFormat;
}

export interface ExportFact {
  key: string;
  label: string;
  value: ExportValue;
  definition: string;
  unit?: string;
  format: ExportValueFormat;
}

export interface ExportFactsBlock {
  kind: 'facts';
  id: string;
  title: string;
  description: string;
  facts: ExportFact[];
}

export interface ExportTableBlock {
  kind: 'table';
  id: string;
  title: string;
  description: string;
  columns: ExportColumn[];
  rows: ExportValue[][];
  /**
   * Present when rows were capped. Stated in the output rather than left
   * implicit, so a reader cannot mistake a partial list for the whole machine.
   */
  truncated?: { shown: number; total: number; orderedBy: string };
}

/** A section that produced nothing, and the reason why. */
export interface ExportUnavailableBlock {
  kind: 'unavailable';
  id: string;
  title: string;
  /** Why there is no data. Always a real reason, never "no data". */
  reason: string;
}

export type ExportBlock = ExportFactsBlock | ExportTableBlock | ExportUnavailableBlock;

export interface ExportDocument {
  /** What this file is, addressed to whoever or whatever reads it. */
  preamble: string[];
  meta: ExportFactsBlock;
  blocks: ExportBlock[];
}

export interface ExportInput {
  snapshot: SystemSnapshot | null;
  host: HostInfo | null;
  /** Result of a history query, when history was requested and available. */
  history: HistoryResult | null;
  /** The span the history query asked for, for the preamble. */
  historySpanMs?: number;
  /** Wall clock at export time. */
  generatedAtUnixMs: number;
  appVersion?: string;
}

export interface ExportOptions {
  sections: readonly ExportSectionId[];
  /**
   * Cap on rows in the per-entity tables. 0 means no cap.
   *
   * A machine with a thousand processes produces an export too large to paste
   * into most conversations, and the tail is almost always idle processes. The
   * cap keeps the interesting rows and records that it did so.
   */
  maxRows: number;
}

export const EXPORT_SECTIONS: readonly {
  id: ExportSectionId;
  label: string;
  /** What the section contains, shown in the picker. */
  summary: string;
  /** True when this section can also be exported as a time series. */
  hasHistory: boolean;
}[] = [
  {
    id: 'host',
    label: 'Machine',
    summary: 'Operating system, CPU topology and installed memory. Context for everything else.',
    hasHistory: false,
  },
  {
    id: 'cpu',
    label: 'CPU',
    summary: 'Aggregate utilization by both definitions, plus every logical processor.',
    hasHistory: true,
  },
  {
    id: 'memory',
    label: 'Memory',
    summary: 'Physical and committed memory, pools, cache and page file.',
    hasHistory: true,
  },
  {
    id: 'processes',
    label: 'Processes',
    summary: 'One row per process: CPU, memory, I/O, threads, handles, identity.',
    hasHistory: false,
  },
  {
    id: 'applications',
    label: 'Applications',
    summary: 'Processes grouped into applications, with the signal that formed each group.',
    hasHistory: false,
  },
  {
    id: 'disk',
    label: 'Disk',
    summary: 'Per physical disk throughput, active time, latency and temperature.',
    hasHistory: true,
  },
  {
    id: 'network',
    label: 'Network',
    summary: 'Per adapter throughput, link speed, packet rates and discards.',
    hasHistory: true,
  },
  {
    id: 'gpu',
    label: 'GPU',
    summary: 'Per adapter utilisation, per-engine breakdown, video memory and temperature.',
    hasHistory: true,
  },
  {
    id: 'thermal',
    label: 'Temperature',
    summary: 'Every readable sensor, each named and attributed to its source.',
    hasHistory: false,
  },
  {
    id: 'diagnostics',
    label: 'Collector cost',
    summary: 'What this application spent to produce the snapshot, and any issues it hit.',
    hasHistory: false,
  },
];

/** Sections whose data is a single instant only, with the reason. */
export const SNAPSHOT_ONLY_REASONS: Partial<Record<ExportSectionId, string>> = {
  processes:
    'The history engine stores machine-wide series only. Per-process history is not collected, so there is nothing to export over time.',
  applications:
    'Applications are grouped from the live process list, and per-process history is not collected.',
  thermal:
    'Temperatures are not written to the history database, so only the current reading exists.',
  diagnostics: 'Collection costs are measured per snapshot and are not retained.',
  host: 'Machine identity and topology do not change while the application runs.',
};

// --- building ---------------------------------------------------------------

export function buildExportDocument(
  input: ExportInput,
  options: ExportOptions,
): ExportDocument {
  const wanted = new Set(options.sections);
  const blocks: ExportBlock[] = [];
  const { snapshot } = input;

  if (!snapshot) {
    return {
      preamble: preambleFor(input, options, []),
      meta: metaBlock(input, options),
      blocks: [
        {
          kind: 'unavailable',
          id: 'snapshot',
          title: 'Everything',
          reason:
            'No snapshot had been produced when the export ran. The collector may not have started, or the native module may have failed to load.',
        },
      ],
    };
  }

  if (wanted.has('host')) blocks.push(hostBlock(input.host, snapshot));
  if (wanted.has('cpu')) {
    blocks.push(cpuFacts(snapshot));
    blocks.push(cpuTable(snapshot));
  }
  if (wanted.has('memory')) blocks.push(memoryFacts(snapshot));
  if (wanted.has('processes')) blocks.push(processTable(snapshot, options.maxRows));
  if (wanted.has('applications')) blocks.push(applicationTable(snapshot, options.maxRows));
  if (wanted.has('disk')) blocks.push(diskTable(snapshot));
  if (wanted.has('network')) blocks.push(networkTable(snapshot));
  if (wanted.has('gpu')) blocks.push(gpuTable(snapshot));
  if (wanted.has('thermal')) blocks.push(thermalTable(snapshot));
  if (wanted.has('diagnostics')) blocks.push(diagnosticsFacts(snapshot));
  if (wanted.has('history')) blocks.push(historyTable(input));

  return {
    preamble: preambleFor(input, options, blocks),
    meta: metaBlock(input, options),
    blocks,
  };
}

function preambleFor(
  input: ExportInput,
  options: ExportOptions,
  blocks: readonly ExportBlock[],
): string[] {
  const lines = [
    'Resource telemetry exported from Task Manager, a Windows monitor that reads the operating system directly rather than through any abstraction.',
    'Every column below carries its own definition and unit. Read them before drawing conclusions: several metrics here have names that look interchangeable and are not. In particular, CPU "time utilization" and CPU "processor utility" are different measurements of the same processor and routinely differ by more than 50 percentage points on a machine that boosts above its base clock.',
    'A value of null means the collector did not measure it, not that it was zero. Nothing in this file is estimated, interpolated or filled in.',
  ];
  if (blocks.some((block) => block.kind === 'table')) {
    lines.push(
      'Tables are given as a `columns` list and a `rows` list of arrays: the nth entry of each row corresponds to the nth column. This keeps a large process list to a readable size.',
    );
  }
  if (options.maxRows > 0) {
    lines.push(
      `Per-entity tables are capped at ${options.maxRows} rows. Any table that was capped says so, along with what it was ordered by, so a truncated list is never mistaken for a complete one.`,
    );
  }
  if (input.history && input.history.available) {
    lines.push(
      'The history section is a time series of machine-wide metrics. Each point is the mean over its window, and the peak within that window is stored alongside it, because an average hides exactly the spike a forensic question is usually about.',
    );
  }
  return lines;
}

function metaBlock(input: ExportInput, options: ExportOptions): ExportFactsBlock {
  const { snapshot } = input;
  return {
    kind: 'facts',
    id: 'export',
    title: 'About this export',
    description: 'When it was taken and what produced it.',
    facts: [
      fact('generatedAtUnixMs', 'Generated at', input.generatedAtUnixMs, 'timestamp', {
        definition: 'Wall clock when the export was written, in milliseconds since the Unix epoch.',
      }),
      fact('appVersion', 'Application version', input.appVersion ?? null, 'text', {
        definition: 'Version of Task Manager that produced this file.',
      }),
      fact('snapshotSequence', 'Snapshot sequence', snapshot?.sequence ?? null, 'count', {
        definition: 'Index of the snapshot exported, counting from 0 at collector start.',
      }),
      fact('intervalMs', 'Measured interval', snapshot?.intervalMs ?? null, 'milliseconds', {
        definition:
          'Time since the previous snapshot, measured from a monotonic clock. Every per-second rate in this export was divided by this value, not by the configured interval. Absent on the very first snapshot, in which case all rates are absent too.',
      }),
      fact('sections', 'Sections included', options.sections.join(', '), 'text', {
        definition: 'Which parts of the machine this export covers.',
      }),
      fact('maxRows', 'Row cap', options.maxRows === 0 ? 'none' : options.maxRows, 'text', {
        definition: 'Maximum rows exported per per-entity table. Tables that hit it say so.',
      }),
    ],
  };
}

// --- sections ---------------------------------------------------------------

function hostBlock(host: HostInfo | null, snapshot: SystemSnapshot): ExportBlock {
  const topology = snapshot.cpu.topology;
  return {
    kind: 'facts',
    id: 'host',
    title: 'Machine',
    description:
      'Static facts about the machine, read once at startup. Context for interpreting everything else — a percentage means nothing without knowing how many logical processors it is a share of.',
    facts: [
      fact('computerName', 'Computer name', host?.computerName ?? null, 'text', {
        definition: 'NetBIOS name of the machine.',
      }),
      fact('osName', 'Operating system', host?.osName ?? null, 'text', {
        definition: 'Marketing name from the registry, corrected to Windows 11 by build number.',
      }),
      fact('osVersion', 'OS version', host?.osVersion ?? null, 'text', {
        definition: 'major.minor.build.',
      }),
      fact('osBuild', 'OS build', host?.osBuild ?? null, 'text', {
        definition: 'build.UBR, the display build.',
      }),
      fact('architecture', 'Architecture', host?.architecture ?? null, 'text', {
        definition: 'Processor architecture of the machine.',
      }),
      fact('isElevated', 'Running elevated', host?.isElevated ?? null, 'boolean', {
        definition:
          'Whether the collector had administrator rights. When false, image path, command line and owner are unavailable for other users’ and protected processes, and those fields will be null for them.',
      }),
      fact('bootTimeUnixMs', 'Booted at', host?.bootTimeUnixMs ?? null, 'timestamp', {
        definition: 'When the machine last started.',
      }),
      fact('uptimeMs', 'Uptime', snapshot.cpu.uptimeMs ?? null, 'milliseconds', {
        definition: 'Milliseconds since boot, from GetTickCount64.',
      }),
      fact('cpuBrand', 'Processor', topology.brandString ?? null, 'text', {
        definition: 'Processor brand string as the CPU reports it.',
      }),
      fact('packageCount', 'Packages', topology.packageCount ?? null, 'count', {
        definition: 'Physical processor packages (sockets).',
      }),
      fact('physicalCoreCount', 'Physical cores', topology.physicalCoreCount ?? null, 'count', {
        definition: 'Physical cores, from GetLogicalProcessorInformationEx.',
      }),
      fact('logicalProcessorCount', 'Logical processors', topology.logicalProcessorCount, 'count', {
        definition:
          'Logical processors. This is the denominator for every machine-share percentage in this export: one fully saturated logical processor is 100 divided by this number.',
      }),
      fact('processorGroupCount', 'Processor groups', topology.processorGroupCount ?? null, 'count', {
        definition: 'Windows processor groups. More than one appears above 64 logical processors.',
      }),
      fact('isHybrid', 'Hybrid cores', topology.isHybrid ?? null, 'boolean', {
        definition:
          'True when Windows reports more than one core efficiency class, i.e. performance and efficiency cores. Reported by Windows, never inferred from core counts.',
      }),
      fact('baseFrequencyMhz', 'Base frequency', topology.baseFrequencyMhz ?? null, 'megahertz', {
        definition:
          'Nominal base clock. Processor utility is expressed relative to this, which is why it can exceed 100% when the processor boosts above it.',
      }),
      fact(
        'installedPhysicalBytes',
        'Installed memory',
        snapshot.memory.installedPhysicalBytes ?? null,
        'bytes',
        {
          definition:
            'Physically installed memory from GetPhysicallyInstalledSystemMemory. Larger than the memory usable by Windows, which excludes firmware reservations.',
        },
      ),
      fact('totalPhysicalBytes', 'Usable memory', snapshot.memory.totalPhysicalBytes, 'bytes', {
        definition: 'Memory usable by Windows. The denominator for memory utilization.',
      }),
    ],
  };
}

function cpuFacts(snapshot: SystemSnapshot): ExportFactsBlock {
  const cpu = snapshot.cpu;
  return {
    kind: 'facts',
    id: 'cpu',
    title: 'CPU',
    description:
      'Two different definitions of processor utilization, reported side by side because they answer different questions and neither is wrong. Time utilization asks what share of available processor time was not idle. Processor utility asks how much work was delivered relative to the base clock, so a processor boosting above base exceeds 100%.',
    facts: [
      fact(
        'aggregateTimeUtilizationPercent',
        'Time utilization',
        cpu.aggregateTimeUtilizationPercent ?? null,
        'percent',
        {
          definition:
            'Share of all logical processor time not spent idle, 0..100. Frequency-independent: a processor at half clock doing nothing but work still reads 100. From NtQuerySystemInformation(SystemProcessorPerformanceInformation).',
        },
      ),
      fact('processorUtilityPercent', 'Processor utility', cpu.processorUtilityPercent ?? null, 'percent', {
        definition:
          'The figure Windows Task Manager displays. Busy time weighted by delivered performance against the base clock, so it exceeds 100 on a boosting processor and is not capped here. PDH \\Processor Information(_Total)\\% Processor Utility.',
      }),
      fact(
        'processorPerformancePercent',
        'Processor performance',
        cpu.processorPerformancePercent ?? null,
        'percent',
        {
          definition:
            'Delivered performance as a percentage of base clock. 167 means the processor averaged 1.67x its base frequency. PDH \\Processor Information(_Total)\\% Processor Performance.',
        },
      ),
      fact('currentFrequencyMhz', 'Current frequency', cpu.currentFrequencyMhz ?? null, 'megahertz', {
        definition:
          'Base frequency multiplied by processor performance. A derivation, not a measurement — the same one Task Manager shows.',
      }),
      fact(
        'busiestLogicalProcessorPercent',
        'Busiest logical processor',
        cpu.busiestLogicalProcessorPercent ?? null,
        'percent',
        {
          definition:
            'Highest time utilization of any single logical processor. A single-threaded workload pins one processor at 100 while the aggregate stays low, and this is what reveals it.',
        },
      ),
      fact(
        'busiestLogicalProcessorIndex',
        'Busiest processor index',
        cpu.busiestLogicalProcessorIndex ?? null,
        'count',
        { definition: 'Which logical processor that was.' },
      ),
      fact(
        'averageLogicalProcessorPercent',
        'Average logical processor',
        cpu.averageLogicalProcessorPercent ?? null,
        'percent',
        { definition: 'Mean time utilization across logical processors.' },
      ),
      fact('aggregateDpcPercent', 'DPC time', cpu.aggregateDpcPercent ?? null, 'percent', {
        definition:
          'Share of processor time in deferred procedure calls. Windows charges this to no process, which is part of why per-process CPU sums to less than the aggregate.',
      }),
      fact('aggregateInterruptPercent', 'Interrupt time', cpu.aggregateInterruptPercent ?? null, 'percent', {
        definition: 'Share of processor time servicing hardware interrupts. Also charged to no process.',
      }),
      fact('processCount', 'Processes', cpu.processCount ?? null, 'count', {
        definition: 'Live processes.',
      }),
      fact('threadCount', 'Threads', cpu.threadCount ?? null, 'count', {
        definition: 'Live threads across all processes.',
      }),
      fact('handleCount', 'Handles', cpu.handleCount ?? null, 'count', {
        definition:
          'Open kernel handles across all processes. A steadily climbing total on an otherwise idle machine indicates a handle leak.',
      }),
    ],
  };
}

function cpuTable(snapshot: SystemSnapshot): ExportBlock {
  const processors = snapshot.cpu.perLogicalProcessor;
  if (processors.length === 0) {
    return {
      kind: 'unavailable',
      id: 'cpu.logicalProcessors',
      title: 'Logical processors',
      reason:
        'Per-processor utilization needs two samples to difference; the first snapshot after start has no predecessor.',
    };
  }
  const columns: ExportColumn[] = [
    col('index', 'Index', 'identifier', 'Logical processor index, flat across processor groups.'),
    col('group', 'Group', 'identifier', 'Windows processor group this processor belongs to.'),
    col(
      'efficiencyClass',
      'Efficiency class',
      'identifier',
      'Windows core efficiency class. Higher is the more performant core type on a hybrid processor. Null when the machine is not hybrid.',
    ),
    col('timeUtilizationPercent', 'Utilization', 'percent', 'Share of this processor’s time not idle, 0..100. Says nothing about the clock speed while it was busy.', '%'),
    col('userPercent', 'User', 'percent', 'Share spent in user mode.', '%'),
    col('kernelPercent', 'Kernel', 'percent', 'Share spent in kernel mode, excluding idle.', '%'),
    col('dpcPercent', 'DPC', 'percent', 'Share spent in deferred procedure calls.', '%'),
    col('interruptPercent', 'Interrupt', 'percent', 'Share spent servicing interrupts.', '%'),
    col(
      'currentFrequencyMhz',
      'Frequency',
      'megahertz',
      'CurrentMhz from CallNtPowerInformation. Windows reports this only for the calling thread’s processor group, so processors in other groups are null rather than filled in with group 0 values. On many modern parts it simply mirrors the nominal frequency; the machine-wide currentFrequencyMhz is the better estimate.',
      'MHz',
    ),
  ];
  return {
    kind: 'table',
    id: 'cpu.logicalProcessors',
    title: 'Logical processors',
    description:
      'One row per logical processor. Comparing these against the aggregate is how a single-threaded bottleneck becomes visible.',
    columns,
    rows: processors.map((p) => [
      p.index,
      p.group,
      p.efficiencyClass ?? null,
      p.timeUtilizationPercent,
      p.userPercent,
      p.kernelPercent,
      p.dpcPercent,
      p.interruptPercent,
      p.currentFrequencyMhz ?? null,
    ]),
  };
}

function memoryFacts(snapshot: SystemSnapshot): ExportFactsBlock {
  const m = snapshot.memory;
  return {
    kind: 'facts',
    id: 'memory',
    title: 'Memory',
    description:
      'Physical memory and the commit charge, which are different things. Physical memory is what is resident in RAM; commit is what the system has promised to back, and can exceed RAM because the page file backs the rest.',
    facts: [
      fact('installedPhysicalBytes', 'Installed', m.installedPhysicalBytes ?? null, 'bytes', {
        definition: 'Physically installed, including memory firmware reserved from Windows.',
      }),
      fact('totalPhysicalBytes', 'Usable', m.totalPhysicalBytes, 'bytes', {
        definition: 'Usable by Windows. The denominator for utilization below.',
      }),
      fact('usedPhysicalBytes', 'In use', m.usedPhysicalBytes, 'bytes', {
        definition: 'Usable minus available.',
      }),
      fact('availablePhysicalBytes', 'Available', m.availablePhysicalBytes, 'bytes', {
        definition:
          'Immediately available to a process without paging anything out: free plus standby. Standby is cached data that can be discarded, which is why available exceeds free.',
      }),
      fact('physicalUtilizationPercent', 'Utilization', m.physicalUtilizationPercent, 'percent', {
        definition: 'In use as a percentage of usable.',
      }),
      fact('committedBytes', 'Committed', m.committedBytes ?? null, 'bytes', {
        definition:
          'Total commit charge: memory the system has promised to back with RAM or page file. Can legitimately exceed installed memory.',
      }),
      fact('commitLimitBytes', 'Commit limit', m.commitLimitBytes ?? null, 'bytes', {
        definition: 'RAM plus current page file size. Allocations fail when commit reaches this.',
      }),
      fact('commitPeakBytes', 'Commit peak', m.commitPeakBytes ?? null, 'bytes', {
        definition: 'Highest commit charge since boot.',
      }),
      fact('cachedBytes', 'Cached', m.cachedBytes ?? null, 'bytes', {
        definition: 'Standby plus modified: file data held in memory.',
      }),
      fact('standbyBytes', 'Standby', m.standbyBytes ?? null, 'bytes', {
        definition: 'Cached pages that can be reclaimed immediately.',
      }),
      fact('modifiedBytes', 'Modified', m.modifiedBytes ?? null, 'bytes', {
        definition: 'Cached pages that must be written to disk before reuse.',
      }),
      fact('freeBytes', 'Free', m.freeBytes ?? null, 'bytes', {
        definition: 'Pages holding nothing at all. Low free memory is normal and not a problem by itself.',
      }),
      fact('pagedPoolBytes', 'Paged pool', m.pagedPoolBytes ?? null, 'bytes', {
        definition: 'Kernel memory that may be paged out.',
      }),
      fact('nonPagedPoolBytes', 'Non-paged pool', m.nonPagedPoolBytes ?? null, 'bytes', {
        definition: 'Kernel memory that must stay resident. Growth here is a common driver leak signature.',
      }),
      fact('pageFileTotalBytes', 'Page file size', m.pageFileTotalBytes ?? null, 'bytes', {
        definition: 'Total page file across all volumes.',
      }),
      fact('pageFileUsedBytes', 'Page file in use', m.pageFileUsedBytes ?? null, 'bytes', {
        definition: 'Page file currently in use.',
      }),
    ],
  };
}

function processTable(snapshot: SystemSnapshot, maxRows: number): ExportBlock {
  const processes = snapshot.processes?.processes;
  if (!processes || processes.length === 0) {
    return {
      kind: 'unavailable',
      id: 'processes',
      title: 'Processes',
      reason:
        'The process list was not collected for this snapshot. It is gathered only while a view that shows it is open, because enumerating a thousand processes costs about 35 ms per sample against under 2 ms without.',
    };
  }
  // Busiest first: a capped list should keep the rows anyone would ask about.
  const ordered = [...processes].sort(
    (a, b) => (b.cpuMachinePercent ?? -1) - (a.cpuMachinePercent ?? -1),
  );
  const shown = maxRows > 0 ? ordered.slice(0, maxRows) : ordered;

  const columns: ExportColumn[] = [
    col('pid', 'PID', 'identifier', 'Process id. Windows reuses these, so it is not a stable identity.'),
    col(
      'isIdleProcess',
      'Is the idle process',
      'boolean',
      'True only for PID 0, the System Idle Process. READ THIS BEFORE RANKING BY CPU: it is not a program, and its CPU time is the time each logical processor spent doing nothing. Its percentage is idle capacity, not work, and it and the aggregate CPU utilization add up to roughly 100. It is included because excluding it would stop the CPU column summing to 100, but it must never be reported as a consumer of anything.',
    ),
    col(
      'key',
      'Identity',
      'text',
      'pid:createTime100ns. The only identity safe across samples, because a reused PID produces a different key.',
    ),
    col(
      'name',
      'Name',
      'text',
      'Executable file name, e.g. chrome.exe. Not a window title, and not unique — many unrelated processes share one, which is why identity is keyed separately.',
    ),
    col('userName', 'User', 'text', 'Owner as DOMAIN\\User. Null when the process could not be opened.'),
    col(
      'cpuMachinePercent',
      'CPU (machine)',
      'percent',
      'Share of total machine capacity, 0..100. These sum to approximately the aggregate CPU utilization. On this machine one fully saturated logical processor is 100 divided by the logical processor count.',
      '%',
    ),
    col(
      'cpuCoreEquivalentPercent',
      'CPU (core-equivalent)',
      'percent',
      'The same measurement with one saturated logical processor as 100. Exceeds 100 for a multi-threaded process.',
      '%',
    ),
    col(
      'privateWorkingSetBytes',
      'Private working set',
      'bytes',
      'Physical memory private to this process. What Task Manager’s Memory column is derived from.',
    ),
    col('workingSetBytes', 'Working set', 'bytes', 'Physical memory mapped, shared pages included.'),
    col('privateCommitBytes', 'Commit', 'bytes', 'Private committed bytes. Task Manager’s Commit size.'),
    col('threadCount', 'Threads', 'count', 'Threads in this process.'),
    col(
      'handleCount',
      'Handles',
      'count',
      'Open kernel handles. A process climbing steadily here over minutes is leaking them.',
    ),
    col(
      'ioReadBytesPerSecond',
      'I/O read',
      'bytesPerSecond',
      'NOT disk throughput. Windows per-process I/O counters cover file, network, device and pipe I/O together, so a process streaming from a socket increases this without touching a disk. Real per-process disk attribution needs ETW and is not collected.',
    ),
    col('ioWriteBytesPerSecond', 'I/O write', 'bytesPerSecond', 'As above, for writes.'),
    col('hardFaultCount', 'Hard faults', 'count', 'Cumulative page faults that required a disk read.'),
    col(
      'gpuPercent',
      'GPU',
      'percent',
      'Maximum across engine types for this process, summed over adapters it used. Never a sum across engines, because they run concurrently.',
      '%',
    ),
    col('gpuDedicatedMemoryBytes', 'GPU memory', 'bytes', 'Dedicated video memory attributed to this process.'),
    col('sessionId', 'Session', 'identifier', 'Terminal services session.'),
    col('architecture', 'Architecture', 'text', 'Image architecture. Null when the process could not be opened.'),
    col('productName', 'Product', 'text', 'ProductName from the image version resource.'),
    col('companyName', 'Company', 'text', 'CompanyName from the image version resource.'),
    col('imagePath', 'Path', 'text', 'Full image path. Null when the process could not be opened.'),
    col(
      'detailFailure',
      'Detail failure',
      'text',
      'Why the handle-derived fields above are null: accessDenied, processExited, notSupported or pending. Null when they were read successfully.',
    ),
    col('createTimeUnixMs', 'Started at', 'timestamp', 'When the process started.'),
  ];

  return {
    kind: 'table',
    id: 'processes',
    title: 'Processes',
    description:
      'One row per live process, busiest first. THE FIRST ROW IS USUALLY THE SYSTEM IDLE PROCESS (PID 0), which is not a program: its CPU figure is idle capacity, not work, and it is flagged by the isIdleProcess column. Rank real consumers by excluding it. Per-process CPU sums to roughly 3-8% less than the aggregate CPU figure: about one point is DPC and interrupt time, which Windows charges to no process, and the remainder is a systematic difference between Windows’ per-thread and per-processor accounting. Neither figure is adjusted to make them agree.',
    columns,
    rows: shown.map((p: ProcessSnapshot) => [
      p.pid,
      p.pid === 0,
      p.key,
      p.name,
      p.userName ?? null,
      p.cpuMachinePercent ?? null,
      p.cpuCoreEquivalentPercent ?? null,
      p.privateWorkingSetBytes,
      p.workingSetBytes,
      p.privateCommitBytes,
      p.threadCount,
      p.handleCount,
      p.ioReadBytesPerSecond ?? null,
      p.ioWriteBytesPerSecond ?? null,
      p.hardFaultCount,
      p.gpuPercent ?? null,
      p.gpuDedicatedMemoryBytes ?? null,
      p.sessionId,
      p.architecture ?? null,
      p.productName ?? null,
      p.companyName ?? null,
      p.imagePath ?? null,
      p.detailFailure ?? null,
      p.createTimeUnixMs,
    ]),
    truncated:
      shown.length < ordered.length
        ? {
            shown: shown.length,
            total: ordered.length,
            orderedBy: 'cpuMachinePercent, descending',
          }
        : undefined,
  };
}

function applicationTable(snapshot: SystemSnapshot, maxRows: number): ExportBlock {
  const processes = snapshot.processes?.processes;
  if (!processes || processes.length === 0) {
    return {
      kind: 'unavailable',
      id: 'applications',
      title: 'Applications',
      reason:
        'Applications are grouped from the live process list, which was not collected for this snapshot.',
    };
  }
  const groups = groupIntoApplications(processes);
  const ordered = [...groups].sort(
    (a, b) => applicationCpu(b) - applicationCpu(a),
  );
  const shown = maxRows > 0 ? ordered.slice(0, maxRows) : ordered;

  return {
    kind: 'table',
    id: 'applications',
    title: 'Applications',
    description:
      'Processes grouped into applications using only signals Windows provides: package identity first, then the publisher and product declared in the executable’s version resource, then the executable path. The basis column says which signal formed each group, because a group formed by image name alone is much weaker evidence than one formed by package identity — that is why every inaccessible svchost.exe lands in one row.',
    columns: [
      col('name', 'Application', 'text', 'Display name for the group.'),
      col(
        'basis',
        'Grouping basis',
        'text',
        'Which signal formed the group: package identity, publisher and product, executable path, or image name alone. Weaker bases mean a less trustworthy grouping.',
      ),
      col('processCount', 'Processes', 'count', 'Processes in this group.'),
      col('cpuMachinePercent', 'CPU (machine)', 'percent', 'Summed share of total machine capacity.', '%'),
      col('privateWorkingSetBytes', 'Private working set', 'bytes', 'Summed private physical memory.'),
      col('threadCount', 'Threads', 'count', 'Summed threads.'),
      col('handleCount', 'Handles', 'count', 'Summed open handles.'),
    ],
    rows: shown.map((g) => [
      g.name,
      g.basis,
      g.processes.length,
      // Zero and "never measured" are different, and the aggregate stores both
      // as 0 with a flag. Exporting the flag's meaning rather than the zero.
      g.totals.hasCpuMeasurement ? g.totals.cpuMachinePercent : null,
      g.totals.privateWorkingSetBytes,
      g.totals.threadCount,
      g.totals.handleCount,
    ]),
    truncated:
      shown.length < ordered.length
        ? { shown: shown.length, total: ordered.length, orderedBy: 'cpuMachinePercent, descending' }
        : undefined,
  };
}

/** Sort key that keeps unmeasured groups below measured ones. */
function applicationCpu(group: { totals: { cpuMachinePercent: number; hasCpuMeasurement: boolean } }): number {
  return group.totals.hasCpuMeasurement ? group.totals.cpuMachinePercent : -1;
}

function diskTable(snapshot: SystemSnapshot): ExportBlock {
  const disks = snapshot.disks;
  if (disks.unavailable) {
    return {
      kind: 'unavailable',
      id: 'disk',
      title: 'Disk',
      reason: 'The PhysicalDisk performance counter set could not be registered on this machine.',
    };
  }
  const rows = [...disks.disks];
  if (disks.total) rows.push(disks.total);
  return {
    kind: 'table',
    id: 'disk',
    title: 'Disk',
    description:
      'One row per physical disk, from the PhysicalDisk counter set, which the kernel maintains per physical device. The _Total row is the aggregate Windows synthesises. Per-disk rather than per-volume, so a device carrying three partitions appears once rather than three times.',
    columns: [
      col('instance', 'Instance', 'text', 'Counter instance name: the disk number and the volumes on it.'),
      col('index', 'Disk number', 'identifier', 'Physical disk number. Null for the synthesised total.'),
      col('volumes', 'Volumes', 'text', 'Drive letters carried by this physical disk.'),
      col('readBytesPerSecond', 'Read', 'bytesPerSecond', 'Bytes read per second.'),
      col('writeBytesPerSecond', 'Write', 'bytesPerSecond', 'Bytes written per second.'),
      col(
        'activeTimePercent',
        'Active time',
        'percent',
        'Share of the interval with at least one request outstanding, derived as 100 minus % Idle Time. The same basis as Task Manager’s Active time. % Disk Time is deliberately not used: it misreports above one outstanding request.',
        '%',
      ),
      col('averageReadLatencyMs', 'Read latency', 'milliseconds', 'Mean milliseconds per read.'),
      col('averageWriteLatencyMs', 'Write latency', 'milliseconds', 'Mean milliseconds per write.'),
      col('queueLength', 'Queue', 'count', 'Requests outstanding at the end of the interval.'),
      col(
        'temperatureCelsius',
        'Temperature',
        'celsius',
        'The drive’s own sensor via IOCTL_STORAGE_QUERY_PROPERTY — for NVMe the controller composite temperature. Refreshed every 10 seconds. Null for devices that do not implement the property, and for the synthesised total, which is not a device.',
        '°C',
      ),
      col('temperatureSensor', 'Temperature sensor', 'text', 'The drive model that reported the temperature.'),
    ],
    rows: rows.map((d) => [
      d.instance,
      d.index ?? null,
      d.volumes.join(' '),
      d.readBytesPerSecond,
      d.writeBytesPerSecond,
      d.activeTimePercent ?? null,
      d.averageReadLatencyMs ?? null,
      d.averageWriteLatencyMs ?? null,
      d.queueLength ?? null,
      d.temperature?.celsius ?? null,
      d.temperature?.sensor ?? null,
    ]),
  };
}

function networkTable(snapshot: SystemSnapshot): ExportBlock {
  const network = snapshot.network;
  if (network.unavailable) {
    return {
      kind: 'unavailable',
      id: 'network',
      title: 'Network',
      reason: 'The Network Interface performance counter set could not be registered on this machine.',
    };
  }
  return {
    kind: 'table',
    id: 'network',
    title: 'Network',
    description:
      'One row per interface. Loopback is flagged and excluded from the machine totals, because local traffic routinely dwarfs real network use and would make a total meaningless.',
    columns: [
      col('name', 'Adapter', 'text', 'Adapter description as Windows publishes it.'),
      col('receivedBytesPerSecond', 'Down', 'bytesPerSecond', 'Bytes received per second.'),
      col('sentBytesPerSecond', 'Up', 'bytesPerSecond', 'Bytes sent per second.'),
      col('linkSpeedBitsPerSecond', 'Link speed', 'count', 'Negotiated link speed in bits per second. Null when the adapter is down.', 'bit/s'),
      col('receivedPacketsPerSecond', 'Packets in', 'count', 'Packets received per second.'),
      col('sentPacketsPerSecond', 'Packets out', 'count', 'Packets sent per second.'),
      col(
        'outboundDiscardsPerSecond',
        'Outbound discards',
        'count',
        'Outbound packets discarded because the queue was full. Non-zero here indicates a saturated or misbehaving adapter.',
      ),
      col('isLoopback', 'Loopback', 'boolean', 'True for the Windows loopback pseudo-interface.'),
    ],
    rows: network.interfaces.map((n) => [
      n.name,
      n.receivedBytesPerSecond,
      n.sentBytesPerSecond,
      n.linkSpeedBitsPerSecond ?? null,
      n.receivedPacketsPerSecond ?? null,
      n.sentPacketsPerSecond ?? null,
      n.outboundDiscardsPerSecond ?? null,
      n.isLoopback,
    ]),
  };
}

function gpuTable(snapshot: SystemSnapshot): ExportBlock {
  const gpu = snapshot.gpu;
  if (gpu.unavailable || gpu.adapters.length === 0) {
    return {
      kind: 'unavailable',
      id: 'gpu',
      title: 'GPU',
      reason: gpu.unavailable
        ? 'The GPU Engine performance counter sets could not be registered on this machine.'
        : 'No graphics adapters were reported.',
    };
  }
  return {
    kind: 'table',
    id: 'gpu',
    title: 'GPU',
    description:
      'One row per adapter. Utilisation is the MAXIMUM across engine types, never a sum: a GPU runs its 3D, compute, copy and video engines concurrently, so adding them would report well over 100% for a GPU nowhere near saturated. This is the rule Windows Task Manager applies. The per-engine breakdown is given so a video-decode-bound workload is still visible as such.',
    columns: [
      col('name', 'Adapter', 'text', 'Adapter description from DXGI. Null when DXGI could not enumerate it.'),
      col('luid', 'LUID', 'text', 'Locally unique id, matching the performance counter instance names.'),
      col('isSoftware', 'Software renderer', 'boolean', 'True for software renderers such as the Microsoft Basic Render Driver.'),
      col('utilisationPercent', 'Utilisation', 'percent', 'Maximum across engine types. Never a sum.', '%'),
      col('engines', 'Per-engine', 'text', 'Utilisation of each engine type, highest first.'),
      col('dedicatedMemoryUsedBytes', 'VRAM used', 'bytes', 'Dedicated video memory in use.'),
      col('dedicatedMemoryTotalBytes', 'VRAM total', 'bytes', 'Total dedicated video memory, from DXGI.'),
      col('sharedMemoryUsedBytes', 'Shared memory used', 'bytes', 'System memory the adapter is using.'),
      col(
        'temperatureCelsius',
        'Temperature',
        'celsius',
        'The GPU die sensor via NVIDIA NVML, refreshed once a second. Null for AMD and Intel adapters, which publish no temperature through any Windows API or counter set, and for two identical NVIDIA boards, where the adapter cannot be matched unambiguously.',
        '°C',
      ),
      col('temperatureWarningCelsius', 'Throttle threshold', 'celsius', 'Temperature at which the vendor driver begins throttling.', '°C'),
    ],
    rows: gpu.adapters.map((a) => [
      a.name ?? null,
      a.luid,
      a.isSoftware,
      a.utilisationPercent ?? null,
      a.engines.map((e) => `${e.label} ${e.utilisationPercent.toFixed(1)}%`).join(', ') || null,
      a.dedicatedMemoryUsedBytes ?? null,
      a.dedicatedMemoryTotalBytes ?? null,
      a.sharedMemoryUsedBytes ?? null,
      a.temperature?.celsius ?? null,
      a.temperature?.warningCelsius ?? null,
    ]),
  };
}

function thermalTable(snapshot: SystemSnapshot): ExportBlock {
  const thermal = snapshot.thermal;
  const rows: ExportValue[][] = [];
  for (const zone of thermal.zones) {
    rows.push([
      zone.instance,
      'acpiThermalZone',
      zone.celsius,
      null,
      null,
      0,
      'An ACPI thermal zone declared by the system firmware. ACPI records no physical attachment for a zone, so this is NOT a CPU temperature. On the development machine this zone had a passive trip point of 124 C and a critical trip point of 125 C with no fan trip points, which is not how firmware guards a processor die.',
    ]);
  }
  for (const gpu of thermal.gpus) {
    rows.push([
      gpu.sensor,
      gpu.source,
      gpu.celsius,
      gpu.warningCelsius ?? null,
      gpu.criticalCelsius ?? null,
      gpu.measuredAgoMs,
      'The GPU die sensor, reported by NVIDIA NVML. The vendor states what it measures.',
    ]);
  }
  for (const drive of thermal.drives) {
    rows.push([
      drive.sensor,
      drive.source,
      drive.celsius,
      drive.warningCelsius ?? null,
      drive.criticalCelsius ?? null,
      drive.measuredAgoMs,
      'The drive’s own SMART/health sensor. The device states what it measures.',
    ]);
  }
  if (rows.length === 0) {
    return {
      kind: 'unavailable',
      id: 'thermal',
      title: 'Temperature',
      reason:
        'No readable temperature sensor was found. Windows exposes only three to an unelevated process — ACPI thermal zones, NVIDIA NVML and the storage device property — and this machine published none of them.',
    };
  }
  return {
    kind: 'table',
    id: 'thermal',
    title: 'Temperature',
    description:
      'Every temperature readable without administrator rights, each under the name of the sensor that produced it. There is NO CPU package temperature here and none is available: reaching one requires an MSR read through a signed kernel-mode driver. There is no memory temperature either — module sensors sit behind the SMBus with no Windows API in front of them. Neither is approximated from anything else.',
    columns: [
      col('sensor', 'Sensor', 'text', 'Exactly what reported the value. Never a category such as "CPU".'),
      col(
        'source',
        'Source',
        'text',
        'acpiThermalZone, nvml or storageDevice. The source is what says how much the reading can be trusted.',
      ),
      col('celsius', 'Temperature', 'celsius', 'Degrees Celsius.', '°C'),
      col('warningCelsius', 'Warning threshold', 'celsius', 'Where the vendor says throttling begins, when published.', '°C'),
      col('criticalCelsius', 'Critical threshold', 'celsius', 'Where the vendor says the device is in danger, when published.', '°C'),
      col(
        'measuredAgoMs',
        'Age',
        'milliseconds',
        'How long ago the value was measured. Zone counters are read every sample; GPUs every second; drives every ten seconds, because each query is a device round-trip.',
      ),
      col('interpretation', 'What it is', 'text', 'What this sensor does and does not measure.'),
    ],
    rows,
  };
}

function diagnosticsFacts(snapshot: SystemSnapshot): ExportFactsBlock {
  const d = snapshot.diagnostics;
  return {
    kind: 'facts',
    id: 'diagnostics',
    title: 'Collector cost',
    description:
      'What this application spent to produce the snapshot. A resource monitor that cannot account for its own cost is not trustworthy, so it measures itself and appears in its own process list like anything else.',
    facts: [
      fact('totalDurationMs', 'Total', d.totalDurationMs, 'milliseconds', {
        definition: 'Wall time inside the native collector for this snapshot.',
      }),
      fact('cpuDurationMs', 'CPU subsystem', d.cpuDurationMs, 'milliseconds', { definition: 'Time in the CPU collector.' }),
      fact('memoryDurationMs', 'Memory subsystem', d.memoryDurationMs, 'milliseconds', { definition: 'Time in the memory collector.' }),
      fact('processDurationMs', 'Process subsystem', d.processDurationMs, 'milliseconds', {
        definition: 'Time enumerating processes. Zero when no view needed the list.',
      }),
      fact('deviceDurationMs', 'Devices', d.deviceDurationMs, 'milliseconds', {
        definition: 'Disk, network, GPU and temperature together — they share one performance counter query.',
      }),
      fact('droppedSnapshots', 'Dropped snapshots', d.droppedSnapshots, 'count', {
        definition:
          'Snapshots discarded because the UI could not accept them in time. Dropping is deliberate: blocking the sampler would stretch the next interval and distort every rate derived from it.',
      }),
      fact('trackedProcessCount', 'Tracked identities', d.trackedProcessCount, 'count', {
        definition: 'Process identities the collector is holding state for. Should track the live process count.',
      }),
      fact(
        'issues',
        'Issues',
        d.issues.length === 0 ? 'none' : d.issues.map((i) => `${i.subsystem}/${i.code}: ${i.message}`).join(' | '),
        'text',
        { definition: 'Non-fatal problems encountered while producing this snapshot.' },
      ),
    ],
  };
}

function historyTable(input: ExportInput): ExportBlock {
  const history = input.history;
  if (!history || !history.available) {
    return {
      kind: 'unavailable',
      id: 'history',
      title: 'History',
      reason:
        'History recording is switched off, or the history database could not be opened. With it off nothing is written to disk at all, so there is no past to export.',
    };
  }
  if (history.points.length === 0) {
    return {
      kind: 'unavailable',
      id: 'history',
      title: 'History',
      reason:
        'History is enabled but no points fall inside the requested window. The application may not have been running for long enough to fill it.',
    };
  }
  const columns: ExportColumn[] = [
    col('timestampUnixMs', 'Time', 'timestamp', 'Start of the window this point covers.'),
    col('cpuTimePercent', 'CPU time utilization', 'percent', 'Mean share of processor time not idle over the window.', '%'),
    col('cpuTimePeakPercent', 'CPU peak', 'percent', 'Highest single sample within the window. A mean hides exactly the spike a forensic question is about.', '%'),
    col('cpuUtilityPercent', 'CPU processor utility', 'percent', 'Mean processor utility. Exceeds 100 on a boosting processor.', '%'),
    col('cpuBusiestPercent', 'Busiest processor', 'percent', 'Mean utilization of the busiest single logical processor.', '%'),
    col('memoryUsedBytes', 'Memory in use', 'bytes', 'Mean physical memory in use.'),
    col('memoryUsedPeakBytes', 'Memory peak', 'bytes', 'Highest physical memory in use within the window.'),
    col('memoryAvailableBytes', 'Memory available', 'bytes', 'Mean memory immediately available.'),
    col('memoryCommittedBytes', 'Committed', 'bytes', 'Mean commit charge.'),
    col('diskReadBytesPerSecond', 'Disk read', 'bytesPerSecond', 'Mean bytes read per second across all physical disks.'),
    col('diskWriteBytesPerSecond', 'Disk write', 'bytesPerSecond', 'Mean bytes written per second across all physical disks.'),
    col('diskTotalPeakBytesPerSecond', 'Disk peak', 'bytesPerSecond', 'Highest combined disk throughput within the window.'),
    col('diskActivePercent', 'Disk active', 'percent', 'Mean share of the window with a request outstanding.', '%'),
    col('networkDownBytesPerSecond', 'Network down', 'bytesPerSecond', 'Mean bytes received per second, loopback excluded.'),
    col('networkUpBytesPerSecond', 'Network up', 'bytesPerSecond', 'Mean bytes sent per second, loopback excluded.'),
    col('gpuPercent', 'GPU', 'percent', 'Mean utilisation of the busiest hardware adapter.', '%'),
    col('gpuMemoryBytes', 'GPU memory', 'bytes', 'Mean dedicated video memory in use.'),
    col('processCount', 'Processes', 'count', 'Mean live process count.'),
    col('threadCount', 'Threads', 'count', 'Mean live thread count.'),
    col('handleCount', 'Handles', 'count', 'Mean open handle count. A steady climb here across the window is a leak.'),
  ];
  const keys = columns.map((c) => c.key) as (keyof (typeof history.points)[number])[];
  return {
    kind: 'table',
    id: 'history',
    title: 'History',
    description: `Machine-wide metrics over time, ${history.points.length} points at ${describeResolution(history.resolutionMs)} resolution, answered from retention tier ${history.tier}. Each point is an exact mean over its window computed from every sample in it, not a mean of means. Per-process history is NOT collected and cannot be exported.`,
    columns,
    rows: history.points.map((point) =>
      keys.map((key) => {
        const value = point[key];
        return typeof value === 'number' ? value : null;
      }),
    ),
  };
}

function describeResolution(resolutionMs: number): string {
  if (resolutionMs <= 0) return 'one row per sample';
  if (resolutionMs < 60_000) return `${Math.round(resolutionMs / 1000)} second`;
  return `${Math.round(resolutionMs / 60_000)} minute`;
}

// --- helpers ----------------------------------------------------------------

function fact(
  key: string,
  label: string,
  value: ExportValue,
  format: ExportValueFormat,
  extra: { definition: string; unit?: string },
): ExportFact {
  return { key, label, value, format, definition: extra.definition, unit: extra.unit };
}

function col(
  key: string,
  label: string,
  format: ExportValueFormat,
  definition: string,
  unit?: string,
): ExportColumn {
  return { key, label, format, definition, unit };
}

// --- rendering --------------------------------------------------------------

/**
 * Render as JSON.
 *
 * Complete and exact: values are raw numbers, never formatted strings, so
 * anything reading this can compute with them. Definitions travel with the
 * columns rather than in a separate glossary, so a reader cannot see a number
 * without also seeing what it means.
 */
export function renderExportJson(document: ExportDocument): string {
  return JSON.stringify(
    {
      $comment: document.preamble,
      export: factsToObject(document.meta),
      sections: document.blocks.map((block) => {
        if (block.kind === 'unavailable') {
          return { id: block.id, title: block.title, available: false, reason: block.reason };
        }
        if (block.kind === 'facts') {
          return {
            id: block.id,
            title: block.title,
            description: block.description,
            available: true,
            definitions: Object.fromEntries(
              block.facts.map((f) => [f.key, unitSuffix(f.definition, f.unit)]),
            ),
            values: Object.fromEntries(block.facts.map((f) => [f.key, f.value])),
          };
        }
        return {
          id: block.id,
          title: block.title,
          description: block.description,
          available: true,
          truncated: block.truncated ?? null,
          columns: block.columns.map((c) => ({
            key: c.key,
            definition: unitSuffix(c.definition, c.unit),
          })),
          rows: block.rows,
        };
      }),
    },
    null,
    2,
  );
}

function factsToObject(block: ExportFactsBlock): Record<string, ExportValue> {
  return Object.fromEntries(block.facts.map((f) => [f.key, f.value]));
}

function unitSuffix(definition: string, unit?: string): string {
  return unit ? `${definition} Unit: ${unit}.` : definition;
}

/**
 * Render as Markdown.
 *
 * For pasting straight into a conversation. Values are formatted the way the
 * application shows them, and each block states its definitions before its
 * data, so the reader meets the meaning before the numbers.
 */
export function renderExportMarkdown(document: ExportDocument): string {
  const out: string[] = ['# Task Manager export', ''];
  for (const line of document.preamble) out.push(line, '');

  out.push('## About this export', '');
  out.push(...factsTable(document.meta));
  out.push('');

  for (const block of document.blocks) {
    out.push(`## ${block.title}`, '');
    if (block.kind === 'unavailable') {
      out.push(`_Not available._ ${block.reason}`, '');
      continue;
    }
    out.push(block.description, '');
    if (block.kind === 'facts') {
      out.push(...factsTable(block));
      out.push('');
      continue;
    }
    if (block.truncated) {
      out.push(
        `_Showing ${block.truncated.shown} of ${block.truncated.total} rows, ordered by ${block.truncated.orderedBy}._`,
        '',
      );
    }
    out.push('### Columns', '');
    out.push('| Column | Meaning |', '|---|---|');
    for (const column of block.columns) {
      out.push(`| \`${column.key}\` | ${escapeCell(unitSuffix(column.definition, column.unit))} |`);
    }
    out.push('');
    out.push('### Data', '');
    out.push(`| ${block.columns.map((c) => c.label).join(' | ')} |`);
    out.push(`|${block.columns.map(() => '---').join('|')}|`);
    for (const row of block.rows) {
      out.push(
        `| ${row
          .map((value, index) => escapeCell(formatValue(value, block.columns[index]?.format ?? 'text')))
          .join(' | ')} |`,
      );
    }
    out.push('');
  }
  return out.join('\n');
}

function factsTable(block: ExportFactsBlock): string[] {
  const out = ['| Metric | Value | Meaning |', '|---|---|---|'];
  for (const f of block.facts) {
    out.push(
      `| ${escapeCell(f.label)} | ${escapeCell(formatValue(f.value, f.format))} | ${escapeCell(
        unitSuffix(f.definition, f.unit),
      )} |`,
    );
  }
  return out;
}

/** Pipes and newlines would break a Markdown table row. */
function escapeCell(value: string): string {
  return value.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|');
}

export function formatValue(value: ExportValue, format: ExportValueFormat): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (typeof value === 'string') return value;
  switch (format) {
    case 'bytes':
      return formatBytes(value);
    case 'bytesPerSecond':
      return formatBytesPerSecond(value);
    case 'percent':
      return formatPercent(value, 2);
    case 'milliseconds':
      return formatMilliseconds(value, 2);
    case 'megahertz':
      return formatFrequency(value);
    case 'celsius':
      return `${value.toFixed(1)} °C`;
    case 'timestamp':
      return new Date(value).toISOString();
    case 'identifier':
      return String(value);
    case 'count':
      return formatCount(value);
    default:
      return String(value);
  }
}

/** A filename that sorts chronologically and says what it is. */
export function exportFileName(format: 'json' | 'markdown', atUnixMs: number): string {
  const stamp = new Date(atUnixMs).toISOString().replace(/[:.]/g, '-').replace('Z', '');
  return `task-manager-${stamp}.${format === 'json' ? 'json' : 'md'}`;
}
