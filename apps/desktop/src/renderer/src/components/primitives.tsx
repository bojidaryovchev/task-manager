import type { ReactNode } from 'react';

export function PageShell({
  title,
  subtitle,
  actions,
  children,
}: {
  title: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex h-full flex-col">
      <header className="flex shrink-0 items-start justify-between gap-4 border-b border-border-subtle px-6 py-3">
        <div className="min-w-0">
          <h1 className="text-base font-semibold">{title}</h1>
          {subtitle && <div className="mt-0.5 text-xs text-text-muted">{subtitle}</div>}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">{children}</div>
    </div>
  );
}

export function Panel({
  title,
  hint,
  actions,
  children,
  className = '',
}: {
  title?: ReactNode;
  hint?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}): React.JSX.Element {
  return (
    <section
      className={`rounded-lg border border-border-subtle bg-surface-1 ${className}`}
    >
      {(title || actions) && (
        <div className="flex items-center justify-between gap-3 border-b border-border-subtle px-4 py-2">
          <div className="min-w-0">
            <div className="text-[13px] font-medium">{title}</div>
            {hint && <div className="text-[11px] text-text-muted">{hint}</div>}
          </div>
          {actions}
        </div>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

/**
 * A labelled value. `definition` is the precise meaning of the metric and is
 * surfaced on hover - every number in this application can say what it is.
 */
export function Stat({
  label,
  value,
  definition,
  accent,
  small,
}: {
  label: string;
  value: ReactNode;
  definition?: string;
  accent?: string;
  small?: boolean;
}): React.JSX.Element {
  return (
    <div title={definition} className={definition ? 'cursor-help' : undefined}>
      <div className="text-[11px] uppercase tracking-wide text-text-muted">{label}</div>
      <div
        className={`tnum font-semibold ${small ? 'text-base' : 'text-2xl'}`}
        style={accent ? { color: accent } : undefined}
      >
        {value}
      </div>
    </div>
  );
}

/** A key/value row for dense detail lists. */
export function Field({
  label,
  value,
  definition,
  mono,
}: {
  label: string;
  value: ReactNode;
  definition?: string;
  mono?: boolean;
}): React.JSX.Element {
  return (
    <div
      className="flex items-baseline justify-between gap-4 border-b border-border-subtle/50 py-1 last:border-b-0"
      title={definition}
    >
      <span className="shrink-0 text-text-muted">{label}</span>
      <span
        className={`tnum selectable min-w-0 truncate text-right ${mono ? 'font-mono text-xs' : ''}`}
      >
        {value}
      </span>
    </div>
  );
}

/** A horizontal bar, used for memory composition and per-processor load. */
export function Bar({
  fraction,
  color,
  height = 6,
  background = 'var(--color-surface-3)',
}: {
  fraction: number;
  color: string;
  height?: number;
  background?: string;
}): React.JSX.Element {
  const clamped = Number.isFinite(fraction) ? Math.min(Math.max(fraction, 0), 1) : 0;
  return (
    <div
      className="w-full overflow-hidden rounded-full"
      style={{ height, background }}
    >
      <div
        style={{
          width: `${clamped * 100}%`,
          height: '100%',
          background: color,
          transition: 'width 180ms linear',
        }}
      />
    </div>
  );
}

/** A short explanatory note attached to a metric. */
export function Note({ children }: { children: ReactNode }): React.JSX.Element {
  return <p className="mt-2 text-[11px] leading-relaxed text-text-muted">{children}</p>;
}
