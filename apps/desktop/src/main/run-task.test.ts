import { describe, expect, it } from 'vitest';
import { MAX_COMMAND_LENGTH, readCommand, reportRunFailure } from './run-task.js';

describe('Run new task', () => {
  it('accepts a command, trimmed', () => {
    expect(readCommand('  notepad  ')).toBe('notepad');
  });

  it('refuses nothing, blanks and absurd lengths', () => {
    expect(readCommand(undefined)).toBeNull();
    expect(readCommand('   ')).toBeNull();
    expect(readCommand('x'.repeat(MAX_COMMAND_LENGTH + 1))).toBeNull();
  });

  it('says plainly what went wrong', () => {
    expect(reportRunFailure('nosuch', { outcome: 'failed', win32Error: 2 }).message).toBe(
      'Windows cannot find "nosuch".',
    );
    expect(reportRunFailure('a.xyz', { outcome: 'failed', win32Error: 1155 }).message).toBe(
      'No program is set to open "a.xyz".',
    );
    expect(reportRunFailure('x', { outcome: 'failed', win32Error: 5 }).code).toBe('TM-0014');
  });
});
