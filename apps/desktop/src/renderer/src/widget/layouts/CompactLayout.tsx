import { memo } from 'react';
import type { WidgetMetricId, WidgetSettings } from '@shared/widget';
import { TemperatureCell } from '../TemperatureCell.js';
import { useWidgetMetric } from '../metrics.js';

/**
 * One row per metric: label, bar, temperature, value.
 *
 * The bar is only drawn for metrics that have a natural full scale. A byte rate
 * has no ceiling, so it gets the value alone rather than a bar against an
 * invented maximum.
 */
export function CompactLayout({ settings }: { settings: WidgetSettings }): React.JSX.Element {
  return (
    <div className="flex h-full flex-col justify-center gap-1.5 px-2.5 py-2">
      {settings.metrics.map((id) => (
        <CompactRow key={id} id={id} showTemperature={settings.showTemperatures} />
      ))}
    </div>
  );
}

const CompactRow = memo(function CompactRow({
  id,
  showTemperature,
}: {
  id: WidgetMetricId;
  showTemperature: boolean;
}) {
  const metric = useWidgetMetric(id);
  return (
    <div className="flex items-center gap-2" title={metric.definition}>
      {/* Fixed column so the bars line up, wide enough that the longest label
          ("CPU utility") stays on one line and does not grow the row. */}
      <span className="widget-label w-[74px] shrink-0 truncate">{metric.label}</span>
      <div className="min-w-0 flex-1">
        {metric.fraction === null ? (
          <div className="widget-bar-track" />
        ) : (
          <div className="widget-bar-track">
            <div
              className="widget-bar-fill"
              style={{ width: `${metric.fraction * 100}%`, background: metric.accent }}
            />
          </div>
        )}
      </div>
      {/* Between the label and the value, in its own fixed column so that a row
          with no sensor keeps the values aligned with the rows that have one.
          The width here is the 34px `widgetLayoutSize` reserves. */}
      {showTemperature && (
        <TemperatureCell temperature={metric.temperature} className="w-[26px] shrink-0 text-right" />
      )}
      <span
        className="tnum widget-value-sm w-12 shrink-0 text-right"
        style={{ color: metric.accent }}
      >
        {metric.text}
      </span>
    </div>
  );
});
