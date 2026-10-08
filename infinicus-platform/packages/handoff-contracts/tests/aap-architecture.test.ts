import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * ARCHITECTURE GUARD (P0-5 Block 2; owner rulings R-8, R-9, R-10).
 *
 *  1. Package creation is restricted to the ABA issuer: `sealAuthorizedActionPackage` may be referenced only by the
 *     contract package itself and the allow-listed issuer path. There is no issuer yet, so the allow-list is empty;
 *     the persistence/issuer block adds exactly one path here, with its own tests.
 *  2. Business Operations may consume the contract (validate) but never create a package.
 *  3. The contract is PURE and portable: it imports nothing outside itself (no database, no I/O, no ABA/BO code).
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const PLATFORM_ROOT = resolve(HERE, '..', '..', '..');
const CONTRACT_SRC = resolve(HERE, '..', 'src', 'authorized-action-package');

/** Platform-relative paths allowed to reference the seal function. Empty until the issuer exists (Block 3). */
const SEAL_ALLOWED_OUTSIDE_CONTRACT: readonly string[] = [];

const SKIP_DIRS = new Set(['node_modules', 'dist', '.turbo', '.next', 'coverage']);
const EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs']);

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) yield* walk(full);
    else if ([...EXTENSIONS].some((e) => name.endsWith(e))) yield full;
  }
}

const isTestFile = (rel: string): boolean => /(^|\/)tests?\//.test(rel) || /\.test\.[tj]sx?$/.test(rel);

describe('AuthorizedActionPackage architecture guard', () => {
  const production: Array<{ rel: string; text: string }> = [];
  for (const root of ['apps', 'packages', 'layers']) {
    for (const file of walk(join(PLATFORM_ROOT, root))) {
      const rel = relative(PLATFORM_ROOT, file).split('\\').join('/');
      if (isTestFile(rel)) continue;
      production.push({ rel, text: readFileSync(file, 'utf8') });
    }
  }

  it('scans the real production tree (not vacuous)', () => {
    expect(production.length).toBeGreaterThan(200);
    expect(production.some((f) => f.rel === 'packages/handoff-contracts/src/authorized-action-package/validator.ts')).toBe(true);
  });

  it('only the contract package and the allow-listed issuer reference sealAuthorizedActionPackage', () => {
    const offenders = production
      .filter((f) => f.text.includes('sealAuthorizedActionPackage'))
      .map((f) => f.rel)
      .filter((rel) => !rel.startsWith('packages/handoff-contracts/src/authorized-action-package/') && !SEAL_ALLOWED_OUTSIDE_CONTRACT.includes(rel));
    expect(offenders).toEqual([]);
  });

  it('Business Operations code never creates a package', () => {
    const boRoots = ['packages/business-operations-runtime/', 'packages/database/src/repositories/bo/', 'layers/business-operations/'];
    const offenders = production.filter((f) => boRoots.some((r) => f.rel.startsWith(r)) && /sealAuthorizedActionPackage|buildIntegrity/.test(f.text)).map((f) => f.rel);
    expect(offenders).toEqual([]);
  });

  it('the contract imports only itself (no database, I/O, ABA or BO code, no Node built-ins)', () => {
    const files = [...walk(CONTRACT_SRC)];
    expect(files.length).toBeGreaterThanOrEqual(6);
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      const specs = [...text.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
      for (const spec of specs) {
        expect(spec.startsWith('./') || spec.startsWith('../'), `${relative(PLATFORM_ROOT, file)} imports ${spec}`).toBe(true);
      }
      expect(/\brequire\(|\bprocess\.|\bfs\b|Date\.now\(|new Date\(\)/.test(text), `${relative(PLATFORM_ROOT, file)} must stay pure`).toBe(false);
    }
  });
});
