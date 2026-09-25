import { createContext, useContext } from 'react';
import type { PageId } from '../components/Sidebar.js';

/** Go to another page, for the places that offer to: menus, links. */
export const NavigationContext = createContext<(page: PageId) => void>(() => {});

export function useNavigate(): (page: PageId) => void {
  return useContext(NavigationContext);
}
