import { memo } from 'react';
import { formatFrequency, formatPercent } from '@task-manager/shared';
import { Chart } from '../components/Chart.js';
import { Field, Note, PageShell, Panel, Stat } from '../components/primitives.js';
import { useTelemetry } from '../lib/hooks.js';
import { telemetryStore } from '../lib/telemetry-store.js';

export function CpuPage(): React.JSX.Element {
  const brand = useTelemetry((s) => s?.cpu.topology.brandString ?? null);

  return (
    <PageShell title="CPU" subtitle={brand ?? undefined}>
      <div className="grid gap-4 xl:grid-cols-[2fr_1fr]">
        <Panel title="Utilization" hint="Two different definitions, drawn together">
          <Headline />
          <div className="mt-3">
            <Chart
              height={180}
              max={100}
              series={[
                {
                  buffer: telemetryStore.system.get('cpuTimeUtilization'),
                  color: 'var(--color-cpu)',
                  fill: true,
                },
                {
                  buffer: telemetryStore.system.get('cpuProcessorUtility'),
                  color: 'var(--color-warn)',
                },
                {
                  buffer: telemetryStore.system.get('cpuBusiest'),
                  color: 'var(--color-chart-comparison)',
                  dashed: true,
                },
              ]}
            />
          </div>
          <Legend />
          <Note>
            The y-axis is fixed at 100%. Processor utility can exceed that on a CPU running
            above its base clock, and is clipped by the axis rather than by the measurement —
            the exact value is shown above and in the debug view.
          </Note>
        </Panel>

        <Topology />
      </div>

      <div className="mt-4">
        <PerProcessorGrid />
      </div>
    </PageShell>
  );
}

function Headline(): React.JSX.Element {
  const values = useTelemetry(
    (s) => ({
      time: s?.cpu.aggregateTimeUtilizationPercent ?? null,
      utility: s?.cpu.processorUtilityPercent ?? null,
      busiest: s?.cpu.busiestLogicalProcessorPercent ?? null,
      busiestIndex: s?.cpu.busiestLogicalProcessorIndex ?? null,
      average: s?.cpu.averageLogicalProcessorPercent ?? null,
      speed: s?.cpu.currentFrequencyMhz ?? null,
      performance: s?.cpu.processorPerformancePercent ?? null,
    }),
    (a, b) =>
      a.time === b.time &&
      a.utility === b.utility &&
      a.busiest === b.busiest &&
      a.speed === b.speed,
  );

  return (
    <div className="grid grid-cols-4 gap-4">
      <Stat
        label="Time utilization"
        value={formatPercent(values.time)}
        accent="var(--color-cpu)"
        definition="Share of all logical processor time not spent idle. Frequency-independent."
      />
      <Stat
        label="Processor utility"
        value={formatPercent(values.utility)}
        accent="var(--color-warn)"
        definition="Task Manager's CPU figure. Busy time weighted by delivered performance."
      />
      <Stat
        label={values.busiestIndex === null ? 'Busiest' : `Busiest · CPU ${values.busiestIndex}`}
        value={formatPercent(values.busiest)}
        definition="Highest utilization of any one logical processor this interval."
      />
      <Stat
        label="Speed"
        value={formatFrequency(values.speed)}
        definition={
          'Base frequency multiplied by % Processor Performance, which is how Task Manager derives ' +
          'the displayed speed. Not a measured clock.'
        }
        small
      />
    </div>
  );
}

function Legend(): React.JSX.Element {
  const items = [
    { color: 'var(--color-cpu)', label: 'Time utilization' },
    { color: 'var(--color-warn)', label: 'Processor utility (Task Manager)' },
    { color: 'var(--color-chart-comparison)', label: 'Busiest logical processor' },
  ];
  return (
    <div className="mt-2 flex flex-wrap gap-4 text-[11px] text-text-secondary">
      {items.map((item) => (
        <span key={item.label} className="flex items-center gap-1.5">
          <span
            className="inline-block h-0.5 w-4 rounded"
            style={{ background: item.color }}
          />
          {item.label}
        </span>
      ))}
    </div>
  );
}

function Topology(): React.JSX.Element {
  const topology = useTelemetry(
    (s) => s?.cpu.topology ?? null,
    (a, b) => a?.logicalProcessorCount === b?.logicalProcessorCount && a?.isHybrid === b?.isHybrid,
  );
  const counts = useTelemetry(
    (s) => ({
      processes: s?.cpu.processCount ?? null,
      threads: s?.cpu.threadCount ?? null,
      handles: s?.cpu.handleCount ?? null,
      uptime: s?.cpu.uptimeMs ?? null,
    }),
    (a, b) => a.processes === b.processes && a.threads === b.threads && a.handles === b.handles,
  );

  if (!topology) return <Panel title="Topology">No data yet.</Panel>;

  return (
    <Panel title="Topology" hint="Reported by GetLogicalProcessorInformationEx">
      <div className="text-[12px]">
        <Field label="Packages" value={topology.packageCount} />
        <Field label="Physical cores" value={topology.physicalCoreCount} />
        <Field label="Logical processors" value={topology.logicalProcessorCount} />
        <Field
          label="Processor groups"
          value={topology.processorGroupCount}
          definition="Windows partitions machines with more than 64 logical processors into groups."
        />
        <Field
          label="Hybrid"
          value={topology.isHybrid ? `Yes · classes ${topology.efficiencyClasses.join(', ')}` : 'No'}
          definition="True only when Windows reports more than one EfficiencyClass. Never inferred."
        />
        <Field label="Base frequency" value={formatFrequency(topology.baseFrequencyMhz)} />
        <Field label="Processes" value={counts.processes ?? '—'} />
        <Field label="Threads" value={counts.threads ?? '—'} />
        <Field label="Handles" value={counts.handles?.toLocaleString() ?? '—'} />
      </div>
      {topology.isHybrid && (
        <Note>
          This machine has more than one core efficiency class. Class {Math.max(...topology.efficiencyClasses)} cores
          are the more performant ones; per-processor tiles are labelled with their class.
        </Note>
      )}
    </Panel>
  );
}

function PerProcessorGrid(): React.JSX.Element {
  const indices = useTelemetry(
    (s) => s?.cpu.perLogicalProcessor.map((p) => p.index) ?? [],
    (a, b) => a.length === b.length,
  );

  if (indices.length === 0) {
    return <Panel title="Logical processors">Waiting for the first interval…</Panel>;
  }

  return (
    <Panel
      title="Logical processors"
      hint="Per-processor time utilization, same scale on every tile"
    >
      <div className="grid grid-cols-4 gap-2 md:grid-cols-6 xl:grid-cols-8">
        {indices.map((index) => (
          <ProcessorTile key={index} index={index} />
        ))}
      </div>
    </Panel>
  );
}

/**
 * One processor tile. Subscribes only to its own value, so a snapshot updates
 * 24 small text nodes rather than re-rendering the grid.
 */
const ProcessorTile = memo(function ProcessorTile({ index }: { index: number }) {
  const info = useTelemetry(
    (s) => {
      const p = s?.cpu.perLogicalProcessor[index];
      return {
        percent: p?.timeUtilizationPercent ?? null,
        efficiencyClass: p?.efficiencyClass ?? null,
        group: p?.group ?? 0,
      };
    },
    (a, b) => a.percent === b.percent && a.efficiencyClass === b.efficiencyClass,
  );
  const buffer = telemetryStore.perProcessor.get(index);

  return (
    <div className="rounded border border-border-subtle bg-surface-2 p-1.5">
      <div className="flex items-baseline justify-between text-[10px] text-text-muted">
        <span>
          CPU {index}
          {info.efficiencyClass !== null && (
            <span className="ml-1 opacity-60">E{info.efficiencyClass}</span>
          )}
        </span>
        <span className="tnum text-[11px] text-text-primary">
          {info.percent === null ? '—' : `${info.percent.toFixed(0)}%`}
        </span>
      </div>
      {buffer && (
        <Chart
          height={34}
          max={100}
          gridLines={0}
          series={[
            {
              buffer,
              color: 'var(--color-cpu)',
              fill: true,
            },
          ]}
        />
      )}
    </div>
  );
});
