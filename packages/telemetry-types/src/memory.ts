/**
 * System memory model.
 *
 * "Memory used" is not one universal number, so the components are exposed and
 * the UI explains them. Nothing here is derived to make a figure resemble
 * another tool's output; each field names its Windows source.
 */

/** `MEMORYSTATUSEX` as returned by `GlobalMemoryStatusEx`. */
export interface MemoryDebugGlobal {
  memoryLoadPercent: number;
  totalPhysBytes: number;
  availPhysBytes: number;
  /** Commit limit: RAM plus the current page file size, not the page file alone. */
  totalPageFileBytes: number;
  availPageFileBytes: number;
  totalVirtualBytes: number;
  availVirtualBytes: number;
}

/** `PERFORMANCE_INFORMATION` from `GetPerformanceInfo`. Counts are in pages. */
export interface MemoryDebugPerformance {
  pageSizeBytes: number;
  commitTotalPages: number;
  commitLimitPages: number;
  commitPeakPages: number;
  physicalTotalPages: number;
  physicalAvailablePages: number;
  systemCachePages: number;
  kernelTotalPages: number;
  kernelPagedPages: number;
  kernelNonpagedPages: number;
  handleCount: number;
  processCount: number;
  threadCount: number;
}

/** `SYSTEM_MEMORY_LIST_INFORMATION`, converted to bytes. */
export interface MemoryDebugList {
  freeAndZeroBytes: number;
  modifiedBytes: number;
  modifiedNoWriteBytes: number;
  standbyBytes: number;
  /** Standby broken down by cache priority 0..7. */
  standbyByPriorityBytes: number[];
}

export interface MemoryDebugSample {
  globalMemoryStatusEx: MemoryDebugGlobal;
  performanceInformation?: MemoryDebugPerformance;
  memoryList?: MemoryDebugList;
  installedPhysicalBytes?: number;
}

export interface MemorySnapshot {
  /**
   * RAM physically installed, from `GetPhysicallyInstalledSystemMemory` (SMBIOS).
   * Larger than `totalPhysicalBytes` by whatever firmware and hardware reserve.
   */
  installedPhysicalBytes?: number;
  /** `ullTotalPhys`: physical memory usable by the OS. */
  totalPhysicalBytes: number;
  /**
   * `ullAvailPhys`: free, zeroed and standby pages. Note that standby pages hold
   * cached file data, so "available" is not "unused".
   */
  availablePhysicalBytes: number;
  /** `totalPhysicalBytes - availablePhysicalBytes`. Task Manager's "In use". */
  usedPhysicalBytes: number;
  /** `usedPhysicalBytes / totalPhysicalBytes * 100`. */
  physicalUtilizationPercent: number;
  /** `dwMemoryLoad`, kept as an independent check on our own percentage. */
  memoryLoadPercent: number;

  /** Commit charge: `CommitTotal * pageSize`. */
  committedBytes?: number;
  /** Commit limit: `CommitLimit * pageSize` (RAM plus current page file). */
  commitLimitBytes?: number;
  /** Peak commit charge since boot. */
  commitPeakBytes?: number;

  /** Task Manager's "Cached": standby plus modified pages. */
  cachedBytes?: number;
  standbyBytes?: number;
  /** Modified plus modified-no-write pages. */
  modifiedBytes?: number;
  /** Free plus zeroed pages. */
  freeBytes?: number;

  pagedPoolBytes?: number;
  nonPagedPoolBytes?: number;

  /** Page file size excluding RAM: `totalPageFile - totalPhys`. */
  pageFileTotalBytes?: number;
  /** Commit that cannot be held in RAM, bounded by the page file size. */
  pageFileUsedBytes?: number;

  pageSizeBytes: number;
  /** Present only when debug collection is enabled. */
  debug?: MemoryDebugSample;
}
