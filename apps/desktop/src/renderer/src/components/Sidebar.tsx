import { memo } from 'react';
import { formatPercent } from '@task-manager/shared';
import { useHostInfo, useTelemetry } from '../lib/hooks.js';

export type PageId = 'overview' | 'cpu' | 'memory' | 'processes' | 'debug';

interface NavItem {
  id: PageId;
  label: string;
  accent: string;
}

const ITEMS: NavItem[] = [
  { id: 'overview', label: 'Overview', accent: 'var(--color-accent)' },
  { id: 'processes', label: 'Processes', accent: 'var(--color-text-secondary)' },
  { id: 'cpu', label: 'CPU', accent: 'var(--color-cpu)' },
  { id: 'memory', label: 'Memory', accent: 'var(--color-memory)' },
  { id: 'debug', label: 'Debug telemetry', accent: 'var(--color-warn)' },
];

export function Sidebar({
  current,
  onNavigate,
}: {
  current: PageId;
  onNavigate: (page: PageId) => void;
}): React.JSX.Element {
  const hostInfo = useHostInfo();

  return (
    <nav className="flex w-56 shrink-0 flex-col border-r border-border-subtle bg-surface-1">
      <div className="border-b border-border-subtle px-4 py-3">
        <div className="text-sm font-semibold tracking-tight">Task Manager</div>
        <div className="truncate text-[11px] text-text-muted" title={hostInfo?.computerName}>
          {hostInfo?.computerName ?? '—'}
        </div>
      </div>

      <ul className="flex-1 overflow-y-auto py-2">
        {ITEMS.map((item) => (
          <li key={item.id}>
            <button
              type="button"
              onClick={() => onNavigate(item.id)}
              className={`flex w-full items-center justify-between px-4 py-2 text-left text-[13px] transition-colors ${
                current === item.id
                  ? 'bg-surface-3 text-text-primary'
                  : 'text-text-secondary hover:bg-surface-2 hover:text-text-primary'
              }`}
            >
              <span className="flex items-center gap-2">
                <span
                  className="h-3.5 w-[3px] rounded-full"
                  style={{
                    background: current === item.id ? item.accent : 'transparent',
                  }}
                />
                {item.label}
              </span>
              <NavValue id={item.id} />
            </button>
          </li>
        ))}
      </ul>

      <SidebarFooter />
    </nav>
  );
}

/**
 * The small live value beside each nav entry.
 *
 * Each one subscribes to exactly one number, so a snapshot re-renders five tiny
 * leaves rather than the sidebar.
 */
const NavValue = memo(function NavValue({ id }: { id: PageId }) {
  const value = useTelemetry((snapshot) => {
    if (!snapshot) return null;
    switch (id) {
      case 'cpu':
        return snapshot.cpu.aggregateTimeUtilizationPercent ?? null;
      case 'memory':
        return snapshot.memory.physicalUtilizationPercent;
      case 'processes':
        // From the system-wide counter, which is present whether or not this
        // window is subscribed to the full process list.
        return snapshot.cpu.processCount ?? null;
      default:
        return null;
    }
  });

  if (value === null) return null;
  return (
    <span className="tnum text-[11px] text-text-muted">
      {id === 'processes' ? value : formatPercent(value, 0)}
    </span>
  );
});

function SidebarFooter(): React.JSX.Element {
  const hostInfo = useHostInfo();
  const collectionMs = useTelemetry(
    (snapshot) => snapshot?.diagnostics.totalDurationMs ?? null,
  );

  return (
    <div className="border-t border-border-subtle px-4 py-2 text-[11px] text-text-muted">
      <div className="flex justify-between">
        <span>Sample cost</span>
        <span className="tnum">
          {collectionMs === null ? '—' : `${collectionMs.toFixed(1)} ms`}
        </span>
      </div>
      <div className="flex justify-between">
        <span>Privileges</span>
        <span>{hostInfo?.isElevated ? 'Elevated' : 'Standard'}</span>
      </div>
    </div>
  );
}
