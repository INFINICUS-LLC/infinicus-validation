import { describe, it, expect, vi } from 'vitest';
import { renderToString } from 'react-dom/server';
import {
  collectionRunsPath, collectionRunsSchema, DATA_LIMIT, dataSourcesPath, dataSourcesSchema, mayBeTruncated, runTime, sourceLabel, sourceNames, utcDateTime,
  type CollectionRunsResponse, type DataSourcesResponse,
} from '../lib/client/dataAcquisition';
import { DataView } from '../app/(client)/businesses/[businessId]/data/data-view';
import DataPage from '../app/(client)/businesses/[businessId]/data/page';
import { AuthContext, type AuthContextValue } from '../app/(client)/auth-provider';

vi.mock('../app/(client)/use-scoped-resource', () => ({ useScopedResource: () => ({ resource: { kind: 'loading' }, reload: vi.fn() }) }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: vi.fn() }), useParams: () => ({ businessId: '00000000-0000-4000-8000-000000000002' }) }));

const BUSINESS = '00000000-0000-4000-8000-000000000002';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const source = (n: number, over: Record<string, unknown> = {}) => ({
  id: id(100 + n), businessId: BUSINESS, name: `Source ${n}`, sourceCode: `SRC-${n}`, sourceType: 'manual_json', sensitivityLevel: 'internal', description: `About ${n}`,
  status: 'active', version: 1, createdAt: '2026-03-01T08:00:00.000Z', updatedAt: '2026-03-02T09:30:00.000Z', ...over,
});
const run = (n: number, over: Record<string, unknown> = {}) => ({
  id: id(200 + n), businessId: BUSINESS, dataSourceId: id(101), connectorId: null, collectionType: 'manual', state: 'completed', startedAt: '2026-03-10T08:00:00.000Z',
  completedAt: '2026-03-10T08:05:00.000Z', recordsReceived: 10, recordsAccepted: 8, recordsRejected: 2, errorCode: null, errorMessage: null, attemptNumber: 1,
  correlationId: id(300 + n), createdAt: '2026-03-10T08:00:00.000Z', updatedAt: '2026-03-10T08:05:00.000Z', ...over,
});
const sources = (rows: ReturnType<typeof source>[]): DataSourcesResponse => dataSourcesSchema.parse({ dataSources: rows });
const runs = (rows: ReturnType<typeof run>[]): CollectionRunsResponse => collectionRunsSchema.parse({ runs: rows });
const view = (s: Parameters<typeof DataView>[0]['sources'], r: Parameters<typeof DataView>[0]['runs']) => renderToString(<DataView sources={s} runs={r} />).replace(/<!-- -->/g, '');

describe('paths', () => {
  it('ask for this business, the most recent rows, and never read connectors', () => {
    expect(dataSourcesPath(BUSINESS)).toBe(`/v1/businesses/${BUSINESS}/data-sources?limit=100`);
    expect(collectionRunsPath(BUSINESS)).toBe(`/v1/businesses/${BUSINESS}/collection-runs?limit=100`);
    expect(dataSourcesPath('a/b?x=1')).toContain('/v1/businesses/a%2Fb%3Fx%3D1/data-sources');
    expect(collectionRunsPath('a/b?x=1')).toContain('/v1/businesses/a%2Fb%3Fx%3D1/collection-runs');
    expect(dataSourcesPath(BUSINESS)).not.toContain('connectors');
    expect(DATA_LIMIT).toBe(100);
  });
});

describe('helpers', () => {
  it('shows a UTC time, a plain word for no time, and unavailable for an unreadable one', () => {
    expect(utcDateTime('2026-03-10T08:30:00.000Z')).toBe('2026-03-10 08:30 UTC');
    expect(utcDateTime('nope')).toBe('unavailable');
    expect(runTime(null, 'not started')).toBe('not started');
    expect(runTime('2026-03-10T08:30:00.000Z', 'not started')).toBe('2026-03-10 08:30 UTC');
  });
  it('names a run\'s source, or a short id when the source is not in the list', () => {
    const names = sourceNames([{ id: id(101), name: 'Till export' }]);
    expect(sourceLabel(names, id(101))).toBe('Till export');
    expect(sourceLabel(names, id(999))).toBe('source 00000000');
  });
  it('treats a full page as possibly cut short', () => {
    expect(mayBeTruncated(DATA_LIMIT)).toBe(true);
    expect(mayBeTruncated(DATA_LIMIT - 1)).toBe(false);
  });
});

describe('response contracts', () => {
  it('reject the wrong shape: string or negative counts, a missing field', () => {
    expect(() => collectionRunsSchema.parse({ runs: [{ ...run(1), recordsReceived: '10' }] })).toThrow();
    expect(() => collectionRunsSchema.parse({ runs: [{ ...run(1), recordsRejected: -1 }] })).toThrow();
    expect(() => collectionRunsSchema.parse({ runs: [{ ...run(1), state: undefined }] })).toThrow();
    expect(() => dataSourcesSchema.parse({ dataSources: [{ ...source(1), name: 5 }] })).toThrow();
    expect(() => dataSourcesSchema.parse({})).toThrow();
  });
});

describe('DataView', () => {
  it('names itself read-only', () => {
    const out = view({ kind: 'loading' }, { kind: 'loading' });
    expect(out).toContain('does not import, register, retry or change anything');
    expect(out).toContain('aria-busy="true"');
  });
  it('shows an error for each list on its own, with the right role', () => {
    const out = view({ kind: 'error', message: 'You do not have permission to do this in this workspace.' }, { kind: 'ok', data: runs([run(1)]) });
    expect(out).toMatch(/role="alert"[^>]*>You do not have permission/);
    expect(out).toContain('Collection runs');
    expect(out).toContain('source 00000000');            // the run still shows, named by id, when the source list is unavailable
  });
  it('says so when there are no sources or runs', () => {
    const out = view({ kind: 'ok', data: sources([]) }, { kind: 'ok', data: runs([]) });
    expect(out).toContain('No data sources are registered for this business yet.');
    expect(out).toContain('No collection runs have happened for this business yet.');
  });
  it('shows each source as registered', () => {
    const out = view({ kind: 'ok', data: sources([source(1), source(2, { description: null, status: 'paused' })]) }, { kind: 'loading' });
    expect(out).toContain('Source 1'); expect(out).toContain('SRC-1'); expect(out).toContain('About 1'); expect(out).toContain('manual_json');
    expect(out).toContain('internal'); expect(out).toContain('paused'); expect(out).toContain('2026-03-01 08:00 UTC'); expect(out).toContain('2026-03-02 09:30 UTC');
  });
  it('shows each run with its source name and the counts exactly as recorded, never summed or rated', () => {
    const out = view({ kind: 'ok', data: sources([source(1)]) }, { kind: 'ok', data: runs([run(1), run(2, { recordsReceived: 0, recordsAccepted: 0, recordsRejected: 0, state: 'running', completedAt: null })]) });
    expect(out).toContain('Source 1');
    expect(out).toContain('2026-03-10 08:05 UTC');
    expect(out).toContain('not finished');
    expect(out).toContain('not added together');
    expect(out).not.toMatch(/Total (records|received)|success rate|acceptance rate|Quality/i);
  });
  it('shows a run error as text with its code, and "none" when there is no error', () => {
    const bad = view({ kind: 'loading' }, { kind: 'ok', data: runs([run(1, { state: 'failed', errorCode: 'SCHEMA_MISMATCH', errorMessage: '<script>alert(1)</script> bad column' }), run(2)]) });
    expect(bad).toContain('SCHEMA_MISMATCH');
    expect(bad).toContain('&lt;script&gt;alert(1)&lt;/script&gt; bad column');       // escaped, never run
    expect(bad).not.toContain('<script>alert(1)</script>');
    expect(bad).toContain('none');
  });
  it('says a run has not started when it has no start time', () => {
    expect(view({ kind: 'loading' }, { kind: 'ok', data: runs([run(1, { startedAt: null, completedAt: null, state: 'queued' })]) })).toContain('not started');
  });
  it('warns that a full page may be incomplete, and not otherwise', () => {
    const full = Array.from({ length: DATA_LIMIT }, (_, i) => run(i + 1));
    expect(view({ kind: 'loading' }, { kind: 'ok', data: runs(full) })).toContain('There may be more that are not listed here.');
    expect(view({ kind: 'loading' }, { kind: 'ok', data: runs(full.slice(1)) })).not.toContain('There may be more');
  });
  it('is read-only and shows no connector or secret: no control, no configuration reference, no token', () => {
    const out = view({ kind: 'ok', data: sources([source(1)]) }, { kind: 'ok', data: runs([run(1)]) });
    expect(out).not.toMatch(/<(button|form|input|select|textarea)\b/);
    expect(out).not.toMatch(/\b(Connector|configuration|token|secret)\b/i);       // the sentence that says the screen does not import, register or retry is the only mention of those verbs
    expect(out).not.toMatch(/\b(Import now|Register source|Retry run|Delete)\b/);
  });
});

describe('DataPage', () => {
  const scope = { tenantId: id(3), workspaceId: id(4) };
  const value: AuthContextValue = { state: { status: 'ready', email: 'staff@example.test', scope, memberships: [] }, api: null, signIn: async () => ({ ok: true }), signOut: async () => undefined, selectWorkspace: () => true, retry: () => undefined };
  it('shows nothing before the business address is known (server render), and nothing at all when signed out', () => {
    const ready = renderToString(<AuthContext.Provider value={value}><DataPage /></AuthContext.Provider>);
    expect(ready).toContain('business address is not valid');
    const out = renderToString(<AuthContext.Provider value={{ ...value, state: { status: 'signed-out' } }}><DataPage /></AuthContext.Provider>);
    expect(out).not.toContain('Data sources');
  });
});
