import { useEffect, useState } from 'react';
import type { WidgetSettings } from '@shared/widget';
import { telemetryStore } from '../lib/telemetry-store.js';
import { useNativeStatus } from '../lib/hooks.js';
import { MinimalLayout } from './layouts/MinimalLayout.js';
import { CompactLayout } from './layouts/CompactLayout.js';
import { PerformanceLayout } from './layouts/PerformanceLayout.js';
import { TopConsumersLayout } from './layouts/TopConsumersLayout.js';

/**
 * The desktop widget.
 *
 * Consumes exactly the same snapshot stream as the main window through the same
 * preload bridge, and computes nothing. Every number it shows was produced by
 * the native collector, which is what guarantees the widget and the main window
 * can never disagree.
 */
export function Widget(): React.JSX.Element | null {
  const [settings, setSettings] = useState<WidgetSettings | null>(null);
  const status = useNativeStatus();

  useEffect(() => {
    const api = window.taskManager;
    let cancelled = false;

    void (async () => {
      const [widgetSettings, nativeStatus, latest] = await Promise.all([
        api.getWidgetSettings(),
        api.getNativeStatus(),
        api.getLatestSnapshot(),
      ]);
      if (cancelled) return;
      setSettings(widgetSettings);
      telemetryStore.setNativeStatus(nativeStatus);
      if (latest) telemetryStore.ingest(latest);
    })();

    const stopSnapshots = api.onSnapshot((snapshot) => telemetryStore.ingest(snapshot));
    const stopSettings = api.onWidgetSettings((next) => setSettings(next));

    return () => {
      cancelled = true;
      stopSnapshots();
      stopSettings();
    };
  }, []);

  // The top-consumers layout is the only one that needs the process list, so it
  // is the only one that asks for it. Every other layout leaves the collector
  // skipping process enumeration entirely.
  useEffect(() => {
    if (!settings) return;
    const wanted = settings.layout === 'topConsumers';
    void window.taskManager.setProcessSubscription(wanted);
    return () => {
      if (wanted) void window.taskManager.setProcessSubscription(false);
    };
  }, [settings?.layout]);

  if (!settings) return null;

  return (
    <div
      className="widget-root"
      onContextMenu={(event) => {
        event.preventDefault();
        // Screen coordinates, so the menu opens where the pointer is even
        // though the window is frameless and may sit anywhere.
        void window.taskManager.showWidgetMenu(event.screenX, event.screenY);
      }}
      onDoubleClick={() => void window.taskManager.showMainWindow()}
      style={{
        // Dragging is a window-level gesture; locking simply stops the drag
        // region from being draggable rather than moving the window back.
        WebkitAppRegion: settings.locked ? 'no-drag' : 'drag',
      } as React.CSSProperties}
    >
      {status && !status.loaded ? (
        <div className="widget-unavailable">Telemetry unavailable</div>
      ) : (
        <LayoutFor settings={settings} />
      )}
    </div>
  );
}

function LayoutFor({ settings }: { settings: WidgetSettings }): React.JSX.Element {
  switch (settings.layout) {
    case 'minimal':
      return <MinimalLayout settings={settings} />;
    case 'compact':
      return <CompactLayout settings={settings} />;
    case 'performance':
      return <PerformanceLayout settings={settings} />;
    case 'topConsumers':
      return <TopConsumersLayout />;
  }
}
