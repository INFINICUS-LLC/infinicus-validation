'use client';

import { useMemo, useState } from 'react';
import type { Product } from '../../../../../lib/client/schemas';
import { ALL_CATEGORIES, categoriesOf, filterProducts, formatAmount, visibleProducts } from '../../../../../lib/client/counter';

/**
 * Counter catalogue (POS-1): product tiles with search and category filters. Read only: choosing a tile does nothing yet, because building an order
 * is the next step (POS-2). The order panel is a visible placeholder so the layout is the final one.
 */
export function CounterCatalogue({ products }: { products: readonly Product[] }) {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState(ALL_CATEGORIES);
  const active = useMemo(() => visibleProducts(products), [products]);
  const categories = useMemo(() => categoriesOf(active), [active]);
  const shown = useMemo(() => filterProducts(active, query, category), [active, query, category]);

  return (
    <div className="counter">
      <section className="counter-order card" aria-labelledby="order-heading">
        <h2 id="order-heading">Order</h2>
        <p className="empty-state">Building an order comes in the next step. This screen shows the catalogue only.</p>
      </section>

      <section className="counter-catalogue" aria-labelledby="catalogue-heading">
        <h2 id="catalogue-heading">Products</h2>
        <p>
          <label htmlFor="product-search">Search products</label>{' '}
          <input id="product-search" type="search" autoComplete="off" value={query} onChange={(e) => setQuery(e.target.value)} />
        </p>
        {categories.length > 1 ? (
          <div className="counter-categories" role="group" aria-label="Categories">
            <button type="button" className="secondary" aria-pressed={category === ALL_CATEGORIES} onClick={() => setCategory(ALL_CATEGORIES)}>All</button>
            {categories.map((c) => (
              <button key={c} type="button" className="secondary" aria-pressed={category === c} onClick={() => setCategory(c)}>{c}</button>
            ))}
          </div>
        ) : null}
        <p role="status" aria-live="polite" className="counter-count">{shown.length} of {active.length} products</p>
        {active.length === 0 ? (
          <p className="empty-state">No products yet. Add products for this business first.</p>
        ) : shown.length === 0 ? (
          <p className="empty-state">No product matches that search.</p>
        ) : (
          <ul className="product-grid" aria-label="Products">
            {shown.map((p) => (
              <li key={p.id} className="product-tile">
                {p.icon ? <span aria-hidden="true" className="product-icon">{p.icon}</span> : null}
                <strong>{p.name}</strong>
                <span className="product-price">{formatAmount(p.price)}</span>
                <span className="product-category">{p.category}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
