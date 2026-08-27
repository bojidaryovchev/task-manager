/**
 * CPU telemetry model.
 *
 * Windows exposes several *different* notions of "CPU usage" and this model
 * keeps them explicitly separate. Never collapse them into a single `cpu` number
 * without saying which definition is meant. See `docs/telemetry.md` for the
 * derivation and measured differences between them.
 *
 * Optional properties are genuinely absent when the underlying source could not
 * produce a value (first sample, counter unavailable, privilege). They are never
 * defaulted to zero, because "0%" and "we do not know" are different facts.
 */

/** Topology facts, all read from `GetLogicalProcessorInformationEx`. */
export interface CpuTopology {
  /** Physical packages (sockets). */
  packageCount: number;
  /** Physical cores across all packages. */
  physicalCoreCount: number;
  /** Logical processors across all processor groups. */
  logicalProcessorCount: number;
  /** Processor groups; greater than 1 above 64 logical processors. */
  processorGroupCount: number;
  /** Active logical processors per group, indexed by group number. */
  logicalProcessorsPerGroup: number[];
  /**
   * True only when Windows reports more than one `EfficiencyClass`, i.e. a
   * hybrid P/E-core design. Never inferred from core counts or the brand string.
   */
  isHybrid: boolean;
  /** Distinct efficiency classes Windows reported, ascending. 0 is least performant. */
  efficiencyClasses: number[];
  /** `ProcessorNameString` from the registry. */
  brandString?: string;
  /** Nominal base frequency in MHz, from the registry `~MHz` value written at boot. */
  baseFrequencyMhz?: number;
}

/** One logical processor's utilization over one interval. */
export interface LogicalProcessorSample {
  /** Flat index across all groups: group 0 first, then group 1, and so on. */
  index: number;
  group: number;
  /** Index within the processor group (0..63). */
  numberInGroup: number;
  /** Index into the physical core list, when Windows reported the relationship. */
  coreId?: number;
  /** Windows-reported efficiency class of the owning core. */
  efficiencyClass?: number;
  /**
   * Fraction of this processor's elapsed time not spent in the idle thread,
   * 0..100. Says nothing about the clock speed while it was busy.
   */
  timeUtilizationPercent: number;
  /** Fraction of the interval spent servicing DPCs, 0..100 (subset of kernel). */
  dpcPercent: number;
  /** Fraction of the interval spent servicing interrupts, 0..100 (subset of kernel). */
  interruptPercent: number;
  /** Fraction spent in kernel mode excluding idle, 0..100. */
  kernelPercent: number;
  /** Fraction spent in user mode, 0..100. */
  userPercent: number;
  /**
   * `CurrentMhz` from `CallNtPowerInformation(ProcessorInformation)`. The power
   * manager derives this and on many modern parts it simply mirrors the nominal
   * frequency; treat `CpuSnapshot.currentFrequencyMhz` as the better estimate.
   */
  currentFrequencyMhz?: number;
  /** `MaxMhz` from the same source. */
  maxFrequencyMhz?: number;
}

/** Raw `GetSystemTimes` deltas, collected as an independent cross-check. */
export interface GetSystemTimesDelta {
  idleDelta100ns: number;
  /** Includes idle time, as Windows documents. */
  kernelDelta100ns: number;
  userDelta100ns: number;
  /** `(kernel + user - idle) / (kernel + user) * 100`. */
  utilizationPercent: number;
}

/** Every input and intermediate value behind the aggregate CPU number. */
export interface CpuDebugSample {
  /** Measured monotonic interval used as the denominator, in milliseconds. */
  intervalMs: number;
  /** Sum over logical processors of the idle-time delta. */
  idleDelta100ns: number;
  /** Sum of the kernel-time delta. Includes idle. */
  kernelDelta100ns: number;
  /** Sum of the user-time delta. */
  userDelta100ns: number;
  /** `kernelDelta100ns + userDelta100ns`. */
  totalDelta100ns: number;
  /** `totalDelta100ns - idleDelta100ns`. */
  busyDelta100ns: number;
  /** Independently computed from `GetSystemTimes` over the same interval. */
  getSystemTimes?: GetSystemTimesDelta;
  /**
   * `totalDelta100ns / (intervalMs * 10000 * logicalProcessorCount)`.
   * Should sit near 1.0. A large deviation means the counters and the wall
   * interval disagree - a missed sample, or sleep/resume.
   */
  counterCoverageRatio: number;
  /** True when the sample was rejected and the utilization fields are absent. */
  discarded: boolean;
  discardReason?: string;
  /** PDH counter paths that actually registered on this machine. */
  pdhCounterPaths: string[];
}

export interface CpuSnapshot {
  /**
   * Aggregate time-based utilization, 0..100. Summed over every logical
   * processor: `(kernel + user - idle) / (kernel + user)`.
   * Source: `NtQuerySystemInformation(SystemProcessorPerformanceInformation)`.
   * Absent on the first sample and on any discarded interval.
   */
  aggregateTimeUtilizationPercent?: number;
  /**
   * Windows "% Processor Utility" for `_Total`. **This is the metric Windows
   * Task Manager displays.** It scales busy time by delivered performance, so a
   * CPU boosting above its base clock legitimately exceeds 100. Reported
   * uncapped; the UI decides whether to clamp.
   * Source: PDH `\Processor Information(_Total)\% Processor Utility`.
   */
  processorUtilityPercent?: number;
  /**
   * Average delivered frequency during the interval as a percentage of nominal.
   * Source: PDH `\Processor Information(_Total)\% Processor Performance`.
   */
  processorPerformancePercent?: number;
  /**
   * PDH `\Processor Information(_Total)\% Processor Time`, kept only as an
   * independent check on `aggregateTimeUtilizationPercent`.
   */
  pdhProcessorTimePercent?: number;
  /** Highest `timeUtilizationPercent` among logical processors this interval. */
  busiestLogicalProcessorPercent?: number;
  /** Flat index of that processor. */
  busiestLogicalProcessorIndex?: number;
  /**
   * Unweighted mean of per-logical-processor utilization. Equals the aggregate
   * when every processor observed the same elapsed time; exposed separately so
   * any difference is visible rather than assumed away.
   */
  averageLogicalProcessorPercent?: number;
  /**
   * Machine-wide share of time spent servicing DPCs, 0..100. A subset of kernel
   * time. Not charged to any process, which is part of why per-process CPU
   * shares sum to slightly less than the aggregate.
   */
  aggregateDpcPercent?: number;
  /**
   * Machine-wide share of time spent servicing interrupts, 0..100. Also a subset
   * of kernel time and also not charged to any process.
   */
  aggregateInterruptPercent?: number;
  /**
   * `baseFrequencyMhz * processorPerformancePercent / 100` - how Task Manager
   * derives the displayed speed. Absent without PDH.
   */
  currentFrequencyMhz?: number;
  perLogicalProcessor: LogicalProcessorSample[];
  topology: CpuTopology;
  /** System-wide counts from `GetPerformanceInfo`, collected in the same tick. */
  processCount?: number;
  threadCount?: number;
  handleCount?: number;
  /** Milliseconds since boot, from `GetTickCount64`. */
  uptimeMs?: number;
  /** Present only when debug collection is enabled. */
  debug?: CpuDebugSample;
}
