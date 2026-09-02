import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { Logger, describeDetail, formatLine } from './logger.js';

/**
 * A log exists to explain a crash, which constrains it in two ways.
 *
 * The lines that matter are the last ones written before the process died, so
 * nothing may be buffered. And an Error has to arrive as its stack: a crash log
 * containing `[object Object]` where the stack should be is the exact failure
 * that makes one useless.
 */

let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'tm-log-'));
});

describe('describeDetail', () => {
  it('unwraps an Error to its stack', () => {
    const detail = describeDetail(new Error('boom'));
    expect(detail).toContain('boom');
    expect(detail).toContain('logger.test');
    expect(detail).not.toBe('[object Object]');
  });

  it('keeps a stack on one line so it cannot be mistaken for separate entries', () => {
    expect(describeDetail(new Error('boom'))).not.toMatch(/\r?\n/);
  });

  it('serialises a plain object', () => {
    expect(describeDetail({ a: 1 })).toBe('{"a":1}');
  });

  it('does not throw on a circular structure', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(describeDetail(circular)).toContain('unserialisable');
  });

  it('passes a string through unchanged', () => {
    expect(describeDetail('plain')).toBe('plain');
  });
});

describe('formatLine', () => {
  it('leads with an ISO timestamp so it correlates with other logs', () => {
    // A crash log is read next to Event Viewer; a local-format timestamp makes
    // lining them up guesswork.
    expect(formatLine('error', 'crash', 'died')).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z \| ERROR \| crash \| died$/,
    );
  });

  it('appends the detail when there is one', () => {
    expect(formatLine('info', 'app', 'started', 'v1')).toContain('| started | v1');
  });
});

describe('Logger', () => {
  it('writes a line that is on disk immediately', () => {
    // Not "eventually": the process this is describing may be about to die.
    const logger = new Logger(directory);
    logger.error('TM-7005', 'something broke', new Error('boom'));
    expect(readFileSync(logger.path, 'utf8')).toContain('something broke');
  });

  it('rotates once the file passes its cap and keeps a bounded number', () => {
    const logger = new Logger(directory);
    // Enough volume to cross the 1 MB cap several times over.
    const filler = 'x'.repeat(20_000);
    for (let i = 0; i < 300; i += 1) logger.info('test', filler);

    const files = readdirSync(directory).filter((name) => name.endsWith('.log'));
    expect(files).toContain('main.log');
    expect(files).toContain('main.1.log');
    // Active file plus the generations kept, and no more: a log that grows
    // with uptime is a log nobody keeps.
    expect(files.length).toBeLessThanOrEqual(4);
  });

  it('lists what is on disk for the UI', () => {
    const logger = new Logger(directory);
    logger.info('test', 'hello');
    const files = logger.listFiles();
    expect(files).toHaveLength(1);
    expect(files[0]!.name).toBe('main.log');
    expect(files[0]!.bytes).toBeGreaterThan(0);
  });

  it('never throws when the log cannot be written', () => {
    // It is called from inside error handlers. Throwing there would replace the
    // failure being reported with a different one.
    const logger = new Logger(join(directory, 'nested', 'deeper'));
    expect(() => logger.error('TM-9002', 'still works')).not.toThrow();
  });
});
