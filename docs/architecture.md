# Architecture

How the pieces fit together, and the reasoning behind the arrangement. For what
each metric means, see [`telemetry.md`](telemetry.md).

## The pipeline

```
COLLECTION      Windows APIs        native/telemetry/src/win/
CALCULATION     Rust collectors     native/telemetry/src/{cpu,memory,process}/
AGGREGATION     Sampling engine     native/telemetry/src/sampling/
TRANSPORT       N-API + IPC         native/telemetry/src/api.rs, apps/desktop/src/{main,preload}/
PRESENTATION    React               apps/desktop/src/renderer/
```

Each stage depends only on the one above it. Nothing above `win/` contains a
Windows call; nothing below `api.rs` knows that JavaScript exists; nothing in the
renderer computes a metric.

## Why the boundaries sit where they do

### All calculation in Rust

The stated goal is that the tray, the desktop widget and the main window can
never disagree about what CPU usage is. The only reliable way to guarantee that
is for there to be exactly one implementation, upstream of every presentation.

A weaker version — "everyone calls the same helper" — fails the moment one
consumer needs a slightly different shape and copies the helper. Putting the
calculation on the far side of a process boundary makes copying it impossible.

The rule this produces: **if a component divides one counter by another, that
code is in the wrong place.** Formatting is presentation; arithmetic on counters
is not.

### One sampling engine, one timer

Independent per-subsystem timers would mean a process's CPU percentage and the
aggregate CPU percentage were measured over different windows, so comparing them
would be meaningless — and comparing them is the whole point of a process list.

So there is one thread, one interval, one `SystemSnapshot`. Everything inside a
snapshot describes the same interval, and the interval it describes is carried in
the snapshot as a measured value rather than assumed from configuration.

### The sampler owns its own thread

Collection costs a few milliseconds — up to ~40 ms with the process list. Running
that on the Electron main thread would stall IPC and the UI, and would make the
sampling interval depend on how busy the UI was.

Snapshots cross into JavaScript through an N-API threadsafe function in
**non-blocking** mode. If JavaScript cannot accept a snapshot, it is dropped and
counted in `diagnostics.droppedSnapshots`. Blocking the sampler instead would
stretch the next interval, and since every rate is divided by the measured
interval, one stall would distort the following sample too.

### Rates are absent, never zero

A cumulative counter yields a rate only when there is a predecessor. The first
sample, a sample after a counter regression, and a process seen for the first
time all produce *absent* values, not zeros.

This is the difference between "this process used no CPU" and "we do not yet know
what this process used", and the UI renders them differently — a number versus an
em dash. Filling the gap with zero would be a fabricated measurement, and filling
it with a process-lifetime average would be worse.

## Process model

```
┌─────────────────────────────────────────────────────────────┐
│ Electron main                                               │
│                                                             │
│   TelemetryService                                          │
│     owns the one native engine                              │
│     fans snapshots out to every presentation                │
│     tracks which windows want the process list              │
│                                                             │
│   ┌───────────────────────────────────────────────┐         │
│   │ native module (in-process)                    │         │
│   │   sampling thread ──► collectors ──► Windows  │         │
│   └───────────────────────────────────────────────┘         │
└───────────┬─────────────────────┬───────────────────────────┘
            │ IPC                 │ IPC
   ┌────────▼────────┐   ┌────────▼────────┐
   │ main window     │   │ desktop widget  │  (planned)
   │ preload bridge  │   │ preload bridge  │
   └─────────────────┘   └─────────────────┘
```

`TelemetryService` is a broadcaster from the outset, even though there is
currently one window. The tray and the desktop widget attach to the same stream;
they do not get their own engine and do not compute anything.

## Demand-driven collection

The process list is the largest part of a snapshot (~2.5 MB of kernel data, ~1000
objects) and by far the most expensive to gather. It is collected only while some
window is showing it.

A renderer declares its need through `setProcessSubscription(true)`. The main
process tracks subscribers per window and:

- strips `processes` from the snapshot sent to windows that did not ask;
- turns native process collection off entirely when nobody is asking.

Measured effect: 1.8 ms per sample with no subscriber, versus 37 ms with one.
System-wide process, thread and handle *counts* remain available either way,
because they come from `GetPerformanceInfo` when the list is off and from our own
enumeration when it is on.

Snapshots are also not pushed to hidden or minimised windows. Collection
continues — it is in the native engine and unaffected — but a renderer nobody can
see is not asked to render. The renderer re-primes from `getLatestSnapshot()` when
it becomes visible.

## Identity

Windows reuses PIDs. Anything that must survive across samples is keyed on
`"{pid}:{createTime100ns}"`:

- per-process CPU and I/O deltas;
- the cache of handle-derived details;
- parent links in the process tree;
- React row identity;
- anything persisted later.

Keying on PID alone would let a CPU delta be computed between two unrelated
programs that happened to share a PID, showing up as an enormous spike.

The identity string is formatted in Rust because a FILETIME creation timestamp
(~1.3 × 10¹⁷) exceeds the exact integer range of a JavaScript double. The numeric
`createTime100ns` field is display-only and documented as such.

## Renderer performance

A snapshot arrives every 500 ms and most of it is irrelevant to most components.

**State lives outside React.** `TelemetryStore` holds the current snapshot and the
bounded history buffers. Components subscribe through `useTelemetry(selector)`,
built on `useSyncExternalStore`; a component re-renders only when its selected
value actually changes. A component reading
`cpu.aggregateTimeUtilizationPercent` re-renders when that one number moves, not
when any part of the snapshot does.

**Charts never re-render.** `Chart` subscribes to the store itself and redraws
onto a canvas inside `requestAnimationFrame`. Adding 24 per-processor charts to
the CPU page therefore adds 24 canvas draws, not 24 React subtree renders.

**The process table is windowed.** Only the visible rows plus a small overscan
exist in the DOM, so the cost of a snapshot is proportional to viewport height
rather than to process count. Rows are keyed by process identity, so React reuses
DOM nodes as the sort order changes.

**History buffers are fixed-capacity.** `RingBuffer` allocates once and
overwrites in place. A chart costs a constant amount of memory no matter how long
the application runs. A missing measurement is stored as `NaN` and drawn as a gap
rather than as zero.

## Error handling

Every condition below is expected, not exceptional, and none of them stops a
snapshot from being produced:

| Condition | Handling |
|---|---|
| Process exits mid-collection | Detail read fails; `detailFailure: processExited` |
| Access denied | Cached as a failure so it is not retried every sample; counted and surfaced |
| Protected process | Same path as access denied |
| PID reused | Identity includes creation time, so the new process is a new identity |
| Counter goes backwards (sleep/resume) | Interval discarded with a reason; utilization absent for that sample |
| Processor count changes | Previous counters rebased; interval discarded |
| PDH unavailable | Utility and performance metrics absent; everything else unaffected |
| `NtQuerySystemInformation` unavailable | Resolved with `GetProcAddress`, so one metric degrades rather than the module failing to load |
| Native module missing | The application starts and explains why telemetry is unavailable, rather than showing zeroes |

Subsystem failures are reported as `diagnostics.issues` on the snapshot and shown
on the Debug page.

## Unsafe code

`unsafe` is confined to `native/telemetry/src/win/` and the handle-based reads in
`process/details.rs`. The crate sets
`#![deny(clippy::undocumented_unsafe_blocks)]`, so every block carries a comment
stating the invariant that makes it sound.

The patterns used throughout:

- buffer length is always passed as the true allocated length;
- returned lengths are validated before the buffer is parsed;
- all structure walking is bounds-checked, and a malformed or zero-sized record
  terminates the walk instead of looping or reading out of bounds;
- handles are owned by an RAII wrapper so every early return closes them;
- NT entry points are resolved with `GetProcAddress` rather than linked.

The buffer-walking code is unit-tested against synthetic buffers, including
truncated ones, zero-sized records and out-of-range links.

## Self-measurement

A resource monitor that cannot account for its own cost is not trustworthy.
Every snapshot carries per-subsystem collection timings, the dropped-snapshot
count and the number of tracked process identities. The Debug page turns these
into a duty cycle and a share of total machine capacity, and the application is
visible in its own process list like anything else.

## Planned work

| Milestone | Adds |
|---|---|
| 4 | Process trees, application grouping, process detail pages |
| 5 | History engine with tiered retention, SQLite persistence |
| 6 | Disk throughput, per-process disk, ETW file attribution |
| 7 | GPU adapters, engines, VRAM, per-process GPU |
| 8 | Network throughput, per-process network, connections |
| 9 | Tray, desktop widget, settings, autostart |

The desktop widget is a second `BrowserWindow` in this same application, attached
to the same `TelemetryService` broadcast. It will not implement any telemetry of
its own — that is the property the architecture exists to protect.
