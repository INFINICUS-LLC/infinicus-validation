import { describe, expect, it } from 'vitest';
import { CL_06J_DECISIONS, reviewSecurityRatification } from '../src/ShadowSecurityRatificationGate.js';

describe('CL-ACT-06J security ratification gate', () => {
  it('defaults to five pending decisions and denies migration', () => {
    const result = reviewSecurityRatification([]);
    expect(result.pending).toEqual(CL_06J_DECISIONS);
    expect(result.allRatifiedForReview).toBe(false);
    expect(result.migrationAuthorized).toBe(false);
    expect(result.databasePermissionGranted).toBe(false);
    expect(result.productionEnabled).toBe(false);
    expect(result.learningActivated).toBe(false);
  });

  it('does not mistake incomplete, rejected, duplicate or unreferenced ratifications for approval', () => {
    const full = CL_06J_DECISIONS.map(decision => ({
      decision, status: 'RATIFIED' as const, specificationVersion: 'v1', approvalReference: 'reviewed-record',
    }));
    for (const records of [
      full.slice(0, 4),
      full.map(r => r.decision === 'H-HASH' ? { ...r, status: 'REJECTED' as const } : r),
      [...full, full[0]],
      full.map(r => r.decision === 'H-KILL' ? { ...r, approvalReference: '' } : r),
    ]) {
      const result = reviewSecurityRatification(records);
      expect(result.allRatifiedForReview).toBe(false);
      expect(result.pending.length).toBeGreaterThan(0);
      expect(result.migrationAuthorized).toBe(false);
    }
  });

  it('never allows unverified caller-supplied approvals to authorize migration or learning', () => {
    const claimed = CL_06J_DECISIONS.map(decision => ({
      decision, status: 'RATIFIED' as const, specificationVersion: 'v1', approvalReference: 'self-reported',
    }));
    const result = reviewSecurityRatification(claimed);
    expect(result.allRatifiedForReview).toBe(true);
    expect(result.migrationAuthorized).toBe(false);
    expect(result.databasePermissionGranted).toBe(false);
    expect(result.productionEnabled).toBe(false);
    expect(result.learningActivated).toBe(false);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.pending)).toBe(true);
  });
});
