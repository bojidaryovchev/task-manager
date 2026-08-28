/**
 * Per-process model.
 *
 * Identity: Windows reuses PIDs, so `key` (`pid:createTime100ns`) is the only
 * safe identity across samples. Use it for React keys, CPU deltas, tree
 * building and anything persisted.
 *
 * Nearly every field comes from a single `NtQuerySystemInformation` call. The
 * handful that need a process handle - path, command line, owner, architecture,
 * protection - are resolved once per process and are absent until then, or
 * permanently when we lack rights. `detailFailure` says which case applies.
 */

/** Why the handle-derived fields are missing. */
export type ProcessDetailFailure =
  /** Opening the process was denied; run elevated to see these fields. */
  | 'accessDenied'
  /** The process exited between enumeration and the detail read. */
  | 'processExited'
  /** Not a real process (PID 0, the System Idle Process). */
  | 'notSupported'
  /** Queued behind this tick's resolution budget; fills in shortly. */
  | 'pending';

export interface ProcessSnapshot {
  /** `pid:createTime100ns`. The only safe identity across samples. */
  key: string;
  pid: number;
  /** Parent PID as Windows reports it; may name a recycled or dead PID. */
  parentPid: number;
  /**
   * Key of the parent, set only when a live process with that PID exists and was
   * created no later than this process. Absent otherwise, so a recycled PID
   * never produces a false parent link.
   */
  parentKey?: string;
  /** Image name, e.g. `chrome.exe`. */
  name: string;
  imagePath?: string;
  commandLine?: string;
  /**
   * Creation time in FILETIME 100ns units. **Display only** - the value exceeds
   * the exact integer range of a JavaScript number. Use `key` for identity.
   */
  createTime100ns: number;
  /** Creation time as milliseconds since the Unix epoch. */
  createTimeUnixMs: number;
  sessionId: number;
  isWow64?: boolean;
  /** `x64` | `x86` | `arm64` | `arm`. */
  architecture?: string;
  /** Owner as `DOMAIN\User`. */
  userName?: string;
  isProtected?: boolean;
  /**
   * `ProductName` from the image version resource, e.g. "Google Chrome".
   * The primary signal for grouping processes into applications.
   */
  productName?: string;
  /** `CompanyName` from the image version resource, e.g. "Google LLC". */
  companyName?: string;
  /** `FileDescription` from the image version resource - Explorer's friendly name. */
  fileDescription?: string;
  /** Windows package full name. Present only for packaged (MSIX/UWP) applications. */
  packageFullName?: string;
  /** Application User Model ID. Present only for packaged applications. */
  applicationUserModelId?: string;
  basePriority: number;

  /** Cumulative kernel-mode CPU time since process start, 100ns units. */
  kernelTime100ns: number;
  /** Cumulative user-mode CPU time since process start, 100ns units. */
  userTime100ns: number;
  /**
   * Share of *total machine capacity*, 0..100:
   * `delta(kernel + user) / (interval * logicalProcessorCount)`.
   * On a 24-processor machine one saturated processor is ~4.17%. These values
   * sum to approximately the aggregate CPU utilization.
   * Absent until a valid delta exists - never a process-lifetime average.
   */
  cpuMachinePercent?: number;
  /**
   * The same measurement with one saturated logical processor as 100%.
   * `cpuMachinePercent * logicalProcessorCount`. Can exceed 100 for a
   * multi-threaded process.
   */
  cpuCoreEquivalentPercent?: number;

  /** `WorkingSetSize`: physical memory mapped, shared pages included. */
  workingSetBytes: number;
  /**
   * `WorkingSetPrivateSize`: physical memory private to this process. This is
   * what the Task Manager "Memory" column is derived from, and the default here.
   */
  privateWorkingSetBytes: number;
  /** `PagefileUsage`: private committed bytes. Task Manager's "Commit size". */
  privateCommitBytes: number;
  peakWorkingSetBytes: number;
  pagedPoolBytes: number;
  nonPagedPoolBytes: number;
  virtualSizeBytes: number;
  pageFaultCount: number;
  /** Page faults that required a disk read. */
  hardFaultCount: number;

  threadCount: number;
  handleCount: number;

  /** Cumulative I/O counters since process start. Include file, network and device I/O. */
  ioReadBytes: number;
  ioWriteBytes: number;
  ioOtherBytes: number;
  ioReadOperations: number;
  ioWriteOperations: number;
  ioOtherOperations: number;
  /** Derived over the measured interval; absent until a delta exists. */
  ioReadBytesPerSecond?: number;
  ioWriteBytesPerSecond?: number;

  detailFailure?: ProcessDetailFailure;
}

export interface ProcessesSnapshot {
  processes: ProcessSnapshot[];
  totalCount: number;
  /** Processes whose handle-derived details were denied. Elevation would reduce this. */
  accessDeniedCount: number;
  /** Entries that disappeared between enumeration and detail resolution. */
  vanishedCount: number;
  collectionDurationMs: number;
}
