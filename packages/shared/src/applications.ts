import type { ProcessSnapshot } from '@task-manager/telemetry-types';
import {
  addProcess,
  emptyAggregate,
  type ProcessAggregate,
} from './process-tree.js';

/**
 * Grouping processes into applications.
 *
 * This is deliberately conservative and uses only signals Windows itself
 * provides. There is no built-in database of application names, and no
 * heuristics over executable names: `node.exe` from two unrelated projects is
 * two entries, not one, because nothing Windows told us says otherwise.
 *
 * Signals, in order of authority:
 *
 * 1. **Package identity.** A packaged (MSIX/UWP) application has a package full
 *    name assigned by Windows. Two processes sharing it are the same application
 *    by definition, not by inference.
 * 2. **Publisher and product.** `CompanyName` + `ProductName` from the image
 *    version resource is what the publisher declared about their own binary.
 *    This is what puts 37 `chrome.exe` processes under "Google Chrome".
 * 3. **Executable path.** When an image carries no version resource, each
 *    distinct executable is its own application. Grouping by bare file name
 *    would merge unrelated programs.
 * 4. **Image name.** Only when even the path is unavailable, which happens for
 *    processes we cannot open.
 *
 * Every group records which signal produced it, so the UI can say *why* things
 * were grouped, and the member processes are always inspectable.
 */

/** Which signal a group was formed from. */
export type ApplicationGroupBasis =
  | 'packageIdentity'
  | 'publisherAndProduct'
  | 'executablePath'
  | 'imageName';

export interface ApplicationGroup {
  /** Stable identity for this group within a snapshot. */
  key: string;
  /** Display name. */
  name: string;
  /** Publisher, when the image declared one. */
  publisher?: string;
  basis: ApplicationGroupBasis;
  /** Representative executable path, when the members share one. */
  imagePath?: string;
  processes: ProcessSnapshot[];
  totals: ProcessAggregate;
}

/**
 * Executables that are shared hosting surfaces rather than applications.
 *
 * These are not application names - they are the opposite. Windows runs many
 * unrelated programs inside them, so grouping by their version resource would
 * collapse dozens of unrelated services into one meaningless row. They fall back
 * to path-based grouping instead.
 *
 * Kept deliberately tiny and limited to Windows' own generic hosts.
 */
const GENERIC_HOSTS = new Set([
  'svchost.exe',
  'rundll32.exe',
  'dllhost.exe',
  'taskhostw.exe',
  'backgroundtaskhost.exe',
  'runtimebroker.exe',
  'conhost.exe',
  'wmiprvse.exe',
]);

function normalise(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/** The package family: everything before the version in a package full name. */
function packageFamily(packageFullName: string): string {
  const parts = packageFullName.split('_');
  if (parts.length < 2) return packageFullName;
  // Name_Version_Arch_ResourceId_PublisherId → group by name and publisher id,
  // so an in-place update does not split an application in two.
  const name = parts[0] as string;
  const publisherId = parts[parts.length - 1] as string;
  return `${name}_${publisherId}`;
}

interface GroupIdentity {
  key: string;
  name: string;
  publisher?: string;
  basis: ApplicationGroupBasis;
}

/** Decide which application a single process belongs to. */
export function identifyApplication(process: ProcessSnapshot): GroupIdentity {
  const packageFullName = normalise(process.packageFullName);
  if (packageFullName) {
    const family = packageFamily(packageFullName);
    return {
      key: `package:${family.toLowerCase()}`,
      // A packaged app's version resource usually still carries the nice name.
      name:
        normalise(process.productName) ??
        normalise(process.fileDescription) ??
        family.split('_')[0] ??
        process.name,
      publisher: normalise(process.companyName),
      basis: 'packageIdentity',
    };
  }

  const isGenericHost = GENERIC_HOSTS.has(process.name.toLowerCase());
  const product = isGenericHost ? undefined : normalise(process.productName);
  const company = normalise(process.companyName);
  if (product) {
    const publisher = company ?? '';
    return {
      key: `product:${publisher.toLowerCase()}|${product.toLowerCase()}`,
      name: product,
      publisher: company,
      basis: 'publisherAndProduct',
    };
  }

  const imagePath = normalise(process.imagePath);
  if (imagePath) {
    return {
      key: `path:${imagePath.toLowerCase()}`,
      // Prefer the friendly description over the raw file name when present.
      name: normalise(process.fileDescription) ?? process.name,
      publisher: company,
      basis: 'executablePath',
    };
  }

  return {
    key: `name:${process.name.toLowerCase()}`,
    name: process.name,
    publisher: company,
    basis: 'imageName',
  };
}

/**
 * Group a process list into applications.
 *
 * Order is not defined here; the caller sorts by whichever column it displays.
 */
export function groupIntoApplications(
  processes: readonly ProcessSnapshot[],
): ApplicationGroup[] {
  const groups = new Map<string, ApplicationGroup>();

  for (const process of processes) {
    const identity = identifyApplication(process);
    let group = groups.get(identity.key);
    if (!group) {
      group = {
        key: identity.key,
        name: identity.name,
        publisher: identity.publisher,
        basis: identity.basis,
        imagePath: normalise(process.imagePath),
        processes: [],
        totals: emptyAggregate(),
      };
      groups.set(identity.key, group);
    } else if (group.imagePath !== normalise(process.imagePath)) {
      // Members run from different executables, so no single path represents
      // the group. Say nothing rather than pick one arbitrarily.
      group.imagePath = undefined;
    }
    group.processes.push(process);
    addProcess(group.totals, process);
  }

  return [...groups.values()];
}
