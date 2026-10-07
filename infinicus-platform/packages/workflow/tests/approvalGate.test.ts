import { describe, expect, it } from 'vitest';
import { evaluateApprovalGate, type GateFacts } from '../src/approvalGate.js';

const NOW = new Date('2026-10-08T12:00:00Z');
const past = new Date('2026-10-08T11:59:59Z');
const future = new Date('2026-10-09T00:00:00Z');
const base: GateFacts = { isTimeSensitive: false, validUntil: null, twinSnapshotId: null };
const gate = (facts: Partial<GateFacts> | null, twin: { usable: boolean; newerPublishedExists: boolean } | null = null) =>
  evaluateApprovalGate({ facts: facts === null ? null : { ...base, ...facts }, now: NOW, twin });
const codes = (v: ReturnType<typeof gate>) => (v.allowed ? [] : v.codes);

describe('evaluateApprovalGate (persisted facts only; owner rulings Q1, Q3, Q4)', () => {
  it('FALSE with no valid_until is allowed', () => {
    expect(gate({}).allowed).toBe(true);
  });

  it('TRUE with a future valid_until is allowed', () => {
    expect(gate({ isTimeSensitive: true, validUntil: future }).allowed).toBe(true);
  });

  it('TRUE without valid_until is blocked', () => {
    expect(codes(gate({ isTimeSensitive: true }))).toEqual(['TIME_SENSITIVE_WITHOUT_VALIDITY']);
  });

  it('NULL / unknown time-sensitivity is blocked, never read as false', () => {
    expect(codes(gate({ isTimeSensitive: null }))).toEqual(['TIME_SENSITIVITY_UNKNOWN']);
    expect(codes(gate({ isTimeSensitive: null, validUntil: future }))).toEqual(['TIME_SENSITIVITY_UNKNOWN']);
  });

  it('an expired valid_until is enforced regardless of is_time_sensitive (false, true, or unknown)', () => {
    for (const isTimeSensitive of [false, true, null]) {
      expect(codes(gate({ isTimeSensitive, validUntil: past }))).toContain('EXPIRED');
    }
  });

  it('valid_until equal to now is expired (inclusive boundary)', () => {
    expect(codes(gate({ isTimeSensitive: true, validUntil: NOW }))).toContain('EXPIRED');
  });

  it('an invalid valid_until date is treated as expired (fail closed)', () => {
    expect(codes(gate({ isTimeSensitive: true, validUntil: new Date('nope') }))).toContain('EXPIRED');
  });

  it('a newer published Twin snapshot makes the recommendation STALE', () => {
    expect(codes(gate({ twinSnapshotId: 'snap' }, { usable: true, newerPublishedExists: true }))).toEqual(['STALE']);
  });

  it('a verified snapshot with no newer published one is fresh', () => {
    expect(gate({ twinSnapshotId: 'snap' }, { usable: true, newerPublishedExists: false }).allowed).toBe(true);
  });

  it('an unverifiable Twin reference (unknown, wrong business, never published, or lookup skipped) is blocked, not assumed fresh', () => {
    expect(codes(gate({ twinSnapshotId: 'snap' }, { usable: false, newerPublishedExists: false }))).toEqual(['TWIN_SNAPSHOT_UNVERIFIABLE']);
    expect(codes(gate({ twinSnapshotId: 'snap' }, null))).toEqual(['TWIN_SNAPSHOT_UNVERIFIABLE']);
  });

  it('no Twin reference means there is nothing to compare, so staleness is not asserted', () => {
    expect(gate({ twinSnapshotId: null }).allowed).toBe(true);
  });

  it('missing review facts are blocked', () => {
    expect(codes(gate(null))).toEqual(['REVIEW_FACTS_MISSING']);
  });

  it('reports every applicable code and always the RECALCULATE_DECISION recovery path', () => {
    const verdict = gate({ isTimeSensitive: null, validUntil: past, twinSnapshotId: 'snap' }, { usable: true, newerPublishedExists: true });
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) {
      expect(verdict.codes).toEqual(expect.arrayContaining(['EXPIRED', 'TIME_SENSITIVITY_UNKNOWN', 'STALE']));
      expect(verdict.recovery).toBe('RECALCULATE_DECISION');
      expect(verdict.reasons).toHaveLength(verdict.codes.length);
    }
  });
});
