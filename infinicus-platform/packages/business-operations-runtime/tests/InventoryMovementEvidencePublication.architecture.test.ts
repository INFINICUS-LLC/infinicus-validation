/**
 * BO-PUB-DEV-02 architecture guards (static), R4/D3 association model: the migration is minimal, additive and shaped exactly as D3 describes; the repository is the one controlled
 * writer with the D3 lock order and replay rules; publication is fail-closed and unreachable from any route or other layer; the reader is read-only.
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
const repoRaw = read('packages/database/src/repositories/bo/BoPublicationEvidenceRepository.ts');
const repo = strip(repoRaw);
const publication = strip(read('packages/business-operations-runtime/src/publication/record-evidence/InventoryMovementEvidencePublication.ts'));
const sources = [...walk(resolve(root, 'packages')), ...walk(resolve(root, 'apps'))].filter((f) => /[\\/]src[\\/].*\.(ts|tsx|js|mjs)$/.test(f)).map(rel);

describe('BO-PUB-DEV-02 - migration 0224 is minimal, additive and shaped as the D3 association model', () => {
  it('is the newest migration and creates exactly ONE BO table and ONE parent key; it drops, renames, grants and rewrites nothing', () => {
    const all = readdirSync(resolve(root, 'infrastructure/database/migrations')).filter((f) => f.endsWith('.sql')).sort();
    // 0224 is the newest BO migration; the only later one is POS2-02's billing entitlement store (billing schema, no BO table)
    expect(all.slice(all.indexOf('0224_bo_publication_evidence.sql'))).toEqual(['0224_bo_publication_evidence.sql', '0225_create_billing_entitlements.sql']);
    expect([...sql.matchAll(/CREATE TABLE ([a-z_.]+)/g)].map((m) => m[1])).toEqual(['business_operations.bo_publication_evidence']);
    expect([...sql.matchAll(/ALTER TABLE ([a-z_.]+) ADD CONSTRAINT ([a-z_0-9]+)/g)].map((m) => `${m[1]}.${m[2]}`)).toEqual(['business_operations.bo_publication_packages.bo_publication_packages_d3_key']);
    expect(sql).not.toMatch(/\bDROP (TABLE|COLUMN|CONSTRAINT|TRIGGER|POLICY)\b|\bRENAME\b|\bGRANT\b|\bREVOKE\b|\bCREATE ROLE\b|\bUPDATE business_operations|\bDELETE FROM\b|\bTRUNCATE TABLE\b|;\s*TRUNCATE business/i); // (BEFORE TRUNCATE is the append-only trigger)
    expect(sql).not.toMatch(/INSERT INTO (?!_migrations)/i); // no audit, outbox, dispatch or other write
  });
  it('the parent key is the six-column header tuple (id, tenant, workspace, business, period start, period end)', () => {
    expect(sql).toContain('ADD CONSTRAINT bo_publication_packages_d3_key UNIQUE (id, tenant_id, workspace_id, business_id, period_start, period_end)');
  });
  it('ONE slot per header: a non-deferrable UNIQUE on the header id alone; and the composite FK is the full tuple, RESTRICT on update and delete, immediate', () => {
    expect(sql).toContain('CONSTRAINT bo_publication_evidence_one_per_header UNIQUE (publication_package_id)');
    expect(sql).toContain('CONSTRAINT bo_publication_evidence_header_fk FOREIGN KEY (publication_package_id, tenant_id, workspace_id, business_id, period_start, period_end) REFERENCES business_operations.bo_publication_packages (id, tenant_id, workspace_id, business_id, period_start, period_end) ON UPDATE RESTRICT ON DELETE RESTRICT');
    expect(sql).not.toMatch(/DEFERRABLE(?! INITIALLY DEFERRED FOR EACH ROW)/); // no constraint on the table is deferrable
    expect(sql).not.toMatch(/CREATE CONSTRAINT TRIGGER/);
  });
  it('identities are separate and derived in the database: a generated row id, a content digest over the stored bytes, and an evidence id derived from the digest', () => {
    expect(sql).toContain('id uuid PRIMARY KEY DEFAULT gen_random_uuid()');
    expect(sql).toContain("digest = encode(sha256(convert_to('bo-evidence-body:' || canonical_body, 'UTF8')), 'hex')");
    expect(sql).toContain("evidence_id = encode(sha256(convert_to('bo-evidence-id:' || contract_name || ':' || digest, 'UTF8')), 'hex')");
    for (const c of ["contract_name = 'bo.inventory_movements.record_evidence'", "contract_version = '0.1.0-proposed'", "contract_status = 'PROPOSED_NOT_ACTIVE'", "domain = 'inventory_movements'", "digest_algorithm = 'sha256'", "canonicalization = 'bo-canonical-json-v1'"]) expect(sql).toContain(c);
  });
  it('a NEW association needs the creation state "ready" only (not dispatched or received), a BI-addressed header and the declared count; created_at is the database clock', () => {
    for (const c of ["h.target_layer <> 'business_intelligence'", "h.package_status <> 'ready'", 'h.record_count <> NEW.record_count', 'NEW.created_at := now()']) expect(sql).toContain(c);
    expect(sql).not.toContain("'dispatched', 'received'");
  });
  it('is append-only (reusing business_operations.forbid_mutation, never redefining it) with ENABLE and FORCE row-level security and a tenant+workspace policy', () => {
    expect(sql).toContain('CREATE TRIGGER forbid_mutation_bo_publication_evidence BEFORE UPDATE OR DELETE ON business_operations.bo_publication_evidence FOR EACH ROW EXECUTE FUNCTION business_operations.forbid_mutation()');
    expect(sql).toContain('CREATE TRIGGER forbid_truncate_bo_publication_evidence BEFORE TRUNCATE ON business_operations.bo_publication_evidence FOR EACH STATEMENT EXECUTE FUNCTION business_operations.forbid_mutation()');
    expect(sql).toContain('ENABLE ROW LEVEL SECURITY'); expect(sql).toContain('FORCE ROW LEVEL SECURITY');
    expect(sql).toContain("USING (tenant_id = current_setting('app.tenant_id', true)::uuid AND workspace_id = current_setting('app.workspace_id', true)::uuid)");
    expect(sql).not.toMatch(/CREATE OR REPLACE FUNCTION business_operations\.forbid_mutation/);
  });
  it('no records table (the full canonical body is the artifact), and decimals are text: no numeric, double or real column', () => {
    expect(sql).not.toMatch(/bo_publication_evidence_records/);
    const table = sql.slice(sql.indexOf('CREATE TABLE business_operations.bo_publication_evidence'), sql.indexOf('CREATE OR REPLACE FUNCTION'));
    expect(table).not.toMatch(/\b(numeric|decimal|double precision|real|float)\b/i);
    expect(table).toMatch(/canonical_body\s+text\s+NOT NULL/);
  });
});

describe('BO-PUB-DEV-02 - the repository is the ONE controlled writer, with the D3 lock order and replay rules', () => {
  const statements = [...repo.matchAll(/client\.query[^(]*\(\s*(?:`([\s\S]*?)`|'([^']*)')/g)].map((m) => flat(m[1] ?? m[2] ?? ''));
  it('every statement is parameterised; the only write is ONE insert into the evidence table with ON CONFLICT (publication_package_id) DO NOTHING; the header is only ever read FOR UPDATE', () => {
    const writes = statements.filter((s) => /^(INSERT|UPDATE|DELETE|TRUNCATE)\b/i.test(s));
    expect(writes).toHaveLength(1); expect(writes[0]).toMatch(/^INSERT INTO business_operations\.bo_publication_evidence /); expect(writes[0]).toContain('ON CONFLICT (publication_package_id) DO NOTHING RETURNING id');
    expect(statements.some((s) => /^(UPDATE|DELETE|TRUNCATE|DROP|ALTER)\b/i.test(s))).toBe(false);
    expect(statements.some((s) => /bo_publication_packages/.test(s) && /FOR UPDATE$/.test(s) && /tenant_id = \$2 AND workspace_id = \$3 AND business_id = \$4/.test(s))).toBe(true);
    expect(repo.replace(/`bo_publication_evidence:[^`]*`/, '')).not.toMatch(/\$\{(?!MS\}|EVIDENCE_COLUMNS\})/);
  });
  it('lock order: the header FOR UPDATE comes first, then the association is read, THEN eligibility; replay is decided before eligibility', () => {
    const lock = repo.indexOf('FOR UPDATE'); const read = repo.indexOf('const existing = await readStored()'); const eligibility = repo.indexOf("h.package_status !== 'ready'"); const insert = repo.indexOf('INSERT INTO business_operations.bo_publication_evidence');
    expect(lock).toBeGreaterThan(0); expect(read).toBeGreaterThan(lock); expect(eligibility).toBeGreaterThan(read); expect(insert).toBeGreaterThan(eligibility);
    expect(repo).toMatch(/if \(existing !== null\) return decide\(existing\)/);
  });
  it('replay compares the stored canonical bytes, digest, evidence id, period, contract and schema - and NOT the correlation id; a different artifact is a CONFLICT', () => {
    const same = repo.slice(repo.indexOf('function sameArtifact'), repo.indexOf('export class'));
    for (const f of ['canonicalBody', 'digest', 'evidenceId', 'periodStart', 'periodEnd', 'contractName', 'contractVersion', 'contractStatus', 'recordSchemaVersion']) expect(same).toContain(`s.${f} === i.${f}`);
    expect(same).not.toMatch(/correlation/i);
    expect(repo).toMatch(/sameArtifact\(s, input\) \? \{ outcome: 'REPLAYED'.*: \{ outcome: 'CONFLICT' \}/);
  });
  it('a lost race is read back in a separate statement and validated identically; a database refusal is an outcome with no SQL, constraint or message text', () => {
    expect(repo).toMatch(/const winner = await readStored\(\);\s*return winner === null \? \{ outcome: 'REFUSED' \} : decide\(winner\)/);
    expect(repo).not.toMatch(/\.message|\.detail|\.constraint|String\(error\)/);
    expect(repo).toMatch(/outcome: code === '23505' \? 'CONFLICT' : 'REFUSED'/);
  });
  it('touches no operational ledger, no Business Intelligence table, no event or audit table, and never updates the header', () => {
    expect(repo).not.toMatch(/inventory_movements|inventory_balances|business_intelligence\.|events\.|audit\.|bo_handoff_records|dispatchTo|\.dispatch\(/i); // ('business_intelligence' alone is the target-layer literal of the eligibility check)
  });
  it('reads are pinned to tenant, workspace and business', () => {
    for (const s of statements.filter((x) => /FROM business_operations\.bo_publication_evidence/.test(x))) expect(s).toMatch(/tenant_id = \$\d AND [a-z.]*workspace_id = \$\d AND [a-z.]*business_id = \$\d/);
  });
});

describe('BO-PUB-DEV-02 - publication is fail-closed and unreachable; the reader is read-only', () => {
  it('the shipped authority denies, only an explicit true authorises, and the authority is consulted before any extraction', () => {
    expect(publication).toMatch(/DisabledPublicationAuthority: PublicationAuthority = Object\.freeze\(\{ mayPublish: async \(\) => false \}\)/);
    expect(publication).toMatch(/\(await this\.authority\.mayPublish\(ctx, request\?\.businessId\)\) !== true/);
    expect(publication.indexOf('this.authority.mayPublish')).toBeLessThan(publication.indexOf('this.extractor.extract'));
    expect(publication).toMatch(/constructor\(\s*private readonly authority: PublicationAuthority = DisabledPublicationAuthority/);
    expect(sources.filter((f) => /mayPublish/.test(strip(read(f))))).toEqual(['packages/business-operations-runtime/src/publication/record-evidence/InventoryMovementEvidencePublication.ts']);
  });
  it('no route, worker, event publisher or other layer constructs the publication service or touches the evidence table; the existing publication service does not know it', () => {
    const outside = sources.filter((f) => !f.startsWith('packages/business-operations-runtime/src/') && f !== 'packages/database/src/repositories/bo/BoPublicationEvidenceRepository.ts' && f !== 'packages/database/src/index.ts')
      .filter((f) => /InventoryMovementEvidencePublicationService|bo_publication_evidence|BoPublicationEvidenceRepository|DisabledPublicationAuthority/.test(strip(read(f))));
    expect(outside).toEqual([]);
    const insideBo = sources.filter((f) => f.startsWith('packages/business-operations-runtime/src/') && !f.includes('/publication/record-evidence/') && f !== 'packages/business-operations-runtime/src/index.ts')
      .filter((f) => /InventoryMovementEvidencePublicationService|BoPublicationEvidenceRepository|bo_publication_evidence/.test(strip(read(f))));
    expect(insideBo).toEqual([]);
    expect(strip(read('packages/business-operations-runtime/src/publication/OperationalPublicationService.ts'))).not.toMatch(/bo_publication_evidence|Evidence/);
  });
  it('the reader can only use the read port, never reads the mutable ledger, compares the stored columns with the body and requires canonical bytes', () => {
    expect(publication).toMatch(/PublicationEvidenceReadPort = Pick<BoPublicationEvidenceRepository, 'getByHeader'>/);
    const reader = publication.slice(publication.indexOf('export class InventoryMovementEvidenceReader'), publication.indexOf('export class InventoryMovementEvidencePublicationService'));
    expect(reader).not.toMatch(/\.append\(|inventory_movements|InventoryMovementEvidenceExtractor/);
    expect(publication).toMatch(/canonicalJson\(body\) !== s\.canonicalBody\) return null/);
    for (const c of ['artifact.scope?.tenantId === stored.tenantId', 'artifact.source?.boPublicationPackageId === stored.publicationPackageId', 'artifact.source?.periodStart === stored.periodStart', 'artifact.recordCount === stored.recordCount']) expect(reader).toContain(c);
  });
  it('the publication changes no header state and writes no event, audit row or Business Intelligence table', () => {
    expect(publication).not.toMatch(/package_status|UPDATE |outbox|publishEvent|OperationalPublicationService|business_intelligence|\.dispatch\(/);
  });
});
