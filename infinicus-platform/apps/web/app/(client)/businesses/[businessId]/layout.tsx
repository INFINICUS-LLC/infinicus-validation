import type { ReactNode } from 'react';
import { BusinessTabs } from './business-tabs';

/** Shared by every screen of one business: the tab bar above the screen. */
export default function BusinessLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <BusinessTabs />
      {children}
    </>
  );
}
