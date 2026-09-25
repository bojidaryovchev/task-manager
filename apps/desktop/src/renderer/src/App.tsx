import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AppCommand } from '@shared/ipc';
import { telemetryStore } from './lib/telemetry-store.js';
import { useNativeStatus } from './lib/hooks.js';
import { Sidebar, type PageId } from './components/Sidebar.js';
import { StartupBanner } from './components/StartupBanner.js';
import { OverviewPage } from './pages/Overview.js';
import { CpuPage } from './pages/Cpu.js';
import { MemoryPage } from './pages/Memory.js';
import { ProcessesPage } from './pages/Processes.js';
import { ApplicationsPage } from './pages/Applications.js';
import { DebugPage } from './pages/Debug.js';
import { WidgetSettingsPage } from './pages/WidgetSettings.js';
import { ExportPage } from './pages/Export.js';
import { DiskPage, GpuPage, NetworkPage } from './pages/Devices.js';
import { HistoryPage } from './pages/History.js';
import { RunTaskDialog } from './components/RunTaskDialog.js';
import { PausedBanner } from './components/PausedBanner.js';
import { ActivityBanner } from './components/ActivityBanner.js';
import { SettingsPage } from './pages/Settings.js';
import { ServicesPage } from './pages/Services.js';
import { StartupPage } from './pages/Startup.js';
import {
  GoToContext,
  NavigationContext,
  type GoTo,
  type ProcessTarget,
} from './lib/navigation.js';

export function App(): React.JSX.Element {
  const [page, setPage] = useState<PageId>('overview');
  const [runTask, setRunTask] = useState(false);
  // A row to select on the Processes or Services page, until the page has
  // taken it.
  const [showProcess, setShowProcess] = useState<ProcessTarget | null>(null);
  const onProcessShown = useCallback(() => setShowProcess(null), []);
  const [showServices, setShowServices] = useState<string[] | null>(null);
  const onServicesShown = useCallback(() => setShowServices(null), []);
  const goTo = useMemo<GoTo>(
    () => ({
      process: (target) => {
        setPage('processes');
        setShowProcess(target);
      },
      services: (names) => {
        setPage('services');
        setShowServices(names);
      },
    }),
    [],
  );
  const status = useNativeStatus();

  // Commands from elsewhere, such as the tray's Run new task. One sent before
  // this page was listening is collected on arrival.
  useEffect(() => {
    const handle = (command: AppCommand | null): void => {
      if (command?.kind === 'runNewTask') setRunTask(true);
      if (command?.kind === 'showProcess') goTo.process({ key: command.key });
    };
    const stop = window.taskManager.onAppCommand((command) => {
      handle(command);
      void window.taskManager.takePendingAppCommand();
    });
    void window.taskManager.takePendingAppCommand().then(handle);
    return stop;
  }, [goTo]);

  useEffect(() => {
    const api = window.taskManager;
    let cancelled = false;

    void (async () => {
      const [hostInfo, nativeStatus, config, latest] = await Promise.all([
        api.getHostInfo(),
        api.getNativeStatus(),
        api.getConfig(),
        api.getLatestSnapshot(),
      ]);
      if (cancelled) return;
      telemetryStore.setHostInfo(hostInfo);
      telemetryStore.setNativeStatus(nativeStatus);
      telemetryStore.setConfig(config);
      if (latest) telemetryStore.ingest(latest);
    })();

    const unsubscribe = api.onSnapshot((snapshot) => telemetryStore.ingest(snapshot));
    const stopPaused = api.onPaused((paused) => telemetryStore.setPaused(paused));
    void api.getAppSettings().then((settings) => {
      if (!cancelled && settings) telemetryStore.setPaused(settings.paused);
    });

    // The main process stops pushing to a hidden window, so re-prime on return
    // rather than waiting a full interval with stale values on screen.
    const onVisible = (): void => {
      if (document.visibilityState !== 'visible') return;
      void api.getLatestSnapshot().then((latest) => {
        if (latest) telemetryStore.ingest(latest);
      });
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      cancelled = true;
      unsubscribe();
      stopPaused();
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  if (status && !status.loaded) {
    return <NativeUnavailable message={status.error ?? 'Unknown error'} />;
  }

  return (
    <NavigationContext.Provider value={setPage}>
      <GoToContext.Provider value={goTo}>
        <div className="flex h-full w-full bg-surface-0">
          <Sidebar current={page} onNavigate={setPage} />
          <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
            <StartupBanner />
            <PausedBanner />
            <ActivityBanner />
            {page === 'overview' && <OverviewPage />}
            {page === 'cpu' && <CpuPage />}
            {page === 'memory' && <MemoryPage />}
            {page === 'processes' && (
              <ProcessesPage
                onRunNewTask={() => setRunTask(true)}
                show={showProcess}
                onShown={onProcessShown}
              />
            )}
            {page === 'applications' && <ApplicationsPage />}
            {page === 'services' && (
              <ServicesPage show={showServices} onShown={onServicesShown} />
            )}
            {page === 'startup' && <StartupPage />}
            {page === 'gpu' && <GpuPage />}
            {page === 'disk' && <DiskPage />}
            {page === 'network' && <NetworkPage />}
            {page === 'history' && <HistoryPage />}
            {page === 'widget' && <WidgetSettingsPage />}
            {page === 'export' && <ExportPage />}
            {page === 'settings' && <SettingsPage />}
            {page === 'debug' && <DebugPage />}
          </main>
          {runTask && <RunTaskDialog onClose={() => setRunTask(false)} />}
        </div>
      </GoToContext.Provider>
    </NavigationContext.Provider>
  );
}

/**
 * Shown when the native module is missing. The application says exactly what is
 * wrong instead of rendering an empty shell with zeroes in it.
 */
function NativeUnavailable({ message }: { message: string }): React.JSX.Element {
  return (
    <div className="flex h-full w-full items-center justify-center bg-surface-0 p-8">
      <div className="max-w-2xl rounded-lg border border-danger/40 bg-surface-1 p-6">
        <h1 className="mb-2 text-lg font-semibold text-danger">
          Native telemetry unavailable
        </h1>
        <p className="mb-4 text-text-secondary">
          Task Manager reads every metric from its native Windows module. Without it there
          is nothing real to display, so no values are shown.
        </p>
        <pre className="selectable overflow-auto rounded border border-border-subtle bg-surface-0 p-3 font-mono text-xs text-text-muted">
          {message}
        </pre>
      </div>
    </div>
  );
}
