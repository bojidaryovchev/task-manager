import { useEffect, useState } from 'react';
import {
  UPDATE_SPEED_LABELS,
  UPDATE_INTERVALS_MS,
  type AppSettingsView,
  type UpdateSpeed,
} from '@shared/app-settings';
import { Note, PageShell, Panel } from '../components/primitives.js';

/**
 * The application's own settings. Everything here is also in the tray menu,
 * and a change made in either place shows in the other at once.
 */
export function SettingsPage(): React.JSX.Element {
  const [settings, setSettings] = useState<AppSettingsView | null>(null);

  useEffect(() => {
    void window.taskManager.getAppSettings().then(setSettings);
    return window.taskManager.onAppSettings(setSettings);
  }, []);

  if (!settings) {
    return (
      <PageShell title="Settings">
        <Panel>Loading…</Panel>
      </PageShell>
    );
  }

  const update = (patch: Partial<AppSettingsView>): void => {
    void window.taskManager.setAppSettings(patch).then(setSettings);
  };

  return (
    <PageShell title="Settings" subtitle="Also in the tray menu, under Options and Update speed">
      <div className="grid gap-4 xl:grid-cols-2">
        <Panel title="Updates">
          <div role="radiogroup" aria-label="Update speed" className="flex flex-col gap-1">
            {(Object.keys(UPDATE_INTERVALS_MS) as UpdateSpeed[]).map((speed) => (
              <label key={speed} className="flex cursor-pointer items-center gap-2 py-1 text-[12px]">
                <input
                  type="radio"
                  name="update-speed"
                  checked={settings.updateSpeed === speed}
                  onChange={() => update({ updateSpeed: speed })}
                  className="accent-accent"
                />
                {UPDATE_SPEED_LABELS[speed]}
              </label>
            ))}
          </div>
          <Toggle
            label="Pause updates"
            checked={settings.paused}
            onChange={(paused) => update({ paused })}
            hint="Freezes every number on screen, the widget and the tray icon. Measuring and recording to history carry on, so resuming loses nothing."
          />
          <Note>
            Each update is one sample: CPU and rates are averaged over the time since the last
            one, so a slower speed smooths the numbers as well as costing less. History records
            every sample for the last ten minutes, so a slower speed also means fewer recent
            points there; older history is kept at five-second, one-minute and five-minute
            resolution either way.
          </Note>
        </Panel>

        <Panel title="Window">
          <Toggle
            label="Always on top"
            checked={settings.alwaysOnTop}
            onChange={(alwaysOnTop) => update({ alwaysOnTop })}
            hint="Keeps this window above other windows."
          />
          <Toggle
            label="Close to tray"
            checked={settings.closeToTray}
            onChange={(closeToTray) => update({ closeToTray })}
            hint="Closing the window leaves Task Manager running in the tray, with the window's memory released."
          />
          <Toggle
            label="Hide when minimized"
            checked={settings.hideWhenMinimized}
            onChange={(hideWhenMinimized) => update({ hideWhenMinimized })}
            hint="Minimising takes the window off the taskbar; the tray icon brings it back."
          />
          <Toggle
            label="Show usage in tray icon"
            checked={settings.liveTrayIcon}
            onChange={(liveTrayIcon) => update({ liveTrayIcon })}
            hint="CPU, memory and GPU as three live bars in the notification area."
          />
        </Panel>

        <Panel title="Starting">
          <Toggle
            label="Start with Windows"
            checked={settings.startWithWindows === true}
            disabled={settings.startWithWindows === null}
            onChange={(startWithWindows) => update({ startWithWindows })}
            hint={
              settings.startWithWindows === null
                ? 'Only the packaged Task Manager, started normally rather than as administrator, can register itself to start with Windows.'
                : 'Starts when you sign in, straight into the tray, without putting a window in front of you.'
            }
          />
        </Panel>

        <Panel title="Processes">
          <Toggle
            label="Ask before ending a process"
            checked={settings.confirmEnd}
            onChange={(confirmEnd) => update({ confirmEnd })}
            hint="Ending several processes, a process tree or a whole application always asks, because one slip there ends far more than was meant."
          />
        </Panel>
      </div>
    </PageShell>
  );
}

function Toggle({
  label,
  checked,
  onChange,
  hint,
  disabled,
}: {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  hint?: string;
  disabled?: boolean;
}): React.JSX.Element {
  return (
    <label
      className={`flex items-start gap-2 py-1.5 ${disabled ? 'cursor-not-allowed opacity-55' : 'cursor-pointer'}`}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-0.5 accent-accent"
      />
      <span className="min-w-0">
        <span className="text-[12px]">{label}</span>
        {hint && <span className="block text-[11px] leading-snug text-text-muted">{hint}</span>}
      </span>
    </label>
  );
}
