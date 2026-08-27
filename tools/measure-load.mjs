/**
 * Integration check: run a controlled CPU workload and confirm the collector
 * reports the expected per-process normalisation.
 *
 * Starts `tools/fixtures/cpu-load.mjs` with a known number of busy threads,
 * samples that process for the duration, and compares the measured CPU against
 * the arithmetic expectation. Also reports how much of the aggregate CPU rise
 * the workload accounts for.
 *
 * Usage: node tools/measure-load.mjs [threads] [seconds]
 */

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const native = require('../native/telemetry/index.js');
const here = dirname(fileURLToPath(import.meta.url));

const THREADS = Number(process.argv[2] ?? 1);
const SECONDS = Number(process.argv[3] ?? 14);

const engine = new native.TelemetryEngine({
  intervalMs: 500,
  collectProcesses: true,
  collectDebug: true,
  collectCommandLines: false,
});

const baseline = [];
const during = [];
let targetPid = null;

engine.start((snapshot) => {
  if (targetPid === null) {
    baseline.push(snapshot);
    return;
  }
  const target = snapshot.processes?.processes.find((p) => p.pid === targetPid);
  if (target?.cpuMachinePercent !== undefined) {
    during.push({ snapshot, target });
  }
});

// Let the collector establish deltas before starting the load.
await new Promise((resolve) => setTimeout(resolve, 2000));

const child = spawn(
  process.execPath,
  [join(here, 'fixtures', 'cpu-load.mjs'), String(THREADS), String(SECONDS)],
  { stdio: ['ignore', 'pipe', 'inherit'] },
);
child.stdout.on('data', (data) => process.stdout.write(`[load] ${data}`));
targetPid = child.pid;

await new Promise((resolve) => child.on('exit', resolve));
// Discard the first and last two samples: the workload is ramping up or winding
// down in those, so they are not measurements of the steady state.
const steady = during.slice(2, -2);
engine.stop();

if (steady.length === 0) {
  console.error('No steady-state samples captured; try a longer run.');
  process.exit(1);
}

const logical = steady[0].snapshot.cpu.topology.logicalProcessorCount;
const mean = (values) => values.reduce((a, b) => a + b, 0) / values.length;

const machine = mean(steady.map((s) => s.target.cpuMachinePercent));
const core = mean(steady.map((s) => s.target.cpuCoreEquivalentPercent));
const expectedMachine = (THREADS / logical) * 100;
const expectedCore = THREADS * 100;

const baselineAggregate = baseline.length
  ? mean(
      baseline
        .map((s) => s.cpu.aggregateTimeUtilizationPercent)
        .filter((v) => v !== undefined && v !== null),
    )
  : Number.NaN;
const loadAggregate = mean(steady.map((s) => s.snapshot.cpu.aggregateTimeUtilizationPercent));

console.log(`\nSteady-state samples: ${steady.length}`);
console.log(`Logical processors:   ${logical}`);
console.log(`Workload threads:     ${THREADS}\n`);

const row = (label, measured, expected, unit) =>
  console.log(
    `${label.padEnd(28)}measured ${measured.toFixed(3)}${unit}`.padEnd(60) +
      `expected ${expected.toFixed(3)}${unit}   error ${(
        ((measured - expected) / expected) *
        100
      ).toFixed(2)}%`,
  );

row('cpuMachinePercent', machine, expectedMachine, '%');
row('cpuCoreEquivalentPercent', core, expectedCore, '%');

console.log(
  `\nAggregate CPU: ${baselineAggregate.toFixed(2)}% before load, ` +
    `${loadAggregate.toFixed(2)}% during load ` +
    `(rise ${(loadAggregate - baselineAggregate).toFixed(2)} points, ` +
    `workload contributes ${machine.toFixed(2)} points)`,
);

process.exit(0);
