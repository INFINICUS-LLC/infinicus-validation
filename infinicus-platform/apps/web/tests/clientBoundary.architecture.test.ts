/**
 * NA-04 guard for the browser-side client (lib/client and app/(client)): it is code that runs in the visitor's browser, so it must hold no server
 * dependency, no secret, no storage of the backend session, and no ambient credentials. These are structural checks over the source text.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(__dirname, '..');
const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => {
  const p = join(dir, n);
  return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(n) ? [p] : [];
});
const files = [...walk(join(ROOT, 'lib/client')), ...walk(join(ROOT, 'app/(client)'))];
const read = (f: string) => readFileSync(f, 'utf8');
const rel = (f: string) => f.replace(ROOT, '');
const code = (f: string) => read(f).split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');   // drop comment lines

describe('browser-side client boundary (NA-04)', () => {
  it('has source files to check', () => expect(files.length).toBeGreaterThan(10));

  it('imports no server package, Node-only module or server-only Next API', () => {
    const banned = /from ['"](@infinicus\/(database|workflow|authentication|authorization|configuration)|pg|node:[a-z/]+|next\/headers|server-only)['"]/;
    expect(files.filter((f) => banned.test(code(f))).map(rel)).toEqual([]);
  });

  it('uses no cookie access and no persistent browser storage; only the tab-scoped workspace selection is stored', () => {
    expect(files.filter((f) => /document\.cookie|cookies\(|indexedDB|localStorage/.test(code(f))).map(rel)).toEqual([]);
    const writers = files.filter((f) => /\.setItem\(/.test(code(f))).map(rel);
    expect(writers).toEqual(['/lib/client/workspaces.ts']);
    const ws = code(join(ROOT, 'lib/client/workspaces.ts'));
    expect(ws.match(/\.setItem\(/g)).toHaveLength(1);
    expect(ws).toContain('.setItem(SCOPE_STORAGE_KEY, JSON.stringify(scope))');       // the selection (two ids) is the only thing ever stored
    expect(files.filter((f) => /sessionStorage/.test(code(f))).map(rel)).toEqual(['/app/(client)/auth-provider.tsx']);
  });

  it('the backend session token is referenced only inside the session manager', () => {
    const offenders = files.filter((f) => !f.endsWith('backendSession.ts') && /rawSessionToken/.test(code(f)));
    expect(offenders.map(rel)).toEqual([]);
  });

  it('reads process.env only in config.ts, and never a secret-named variable', () => {
    expect(files.filter((f) => !f.endsWith('lib/client/config.ts') && /process\.env/.test(code(f))).map(rel)).toEqual([]);
    // config.ts is the detector that REFUSES secret keys, so it necessarily names them; every other file must not.
    for (const f of files.filter((x) => !x.endsWith('lib/client/config.ts'))) expect(code(f), rel(f)).not.toMatch(/service_role|SERVICE_ROLE|sb_secret|SUPABASE_SERVICE|DATABASE_URL/);
    const publicNames = [...code(join(ROOT, 'lib/client/config.ts')).matchAll(/process\.env\.([A-Z0-9_]+)/g)].map((m) => m[1]);
    expect(publicNames.sort()).toEqual(['NEXT_PUBLIC_API_BASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'NEXT_PUBLIC_SUPABASE_URL']);
  });

  it('every network call omits ambient credentials and no URL is hard-coded', () => {
    for (const f of ['lib/client/apiClient.ts', 'lib/client/backendSession.ts']) expect(code(join(ROOT, f)), f).toContain("credentials: 'omit'");
    expect(files.filter((f) => /['"`]https?:\/\//.test(code(f))).map(rel)).toEqual([]);
  });

  it('has no raw HTML injection, eval, or console logging of values', () => {
    expect(files.filter((f) => /dangerouslySetInnerHTML|\beval\(|new Function\(|console\.(log|debug|info)/.test(code(f))).map(rel)).toEqual([]);
  });

  it('sends tenant/workspace only as the two claim headers and takes them only from a selected scope', () => {
    const api = code(join(ROOT, 'lib/client/apiClient.ts'));
    expect([...api.matchAll(/headers\['(x-[a-z-]+)'\]/g)].map((m) => m[1]).sort()).toEqual(['x-tenant-id', 'x-workspace-id']);
    expect(files.filter((f) => /searchParams|useSearchParams|location\.(search|hash)/.test(code(f))).map(rel)).toEqual([]);
  });
});
