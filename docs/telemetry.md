# Telemetry reference

Every metric this application displays is defined here: what it means, where the
number comes from, how it is calculated, and how it differs from what other
tools show.

The governing rule is that a displayed number must have exactly one meaning. Where
Windows offers several incompatible definitions of "the same" quantity, we expose
each of them under its own name rather than picking one and calling it *CPU*.

Contents:

- [Sampling model](#sampling-model)
- [CPU](#cpu)
  - [Aggregate time utilization](#metric-aggregate-time-utilization)
  - [Processor utility](#metric-processor-utility)
  - [Busiest logical processor](#metric-busiest-logical-processor)
  - [DPC and interrupt time](#metric-dpc-and-interrupt-time)
  - [Per-logical-processor utilization](#metric-per-logical-processor-utilization)
  - [Processor performance and speed](#metric-processor-performance-and-speed)
  - [Topology](#cpu-topology)
- [Memory](#memory)
- [Processes](#processes)
  - [Process CPU](#metric-process-cpu)
- [Collector self-measurement](#collector-self-measurement)
- [Measured discrepancies](#measured-discrepancies)
  - [The process CPU accounting gap](#the-process-cpu-accounting-gap)

---

## Sampling model

One thread, one timer, one snapshot.

A dedicated OS thread inside the native module wakes on an interval (500 ms by
default), reads every subsystem, and produces a single `SystemSnapshot`. CPU,
memory and process values in one snapshot therefore describe the *same* interval,
which is what makes it meaningful to compare a process's CPU share against the
aggregate CPU figure.

**Intervals are measured, never assumed.** The elapsed time between the previous
sample and this one is read from a monotonic clock (`Instant`, backed by
`QueryPerformanceCounter`) and carried in `snapshot.intervalMs`. Every rate is
divided by that measured value. If the machine stalls and the next sample lands
822 ms later, rates are divided by 822 ms, not by the configured 500 ms.

**Wall-clock time is never used for rate maths.** `wallClockUnixMs` is recorded
for display and for future persistence only. It can jump backwards from NTP
correction, a manual clock change, or a timezone change.

**The loop does not accumulate drift.** It sleeps for `interval - work`, so a
collection that costs 35 ms does not push the next sample 35 ms late. It also
never bursts to "catch up" after a slow tick: a late sample is still a correct
measurement of a longer interval.

**Cumulative counters need a predecessor.** Every CPU and I/O counter Windows
exposes is cumulative since boot or since process start. A rate needs two
readings. On the first sample, and after any discarded sample, rate fields are
*absent* rather than zero. Reporting a process-lifetime average as "current CPU"
would be wrong, so we do not.

Snapshots are delivered to JavaScript through an N-API threadsafe function in
non-blocking mode. If the JavaScript side cannot keep up, the snapshot is dropped
and counted in `diagnostics.droppedSnapshots` — the sampling thread is never
blocked, because blocking it would corrupt the interval of every later sample.

---

## CPU

### Why there is more than one CPU number

Windows can answer "how busy is the CPU" in at least three incompatible ways, and
they routinely disagree by a factor of two on modern hardware. This application
shows them separately.

| Metric | Answers | Frequency-aware |
|---|---|---|
| Aggregate time utilization | What fraction of available processor *time* was not idle | No |
| Processor utility | What fraction of the processor's *nominal work capacity* was used | Yes |
| Busiest logical processor | How saturated is the most loaded single processor | No |

---

<a id="metric-aggregate-time-utilization"></a>
### Metric: Aggregate time utilization

**User-facing label:** Utilization / Time utilization
**Field:** `cpu.aggregateTimeUtilizationPercent`
**Units:** percent, 0–100

**Definition.** The fraction of total logical-processor execution time during the
interval that was spent doing something other than running the idle thread.

**Windows data source.** `NtQuerySystemInformation` with
`SystemProcessorPerformanceInformation` (class 8), which returns
`SYSTEM_PROCESSOR_PERFORMANCE_INFORMATION` per logical processor: cumulative
`IdleTime`, `KernelTime`, `UserTime`, `DpcTime` and `InterruptTime` in 100 ns
units.

On machines with more than one processor group, class 8 alone reports only the
calling thread's group. We detect the group count from
`GetLogicalProcessorInformationEx` and, when there is more than one, query each
group individually through `NtQuerySystemInformationEx` with the group number as
the input buffer.

**Calculation.** Per logical processor, between two samples:

```
idle   = idle₁   - idle₀
kernel = kernel₁ - kernel₀      # NOTE: KernelTime includes IdleTime
user   = user₁   - user₀

total  = kernel + user
busy   = total - idle
```

Aggregated over all logical processors:

```
aggregateTimeUtilizationPercent = Σbusy / Σtotal × 100
```

The aggregate is computed by summing the per-processor deltas rather than by
calling `GetSystemTimes` separately, so the total and the per-processor list are
guaranteed to be consistent with each other.

**Sampling method.** Two readings of the cumulative counters, one interval apart.

**Aggregation method.** Sum of numerators over sum of denominators — a
time-weighted mean. Not the arithmetic mean of the per-processor percentages;
`cpu.averageLogicalProcessorPercent` exposes that separately so any difference is
visible rather than assumed away. They coincide when all processors observed the
same elapsed time, which is normally the case.

**Rejected samples.** The interval is discarded, and the field is absent, when:

- there is no previous sample;
- the logical processor count changed (processor hot-add, group change) — the new
  and old readings describe different sets of processors, so no delta between them
  is meaningful;
- any counter moved backwards, which happens across sleep/resume;
- the total delta is zero.

`cpu.debug.discardReason` names the case.

**Known differences from Windows Task Manager.** Task Manager does **not** show
this metric. It shows [processor utility](#metric-processor-utility). On a CPU
running above its base clock, this number is *lower* than Task Manager's; on a
throttled CPU it is *higher*. See [measured discrepancies](#measured-discrepancies).

**Known limitations.** Frequency-blind by construction. A processor running at
800 MHz and one running at 5 GHz both read 100% if they never idle.

---

<a id="metric-processor-utility"></a>
### Metric: Processor utility

**User-facing label:** Processor utility
**Field:** `cpu.processorUtilityPercent`
**Units:** percent, 0 to above 100

**Definition.** Busy time weighted by the performance actually delivered relative
to the processor's nominal frequency. Informally: what fraction of the work the
processor *could* nominally have done, did it do.

**Windows data source.** PDH counter
`\Processor Information(_Total)\% Processor Utility`, registered with
`PdhAddEnglishCounterW` so the path does not depend on the display language, and
formatted with `PDH_FMT_DOUBLE | PDH_FMT_NOCAP100`.

**Calculation.** Performed by Windows inside the performance counter, not by us.
We deliberately do not reimplement it: the counter is the definition.

**Why it can exceed 100.** A processor boosting above its nominal frequency
delivers more work per unit time than nominal, so utility above 100% is a correct
reading, not an error. We report it uncapped. Windows Task Manager clamps its
display at 100%.

**Sampling method.** One `PdhCollectQueryData` per sampling interval, so PDH's
rate window matches our own. The first collection only establishes a baseline;
the metric is absent until the second.

**Known differences from Windows Task Manager.** This is Task Manager's number,
except that Task Manager clamps the display at 100% and we do not.

**Known limitations.** Requires PDH. If the counter cannot be registered the field
is absent — we do not substitute a computed approximation.

---

<a id="metric-busiest-logical-processor"></a>
### Metric: Busiest logical processor

**User-facing label:** Busiest / Busiest logical processor
**Fields:** `cpu.busiestLogicalProcessorPercent`, `cpu.busiestLogicalProcessorIndex`

**Definition.** The maximum of per-logical-processor time utilization across all
logical processors for the interval, and which processor it was.

**Why this exists.** This is the single most common source of "why does one tool
say 95% and another say 14%". A single-threaded workload saturating one core of a
24-processor machine produces:

- aggregate time utilization ≈ 4.2%
- busiest logical processor ≈ 100%

Both are correct measurements of different things. A monitor reporting the second
number as "CPU" is not wrong, it is answering a different question. Showing both
side by side makes the discrepancy self-explanatory.

---

<a id="metric-dpc-and-interrupt-time"></a>
### Metric: DPC and interrupt time

**Fields:** `cpu.aggregateDpcPercent`, `cpu.aggregateInterruptPercent`

**Definition.** Machine-wide share of processor time spent servicing deferred
procedure calls and interrupt service routines, computed the same way as the
aggregate: summed DPC (or interrupt) delta over summed total delta.

**Both are subsets of kernel time.** Windows accounts DPC and ISR time *inside*
`KernelTime`, so these must never be added to the kernel/user breakdown.

**Why they are exposed.** This time is not charged to any process, which is one
of the reasons per-process CPU shares sum to slightly less than the aggregate.
Making it visible turns part of that gap from a mystery into a number. Measured on
the development machine, DPC plus interrupt together account for roughly 0.5–1.2
percentage points.

---

<a id="metric-per-logical-processor-utilization"></a>
### Metric: Per-logical-processor utilization

**Field:** `cpu.perLogicalProcessor[]`

Each entry carries `timeUtilizationPercent` plus the mode breakdown from the same
counters:

| Field | Derivation |
|---|---|
| `timeUtilizationPercent` | `(kernel + user - idle) / (kernel + user)` |
| `kernelPercent` | `(kernel - idle) / total` — kernel excluding idle |
| `userPercent` | `user / total` |
| `dpcPercent` | `dpc / total` — a **subset** of kernel time, not additional to it |
| `interruptPercent` | `interrupt / total` — also a subset of kernel time |

`dpcPercent` and `interruptPercent` must not be added to the others; Windows
accounts DPC and ISR time inside `KernelTime`.

**Addressing.** A logical processor is identified by `(group, numberInGroup)`.
`index` is a stable flat index that orders group 0 first, then group 1, and so on,
so machines with more than 64 logical processors work correctly.

---

<a id="metric-processor-performance-and-speed"></a>
### Metric: Processor performance and speed

**Fields:** `cpu.processorPerformancePercent`, `cpu.currentFrequencyMhz`

**Processor performance** is the PDH counter
`\Processor Information(_Total)\% Processor Performance`: the average delivered
frequency during the interval as a percentage of nominal. Above 100% means the
processor was boosting.

**Speed** is derived exactly as Task Manager derives it:

```
currentFrequencyMhz = baseFrequencyMhz × processorPerformancePercent / 100
```

where `baseFrequencyMhz` is the registry value `~MHz` under
`HKLM\HARDWARE\DESCRIPTION\System\CentralProcessor\0`, which Windows writes at
boot.

**This is a derivation, not a measurement.** It is labelled as such in the UI. We
do not time a spin loop to estimate a clock.

Additionally, `perLogicalProcessor[].currentFrequencyMhz` and `maxFrequencyMhz`
come from `CallNtPowerInformation(ProcessorInformation)`. The power manager derives
`CurrentMhz` itself and on many modern parts it simply mirrors the nominal
frequency, so it is reported as-is and never blended into the derived speed above.
That call also reports only the calling thread's processor group, so on
multi-group machines the tail of the list has no frequency data — reported as
absent rather than by repeating group 0's values.

---

<a id="cpu-topology"></a>
### CPU topology

**Source.** `GetLogicalProcessorInformationEx(RelationAll)`, parsed for
`RelationProcessorPackage`, `RelationProcessorCore` and `RelationGroup` records.

| Field | Source |
|---|---|
| `packageCount` | count of `RelationProcessorPackage` records |
| `physicalCoreCount` | count of `RelationProcessorCore` records |
| `logicalProcessorCount` | sum of `ActiveProcessorCount` over groups |
| `processorGroupCount` | `ActiveGroupCount` from the `RelationGroup` record |
| `isHybrid` | more than one distinct `EfficiencyClass` across cores |
| `efficiencyClasses` | the distinct `PROCESSOR_RELATIONSHIP::EfficiencyClass` values |

**On P-cores and E-cores.** We report `EfficiencyClass` exactly as Windows gives
it and nothing more. We do not label cores "Performance" or "Efficiency", do not
infer core types from frequency, core counts, or the CPU brand string, and report
`isHybrid: false` whenever Windows reports a single class. A higher efficiency
class is the more performant one; that ordering is the only interpretation we
apply.

---

## Memory

"Memory used" is not one number. The components are exposed and the UI explains
them.

| Field | Source | Meaning |
|---|---|---|
| `installedPhysicalBytes` | `GetPhysicallyInstalledSystemMemory` | RAM reported by SMBIOS. Larger than usable by whatever firmware and hardware reserve. |
| `totalPhysicalBytes` | `MEMORYSTATUSEX.ullTotalPhys` | Physical memory usable by the OS. |
| `availablePhysicalBytes` | `MEMORYSTATUSEX.ullAvailPhys` | Free + zeroed + standby pages. |
| `usedPhysicalBytes` | derived | `totalPhysical - availablePhysical`. Task Manager's "In use". |
| `physicalUtilizationPercent` | derived | `used / total × 100`. |
| `memoryLoadPercent` | `MEMORYSTATUSEX.dwMemoryLoad` | Windows's own percentage, kept as a cross-check. |
| `committedBytes` | `GetPerformanceInfo` `CommitTotal × PageSize` | Commit charge. |
| `commitLimitBytes` | `GetPerformanceInfo` `CommitLimit × PageSize` | RAM plus current page file size. |
| `commitPeakBytes` | `GetPerformanceInfo` `CommitPeak × PageSize` | Highest commit charge since boot. |
| `standbyBytes` | `SystemMemoryListInformation` | Sum of `PageCountByPriority[0..7]` × page size. |
| `modifiedBytes` | `SystemMemoryListInformation` | Modified + modified-no-write pages. |
| `freeBytes` | `SystemMemoryListInformation` | Free + zeroed pages. |
| `cachedBytes` | derived | `standby + modified`. The definition Task Manager labels "Cached". |
| `pagedPoolBytes` | `GetPerformanceInfo` `KernelPaged × PageSize` | |
| `nonPagedPoolBytes` | `GetPerformanceInfo` `KernelNonpaged × PageSize` | |
| `pageFileTotalBytes` | derived | `ullTotalPageFile - ullTotalPhys`. Absent if that would be negative. |
| `pageFileUsedBytes` | derived | `max(committed - totalPhysical, 0)`, bounded by page file size. |

**The trap in "available".** `ullAvailPhys` already counts the standby list —
pages holding cached file data that can be reclaimed instantly. So "in use" is not
"memory processes are actively holding", and "in use" can fall without any process
releasing anything. The memory composition bar exists to make this visible.

**Commit is not RAM.** Commit charge is a promise of backing store, not resident
pages, and legitimately exceeds physical memory. Running out of *commit* is a
different failure from running out of RAM, and produces different symptoms
(allocation failures rather than paging).

**Sampling.** All memory values are instantaneous readings, not rates, so there is
no previous-sample state and no first-sample gap.

`SystemMemoryListInformation` (class 80) has no documented Win32 equivalent; when
it is unavailable the standby/modified/free breakdown and `cachedBytes` are absent
and the composition bar says so rather than guessing.

---

## Processes

### Enumeration

**Source.** A single `NtQuerySystemInformation(SystemProcessInformation)` call
returning `SYSTEM_PROCESS_INFORMATION` for every process, with each process's
threads inline.

**Why not `OpenProcess` per PID.** The handle-based approach costs several
thousand syscalls per sample, and still fails with `ERROR_ACCESS_DENIED` on system
and protected processes. The single call returns CPU times, memory (including
private working set, which no Win32 API exposes), handle counts, thread counts and
I/O counters for every process without a handle. Measured on a 1000-process
machine: ~30 ms for the whole list, versus ~180 ms for the handle approach on the
subset of fields it can even reach.

### Identity

`key = "{pid}:{createTime100ns}"`.

Windows reuses PIDs. A CPU delta computed between two different programs that
happened to share a PID would appear as an enormous spike. Everything that must
survive across samples — CPU deltas, I/O deltas, the detail cache, parent links,
React row identity — is keyed on this string.

`createTime100ns` is also exposed as a number, but a FILETIME is around 1.3 × 10¹⁷
and exceeds the exact integer range of a JavaScript double. It is **display only**;
the `key` string is formatted in Rust at full precision.

### Parent links

`parentKey` is set only when a process with the reported parent PID currently
exists *and* was created no later than the child. PID 0 is never treated as a
parent. This means a link is absent rather than wrong when the parent has exited
or its PID has been recycled.

---

<a id="metric-process-cpu"></a>
### Metric: Process CPU

**Fields:** `cpuMachinePercent`, `cpuCoreEquivalentPercent`

Two normalisations, always labelled, never both called "CPU %".

**Machine share** — the share of *total machine capacity*:

```
cpuMachinePercent =
    Δ(kernelTime + userTime)
    ────────────────────────────────────────────
    intervalMs × 10000 × logicalProcessorCount
    × 100
```

On a 24-logical-processor machine, one fully saturated logical processor is
`100 / 24 ≈ 4.17%`. These values sum to approximately the aggregate CPU figure,
which is what makes the process list explain the total.

**Core equivalent** — one saturated logical processor is 100%:

```
cpuCoreEquivalentPercent = cpuMachinePercent × logicalProcessorCount
```

A process using four processors reads 400%. This is what developers usually want
when asking "how many cores is this thing using".

**Source.** `KernelTime` and `UserTime` from `SYSTEM_PROCESS_INFORMATION`,
cumulative 100 ns units since process start.

**Absent, not zero.** Both fields are absent until the process has been seen in two
consecutive samples under the same identity.

### Process memory

| Field | Source | Meaning |
|---|---|---|
| `privateWorkingSetBytes` | `WorkingSetPrivateSize` | Physical memory private to the process. **This is the default "Memory" column**, and the basis Task Manager uses. |
| `workingSetBytes` | `WorkingSetSize` | All physical memory mapped, shared pages included. Summing this across processes double-counts shared memory. |
| `privateCommitBytes` | `PagefileUsage` | Private committed bytes. Task Manager's "Commit size". |
| `peakWorkingSetBytes` | `PeakWorkingSetSize` | |
| `virtualSizeBytes` | `VirtualSize` | Address space reserved, mostly meaningless as a memory figure on 64-bit. |
| `pagedPoolBytes` / `nonPagedPoolBytes` | `QuotaPagedPoolUsage` / `QuotaNonPagedPoolUsage` | Kernel memory charged to the process. |
| `pageFaultCount` / `hardFaultCount` | `PageFaultCount` / `HardFaultCount` | Hard faults required a disk read; a rising rate under memory pressure is what thrashing looks like. |

**Why private working set is the default.** It is the only one of these that
answers "how much physical memory would I get back if this process exited", and it
does not double-count shared pages when you read down the column.

### Process I/O

`ioReadBytes` / `ioWriteBytes` / `ioOtherBytes` and their operation counts come
from the process I/O counters in `SYSTEM_PROCESS_INFORMATION`. Rates are derived
over the measured interval.

**These are not disk metrics.** Windows I/O counters cover file, network, device
and pipe I/O alike. A process reading from a network socket increases
`ioReadBytes`. Real disk attribution needs ETW and is a later milestone; until
then these columns are labelled "I/O", not "Disk".

### Process trees

`parentKey` links a child to a parent only when a live process with that PID
exists *and* was created no later than the child, and PID 0 is never treated as a
parent. A link is therefore absent rather than wrong when the parent has exited
or its PID has been recycled; such processes appear as roots.

Subtree totals sum only metrics that are actually additive:

| Field | Additive | Why |
|---|---|---|
| `cpuMachinePercent` | yes | Shares of one common denominator, total machine capacity |
| `privateWorkingSetBytes` | yes | Private by definition, so no page is counted twice |
| `privateCommitBytes` | yes | Also private |
| `threadCount`, `handleCount` | yes | Counts of distinct objects |
| I/O rates | yes | Independent byte streams |
| `workingSetBytes` | **no** | Includes shared pages; summing double-counts them |
| `peakWorkingSetBytes` | **no** | A historical maximum, not a quantity |
| `virtualSizeBytes` | **no** | Reserved address space, meaningless summed |

A subtree with no CPU measurement anywhere reports no CPU value rather than 0%.

### Application grouping

Grouping uses only signals Windows provides, in this order:

1. **Package identity** — `GetPackageFullName`. Windows assigns it, so two
   processes sharing it are the same application by definition. The version
   component is excluded from the key so an in-place update does not split a
   group in two.
2. **Publisher and product** — `CompanyName` and `ProductName` from the image
   version resource, read with `GetFileVersionInfoW` / `VerQueryValueW` using the
   image's own language/codepage rather than assuming US English. This is what
   places many `chrome.exe` processes under "Google Chrome".
3. **Executable path** — for images with no version resource. Grouping by bare
   file name would merge unrelated programs, so it is not done.
4. **Image name** — only when the path could not be read, which happens for
   processes we lack rights to open.

Windows' generic hosts (`svchost.exe`, `rundll32.exe`, `dllhost.exe`,
`taskhostw.exe`, `backgroundtaskhost.exe`, `runtimebroker.exe`, `conhost.exe`,
`wmiprvse.exe`) are excluded from rule 2, because they all declare the same
Windows product name and grouping on it would collapse dozens of unrelated
services into one meaningless row. They fall through to path-based grouping.

There is no built-in database of application names, and every group records the
signal that formed it so the UI can explain the grouping. Member processes are
always inspectable.

### Handle-derived details

Image path, command line, owning user, architecture and protection status require
a process handle. They are static for a process's lifetime, so they are resolved
once per identity and cached.

| Field | Source |
|---|---|
| `imagePath` | `QueryFullProcessImageNameW` |
| `commandLine` | `NtQueryInformationProcess(ProcessCommandLineInformation)` — needs only `PROCESS_QUERY_LIMITED_INFORMATION`, unlike reading the PEB |
| `userName` | `OpenProcessToken` → `GetTokenInformation(TokenUser)` → `LookupAccountSidW`, with a process-wide SID cache |
| `architecture`, `isWow64` | `IsWow64Process2` |
| `isProtected` | `NtQueryInformationProcess(ProcessBasicInformation)` with a `PROCESS_EXTENDED_BASIC_INFORMATION` buffer, bit 0 |

`detailFailure` records why they are missing:

| Value | Meaning |
|---|---|
| `accessDenied` | `OpenProcess` was refused. Elevation would reveal these fields. |
| `processExited` | The process vanished between enumeration and the detail read. Normal and frequent. |
| `notSupported` | PID 0, the System Idle Process, which cannot be opened. |
| `pending` | Queued behind this tick's resolution budget; fills in within a tick or two. |

**Resolution budget.** At most 96 new processes have their details resolved per
tick. Resolving a thousand at once costs ~180 ms and would overrun the sampling
interval on the very first sample. Steady-state churn is a few processes per tick,
well under the budget.

---

## Collector self-measurement

A resource monitor that cannot account for its own cost is not trustworthy.
`snapshot.diagnostics` reports, every interval:

| Field | Meaning |
|---|---|
| `totalDurationMs` | Wall time inside the native collector for this snapshot |
| `cpuDurationMs`, `memoryDurationMs`, `processDurationMs` | Per-subsystem breakdown |
| `droppedSnapshots` | Snapshots JavaScript could not accept in time. Should stay at 0. |
| `trackedProcessCount` | Process identities held for delta calculation. Should track the live process count, not grow. |

The Debug page turns these into a duty cycle and a machine share.

**Measured on the development machine** (Intel Core Ultra 9 275HX, 24 logical
processors, ~1000 processes, 500 ms interval):

| Subsystem | Cost per sample |
|---|---|
| CPU | ~1.0 ms |
| Memory | ~4.5 ms |
| Processes | ~32–44 ms |
| **Total** | **~38–50 ms** |

The process list dominates, and almost all of it is the kernel walking every
process and every thread to service the call. Buffer reuse across samples removed
~15 ms of that: getting the buffer size wrong forces the kernel to do the walk
twice.

As a share of the machine, ~40 ms of one thread per 500 ms is roughly
`40 / 500 / 24 ≈ 0.33%` of total capacity.

---

## Measured discrepancies

Observed on the development machine while a Rust build was running. All four
numbers describe the same interval.

| Metric | Value |
|---|---|
| Aggregate time utilization (ours) | 58.80% |
| `GetSystemTimes` cross-check | 58.80% |
| PDH `% Processor Time` | 59.18% |
| PDH `% Processor Utility` (Task Manager) | 102.18% |
| PDH `% Processor Performance` | 164.0% |
| Derived speed | 5.04 GHz (base 3.072 GHz) |

**Reading this table.**

- Our aggregate and the independent `GetSystemTimes` computation agree exactly, as
  they must: both measure idle time, from different APIs, over the same interval.
- PDH `% Processor Time` differs by ~0.4 points because PDH maintains its own
  sampling window that does not align exactly with ours. This is expected and is
  not corrected for.
- **Processor utility is 1.74× time utilization**, closely tracking
  `% Processor Performance / 100 = 1.64` (they are not identical because utility is
  computed per processor and then aggregated, whereas the ratio here is taken on
  the aggregates). The CPU was running at 5.04 GHz against a 3.072 GHz base, so it
  delivered far more work per unit time than nominal.

This is the concrete answer to "why does one monitor say 95% and another says
14%", in its frequency-scaling form: a tool showing time utilization and a tool
showing processor utility will disagree by the boost ratio, and neither is wrong.
The `busiest logical processor` metric covers the other common form, where a tool
reports single-core saturation as if it were the whole machine.

The Debug page shows all of these live, along with the raw counter deltas they were
computed from and the ratio `utility ÷ time utilization`.

### Validation against Windows counters

`node tools/validate.mjs` runs our engine and `Get-Counter` over the same window
and compares the means. A representative 20-second run:

| Metric | Ours | Windows | Difference |
|---|---|---|---|
| `% Processor Utility` | 95.60% | 95.75% | −0.16% |
| `% Processor Performance` | 174.49% | 174.41% | +0.05% |
| Time utilization vs PDH `% Processor Time` | 53.54% | 53.69% | −0.28% |
| Time utilization vs `GetSystemTimes` | 53.54% | 53.54% | 0.00% |
| Memory available | 6.534 GiB | 6.537 GiB | −0.06% |
| Memory committed | 158.081 GiB | 158.081 GiB | 0.00% |
| Process count | 998.5 | 999.3 | −0.08% |
| Thread count | 24588 | 24666 | −0.31% |

The sub-percent differences against PDH come from PDH keeping its own sampling
window, which cannot be phase-aligned with ours. They are not corrected for.

### Validation against a controlled workload

`node tools/measure-load.mjs N` runs a process with N busy threads and compares
the reported per-process CPU against arithmetic. On the 24-logical-processor
development machine, with the machine already ~50% busy:

| Threads | Expected core-equivalent | Measured | Error |
|---|---|---|---|
| 1 | 100.0% | 98.56% | −1.44% |
| 4 | 400.0% | 391.95% | −2.01% |

The shortfall grows with contention, which is what you would expect: on a busy
machine a spinning thread does not get an entire logical processor to itself. The
normalisation itself is confirmed correct.

<a id="the-process-cpu-accounting-gap"></a>
### The process CPU accounting gap

Summed per-process machine shares come to 3–8 percentage points less than the
aggregate CPU figure. This was investigated rather than papered over.

**It is not process churn.** Instrumenting appeared/vanished processes per
interval shows the gap persisting at 3–8 points across intervals where *zero*
processes started or exited, so unattributed time from short-lived processes is
not the cause.

**DPC and interrupt time explains about one point.** Measured simultaneously:

```
agg=52.44%  sumProc(noIdle)=45.12%  missing=7.33%
            dpc=0.26%  isr=0.52%    → residual 6.54%
```

Windows does not charge DPC or ISR time to any process, so it appears in the
per-processor counters and in no process. Process Explorer models this by
inventing "Interrupts" and "DPCs" pseudo-processes; we report it as two
machine-wide metrics instead of fabricating rows.

**The residual is an accounting difference.** Per-processor idle time and
per-thread execution time are accumulated by different mechanisms in the Windows
kernel, and they are not guaranteed to reconcile. The controlled-workload results
above show the same bias in miniature: a thread that should read 100% reads
98.6%.

**What we do about it.** Nothing. Both figures are reported as measured, the
components of the gap that can be named are exposed as their own metrics, and the
difference is documented here. Scaling process percentages up so they sum to the
aggregate would make the numbers agree and make them wrong.

---

## Not yet collected

These are deliberately absent from the UI rather than shown as zero or estimated:
GPU, VRAM, disk throughput, disk latency, network throughput, per-process disk and
network attribution, file-level I/O attribution, persistent history.
