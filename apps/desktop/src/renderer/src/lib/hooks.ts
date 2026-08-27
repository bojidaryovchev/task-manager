import { useCallback, useDebugValue, useRef, useSyncExternalStore } from 'react';
import type { SystemSnapshot } from '@task-manager/telemetry-types';
import { telemetryStore } from './telemetry-store.js';

/**
 * Subscribe to a slice of the telemetry store.
 *
 * The selector runs on every snapshot, but the component re-renders only when
 * the selected value changes by `Object.is` (or by the supplied comparator).
 * That is what keeps a 500 ms update from re-rendering the whole application:
 * a component reading `cpu.aggregateTimeUtilizationPercent` only re-renders when
 * that one number moves.
 *
 * Selectors must be cheap and must not allocate a new object on every call
 * unless a comparator is supplied, or the bail-out never triggers.
 */
export function useTelemetry<T>(
  selector: (snapshot: SystemSnapshot | null) => T,
  isEqual?: (a: T, b: T) => boolean,
): T {
  const lastValue = useRef<{ value: T } | null>(null);

  const getSnapshot = useCallback(() => {
    const next = selector(telemetryStore.snapshot);
    const previous = lastValue.current;
    if (previous !== null) {
      const same = isEqual ? isEqual(previous.value, next) : Object.is(previous.value, next);
      // Returning the previous reference is what lets useSyncExternalStore skip
      // the render; returning an equal-but-new object would not.
      if (same) return previous.value;
    }
    lastValue.current = { value: next };
    return next;
  }, [selector, isEqual]);

  const value = useSyncExternalStore(telemetryStore.subscribe, getSnapshot, getSnapshot);
  useDebugValue(value);
  return value;
}

/** Shallow equality for arrays, for selectors that must return a list. */
export function shallowArrayEqual<T>(a: readonly T[], b: readonly T[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (!Object.is(a[i], b[i])) return false;
  }
  return true;
}

/** The whole current snapshot. Use sparingly - it changes every interval. */
export function useSnapshot(): SystemSnapshot | null {
  return useTelemetry(identity);
}

const identity = (snapshot: SystemSnapshot | null): SystemSnapshot | null => snapshot;

/**
 * A monotonically increasing counter that changes whenever the store does.
 *
 * Charts subscribe to this and redraw imperatively onto a canvas, so a new
 * sample never causes a React re-render of the chart's subtree.
 */
export function useStoreVersion(): number {
  return useSyncExternalStore(
    telemetryStore.subscribe,
    () => telemetryStore.version,
    () => telemetryStore.version,
  );
}

/** Static host information, fetched once by the app shell. */
export function useHostInfo() {
  return useSyncExternalStore(
    telemetryStore.subscribe,
    () => telemetryStore.hostInfo,
    () => telemetryStore.hostInfo,
  );
}

export function useNativeStatus() {
  return useSyncExternalStore(
    telemetryStore.subscribe,
    () => telemetryStore.nativeStatus,
    () => telemetryStore.nativeStatus,
  );
}

export function useCollectorConfig() {
  return useSyncExternalStore(
    telemetryStore.subscribe,
    () => telemetryStore.config,
    () => telemetryStore.config,
  );
}
