/**
 * BO-PUB-DEV-01 architecture guards (static): the evidence component is pure, BO-owned, read-only, isolated from every other layer and from live publication, adds no
 * migration, route, permission or event, and the proposed contract can never be mistaken for an approved one.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';

const root = resolve(__dirname, '..', '..', '..');
const read = (rel: string) => readFileSync(resolve(root, rel), 'utf8');
const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (e.name === 'node_modules' || e.name === 'dist' ? [] : walk(join(dir, e.name))) : [join(dir, e.name)]));
const rel = (f: string) => f.slice(root.length + 1).replace(/\\/g, '/');
const evidenceRaw = read('packages/business-operations-runtime/src/publication/record-evidence/inventoryMovementEvidence.ts');
const evidence = strip(evidenceRaw);
const extractorRaw = read('packages/business-operations-runtime/src/publication/record-evidence/InventoryMovementEvidenceExtractor.ts');
const extractor = strip(extractorRaw);
const sources = [...walk(resolve(root, 'packages')), ...walk(resolve(root, 'apps'))].filter((f) => /[\\/]src[\\/].*\.(ts|tsx|js|mjs)$/.test(f));

describe('BO-PUB-DEV-01 - the evidence module is pure and deterministic', () => {
  it('imports only node:crypto; no clock, randomness, I/O, database, network or other layer', () => {
    expect([...evidence.matchAll(/^import .* from '([^']+)'/gm)].map((m) => m[1])).toEqual(['node:crypto']);
    expect(evidence).not.toMatch(/Date\.now|new Date\(\)|Math\.random|randomUUID|process\.|fetch\(|require\(|readFile|writeFile|setTimeout|@infinicus/);
    expect([...evidence.matchAll(/\bDate\.[A-Za-z]+/g)].map((m) => m[0])).toEqual(['Date.UTC']);
  });
  it('never turns money or stock into a floating-point value: decimals are text; no parseFloat/Math rounding; the only Number() is a threshold comparison on already-validated text', () => {
    expect(evidence).not.toMatch(/parseFloat|parseInt|Math\.(round|floor|ceil|trunc|fround)|toFixed/);
    expect([...evidence.matchAll(/Number\(([^)]*)\)/g)].map((m) => m[1])).toEqual(['v.unitCost']);
  });
});

describe('BO-PUB-DEV-01 - the proposed contract is marked proposed and is not active', () => {
  it('names itself PROPOSED_NOT_ACTIVE with a -proposed version and schema version, and the header comment says it is not approved', () => {
    expect(evidence).toMatch(/status: 'PROPOSED_NOT_ACTIVE'/);
    expect(evidence).toMatch(/contractVersion: '0\.1\.0-proposed'/);
    expect(evidence).toMatch(/recordSchemaVersion: 'bo\.inventory_movement\.record\.v0\.1-proposed'/);
    expect(evidenceRaw).toMatch(/PROPOSED contract/);
    expect(evidenceRaw).toMatch(/NOT an[\s*]+approved/);
  });
  it('is not referenced by any production source outside the BO package: no BI, API, event, worker or handoff-contract source mentions it', () => {
    const users = sources.map(rel).filter((f) => !f.startsWith('packages/business-operations-runtime/src/')).filter((f) => /InventoryMovementEvidence|InventoryMovementRecord|record_evidence|verifyInventoryMovementEvidence|buildInventoryMovementEvidence/.test(strip(read(f))));
    expect(users).toEqual([]);
  });
  it('inside the BO package it is referenced only by its own folder and the package index (nothing activates or calls it)', () => {
    const users = sources.map(rel).filter((f) => f.startsWith('packages/business-operations-runtime/src/') && !f.includes('/publication/record-evidence/') && f !== 'packages/business-operations-runtime/src/index.ts')
      .filter((f) => /InventoryMovementEvidence|record-evidence|verifyInventoryMovementEvidence|buildInventoryMovementEvidence/.test(strip(read(f))));
    expect(users).toEqual([]);
  });
  it('the existing publication service and the frozen BO -> BI handoff contract do not mention the new contract', () => {
    for (const f of ['packages/business-operations-runtime/src/publication/OperationalPublicationService.ts', 'packages/handoff-contracts/src/bo-to-bi.ts']) expect(strip(read(f)), f).not.toMatch(/record_evidence|InventoryMovementEvidence|PROPOSED_NOT_ACTIVE/);
  });
});

describe('BO-PUB-DEV-01 - the extractor is BO-owned, read-only and isolated', () => {
  const statements = [...extractor.matchAll(/(?:const (LEDGER|HEADER) = `([\s\S]*?)`;)/g)].map((m) => ({ name: m[1]!, sql: m[2]!.replace(/\s+/g, ' ').trim() }));
  it('has exactly the ledger and the header statements, both SELECT, parameterised, with no interpolation anywhere', () => {
    expect(statements.map((s) => s.name)).toEqual(['LEDGER', 'HEADER']);
    for (const s of statements) { expect(s.sql).toMatch(/^SELECT /); expect(s.sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE|DROP|ALTER|CREATE|GRANT)\b/i); }
    expect(extractor).not.toMatch(/\$\{/);
    expect(extractor.match(/client\.query/g)?.length).toBe(3); // business check, ledger, header, and nothing else
  });
  it('the ledger statement names a fixed column list (never *), omits notes, performed_by and created_at, and is pinned to tenant, workspace and business', () => {
    const ledger = statements.find((s) => s.name === 'LEDGER')!.sql;
    expect(ledger).not.toMatch(/\*|\bnotes\b|performed_by|created_at/);
    expect(ledger).toContain('WHERE m.tenant_id = $1 AND m.workspace_id = $2 AND m.business_id = $3');
    expect(ledger).toContain('ORDER BY m.occurred_at ASC, m.id ASC');
    expect(ledger).toMatch(/LIMIT \$6$/);
    const header = statements.find((s) => s.name === 'HEADER')!.sql;
    expect(header).toContain('WHERE id = $1 AND tenant_id = $2 AND workspace_id = $3 AND business_id = $4');
  });
  it('reads only the ledger and the publication header; no other BO or BI table; it imports only the database client and its own module', () => {
    expect([...new Set(extractor.match(/business_operations\.[a-z_]+/g))].sort()).toEqual(['business_operations.bo_publication_packages', 'business_operations.inventory_movements']);
    expect(extractor).not.toMatch(/business_intelligence\.|events\.|audit\./);
    expect([...extractor.matchAll(/from '([^']+)'/g)].map((m) => m[1])).toEqual(['@infinicus/database', './inventoryMovementEvidence.js']);
  });
  it('writes nothing and publishes nothing: no outbox, no event, no handoff, no audit, no INSERT', () => {
    expect(extractor).not.toMatch(/outbox|publishEvent|OperationalEventService|OperationalPublicationService|BOToBIHandoff|\.publish\(|\.dispatch\(/i);
  });
});

describe('BO-PUB-DEV-01 - no migration, no route, no permission, no durable store', () => {
  it('the newest migration is still 0223 (this block adds none) and none mentions the evidence contract', () => {
    const migrations = readdirSync(resolve(root, 'infrastructure/database/migrations')).filter((f) => f.endsWith('.sql')).sort();
    expect(migrations[migrations.length - 1]).toMatch(/^0223_/);
    for (const m of migrations.slice(-5)) expect(read(`infrastructure/database/migrations/${m}`)).not.toMatch(/record_evidence|publication_evidence/i);
  });
  it('the API exposes nothing of it and no source creates a table, permission or event type for it', () => {
    const api = walk(resolve(root, 'apps/api/src')).filter((f) => /\.ts$/.test(f)).map((f) => read(rel(f))).join('\n');
    expect(api).not.toMatch(/InventoryMovementEvidence|record-evidence|record_evidence/);
    for (const s of [evidence, extractor]) expect(s).not.toMatch(/CREATE TABLE|permission|requirePermission|event_type|registerEvent/i);
  });
});
