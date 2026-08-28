import { memo } from 'react';
import type { GpuAdapterSnapshot } from '@task-manager/telemetry-types';
import {
  formatBitsPerSecond,
  formatBytes,
  formatBytesPerSecond,
  formatCount,
  formatMilliseconds,
  formatPercent,
} from '@task-manager/shared';
import { Chart } from '../components/Chart.js';
import { Bar, Field, Note, PageShell, Panel, Stat } from '../components/primitives.js';
import { useTelemetry } from '../lib/hooks.js';
import { telemetryStore } from '../lib/telemetry-store.js';

/**
 * Disk, network and GPU pages.
 *
 * They share a file because they are the same shape: a headline, a live chart
 * fed from the shared ring buffers, and a per-device breakdown. Nothing here
 * calculates a metric.
 */

function Unavailable({ what, why }: { what: string; why: string }): React.JSX.Element {
  return (
    <Panel title={what}>
      <div className="text-[12px] text-text-secondary">{why}</div>
    </Panel>
  );
}

// --- disk -------------------------------------------------------------------

export function DiskPage(): React.JSX.Element {
  const summary = useTelemetry(
    (s) => ({
      unavailable: s?.disks.unavailable ?? false,
      read: s?.disks.total?.readBytesPerSecond ?? null,
      write: s?.disks.total?.writeBytesPerSecond ?? null,
      active: s?.disks.total?.activeTimePercent ?? null,
      count: s?.disks.disks.length ?? 0,
    }),
    (a, b) => a.read === b.read && a.write === b.write && a.active === b.active,
  );
  const disks = useTelemetry(
    (s) => s?.disks.disks ?? EMPTY_DISKS,
    (a, b) => a === b,
  );

  if (summary.unavailable) {
    return (
      <PageShell title="Disk">
        <Unavailable
          what="Disk"
          why="The Windows PhysicalDisk counter set could not be registered on this machine, so no disk telemetry is available. Nothing is shown rather than a zero."
        />
      </PageShell>
    );
  }

  return (
    <PageShell
      title="Disk"
      subtitle={`${formatCount(summary.count)} physical disks · PhysicalDisk counter set`}
    >
      <Panel title="Throughput" hint="All physical disks combined">
        <div className="grid grid-cols-3 gap-4">
          <Stat
            label="Read"
            value={formatBytesPerSecond(summary.read)}
            accent="var(--color-disk)"
            definition="Bytes per second read from all physical disks."
          />
          <Stat
            label="Write"
            value={formatBytesPerSecond(summary.write)}
            accent="var(--color-network)"
            definition="Bytes per second written to all physical disks."
          />
          <Stat
            label="Active time"
            value={formatPercent(summary.active)}
            definition="Share of the interval at least one request was outstanding. Derived as 100 − % Idle Time, the same basis Task Manager uses."
          />
        </div>
        <div className="mt-3">
          <Chart
            height={140}
            series={[
              { buffer: telemetryStore.system.get('diskReadBytes'), color: 'var(--color-disk)', fill: true },
              { buffer: telemetryStore.system.get('diskWriteBytes'), color: 'var(--color-network)' },
            ]}
          />
        </div>
        <div className="mt-2 flex flex-wrap gap-4 text-[11px] text-text-secondary">
          <LegendItem color="var(--color-disk)" label="Read" />
          <LegendItem color="var(--color-network)" label="Write" />
        </div>
      </Panel>

      <div className="mt-4 grid gap-4 xl:grid-cols-2">
        {disks.map((disk) => (
          <Panel
            key={disk.instance}
            title={
              disk.volumes.length > 0
                ? `Disk ${disk.index ?? '?'} — ${disk.volumes.join(' ')}`
                : `Disk ${disk.index ?? disk.instance}`
            }
            hint={disk.instance}
          >
            <div className="grid grid-cols-3 gap-4">
              <Stat label="Read" value={formatBytesPerSecond(disk.readBytesPerSecond)} small />
              <Stat label="Write" value={formatBytesPerSecond(disk.writeBytesPerSecond)} small />
              <Stat label="Active" value={formatPercent(disk.activeTimePercent)} small />
            </div>
            <div className="mt-3">
              <Bar
                fraction={(disk.activeTimePercent ?? 0) / 100}
                color="var(--color-disk)"
                height={6}
              />
            </div>
            <div className="mt-3 text-[12px]">
              <Field
                label="Average read latency"
                value={formatMilliseconds(disk.averageReadLatencyMs, 2)}
                definition="Avg. Disk sec/Read, converted to milliseconds."
              />
              <Field
                label="Average write latency"
                value={formatMilliseconds(disk.averageWriteLatencyMs, 2)}
              />
              <Field
                label="Queue length"
                value={disk.queueLength?.toFixed(2) ?? '—'}
                definition="Requests outstanding at the end of the interval."
              />
              <Field label="Reads/s" value={formatCount(disk.readsPerSecond)} />
              <Field label="Writes/s" value={formatCount(disk.writesPerSecond)} />
            </div>
          </Panel>
        ))}
      </div>

      <Note>
        These are physical-device figures: they count requests that reached the storage stack.
        The per-process I/O columns on the Processes page are a different measurement — Windows
        counts file, network and device I/O together there, so they are labelled "I/O" rather
        than "Disk". Attributing real disk traffic to a process needs ETW and is not implemented.
      </Note>
    </PageShell>
  );
}

const EMPTY_DISKS: never[] = [];

// --- network ----------------------------------------------------------------

export function NetworkPage(): React.JSX.Element {
  const summary = useTelemetry(
    (s) => ({
      unavailable: s?.network.unavailable ?? false,
      down: s?.network.receivedBytesPerSecond ?? null,
      up: s?.network.sentBytesPerSecond ?? null,
    }),
    (a, b) => a.down === b.down && a.up === b.up,
  );
  const interfaces = useTelemetry(
    (s) => s?.network.interfaces ?? EMPTY_DISKS,
    (a, b) => a === b,
  );

  if (summary.unavailable) {
    return (
      <PageShell title="Network">
        <Unavailable
          what="Network"
          why="The Windows Network Interface counter set could not be registered on this machine."
        />
      </PageShell>
    );
  }

  const active = interfaces.filter((item) => item.totalBytesPerSecond > 0 || !item.isLoopback);

  return (
    <PageShell title="Network" subtitle="Network Interface counter set, per adapter">
      <Panel title="Throughput" hint="Summed over non-loopback adapters">
        <div className="grid grid-cols-2 gap-4">
          <Stat
            label="Download"
            value={formatBitsPerSecond(summary.down)}
            accent="var(--color-network)"
            definition="Bytes received per second across all non-loopback adapters, shown in network units."
          />
          <Stat
            label="Upload"
            value={formatBitsPerSecond(summary.up)}
            accent="var(--color-disk)"
            definition="Bytes sent per second across all non-loopback adapters."
          />
        </div>
        <div className="mt-3">
          <Chart
            height={140}
            series={[
              { buffer: telemetryStore.system.get('networkDownBytes'), color: 'var(--color-network)', fill: true },
              { buffer: telemetryStore.system.get('networkUpBytes'), color: 'var(--color-disk)' },
            ]}
          />
        </div>
        <div className="mt-2 flex flex-wrap gap-4 text-[11px] text-text-secondary">
          <LegendItem color="var(--color-network)" label="Download" />
          <LegendItem color="var(--color-disk)" label="Upload" />
        </div>
      </Panel>

      <Panel className="mt-4" title="Adapters" hint={`${interfaces.length} reported by Windows`}>
        <div className="text-[12px]">
          {active.map((item) => (
            <div
              key={item.name}
              className="flex items-center gap-3 border-b border-border-subtle/50 py-1.5 last:border-b-0"
            >
              <span className="min-w-0 flex-1 truncate" title={item.name}>
                {item.name}
                {item.isLoopback && (
                  <span className="ml-2 rounded bg-surface-3 px-1 text-[10px] text-text-muted">
                    loopback
                  </span>
                )}
              </span>
              <span className="tnum w-28 shrink-0 text-right text-text-secondary">
                {formatBitsPerSecond(item.receivedBytesPerSecond)}
              </span>
              <span className="tnum w-28 shrink-0 text-right text-text-secondary">
                {formatBitsPerSecond(item.sentBytesPerSecond)}
              </span>
              <span className="tnum w-24 shrink-0 text-right text-text-muted">
                {item.linkSpeedBitsPerSecond
                  ? formatBitsPerSecond(item.linkSpeedBitsPerSecond / 8)
                  : 'down'}
              </span>
            </div>
          ))}
        </div>
      </Panel>

      <Note>
        Loopback traffic is excluded from the totals: local traffic routinely dwarfs real network
        use and would make the figure meaningless. Per-process network attribution is not
        collected — Windows does not publish it through a counter set, and the general-purpose
        process I/O counters mix file, network and device traffic together.
      </Note>
    </PageShell>
  );
}

// --- gpu --------------------------------------------------------------------

export function GpuPage(): React.JSX.Element {
  const state = useTelemetry(
    (s) => ({
      unavailable: s?.gpu.unavailable ?? false,
      adapters: s?.gpu.adapters ?? EMPTY_DISKS,
    }),
    (a, b) => a.adapters === b.adapters,
  );

  if (state.unavailable) {
    return (
      <PageShell title="GPU">
        <Unavailable
          what="GPU"
          why="The Windows GPU Engine counter set could not be registered on this machine."
        />
      </PageShell>
    );
  }

  return (
    <PageShell
      title="GPU"
      subtitle="GPU Engine and GPU Adapter Memory counter sets, joined to DXGI adapters by LUID"
    >
      <div className="grid gap-4 xl:grid-cols-2">
        {state.adapters.map((adapter) => (
          <AdapterCard key={adapter.luid} adapter={adapter} />
        ))}
      </div>
      <Note>
        Adapter utilisation is the <strong>maximum across engine types</strong>, never their sum.
        A GPU runs its 3D, Compute, Copy and video engines concurrently, so adding them would
        report well over 100% for a GPU that is nowhere near saturated. This is the same rule
        Windows Task Manager applies; each engine&apos;s own total is listed so a workload that is
        entirely video-decode bound is visible as such.
      </Note>
    </PageShell>
  );
}

const AdapterCard = memo(function AdapterCard({
  adapter,
}: {
  adapter: GpuAdapterSnapshot;
}) {
  const vramFraction =
    adapter.dedicatedMemoryUsedBytes !== undefined && adapter.dedicatedMemoryTotalBytes
      ? adapter.dedicatedMemoryUsedBytes / adapter.dedicatedMemoryTotalBytes
      : 0;

  return (
    <Panel
      title={adapter.name ?? `Adapter ${adapter.luid}`}
      hint={adapter.isSoftware ? 'Software renderer' : adapter.luid}
    >
      <div className="grid grid-cols-2 gap-4">
        <Stat
          label="Utilisation"
          value={formatPercent(adapter.utilisationPercent)}
          accent="var(--color-gpu)"
          definition="Maximum across engine types — never a sum, because engines run concurrently."
        />
        <Stat
          label="Dedicated memory"
          value={
            adapter.dedicatedMemoryUsedBytes === undefined
              ? '—'
              : `${formatBytes(adapter.dedicatedMemoryUsedBytes)} / ${formatBytes(
                  adapter.dedicatedMemoryTotalBytes,
                )}`
          }
          small
          definition="GPU Adapter Memory Dedicated Usage, against the total DXGI reports for the adapter."
        />
      </div>

      {adapter.dedicatedMemoryTotalBytes !== undefined && (
        <div className="mt-3">
          <Bar fraction={vramFraction} color="var(--color-gpu)" height={6} />
        </div>
      )}

      <div className="mt-3 text-[12px]">
        {adapter.engines.length === 0 && (
          <div className="text-text-muted">No engine activity this interval.</div>
        )}
        {adapter.engines.map((engine) => (
          <div key={engine.engine} className="flex items-center gap-3 py-0.5">
            <span className="w-32 shrink-0 text-text-secondary">{engine.label}</span>
            <div className="min-w-0 flex-1">
              <Bar
                fraction={engine.utilisationPercent / 100}
                color="var(--color-gpu)"
                height={4}
              />
            </div>
            <span className="tnum w-14 shrink-0 text-right text-text-secondary">
              {formatPercent(engine.utilisationPercent)}
            </span>
          </div>
        ))}
      </div>

      <div className="mt-3 text-[12px]">
        <Field
          label="Shared memory"
          value={
            adapter.sharedMemoryUsedBytes === undefined
              ? '—'
              : `${formatBytes(adapter.sharedMemoryUsedBytes)} / ${formatBytes(
                  adapter.sharedMemoryTotalBytes,
                )}`
          }
          definition="System memory the adapter is using, against the total it may share."
        />
        {adapter.name === undefined && (
          <Field
            label="Name"
            value="Not reported by DXGI"
            definition="This adapter appears in the counter sets but DXGI did not enumerate it, so only its LUID is known."
          />
        )}
      </div>
    </Panel>
  );
});

function LegendItem({ color, label }: { color: string; label: string }): React.JSX.Element {
  return (
    <span className="flex items-center gap-1.5">
      <span className="inline-block h-0.5 w-4 rounded" style={{ background: color }} />
      {label}
    </span>
  );
}
