import type { ReactNode } from 'react';
import { BusinessTabs } from './business-tabs';

/**
 * Static export (the device shell bundles the counter, POS-8d-2a): a business id exists only at run time, so the export builds each business screen
 * ONCE under a placeholder id, and the shell serves that file for every business address. The page then reads the real id from the address
 * (`use-business-id.ts`). A normal server build is unchanged: any real id still renders on demand. The placeholder is not a valid id, so opening it shows
 * the usual "address is not valid" notice.
 */
export function generateStaticParams(): { businessId: string }[] {
  return [{ businessId: '_' }];
}

/** Shared by every screen of one business: the tab bar above the screen. */
export default function BusinessLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <BusinessTabs />
      {children}
    </>
  );
}
