import type { MemorySnapshot } from '@task-manager/telemetry-types';
import { formatBytes, formatPercent } from '@task-manager/shared';
import { Chart } from '../components/Chart.js';
import { Field, Note, PageShell, Panel, Stat } from '../components/primitives.js';
import { useTelemetry } from '../lib/hooks.js';
import { telemetryStore } from '../lib/telemetry-store.js';

export function MemoryPage(): React.JSX.Element {
  const memory = useTelemetry(
    (s) => s?.memory ?? null,
    (a, b) => a?.usedPhysicalBytes === b?.usedPhysicalBytes && a?.committedBytes === b?.committedBytes,
  );

  if (!memory) {
    return (
      <PageShell title="Memory">
        <Panel>Waiting for the first sample…</Panel>
      </PageShell>
    );
  }

  const installed = memory.installedPhysicalBytes;
  const reserved =
    installed !== undefined ? installed - memory.totalPhysicalBytes : undefined;

  return (
    <PageShell
      title="Memory"
      subtitle={
        installed !== undefined
          ? `${formatBytes(installed)} installed · ${formatBytes(memory.totalPhysicalBytes)} usable by Windows`
          : undefined
      }
    >
      <div className="grid gap-4 xl:grid-cols-[2fr_1fr]">
        <Panel title="Physical memory">
          <div className="grid grid-cols-4 gap-4">
            <Stat
              label="In use"
              value={formatBytes(memory.usedPhysicalBytes)}
              accent="var(--color-memory)"
              definition="Total usable physical memory minus available."
            />
            <Stat
              label="Available"
              value={formatBytes(memory.availablePhysicalBytes)}
              definition="Free, zeroed and standby pages. Standby holds cached file data that can be reclaimed instantly."
            />
            <Stat
              label="Cached"
              value={formatBytes(memory.cachedBytes)}
              definition="Standby plus modified pages — the same definition Task Manager uses."
            />
            <Stat
              label="Utilization"
              value={formatPercent(memory.physicalUtilizationPercent)}
              definition="In use divided by total usable physical memory."
            />
          </div>

          <div className="mt-4">
            <Composition memory={memory} />
          </div>

          <div className="mt-4">
            <Chart
              height={150}
              max={memory.totalPhysicalBytes}
              series={[
                {
                  buffer: telemetryStore.system.get('memoryUsedBytes'),
                  color: 'var(--color-memory)',
                  fill: 'rgba(169,112,255,0.14)',
                },
              ]}
            />
            <div className="mt-1 flex justify-between text-[11px] text-text-muted">
              <span>0</span>
              <span>{formatBytes(memory.totalPhysicalBytes)}</span>
            </div>
          </div>
        </Panel>

        <Panel title="Details" hint="Every value with its Windows source">
          <div className="text-[12px]">
            <Field
              label="Installed"
              value={formatBytes(installed)}
              definition="GetPhysicallyInstalledSystemMemory — reads SMBIOS."
            />
            <Field
              label="Usable"
              value={formatBytes(memory.totalPhysicalBytes)}
              definition="MEMORYSTATUSEX.ullTotalPhys"
            />
            {reserved !== undefined && reserved > 0 && (
              <Field
                label="Hardware reserved"
                value={formatBytes(reserved)}
                definition="Installed minus usable: memory claimed by firmware and devices."
              />
            )}
            <Field
              label="Available"
              value={formatBytes(memory.availablePhysicalBytes)}
              definition="MEMORYSTATUSEX.ullAvailPhys"
            />
            <Field
              label="Standby"
              value={formatBytes(memory.standbyBytes)}
              definition="SystemMemoryListInformation, summed over cache priorities 0-7."
            />
            <Field
              label="Modified"
              value={formatBytes(memory.modifiedBytes)}
              definition="Modified plus modified-no-write pages, awaiting write-back."
            />
            <Field
              label="Free"
              value={formatBytes(memory.freeBytes)}
              definition="Free plus zeroed page lists."
            />
            <Field
              label="Committed"
              value={formatBytes(memory.committedBytes)}
              definition="GetPerformanceInfo CommitTotal x page size."
            />
            <Field
              label="Commit limit"
              value={formatBytes(memory.commitLimitBytes)}
              definition="RAM plus the current page file size."
            />
            <Field
              label="Commit peak"
              value={formatBytes(memory.commitPeakBytes)}
              definition="Highest commit charge since boot."
            />
            <Field
              label="Paged pool"
              value={formatBytes(memory.pagedPoolBytes)}
              definition="Kernel memory that can be paged out."
            />
            <Field
              label="Non-paged pool"
              value={formatBytes(memory.nonPagedPoolBytes)}
              definition="Kernel memory that must stay resident."
            />
            <Field
              label="Page file"
              value={
                memory.pageFileTotalBytes === undefined
                  ? '—'
                  : `${formatBytes(memory.pageFileUsedBytes)} / ${formatBytes(memory.pageFileTotalBytes)}`
              }
              definition="Commit limit minus RAM gives the page file size; usage is commit beyond what RAM can hold."
            />
            <Field label="Page size" value={formatBytes(memory.pageSizeBytes)} />
            <Field
              label="Memory load"
              value={formatPercent(memory.memoryLoadPercent, 0)}
              definition="MEMORYSTATUSEX.dwMemoryLoad, kept as a cross-check on our own percentage."
            />
          </div>
        </Panel>
      </div>

      <Note>
        Committed memory can exceed physical memory: commit is a promise of backing store, not
        of resident pages. Commit charge above the commit limit is what makes Windows refuse
        allocations, which is a different failure from running out of RAM.
      </Note>
    </PageShell>
  );
}

/** The composition bar: in use, modified, standby, free. */
function Composition({ memory }: { memory: MemorySnapshot }): React.JSX.Element {
  const total = memory.totalPhysicalBytes || 1;
  const standby = memory.standbyBytes ?? 0;
  const modified = memory.modifiedBytes ?? 0;
  const free = memory.freeBytes ?? 0;
  // In-use excludes the cached lists, which "available" already covers.
  const inUse = Math.max(memory.totalPhysicalBytes - standby - modified - free, 0);

  const segments = [
    { label: 'In use', bytes: inUse, color: 'var(--color-memory)' },
    { label: 'Modified', bytes: modified, color: '#7c4dcc' },
    { label: 'Standby', bytes: standby, color: '#3f4a5c' },
    { label: 'Free', bytes: free, color: '#232a34' },
  ];

  const hasBreakdown = memory.standbyBytes !== undefined;
  if (!hasBreakdown) {
    return (
      <div className="text-[11px] text-text-muted">
        Memory composition needs the standby/modified page lists, which are unavailable on this
        system.
      </div>
    );
  }

  return (
    <div>
      <div className="flex h-7 w-full overflow-hidden rounded border border-border-subtle">
        {segments.map((segment) => (
          <div
            key={segment.label}
            title={`${segment.label}: ${formatBytes(segment.bytes)}`}
            style={{
              width: `${(segment.bytes / total) * 100}%`,
              background: segment.color,
            }}
          />
        ))}
      </div>
      <div className="mt-1.5 flex flex-wrap gap-4 text-[11px] text-text-secondary">
        {segments.map((segment) => (
          <span key={segment.label} className="flex items-center gap-1.5">
            <span
              className="inline-block h-2.5 w-2.5 rounded-sm"
              style={{ background: segment.color }}
            />
            {segment.label}
            <span className="tnum text-text-muted">{formatBytes(segment.bytes)}</span>
          </span>
        ))}
      </div>
    </div>
  );
}
