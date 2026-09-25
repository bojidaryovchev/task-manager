/**
 * Compile-time proof that `@task-manager/telemetry-types` describes exactly what
 * the Rust module actually returns.
 *
 * The published types are hand-written so they can carry the documentation that
 * makes each metric's meaning explicit. That is only safe if something checks
 * them against reality — otherwise they would slowly become a parallel fiction.
 * The assignments below fail to compile if the Rust structures and the published
 * types drift apart in either direction: a field added in Rust and not
 * documented, or documented and not produced.
 *
 * This file exists purely for `tsc`; it emits nothing at runtime.
 *
 * Requires the native module to have been built (`pnpm native:build`), because
 * the generated `index.d.ts` is the other half of the comparison.
 */

import type {
  JsActionOutcome,
  JsCollectorConfig,
  JsHistoryPoint,
  JsHistoryResult,
  JsHostInfo,
  JsLaunchOutcome,
  JsProcessState,
  JsServiceOutcome,
  JsServiceState,
  JsSettingOutcome,
  JsShellOutcome,
  JsStartupItem,
  JsStartupOutcome,
  JsSystemSnapshot,
} from '@task-manager/telemetry-native';
import type { ActionOutcome, ProcessState, SettingOutcome } from '@shared/process-actions.js';
import type { ServiceOutcome, ServiceState } from '@shared/services.js';
import type { StartupItem, StartupOutcome } from '@shared/startup.js';
import type { LaunchOutcome, ShellOutcome } from './native.js';
import type {
  CollectorConfig,
  HistoryPoint,
  HistoryResult,
  HostInfo,
  SystemSnapshot,
} from '@task-manager/telemetry-types';

/** Fails to compile unless `Value` is assignable to `Target`. */
type AssignableTo<Value extends Target, Target> = Value;

// Native -> published: every field Rust produces is described.
type _SnapshotIsDescribed = AssignableTo<JsSystemSnapshot, SystemSnapshot>;
type _HostInfoIsDescribed = AssignableTo<JsHostInfo, HostInfo>;
type _ConfigIsDescribed = AssignableTo<JsCollectorConfig, CollectorConfig>;

// Published -> native: nothing is documented that Rust does not produce.
type _SnapshotIsProduced = AssignableTo<SystemSnapshot, JsSystemSnapshot>;
type _HostInfoIsProduced = AssignableTo<HostInfo, JsHostInfo>;
type _ConfigIsProduced = AssignableTo<CollectorConfig, JsCollectorConfig>;

type _HistoryPointIsDescribed = AssignableTo<JsHistoryPoint, HistoryPoint>;
type _HistoryPointIsProduced = AssignableTo<HistoryPoint, JsHistoryPoint>;
type _HistoryResultIsDescribed = AssignableTo<JsHistoryResult, HistoryResult>;
type _HistoryResultIsProduced = AssignableTo<HistoryResult, JsHistoryResult>;

// Acting on processes: what Rust reports is exactly what main and the menu read.
type _ProcessStateIsDescribed = AssignableTo<JsProcessState, ProcessState>;
type _ProcessStateIsProduced = AssignableTo<ProcessState, JsProcessState>;
type _ActionOutcomeIsDescribed = AssignableTo<JsActionOutcome, ActionOutcome>;
type _ActionOutcomeIsProduced = AssignableTo<ActionOutcome, JsActionOutcome>;
type _LaunchOutcomeIsDescribed = AssignableTo<JsLaunchOutcome, LaunchOutcome>;
type _LaunchOutcomeIsProduced = AssignableTo<LaunchOutcome, JsLaunchOutcome>;
type _SettingOutcomeIsDescribed = AssignableTo<JsSettingOutcome, SettingOutcome>;
type _SettingOutcomeIsProduced = AssignableTo<SettingOutcome, JsSettingOutcome>;
type _ShellOutcomeIsDescribed = AssignableTo<JsShellOutcome, ShellOutcome>;
type _ShellOutcomeIsProduced = AssignableTo<ShellOutcome, JsShellOutcome>;

// Services: likewise.
type _ServiceStateIsDescribed = AssignableTo<JsServiceState, ServiceState>;
type _ServiceStateIsProduced = AssignableTo<ServiceState, JsServiceState>;
type _ServiceOutcomeIsDescribed = AssignableTo<JsServiceOutcome, ServiceOutcome>;
type _ServiceOutcomeIsProduced = AssignableTo<ServiceOutcome, JsServiceOutcome>;

// Startup apps: likewise.
type _StartupItemIsDescribed = AssignableTo<JsStartupItem, StartupItem>;
type _StartupItemIsProduced = AssignableTo<StartupItem, JsStartupItem>;
type _StartupOutcomeIsDescribed = AssignableTo<JsStartupOutcome, StartupOutcome>;
type _StartupOutcomeIsProduced = AssignableTo<StartupOutcome, JsStartupOutcome>;

export {};
