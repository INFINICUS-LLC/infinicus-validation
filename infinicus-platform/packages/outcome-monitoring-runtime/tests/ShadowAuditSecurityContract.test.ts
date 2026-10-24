import { describe, expect, it } from 'vitest';
import { SHADOW_AUDIT_SECURITY_CONTROLS, assessShadowAuditSecurityEvidence } from '../src/ShadowAuditSecurityContract.js';

describe('CL-ACT-06G audit security requirements', () => {
  it('defaults to refusal when no disposable DB or authority evidence exists', () => {
    const result = assessShadowAuditSecurityEvidence([]);
    expect(result.acceptanceReady).toBe(false);
    expect(result.migrationAuthorized).toBe(false);
    expect(result.productionEnabled).toBe(false);
    expect(result.learningActivated).toBe(false);
    expect(result.missingOrUnapproved).toContain('FORCED_RLS_WITH_LEAST_PRIVILEGE');
    expect(result.missingOrUnapproved).toContain('AUDIT_RETENTION_PERIOD_AND_LEGAL_DELETION');
  });
  it('never trusts claimed tests, even if every security control is declared passed', () => {
    const claimed = SHADOW_AUDIT_SECURITY_CONTROLS.map(control => ({
      control, verified: true, disposableDatabase: true, evidenceReference: 'self-reported-only',
    }));
    const result = assessShadowAuditSecurityEvidence(claimed);
    expect(result.acceptanceReady).toBe(false);
    expect(result.migrationAuthorized).toBe(false);
    expect(result.productionEnabled).toBe(false);
    expect(result.learningActivated).toBe(false);
    expect(result.missingOrUnapproved).toContain('DATABASE_GRANTS_AND_COMPOSITE_SCOPE_AUTHORITY');
  });
  it('does not accept missing evidence references or skipped/non-disposable checks', () => {
    const evidence = [
      { control: 'FORCED_RLS_WITH_LEAST_PRIVILEGE' as const, verified: true, disposableDatabase: false, evidenceReference: 'test' },
      { control: 'KILL_SWITCH_FIRST' as const, verified: false, disposableDatabase: true, evidenceReference: 'test' },
      { control: 'ATOMIC_AUDIT_AND_CONTROL_TRANSITION' as const, verified: true, disposableDatabase: true, evidenceReference: '' },
    ];
    const result = assessShadowAuditSecurityEvidence(evidence);
    expect(result.missingOrUnapproved).toContain('FORCED_RLS_WITH_LEAST_PRIVILEGE');
    expect(result.missingOrUnapproved).toContain('KILL_SWITCH_FIRST');
    expect(result.missingOrUnapproved).toContain('ATOMIC_AUDIT_AND_CONTROL_TRANSITION');
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.missingOrUnapproved)).toBe(true);
  });
});
