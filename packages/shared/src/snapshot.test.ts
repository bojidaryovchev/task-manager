import type { GpuAdapterSnapshot, SystemSnapshot } from '@task-manager/telemetry-types';
import { describe, expect, it } from 'vitest';
import { busiestHardwareAdapter } from './snapshot.js';

function adapter(overrides: Partial<GpuAdapterSnapshot>): GpuAdapterSnapshot {
  return { luid: 'luid', isSoftware: false, engines: [], ...overrides };
}

function withAdapters(adapters: GpuAdapterSnapshot[]): SystemSnapshot {
  return { gpu: { adapters, unavailable: false } } as unknown as SystemSnapshot;
}

describe('busiestHardwareAdapter', () => {
  it('picks the busiest hardware adapter', () => {
    const chosen = busiestHardwareAdapter(
      withAdapters([
        adapter({ luid: 'igpu', utilisationPercent: 4 }),
        adapter({ luid: 'dgpu', utilisationPercent: 61 }),
      ]),
    );
    expect(chosen?.luid).toBe('dgpu');
  });

  it('never picks a software renderer, however busy it looks', () => {
    const chosen = busiestHardwareAdapter(
      withAdapters([
        adapter({ luid: 'basic-render', isSoftware: true, utilisationPercent: 90 }),
        adapter({ luid: 'dgpu', utilisationPercent: 3 }),
      ]),
    );
    expect(chosen?.luid).toBe('dgpu');
  });

  it('still returns an idle GPU that reported no engine activity', () => {
    // Otherwise an idle GPU would be indistinguishable from no GPU at all, and
    // its temperature - which is real while it idles - would vanish with it.
    const chosen = busiestHardwareAdapter(withAdapters([adapter({ luid: 'dgpu' })]));
    expect(chosen?.luid).toBe('dgpu');
  });

  it('returns null only when there is no hardware adapter', () => {
    expect(busiestHardwareAdapter(withAdapters([]))).toBeNull();
    expect(
      busiestHardwareAdapter(withAdapters([adapter({ isSoftware: true, utilisationPercent: 5 })])),
    ).toBeNull();
  });
});
