import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import type { ServiceSnapshot, ServicesSnapshot } from '@task-manager/telemetry-types';
import { formatCount } from '@task-manager/shared';
import { describeErrorCode } from '@shared/error-codes';
import { SERVICE_STATE_LABELS, startTypeLabel } from '@shared/services';
import { Field, PageShell } from '../components/primitives.js';
import { useHostInfo, useTelemetry } from '../lib/hooks.js';
import { useGoTo } from '../lib/navigation.js';

/**
 * Every Windows service: whether it is running, in which process, when
 * Windows starts it and as whom.
 *
 * The list is read on a thread of its own every five seconds, and each
 * service's configuration once a minute, only while this page is open. The
 * page acts on nothing itself: right-clicking asks the main process for the
 * menu, which checks what Windows allows before offering anything.
 */

const ROW_HEIGHT = 24;

type SortKey = 'displayName' | 'pid' | 'state' | 'startType' | 'group' | 'account';

interface ColumnSpec {
  id: Exclude<SortKey, 'displayName'>;
  label: string;
  width: number;
  align?: 'right';
  definition: string;
  cell: (service: ServiceSnapshot) => string;
}

/** Running first, stopped last, anything on its way in between. */
const STATE_ORDER: Record<ServiceSnapshot['state'], number> = {
  running: 0,
  startPending: 1,
  continuePending: 2,
  pausePending: 3,
  paused: 4,
  stopPending: 5,
  stopped: 6,
  unknown: 7,
};

const COLUMNS: ColumnSpec[] = [
  {
    id: 'pid',
    label: 'PID',
    width: 72,
    align: 'right',
    definition:
      'The process the service runs in. Services sharing an svchost.exe process share its PID.',
    cell: (service) => (service.pid === undefined ? '' : String(service.pid)),
  },
  {
    id: 'state',
    label: 'Status',
    width: 88,
    definition: 'Whether it is running, stopped, or on its way between the two.',
    cell: (service) => SERVICE_STATE_LABELS[service.state],
  },
  {
    id: 'startType',
    label: 'Startup type',
    width: 200,
    definition:
      'When Windows starts it. Automatic: at startup; Delayed Start: shortly after the other automatic services. Manual: when something asks for it. Trigger Start: also when an event it registered for happens, such as a device arriving. Disabled: never. Read once a minute.',
    cell: (service) => startTypeLabel(service) ?? '—',
  },
  {
    id: 'group',
    label: 'Group',
    width: 190,
    definition:
      'The svchost group it shares a process with: what follows -k in its command line. Empty for a service with a program of its own.',
    cell: (service) => service.group ?? '',
  },
  {
    id: 'account',
    label: 'Log on as',
    width: 190,
    definition: 'The account it runs as.',
    cell: (service) => service.account ?? '',
  },
];

const TABLE_WIDTH = 280 + COLUMNS.reduce((total, column) => total + column.width, 0);

function comparator(key: SortKey, descending: boolean) {
  const direction = descending ? -1 : 1;
  const text = (a: string, b: string): number => a.localeCompare(b, undefined, { sensitivity: 'base' });
  return (a: ServiceSnapshot, b: ServiceSnapshot): number => {
    let order = 0;
    switch (key) {
      case 'displayName':
        order = text(a.displayName, b.displayName);
        break;
      case 'pid':
        order = (a.pid ?? -1) - (b.pid ?? -1);
        break;
      case 'state':
        order = STATE_ORDER[a.state] - STATE_ORDER[b.state];
        break;
      case 'startType':
        order = text(startTypeLabel(a) ?? '', startTypeLabel(b) ?? '');
        break;
      case 'group':
        order = text(a.group ?? '', b.group ?? '');
        break;
      case 'account':
        order = text(a.account ?? '', b.account ?? '');
        break;
    }
    // Ties fall back to the name, so the order is stable between readings.
    return order !== 0 ? order * direction : text(a.displayName, b.displayName);
  };
}

const EMPTY_NAMES: ReadonlySet<string> = new Set();

export function ServicesPage({
  show = null,
  onShown,
}: {
  /** Services to select, by key name, asked for from outside the page. */
  show?: string[] | null;
  onShown?: () => void;
}): React.JSX.Element {
  const [sortKey, setSortKey] = useState<SortKey>('displayName');
  const [descending, setDescending] = useState(false);
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query);
  const [selected, setSelected] = useState<ReadonlySet<string>>(EMPTY_NAMES);
  const listRef = useRef<HTMLDivElement | null>(null);
  const elevated = useHostInfo()?.isElevated ?? true;
  const goTo = useGoTo();

  // Only this page needs the service list, so only this page asks for it.
  useEffect(() => {
    void window.taskManager.setServiceSubscription(true);
    return () => {
      void window.taskManager.setServiceSubscription(false);
    };
  }, []);

  // A new reading arrives every few seconds; the snapshots in between carry
  // the same one, and re-rendering 350 rows for them would be waste.
  const reading = useTelemetry(
    (snapshot) => snapshot?.services ?? null,
    (a: ServicesSnapshot | null, b: ServicesSnapshot | null) =>
      a?.readAtUnixMs === b?.readAtUnixMs && a?.services.length === b?.services.length,
  );
  const services = useMemo(() => reading?.services ?? [], [reading]);

  const filtered = useMemo(() => {
    const needle = deferredQuery.trim().toLowerCase();
    const matching = needle
      ? services.filter(
          (service) =>
            service.displayName.toLowerCase().includes(needle) ||
            service.name.toLowerCase().includes(needle) ||
            String(service.pid ?? '') === needle ||
            (service.description?.toLowerCase().includes(needle) ?? false) ||
            (service.group?.toLowerCase().includes(needle) ?? false) ||
            (service.account?.toLowerCase().includes(needle) ?? false) ||
            (service.binaryPath?.toLowerCase().includes(needle) ?? false),
        )
      : services;
    return [...matching].sort(comparator(sortKey, descending));
  }, [services, deferredQuery, sortKey, descending]);

  const running = useMemo(
    () => services.filter((service) => service.state === 'running').length,
    [services],
  );

  const onSort = useCallback((key: SortKey) => {
    setSortKey((current) => {
      if (current === key) {
        setDescending((value) => !value);
        return current;
      }
      setDescending(false);
      return key;
    });
  }, []);

  const reveal = useCallback((name: string) => {
    // After the render that shows it.
    requestAnimationFrame(() => {
      const row = listRef.current?.querySelector<HTMLElement>(`[data-name="${CSS.escape(name)}"]`);
      row?.scrollIntoView({ block: 'nearest' });
    });
  }, []);

  // Services asked for from the Processes page. They wait for a reading.
  useEffect(() => {
    if (!show || !reading) return;
    const present = show.filter((name) => services.some((service) => service.name === name));
    if (present.length > 0) {
      setSelected(new Set(present));
      if (!filtered.some((service) => present.includes(service.name))) setQuery('');
      requestAnimationFrame(() => {
        const row = listRef.current?.querySelector<HTMLElement>(
          `[data-name="${CSS.escape(present[0]!)}"]`,
        );
        row?.scrollIntoView({ block: 'center' });
      });
    }
    onShown?.();
  }, [show, reading, services, filtered, onShown]);

  const openMenu = useCallback(
    (name: string) => {
      const readAt = reading?.readAtUnixMs ?? 0;
      void window.taskManager.showServiceMenu({ name }).then((command) => {
        if (command?.kind === 'goToProcess') {
          goTo.process({ pid: command.pid, createdBeforeUnixMs: readAt });
        }
      });
    },
    [reading, goTo],
  );

  const single = selected.size === 1 ? [...selected][0]! : null;
  const detailed = single ? (services.find((service) => service.name === single) ?? null) : null;

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const order = filtered.map((service) => service.name);
      const index = single ? order.indexOf(single) : -1;
      const moveTo = (next: number): void => {
        const name = order[Math.max(0, Math.min(order.length - 1, next))];
        if (!name) return;
        setSelected(new Set([name]));
        reveal(name);
      };
      const page = Math.max(1, Math.floor(event.currentTarget.clientHeight / ROW_HEIGHT) - 1);
      switch (event.key) {
        case 'ArrowDown':
          moveTo(index + 1);
          break;
        case 'ArrowUp':
          moveTo(index < 0 ? 0 : index - 1);
          break;
        case 'PageDown':
          moveTo(index + page);
          break;
        case 'PageUp':
          moveTo(index - page);
          break;
        case 'Home':
          moveTo(0);
          break;
        case 'End':
          moveTo(order.length - 1);
          break;
        case 'Escape':
          setSelected(EMPTY_NAMES);
          break;
        case 'ContextMenu':
          if (single) openMenu(single);
          break;
        case 'F10':
          if (!event.shiftKey || !single) return;
          openMenu(single);
          break;
        default:
          return;
      }
      event.preventDefault();
    },
    [filtered, single, reveal, openMenu],
  );

  const failure = reading?.failureWin32Error;
  const failureCode = describeErrorCode('TM-2004');

  return (
    <PageShell
      title="Services"
      subtitle={
        <span>
          {formatCount(services.length)} services · {formatCount(running)} running
          {!elevated && (
            <>
              {' · starting and stopping most of them needs administrator rights ('}
              <button
                type="button"
                onClick={() => void window.taskManager.restartAsAdministrator()}
                title="Windows lets most services be started and stopped only by administrators. A few, such as your own per-user services, you can control without."
                className="text-accent hover:underline"
              >
                restart as administrator
              </button>
              {')'}
            </>
          )}
        </span>
      }
      actions={
        <>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Filter by name, PID, description, group or account"
            spellCheck={false}
            className="w-64 rounded border border-border-subtle bg-surface-2 px-2 py-1 text-xs text-text-primary outline-none placeholder:text-text-muted focus:border-accent-dim"
          />
          <button
            type="button"
            onClick={() => void window.taskManager.openServicesConsole()}
            title="Open the Windows Services console, where start types, recovery and log-on accounts can be changed."
            className="rounded border border-border-subtle bg-surface-2 px-2.5 py-1 text-[11px] text-text-primary hover:border-border-strong"
          >
            Open Services
          </button>
        </>
      }
    >
      {failure !== undefined && (
        <div className="mb-3 rounded border border-warn/30 bg-warn/5 p-2 text-[11px] text-text-secondary">
          The service list could not be read (Windows error {failure}). TM-2004 ·{' '}
          {failureCode?.title}. {failureCode?.action}
        </div>
      )}
      <div className="flex h-full min-h-0 gap-4">
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-lg border border-border-subtle bg-surface-1">
          <div className="shrink-0 overflow-hidden border-b border-border-subtle bg-surface-2">
            <div
              style={{ minWidth: TABLE_WIDTH }}
              className="flex text-[11px] font-medium text-text-secondary"
            >
              <HeaderCell
                label="Name"
                definition="The name Windows shows for the service, then its key name, which is what sc.exe and the registry use."
                active={sortKey === 'displayName'}
                descending={descending}
                onClick={() => onSort('displayName')}
                grow
              />
              {COLUMNS.map((column) => (
                <HeaderCell
                  key={column.id}
                  label={column.label}
                  definition={column.definition}
                  width={column.width}
                  alignRight={column.align === 'right'}
                  active={sortKey === column.id}
                  descending={descending}
                  onClick={() => onSort(column.id)}
                />
              ))}
            </div>
          </div>
          <div
            ref={listRef}
            role="listbox"
            aria-label="Services"
            tabIndex={0}
            onKeyDown={onKeyDown}
            onScroll={(event) => {
              const header = event.currentTarget.previousElementSibling;
              if (header) header.scrollLeft = event.currentTarget.scrollLeft;
            }}
            className="min-h-0 flex-1 overflow-auto outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent-dim"
          >
            <div style={{ minWidth: TABLE_WIDTH }}>
              {filtered.map((service) => (
                <ServiceRow
                  key={service.name}
                  service={service}
                  selected={selected.has(service.name)}
                  onClick={() => setSelected(new Set([service.name]))}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    setSelected(new Set([service.name]));
                    openMenu(service.name);
                  }}
                />
              ))}
            </div>
            {filtered.length === 0 && (
              <div className="p-6 text-center text-xs text-text-muted">
                {!reading
                  ? 'Reading the service list…'
                  : services.length === 0
                    ? 'No services were listed.'
                    : 'No matching services.'}
              </div>
            )}
          </div>
        </div>
        {detailed && (
          <ServiceDetails
            service={detailed}
            readAtUnixMs={reading?.readAtUnixMs ?? 0}
            onClose={() => setSelected(EMPTY_NAMES)}
          />
        )}
      </div>
    </PageShell>
  );
}

function HeaderCell({
  label,
  definition,
  width,
  alignRight,
  grow,
  active,
  descending,
  onClick,
}: {
  label: string;
  definition: string;
  width?: number;
  alignRight?: boolean;
  grow?: boolean;
  active: boolean;
  descending: boolean;
  onClick: () => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      title={definition}
      onClick={onClick}
      style={width === undefined ? undefined : { width }}
      className={`flex items-center gap-1 px-2 py-1.5 hover:text-text-primary ${
        grow ? 'min-w-0 flex-1' : 'shrink-0'
      } ${alignRight ? 'justify-end' : ''} ${active ? 'text-text-primary' : ''}`}
    >
      {label}
      {active && <span>{descending ? '▾' : '▴'}</span>}
    </button>
  );
}

function ServiceRow({
  service,
  selected,
  onClick,
  onContextMenu,
}: {
  service: ServiceSnapshot;
  selected: boolean;
  onClick: () => void;
  onContextMenu: (event: React.MouseEvent) => void;
}): React.JSX.Element {
  const stopped = service.state === 'stopped';
  return (
    <div
      role="option"
      aria-selected={selected}
      data-name={service.name}
      onClick={onClick}
      onContextMenu={onContextMenu}
      style={{ height: ROW_HEIGHT }}
      className={`flex cursor-default select-none items-center text-[12px] ${
        selected ? 'bg-accent-dim/25' : 'hover:bg-surface-2'
      }`}
    >
      <div className="flex min-w-0 flex-1 items-baseline gap-1.5 px-2" title={service.description}>
        {/* Both give way when the column is narrow, the key name first. */}
        <span className={`min-w-0 truncate ${stopped ? 'text-text-secondary' : ''}`}>
          {service.displayName}
        </span>
        <span className="min-w-0 shrink-4 truncate text-[11px] text-text-muted">{service.name}</span>
      </div>
      {COLUMNS.map((column) => (
        <div
          key={column.id}
          style={{ width: column.width }}
          className={`tnum shrink-0 truncate px-2 ${column.align === 'right' ? 'text-right' : ''} ${
            column.id === 'state' && !stopped ? 'text-text-primary' : 'text-text-secondary'
          }`}
        >
          {column.cell(service)}
        </div>
      ))}
    </div>
  );
}

function ServiceDetails({
  service,
  readAtUnixMs,
  onClose,
}: {
  service: ServiceSnapshot;
  readAtUnixMs: number;
  onClose: () => void;
}): React.JSX.Element {
  const goTo = useGoTo();
  const pid = service.pid;
  return (
    <aside className="flex w-96 shrink-0 flex-col overflow-hidden rounded-lg border border-border-subtle bg-surface-1">
      <div className="flex shrink-0 items-start justify-between gap-2 border-b border-border-subtle px-4 py-2">
        <div className="min-w-0">
          <div className="truncate text-[13px] font-medium">{service.displayName}</div>
          <div className="text-[11px] text-text-muted">{service.name}</div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded px-1.5 text-text-muted hover:bg-surface-3 hover:text-text-primary"
        >
          ✕
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3 text-[12px]">
        {service.startType === undefined && (
          <div className="mb-3 rounded border border-warn/30 bg-warn/5 p-2 text-[11px] text-text-secondary">
            Windows did not return this service's configuration, so its startup type, account and
            path are not known.
          </div>
        )}
        <Field label="Status" value={SERVICE_STATE_LABELS[service.state]} />
        <Field
          label="PID"
          value={
            pid === undefined ? (
              '—'
            ) : (
              <button
                type="button"
                onClick={() => goTo.process({ pid, createdBeforeUnixMs: readAtUnixMs })}
                title="Show the process on the Processes page"
                className="text-accent hover:underline"
              >
                {pid}
              </button>
            )
          }
        />
        <Field label="Startup type" value={startTypeLabel(service) ?? '—'} />
        <Field label="Log on as" value={service.account ?? '—'} />
        <Field label="Group" value={service.group ?? '—'} />
        {/* In full: the part that matters for svchost is at the end. */}
        <div className="border-b border-border-subtle/50 py-1">
          <div className="text-text-muted">Path to executable</div>
          <div className="selectable mt-0.5 font-mono text-xs break-all">
            {service.binaryPath ?? '—'}
          </div>
        </div>
        {service.description && (
          <p className="selectable mt-3 text-[12px] leading-relaxed text-text-secondary">
            {service.description}
          </p>
        )}
        <p className="mt-3 text-[11px] text-text-muted">
          Right-click it for Start, Stop and Restart.
        </p>
      </div>
    </aside>
  );
}
