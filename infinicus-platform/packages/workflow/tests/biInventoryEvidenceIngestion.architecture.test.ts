/**
 * BI-08-DEV-02 architecture guards (static): the consumer is pure, BI imports nothing from Business Operations, the ingestion service has no route and no SQL,
 * and it writes only through the warehouse row repository.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';

const root = resolve(__dirname, '..', '..', '..');
const read = (rel: string) => readFileSync(resolve(root, rel), 'utf8');
const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
const consumer = strip(read('packages/workflow/src/bi08/inventoryEvidenceConsumer.ts'));
const service = strip(read('packages/workflow/src/BusinessIntelligenceInventoryEvidenceIngestionService.ts'));
const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (e.name === 'node_modules' || e.name === 'dist' ? [] : walk(join(dir, e.name))) : [join(dir, e.name)]));

describe('BI-08-DEV-02 - consumer module', () => {
  it('imports only node:crypto and the pure load module; no clock, randomness, I/O, database or network', () => {
    expect([...consumer.matchAll(/^import .* from '([^']+)'/gm)].map((m) => m[1])).toEqual(['node:crypto', './warehouseLoad.js']);
    expect(consumer).not.toMatch(/Date\.now|new Date\(|Math\.random|randomUUID|process\.|fetch\(|require\(|readFile|writeFile|setTimeout/);
  });
  it('never coerces values to numbers', () => {
    expect(consumer).not.toMatch(/parseFloat|parseInt|Number\((?!\s*\))|Math\.(round|floor|ceil|trunc)|toFixed/);
  });
});

describe('BI-08-DEV-02 - ingestion service', () => {
  it('has no SQL, no pool, no route and no BO table or package access; its only writer is the warehouse row repository', () => {
    expect(service).not.toMatch(/\.query\(|withTenantTransaction|getPool|\b(INSERT INTO|UPDATE\s+[a-z_.]+\s+SET|DELETE FROM|TRUNCATE)\b/i);
    expect(service).not.toMatch(/fastify|app\.(get|post|put|patch|delete)\(|business-operations|business_operations|inventory_movements|inventory_balances/);
    expect(service).toMatch(/warehouse\.appendRows\(/);
    expect(service).toMatch(/warehouse\.sealVersion\(/);
  });
  it('the workflow package does not import Business Operations anywhere', () => {
    const offenders = walk(resolve(root, 'packages/workflow/src')).filter((f) => f.endsWith('.ts') && /from '@infinicus\/business-operations/.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
    expect(JSON.parse(read('packages/workflow/package.json')).dependencies?.['@infinicus/business-operations-runtime']).toBeUndefined();
  });
  it('adds no migration for this block', () => {
    // content-based, not number-based: no migration after 0224 may touch the warehouse / ingestion objects (another block's migration, e.g. billing 0225, is fine)
    const dir = resolve(root, 'infrastructure/database/migrations');
    const offenders = readdirSync(dir).filter((n) => /^0(22[5-9]|2[3-9]\d)_/.test(n)).filter((n) => /business_intelligence\.|from_bo_evidence|bi_warehouse|inventory_movements/i.test(readFileSync(resolve(dir, n), 'utf8')));
    expect(offenders).toEqual([]);
  });
});
