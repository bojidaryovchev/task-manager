import type { ProcessSnapshot } from '@task-manager/telemetry-types';
import {
  formatBytes,
  formatBytesPerSecond,
  formatCount,
  formatDuration,
  formatPercent,
} from '@task-manager/shared';
import { Field } from './primitives.js';

const DETAIL_FAILURE_TEXT: Record<string, string> = {
  accessDenied:
    'Opening this process was denied. Path, command line, owner and architecture need rights this application does not have; running elevated would reveal them.',
  processExited: 'The process exited before its details could be read.',
  notSupported: 'Not a real process — the System Idle Process cannot be opened.',
  pending: 'Details are queued behind this interval’s resolution budget and will appear shortly.',
};

export function ProcessDetails({
  process,
  onClose,
}: {
  process: ProcessSnapshot;
  onClose: () => void;
}): React.JSX.Element {
  const failure = process.detailFailure;

  return (
    <aside className="flex w-96 shrink-0 flex-col overflow-hidden rounded-lg border border-border-subtle bg-surface-1">
      <div className="flex shrink-0 items-start justify-between gap-2 border-b border-border-subtle px-4 py-2">
        <div className="min-w-0">
          <div className="truncate text-[13px] font-medium">{process.name}</div>
          <div className="text-[11px] text-text-muted">PID {process.pid}</div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded px-1.5 text-text-muted hover:bg-surface-3 hover:text-text-primary"
        >
          ✕
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3 text-[12px]">
        {failure && (
          <div className="mb-3 rounded border border-warn/30 bg-warn/5 p-2 text-[11px] text-text-secondary">
            {DETAIL_FAILURE_TEXT[failure] ?? failure}
          </div>
        )}

        <SectionTitle>Identity</SectionTitle>
        <Field label="Image path" value={process.imagePath ?? '—'} mono />
        <Field label="Command line" value={process.commandLine ?? '—'} mono />
        <Field label="User" value={process.userName ?? '—'} />
        <Field label="Parent PID" value={process.parentPid} />
        <Field
          label="Parent linked"
          value={process.parentKey ? 'Yes' : 'No'}
          definition="A parent link is only made when a live process with that PID was created before this one, so a recycled PID never produces a false parent."
        />
        <Field label="Architecture" value={process.architecture ?? '—'} />
        <Field label="Session" value={process.sessionId} />
        <Field label="Base priority" value={process.basePriority} />
        <Field label="Protected" value={process.isProtected === undefined ? '—' : process.isProtected ? 'Yes' : 'No'} />
        <Field
          label="Started"
          value={new Date(process.createTimeUnixMs).toLocaleString()}
        />
        <Field label="Age" value={formatDuration(Date.now() - process.createTimeUnixMs)} />
        <Field
          label="Identity key"
          value={process.key}
          mono
          definition="PID plus creation time. The only identity that survives PID reuse."
        />

        <SectionTitle>CPU</SectionTitle>
        <Field
          label="Machine share"
          value={formatPercent(process.cpuMachinePercent, 2)}
          definition="Share of total machine capacity across all logical processors."
        />
        <Field
          label="Core equivalent"
          value={formatPercent(process.cpuCoreEquivalentPercent, 1)}
          definition="One fully saturated logical processor is 100%."
        />
        <Field
          label="Kernel time"
          value={formatDuration(process.kernelTime100ns / 10_000)}
          definition="Cumulative kernel-mode CPU time since the process started."
        />
        <Field
          label="User time"
          value={formatDuration(process.userTime100ns / 10_000)}
          definition="Cumulative user-mode CPU time since the process started."
        />

        <SectionTitle>Memory</SectionTitle>
        <Field
          label="Private working set"
          value={formatBytes(process.privateWorkingSetBytes)}
          definition="Physical memory private to this process. The default Memory column."
        />
        <Field
          label="Working set"
          value={formatBytes(process.workingSetBytes)}
          definition="All physical memory mapped by the process, shared pages included. Summing this across processes double-counts shared memory."
        />
        <Field
          label="Private commit"
          value={formatBytes(process.privateCommitBytes)}
          definition="Private committed bytes — backing store reserved, whether resident or not."
        />
        <Field label="Peak working set" value={formatBytes(process.peakWorkingSetBytes)} />
        <Field label="Virtual size" value={formatBytes(process.virtualSizeBytes)} />
        <Field label="Paged pool" value={formatBytes(process.pagedPoolBytes)} />
        <Field label="Non-paged pool" value={formatBytes(process.nonPagedPoolBytes)} />
        <Field label="Page faults" value={formatCount(process.pageFaultCount)} />
        <Field
          label="Hard faults"
          value={formatCount(process.hardFaultCount)}
          definition="Page faults that required a disk read. A rising count under memory pressure is what thrashing looks like."
        />

        <SectionTitle>Counts</SectionTitle>
        <Field label="Threads" value={formatCount(process.threadCount)} />
        <Field label="Handles" value={formatCount(process.handleCount)} />

        <SectionTitle>I/O</SectionTitle>
        <Field
          label="Read rate"
          value={formatBytesPerSecond(process.ioReadBytesPerSecond)}
          definition="From the process I/O counters. Covers file, network and device I/O — not disk alone."
        />
        <Field label="Write rate" value={formatBytesPerSecond(process.ioWriteBytesPerSecond)} />
        <Field label="Total read" value={formatBytes(process.ioReadBytes)} />
        <Field label="Total written" value={formatBytes(process.ioWriteBytes)} />
        <Field label="Other bytes" value={formatBytes(process.ioOtherBytes)} />
        <Field label="Read operations" value={formatCount(process.ioReadOperations)} />
        <Field label="Write operations" value={formatCount(process.ioWriteOperations)} />
      </div>
    </aside>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <h3 className="mt-4 mb-1 text-[11px] font-semibold uppercase tracking-wide text-text-muted first:mt-0">
      {children}
    </h3>
  );
}
