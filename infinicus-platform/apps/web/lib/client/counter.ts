/**
 * Pure helpers for the counter (POS) catalogue. No hooks, no data access and no storage: the page fetches products through the /v1 API and
 * these functions only decide what to show. Prices are shown exactly as the server returned them; the counter never computes an order total.
 */
import { formatMoney } from './currency';
import type { Product } from './schemas';

export const ALL_CATEGORIES = 'all';

/** Active products in the shop's own order (sortOrder, then name). The server already omits inactive products; this is a second guard. */
export function visibleProducts(products: readonly Product[]): Product[] {
  return products.filter((p) => p.active).sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
}

export function categoriesOf(products: readonly Product[]): string[] {
  return [...new Set(products.map((p) => p.category))].sort((a, b) => a.localeCompare(b));
}

/** Case-insensitive name match (surrounding whitespace ignored) within an optional category. */
export function filterProducts(products: readonly Product[], query: string, category: string): Product[] {
  const q = query.trim().toLowerCase();
  return products.filter((p) => (category === ALL_CATEGORIES || p.category === category) && (q === '' || p.name.toLowerCase().includes(q)));
}

/** An amount without a currency symbol, with the decimal places of the currency when it is known (see currency.ts). */
export function formatAmount(value: number, currencyCode?: string | null): string {
  return formatMoney(value, currencyCode);
}
