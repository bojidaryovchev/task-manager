import { useEffect, useState } from 'react';

/**
 * Says what a long action is doing while it runs: a memory dump being
 * written, a service starting. Without it, the seconds these take would look
 * like nothing happening.
 */
export function ActivityBanner(): React.JSX.Element | null {
  const [label, setLabel] = useState<string | null>(null);
  useEffect(() => window.taskManager.onActivity(setLabel), []);
  if (!label) return null;
  return (
    <div
      role="status"
      className="shrink-0 border-b border-border-subtle bg-surface-2 px-6 py-2 text-[12px] text-text-secondary"
    >
      {label}
    </div>
  );
}
