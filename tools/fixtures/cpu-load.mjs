/**
 * A controlled CPU workload, for validating per-process CPU normalisation.
 *
 * Spawns N worker threads that spin without sleeping or allocating, so the
 * process should consume almost exactly N logical processors' worth of CPU time.
 *
 * On a machine with L logical processors, running with N threads, the expected
 * readings are:
 *
 *   cpuMachinePercent        ≈ N / L * 100
 *   cpuCoreEquivalentPercent ≈ N * 100
 *
 * Usage: node tools/fixtures/cpu-load.mjs [threads] [seconds]
 */

import { Worker, isMainThread, workerData } from 'node:worker_threads';
import { availableParallelism } from 'node:os';

const SPIN_SOURCE = `
  const { workerData } = require('node:worker_threads');
  const until = Date.now() + workerData.seconds * 1000;
  // A tight integer loop. Date.now() is checked rarely so the check itself does
  // not become a meaningful share of the work.
  let accumulator = 0;
  while (Date.now() < until) {
    for (let i = 0; i < 5_000_000; i += 1) accumulator = (accumulator + i) % 2147483647;
  }
  // Prevent the loop from being optimised away entirely.
  if (accumulator === -1) console.log(accumulator);
`;

if (isMainThread) {
  const threads = Number(process.argv[2] ?? 1);
  const seconds = Number(process.argv[3] ?? 15);
  const logical = availableParallelism();

  console.log(
    `pid=${process.pid} threads=${threads} seconds=${seconds} logicalProcessors=${logical}`,
  );
  console.log(
    `expected: cpuMachinePercent ~= ${((threads / logical) * 100).toFixed(3)}%, ` +
      `cpuCoreEquivalentPercent ~= ${(threads * 100).toFixed(0)}%`,
  );

  const workers = [];
  for (let i = 0; i < threads; i += 1) {
    workers.push(new Worker(SPIN_SOURCE, { eval: true, workerData: { seconds } }));
  }
  await Promise.all(
    workers.map((worker) => new Promise((resolve) => worker.on('exit', resolve))),
  );
  console.log('done');
} else {
  void workerData;
}
