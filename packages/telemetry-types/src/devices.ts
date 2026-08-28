/**
 * Disk, network and GPU models.
 *
 * As everywhere else in this model, an absent field means the value was not
 * measured rather than measured as zero, and each field names the Windows
 * source it came from.
 */

// --- disk -------------------------------------------------------------------

/** One physical disk over one interval, from the `PhysicalDisk` counter set. */
export interface DiskSnapshot {
  /** PDH instance name, e.g. `0 C: D:` — the disk number and its volumes. */
  instance: string;
  /** Physical disk number, parsed from the instance name. */
  index?: number;
  /** Drive letters carried by this physical disk. */
  volumes: string[];
  readBytesPerSecond: number;
  writeBytesPerSecond: number;
  /** Reads plus writes. */
  totalBytesPerSecond: number;
  /**
   * Share of the interval the disk had at least one request outstanding,
   * 0..100. Derived as `100 - % Idle Time`, the same basis as Task Manager's
   * "Active time". `% Disk Time` is not used: it misreports above one
   * outstanding request.
   */
  activeTimePercent?: number;
  /** Mean milliseconds per read, from `Avg. Disk sec/Read`. */
  averageReadLatencyMs?: number;
  averageWriteLatencyMs?: number;
  /** Requests outstanding at the end of the interval. */
  queueLength?: number;
  readsPerSecond?: number;
  writesPerSecond?: number;
}

export interface DisksSnapshot {
  /** Per physical disk, busiest first, excluding the synthesised total. */
  disks: DiskSnapshot[];
  /** The `_Total` instance PDH synthesises across all disks. */
  total?: DiskSnapshot;
  /** True when the `PhysicalDisk` counter set could not be registered. */
  unavailable: boolean;
}

// --- network ----------------------------------------------------------------

/** One network interface over one interval, from `Network Interface`. */
export interface NetworkInterfaceSnapshot {
  /** Adapter description, as Windows publishes it. */
  name: string;
  receivedBytesPerSecond: number;
  sentBytesPerSecond: number;
  totalBytesPerSecond: number;
  /** Negotiated link speed in bits per second. Absent when the adapter is down. */
  linkSpeedBitsPerSecond?: number;
  receivedPacketsPerSecond?: number;
  sentPacketsPerSecond?: number;
  /** Outbound packets discarded because the queue was full. */
  outboundDiscardsPerSecond?: number;
  /** True for the Windows loopback pseudo-interface. */
  isLoopback: boolean;
}

export interface NetworkSnapshot {
  /** Every interface, busiest first. */
  interfaces: NetworkInterfaceSnapshot[];
  /**
   * Summed over non-loopback interfaces. Loopback is excluded because local
   * traffic routinely dwarfs real network use and would make the total useless.
   */
  receivedBytesPerSecond: number;
  sentBytesPerSecond: number;
  unavailable: boolean;
}

// --- gpu --------------------------------------------------------------------

/** Utilisation of one engine type on one adapter. */
export interface GpuEngineSnapshot {
  /** Raw engine type from the counter instance name, e.g. `3d`, `videodecode`. */
  engine: string;
  /** Friendlier label for the same engine, e.g. `3D`, `Video decode`. */
  label: string;
  utilisationPercent: number;
}

export interface GpuAdapterSnapshot {
  /** LUID key matching the counter instance names, e.g. `0x00000000_0x000194b3`. */
  luid: string;
  /**
   * Adapter description from DXGI. Absent when DXGI could not enumerate the
   * adapter, in which case the LUID is the only identity available.
   */
  name?: string;
  /** True for software renderers such as the Microsoft Basic Render Driver. */
  isSoftware: boolean;
  /**
   * **Maximum across engine types, never a sum.** A GPU runs its 3D, Compute,
   * Copy and video engines concurrently, so adding them would report well over
   * 100% for a GPU that is nowhere near saturated. This is the rule Windows
   * Task Manager applies.
   */
  utilisationPercent?: number;
  /** Per-engine-type totals, highest first. */
  engines: GpuEngineSnapshot[];
  /** Dedicated (on-board) video memory in use. */
  dedicatedMemoryUsedBytes?: number;
  /** Total dedicated video memory, from DXGI. */
  dedicatedMemoryTotalBytes?: number;
  /** System memory the adapter is using. */
  sharedMemoryUsedBytes?: number;
  /** Total system memory the adapter may share, from DXGI. */
  sharedMemoryTotalBytes?: number;
}

export interface GpuSnapshot {
  /** Hardware adapters first, then software renderers. */
  adapters: GpuAdapterSnapshot[];
  /** True when the GPU counter sets could not be registered. */
  unavailable: boolean;
}
