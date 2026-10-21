'use client';

import { usePathname } from 'next/navigation';
import { businessTabs, type BusinessTab } from '../../../../lib/client/businessTabs';

/** Presentational tab bar. The open screen is marked for assistive technology as well as visually. */
export function BusinessTabsView({ tabs }: { tabs: readonly BusinessTab[] }) {
  if (tabs.length === 0) return null;
  return (
    <nav className="business-tabs" aria-label="Business sections">
      <ul>
        {tabs.map((t) => (
          <li key={t.key}><a href={t.href} aria-current={t.current ? 'page' : undefined} className={t.current ? 'current' : undefined}>{t.label}</a></li>
        ))}
      </ul>
    </nav>
  );
}

export function BusinessTabs() {
  return <BusinessTabsView tabs={businessTabs(usePathname())} />;
}
