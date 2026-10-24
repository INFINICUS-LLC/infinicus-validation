/** CL-ACT-06J: explicit owner ratification gate. Pure, never an authorization token. */
export const CL_06J_DECISIONS = Object.freeze(['H-RET','H-HASH','H-AUTH','H-TXN','H-KILL'] as const);
export type CL06JDecision = (typeof CL_06J_DECISIONS)[number];
export interface SecurityDecisionRatification {
  readonly decision: CL06JDecision;
  readonly status: 'RATIFIED' | 'PENDING' | 'REJECTED';
  readonly specificationVersion: string;
  readonly approvalReference: string;
}
export interface SecurityRatificationReview {
  readonly allRatifiedForReview: boolean;
  readonly pending: readonly CL06JDecision[];
  readonly migrationAuthorized: false;
  readonly databasePermissionGranted: false;
  readonly productionEnabled: false;
  readonly learningActivated: false;
}
export function reviewSecurityRatification(records: readonly SecurityDecisionRatification[]): SecurityRatificationReview {
  const pending: CL06JDecision[] = [];
  for (const decision of CL_06J_DECISIONS) {
    const matches = Array.isArray(records) ? records.filter(r => r?.decision === decision) : [];
    if (matches.length !== 1 || matches[0].status !== 'RATIFIED' ||
        typeof matches[0].specificationVersion !== 'string' || matches[0].specificationVersion.trim() === '' ||
        typeof matches[0].approvalReference !== 'string' || matches[0].approvalReference.trim() === '') {
      pending.push(decision);
    }
  }
  return Object.freeze({
    allRatifiedForReview: pending.length === 0,
    pending: Object.freeze(pending),
    migrationAuthorized: false, databasePermissionGranted: false,
    productionEnabled: false, learningActivated: false,
  });
}
