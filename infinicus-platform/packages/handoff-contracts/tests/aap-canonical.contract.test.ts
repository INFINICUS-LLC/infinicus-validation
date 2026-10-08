import { describe, expect, it } from 'vitest';
import { canonicalize, CanonicalizationError, computePackageDigest, digestCoveredContent, isWellFormedDigest } from '../src';
import { approvedBody, clone, modifiedBody, na, val, ID } from './aap-fixtures';

describe('aap-canonical/1', () => {
  it('is deterministic', () => {
    const body = approvedBody();
    expect(canonicalize(body)).toBe(canonicalize(clone(body)));
    expect(computePackageDigest(body)).toBe(computePackageDigest(clone(body)));
  });

  it('is independent of object field order at every depth', () => {
    const a = { b: 1, a: { y: [1, { q: 1, p: 2 }], x: 'v' } };
    const b = { a: { x: 'v', y: [1, { p: 2, q: 1 }] }, b: 1 };
    expect(canonicalize(a)).toBe(canonicalize(b));
    const body = approvedBody();
    const shuffled = Object.fromEntries(Object.entries(body).reverse()) as unknown as typeof body;
    expect(computePackageDigest(shuffled)).toBe(computePackageDigest(body));
  });

  it('preserves array order (order is meaningful)', () => {
    expect(canonicalize([1, 2])).not.toBe(canonicalize([2, 1]));
  });

  it('serializes primitives in the specified form', () => {
    expect(canonicalize({ n: 1, f: 1.5, z: -0, small: 1e-7, s: 'a"b\\c\né', t: true, f2: false, nul: null }))
      .toBe('{"f":1.5,"f2":false,"n":1,"nul":null,"s":"a\\"b\\\\c\\né","small":1e-7,"t":true,"z":0}');
  });

  it('sorts keys by UTF-16 code unit order, not locale', () => {
    expect(canonicalize({ b: 1, B: 2, a: 3, _: 4, 'é': 5 })).toBe('{"B":2,"_":4,"a":3,"b":1,"é":5}');
  });

  it.each([
    ['undefined value', { a: undefined }],
    ['NaN', { a: Number.NaN }],
    ['Infinity', { a: Number.POSITIVE_INFINITY }],
    ['bigint', { a: 1n }],
    ['function', { a: () => 1 }],
    ['symbol', { a: Symbol('x') }],
    ['Date', { a: new Date(0) }],
    ['Map', { a: new Map() }],
    ['class instance', { a: new (class Foo { x = 1; })() }],
    ['unsafe integer', { a: 2 ** 53 }],
    ['lone high surrogate', { a: '\ud800' }],
    ['lone low surrogate value', { a: '\udc00x' }],
    ['lone surrogate in a key', { '\ud800': 1 }],
    ['sparse array', { a: [1, , 3] }],
  ])('rejects %s instead of dropping or coercing it', (_name, value) => {
    expect(() => canonicalize(value)).toThrow(CanonicalizationError);
  });

  it('rejects cyclic structures and excessive nesting', () => {
    const cyc: Record<string, unknown> = {};
    cyc.self = cyc;
    expect(() => canonicalize(cyc)).toThrow(/cyclic/);
    let deep: unknown = 1;
    for (let i = 0; i < 40; i++) deep = { d: deep };
    expect(() => canonicalize(deep)).toThrow(/nesting/);
  });

  it('accepts well-formed surrogate pairs', () => {
    expect(canonicalize({ a: '🚀' })).toBe('{"a":"🚀"}');
  });
});

describe('package integrity digest (tamper evidence only)', () => {
  const digest = (b: ReturnType<typeof approvedBody>) => computePackageDigest(b);

  it('has the sha256:<64 hex> form', () => {
    expect(isWellFormedDigest(digest(approvedBody()))).toBe(true);
    expect(isWellFormedDigest('sha256:ABC')).toBe(false);
    expect(isWellFormedDigest(`sha256:${'a'.repeat(63)}`)).toBe(false);
    expect(isWellFormedDigest(`md5:${'a'.repeat(32)}`)).toBe(false);
    expect(isWellFormedDigest(undefined)).toBe(false);
  });

  it('covers everything except the integrity block', () => {
    const body = approvedBody();
    const withIntegrity = { ...body, integrity: { canonicalVersion: 'aap-canonical/1', algorithm: 'sha256', digest: 'sha256:' + '0'.repeat(64) } } as any;
    expect(digest(withIntegrity)).toBe(digest(body));
    expect(digestCoveredContent(withIntegrity)).toEqual(body);
  });

  it('changes when a parameter changes', () => {
    const b = approvedBody();
    const base = digest(b);
    (b.action.parameters as Record<string, unknown>).newPrice = '10.01';
    expect(digest(b)).not.toBe(base);
  });

  it('changes when the authorization lineage changes', () => {
    const base = digest(approvedBody());
    for (const mutate of [
      (b: any) => { b.authorization.approver.userId = ID.owner; },
      (b: any) => { b.authorization.approver.assignmentVersionId = ID.assignment; },
      (b: any) => { b.authorization.authorityProvenance.scopeId = ID.owner; },
      (b: any) => { b.authorization.permissionUsed = 'aba:admin'; },
      (b: any) => { b.authorization.risk.riskClass = 'low'; },
      (b: any) => { b.lineage.decision.decisionVersionId = ID.decision; },
      (b: any) => { b.trace.approvalAuditEventId = ID.causation; },
    ]) {
      const b: any = approvedBody();
      mutate(b);
      expect(digest(b)).not.toBe(base);
    }
  });

  it('changes when the scope changes', () => {
    const base = digest(approvedBody());
    for (const key of ['tenantId', 'workspaceId', 'businessId'] as const) {
      const b = approvedBody();
      b.scope[key] = ID.otherTenant;
      expect(digest(b)).not.toBe(base);
    }
  });

  it('changes when an applicability state changes (VALUE <-> NOT_APPLICABLE) and when the governed reason changes', () => {
    const base = digest(approvedBody());
    const b1: any = approvedBody();
    b1.action.budget = val({ amount: '0', currency: 'USD' });
    expect(digest(b1)).not.toBe(base);
    const b2: any = approvedBody();
    b2.action.budget = na('NO_SPEND', 'different statement');
    expect(digest(b2)).not.toBe(base);
    const b3: any = approvedBody();
    b3.lineage.simulationRunId = val(ID.simulation);
    expect(digest(b3)).not.toBe(base);
  });

  it('changes when the modification delta changes', () => {
    const base = digest(modifiedBody());
    const b: any = modifiedBody();
    b.lineage.modification.value.reason = 'Another reason';
    expect(digest(b)).not.toBe(base);
  });

  it('is sensitive to EVERY leaf of the package (nothing execution- or authorization-relevant is uncovered)', () => {
    const base = approvedBody();
    const baseDigest = digest(base);
    const leaves: Array<Array<string | number>> = [];
    const walk = (v: unknown, path: Array<string | number>): void => {
      if (Array.isArray(v)) v.forEach((x, i) => walk(x, [...path, i]));
      else if (v !== null && typeof v === 'object') Object.entries(v).forEach(([k, x]) => walk(x, [...path, k]));
      else leaves.push(path);
    };
    walk(base, []);
    expect(leaves.length).toBeGreaterThan(80);
    for (const path of leaves) {
      const b: any = approvedBody();
      let parent = b;
      for (const p of path.slice(0, -1)) parent = parent[p];
      const key = path[path.length - 1];
      const current = parent[key];
      parent[key] = typeof current === 'string' ? `${current}x` : typeof current === 'number' ? current + 1 : typeof current === 'boolean' ? !current : 'changed';
      expect(digest(b), `leaf ${path.join('.')} must be covered by the digest`).not.toBe(baseDigest);
    }
  });
});
