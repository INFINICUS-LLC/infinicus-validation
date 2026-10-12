/**
 * P0-5 Block 3d - architecture guard for the ABA package issuer (no database required).
 * The issuer is the ONE sealing/persisting component; it emits nothing, calls no Business Operations code, and offers no
 * consumption path. Everything here is a static scan of the real production tree.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLATFORM = resolve(HERE, '..', '..', '..');
const ISSUER = 'packages/workflow/src/AuthorizedActionPackageIssuer.ts';
const POLICY = 'packages/workflow/src/packageIssuancePolicy.ts';
const AUTHORING = 'packages/workflow/src/AbaAuthoringService.ts';
const SOURCE_READER = 'packages/database/src/repositories/approved_action/AuthorizedActionIssuanceRepository.ts';

const SKIP = new Set(['node_modules', 'dist', '.turbo', '.next', 'coverage']);
function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (/\.(ts|tsx|js|mjs|cjs)$/.test(name)) yield full;
  }
}
const isTest = (rel: string): boolean => /(^|\/)tests?\//.test(rel) || /\.test\.[tj]sx?$/.test(rel);
const production: { rel: string; text: string }[] = [];
for (const root of ['apps', 'packages', 'layers']) {
  for (const file of walk(join(PLATFORM, root))) {
    const rel = relative(PLATFORM, file).split('\\').join('/');
    if (!isTest(rel)) production.push({ rel, text: readFileSync(file, 'utf8') });
  }
}
const read = (rel: string): string => readFileSync(join(PLATFORM, rel), 'utf8');
const code = (rel: string): string => read(rel).split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

describe('ABA package issuer architecture', () => {
  it('scans the real production tree (not vacuous)', () => {
    expect(production.length).toBeGreaterThan(200);
    expect(production.some((f) => f.rel === ISSUER)).toBe(true);
  });

  it('the issuer is the only production file that seals a package', () => {
    expect(production.filter((f) => /sealAuthorizedActionPackage\(/.test(f.text) && !f.rel.startsWith('packages/handoff-contracts/')).map((f) => f.rel)).toEqual([ISSUER]);
  });

  it('nothing but the workflow package index, the authoring service (identifiers only) and tests reference the issuer, and no app, layer or BO code does', () => {
    const users = production
      .filter((f) => /AuthorizedActionPackageIssuer/.test(f.text))
      .map((f) => f.rel)
      .filter((rel) => rel !== ISSUER && rel !== AUTHORING && rel !== 'packages/workflow/src/index.ts');
    // P0-6f: the API composition root is the one place the issuer is joined to its announcer (and so to BO's activation gate); no other app, layer or BO code.
    expect(users).toEqual(['apps/api/src/abaPackageAnnouncement.ts']);
  });

  it('the shared transaction is used only by the issuer, the authoring service and the read-only P0-6a status provider (none nests it around the issuer)', () => {
    const users = production.filter((f) => /withSharedTenantTransaction/.test(f.text.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n'))).map((f) => f.rel).sort();
    expect(users).toEqual([ISSUER, AUTHORING, 'packages/workflow/src/abaExecutionPorts.ts', 'packages/database/src/client.ts', 'packages/database/src/index.ts'].sort());
  });

  it('the issuer, its policy and the source reader name no event, outbox, ledger or publisher (any announcement is an injected collaborator)', () => {
    for (const rel of [ISSUER, POLICY, SOURCE_READER]) {
      expect(code(rel), rel).not.toMatch(/ACTION_AUTHORIZED|aba\.action\.authorized|outbox|business_event_ledger|CanonicalEventPublisher|EventLedger/i);
    }
  });

  it('never touches Business Operations (no BO import, table or runtime)', () => {
    for (const rel of [ISSUER, POLICY, SOURCE_READER]) {
      expect(code(rel), rel).not.toMatch(/business[_-]operations|@infinicus\/business-operations|layers\/business-operations/i);
    }
  });

  it('offers no consumption path: no consume/claim/execute API on the issuer, its policy or the package repository', () => {
    for (const rel of [ISSUER, POLICY, 'packages/database/src/repositories/approved_action/AuthorizedActionPackageRepository.ts']) {
      expect(code(rel), rel).not.toMatch(/\b(consume|claimPackage|markConsumed|executePackage|ExecutionEvidence)\w*\s*\(/i);
    }
  });

  it('the policy module is pure: no runtime database import, no clock, no I/O, no randomness', () => {
    const text = code(POLICY);
    const imports = [...text.matchAll(/^import (type )?.* from '([^']+)'/gm)].map((m) => ({ type: Boolean(m[1]), spec: m[2] }));
    for (const i of imports.filter((x) => x.spec === '@infinicus/database')) expect(i.type, 'database imports must be type-only').toBe(true);
    expect(text).not.toMatch(/Date\.now\(|new Date\(\)|Math\.random|randomUUID|node:fs|node:crypto|process\./);
  });

  it('the source reader imports only the tenant client, repository errors and shared support, and writes only audit rows', () => {
    const imports = [...read(SOURCE_READER).matchAll(/^import .* from '([^']+)'/gm)].map((m) => m[1]).sort();
    expect(imports).toEqual(['../../client.js', '../../client.js', './errors.js', './governanceSupport.js']);
    const text = code(SOURCE_READER);
    expect(text).not.toMatch(/\bDELETE\s+FROM\b/);
    const writes = [...text.matchAll(/\b(INSERT\s+INTO|UPDATE)\s+(\S+)/g)].map((m) => m[2]);
    expect(writes).toEqual(['${S}.approval_audit_events']);
  });

  it('the action version is read for its id only (D3D-4): no description and no executable data from approved_action_versions', () => {
    const text = code(SOURCE_READER);
    expect(text).toMatch(/SELECT v\.id FROM \$\{S\}\.approved_action_versions/);
    expect(text).not.toMatch(/approved_action_(?:steps|constraints)|description/);
    expect(code(POLICY)).not.toMatch(/description|approved_action_versions|actionCode/);
  });

  it('every issuer repository call runs through the tenant transaction (RLS-confined)', () => {
    const text = code(SOURCE_READER);
    expect(text).not.toMatch(/getPool\(|\bpool\.query\(|(?<![.\w])query\(/);
    const methods = [...text.matchAll(/^ {2}async (\w+)\(/gm)].map((m) => m[1]);
    expect(methods.sort()).toEqual(['loadSources', 'lockAction', 'recordAudit']);
    expect((text.match(/withTenantTransaction\(/g) ?? []).length).toBe(methods.length);
  });
});
