import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { HistoryPoint } from '@task-manager/telemetry-types';
import { RingBuffer } from '@task-manager/shared';
import {
  formatBitsPerSecond,
  formatBytes,
  formatBytesPerSecond,
  formatCount,
  formatPercent,
} from '@task-manager/shared';
import type { HistoryStatus } from '@shared/ipc';
import { Chart, type ChartSeries } from '../components/Chart.js';
import { Field, Note, PageShell, Panel } from '../components/primitives.js';

/**
 * Historical telemetry.
 *
 * Reads from the native store, which keeps fine detail for the recent past and
 * coarser aggregates further back. Nothing is recomputed here: the stored points
 * already carry the means and the peaks the collector accumulated.
 */

interface Range {
  id: string;
  label: string;
  spanMs: number;
}

const RANGES: Range[] = [
  { id: '5m', label: '5 minutes', spanMs: 5 * 60_000 },
  { id: '1h', label: '1 hour', spanMs: 60 * 60_000 },
  { id: '24h', label: '24 hours', spanMs: 24 * 60 * 60_000 },
  { id: '7d', label: '7 days', spanMs: 7 * 24 * 60 * 60_000 },
];

const TIER_LABELS = ['every sample', '5 seconds', '1 minute', '5 minutes'];

/** How often the view re-queries while it is open. */
const REFRESH_MS = 5_000;

export function HistoryPage(): React.JSX.Element {
  const [range, setRange] = useState<Range>(RANGES[0] as Range);
  const [points, setPoints] = useState<HistoryPoint[]>([]);
  const [meta, setMeta] = useState<{ tier: number; resolutionMs: number; available: boolean }>({
    tier: 0,
    resolutionMs: 0,
    available: false,
  });
  const [status, setStatus] = useState<HistoryStatus | null>(null);

  const load = useCallback(async () => {
    const now = Date.now();
    const [result, current] = await Promise.all([
      window.taskManager.queryHistory(now - range.spanMs, now),
      window.taskManager.getHistoryStatus(),
    ]);
    setPoints(result.points);
    setMeta({ tier: result.tier, resolutionMs: result.resolutionMs, available: result.available });
    setStatus(current);
  }, [range]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  const toggleRecording = (): void => {
    void window.taskManager.setHistoryEnabled(!(status?.enabled ?? false)).then((next) => {
      setStatus(next);
      void load();
    });
  };

  return (
    <PageShell
      title="History"
      subtitle={
        meta.available
          ? `${formatCount(points.length)} points · ${TIER_LABELS[meta.tier] ?? 'unknown'} resolution`
          : 'Recording is off'
      }
      actions={
        <>
          <div className="flex overflow-hidden rounded border border-border-subtle text-[11px]">
            {RANGES.map((option) => (
              <button
                key={option.id}
                type="button"
                onClick={() => setRange(option)}
                className={`px-2 py-1 ${
                  range.id === option.id
                    ? 'bg-surface-3 text-text-primary'
                    : 'bg-surface-1 text-text-muted hover:text-text-secondary'
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={toggleRecording}
            className="rounded border border-border-subtle bg-surface-2 px-2 py-1 text-[11px] text-text-secondary hover:text-text-primary"
          >
            {status?.enabled ? 'Stop recording' : 'Start recording'}
          </button>
        </>
      }
    >
      {!status?.enabled && (
        <Panel className="mb-4" title="Recording is off">
          <div className="text-[12px] text-text-secondary">
            Nothing is being written to disk. Existing history is kept and can still be read.
          </div>
        </Panel>
      )}

      {points.length === 0 ? (
        <Panel title="No data for this range">
          <div className="text-[12px] text-text-secondary">
            {status?.enabled
              ? 'History is recorded as the application runs, so a longer range fills in over time. The coarser tiers only gain a point once their window has elapsed.'
              : 'Turn recording on to start collecting history.'}
          </div>
        </Panel>
      ) : (
        <div className="grid gap-4">
          <HistoryChart
            title="CPU"
            hint="Mean over each window, with the peak drawn behind it"
            points={points}
            max={100}
            series={[
              { key: 'cpuTimePeakPercent', color: 'var(--color-chart-comparison)', label: 'Peak', dashed: true },
              { key: 'cpuTimePercent', color: 'var(--color-cpu)', label: 'Time utilization', fill: true },
              { key: 'cpuUtilityPercent', color: 'var(--color-warn)', label: 'Processor utility' },
            ]}
            format={(value) => formatPercent(value)}
          />
          <HistoryChart
            title="Memory"
            hint="Physical memory in use"
            points={points}
            series={[
              { key: 'memoryUsedPeakBytes', color: 'var(--color-chart-comparison)', label: 'Peak', dashed: true },
              { key: 'memoryUsedBytes', color: 'var(--color-memory)', label: 'In use', fill: true },
              { key: 'memoryCommittedBytes', color: 'var(--color-gpu)', label: 'Committed' },
            ]}
            format={formatBytes}
          />
          <HistoryChart
            title="Disk"
            hint="Throughput across all physical disks"
            points={points}
            series={[
              { key: 'diskTotalPeakBytesPerSecond', color: 'var(--color-chart-comparison)', label: 'Peak total', dashed: true },
              { key: 'diskReadBytesPerSecond', color: 'var(--color-disk)', label: 'Read', fill: true },
              { key: 'diskWriteBytesPerSecond', color: 'var(--color-network)', label: 'Write' },
            ]}
            format={formatBytesPerSecond}
          />
          <HistoryChart
            title="Network"
            hint="Non-loopback adapters"
            points={points}
            series={[
              { key: 'networkDownBytesPerSecond', color: 'var(--color-network)', label: 'Download', fill: true },
              { key: 'networkUpBytesPerSecond', color: 'var(--color-disk)', label: 'Upload' },
            ]}
            format={formatBitsPerSecond}
          />
          <HistoryChart
            title="GPU"
            hint="Busiest hardware adapter"
            points={points}
            max={100}
            series={[{ key: 'gpuPercent', color: 'var(--color-gpu)', label: 'Utilisation', fill: true }]}
            format={(value) => formatPercent(value)}
          />
          <HistoryChart
            title="Counts"
            hint="Processes, threads and handles — a steadily climbing line is a leak"
            points={points}
            series={[
              { key: 'processCount', color: 'var(--color-cpu)', label: 'Processes' },
              { key: 'threadCount', color: 'var(--color-memory)', label: 'Threads' },
              { key: 'handleCount', color: 'var(--color-warn)', label: 'Handles' },
            ]}
            format={formatCount}
          />
        </div>
      )}

      <Panel className="mt-4" title="Storage" hint={status?.path}>
        <div className="text-[12px]">
          <Field label="Recording" value={status?.enabled ? 'On' : 'Off'} />
          <Field
            label="Answering tier"
            value={`${meta.tier} — ${TIER_LABELS[meta.tier] ?? 'unknown'}`}
            definition="A query is answered from the finest tier whose retention covers the requested span."
          />
          {(status?.tiers ?? []).map((tier) => (
            <Field
              key={tier.tier}
              label={`Tier ${tier.tier} (${TIER_LABELS[tier.tier] ?? '?'})`}
              value={`${formatCount(tier.rowCount)} rows`}
            />
          ))}
        </div>
      </Panel>

      <Note>
        Each stored point is an exact mean over its window, computed from every sample rather than
        from a coarser average, and carries the peak within that window alongside it — an average
        over five minutes hides exactly the spike a post-hoc question is about. Retention is
        tiered, so the database stays a few hundred kilobytes however long the application runs.
      </Note>
    </PageShell>
  );
}

interface SeriesSpec {
  key: keyof HistoryPoint;
  color: string;
  label: string;
  fill?: boolean;
  dashed?: boolean;
}

/**
 * A chart over stored points.
 *
 * The `Chart` component draws from ring buffers, so the queried points are
 * copied into fixed buffers sized to the result. They are rebuilt only when the
 * data changes, not on every render.
 */
function HistoryChart({
  title,
  hint,
  points,
  series,
  max,
  format,
}: {
  title: string;
  hint?: string;
  points: HistoryPoint[];
  series: SeriesSpec[];
  max?: number;
  format: (value: number | undefined) => string;
}): React.JSX.Element {
  const buffersRef = useRef<Map<string, RingBuffer>>(new Map());

  const chartSeries = useMemo<ChartSeries[]>(() => {
    const buffers = buffersRef.current;
    const capacity = Math.max(points.length, 2);
    return series.map((spec) => {
      let buffer = buffers.get(spec.key as string);
      if (!buffer || buffer.capacity !== capacity) {
        buffer = new RingBuffer(capacity);
        buffers.set(spec.key as string, buffer);
      } else {
        buffer.clear();
      }
      for (const point of points) {
        const value = point[spec.key];
        buffer.push(typeof value === 'number' ? value : Number.NaN);
      }
      return {
        buffer,
        color: spec.color,
        fill: spec.fill,
        dashed: spec.dashed,
      };
    });
  }, [points, series]);

  const latest = points.at(-1);
  const first = points.at(0);

  return (
    <Panel title={title} hint={hint}>
      <Chart height={120} max={max} windowSamples={Math.max(points.length, 2)} series={chartSeries} />
      <div className="mt-2 flex flex-wrap items-center gap-4 text-[11px] text-text-secondary">
        {series.map((spec, index) => {
          const value = latest?.[spec.key];
          return (
            <span key={spec.key as string} className="flex items-center gap-1.5">
              <span
                className="inline-block h-0.5 w-4 rounded"
                style={{ background: chartSeries[index]?.color }}
              />
              {spec.label}
              <span className="tnum text-text-primary">
                {format(typeof value === 'number' ? value : undefined)}
              </span>
            </span>
          );
        })}
      </div>
      {first && latest && (
        <div className="mt-1 flex justify-between text-[10px] text-text-muted">
          <span>{new Date(first.timestampUnixMs).toLocaleString()}</span>
          <span>{new Date(latest.timestampUnixMs).toLocaleTimeString()}</span>
        </div>
      )}
    </Panel>
  );
}
