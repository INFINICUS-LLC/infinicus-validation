import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

/**
 * Data-capture Block D architecture guard (migration 0198, no database): purchase-order line -> inventory item linkage is enforced by the database
 * and read by the ONE BO writer; no second writer, no inference from product, no backfill, no supplier-to-item structure, no status / received_qty
 * automation, and no DAL / ABA / OM / P0-6 involvement.
 */
const PLATFORM = resolve(__dirname, '../../..');
const SKIP = new Set(['node_modules', 'dist', '.turbo', '.next', 'coverage']);
function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (/\.(ts|tsx|js|mjs)$/.test(name)) yield full;
  }
}
const isTest = (rel: string): boolean => /(^|\/)(tests?|__tests__)\//.test(rel) || /\.test\.[tj]sx?$/.test(rel);
const stripComments = (s: string): string => s.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
const production: { rel: string; code: string }[] = [];
for (const root of ['apps', 'packages', 'layers']) {
  for (const file of walk(join(PLATFORM, root))) {
    const rel = relative(PLATFORM, file).split('\\').join('/');
    if (!isTest(rel)) production.push({ rel, code: stripComments(readFileSync(file, 'utf8')) });
  }
}
const read = (rel: string): string => production.find((f) => f.rel === rel)?.code ?? '';
const filesMatching = (re: RegExp) => production.filter((f) => re.test(f.code)).map((f) => f.rel).sort();
const EXECUTOR = 'packages/business-operations-runtime/src/OperationalCommandExecutor.ts';
const MIGRATION = 'infrastructure/database/migrations/0198_link_purchase_order_lines_to_inventory_items.sql';
const sqlText = readFileSync(join(PLATFORM, MIGRATION), 'utf8');
const sql = sqlText.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');

describe('Data-capture Block D architecture (purchase-order / receipt / inventory-item linkage)', () => {
  it('scans the real production tree and the migration (not vacuous)', () => {
    expect(production.length).toBeGreaterThan(200);
    expect(read(EXECUTOR).length).toBeGreaterThan(5000);
    expect(sql.length).toBeGreaterThan(2500);
  });

  it('0198 is the single migration after 0197: no edit of earlier files is possible here, and no second migration was allocated', () => {
    const migrations = readdirSync(join(PLATFORM, 'infrastructure/database/migrations')).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
    const at = migrations.indexOf('0197_create_purchase_receipt_lines.sql');
    expect(migrations.slice(at, at + 2)).toEqual(['0197_create_purchase_receipt_lines.sql', '0198_link_purchase_order_lines_to_inventory_items.sql']);
  });

  it('the migration adds ONLY a nullable item column with a RESTRICT FK, the indexes and the guards - no backfill, no data statement, no destructive change, no grant', () => {
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS inventory_item_id uuid NULL REFERENCES platform\.inventory_items\(id\) ON DELETE RESTRICT/);
    expect(sql).not.toMatch(/NOT NULL REFERENCES platform\.inventory_items/);
    expect(sql).not.toMatch(/\b(UPDATE|DELETE)\s+(FROM\s+)?business_operations\./i);
    expect(sql.replace(/INSERT INTO _migrations[^;]*;/, '')).not.toMatch(/\bINSERT\s+INTO\b/i);
    expect(sql).not.toMatch(/DROP\s+(TABLE|COLUMN|CONSTRAINT)|\bTRUNCATE\b|\bGRANT\b|\bREVOKE\b|CREATE\s+ROLE|ALTER\s+ROLE/i);
    expect(sql).not.toMatch(/product_id/); // nothing is inferred from, copied from or compared with the product link
    expect(sql).not.toMatch(/supplier/i); // no supplier-to-item structure
    expect(sql).not.toMatch(/po_status|received_qty/); // no status or received-quantity automation
  });

  it('the guards check scope on the database side and the chain rule is in the receipt-line guard', () => {
    expect(sql).toMatch(/guard_purchase_order_line_item_write/);
    expect(sql).toMatch(/i\.tenant_id = NEW\.tenant_id AND i\.workspace_id = NEW\.workspace_id AND i\.business_id = NEW\.business_id/);
    expect(sql).toMatch(/v_linked_item IS NOT NULL AND v_linked_item <> NEW\.inventory_item_id/);
    expect(sql).toMatch(/SET search_path = pg_catalog, pg_temp/);
  });

  it('no second BO writer: purchase-order lines are still written by NO production code, and the item column is only ever read (by the receipt branch of the executor)', () => {
    expect(filesMatching(/INSERT\s+INTO\s+\S*purchase_order_line_items\b/i)).toEqual([]);
    expect(filesMatching(/UPDATE\s+\S*purchase_order_line_items\b/i)).toEqual([]);
    expect(filesMatching(/purchase_order_line_items/)).toEqual([EXECUTOR]);
    expect(filesMatching(/SELECT inventory_item_id FROM business_operations\.purchase_order_line_items/)).toEqual([EXECUTOR]);
  });

  it('no inference: nothing in production maps product to inventory item to fill a purchase-order line, and the receipt branch never writes the item back', () => {
    const c = read(EXECUTOR);
    const receipt = c.slice(c.indexOf('private async recordPurchaseReceipt('), c.indexOf('async configureInventoryReorderPolicy('));
    expect(receipt).not.toMatch(/product_id|productId/);
    expect(receipt).not.toMatch(/UPDATE\s+business_operations\.purchase_order/i);
    expect(receipt).not.toMatch(/po_status|received_qty/);
  });

  it('DAL, ABA, OM and the P0-6 execution path do not touch purchase-order lines or the item link', () => {
    const prefixes = ['packages/data-acquisition-runtime/', 'layers/data-acquisition/', 'packages/handoff-contracts/', 'packages/workflow/', 'packages/outcome-monitoring-runtime/', 'packages/event-worker/src/', 'packages/database/src/repositories/approved_action/'];
    const hits = production.filter((f) => prefixes.some((p) => f.rel.startsWith(p)) && /purchase_order_line|purchaseOrderLine/.test(f.code)).map((f) => f.rel);
    expect(hits).toEqual([]);
  });

  it('no supplier-to-item structure exists anywhere in production', () => {
    expect(filesMatching(/supplier_item|supplierItem|preferred_supplier|preferredSupplier|item_sourcing/i)).toEqual([]);
  });
});
