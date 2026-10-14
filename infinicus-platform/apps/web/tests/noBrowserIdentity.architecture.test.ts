/**
 * J-2 guard: nothing under apps/web may take identity or scope from the URL, a form field or a request body. A future change that
 * re-introduces it fails here. Identity comes only from lib/context.ts (session -> membership -> permission).
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(__dirname, '..');
const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => {
  const p = join(dir, n);
  return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(n) ? [p] : [];
});
const files = [...walk(join(ROOT, 'app')), ...walk(join(ROOT, 'lib'))];
const read = (f: string) => readFileSync(f, 'utf8');

describe('apps/web takes no identity or scope from the browser (AC-3 J-2)', () => {
  it('has source files to check', () => expect(files.length).toBeGreaterThan(5));

  it.each(['userId', 'tenantId', 'workspaceId'])('no page, action or lib reads %s from searchParams, formData, headers or the body', (key) => {
    const offenders = files.filter((f) => new RegExp(
      `searchParams\\??\\.${key}\\b|searchParams\\[['"]${key}['"]\\]|formData\\.get\\(\\s*['"]${key}['"]|name=["']${key}["']|headers\\(\\)[^;]*${key}|\\.json\\(\\)[^;]*${key}`, 'i',
    ).test(read(f)));
    expect(offenders.map((f) => f.replace(ROOT, ''))).toEqual([]);
  });

  it('the old query-parameter context builders are gone', () => {
    for (const f of files) expect(read(f), f).not.toMatch(/contextFromSearchParams|ctxQuery|requireCtxFromForm/);
  });

  it('no page or action builds a TenantContext literal; only lib/context.ts does', () => {
    const offenders = files.filter((f) => !f.endsWith('lib/context.ts') && /tenantId\s*:\s*\S+\s*,\s*workspaceId\s*:/.test(read(f)));
    expect(offenders.map((f) => f.replace(ROOT, ''))).toEqual([]);
  });

  it('every page and server action resolves its context through requireServerContext (directly or via requireCtx) with a permission list', () => {
    const gated = files.filter((f) => /app\/businesses\/.*(page|actions)\.tsx?$/.test(f));
    expect(gated.length).toBe(4);
    for (const f of gated) expect(read(f), f).toMatch(/(requireServerContext|requireCtx)\(\s*[A-Z_]+PERMISSIONS\s*\)/);
  });

  it('the session cookie is read, never written or exposed to client script by this app', () => {
    const lib = read(join(ROOT, 'lib/serverContext.ts'));
    expect(lib).toMatch(/inf_session/);
    for (const f of files) expect(read(f), f).not.toMatch(/cookies\(\)\)?\.set|document\.cookie|localStorage/);
  });
});
