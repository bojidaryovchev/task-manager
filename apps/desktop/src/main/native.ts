import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';
import type {
  CollectorConfig,
  HostInfo,
  SystemSnapshot,
} from '@task-manager/telemetry-types';

/**
 * The native telemetry module, as N-API generates it.
 *
 * Declared structurally rather than imported so that a missing build produces a
 * clear runtime message instead of a module-resolution failure at import time.
 */
export interface NativeTelemetryModule {
  TelemetryEngine: new (config?: CollectorConfig) => NativeEngine;
  getHostInfo(): HostInfo;
  collectSingleSnapshot(): SystemSnapshot;
  nativeProbe(): string;
}

export interface NativeEngine {
  start(onSnapshot: (snapshot: SystemSnapshot) => void): void;
  stop(): void;
  readonly isRunning: boolean;
  getLatestSnapshot(): SystemSnapshot | null;
  getConfig(): CollectorConfig;
  setConfig(config: CollectorConfig): CollectorConfig;
}

export interface NativeLoadResult {
  module: NativeTelemetryModule | null;
  modulePath: string | null;
  error: string | null;
}

/**
 * A require bound to this file rather than the bundler's.
 *
 * The bundle is CommonJS, but the specifier is chosen at runtime, so it must not
 * be rewritten into a static dependency.
 */
const resolveRequire = createRequire(__filename);

/**
 * Candidate locations for the addon, in the order we try them.
 *
 * In development the workspace package resolves normally. In a packaged build
 * the `.node` binary is unpacked next to the asar, because a native module
 * cannot be loaded from inside an archive.
 */
function candidatePaths(): string[] {
  if (app.isPackaged) {
    // Packaged builds ship the addon under resources/native, outside the asar
    // archive, because a .node binary cannot be loaded from inside one.
    return [
      join(process.resourcesPath, 'native', 'index.js'),
      join(
        process.resourcesPath,
        'app.asar.unpacked',
        'node_modules',
        '@task-manager',
        'telemetry-native',
      ),
    ];
  }
  // In development the workspace package resolves normally.
  return ['@task-manager/telemetry-native'];
}

let cached: NativeLoadResult | null = null;

/**
 * Load the native module once, reporting failure as data rather than throwing.
 *
 * The application still starts without it - the UI shows why telemetry is
 * unavailable, which is far more useful than a blank window.
 */
export function loadNative(): NativeLoadResult {
  if (cached) return cached;

  const attempts: string[] = [];
  for (const candidate of candidatePaths()) {
    try {
      if (candidate.includes(':') && !existsSync(candidate)) {
        attempts.push(`${candidate}: not present`);
        continue;
      }
      const loaded = resolveRequire(candidate) as NativeTelemetryModule;
      if (typeof loaded?.nativeProbe !== 'function') {
        attempts.push(`${candidate}: loaded but does not look like the telemetry module`);
        continue;
      }
      cached = {
        module: loaded,
        modulePath: resolveRequire.resolve(candidate),
        error: null,
      };
      return cached;
    } catch (error) {
      attempts.push(`${candidate}: ${(error as Error).message}`);
    }
  }

  cached = {
    module: null,
    modulePath: null,
    error: [
      'Native telemetry module could not be loaded.',
      'Build it with: pnpm native:build',
      ...attempts.map((line) => `  - ${line}`),
    ].join('\n'),
  };
  return cached;
}
