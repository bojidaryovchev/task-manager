import type { GpuAdapterSnapshot, SystemSnapshot } from '@task-manager/telemetry-types';

/**
 * Picking values out of a snapshot where more than one presentation needs the
 * same answer.
 *
 * The rule that holds this application together is that the main window, the
 * widget and the tray can never disagree about a number. That is guaranteed for
 * anything the collector computes, because each of them only formats it. It is
 * not guaranteed for a *choice* - which of several adapters "the GPU" is - unless
 * the choice is made in exactly one place, which is this file.
 */

/**
 * The adapter a single "GPU" figure describes.
 *
 * The busiest hardware adapter. Software renderers are excluded: the Microsoft
 * Basic Render Driver is not a GPU anyone is asking about, and including it could
 * only ever make the number less meaningful.
 *
 * When no hardware adapter reported any engine activity this interval, the first
 * hardware adapter is returned rather than nothing. The machine still has a GPU,
 * and its temperature and memory are real even while it is idle - returning null
 * there would make an idle GPU indistinguishable from an absent one.
 *
 * Returns null only when there is no hardware adapter at all.
 */
export function busiestHardwareAdapter(snapshot: SystemSnapshot): GpuAdapterSnapshot | null {
  let best: GpuAdapterSnapshot | null = null;
  for (const adapter of snapshot.gpu.adapters) {
    if (adapter.isSoftware) continue;
    if (best === null || (adapter.utilisationPercent ?? -1) > (best.utilisationPercent ?? -1)) {
      best = adapter;
    }
  }
  return best;
}
