import { memo } from 'react';
import type { WidgetSettings } from '@shared/widget';
import { useWidgetMetric } from '../metrics.js';

/**
 * One line, values only: `CPU 14%  |  RAM 92%`.
 *
 * The smallest useful shape — sized to sit on a taskbar edge without covering
 * anything.
 */
export function MinimalLayout({ settings }: { settings: WidgetSettings }): React.JSX.Element {
  return (
    <div className="flex h-full items-center gap-2 px-2.5">
      {settings.metrics.map((id, index) => (
        <span key={id} className="flex items-center gap-2">
          {index > 0 && <span className="widget-divider" />}
          <MinimalMetric id={id} />
        </span>
      ))}
    </div>
  );
}

const MinimalMetric = memo(function MinimalMetric({
  id,
}: {
  id: WidgetSettings['metrics'][number];
}) {
  const metric = useWidgetMetric(id);
  return (
    <span className="flex items-baseline gap-1" title={metric.definition}>
      <span className="widget-label">{metric.label}</span>
      <span className="tnum widget-value-sm" style={{ color: metric.accent }}>
        {metric.text}
      </span>
    </span>
  );
});
