/**
 * Historical telemetry.
 *
 * History is stored in tiers: fine detail for the recent past, coarser
 * aggregates further back, so the database stays a fixed small size however
 * long the application runs. A query is answered from the finest tier whose
 * retention covers the requested span.
 *
 * | Tier | Resolution | Retention |
 * |---|---|---|
 * | 0 | every sample | 10 minutes |
 * | 1 | 5 seconds | 1 hour |
 * | 2 | 1 minute | 24 hours |
 * | 3 | 5 minutes | 7 days |
 */

/** One stored point: the mean over its window, plus the peaks within it. */
export interface HistoryPoint {
  /** Start of the window, as milliseconds since the Unix epoch. */
  timestampUnixMs: number;
  cpuTimePercent?: number;
  cpuUtilityPercent?: number;
  cpuBusiestPercent?: number;
  memoryUsedBytes?: number;
  memoryAvailableBytes?: number;
  memoryCommittedBytes?: number;
  diskReadBytesPerSecond?: number;
  diskWriteBytesPerSecond?: number;
  diskActivePercent?: number;
  networkDownBytesPerSecond?: number;
  networkUpBytesPerSecond?: number;
  gpuPercent?: number;
  gpuMemoryBytes?: number;
  processCount?: number;
  threadCount?: number;
  handleCount?: number;
  /**
   * Peak within the window. A mean over five minutes hides exactly the spike a
   * forensic question is about, so peaks are stored alongside it.
   */
  cpuTimePeakPercent?: number;
  memoryUsedPeakBytes?: number;
  diskTotalPeakBytesPerSecond?: number;
}

export interface HistoryTier {
  tier: number;
  rowCount: number;
}

export interface HistoryResult {
  points: HistoryPoint[];
  /** Which retention tier answered the query. */
  tier: number;
  /** Nominal resolution of that tier, in milliseconds. 0 means one row per sample. */
  resolutionMs: number;
  /** False when history is disabled or the database could not be opened. */
  available: boolean;
}
