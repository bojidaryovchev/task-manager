import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  STARTUP_SOURCE_LABELS,
  startupDisplayName,
  type StartupItem,
} from '@shared/startup';
import { PageShell } from '../components/primitives.js';

/**
 * What Windows starts when you sign in: the Run keys and the Startup folders,
 * with whether each is turned on.
 *
 * Read when the page opens, when the window comes back into view, and after
 * every change, rather than on a timer: these change when something is
 * installed, not from one second to the next.
 */

const ROW_HEIGHT = 26;

type SortKey = 'name' | 'publisher' | 'status' | 'location';

interface ColumnSpec {
  id: SortKey | 'command';
  label: string;
  width: number;
  definition: string;
}

const COLUMNS: ColumnSpec[] = [
  {
    id: 'publisher',
    label: 'Publisher',
    width: 190,
    definition: "The company named in the program's version information.",
  },
  {
    id: 'status',
    label: 'Status',
    width: 190,
    definition:
      'Whether Windows starts it at sign-in. Windows records this in a form it does not document; the forms it has been seen to write are read, and anything else shows as Unknown rather than as either.',
  },
  {
    id: 'location',
    label: 'Location',
    width: 200,
    definition:
      'Where it is registered: the Run key in the registry, for you or for every user of this PC, or a Startup folder.',
  },
  {
    id: 'command',
    label: 'Command',
    width: 340,
    definition: 'What Windows runs.',
  },
];

const TABLE_WIDTH = 300 + COLUMNS.reduce((total, column) => total + column.width, 0);

const STATUS_ORDER: Record<StartupItem['status'], number> = { enabled: 0, disabled: 1, unknown: 2 };

function idOf(item: StartupItem): string {
  return `${item.source}\u0000${item.name}`;
}

export function StartupPage(): React.JSX.Element {
  const [items, setItems] = useState<StartupItem[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>('name');
  const [descending, setDescending] = useState(false);

  const load = useCallback(() => {
    void window.taskManager.getStartupItems().then(setItems);
  }, []);

  useEffect(() => {
    load();
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') load();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [load]);

  const sorted = useMemo(() => {
    const text = (a: string, b: string): number => a.localeCompare(b, undefined, { sensitivity: 'base' });
    const direction = descending ? -1 : 1;
    return [...(items ?? [])].sort((a, b) => {
      let order = 0;
      switch (sortKey) {
        case 'name':
          order = text(startupDisplayName(a), startupDisplayName(b));
          break;
        case 'publisher':
          order = text(a.publisher ?? '', b.publisher ?? '');
          break;
        case 'status':
          order = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
          break;
        case 'location':
          order = text(STARTUP_SOURCE_LABELS[a.source], STARTUP_SOURCE_LABELS[b.source]);
          break;
      }
      return order !== 0 ? order * direction : text(startupDisplayName(a), startupDisplayName(b));
    });
  }, [items, sortKey, descending]);

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

  const chosen = sorted.find((item) => idOf(item) === selected) ?? null;
  const enabledCount = (items ?? []).filter((item) => item.status === 'enabled').length;

  const openMenu = useCallback(
    (item: StartupItem) => {
      void window.taskManager
        .showStartupMenu({ source: item.source, name: item.name })
        .then((changed) => {
          if (changed) load();
        });
    },
    [load],
  );

  const toggle = useCallback(() => {
    if (!chosen) return;
    void window.taskManager
      .setStartupItemEnabled({ source: chosen.source, name: chosen.name }, chosen.status !== 'enabled')
      .then((changed) => {
        if (changed) load();
      });
  }, [chosen, load]);

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const index = chosen ? sorted.indexOf(chosen) : -1;
      const moveTo = (next: number): void => {
        const item = sorted[Math.max(0, Math.min(sorted.length - 1, next))];
        if (item) setSelected(idOf(item));
      };
      switch (event.key) {
        case 'ArrowDown':
          moveTo(index + 1);
          break;
        case 'ArrowUp':
          moveTo(index < 0 ? 0 : index - 1);
          break;
        case 'Home':
          moveTo(0);
          break;
        case 'End':
          moveTo(sorted.length - 1);
          break;
        case 'Escape':
          setSelected(null);
          break;
        case 'ContextMenu':
          if (chosen) openMenu(chosen);
          break;
        case 'F10':
          if (!event.shiftKey || !chosen) return;
          openMenu(chosen);
          break;
        default:
          return;
      }
      event.preventDefault();
    },
    [chosen, sorted, openMenu],
  );

  return (
    <PageShell
      title="Startup apps"
      subtitle={
        items
          ? `${items.length} startup apps · ${enabledCount} enabled · Store apps that start themselves are not listed`
          : 'Reading what starts with Windows…'
      }
      actions={
        <button
          type="button"
          onClick={toggle}
          disabled={!chosen}
          title="Whether Windows starts the selected app at your next sign-in. Nothing starts or stops now."
          className="rounded border border-border-subtle bg-surface-2 px-2.5 py-1 text-[11px] text-text-primary hover:border-border-strong disabled:cursor-default disabled:text-text-muted disabled:hover:border-border-subtle"
        >
          {chosen?.status === 'enabled' ? 'Disable' : 'Enable'}
        </button>
      }
    >
      <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-lg border border-border-subtle bg-surface-1">
        <div className="shrink-0 overflow-hidden border-b border-border-subtle bg-surface-2">
          <div
            style={{ minWidth: TABLE_WIDTH }}
            className="flex text-[11px] font-medium text-text-secondary"
          >
            <HeaderCell
              label="Name"
              definition="The program's own name for itself, from its version information, then the name it is registered under."
              active={sortKey === 'name'}
              descending={descending}
              onClick={() => onSort('name')}
              grow
            />
            {COLUMNS.map((column) =>
              column.id === 'command' ? (
                <div
                  key={column.id}
                  title={column.definition}
                  style={{ width: column.width }}
                  className="shrink-0 px-2 py-1.5"
                >
                  {column.label}
                </div>
              ) : (
                <HeaderCell
                  key={column.id}
                  label={column.label}
                  definition={column.definition}
                  width={column.width}
                  active={sortKey === column.id}
                  descending={descending}
                  onClick={() => onSort(column.id as SortKey)}
                />
              ),
            )}
          </div>
        </div>
        <div
          role="listbox"
          aria-label="Startup apps"
          tabIndex={0}
          onKeyDown={onKeyDown}
          onScroll={(event) => {
            const header = event.currentTarget.previousElementSibling;
            if (header) header.scrollLeft = event.currentTarget.scrollLeft;
          }}
          className="min-h-0 flex-1 overflow-auto outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent-dim"
        >
          <div style={{ minWidth: TABLE_WIDTH }}>
            {sorted.map((item) => (
              <StartupRow
                key={idOf(item)}
                item={item}
                selected={idOf(item) === selected}
                onClick={() => setSelected(idOf(item))}
                onContextMenu={(event) => {
                  event.preventDefault();
                  setSelected(idOf(item));
                  openMenu(item);
                }}
              />
            ))}
          </div>
          {items && items.length === 0 && (
            <div className="p-6 text-center text-xs text-text-muted">
              Nothing is set to start when you sign in.
            </div>
          )}
        </div>
      </div>
    </PageShell>
  );
}

function HeaderCell({
  label,
  definition,
  width,
  grow,
  active,
  descending,
  onClick,
}: {
  label: string;
  definition: string;
  width?: number;
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
      } ${active ? 'text-text-primary' : ''}`}
    >
      {label}
      {active && <span>{descending ? '▾' : '▴'}</span>}
    </button>
  );
}

function StartupRow({
  item,
  selected,
  onClick,
  onContextMenu,
}: {
  item: StartupItem;
  selected: boolean;
  onClick: () => void;
  onContextMenu: (event: React.MouseEvent) => void;
}): React.JSX.Element {
  const name = startupDisplayName(item);
  const missing = item.programPath !== undefined && !item.programExists;
  const disabledOn =
    item.disabledAtUnixMs === undefined
      ? null
      : new Date(item.disabledAtUnixMs).toLocaleDateString(undefined, {
          day: 'numeric',
          month: 'short',
          year: 'numeric',
        });
  return (
    <div
      role="option"
      aria-selected={selected}
      onClick={onClick}
      onContextMenu={onContextMenu}
      style={{ height: ROW_HEIGHT }}
      className={`flex cursor-default select-none items-center text-[12px] ${
        selected ? 'bg-accent-dim/25' : 'hover:bg-surface-2'
      }`}
    >
      <div className="flex min-w-0 flex-1 items-baseline gap-1.5 px-2">
        {/* The program's own name never gives way to the registered one. */}
        <span
          className={`max-w-full shrink-0 truncate ${item.status === 'enabled' ? '' : 'text-text-secondary'}`}
        >
          {name}
        </span>
        {name !== item.name && (
          <span className="min-w-0 shrink-4 truncate text-[11px] text-text-muted">{item.name}</span>
        )}
        {missing && (
          <span
            className="shrink-0 text-[11px] text-warn"
            title={`${item.programPath} does not exist, so it cannot start.`}
          >
            file not found
          </span>
        )}
      </div>
      <div style={{ width: 190 }} className="shrink-0 truncate px-2 text-text-secondary">
        {item.publisher ?? '—'}
      </div>
      <div style={{ width: 190 }} className="flex shrink-0 items-baseline gap-1.5 truncate px-2">
        {item.status === 'enabled' && <span className="text-text-primary">Enabled</span>}
        {item.status === 'disabled' && (
          <>
            <span className="text-text-secondary">Disabled</span>
            {disabledOn && <span className="text-[11px] text-text-muted">since {disabledOn}</span>}
          </>
        )}
        {item.status === 'unknown' && (
          <span
            className="text-warn"
            title={`Windows' record of this entry starts with ${
              item.approvalFlag === undefined ? 'no readable byte' : `0x${item.approvalFlag.toString(16).padStart(2, '0')}`
            }, a form not seen before, so whether it starts is not claimed. Enable or Disable writes a form Windows is known to read.`}
          >
            Unknown
          </span>
        )}
      </div>
      <div style={{ width: 200 }} className="shrink-0 truncate px-2 text-text-secondary">
        {STARTUP_SOURCE_LABELS[item.source]}
      </div>
      <div
        style={{ width: 340 }}
        title={item.command}
        className="selectable shrink-0 truncate px-2 font-mono text-[11px] text-text-secondary"
      >
        {item.command}
      </div>
    </div>
  );
}
