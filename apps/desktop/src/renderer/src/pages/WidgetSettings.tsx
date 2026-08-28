import { useEffect, useState } from 'react';
import {
  WIDGET_LAYOUTS,
  WIDGET_LAYOUT_LABELS,
  WIDGET_METRICS,
  WIDGET_OPACITY_MAX,
  WIDGET_OPACITY_MIN,
  type WidgetSettings as WidgetSettingsModel,
} from '@shared/widget';
import { Note, PageShell, Panel } from '../components/primitives.js';

/**
 * Settings for the desktop widget.
 *
 * Every change round-trips through the main process, which normalises and
 * persists it and pushes the result back, so this page always shows what was
 * actually stored rather than what was requested.
 */
export function WidgetSettingsPage(): React.JSX.Element {
  const [settings, setSettings] = useState<WidgetSettingsModel | null>(null);

  useEffect(() => {
    let cancelled = false;
    void window.taskManager.getWidgetSettings().then((value) => {
      if (!cancelled) setSettings(value);
    });
    const stop = window.taskManager.onWidgetSettings((value) => setSettings(value));
    return () => {
      cancelled = true;
      stop();
    };
  }, []);

  const update = (patch: Partial<WidgetSettingsModel>): void => {
    void window.taskManager.setWidgetSettings(patch).then(setSettings);
  };

  if (!settings) {
    return (
      <PageShell title="Widget">
        <Panel>Loading…</Panel>
      </PageShell>
    );
  }

  return (
    <PageShell
      title="Widget"
      subtitle="An always-on-top desktop overlay fed by the same telemetry as this window"
    >
      <div className="grid gap-4 xl:grid-cols-2">
        <Panel title="Display">
          <Toggle
            label="Show widget"
            checked={settings.enabled}
            onChange={(value) => update({ enabled: value })}
            hint="Opens a small frameless window. It keeps running when this window is closed."
          />

          <Field label="Layout">
            <div className="flex flex-wrap gap-1">
              {WIDGET_LAYOUTS.map((layout) => (
                <button
                  key={layout}
                  type="button"
                  onClick={() => update({ layout })}
                  className={`rounded border px-2 py-1 text-[11px] ${
                    settings.layout === layout
                      ? 'border-accent-dim bg-surface-3 text-text-primary'
                      : 'border-border-subtle bg-surface-2 text-text-muted hover:text-text-secondary'
                  }`}
                >
                  {WIDGET_LAYOUT_LABELS[layout]}
                </button>
              ))}
            </div>
          </Field>

          <Field label={`Opacity — ${Math.round(settings.opacity * 100)}%`}>
            <input
              type="range"
              min={WIDGET_OPACITY_MIN * 100}
              max={WIDGET_OPACITY_MAX * 100}
              value={Math.round(settings.opacity * 100)}
              onChange={(event) => update({ opacity: Number(event.target.value) / 100 })}
              className="w-full"
            />
          </Field>
        </Panel>

        <Panel title="Metrics" hint="Only metrics the collector actually gathers can be shown">
          <div className="grid grid-cols-2 gap-x-4">
            {WIDGET_METRICS.map((metric) => {
              const checked = settings.metrics.includes(metric.id);
              const last = checked && settings.metrics.length === 1;
              return (
                <label
                  key={metric.id}
                  title={
                    metric.collected
                      ? last
                        ? `${metric.definition}\n\nAt least one metric must stay selected.`
                        : metric.definition
                      : 'Not yet collected, so it cannot be displayed. Showing it blank would imply a measurement that was never taken.'
                  }
                  className={`flex items-center gap-2 py-1 text-[12px] ${
                    metric.collected ? 'cursor-pointer' : 'cursor-not-allowed opacity-45'
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={!metric.collected || last}
                    onChange={() =>
                      update({
                        metrics: checked
                          ? settings.metrics.filter((id) => id !== metric.id)
                          : [...settings.metrics, metric.id],
                      })
                    }
                  />
                  <span>{metric.label}</span>
                  {!metric.collected && (
                    <span className="text-[10px] text-text-muted">not yet collected</span>
                  )}
                </label>
              );
            })}
          </div>
        </Panel>

        <Panel title="Behaviour">
          <Toggle
            label="Always on top"
            checked={settings.alwaysOnTop}
            onChange={(value) => update({ alwaysOnTop: value })}
          />
          <Toggle
            label="Click through"
            checked={settings.clickThrough}
            onChange={(value) => update({ clickThrough: value })}
            hint="Mouse events pass to whatever is underneath. The widget cannot be right-clicked while this is on — turn it off from here or from the tray icon."
          />
          <Toggle
            label="Lock position"
            checked={settings.locked}
            onChange={(value) => update({ locked: value })}
            hint="Stops the widget being dragged."
          />
          <Toggle
            label="Snap to edges"
            checked={settings.snapToEdges}
            onChange={(value) => update({ snapToEdges: value })}
            hint="Snaps to the nearest screen edge or corner when released."
          />
          <Toggle
            label="Show temperatures"
            checked={settings.showTemperatures}
            onChange={(value) => update({ showTemperatures: value })}
            hint="Adds a temperature between each metric's label and its value, and widens the widget to fit it. Metrics with no readable sensor — memory and network — show an em dash."
          />
          <Note>
            Only three temperature sources are readable without administrator rights, and the
            widget shows those three and nothing else. GPU temperature comes from NVIDIA&rsquo;s
            own NVML and drive temperature from the device&rsquo;s SMART sensor, so both mean
            exactly what they say. The reading beside CPU is an ACPI thermal zone: a real live
            sensor, but what the firmware attached it to is undocumented, so it is marked with a
            dotted underline and is <em>not</em> labelled a CPU package temperature. Hover any
            reading to see which sensor produced it.
          </Note>
        </Panel>

        <Panel title="Position">
          <div className="text-[12px] text-text-secondary">
            {settings.bounds
              ? `${settings.bounds.width} x ${settings.bounds.height} at ${settings.bounds.x}, ${settings.bounds.y}`
              : 'Not placed yet — it will open at the top right of the primary display.'}
          </div>
          <Note>
            The position is saved as you move it and restored on the next launch. If the display
            it was on has gone, or a resolution or scaling change would leave it off-screen, it
            is moved back somewhere visible rather than restored where it cannot be reached.
          </Note>
        </Panel>
      </div>

      <Note>
        The widget renders the same snapshots this window does and calculates nothing of its own,
        so the two can never disagree about a number. Only the Top consumers layout needs the
        process list; with any other layout the collector skips process enumeration entirely.
      </Note>
    </PageShell>
  );
}

function Toggle({
  label,
  checked,
  onChange,
  hint,
}: {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  hint?: string;
}): React.JSX.Element {
  return (
    <label className="flex cursor-pointer items-start gap-2 py-1.5" title={hint}>
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-0.5"
      />
      <span className="min-w-0">
        <span className="text-[12px]">{label}</span>
        {hint && <span className="block text-[11px] leading-snug text-text-muted">{hint}</span>}
      </span>
    </label>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="mt-3">
      <div className="mb-1 text-[11px] uppercase tracking-wide text-text-muted">{label}</div>
      {children}
    </div>
  );
}
