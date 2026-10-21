'use client';

import { useSyncExternalStore } from 'react';
import { browserLocation, currentBusinessId, type LocationSource } from '../../../../lib/client/locationPath';
import { businessTabs, type BusinessTab } from '../../../../lib/client/businessTabs';

/**
 * The business this screen belongs to, read from the address and validated (well-formed id) before it is returned; null otherwise, and null while the
 * server renders (a page shows its loading or sign-in state first, as before). Replaces the framework route parameter so the same pages work when the
 * counter is bundled as static files (see lib/client/locationPath.ts).
 */
export function useBusinessId(source: LocationSource = browserLocation): string | null {
  return useSyncExternalStore(source.subscribe, () => currentBusinessId(source), () => null);
}

/** The tab bar's tabs for the address being shown (empty on the server and outside a business screen). */
export function useBusinessTabs(source: LocationSource = browserLocation): BusinessTab[] {
  const path = useSyncExternalStore(source.subscribe, () => source.pathname(), () => '');
  return businessTabs(path);
}
