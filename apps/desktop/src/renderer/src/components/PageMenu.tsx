import { useRef, type ReactNode } from 'react';
import type { MenuItemSpec } from '@shared/menu';
import { WIDGET_METRICS, type WidgetMetricId } from '@shared/widget';
import { useNavigate } from '../lib/navigation.js';

/**
 * The right-click menu of a performance page: copy what the page shows as
 * text, show its metrics in the desktop widget, or go to their history.
 *
 * Wraps the page's content. Right-clicks something else has already handled -
 * selected text, which gets Copy - pass straight through.
 */
export function PageMenu({
  title,
  metrics,
  extra = [],
  onExtra,
  showHistory = true,
  children,
}: {
  /** Heads the copied text. */
  title: string;
  /** The widget metrics this page is about. */
  metrics: readonly WidgetMetricId[];
  /** Page-specific items, placed above Open History. */
  extra?: MenuItemSpec[];
  onExtra?: (id: string) => void;
  /** Offer Open History; off on the History page itself. */
  showHistory?: boolean;
  children: ReactNode;
}): React.JSX.Element {
  const content = useRef<HTMLDivElement | null>(null);
  const navigate = useNavigate();

  const open = async (): Promise<void> => {
    const widget = await window.taskManager.getWidgetSettings();
    const shown = (id: WidgetMetricId): boolean => widget.enabled && widget.metrics.includes(id);
    const items: MenuItemSpec[] = [{ id: 'copy', label: 'Copy page as text' }];
    if (metrics.length > 0) {
      items.push({ type: 'separator' });
      for (const id of metrics) {
        const label = WIDGET_METRICS.find((metric) => metric.id === id)?.label ?? id;
        items.push({
          type: 'checkbox',
          id: `widget:${id}`,
          label: `Show ${label} in the widget`,
          checked: shown(id),
        });
      }
    }
    items.push({ type: 'separator' }, ...extra);
    if (showHistory) items.push({ id: 'history', label: 'Open History' });
    // A trailing separator would draw as a stray line at the bottom.
    while (items.at(-1)?.type === 'separator') items.pop();

    const chosen = await window.taskManager.showMenu(items);
    if (chosen === 'copy') {
      const text = content.current?.innerText.trim() ?? '';
      const stamp = new Date().toLocaleString();
      void window.taskManager.copyToClipboard(`${title} · ${stamp}\n\n${text}`);
    } else if (chosen === 'history') {
      navigate('history');
    } else if (chosen?.startsWith('widget:')) {
      const id = chosen.slice('widget:'.length) as WidgetMetricId;
      if (shown(id)) {
        // The widget keeps at least one metric; removing the last is a no-op.
        const rest = widget.metrics.filter((metric) => metric !== id);
        if (rest.length > 0) void window.taskManager.setWidgetSettings({ metrics: rest });
      } else {
        // Showing a metric in a hidden widget would show nothing, so the
        // widget comes up with it.
        const metricsNow = widget.metrics.includes(id) ? widget.metrics : [...widget.metrics, id];
        void window.taskManager.setWidgetSettings({ metrics: metricsNow, enabled: true });
      }
    } else if (chosen) {
      onExtra?.(chosen);
    }
  };

  return (
    <div
      ref={content}
      onContextMenu={(event) => {
        if (event.defaultPrevented) return;
        if (window.getSelection()?.toString().trim()) return;
        event.preventDefault();
        void open();
      }}
    >
      {children}
    </div>
  );
}
