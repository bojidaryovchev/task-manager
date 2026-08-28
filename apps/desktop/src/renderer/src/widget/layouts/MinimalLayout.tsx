import { memo, useRef } from 'react';
import type { WidgetSettings } from '@shared/widget';
import { TemperatureCell } from '../TemperatureCell.js';
import { useContentWidth } from '../useContentWidth.js';
import { useWidgetMetric } from '../metrics.js';

/**
 * One line, values only: `CPU 78° 14%  |  RAM — 92%`.
 *
 * The smallest useful shape — sized to sit on a taskbar edge without covering
 * anything. The temperature sits between the label and the value here too, so
 * the reading order is the same in every layout.
 */
export function MinimalLayout({ settings }: { settings: WidgetSettings }): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  // `w-max` rather than a stretched row: this is the one layout whose width is
  // decided by its content, so it must size to that content for the measurement
  // reported to main to mean anything. See useContentWidth.
  useContentWidth(ref);

  return (
    <div ref={ref} className="flex h-full w-max items-center gap-2 px-2.5">
      {settings.metrics.map((id, index) => (
        <span key={id} className="flex items-center gap-2">
          {index > 0 && <span className="widget-divider" />}
          <MinimalMetric id={id} showTemperature={settings.showTemperatures} />
        </span>
      ))}
    </div>
  );
}

const MinimalMetric = memo(function MinimalMetric({
  id,
  showTemperature,
}: {
  id: WidgetSettings['metrics'][number];
  showTemperature: boolean;
}) {
  const metric = useWidgetMetric(id);
  return (
    <span className="flex items-baseline gap-1" title={metric.definition}>
      <span className="widget-label">{metric.label}</span>
      {showTemperature && <TemperatureCell temperature={metric.temperature} />}
      <span className="tnum widget-value-sm" style={{ color: metric.accent }}>
        {metric.text}
      </span>
    </span>
  );
});
