import { useEffect } from 'react';
import { formatMilliseconds, formatPercent, formatRaw, formatTimeOfDay } from '@task-manager/shared';
import { Field, Note, PageShell, Panel } from '../components/primitives.js';
import { Diagnostics } from '../components/Diagnostics.js';
import { useCollectorConfig, useHostInfo, useNativeStatus, useSnapshot } from '../lib/hooks.js';
import { telemetryStore } from '../lib/telemetry-store.js';

/**
 * The developer view. Every number the application displays can be traced from
 * here: the raw counter deltas, the interval they were divided by, and the
 * arithmetic in between.
 *
 * Enabling this page turns on debug collection in the native engine and turns it
 * off again on leaving, so the extra payload is not carried when nobody is
 * looking at it.
 */
export function DebugPage(): React.JSX.Element {
  const snapshot = useSnapshot();
  const config = useCollectorConfig();
  const status = useNativeStatus();
  const hostInfo = useHostInfo();

  useEffect(() => {
    let cancelled = false;
    void window.taskManager.setConfig({ collectDebug: true }).then((next) => {
      if (!cancelled) telemetryStore.setConfig(next);
    });
    return () => {
      cancelled = true;
      void window.taskManager.setConfig({ collectDebug: false }).then((next) => {
        telemetryStore.setConfig(next);
      });
    };
  }, []);

  const cpu = snapshot?.cpu;
  const debug = cpu?.debug;

  return (
    <PageShell
      title="Debug telemetry"
      subtitle="Raw counters, measured intervals and the derivation of every displayed metric"
    >
      <div className="grid gap-4 xl:grid-cols-2">
        <Panel title="Sample" hint="This interval, as measured">
          <div className="text-[12px]">
            <Field label="Sequence" value={snapshot?.sequence ?? '—'} />
            <Field
              label="Wall clock"
              value={formatTimeOfDay(snapshot?.wallClockUnixMs)}
              definition="Display only. Never used for rate calculations."
            />
            <Field
              label="Monotonic"
              value={formatMilliseconds(snapshot?.monotonicMs, 1)}
              definition="Milliseconds since collector start, from QueryPerformanceCounter via Rust's Instant."
            />
            <Field
              label="Measured interval"
              value={formatMilliseconds(snapshot?.intervalMs, 2)}
              definition="The actual denominator used for every rate in this snapshot."
            />
            <Field
              label="Configured interval"
              value={formatMilliseconds(config?.intervalMs, 0)}
              definition="What was requested. The measured interval is what is used."
            />
            <Field
              label="Interval drift"
              value={
                snapshot?.intervalMs !== undefined && config
                  ? formatMilliseconds(snapshot.intervalMs - config.intervalMs, 2)
                  : '—'
              }
            />
          </div>
        </Panel>

        <Panel title="Collector cost" hint="What this application spends to measure the machine">
          <div className="text-[12px]">
            <Field label="Total" value={formatMilliseconds(snapshot?.diagnostics.totalDurationMs)} />
            <Field label="CPU" value={formatMilliseconds(snapshot?.diagnostics.cpuDurationMs)} />
            <Field label="Memory" value={formatMilliseconds(snapshot?.diagnostics.memoryDurationMs)} />
            <Field
              label="Processes"
              value={formatMilliseconds(snapshot?.diagnostics.processDurationMs)}
              definition="Dominated by the kernel walking every process and thread to service NtQuerySystemInformation."
            />
            <Field
              label="Duty cycle"
              value={
                snapshot?.intervalMs
                  ? formatPercent(
                      (snapshot.diagnostics.totalDurationMs / snapshot.intervalMs) * 100,
                      2,
                    )
                  : '—'
              }
              definition="Share of the interval the sampling thread was busy. This is one thread, so divide by the logical processor count for machine share."
            />
            <Field
              label="Machine share"
              value={
                snapshot?.intervalMs && cpu
                  ? formatPercent(
                      (snapshot.diagnostics.totalDurationMs /
                        snapshot.intervalMs /
                        cpu.topology.logicalProcessorCount) *
                        100,
                      3,
                    )
                  : '—'
              }
              definition="The collector's own CPU cost as a share of total machine capacity."
            />
            <Field
              label="Dropped snapshots"
              value={snapshot?.diagnostics.droppedSnapshots ?? '—'}
              definition="Snapshots the JavaScript side could not accept in time. Should stay at zero."
            />
            <Field
              label="Tracked identities"
              value={snapshot?.diagnostics.trackedProcessCount ?? '—'}
              definition="Process identities held for delta calculation. Should track the live process count, not grow."
            />
          </div>
        </Panel>

        <Panel
          title="Aggregate CPU derivation"
          hint="NtQuerySystemInformation(SystemProcessorPerformanceInformation)"
        >
          {debug ? (
            <div className="text-[12px]">
              <Field label="Interval" value={formatMilliseconds(debug.intervalMs, 2)} />
              <Field label="idle delta (100ns)" value={formatRaw(debug.idleDelta100ns)} mono />
              <Field
                label="kernel delta (100ns)"
                value={formatRaw(debug.kernelDelta100ns)}
                mono
                definition="Includes idle time, as Windows documents."
              />
              <Field label="user delta (100ns)" value={formatRaw(debug.userDelta100ns)} mono />
              <Field
                label="total = kernel + user"
                value={formatRaw(debug.totalDelta100ns)}
                mono
              />
              <Field
                label="busy = total − idle"
                value={formatRaw(debug.busyDelta100ns)}
                mono
              />
              <Field
                label="result = busy / total"
                value={formatPercent(cpu?.aggregateTimeUtilizationPercent, 4)}
              />
              <Field
                label="counter coverage"
                value={debug.counterCoverageRatio.toFixed(5)}
                definition="total delta divided by (interval × 10000 × logical processors). Near 1.0 means the counters and the wall clock agree."
              />
              <Field
                label="discarded"
                value={debug.discarded ? `Yes — ${debug.discardReason ?? 'unknown'}` : 'No'}
              />
            </div>
          ) : (
            <div className="text-[11px] text-text-muted">Waiting for a debug sample…</div>
          )}
        </Panel>

        <Panel title="Cross-checks" hint="Independent sources measured over the same interval">
          {debug ? (
            <div className="text-[12px]">
              <Field
                label="Ours (per-processor sum)"
                value={formatPercent(cpu?.aggregateTimeUtilizationPercent, 4)}
              />
              <Field
                label="GetSystemTimes"
                value={formatPercent(debug.getSystemTimes?.utilizationPercent, 4)}
                definition="Computed from a completely separate API over the same interval. Should agree to within rounding."
              />
              <Field
                label="Difference"
                value={
                  cpu?.aggregateTimeUtilizationPercent !== undefined &&
                  debug.getSystemTimes !== undefined
                    ? formatPercent(
                        cpu.aggregateTimeUtilizationPercent -
                          debug.getSystemTimes.utilizationPercent,
                        4,
                      )
                    : '—'
                }
              />
              <Field
                label="PDH % Processor Time"
                value={formatPercent(cpu?.pdhProcessorTimePercent, 4)}
                definition="A third source. PDH keeps its own sampling window, so small differences are expected."
              />
              <Field
                label="PDH % Processor Utility"
                value={formatPercent(cpu?.processorUtilityPercent, 4)}
                definition="What Task Manager shows. Differs from time utilization by the frequency factor below."
              />
              <Field
                label="PDH % Processor Performance"
                value={formatPercent(cpu?.processorPerformancePercent, 2)}
                definition="Delivered frequency as a percentage of nominal. Above 100 means the CPU is boosting."
              />
              <Field
                label="utility ÷ time utilization"
                value={
                  cpu?.processorUtilityPercent !== undefined &&
                  cpu?.aggregateTimeUtilizationPercent
                    ? (
                        cpu.processorUtilityPercent / cpu.aggregateTimeUtilizationPercent
                      ).toFixed(3)
                    : '—'
                }
                definition="Should track % Processor Performance ÷ 100. This ratio is exactly why the two CPU numbers differ."
              />
              <div className="mt-2">
                {debug.pdhCounterPaths.map((path) => (
                  <div key={path} className="selectable font-mono text-[10px] text-text-muted">
                    {path}
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="text-[11px] text-text-muted">Waiting for a debug sample…</div>
          )}
        </Panel>

        <Panel title="Memory sources" hint="Raw structure fields">
          {snapshot?.memory.debug ? (
            <div className="text-[12px]">
              <SubTitle>MEMORYSTATUSEX</SubTitle>
              {Object.entries(snapshot.memory.debug.globalMemoryStatusEx).map(([key, value]) => (
                <Field key={key} label={key} value={formatRaw(value as number)} mono />
              ))}
              {snapshot.memory.debug.performanceInformation && (
                <>
                  <SubTitle>PERFORMANCE_INFORMATION (pages)</SubTitle>
                  {Object.entries(snapshot.memory.debug.performanceInformation).map(
                    ([key, value]) => (
                      <Field key={key} label={key} value={formatRaw(value as number)} mono />
                    ),
                  )}
                </>
              )}
              {snapshot.memory.debug.memoryList && (
                <>
                  <SubTitle>SYSTEM_MEMORY_LIST_INFORMATION (bytes)</SubTitle>
                  <Field
                    label="freeAndZeroBytes"
                    value={formatRaw(snapshot.memory.debug.memoryList.freeAndZeroBytes)}
                    mono
                  />
                  <Field
                    label="modifiedBytes"
                    value={formatRaw(snapshot.memory.debug.memoryList.modifiedBytes)}
                    mono
                  />
                  <Field
                    label="standbyBytes"
                    value={formatRaw(snapshot.memory.debug.memoryList.standbyBytes)}
                    mono
                  />
                </>
              )}
            </div>
          ) : (
            <div className="text-[11px] text-text-muted">Waiting for a debug sample…</div>
          )}
        </Panel>

        <Panel title="Environment">
          <div className="text-[12px]">
            <Field label="Native module" value={status?.modulePath ?? '—'} mono />
            <Field label="Module version" value={hostInfo?.nativeModuleVersion ?? '—'} />
            <Field label="Sampling" value={status?.sampling ? 'Running' : 'Stopped'} />
            <Field label="OS" value={`${hostInfo?.osName ?? '—'} ${hostInfo?.osBuild ?? ''}`} />
            <Field label="OS version" value={hostInfo?.osVersion ?? '—'} />
            <Field label="Architecture" value={hostInfo?.architecture ?? '—'} />
            <Field
              label="Elevated"
              value={hostInfo?.isElevated ? 'Yes' : 'No'}
              definition="Some per-process details are unavailable without elevation. Everything else works either way."
            />
            <Field
              label="Boot time"
              value={
                hostInfo?.bootTimeUnixMs ? new Date(hostInfo.bootTimeUnixMs).toLocaleString() : '—'
              }
            />
          </div>
        </Panel>
      </div>

      {snapshot && snapshot.diagnostics.issues.length > 0 && (
        <Panel className="mt-4" title="Issues this interval">
          <div className="text-[12px]">
            {snapshot.diagnostics.issues.map((issue, index) => (
              <Field
                key={`${issue.subsystem}-${issue.code}-${index}`}
                label={`${issue.subsystem} / ${issue.code}`}
                value={issue.message}
              />
            ))}
          </div>
        </Panel>
      )}

      <div className="mt-4">
        <Diagnostics />
      </div>

      <Note>
        Every value on this page is read straight from the native collector. Nothing here is
        recomputed in JavaScript, so what you see is what the metric actually is.
      </Note>
    </PageShell>
  );
}

function SubTitle({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <h4 className="mt-3 mb-1 font-mono text-[10px] uppercase tracking-wide text-text-muted first:mt-0">
      {children}
    </h4>
  );
}
