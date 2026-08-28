import type { WidgetTemperature } from './metrics.js';

/**
 * The temperature column, between a metric's label and its value.
 *
 * Three rules this component exists to enforce, in one place, for every layout:
 *
 * 1. **A missing sensor is an em dash, not a blank and not a zero.** RAM has no
 *    temperature on Windows at all; a non-NVIDIA GPU has none we can read. The
 *    column still occupies its width so the values stay aligned, and the dash
 *    says "not measured" the same way it does everywhere else in the app.
 * 2. **An indirect reading is marked.** The ACPI thermal zone shown beside CPU
 *    is a real live sensor whose physical attachment is defined by firmware and
 *    documented nowhere. It gets a dotted underline, so it does not read as a
 *    CPU package temperature — because it is not one.
 * 3. **Colour only against a vendor threshold.** A reading turns amber only when
 *    it is at or above a limit the vendor itself published. Nothing here invents
 *    a "hot" level for a sensor that arrived without one.
 */
export function TemperatureCell({
  temperature,
  className = '',
}: {
  temperature: WidgetTemperature | null;
  className?: string;
}): React.JSX.Element {
  if (!temperature) {
    return (
      <span
        className={`tnum widget-temp widget-temp-absent ${className}`}
        title="No temperature sensor is readable for this metric."
      >
        —
      </span>
    );
  }
  return (
    <span
      className={[
        'tnum widget-temp',
        temperature.indirect ? 'widget-temp-indirect' : '',
        temperature.overThreshold ? 'widget-temp-hot' : '',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
      title={temperature.detail}
    >
      {Math.round(temperature.celsius)}°
    </span>
  );
}
