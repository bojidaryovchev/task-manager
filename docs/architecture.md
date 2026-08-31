# Architecture

How the pieces fit together, and the reasoning behind the arrangement. For what
each metric means, see [`telemetry.md`](telemetry.md).

## The pipeline

```
COLLECTION      Windows APIs        native/telemetry/src/win/
CALCULATION     Rust collectors     native/telemetry/src/{cpu,memory,process,disk,network,gpu,thermal}/
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
a window larger than what is drawn shows as dead space inside the widget's own
outline, and one smaller clips it. `widgetLayoutSize` derives the size from the
layout, the number of selected metrics and whether the temperature column is on.

For three of the four layouts that is exact, because they are fixed-width by
design: their bars and charts need a stable amount of room, and sizing them to
their text would make the widget breathe every time a value changed width.

The minimal layout is different — its width is whatever its labels and values
need, and no constant serves both `CPU 5%` and `DISK READ 126 KB/s`. A constant
tuned to fit the long case wastes 140 pixels on the short one; tuned to the short
case it clips the long one. So that layout renders at `width: max-content`,
measures itself with a `ResizeObserver`, and reports the result to main, which
sizes the window to it. There is no feedback loop precisely because the element
does not stretch: resizing the window around it cannot change what it measures.

The reported width is clamped in main like any other value crossing the renderer
boundary. A frameless always-on-top window a few pixels wide cannot be grabbed,
and one wider than the desktop cannot be moved off it.

## Temperature, and what it is allowed to claim

Three temperature sources are readable without administrator: NVML for NVIDIA
GPUs, `IOCTL_STORAGE_QUERY_PROPERTY` for drives, and the ACPI thermal zone
counter set. There is no fourth, and in particular there is no CPU package
sensor — that needs an MSR read through a kernel-mode driver.

The design problem is not collecting these. It is that they differ enormously in
how much they can be trusted, and putting three numbers in one column erases
that difference. So **a reading is a value plus its provenance**, never a bare
number: the source it came from and the name of the sensor that produced it
travel with it from Rust all the way to the tooltip.

That single decision settles the rest:

- The GPU and drive readings are joined onto the adapter and the disk they
  belong to, because their sensors *are* those devices. The join is by PCI
  vendor/device id and by disk number, both exact. Where the join would be
  ambiguous — two identical GPUs — no attachment is made at all rather than one
  made by enumeration order, which nothing documents as meaningful.
- The ACPI zone is joined to nothing, and gets its own row under its own ACPI
  name. It was originally shown in the CPU row with a qualifying tooltip. That
  was wrong twice over: an elevated diagnostic read found the zone's passive and
  critical trip points at 124 and 125 °C with no fan trip points, which is not
  how firmware guards a processor die; and a number beside a label reads as that
  label's number however careful the tooltip is. Correlation with CPU load was
  the evidence for the original placement, and correlation is not attachment —
  everything in a laptop chassis warms up when the CPU works.
- Memory and network get nothing, and "nothing" renders as the same em dash the
  rest of the application uses for an unmeasured value.

Colour follows the same rule: a reading turns amber only when it is at or above a
threshold the **vendor** published. NVML supplies throttle and shutdown points;
most drives report none; ACPI zones expose none through this counter set. A
sensor that arrived without thresholds is never coloured, because there is
nothing for it to be above.

The two polled sources carry the age of their measurement rather than hiding it.
A drive is asked every ten seconds — it has orders of magnitude more thermal mass
than a die, and each query is an IOCTL to the device — so a reading can be ten
seconds old, and its tooltip says so.

## One PDH query, one collection

Disk, network, GPU, thermal zones and the two frequency-aware CPU counters all
come from PDH.
They share a single query, collected exactly once per interval, because PDH
derives its rates from the gap between consecutive collections: collecting
per-subsystem would silently change what every rate meant. A counter set missing
on a machine simply yields no counter id and its owner reports values as
unavailable, so a machine with no discrete GPU costs nothing and shows nothing
rather than zeros.

Measured cost of the whole PDH read, including disk, network, GPU and
temperature: 0.78 ms per sample, of which the thermal collector is 0.06-0.13 ms.

## Export

Telemetry leaves the application as JSON or Markdown, to a file or the
clipboard. The intended reader is a language model being asked to analyse it,
and that one fact decides the design.

**A number without its definition is worse than no number.** An analyst handed
`cpu: 95` cannot tell whether that is time utilization, which is capped at 100
and frequency-independent, or processor utility, which legitimately exceeds 100
on a boosting processor — and on this machine those two differ by more than 50
points at the same instant. So every column and every value carries its own
definition and unit inside the export, next to the data rather than in a
glossary, and the preamble names the traps explicitly.

**The honesty rules that govern the UI govern the export.** A value the
collector did not measure is exported as `null`, never as zero. A section with
no data carries the reason — process collection was off, a counter set is
missing on this machine, history is disabled — rather than being dropped, because
silence reads as "there were no processes". A capped table states its cap and its
ordering, so a truncated list can never be mistaken for a complete one.

**What can be a time series, and what cannot.** Machine-wide CPU, memory, disk,
network and GPU have history because the history engine stores them. Processes,
applications and temperatures do not, because per-process history is not
collected and temperatures are not written to the database. The export offers a
history option only for what actually has one, and says why for the rest. This
is the same constraint as everywhere else: the shape of the feature follows what
was really measured.

**The System Idle Process is flagged rather than dropped.** PID 0 sorts to the
top of any CPU-ordered list, and its percentage is idle capacity rather than
work. Removing it would stop the CPU column summing to 100; leaving it unmarked
would let a reader name it the machine's largest consumer. It gets an
`isIdleProcess` column whose definition says exactly what it is, matching how the
Processes page shows it muted and labelled.

**Tables are `columns` plus `rows`, not an array of objects.** A thousand-process
export repeats its keys a thousand times otherwise — roughly three times the
tokens for no extra information, on a payload that has to fit in a conversation.

### Where the work happens

Building and rendering are pure functions in `packages/shared/src/export.ts`,
which makes them directly testable and keeps them out of both processes' way.
The renderer composes the document from the snapshot it already holds and, when
asked, one history query.

Delivery is in main, because the renderer has neither the filesystem nor the
clipboard by design. It hands over finished text and a suggested filename;
`ExportService` owns the save dialog and the write. The suggested name is
sanitised there like anything else crossing that boundary — reduced to a bare
filename, stripped of the characters NTFS forbids — because it seeds a dialog
path. Dismissing that dialog is reported as `saved: false` with no error, since
changing your mind is not a failure.

The clipboard write is read back before the UI claims success: the system
clipboard is a shared resource another process can be holding, so writing to it
is a request rather than an assignment.

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

## Surviving a crash

"Crash" is five different events, and they are not interchangeable. Treating
them as one is how an application ends up either restarting when it should not
or sitting dead when it could have recovered.

| What died | Detectable in-process | Recoverable in-process | Response |
|---|---|---|---|
| Renderer | `render-process-gone` | yes | reload the window, backing off |
| Renderer hung | `unresponsive` | sometimes | recorded; the user decides |
| GPU / utility child | `child-process-gone` | Electron re-spawns it | recorded only |
| Main, catchable | `uncaughtException` | yes | recorded, then relaunch |
| **Main, hard crash** | **no** | **no** | Windows relaunches it |
| Collector thread | polled | no | reported; the UI stops claiming to be live |

### The main process cannot restart itself

Once a native fault takes the main process down, nothing is left running to
relaunch anything. The usual answer is a watchdog process, and it is the wrong
one here: this application ships as a single executable that installs nothing,
and a background watchdog is exactly the sort of thing that becomes a mystery
process on someone's machine.

Windows already solves it. `RegisterApplicationRestart` asks the Restart Manager
to bring the process back after a crash or a hang, with a command line we choose.
Nothing runs while the application is healthy, and nothing is left behind if it
is deleted. It is cancelled on a clean shutdown, so a deliberate quit is never
mistaken for a crash.

The two restarts are told apart deliberately, because they mean different things.
A self-relaunch says the fault was catchable and the process shut itself down.
A Windows restart says the process died outright — the more serious of the two —
and the application reports which one happened.

### Refusing to restart is the harder half

An application that crashes during startup, relaunches, and crashes again forever
is strictly worse than one that stayed down: it burns a core doing it, and it is
harder to notice and harder to stop. For a tool whose premise is not being a
burden on the machine, that would be indefensible.

So every self-restart is written to disk with its timestamp, **the record
survives the restart** — which is the entire point, since a counter that resets on
each crash never fires — and past a threshold inside a window the application
stops relaunching and says so. The history is cleared once it has run long enough
to be considered healthy, so three unrelated crashes weeks apart are never
mistaken for a loop.

Renderer reloads follow the same shape at a smaller scale: immediate for the
first crash, because the user is looking at a blank window, then backing off, and
capped. Nothing in a renderer holds state the next snapshot cannot rebuild, which
is what makes reloading it free.

### A collector that dies silently is the worst case

A panic in the sampling thread unwinds that thread and leaves the rest of the
process running. For a monitor that is the worst possible failure: collection
stops, but everything still looks alive and the interface shows the last snapshot
forever. Nothing would ever notice, because the callback that would have reported
it is the thing that stopped.

The sampler is wrapped in `catch_unwind`, which turns that silent death into a
reportable one: `running` is cleared, the panic message is kept, and the main
process polls for it. The application then says the collector stopped and that
the values on screen are from before it did, instead of presenting stale numbers
as current.

### What is written down

A rotating log under the user's application data, capped in size with a bounded
number of generations — the same principle as the history database. Writes are
**synchronous**, because the lines that matter most are the last ones before the
process died and a buffered write loses exactly those. That is only affordable
because the volume is deliberately tiny: lifecycle, failures, and crash detail.
Nothing per-snapshot is ever logged.

Beside it, one JSON report per crash carrying the reason, the stack, how long the
process had been up and whether it recovered; and Electron's minidumps for native
faults, with **uploading switched off**. Nothing about the machine leaves it.

Renderer errors are forwarded to main so they reach the same log — an error that
only ever reached a devtools console is one nobody will find afterwards — and the
forwarding is capped, because an error inside a render loop can fire thousands of
times a second and push the useful history out of the file.

### Proving it works

Recovery code that has never run is a guess. `--crash-test=main` faults the main
process on purpose a few seconds after startup, and `--crash-test=collector`
simulates the sampler dying. It needs an explicit command-line argument, so it
cannot fire by accident, and it is stripped before relaunching so the restarted
instance comes back healthy rather than faulting again forever.

This is the same instinct as the telemetry probes: the repository does not trust
that a collector reads correctly, and it should not trust that a recovery path
works either.

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

Milestones 1-9 are implemented. What remains deliberately uncollected — and why —
is listed at the end of [`telemetry.md`](telemetry.md#not-collected).
