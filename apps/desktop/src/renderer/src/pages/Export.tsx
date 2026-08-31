import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  buildExportDocument,
  exportFileName,
  EXPORT_SECTIONS,
  renderExportJson,
  renderExportMarkdown,
  SNAPSHOT_ONLY_REASONS,
  type ExportSectionId,
} from '@task-manager/shared';
import type { HistoryResult } from '@task-manager/telemetry-types';
import { Note, PageShell, Panel } from '../components/primitives.js';
import { useHostInfo } from '../lib/hooks.js';
import { telemetryStore } from '../lib/telemetry-store.js';

/**
 * Exporting telemetry for analysis elsewhere.
 *
 * The intended destination is a conversation with a language model, which
 * drives two decisions visible here. Every export carries the definition of
 * every metric it contains, because an analyst that cannot ask a follow-up
 * question needs the meaning shipped alongside the number. And the process
 * table is capped by default, because a thousand rows is more than most
 * conversations will take and the tail is idle processes.
 *
 * Nothing on this page computes a metric. It selects, formats and delivers what
 * the collector already produced.
 */

type Format = 'json' | 'markdown';

interface Range {
  id: string;
  label: string;
  spanMs: number;
}

/** Matches the History page, so the two agree about what "1 hour" means. */
const RANGES: Range[] = [
  { id: '5m', label: '5 minutes', spanMs: 5 * 60_000 },
  { id: '1h', label: '1 hour', spanMs: 60 * 60_000 },
  { id: '24h', label: '24 hours', spanMs: 24 * 60 * 60_000 },
  { id: '7d', label: '7 days', spanMs: 7 * 24 * 60 * 60_000 },
];

const ROW_CAPS = [50, 200, 1000, 0];

const DEFAULT_SECTIONS: ExportSectionId[] = [
  'host',
  'cpu',
  'memory',
  'processes',
  'applications',
  'disk',
  'network',
  'gpu',
  'thermal',
];

export function ExportPage(): React.JSX.Element {
  const host = useHostInfo();
  const [sections, setSections] = useState<Set<ExportSectionId>>(new Set(DEFAULT_SECTIONS));
  const [includeHistory, setIncludeHistory] = useState(false);
  const [rangeId, setRangeId] = useState('1h');
  const [format, setFormat] = useState<Format>('json');
  const [maxRows, setMaxRows] = useState(200);
  const [history, setHistory] = useState<HistoryResult | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const range = RANGES.find((r) => r.id === rangeId) ?? RANGES[1]!;

  // The process list is only collected while a window asks for it. Without this
  // an export selecting Processes would honestly, and uselessly, report that
  // they were not collected. Asked for only while a per-process section is
  // selected, so choosing CPU and memory alone still costs nothing.
  const needsProcesses = sections.has('processes') || sections.has('applications');
  useEffect(() => {
    if (!needsProcesses) return;
    void window.taskManager.setProcessSubscription(true);
    return () => {
      void window.taskManager.setProcessSubscription(false);
    };
  }, [needsProcesses]);

  // History is a database read, so it happens when the selection changes rather
  // than on every snapshot.
  useEffect(() => {
    if (!includeHistory) {
      setHistory(null);
      return;
    }
    let cancelled = false;
    const now = Date.now();
    void window.taskManager
      .queryHistory(now - range.spanMs, now)
      .then((result) => {
        if (!cancelled) setHistory(result);
      });
    return () => {
      cancelled = true;
    };
  }, [includeHistory, range.spanMs]);

  const selected = useMemo(() => {
    const ids = [...sections];
    if (includeHistory) ids.push('history');
    return ids;
  }, [sections, includeHistory]);

  /**
   * Build the text.
   *
   * Deliberately built on demand rather than kept in state: the snapshot
   * changes twice a second, and re-serialising a thousand processes on every
   * one of them would cost more than the collector does.
   */
  const build = useCallback((): { text: string; name: string } => {
    const document = buildExportDocument(
      {
        snapshot: telemetryStore.snapshot,
        host: host ?? null,
        history,
        historySpanMs: includeHistory ? range.spanMs : undefined,
        generatedAtUnixMs: Date.now(),
        appVersion: host?.nativeModuleVersion,
      },
      { sections: selected, maxRows },
    );
    return {
      text: format === 'json' ? renderExportJson(document) : renderExportMarkdown(document),
      name: exportFileName(format, Date.now()),
    };
  }, [host, history, includeHistory, range.spanMs, selected, maxRows, format]);

  const [estimate, setEstimate] = useState<number | null>(null);

  // The size decides whether pasting is realistic, so it is worth knowing
  // before choosing between the clipboard and a file.
  const measure = useCallback(() => {
    setEstimate(new Blob([build().text]).size);
  }, [build]);

  useEffect(() => {
    // Measure once per selection change, not once per snapshot.
    const timer = setTimeout(measure, 150);
    return () => clearTimeout(timer);
  }, [measure]);

  const onCopy = useCallback(async () => {
    setBusy(true);
    try {
      const { text } = build();
      const ok = await window.taskManager.copyToClipboard(text);
      setStatus(
        ok
          ? `Copied ${formatSize(new Blob([text]).size)} to the clipboard.`
          : 'The clipboard could not be set. Another application may be holding it.',
      );
    } finally {
      setBusy(false);
    }
  }, [build]);

  const onSave = useCallback(async () => {
    setBusy(true);
    try {
      const { text, name } = build();
      const result = await window.taskManager.saveExport(name, text);
      if (result.saved) {
        setStatus(`Saved ${formatSize(result.byteLength ?? 0)} to ${result.path}.`);
      } else if (result.error) {
        setStatus(`Could not save: ${result.error}`);
      } else {
        // Dismissing the dialog is a decision, not a failure.
        setStatus(null);
      }
    } finally {
      setBusy(false);
    }
  }, [build]);

  const nothingSelected = selected.length === 0;

  return (
    <PageShell
      title="Export"
      subtitle="Hand this machine's telemetry to something else for analysis"
    >
      <div className="grid gap-4 xl:grid-cols-[2fr_1fr]">
        <Panel title="What to include" hint="Every section carries its own definitions">
          <div className="grid gap-1.5 sm:grid-cols-2">
            {EXPORT_SECTIONS.map((section) => (
              <label
                key={section.id}
                className="flex cursor-pointer items-start gap-2 rounded px-2 py-1.5 text-[12px] hover:bg-surface-2"
                title={section.summary}
              >
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={sections.has(section.id)}
                  onChange={() =>
                    setSections((previous) => {
                      const next = new Set(previous);
                      if (next.has(section.id)) next.delete(section.id);
                      else next.add(section.id);
                      return next;
                    })
                  }
                />
                <span className="min-w-0">
                  <span className="block text-text-primary">{section.label}</span>
                  <span className="block text-[11px] leading-snug text-text-muted">
                    {section.summary}
                  </span>
                </span>
              </label>
            ))}
          </div>

          <div className="mt-3 border-t border-border-subtle pt-3">
            <label className="flex cursor-pointer items-start gap-2 text-[12px]">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={includeHistory}
                onChange={(event) => setIncludeHistory(event.target.checked)}
              />
              <span>
                <span className="block text-text-primary">History — a time series</span>
                <span className="block text-[11px] leading-snug text-text-muted">
                  Machine-wide CPU, memory, disk, network and GPU over a window, each point a
                  mean with its peak alongside.
                </span>
              </span>
            </label>
            {includeHistory && (
              <div className="mt-2 flex flex-wrap gap-1.5 pl-6">
                {RANGES.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    onClick={() => setRangeId(option.id)}
                    className={`rounded px-2 py-1 text-[11px] transition-colors ${
                      rangeId === option.id
                        ? 'bg-surface-3 text-text-primary'
                        : 'bg-surface-2 text-text-secondary hover:text-text-primary'
                    }`}
                  >
                    {option.label}
                  </button>
                ))}
                <span className="self-center pl-1 text-[11px] text-text-muted">
                  {history === null
                    ? 'reading…'
                    : history.available
                      ? `${history.points.length} points from tier ${history.tier}`
                      : 'history recording is off'}
                </span>
              </div>
            )}
          </div>

          <Note>
            Only machine-wide metrics have a history. Processes, applications and temperatures
            are a single instant, because per-process history is not collected and temperatures
            are not written to the database — so there is no past to export rather than a past
            that is being withheld.
          </Note>
        </Panel>

        <div className="flex flex-col gap-4">
          <Panel title="Format">
            <div className="flex gap-1.5">
              <FormatButton
                active={format === 'json'}
                onClick={() => setFormat('json')}
                label="JSON"
                hint="Complete and exact. Values are raw numbers, so anything reading it can compute with them. Best attached as a file."
              />
              <FormatButton
                active={format === 'markdown'}
                onClick={() => setFormat('markdown')}
                label="Markdown"
                hint="Formatted for reading. Best pasted straight into a conversation."
              />
            </div>

            <div className="mt-3 text-[12px] text-text-secondary">Rows per table</div>
            <div className="mt-1 flex flex-wrap gap-1.5">
              {ROW_CAPS.map((cap) => (
                <button
                  key={cap}
                  type="button"
                  onClick={() => setMaxRows(cap)}
                  className={`rounded px-2 py-1 text-[11px] transition-colors ${
                    maxRows === cap
                      ? 'bg-surface-3 text-text-primary'
                      : 'bg-surface-2 text-text-secondary hover:text-text-primary'
                  }`}
                >
                  {cap === 0 ? 'All' : cap}
                </button>
              ))}
            </div>
            <Note>
              Processes and applications are ordered by CPU before the cap is applied, and any
              table that hits it says so in the output along with what it was ordered by.
            </Note>
          </Panel>

          <Panel title="Deliver">
            <div className="mb-2 text-[12px] text-text-secondary">
              Estimated size{' '}
              <span className="tnum text-text-primary">
                {estimate === null ? '—' : formatSize(estimate)}
              </span>
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                disabled={busy || nothingSelected}
                onClick={() => void onCopy()}
                className="flex-1 rounded bg-surface-3 px-3 py-2 text-[12px] text-text-primary transition-colors hover:bg-surface-2 disabled:opacity-50"
              >
                Copy to clipboard
              </button>
              <button
                type="button"
                disabled={busy || nothingSelected}
                onClick={() => void onSave()}
                className="flex-1 rounded bg-surface-3 px-3 py-2 text-[12px] text-text-primary transition-colors hover:bg-surface-2 disabled:opacity-50"
              >
                Save to file…
              </button>
            </div>
            {nothingSelected && (
              <Note>Select at least one section.</Note>
            )}
            {status && (
              <div className="selectable mt-2 break-words rounded border border-border-subtle bg-surface-0 p-2 text-[11px] text-text-secondary">
                {status}
              </div>
            )}
            {estimate !== null && estimate > 400_000 && (
              <Note>
                That is large for a chat message. Saving to a file and attaching it is usually
                more reliable than pasting, or lower the row cap.
              </Note>
            )}
          </Panel>
        </div>
      </div>

      <div className="mt-4">
        <Panel title="What the export promises">
          <ul className="ml-4 list-disc text-[12px] leading-relaxed text-text-secondary">
            <li>
              Every column and every value carries its own definition and unit, so a reader with
              no access to this application can tell what each number means. Several metrics
              here have names that look interchangeable and are not — CPU time utilization and
              CPU processor utility routinely differ by more than fifty points on this machine.
            </li>
            <li>
              A value the collector did not measure is exported as null, never as zero. Nothing
              is estimated, interpolated or filled in.
            </li>
            <li>
              A section with no data says why — process collection off, a counter set missing,
              history disabled — rather than being silently dropped.
            </li>
            <li>
              A capped table states the cap and the ordering, so a truncated list cannot be
              mistaken for a complete one.
            </li>
          </ul>
          <Note>
            {SNAPSHOT_ONLY_REASONS.processes} The same applies to anything derived from the
            process list.
          </Note>
        </Panel>
      </div>
    </PageShell>
  );
}

function FormatButton({
  active,
  onClick,
  label,
  hint,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  hint: string;
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      title={hint}
      className={`flex-1 rounded px-3 py-2 text-[12px] transition-colors ${
        active
          ? 'bg-surface-3 text-text-primary'
          : 'bg-surface-2 text-text-secondary hover:text-text-primary'
      }`}
    >
      {label}
    </button>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
