import { createContext, useContext } from 'react';
import type { PageId } from '../components/Sidebar.js';

/** Go to another page, for the places that offer to: menus, links. */
export const NavigationContext = createContext<(page: PageId) => void>(() => {});

export function useNavigate(): (page: PageId) => void {
  return useContext(NavigationContext);
}

/**
 * A process to show on the Processes page: by identity key, or by the PID a
 * service reported. A PID alone is only trusted for a process created before
 * the service list was read; one created since has merely inherited the
 * number.
 */
export type ProcessTarget = { key: string } | { pid: number; createdBeforeUnixMs: number };

/** Go to a particular row on another page. */
export interface GoTo {
  process(target: ProcessTarget): void;
  /** Open the Services page with these services selected, by key name. */
  services(names: string[]): void;
}

export const GoToContext = createContext<GoTo>({ process: () => {}, services: () => {} });

export function useGoTo(): GoTo {
  return useContext(GoToContext);
}
