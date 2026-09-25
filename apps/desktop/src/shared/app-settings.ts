/**
 * The application settings the Settings page, the tray menu and the main
 * process share. One view of them, so a change made in one place shows in the
 * others at once.
 */

/** How often everything on screen updates. */
export type UpdateSpeed = 'fast' | 'normal' | 'slow';

/** The sampling interval for each speed. Fast is what the application has always used. */
export const UPDATE_INTERVALS_MS: Record<UpdateSpeed, number> = {
  fast: 500,
  normal: 1_000,
  slow: 4_000,
};

export const UPDATE_SPEED_LABELS: Record<UpdateSpeed, string> = {
  fast: 'Fast (twice a second)',
  normal: 'Normal (every second)',
  slow: 'Slow (every 4 seconds)',
};

export interface AppSettingsView {
  updateSpeed: UpdateSpeed;
  /**
   * Nothing on screen updates while paused. Measuring and recording to
   * history carry on, so resuming loses nothing. Never kept across restarts.
   */
  paused: boolean;
  /** The main window stays above other windows. */
  alwaysOnTop: boolean;
  /**
   * Start with Windows, straight into the tray. Null where this build cannot
   * register itself, which is the development build.
   */
  startWithWindows: boolean | null;
  /** Ask before ending a single process. */
  confirmEnd: boolean;
  liveTrayIcon: boolean;
  closeToTray: boolean;
  hideWhenMinimized: boolean;
}

/** The speed an interval corresponds to, for settings written as a number. */
export function speedForInterval(intervalMs: number): UpdateSpeed {
  const entries = Object.entries(UPDATE_INTERVALS_MS) as [UpdateSpeed, number][];
  return entries.find(([, interval]) => interval === intervalMs)?.[0] ?? 'fast';
}

/**
 * Accept a partial change from a renderer. Unknown keys and values of the
 * wrong type are dropped, never coerced.
 */
export function readAppSettingsPatch(value: unknown): Partial<AppSettingsView> {
  if (typeof value !== 'object' || value === null) return {};
  const source = value as Record<string, unknown>;
  const patch: Partial<AppSettingsView> = {};
  if (typeof source.updateSpeed === 'string' && source.updateSpeed in UPDATE_INTERVALS_MS) {
    patch.updateSpeed = source.updateSpeed as UpdateSpeed;
  }
  for (const key of [
    'paused',
    'alwaysOnTop',
    'confirmEnd',
    'liveTrayIcon',
    'closeToTray',
    'hideWhenMinimized',
  ] as const) {
    if (typeof source[key] === 'boolean') patch[key] = source[key];
  }
  if (typeof source.startWithWindows === 'boolean') patch.startWithWindows = source.startWithWindows;
  return patch;
}
