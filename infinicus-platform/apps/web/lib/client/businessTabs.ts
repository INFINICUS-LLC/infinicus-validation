/**
 * The business tab bar (POS-9a): one place to move between a business's screens. Pure. The business id is read from the page address and accepted only if
 * it is a well-formed id (the same check each page makes); it carries no authority, every screen still verifies scope and permission on every request.
 * Only screens that exist are listed: Registers and Products are panels of the Counter screen today, not separate pages.
 */
export interface BusinessTab { key: string; label: string; href: string; current: boolean }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TABS: readonly { key: string; label: string; segment: string }[] = [
  { key: 'counter', label: 'Counter', segment: 'counter' },
  { key: 'sales', label: 'Sales', segment: 'sales' },
  { key: 'reports', label: 'Reports', segment: 'reports' },
  { key: 'finance', label: 'Finance', segment: 'finance' },
  { key: 'inventory', label: 'Inventory', segment: 'inventory' },
  { key: 'printers', label: 'Printers', segment: 'printers' },
  { key: 'workflow', label: 'Workflow', segment: 'workflow' },
  { key: 'history', label: 'Decision history', segment: 'history' },
];

/** The business id in an address like `/businesses/<id>/counter`, or null for any other address or a malformed id. */
export function businessIdFromPath(pathname: string | null): string | null {
  const m = /^\/businesses\/([^/]+)(?:\/|$)/.exec(pathname ?? '');
  return m && UUID.test(m[1]) ? m[1] : null;
}

/** The tabs for the business in `pathname` (empty when the address is not a business screen); the tab whose screen is open is `current`. */
export function businessTabs(pathname: string | null): BusinessTab[] {
  const id = businessIdFromPath(pathname);
  if (!id) return [];
  const segment = (pathname ?? '').split('/')[3] ?? '';
  return TABS.map((t) => ({ key: t.key, label: t.label, href: `/businesses/${id}/${t.segment}`, current: segment === t.segment }));
}
