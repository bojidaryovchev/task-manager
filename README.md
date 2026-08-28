# Task Manager

A high-accuracy Windows system resource and process monitor built with Electron,
TypeScript, React, Rust, and native Windows telemetry APIs.

CPU · Memory · Processes · Applications · Desktop widget — GPU, Disk, Network
and History to follow.

---

## What this is for

Most resource monitors show you a number. This one shows you *which* number, and
why it differs from the one another tool is showing you.

On the machine this was developed on, at the same instant:

| Metric | Value |
|---|---|
| Aggregate time utilization | 58.80% |
| Processor utility (what Windows Task Manager displays) | 102.18% |
| Busiest single logical processor | 96.9% |

None of those is wrong. They are three different questions. The CPU was boosting
to 5.0 GHz against a 3.07 GHz base, so it was delivering 1.64× its nominal work
rate — which is exactly the gap between the first two rows. The application shows
all three side by side, and the Debug page shows the raw counter deltas each was
computed from.

Every metric is defined, with its Windows source and calculation, in
[`docs/telemetry.md`](docs/telemetry.md).

---

## Requirements

**To run:** Windows 11 x64. Nothing else — the shipped build is a single
executable with no installer and no runtime prerequisites. It runs without
Administrator rights; a few per-process detail fields (path, command line, owner
of other users' processes) are unavailable unless elevated, and the application
says so rather than showing blanks.

**To build:**

| Tool | Version used | Notes |
|---|---|---|
| Node.js | 20+ | 25.x used here |
| pnpm | 10+ | `corepack enable pnpm` |
| Rust | 1.82+ | `x86_64-pc-windows-msvc` toolchain |
| Visual Studio Build Tools | 2022 | "Desktop development with C++" workload, plus a Windows 11 SDK |

The MSVC toolchain is required: the native module is a standard N-API addon and
links the same way any Windows native module does.

---

## Getting started

```powershell
pnpm install
pnpm native:build     # build the Rust telemetry module
pnpm dev              # run the app with hot reload
```

`pnpm native:build` must run before the first `pnpm dev`, `pnpm typecheck` or
`pnpm build`: the native module emits `index.d.ts`, and the TypeScript types are
checked against it (see [Type safety across the boundary](#type-safety-across-the-boundary)).

### All scripts

| Command | Does |
|---|---|
| `pnpm dev` | Run the app with renderer hot reload |
| `pnpm build` | Build the native module and the application |
| `pnpm package` | Produce `release/TaskManager-<version>-x64.exe`, a single portable executable |
| `pnpm test` | Run the TypeScript test suites |
| `pnpm test:native` | Run the Rust test suite |
| `pnpm typecheck` | Type-check every package |
| `pnpm check:contrast` | Verify every UI colour pair against WCAG contrast minimums |
| `pnpm native:build` | Build the Rust telemetry module in release mode |

### Development and validation tools

| Command | Does |
|---|---|
| `node tools/validate.mjs [seconds]` | Compare every metric against Windows' own performance counters over the same window |
| `node tools/measure-load.mjs [threads] [seconds]` | Run a controlled CPU workload and check per-process CPU normalisation against arithmetic expectation |
| `node tools/devtools.mjs shot <file.png> [page]` | Drive the running app over the DevTools protocol (needs `--remote-debugging-port`) |
| `node tools/fixtures/cpu-load.mjs [threads] [seconds]` | A controlled CPU workload, on its own |
| `python tools/generate-icons.py` | Regenerate the application icons from `logo.png` (needs Pillow) |
| `TASK_MANAGER_TARGET=widget node tools/devtools.mjs shot <file.png>` | Capture the widget window rather than the main one |

---

## Project structure

```
task-manager/
├── apps/desktop/            Electron application
│   └── src/
│       ├── main/            Lifecycle, native loading, telemetry service, IPC
│       ├── preload/         The only bridge to the renderer
│       ├── renderer/        React UI
│       └── shared/          IPC contract, shared by all three
├── native/telemetry/        Rust N-API module — all Windows API access
│   └── src/
│       ├── win/             Raw Windows calls; the only place `unsafe` appears
│       ├── cpu/             CPU collection and calculation
│       ├── memory/          Memory collection
│       ├── process/         Process enumeration and per-process detail
│       ├── sampling/        The single sampling engine
│       └── api.rs           N-API transport structures
├── packages/
│   ├── telemetry-types/     The documented telemetry model, shared by everything
│   └── shared/              Pure formatting and ring-buffer helpers
├── docs/
│   ├── telemetry.md         Every metric: definition, source, calculation, limits
│   └── architecture.md      How the pieces fit together and why
├── tools/                   Validation and development utilities
└── logo.png                 Source artwork for the application icons
```

Icons are generated from `logo.png` into `apps/desktop/build/` (a 512px PNG and a
multi-resolution ICO) and into the renderer's assets. The source art has a wide
transparent border, so the generator crops to the artwork and re-pads it — an
icon that does not fill its frame looks undersized next to everything else in the
taskbar.

---

## How native telemetry works

```
Windows (Win32 · PSAPI · PDH · NT)
        ↓
Rust collectors  — read counters, compute every metric
        ↓
Sampling engine  — one thread, one timer, one snapshot
        ↓
N-API threadsafe function
        ↓
Electron main    — TelemetryService, fans out to every presentation
        ↓
Preload bridge   — a fixed, typed API surface
        ↓
React renderer   — renders values; calculates none
```

Three properties this arrangement guarantees:

**One implementation per metric.** CPU utilization is computed in exactly one
place. The main window, and later the tray and the desktop widget, cannot drift
apart because they are reading the same computed numbers, not recomputing them.

**No telemetry maths in React.** The renderer formats and draws. If you find
yourself dividing counters in a component, the calculation belongs in Rust.

**Collection never blocks the UI.** Sampling runs on its own OS thread inside the
native module. Snapshots reach JavaScript through a threadsafe function in
non-blocking mode: if the UI ever falls behind, the snapshot is dropped and
counted rather than stalling the sampler and corrupting the next interval.

### Type safety across the boundary

`packages/telemetry-types` is hand-written so it can carry the documentation that
makes each metric's meaning explicit. `apps/desktop/src/main/native-contract.ts`
then asserts, at compile time and in both directions, that those types and the
N-API-generated declarations describe the same thing. A field added in Rust and
not documented — or documented and not produced — fails `pnpm typecheck`.

### Electron security

- `contextIsolation` on, `nodeIntegration` off, `webviewTag` off.
- The renderer gets a fixed set of functions on `window.taskManager`. It cannot
  name an IPC channel, cannot invoke an arbitrary one, and has no access to
  `ipcRenderer`, `require`, `fs` or `child_process`.
- Configuration arriving from the renderer is filtered key by key in the main
  process before it reaches the native module.
- Navigation and window opening are denied; external links go to the system
  browser.
- A Content-Security-Policy on the renderer document permits no remote code and
  no remote connections.

---

## Currently supported metrics

**CPU** — aggregate time utilization, processor utility (Task Manager's metric),
busiest logical processor, average logical processor, per-logical-processor
utilization with kernel/user/DPC/interrupt breakdown, machine-wide DPC and
interrupt shares, processor performance, derived clock speed, per-processor
frequency, topology (packages, physical cores, logical processors, processor
groups, efficiency classes), process/thread/handle totals, uptime.

**Memory** — installed vs usable physical, in use, available, utilization,
standby, modified, free, cached, committed, commit limit, commit peak, paged and
non-paged pool, page file size and usage, page size.

**Processes** — name, PID, parent, stable identity, image path, command line,
user, architecture, session, protection, base priority, CPU (as machine share and
as core equivalent), private working set, working set, private commit, peak
working set, pools, virtual size, page and hard faults, threads, handles,
cumulative and per-second I/O. Flat and tree views, with subtree totals for the
metrics that are actually additive.

**Applications** — processes grouped into applications using only signals Windows
provides: package identity first, then the publisher and product declared in the
executable's version resource, then the executable path. Every group states which
signal formed it and expands to the raw processes underneath.

**Desktop widget** — a frameless, always-on-top overlay in four layouts
(minimal, compact, performance, top consumers), with selectable metrics,
adjustable opacity, click-through, position lock, edge snapping and persisted
placement. It is a second window in the same application reading the same
snapshot stream, so it cannot disagree with the main window.

**Tray** — live tooltip from the same snapshots, and the menu that controls the
widget. It is also the guaranteed way out of click-through mode.

**Self-measurement** — per-subsystem collection cost, duty cycle, dropped
snapshots, tracked identity count.

---

## Measured accuracy

`node tools/validate.mjs` compares against Windows' own counters over a shared
window. A representative run on the development machine:

| Metric | Ours | Windows | Difference |
|---|---|---|---|
| CPU % Processor Utility | 95.60% | 95.75% | −0.16% |
| CPU % Processor Performance | 174.49% | 174.41% | +0.05% |
| CPU time utilization vs PDH % Processor Time | 53.54% | 53.69% | −0.28% |
| CPU time utilization vs GetSystemTimes | 53.54% | 53.54% | 0.00% |
| Memory available | 6.534 GiB | 6.537 GiB | −0.06% |
| Memory committed | 158.081 GiB | 158.081 GiB | 0.00% |
| Process count | 998.5 | 999.3 | −0.08% |
| Thread count | 24588 | 24666 | −0.31% |

`node tools/measure-load.mjs 4` runs four busy threads and checks per-process CPU
against arithmetic: 391.95% core-equivalent measured against 400% expected, an
error of −2.01% attributable to scheduler contention on an already-busy machine.

---

## Known limitations

- **Per-process CPU sums to 3–8% less than the aggregate.** Roughly one point is
  DPC and interrupt time, which Windows does not charge to any process. The rest
  is a systematic difference between Windows' per-thread time accounting and its
  per-processor idle accounting. Both figures are reported; neither is adjusted
  to make them agree. See [`docs/telemetry.md`](docs/telemetry.md#measured-discrepancies).
- **Process I/O counters are not disk metrics.** Windows I/O counters cover file,
  network, device and pipe I/O together. The columns are labelled "I/O", not
  "Disk"; real disk attribution needs ETW.
- **Some per-process details need elevation.** Image path, command line and owner
  are unavailable for other users' and protected processes when running as a
  standard user. The count is shown on the Processes page and each row says why.
- **Derived clock speed is a derivation, not a measurement.** Base frequency ×
  `% Processor Performance`, which is how Task Manager derives it.
- **Per-processor frequency covers one processor group.** The API reports only
  the calling thread's group; the rest is reported as unavailable rather than
  filled in with group 0's values.
- **Application grouping is only as good as its inputs.** Processes we cannot
  open have no path or version resource, so they group by image name alone —
  which is why all inaccessible `svchost.exe` instances land in one row. The
  grouping basis is shown on every row so this is visible rather than implied.
- **The widget can only show what is collected.** GPU, VRAM, disk and network
  appear in its metric picker but are disabled and labelled "not yet collected",
  because a blank or zeroed tile would imply a measurement that was never taken.
- **Not yet collected:** GPU, VRAM, disk throughput, network throughput,
  per-process disk and network attribution, file-level I/O attribution,
  persistent history.
- **Windows 11 x64 only.** The collectors are deliberately Windows-native; there
  is no cross-platform abstraction compromising them.

---

## Resource usage

Measured with the application monitoring itself, packaged build, 500 ms interval,
on a 24-logical-processor machine while the machine was ~50% busy:

| State | CPU (machine share) | Private working set |
|---|---|---|
| Overview open, no process list | 0.60% mean, 1.10% peak | 103 MB across 4 processes |
| Processes page open | 0.88% mean, 1.23% peak | 144 MB across 4 processes |

Handle, thread and process counts were flat across the runs.

The process list is collected only while a window is showing it, which is the
difference between the two rows: 1.8 ms per sample versus 37 ms. Snapshots are
not pushed to hidden or minimised windows at all.
