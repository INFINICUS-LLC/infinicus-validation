import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

/**
 * Data-capture Block A architecture guard (migration 0197, no database): the purchase receipt is written by ONE BO writer (the operational command
 * executor) fed by the DAL only through the published-record intake; DAL never writes BO tables; the rule set is shared; no ABA, P0-6, reorder-policy or
 * Block D (purchase-order linkage) involvement.
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
const under = (prefix: string) => production.filter((f) => f.rel.startsWith(prefix));
const filesMatching = (re: RegExp) => production.filter((f) => re.test(f.code)).map((f) => f.rel).sort();

const BO = 'packages/business-operations-runtime/src/';
const EXECUTOR = `${BO}OperationalCommandExecutor.ts`;
const MAPPERS = `${BO}intake/defaultMappers.ts`;
const RULES = `${BO}procurement/purchaseReceipt.ts`;
const TYPES = `${BO}types.ts`;
const MIGRATION = 'infrastructure/database/migrations/0197_create_purchase_receipt_lines.sql';
const sql = (rel: string): string => readFileSync(join(PLATFORM, rel), 'utf8');
const receiptBranch = (): string => { const c = read(EXECUTOR); const a = c.indexOf('private async recordPurchaseReceipt('); return c.slice(a, c.indexOf('async configureInventoryReorderPolicy(', a)); };

describe('Data-capture Block A architecture (purchase receipt write path)', () => {
  it('scans the real production tree (not vacuous)', () => {
    expect(production.length).toBeGreaterThan(200);
    for (const rel of [EXECUTOR, MAPPERS, RULES, TYPES]) expect(read(rel).length, rel).toBeGreaterThan(400);
    expect(receiptBranch().length).toBeGreaterThan(1500);
    expect(sql(MIGRATION).length).toBeGreaterThan(2500);
  });

  it('DAL never writes (or even names) BO receipt, line or movement tables - it publishes, BO maps and executes', () => {
    for (const prefix of ['packages/data-acquisition-runtime/', 'layers/data-acquisition/', 'packages/handoff-contracts/']) {
      for (const f of under(prefix)) expect(f.code, f.rel).not.toMatch(/purchase_receipts|purchase_receipt_lines|inventory_movements|record_purchase_receipt|OperationalCommandExecutor/);
    }
    expect(filesMatching(/purchase_receipts|purchase_receipt_lines/).filter((rel) => rel.startsWith('packages/data-acquisition-runtime/') || rel.startsWith('layers/'))).toEqual([]);
  });

  it('ONE BO writer: only the executor inserts receipts, receipt lines and ledger movements; the receipt movement goes through the same movement writer as every other movement', () => {
    expect(filesMatching(/INSERT\s+INTO\s+\S*purchase_receipts\b/i)).toEqual([EXECUTOR]);
    expect(filesMatching(/INSERT\s+INTO\s+\S*purchase_receipt_lines\b/i)).toEqual([EXECUTOR]);
    expect(filesMatching(/INSERT\s+INTO\s+\S*inventory_movements\b/i)).toEqual([EXECUTOR]);
    expect(filesMatching(/(UPDATE|DELETE\s+FROM)\s+\S*(purchase_receipts|purchase_receipt_lines)\b/i)).toEqual([]);
    const branch = receiptBranch();
    expect(branch).toMatch(/this\.applyInventoryMovement\(client, ctx,/);
    expect(branch).not.toMatch(/INSERT\s+INTO\s+\S*inventory_movements|UPDATE\s+business_operations|inventory_balances/i);
    expect(read(EXECUTOR).match(/private async applyInventoryMovement\(/g)).toHaveLength(1);
  });

  it('the command and record type live only in BO types, the mapper, the executor and the intake response schema; no route accepts or writes a receipt', () => {
    expect(filesMatching(/record_purchase_receipt/)).toEqual([MAPPERS, EXECUTOR, TYPES, 'apps/api/src/schemas/businessOperations.ts'].sort());
    for (const f of under('apps/api/src/routes/')) expect(f.code, f.rel).not.toMatch(/purchase_receipt|record_purchase_receipt/);
    expect(read(MAPPERS)).toMatch(/recordType: 'purchase_receipt'/);
    expect(read(MAPPERS)).toMatch(/return purchaseReceiptProblems\(data\);/);
    expect(receiptBranch()).toMatch(/purchaseReceiptProblems\(p\); \/\/ the SAME rule set as the intake mapper/);
  });

  it('the rule set reuses the Block B cost rule and the Block C pairing / exact-currency rule instead of duplicating them', () => {
    const r = read(RULES);
    expect(r).toMatch(/import \{ unitCostProblem \} from '\.\.\/unitCost\.js'/);
    expect(r).toMatch(/unitCostProblem\(line\.unitCost\)/);
    expect(r).toMatch(/\^\[A-Z\]\{3\}\$/);
    expect(r).toMatch(/unitCostCurrency_required_with_unitCost/);
    expect(r).not.toMatch(/'USD'|"USD"|default_currency|declared|Math\.round|toFixed|parseFloat/); // no inferred or defaulted currency, no rounding
    expect(receiptBranch()).not.toMatch(/currency_code|default_currency|business_currency_declarations|\?\? 'USD'/);
  });

  it('fails closed on provenance: source reference, provenance reference and idempotency key are all required before anything is written', () => {
    const b = receiptBranch();
    const gate = b.indexOf("['sourceReference', c.sourceReference], ['provenanceReference', c.provenanceReference], ['idempotencyKey', c.idempotencyKey]");
    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(b.indexOf('INSERT INTO'));
    expect(b).toMatch(/provenance: \{ sourceReference: c\.sourceReference, provenanceReference: c\.provenanceReference, idempotencyKey: c\.idempotencyKey, actorId: c\.actorId, occurredAt: c\.occurredAt \}/);
    // scope comes only from the command context / transaction, never from the payload
    expect(b).toMatch(/ctx\.tenantId, ctx\.workspaceId, businessId, p\.purchaseOrderId/);
    expect(b).not.toMatch(/p\.tenantId|p\.workspaceId|p\.businessId/);
    expect(read(RULES)).toMatch(/_not_allowed/);
  });

  it('idempotency is the receipt number: serialized by an advisory lock, identical content is a no-op, different content under the same number is refused', () => {
    const b = receiptBranch();
    expect(b.indexOf('pg_advisory_xact_lock')).toBeGreaterThan(-1);
    expect(b.indexOf('pg_advisory_xact_lock')).toBeLessThan(b.indexOf('INSERT INTO business_operations.purchase_receipts'));
    expect(b).toMatch(/canonicalJson\(existing\.rows\[0\]\.payload\?\.content\) !== canonicalJson\(content\)/);
    expect(b).toMatch(/already exists with different content/);
  });

  it('Block D and P0-6 are not involved: the receipt branch never touches purchase-order state or lines, reorder policy, activation, claims, executions or ABA', () => {
    const b = receiptBranch();
    expect(b).not.toMatch(/UPDATE|DELETE|received_qty|po_status|reorder|apply_inventory_reorder_policy|activation|authorized_action|AuthorizedAction|ExecutionEvidence|@infinicus\/workflow/i);
    for (const rel of [RULES, MAPPERS]) expect(read(rel), rel).not.toMatch(/authorized_action|AuthorizedAction|execution-activation|apply_inventory_reorder_policy|approved_business_action/);
    for (const f of [...under('packages/workflow/'), ...under('layers/approved-business-action/'), ...under('packages/outcome-monitoring-runtime/')]) expect(f.code, f.rel).not.toMatch(/purchase_receipt/);
    expect(filesMatching(/purchase_receipt/).filter((rel) => rel.startsWith(`${BO}authorized-action`) || rel.startsWith(`${BO}execution-activation`))).toEqual([]);
  });

  it('the migration: a new append-only table with FORCE RLS and the cost / currency / quantity invariants from the first row; no GRANT, role, seed, backfill, rewrite or data change', () => {
    const body = sql(MIGRATION).split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
    expect(body.match(/CREATE TABLE IF NOT EXISTS business_operations\.purchase_receipt_lines/g)).toHaveLength(1);
    expect(body).toMatch(/purchase_receipt_lines_unit_cost_positive CHECK \(unit_cost IS NULL OR \(unit_cost > 0 AND unit_cost <> 'NaN'::numeric\)\)/);
    expect(body).toMatch(/purchase_receipt_lines_cost_currency_presence CHECK \(\(unit_cost IS NULL\) = \(unit_cost_currency IS NULL\)\)/);
    expect(body).toMatch(/purchase_receipt_lines_quantity_positive CHECK \(quantity > 0 AND quantity <> 'NaN'::numeric\)/);
    expect(body).not.toMatch(/NOT VALID/);
    expect(body).toMatch(/FORCE ROW LEVEL SECURITY/);
    expect(body).toMatch(/forbid_mutation_purchase_receipt_lines[\s\S]*forbid_truncate_purchase_receipt_lines[\s\S]*forbid_mutation_purchase_receipts[\s\S]*forbid_truncate_purchase_receipts/);
    expect(body).not.toMatch(/\bGRANT\b|CREATE\s+(ROLE|USER)|ALTER\s+(ROLE|USER)|BYPASSRLS|SUPERUSER|SECURITY DEFINER/i);
    expect(body).not.toMatch(/\bUPDATE\s+\S+\s+SET\b|DELETE\s+FROM\s|INSERT\s+INTO\s+(?!_migrations)\S/i); // no data statement of any kind besides the migration registration
    expect(body).not.toMatch(/DROP\s+(TABLE|COLUMN|CONSTRAINT)|ALTER\s+TABLE\s+business_operations\.(inventory_movements|inventory_balances|purchase_orders)/i);
  });

  it('exactly one migration follows 0196 (0197) and no activation, seed or default-enabled path was added', () => {
    const migrations = readdirSync(join(PLATFORM, 'infrastructure/database/migrations')).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
    const from = migrations.findIndex((m) => m.startsWith('0196_'));
    expect(migrations.slice(from, from + 2)).toEqual([migrations[from], '0197_create_purchase_receipt_lines.sql']); // later migrations (Block D, 0198) are separately authorized
    expect(filesMatching(/state:\s*'ENABLED'/).filter((rel) => rel.startsWith('apps/') || rel.startsWith('packages/event-worker/src/'))).toEqual([]);
  });
});
