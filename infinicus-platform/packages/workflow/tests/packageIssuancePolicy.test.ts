import { describe, expect, it } from 'vitest';
import { ISSUABLE_AUTOMATION_LEVELS, NOT_APPLICABLE_CODE_PATTERN, authoritativeInputsKey, collectNotApplicableCodes, notApplicableCodeProblems } from '../src/packageIssuancePolicy.js';

const NA = (code: unknown) => ({ state: 'NOT_APPLICABLE', reason: { code, statement: 's' } });

describe('NOT_APPLICABLE reason codes (owner ruling 4)', () => {
  it('accepts UPPER_SNAKE_CASE', () => {
    for (const code of ['NOT_SIMULATION_BACKED', 'A', 'NO_WINDOW_2', 'PLAIN_APPROVAL']) expect(NOT_APPLICABLE_CODE_PATTERN.test(code)).toBe(true);
  });
  it.each(['not_simulation_backed', 'Not_Simulation', '1_NUMERIC', '_LEADING', 'HAS-DASH', 'HAS SPACE', '', 'TRAILING\n'])('rejects %j without normalizing it', (code) => {
    expect(notApplicableCodeProblems({ lineage: { modification: NA(code) } })).toHaveLength(1);
  });
  it('rejects a non-string or missing code', () => {
    expect(notApplicableCodeProblems({ a: NA(undefined) })).toHaveLength(1);
    expect(notApplicableCodeProblems({ a: NA(7) })).toHaveLength(1);
    expect(notApplicableCodeProblems({ a: { state: 'NOT_APPLICABLE' } })).toHaveLength(1);
  });
  it('finds codes nested in arrays and objects, and ignores VALUE fields', () => {
    const doc = { a: [{ b: NA('X') }, { c: NA('y') }], d: { state: 'VALUE', value: NA('z') } };
    expect(collectNotApplicableCodes(doc).map((c) => c.path)).toEqual(['$.a[0].b.reason.code', '$.a[1].c.reason.code', '$.d.value.reason.code']);
    expect(notApplicableCodeProblems(doc)).toHaveLength(2);
  });
});

describe('only Level 2 is issuable', () => {
  it('lists exactly [2]', () => expect([...ISSUABLE_AUTOMATION_LEVELS]).toEqual([2]));
});

describe('idempotency key', () => {
  const base = () => ({
    contractVersion: 'aap/1', identity: { packageId: 'p', packageVersion: 1, supersedes: null }, issuance: { issuedAt: '2026-01-01T00:00:00.000Z', issuerComponent: 'x' },
    action: { parameters: { a: 1, b: 2 } }, validity: { freshness: { assessedAt: '2026-01-01T00:00:00.000Z', twin: 'FRESH' } },
    trace: { correlationId: 'c1', causationId: 'k' }, integrity: { digest: 'sha256:aa' },
  });
  it('ignores version, supersession, issue time, assessment time, correlation id and the digest', () => {
    const b: any = base(); // eslint-disable-line @typescript-eslint/no-explicit-any
    b.identity = { packageId: 'p', packageVersion: 7, supersedes: { packageId: 'p', packageVersion: 6 } };
    b.issuance.issuedAt = '2027-01-01T00:00:00.000Z';
    b.validity.freshness.assessedAt = '2027-01-01T00:00:00.000Z';
    b.trace.correlationId = 'c2';
    b.integrity.digest = 'sha256:bb';
    expect(authoritativeInputsKey(b)).toBe(authoritativeInputsKey(base()));
  });
  it('is key-order independent', () => {
    const a: any = base(); // eslint-disable-line @typescript-eslint/no-explicit-any
    a.action = { parameters: { b: 2, a: 1 } };
    expect(authoritativeInputsKey(a)).toBe(authoritativeInputsKey(base()));
  });
  it.each([
    ['a parameter', (d: any) => { d.action.parameters.a = 2; }],
    ['the causing audit event', (d: any) => { d.trace.causationId = 'other'; }],
    ['the package identity', (d: any) => { d.identity.packageId = 'q'; }],
    ['the freshness verdict', (d: any) => { d.validity.freshness.twin = 'NOT_APPLICABLE'; }],
  ])('differs when %s changes', (_n, mutate) => {
    const d: any = base(); // eslint-disable-line @typescript-eslint/no-explicit-any
    mutate(d);
    expect(authoritativeInputsKey(d)).not.toBe(authoritativeInputsKey(base()));
  });
});
