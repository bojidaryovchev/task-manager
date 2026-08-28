import { describe, expect, it } from 'vitest';
import type { ProcessSnapshot } from '@task-manager/telemetry-types';
import { groupIntoApplications, identifyApplication } from './applications.js';

function proc(name: string, overrides: Partial<ProcessSnapshot> = {}): ProcessSnapshot {
  return {
    key: `${overrides.pid ?? 1}:0`,
    pid: overrides.pid ?? 1,
    parentPid: 0,
    name,
    createTime100ns: 0,
    createTimeUnixMs: 0,
    sessionId: 1,
    basePriority: 8,
    kernelTime100ns: 0,
    userTime100ns: 0,
    workingSetBytes: 0,
    privateWorkingSetBytes: 0,
    privateCommitBytes: 0,
    peakWorkingSetBytes: 0,
    pagedPoolBytes: 0,
    nonPagedPoolBytes: 0,
    virtualSizeBytes: 0,
    pageFaultCount: 0,
    hardFaultCount: 0,
    threadCount: 0,
    handleCount: 0,
    ioReadBytes: 0,
    ioWriteBytes: 0,
    ioOtherBytes: 0,
    ioReadOperations: 0,
    ioWriteOperations: 0,
    ioOtherOperations: 0,
    ...overrides,
  };
}

describe('identifyApplication', () => {
  it('prefers package identity, which Windows assigns rather than infers', () => {
    const identity = identifyApplication(
      proc('WindowsTerminal.exe', {
        packageFullName: 'Microsoft.WindowsTerminal_1.22.0_x64__8wekyb3d8bbwe',
        productName: 'Windows Terminal',
        companyName: 'Microsoft Corporation',
      }),
    );
    expect(identity.basis).toBe('packageIdentity');
    expect(identity.name).toBe('Windows Terminal');
  });

  it('keeps a packaged application together across a version update', () => {
    const before = identifyApplication(
      proc('a.exe', { packageFullName: 'Contoso.App_1.0.0_x64__abcdefghijklm' }),
    );
    const after = identifyApplication(
      proc('a.exe', { packageFullName: 'Contoso.App_2.0.0_x64__abcdefghijklm' }),
    );
    // The version sits in the middle of the full name and must not split the group.
    expect(before.key).toBe(after.key);
  });

  it('groups by publisher and product from the version resource', () => {
    const identity = identifyApplication(
      proc('chrome.exe', { productName: 'Google Chrome', companyName: 'Google LLC' }),
    );
    expect(identity.basis).toBe('publisherAndProduct');
    expect(identity.name).toBe('Google Chrome');
    expect(identity.publisher).toBe('Google LLC');
  });

  it('separates identical product names from different publishers', () => {
    const a = identifyApplication(proc('x.exe', { productName: 'Updater', companyName: 'Acme' }));
    const b = identifyApplication(proc('x.exe', { productName: 'Updater', companyName: 'Globex' }));
    expect(a.key).not.toBe(b.key);
  });

  it('falls back to the executable path when there is no version resource', () => {
    const identity = identifyApplication(
      proc('node.exe', { imagePath: 'C:\\Program Files\\nodejs\\node.exe' }),
    );
    expect(identity.basis).toBe('executablePath');
    expect(identity.key).toContain('c:\\program files\\nodejs\\node.exe');
  });

  it('does not merge same-named executables from different paths', () => {
    // Two unrelated node.exe installations are two applications. Grouping by
    // bare file name would claim a relationship nothing told us about.
    const a = identifyApplication(proc('node.exe', { imagePath: 'C:\\a\\node.exe' }));
    const b = identifyApplication(proc('node.exe', { imagePath: 'C:\\b\\node.exe' }));
    expect(a.key).not.toBe(b.key);
  });

  it('falls back to the image name when even the path is unavailable', () => {
    const identity = identifyApplication(proc('unknown.exe', { detailFailure: 'accessDenied' }));
    expect(identity.basis).toBe('imageName');
    expect(identity.name).toBe('unknown.exe');
  });

  it('does not collapse generic Windows hosts into one application', () => {
    // Every svchost.exe declares ProductName "Microsoft Windows Operating
    // System". Grouping on that would merge dozens of unrelated services.
    const a = identifyApplication(
      proc('svchost.exe', {
        productName: 'Microsoft(R) Windows(R) Operating System',
        companyName: 'Microsoft Corporation',
        imagePath: 'C:\\Windows\\System32\\svchost.exe',
      }),
    );
    expect(a.basis).toBe('executablePath');
  });

  it('is case-insensitive about paths, as Windows is', () => {
    const a = identifyApplication(proc('n.exe', { imagePath: 'C:\\App\\N.exe' }));
    const b = identifyApplication(proc('n.exe', { imagePath: 'c:\\app\\n.exe' }));
    expect(a.key).toBe(b.key);
  });

  it('ignores whitespace-only metadata', () => {
    const identity = identifyApplication(
      proc('a.exe', { productName: '   ', imagePath: 'C:\\a\\a.exe' }),
    );
    expect(identity.basis).toBe('executablePath');
  });
});

describe('groupIntoApplications', () => {
  it('collapses many processes of one product into a single entry', () => {
    const processes = Array.from({ length: 37 }, (_, i) =>
      proc('chrome.exe', {
        pid: 100 + i,
        productName: 'Google Chrome',
        companyName: 'Google LLC',
        imagePath: 'C:\\Program Files\\Google\\Chrome\\chrome.exe',
        cpuMachinePercent: 0.1,
        privateWorkingSetBytes: 1024,
        threadCount: 2,
      }),
    );
    const groups = groupIntoApplications(processes);
    expect(groups).toHaveLength(1);
    const [group] = groups;
    expect(group?.name).toBe('Google Chrome');
    expect(group?.processes).toHaveLength(37);
    expect(group?.totals.processCount).toBe(37);
    expect(group?.totals.cpuMachinePercent).toBeCloseTo(3.7, 10);
    expect(group?.totals.privateWorkingSetBytes).toBe(37 * 1024);
    expect(group?.totals.threadCount).toBe(74);
  });

  it('drops the representative path when members run from different executables', () => {
    const groups = groupIntoApplications([
      proc('a.exe', { pid: 1, productName: 'Suite', companyName: 'Acme', imagePath: 'C:\\s\\a.exe' }),
      proc('b.exe', { pid: 2, productName: 'Suite', companyName: 'Acme', imagePath: 'C:\\s\\b.exe' }),
    ]);
    expect(groups).toHaveLength(1);
    // One path cannot represent both, so none is claimed.
    expect(groups[0]?.imagePath).toBeUndefined();
  });

  it('keeps the representative path when every member shares it', () => {
    const groups = groupIntoApplications([
      proc('a.exe', { pid: 1, productName: 'App', companyName: 'Acme', imagePath: 'C:\\s\\a.exe' }),
      proc('a.exe', { pid: 2, productName: 'App', companyName: 'Acme', imagePath: 'C:\\s\\a.exe' }),
    ]);
    expect(groups[0]?.imagePath).toBe('C:\\s\\a.exe');
  });

  it('records the basis so the UI can explain the grouping', () => {
    const groups = groupIntoApplications([
      proc('chrome.exe', { pid: 1, productName: 'Google Chrome', companyName: 'Google LLC' }),
      proc('svchost.exe', { pid: 2, imagePath: 'C:\\Windows\\System32\\svchost.exe' }),
    ]);
    const bases = groups.map((g) => g.basis).sort();
    expect(bases).toEqual(['executablePath', 'publisherAndProduct']);
  });

  it('returns nothing for an empty process list', () => {
    expect(groupIntoApplications([])).toEqual([]);
  });
});
