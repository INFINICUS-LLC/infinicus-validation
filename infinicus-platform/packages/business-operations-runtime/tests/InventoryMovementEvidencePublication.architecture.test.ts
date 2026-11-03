/**
 * BO-PUB-DEV-02 architecture guards (static): the migration is additive and complete, the evidence is BO-owned, append-only and tenant-isolated, publication is fail-closed
 * and unreachable from any route or other layer, and Business Intelligence can only ever reach the read-only reader.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';

const root = resolve(__dirname, '..', '..', '..');
const read = (rel: string) => readFileSync(resolve(root, rel), 'utf8');
const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
const flat = (s: string) => s.replace(/\s+/g, ' ');
const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (e.name === 'node_modules' || e.name === 'dist' ? [] : walk(join(dir, e.name))) : [join(dir, e.name)]));
const rel = (f: string) => f.slice(root.length + 1).replace(/\\/g, '/');
const migrationName = readdirSync(resolve(root, 'infrastructure/database/migrations')).find((f) => f.startsWith('0224_'))!;
const migrationRaw = read(`infrastructure/database/migrations/${migrationName}`);
const sql = flat(strip(migrationRaw.replace(/^--.*$/gm, '')));
const repo = strip(read('packages/database/src/repositories/bo/BoPublicationEvidenceRepository.ts'));
const publication = strip(read('packages/business-operations-runtime/src/publication/record-evidence/InventoryMovementEvidencePublication.ts'));
const sources = [...walk(resolve(root, 'packages')), ...walk(resolve(root, 'apps'))].filter((f) => /[\\/]src[\\/].*\.(ts|tsx|js|mjs)$/.test(f)).map(rel);

describe('BO-PUB-DEV-02 - migration 0224 is minimal, additive and complete', () => {
  it('is the newest migration and creates exactly two BO tables and one scope key; it drops, renames, grants and rewrites nothing', () => {
    const all = readdirSync(resolve(root, 'infrastructure/database/migrations')).filter((f) => f.endsWith('.sql')).sort();
    expect(all[all.length - 1]).toBe('0224_bo_publication_evidence.sql');
    expect([...sql.matchAll(/CREATE TABLE ([a-z_.]+)/g)].map((m) => m[1])).toEqual(['business_operations.bo_publication_evidence', 'business_operations.bo_publication_evidence_records']);
    expect([...sql.matchAll(/ALTER TABLE ([a-z_.]+) ADD CONSTRAINT ([a-z_]+)/g)].map((m) => `${m[1]}.${m[2]}`)).toEqual(['business_operations.bo_publication_packages.bo_publication_packages_scope_key']);
    expect(sql).not.toMatch(/\bDROP (TABLE|COLUMN|CONSTRAINT|TRIGGER|POLICY)\b|\bRENAME\b|\bGRANT\b|\bREVOKE\b|\bCREATE ROLE\b|\bUPDATE business_operations|\bDELETE FROM\b|\bTRUNCATE TABLE\b|;\s*TRUNCATE business/i); // (BEFORE TRUNCATE is the append-only trigger, not a statement)
    expect(sql).not.toMatch(/INSERT INTO (?!_migrations)/i);
  });
  it('binds every evidence row to its header and scope through composite foreign keys, one evidence per header, and the digest/id/count rules as CHECK constraints', () => {
    expect(sql).toContain('CONSTRAINT bo_publication_evidence_header_fk FOREIGN KEY (publication_package_id, tenant_id, workspace_id, business_id) REFERENCES business_operations.bo_publication_packages (id, tenant_id, workspace_id, business_id)');
    expect(sql).toContain('CONSTRAINT bo_publication_evidence_records_evidence_fk FOREIGN KEY (evidence_row_id, tenant_id, workspace_id, business_id) REFERENCES business_operations.bo_publication_evidence (id, tenant_id, workspace_id, business_id)');
    expect(sql).toContain('CONSTRAINT bo_publication_evidence_one_per_header UNIQUE (publication_package_id)');
    expect(sql).toContain("digest = encode(sha256(convert_to('bo-evidence-body:' || canonical_body, 'UTF8')), 'hex')");
    expect(sql).toContain("evidence_id = encode(sha256(convert_to('bo-evidence-id:' || contract_name || ':' || digest, 'UTF8')), 'hex')");
    expect(sql).toContain('CONSTRAINT bo_publication_evidence_counts_agree CHECK (declared_record_count = record_count)');
    for (const c of ["contract_name = 'bo.inventory_movements.record_evidence'", "contract_version = '0.1.0-proposed'", "contract_status = 'PROPOSED_NOT_ACTIVE'", "domain = 'inventory_movements'", "digest_algorithm = 'sha256'", "canonicalization = 'bo-canonical-json-v1'"]) expect(sql).toContain(c);
  });
  it('the database, not the caller, supplies the declared count and the time, and checks the header (layer, state, period, count) before storing', () => {
    expect(sql).toContain('NEW.declared_record_count := h.record_count');
    expect(sql).toContain('NEW.created_at := now()');
    for (const c of ["h.target_layer <> 'business_intelligence'", "h.package_status NOT IN ('ready', 'dispatched', 'received')", 'h.period_start <> NEW.period_start OR h.period_end <> NEW.period_end', 'h.record_count <> NEW.record_count']) expect(sql).toContain(c);
  });
  it('is complete-or-absent: a deferred constraint trigger compares the records with the canonical body at commit', () => {
    expect(sql).toMatch(/CREATE CONSTRAINT TRIGGER check_bo_publication_evidence_complete AFTER INSERT ON business_operations\.bo_publication_evidence DEFERRABLE INITIALLY DEFERRED/);
    expect(sql).toContain("agg IS DISTINCT FROM (NEW.canonical_body::jsonb -> 'records')");
  });
  it('both tables are append-only (reusing business_operations.forbid_mutation, update/delete/truncate) with forced tenant+workspace row-level security', () => {
    expect(sql).toContain("ARRAY['bo_publication_evidence', 'bo_publication_evidence_records']");
    expect(sql).toContain('BEFORE UPDATE OR DELETE ON business_operations.%1$s FOR EACH ROW EXECUTE FUNCTION business_operations.forbid_mutation()');
    expect(sql).toContain('BEFORE TRUNCATE ON business_operations.%1$s FOR EACH STATEMENT EXECUTE FUNCTION business_operations.forbid_mutation()');
    expect(sql).toContain('FORCE ROW LEVEL SECURITY');
    expect(sql).toContain("USING (tenant_id = current_setting('app.tenant_id', true)::uuid AND workspace_id = current_setting('app.workspace_id', true)::uuid)");
    expect(sql).not.toMatch(/CREATE OR REPLACE FUNCTION business_operations\.forbid_mutation/); // the shared function is reused, never redefined
  });
  it('decimals are text: no numeric, double or real column on either table', () => {
    const tables = sql.slice(sql.indexOf('CREATE TABLE business_operations.bo_publication_evidence'), sql.indexOf('CREATE OR REPLACE FUNCTION'));
    expect(tables).not.toMatch(/\b(numeric|decimal|double precision|real|float)\b/i);
  });
});

describe('BO-PUB-DEV-02 - the repository writes only the evidence tables and reads only what it must', () => {
  const statements = [...repo.matchAll(/client\.query[^(]*\(\s*(?:`([\s\S]*?)`|'([^']*)')/g)].map((m) => flat(m[1] ?? m[2] ?? ''));
  it('every statement is parameterised, none interpolates a value, and the writes are the two evidence INSERTs only', () => {
    // the only interpolations are two fixed SQL fragments (column list, timestamp format) and the advisory-lock KEY, which is a bound parameter value
    expect(repo.replace(/`bo_publication_evidence:\$\{business\}:\$\{header\}`/, '')).not.toMatch(/\$\{(?!MS\}|EVIDENCE_COLUMNS\})/);
    const writes = statements.filter((s) => /^(INSERT|UPDATE|DELETE|TRUNCATE)\b/i.test(s));
    expect(writes.map((s) => s.match(/^INSERT INTO ([a-z_.]+)/)![1])).toEqual(['business_operations.bo_publication_evidence', 'business_operations.bo_publication_evidence_records']);
    expect(statements.some((s) => /^(UPDATE|DELETE|TRUNCATE|DROP|ALTER)\b/i.test(s))).toBe(false);
  });
  it('touches no operational ledger, no publication-header write and no Business Intelligence table', () => {
    expect(repo).not.toMatch(/inventory_movements|inventory_balances|bo_publication_packages|business_intelligence|events\.|audit\./);
    expect(repo).toMatch(/pg_advisory_xact_lock/);
  });
  it('reads are pinned to tenant, workspace and business, and replay/conflict is decided on the digest', () => {
    const selects = statements.filter((s) => /^SELECT .*bo_publication_evidence/.test(s));
    expect(selects.length).toBeGreaterThanOrEqual(2);
    for (const s of selects.filter((x) => !x.includes('pg_advisory'))) expect(s).toMatch(/tenant_id = \$\d AND [a-z.]*workspace_id = \$\d AND [a-z.]*business_id = \$\d/);
    expect(repo).toMatch(/digest === input\.digest \? \{ outcome: 'REPLAYED'/);
  });
  it('reports a database refusal as an outcome, with no SQL, constraint or message text', () => {
    expect(repo).not.toMatch(/\.message|\.detail|\.constraint|String\(error\)/);
    expect(repo).toMatch(/outcome: code === '23505' \? 'CONFLICT' : 'REFUSED'/);
  });
});

describe('BO-PUB-DEV-02 - publication is fail-closed and unreachable; the reader is read-only', () => {
  it('the shipped authority denies, the service consults it before any read, and no production source supplies an approving authority', () => {
    expect(publication).toMatch(/DisabledPublicationAuthority: PublicationAuthority = Object\.freeze\(\{ mayPublish: async \(\) => false \}\)/);
    const authorize = publication.indexOf('this.authority.mayPublish'); const extract = publication.indexOf('this.extractor.extract');
    expect(authorize).toBeGreaterThan(0); expect(authorize).toBeLessThan(extract);
    expect(publication).toMatch(/constructor\(\s*private readonly authority: PublicationAuthority = DisabledPublicationAuthority/);
    const definers = sources.filter((f) => /mayPublish/.test(strip(read(f))));
    expect(definers).toEqual(['packages/business-operations-runtime/src/publication/record-evidence/InventoryMovementEvidencePublication.ts']);
  });
  it('no route, worker, event publisher or other layer constructs the publication service or touches the evidence tables', () => {
    const users = sources.filter((f) => !f.startsWith('packages/business-operations-runtime/src/') && f !== 'packages/database/src/repositories/bo/BoPublicationEvidenceRepository.ts' && f !== 'packages/database/src/index.ts')
      .filter((f) => /InventoryMovementEvidencePublicationService|bo_publication_evidence|BoPublicationEvidenceRepository|DisabledPublicationAuthority/.test(strip(read(f))));
    expect(users).toEqual([]);
    const insideBo = sources.filter((f) => f.startsWith('packages/business-operations-runtime/src/') && !f.includes('/publication/record-evidence/') && f !== 'packages/business-operations-runtime/src/index.ts')
      .filter((f) => /InventoryMovementEvidencePublicationService|BoPublicationEvidenceRepository|bo_publication_evidence/.test(strip(read(f))));
    expect(insideBo).toEqual([]);
  });
  it('the reader can only use the read port: it has no write method in its type, imports no write repository method, and never reads the mutable ledger', () => {
    expect(publication).toMatch(/PublicationEvidenceReadPort = Pick<BoPublicationEvidenceRepository, 'getByHeader'>/);
    const reader = publication.slice(publication.indexOf('export class InventoryMovementEvidenceReader'), publication.indexOf('export class InventoryMovementEvidencePublicationService'));
    expect(reader).not.toMatch(/\.append\(|inventory_movements|InventoryMovementEvidenceExtractor/);
    expect(reader).toMatch(/canonicalEvidenceBody\(artifact\) !== stored\.canonicalBody/);
  });
  it('the publication changes no header state and writes no event, audit row or Business Intelligence table', () => {
    expect(publication).not.toMatch(/package_status|UPDATE |outbox|publishEvent|OperationalPublicationService|business_intelligence|\.dispatch\(/);
  });
});
