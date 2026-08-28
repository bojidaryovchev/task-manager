import { useEffect, useState } from 'react';
import { telemetryStore } from './lib/telemetry-store.js';
import { useNativeStatus } from './lib/hooks.js';
import { Sidebar, type PageId } from './components/Sidebar.js';
import { OverviewPage } from './pages/Overview.js';
import { CpuPage } from './pages/Cpu.js';
import { MemoryPage } from './pages/Memory.js';
import { ProcessesPage } from './pages/Processes.js';
import { ApplicationsPage } from './pages/Applications.js';
import { DebugPage } from './pages/Debug.js';

export function App(): React.JSX.Element {
  const [page, setPage] = useState<PageId>('overview');
  const status = useNativeStatus();

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
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  if (status && !status.loaded) {
    return <NativeUnavailable message={status.error ?? 'Unknown error'} />;
  }

  return (
    <div className="flex h-full w-full bg-surface-0">
      <Sidebar current={page} onNavigate={setPage} />
      <main className="min-w-0 flex-1 overflow-hidden">
        {page === 'overview' && <OverviewPage />}
        {page === 'cpu' && <CpuPage />}
        {page === 'memory' && <MemoryPage />}
        {page === 'processes' && <ProcessesPage />}
        {page === 'applications' && <ApplicationsPage />}
        {page === 'debug' && <DebugPage />}
      </main>
    </div>
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
