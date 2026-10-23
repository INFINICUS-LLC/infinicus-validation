import { describe, it, expect, vi } from 'vitest';
import { renderToString } from 'react-dom/server';
import { formatAllocation, mayBeTruncated, utcDate, validityText, WORKFORCE_LIMIT, workforcePath, workforceSchema, type WorkforceResponse } from '../lib/client/workforce';
import { StaffView } from '../app/(client)/businesses/[businessId]/staff/staff-view';
import StaffPage from '../app/(client)/businesses/[businessId]/staff/page';
import { AuthContext, type AuthContextValue } from '../app/(client)/auth-provider';

vi.mock('../app/(client)/use-scoped-resource', () => ({ useScopedResource: () => ({ resource: { kind: 'loading' }, reload: vi.fn() }) }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: vi.fn() }), useParams: () => ({ businessId: '00000000-0000-4000-8000-000000000002' }) }));

const BUSINESS = '00000000-0000-4000-8000-000000000002';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const row = (n: number, over: Record<string, unknown> = {}) => ({
  id: id(100 + n), employeeId: id(200 + n), employeeName: `Person ${n}`, employeeCode: `EMP-${n}`, assignmentCode: `ASG-${n}`, assignmentType: 'primary',
  title: `Cashier ${n}`, allocationPct: 50, validFrom: '2026-03-01T00:00:00.000Z', validTo: '2026-09-30T00:00:00.000Z', status: 'active', ...over,
});
const data = (rows: ReturnType<typeof row>[]): WorkforceResponse => workforceSchema.parse({ assignments: rows });
const view = (resource: Parameters<typeof StaffView>[0]['resource']) => renderToString(<StaffView resource={resource} />).replace(/<!-- -->/g, '');

describe('workforcePath', () => {
  it('asks for the largest page for exactly this business and encodes the id', () => {
    expect(workforcePath(BUSINESS)).toBe(`/v1/businesses/${BUSINESS}/operations/workforce?limit=100`);
    expect(workforcePath('a/b?x=1')).toContain('/v1/businesses/a%2Fb%3Fx%3D1/operations/workforce');
    expect(WORKFORCE_LIMIT).toBe(100);
  });
});

describe('display helpers', () => {
  it.each([[50, '50%'], [12.5, '12.5%'], [100, '100%'], [0, '0%'], [33.333, '33.33%']])('%d is shown as %s', (n, text) => { expect(formatAllocation(n)).toBe(text); });
  it('fails closed on an allocation that is not a finite number', () => {
    expect(formatAllocation(Number.NaN)).toBeNull();
    expect(formatAllocation(Number.POSITIVE_INFINITY)).toBeNull();
  });
  it('shows UTC dates, an open-ended validity in words, and an unreadable date as unavailable', () => {
    expect(utcDate('2026-03-01T23:30:00.000Z')).toBe('2026-03-01');
    expect(utcDate('nope')).toBe('unavailable');
    expect(validityText('2026-03-01T00:00:00.000Z', '2026-09-30T00:00:00.000Z')).toBe('2026-03-01 to 2026-09-30');
    expect(validityText('2026-03-01T00:00:00.000Z', null)).toBe('from 2026-03-01, no end date');
  });
  it('treats a full page as possibly cut short', () => {
    expect(mayBeTruncated(WORKFORCE_LIMIT)).toBe(true);
    expect(mayBeTruncated(WORKFORCE_LIMIT - 1)).toBe(false);
  });
});

describe('response contract', () => {
  it('rejects the wrong shape: string allocation, missing field, non-finite allocation', () => {
    expect(() => workforceSchema.parse({ assignments: [{ ...row(1), allocationPct: '50' }] })).toThrow();
    expect(() => workforceSchema.parse({ assignments: [{ ...row(1), employeeName: undefined }] })).toThrow();
    expect(() => workforceSchema.parse({ assignments: [{ ...row(1), allocationPct: Number.NaN }] })).toThrow();
    expect(() => workforceSchema.parse({})).toThrow();
  });
});

describe('StaffView', () => {
  it('shows loading and error states with the right roles', () => {
    expect(view({ kind: 'loading' })).toContain('aria-busy="true"');
    expect(view({ kind: 'loading' })).toContain('role="status"');
    expect(view({ kind: 'error', message: 'Could not load.' })).toMatch(/role="alert"[^>]*>Could not load\./);
  });
  it('says so when there are no assignments', () => {
    expect(view({ kind: 'ok', data: data([]) })).toContain('No staff assignments are recorded for this business yet.');
  });
  it('shows each assignment exactly as returned, with the server status and validity', () => {
    const out = view({ kind: 'ok', data: data([row(1), row(2, { allocationPct: 12.5, validTo: null, status: 'ended', assignmentType: 'secondary' })]) });
    expect(out).toContain('Person 1'); expect(out).toContain('EMP-1'); expect(out).toContain('Cashier 1'); expect(out).toContain('ASG-1');
    expect(out).toContain('50%'); expect(out).toContain('12.5%');
    expect(out).toContain('2026-03-01 to 2026-09-30'); expect(out).toContain('from 2026-03-01, no end date');
    expect(out).toContain('active'); expect(out).toContain('ended'); expect(out).toContain('secondary');
    expect(out).toContain('is not added together');
  });
  it('shows an allocation it cannot display as unavailable rather than a guess', () => {
    const bad = data([row(1)]);
    (bad.assignments[0] as { allocationPct: number }).allocationPct = Number.NaN;
    expect(view({ kind: 'ok', data: bad })).toContain('unavailable');
  });
  it('warns that a full page may be incomplete, and not otherwise', () => {
    const full = Array.from({ length: WORKFORCE_LIMIT }, (_, i) => row(i + 1));
    expect(view({ kind: 'ok', data: data(full) })).toContain('There may be more that are not listed here.');
    expect(view({ kind: 'ok', data: data(full.slice(1)) })).not.toContain('There may be more');
  });
  it('is read-only: no button, form, input or select exists, and nothing offers to hire, assign or change', () => {
    const out = view({ kind: 'ok', data: data([row(1)]) });
    expect(out).not.toMatch(/<(button|form|input|select|textarea)\b/);
    expect(out).not.toMatch(/\b(Hire|Fire|Assign now|Edit|Save|Delete|New assignment)\b/);
  });
});

describe('StaffPage', () => {
  const scope = { tenantId: id(3), workspaceId: id(4) };
  const value: AuthContextValue = { state: { status: 'ready', email: 'staff@example.test', scope, memberships: [] }, api: null, signIn: async () => ({ ok: true }), signOut: async () => undefined, selectWorkspace: () => true, retry: () => undefined };
  it('shows nothing before the business address is known (server render), and nothing at all when signed out', () => {
    const ready = renderToString(<AuthContext.Provider value={value}><StaffPage /></AuthContext.Provider>);
    expect(ready).toContain('business address is not valid');
    const out = renderToString(<AuthContext.Provider value={{ ...value, state: { status: 'signed-out' } }}><StaffPage /></AuthContext.Provider>);
    expect(out).not.toContain('Assignments');
  });
});
