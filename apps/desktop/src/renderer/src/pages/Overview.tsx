import { formatBytes, formatFrequency, formatPercent } from '@task-manager/shared';
import { Chart } from '../components/Chart.js';
import { Bar, Note, PageShell, Panel, Stat } from '../components/primitives.js';
import { useHostInfo, useTelemetry } from '../lib/hooks.js';
import { telemetryStore } from '../lib/telemetry-store.js';

export function OverviewPage(): React.JSX.Element {
  const hostInfo = useHostInfo();

  return (
    <PageShell
      title="Overview"
      subtitle={
        hostInfo
          ? `${hostInfo.osName ?? 'Windows'} ${hostInfo.osBuild ?? hostInfo.osVersion} · ${hostInfo.architecture}`
          : undefined
      }
    >
      <div className="grid gap-4 xl:grid-cols-2">
        <CpuCard />
        <MemoryCard />
      </div>
      <PendingSubsystems />
    </PageShell>
  );
}

function CpuCard(): React.JSX.Element {
  const cpu = useTelemetry(
    (snapshot) => {
      const c = snapshot?.cpu;
      return {
        time: c?.aggregateTimeUtilizationPercent ?? null,
        utility: c?.processorUtilityPercent ?? null,
        busiest: c?.busiestLogicalProcessorPercent ?? null,
        busiestIndex: c?.busiestLogicalProcessorIndex ?? null,
        speed: c?.currentFrequencyMhz ?? null,
        brand: c?.topology.brandString ?? null,
        logical: c?.topology.logicalProcessorCount ?? null,
        cores: c?.topology.physicalCoreCount ?? null,
      };
    },
    (a, b) =>
      a.time === b.time &&
      a.utility === b.utility &&
      a.busiest === b.busiest &&
      a.busiestIndex === b.busiestIndex &&
      a.speed === b.speed &&
      a.brand === b.brand,
  );

  return (
    <Panel title="CPU" hint={cpu.brand ?? undefined}>
      <div className="grid grid-cols-3 gap-4">
        <Stat
          label="Utilization"
          value={formatPercent(cpu.time)}
          accent="var(--color-cpu)"
          definition={
            'Aggregate time utilization: the share of all logical processor time not spent in the idle thread. ' +
            'Source: NtQuerySystemInformation(SystemProcessorPerformanceInformation).'
          }
        />
        <Stat
          label="Processor utility"
          value={formatPercent(cpu.utility)}
          definition={
            'The metric Windows Task Manager displays. Time utilization scaled by delivered performance, ' +
            'so it exceeds 100% when the CPU runs above its base clock. Source: PDH % Processor Utility.'
          }
        />
        <Stat
          label={
            cpu.busiestIndex === null ? 'Busiest processor' : `Busiest (CPU ${cpu.busiestIndex})`
          }
          value={formatPercent(cpu.busiest)}
          definition={
            'The highest utilization of any single logical processor. A single-threaded workload saturating ' +
            'one core reads ~100% here while total utilization stays low.'
          }
        />
      </div>

      <div className="mt-3">
        <Chart
          height={130}
          max={100}
          series={[
            {
              buffer: telemetryStore.system.get('cpuTimeUtilization'),
              color: 'var(--color-cpu)',
              fill: 'rgba(74,158,255,0.14)',
            },
            {
              buffer: telemetryStore.system.get('cpuBusiest'),
              color: 'rgba(255,255,255,0.30)',
              dashed: true,
            },
          ]}
        />
      </div>

      <div className="mt-2 flex items-center justify-between text-[11px] text-text-muted">
        <span>
          {cpu.cores ?? '—'} cores · {cpu.logical ?? '—'} logical processors
        </span>
        <span className="tnum">{formatFrequency(cpu.speed)}</span>
      </div>
      <Note>
        Solid line is time utilization. Dashed line is the busiest single logical processor —
        the gap between them is how much of the machine a workload is actually able to use.
      </Note>
    </Panel>
  );
}

function MemoryCard(): React.JSX.Element {
  const memory = useTelemetry(
    (snapshot) => {
      const m = snapshot?.memory;
      return {
        used: m?.usedPhysicalBytes ?? null,
        total: m?.totalPhysicalBytes ?? null,
        percent: m?.physicalUtilizationPercent ?? null,
        available: m?.availablePhysicalBytes ?? null,
        cached: m?.cachedBytes ?? null,
        committed: m?.committedBytes ?? null,
        commitLimit: m?.commitLimitBytes ?? null,
      };
    },
    (a, b) =>
      a.used === b.used &&
      a.total === b.total &&
      a.cached === b.cached &&
      a.committed === b.committed,
  );

  const fraction =
    memory.total && memory.used !== null ? memory.used / memory.total : 0;

  return (
    <Panel title="Memory">
      <div className="grid grid-cols-3 gap-4">
        <Stat
          label="In use"
          value={formatBytes(memory.used)}
          accent="var(--color-memory)"
          definition="Total physical memory minus available. Available already includes the standby (cached) list."
        />
        <Stat
          label="Utilization"
          value={formatPercent(memory.percent)}
          definition="In use divided by total physical memory usable by the OS."
        />
        <Stat
          label="Committed"
          value={
            memory.committed === null
              ? '—'
              : `${formatBytes(memory.committed)} / ${formatBytes(memory.commitLimit)}`
          }
          small
          definition="Commit charge against the commit limit (RAM plus the current page file size)."
        />
      </div>

      <div className="mt-3">
        <Bar fraction={fraction} color="var(--color-memory)" height={8} />
        <div className="mt-1.5 flex justify-between text-[11px] text-text-muted">
          <span>{formatBytes(memory.available)} available</span>
          <span>{formatBytes(memory.cached)} cached</span>
          <span>{formatBytes(memory.total)} total</span>
        </div>
      </div>

      <div className="mt-3">
        <Chart
          height={100}
          max={memory.total ?? undefined}
          series={[
            {
              buffer: telemetryStore.system.get('memoryUsedBytes'),
              color: 'var(--color-memory)',
              fill: 'rgba(169,112,255,0.14)',
            },
          ]}
        />
      </div>
      <Note>
        Cached memory is standby plus modified pages. It is counted as available, which is why
        "in use" can fall without any process releasing memory.
      </Note>
    </Panel>
  );
}

/**
 * Subsystems that are not implemented yet are listed explicitly rather than
 * shown as empty gauges, so the UI never implies a measurement it does not have.
 */
function PendingSubsystems(): React.JSX.Element {
  const pending = ['GPU', 'Disk', 'Network', 'History'];
  return (
    <div className="mt-4 rounded-lg border border-dashed border-border-subtle px-4 py-3 text-[11px] text-text-muted">
      Not yet collected: {pending.join(' · ')}. These are deliberately absent rather than shown
      as zero — nothing in this application displays a value it has not measured.
    </div>
  );
}
