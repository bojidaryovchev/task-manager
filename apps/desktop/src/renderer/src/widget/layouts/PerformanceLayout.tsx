import { memo } from 'react';
import type { WidgetMetricId, WidgetSettings } from '@shared/widget';
import { Chart } from '../../components/Chart.js';
import { TemperatureCell } from '../TemperatureCell.js';
import { useTelemetry } from '../../lib/hooks.js';
import {
  telemetryStore,
  type SystemSeriesName,
} from '../../lib/telemetry-store.js';
import { useWidgetMetric } from '../metrics.js';

/**
 * Each metric with a short history graph.
 *
 * The graphs are the same canvas `Chart` the main window uses: it subscribes to
 * the store and redraws imperatively, so a new snapshot never re-renders the
 * widget's React tree. The buffers are the shared bounded ring buffers, so a
 * widget left running for a week costs the same memory as one just opened.
 */

/** A 30-second window at the default 500 ms interval. */
const WINDOW_SAMPLES = 60;

/** Metrics whose natural axis is 0-100. */
const PERCENT_METRICS = new Set<WidgetMetricId>([
  'cpuUtilization',
  'cpuUtility',
  'cpuBusiest',
  'memoryPercent',
  'gpu',
]);

/** Which stored series backs each metric, when one does. */
const SERIES_FOR: Partial<Record<WidgetMetricId, SystemSeriesName>> = {
  cpuUtilization: 'cpuTimeUtilization',
  cpuUtility: 'cpuProcessorUtility',
  cpuBusiest: 'cpuBusiest',
  memoryPercent: 'memoryPercent',
  memoryUsed: 'memoryUsedBytes',
  gpu: 'gpuUtilisation',
  diskRead: 'diskReadBytes',
  diskWrite: 'diskWriteBytes',
  networkDown: 'networkDownBytes',
  networkUp: 'networkUpBytes',
};

export function PerformanceLayout({
  settings,
}: {
  settings: WidgetSettings;
}): React.JSX.Element {
  return (
    <div className="flex h-full flex-col gap-1.5 px-2.5 py-2">
      {settings.metrics.map((id) => (
        <PerformanceRow key={id} id={id} showTemperature={settings.showTemperatures} />
      ))}
    </div>
  );
}

const PerformanceRow = memo(function PerformanceRow({
  id,
  showTemperature,
}: {
  id: WidgetMetricId;
  showTemperature: boolean;
}) {
  const metric = useWidgetMetric(id);
  const seriesName = SERIES_FOR[id];
  // Memory in bytes has no fixed ceiling, so its graph scales to the machine's
  // installed memory rather than to whatever the highest sample happened to be.
  const totalMemoryBytes = useTelemetry((snapshot) =>
    id === 'memoryUsed' ? (snapshot?.memory.totalPhysicalBytes ?? null) : null,
  );

  return (
    <div className="min-h-0 flex-1" title={metric.definition}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="widget-label truncate">{metric.label}</span>
        <span className="flex shrink-0 items-baseline gap-2">
          {showTemperature && <TemperatureCell temperature={metric.temperature} />}
          <span className="tnum widget-value-sm" style={{ color: metric.accent }}>
            {metric.text}
          </span>
        </span>
      </div>
      {seriesName && (
        <Chart
          height={30}
          gridLines={0}
          windowSamples={WINDOW_SAMPLES}
          max={
            id === 'memoryUsed'
              ? (totalMemoryBytes ?? undefined)
              : // Percentages get a fixed 0-100 axis; byte rates have no
                // ceiling, so their chart scales to what has been seen.
                PERCENT_METRICS.has(id)
                ? 100
                : undefined
          }
          series={[
            {
              buffer: telemetryStore.system.get(seriesName),
              color: metric.accent,
              fill: true,
            },
          ]}
        />
      )}
    </div>
  );
});
