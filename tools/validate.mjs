/**
 * Validates the native collector against Windows' own performance counters.
 *
 * Runs our sampling engine and `Get-Counter` over the same wall-clock window,
 * then compares the means. Comparing means rather than individual samples is
 * deliberate: the two samplers cannot be phase-aligned, so instantaneous values
 * legitimately differ while their averages over a shared window should not.
 *
 * The point is *not* to force our numbers to match another tool. Where a
 * difference is expected - different metric definitions, different sampling
 * windows - the expectation is stated alongside the result.
 *
 * Usage: node tools/validate.mjs [seconds]
 */

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const native = require('../native/telemetry/index.js');

const SECONDS = Number(process.argv[2] ?? 20);
const INTERVAL_MS = 1000;

const COUNTERS = [
  '\\Processor Information(_Total)\\% Processor Utility',
  '\\Processor Information(_Total)\\% Processor Time',
  '\\Processor Information(_Total)\\% Processor Performance',
  '\\Memory\\Available Bytes',
  '\\Memory\\Committed Bytes',
  '\\Memory\\Cache Bytes',
  '\\Memory\\Standby Cache Reserve Bytes',
  '\\System\\Processes',
  '\\System\\Threads',
];

function mean(values) {
  const usable = values.filter((v) => typeof v === 'number' && Number.isFinite(v));
  if (usable.length === 0) return null;
  return usable.reduce((a, b) => a + b, 0) / usable.length;
}

function runGetCounter(seconds) {
  const counterList = COUNTERS.map((c) => `'${c}'`).join(',');
  const script = `
    $ErrorActionPreference = 'Stop'
    $samples = Get-Counter -Counter ${counterList} -SampleInterval 1 -MaxSamples ${seconds}
    $rows = foreach ($s in $samples) {
      $h = @{}
      foreach ($v in $s.CounterSamples) { $h[$v.Path] = $v.CookedValue }
      [pscustomobject]$h
    }
    $rows | ConvertTo-Json -Depth 4 -Compress
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`Get-Counter failed: ${stderr || code}`));
      try {
        const parsed = JSON.parse(stdout);
        resolve(Array.isArray(parsed) ? parsed : [parsed]);
      } catch (error) {
        reject(new Error(`Could not parse Get-Counter output: ${error.message}\n${stdout}`));
      }
    });
  });
}

/** Look up a counter by its suffix, since Get-Counter prefixes the machine name. */
function counterValues(rows, suffix) {
  const key = Object.keys(rows[0] ?? {}).find((k) => k.toLowerCase().endsWith(suffix.toLowerCase()));
  if (!key) return [];
  return rows.map((r) => r[key]);
}

function pct(value) {
  return value === null || value === undefined ? '—' : `${value.toFixed(2)}%`;
}

function gib(value) {
  return value === null || value === undefined ? '—' : `${(value / 1024 ** 3).toFixed(3)} GiB`;
}

function difference(ours, theirs) {
  if (ours === null || theirs === null || theirs === 0) return '—';
  return `${(((ours - theirs) / theirs) * 100).toFixed(2)}%`;
}

const ours = [];
const engine = new native.TelemetryEngine({
  intervalMs: INTERVAL_MS,
  collectProcesses: true,
  collectDebug: true,
  collectCommandLines: false,
});

console.log(`Sampling for ${SECONDS}s at ${INTERVAL_MS} ms — ours vs Get-Counter…\n`);

engine.start((snapshot) => ours.push(snapshot));

const rows = await runGetCounter(SECONDS);
engine.stop();

// Drop the first sample: ours has no delta yet and PDH needs a baseline.
const samples = ours.slice(1);

const results = [
  {
    metric: 'CPU % Processor Utility',
    ours: mean(samples.map((s) => s.cpu.processorUtilityPercent)),
    theirs: mean(counterValues(rows, '% processor utility')),
    format: pct,
    expectation: 'Same PDH counter. Should agree closely.',
  },
  {
    metric: 'CPU % Processor Performance',
    ours: mean(samples.map((s) => s.cpu.processorPerformancePercent)),
    theirs: mean(counterValues(rows, '% processor performance')),
    format: pct,
    expectation: 'Same PDH counter. Should agree closely.',
  },
  {
    metric: 'CPU time utilization (ours) vs % Processor Time',
    ours: mean(samples.map((s) => s.cpu.aggregateTimeUtilizationPercent)),
    theirs: mean(counterValues(rows, '% processor time')),
    format: pct,
    expectation: 'Different sources (NT counters vs PDH) for the same definition. Small drift expected.',
  },
  {
    metric: 'CPU time utilization (ours) vs GetSystemTimes',
    ours: mean(samples.map((s) => s.cpu.aggregateTimeUtilizationPercent)),
    theirs: mean(samples.map((s) => s.cpu.debug?.getSystemTimes?.utilizationPercent)),
    format: pct,
    expectation: 'Independent API, identical definition and interval. Should match near-exactly.',
  },
  {
    metric: 'Memory available',
    ours: mean(samples.map((s) => s.memory.availablePhysicalBytes)),
    theirs: mean(counterValues(rows, 'available bytes')),
    format: gib,
    expectation: 'Same underlying value via different APIs.',
  },
  {
    metric: 'Memory committed',
    ours: mean(samples.map((s) => s.memory.committedBytes)),
    theirs: mean(counterValues(rows, 'committed bytes')),
    format: gib,
    expectation: 'Same underlying value via different APIs.',
  },
  {
    metric: 'Process count',
    ours: mean(samples.map((s) => s.cpu.processCount)),
    theirs: mean(counterValues(rows, '\\processes')),
    format: (v) => (v === null ? '—' : v.toFixed(1)),
    expectation: 'Processes start and exit between samples; a small difference is normal.',
  },
  {
    metric: 'Thread count',
    ours: mean(samples.map((s) => s.cpu.threadCount)),
    theirs: mean(counterValues(rows, '\\threads')),
    format: (v) => (v === null ? '—' : v.toFixed(1)),
    expectation: 'Same as above.',
  },
  {
    metric: 'Process CPU sum vs aggregate CPU',
    ours: mean(
      samples.map((s) =>
        (s.processes?.processes ?? [])
          .filter((p) => p.pid !== 0)
          .reduce((total, p) => total + (p.cpuMachinePercent ?? 0), 0),
      ),
    ),
    theirs: mean(samples.map((s) => s.cpu.aggregateTimeUtilizationPercent)),
    format: pct,
    expectation:
      'Per-process machine shares should sum to roughly the aggregate. Excludes the idle process.',
  },
];

const pad = (text, width) => String(text).padEnd(width);
console.log(
  `${pad('METRIC', 46)}${pad('OURS', 14)}${pad('WINDOWS', 14)}${pad('DIFF', 10)}`,
);
console.log('-'.repeat(84));
for (const row of results) {
  console.log(
    `${pad(row.metric, 46)}${pad(row.format(row.ours), 14)}${pad(
      row.format(row.theirs),
      14,
    )}${pad(difference(row.ours, row.theirs), 10)}`,
  );
}

console.log('\nNotes:');
for (const row of results) {
  console.log(`  ${row.metric}\n    ${row.expectation}`);
}

const last = samples.at(-1);
if (last) {
  console.log('\nCollector cost (mean over run):');
  console.log(`  total    ${mean(samples.map((s) => s.diagnostics.totalDurationMs)).toFixed(2)} ms`);
  console.log(`  cpu      ${mean(samples.map((s) => s.diagnostics.cpuDurationMs)).toFixed(2)} ms`);
  console.log(`  memory   ${mean(samples.map((s) => s.diagnostics.memoryDurationMs)).toFixed(2)} ms`);
  console.log(
    `  process  ${mean(samples.map((s) => s.diagnostics.processDurationMs)).toFixed(2)} ms`,
  );
  console.log(`  dropped snapshots: ${last.diagnostics.droppedSnapshots}`);
  console.log(
    `  measured interval: mean ${mean(samples.map((s) => s.intervalMs)).toFixed(2)} ms ` +
      `(configured ${INTERVAL_MS} ms)`,
  );
}

process.exit(0);
