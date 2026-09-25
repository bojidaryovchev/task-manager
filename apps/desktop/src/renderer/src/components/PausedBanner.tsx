import { usePaused, useTelemetry } from '../lib/hooks.js';

/**
 * Says, while updates are paused, that every number on screen is frozen and
 * from when. A frozen number that looks live would be a wrong number.
 */
export function PausedBanner(): React.JSX.Element | null {
  const paused = usePaused();
  const at = useTelemetry((snapshot) => snapshot?.wallClockUnixMs ?? null);
  if (!paused) return null;
  return (
    <div
      role="status"
      className="flex shrink-0 items-center justify-between gap-4 border-b border-warn/30 bg-warn/10 px-6 py-2 text-[12px]"
    >
      <span className="text-text-secondary">
        <span className="font-medium text-text-primary">Updates are paused.</span> Everything on
        screen is from {at === null ? 'the moment of pausing' : new Date(at).toLocaleTimeString()};
        measuring and recording to history carry on.
      </span>
      <button
        type="button"
        onClick={() => void window.taskManager.setAppSettings({ paused: false })}
        className="shrink-0 rounded border border-border-subtle bg-surface-2 px-2.5 py-1 text-[11px] text-text-primary hover:border-border-strong"
      >
        Resume
      </button>
    </div>
  );
}
