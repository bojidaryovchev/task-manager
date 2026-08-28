# Architecture

How the pieces fit together, and the reasoning behind the arrangement. For what
each metric means, see [`telemetry.md`](telemetry.md).

## The pipeline

```
COLLECTION      Windows APIs        native/telemetry/src/win/
CALCULATION     Rust collectors     native/telemetry/src/{cpu,memory,process,disk,network,gpu}/
AGGREGATION     Sampling engine     native/telemetry/src/sampling/
PERSISTENCE     Tiered history      native/telemetry/src/history/
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
   │ main window     │   │ desktop widget  │
   │ preload bridge  │   │ preload bridge  │
   └─────────────────┘   └─────────────────┘
```

`TelemetryService` is a broadcaster. The main window, the desktop widget and the
tray all attach to the same stream; none of them gets its own engine and none of
them computes anything.

## The desktop widget

A second `BrowserWindow` in this same application: frameless, transparent,
always-on-top, excluded from the taskbar. It loads its own HTML entry rather than
a route inside the main app, so a 250-pixel window does not pull in the whole
interface.

**It reads the same snapshots.** The widget's layouts format values the collector
already produced. There is no widget-side calculation, which is the property that
makes it impossible for the widget and the main window to disagree.

**Only the layout that needs processes asks for them.** Top consumers subscribes
to the process list; the other three leave process enumeration switched off
entirely, which is the difference between a ~35 ms and a ~2 ms sample.

**Placement survives the real world.** Position is persisted as it moves,
debounced. On restore it is only reused if it still lands on a display that
exists and leaves enough of the window on-screen to grab; otherwise the widget
goes back to the primary display's top-right corner. Monitors get unplugged and
scaling changes move work areas, and a widget you cannot reach is worse than one
in the wrong place.

**Click-through has a guaranteed way back.** An always-on-top frameless window
that ignores the mouse cannot be right-clicked, so the tray menu — which is
built from the same template as the widget's own context menu — can always turn
it off again.

**The window is sized to its content.** Because it is frameless and transparent,
a window larger than what is drawn shows as dead transparent space inside the
widget's own outline. `widgetLayoutSize` derives the size from the layout and the
number of selected metrics.

## One PDH query, one collection

Disk, network, GPU and the two frequency-aware CPU counters all come from PDH.
They share a single query, collected exactly once per interval, because PDH
derives its rates from the gap between consecutive collections: collecting
per-subsystem would silently change what every rate meant. A counter set missing
on a machine simply yields no counter id and its owner reports values as
unavailable, so a machine with no discrete GPU costs nothing and shows nothing
rather than zeros.

Measured cost of the whole PDH read, including disk, network and GPU: under 1 ms
per sample.

## History

Persistence lives in the native layer, in SQLite compiled from the bundled
amalgamation so neither a build nor a shipped binary needs anything installed.

Four retention tiers — every sample for 10 minutes, 5-second means for an hour,
1-minute means for a day, 5-minute means for a week — around 5400 rows in total,
so the database stays a few hundred kilobytes however long the application runs.

A tier is **not** built by re-reading and re-aggregating the tier below it, which
would need bookkeeping to know what had already been rolled up. Each tier keeps
an in-memory accumulator that every sample is added to; when its window elapses
it writes one row and resets. Each row is therefore an exact mean over its
window computed from every sample, not a mean of means.

Peaks are stored beside the means. A five-minute average hides exactly the spike
a post-hoc question is about.

Reads open their own connection. SQLite in WAL mode lets a reader run without
blocking the writer, so the UI asking for a week of history never stalls the
sampler. With history disabled no database is opened and nothing is written —
the collector's only disk activity.

## Colour and contrast

The palette lives as design tokens in `styles.css`, and `pnpm check:contrast`
reads those tokens and checks every foreground/background pair the interface
actually uses against WCAG 2.1 minimums — 4.5:1 for text, 3:1 for graphical
objects — including the widget composited over a white desktop, its worst case.

Canvas is the sharp edge here. A 2D context silently ignores a colour string it
cannot parse and keeps whatever it had, so passing `var(--color-cpu)` to
`strokeStyle` leaves it at the default black and nothing throws. Every colour
reaching a canvas goes through `resolveColor` in `Chart`, which resolves tokens
against computed style first.

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
