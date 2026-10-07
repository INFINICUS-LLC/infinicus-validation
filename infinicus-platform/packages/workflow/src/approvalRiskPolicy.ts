/**
 * Action-risk approval policy (P0-2, locked ABA spec §8 and §27).
 *
 * Pure and database-free: maps an action's risk class to the minimum approver
 * authority tier that may approve it. "One click" is not universally
 * sufficient — a low-risk action may be approved by a lower tier than a
 * high-risk one.
 *
 * Rules enforced here (and nowhere else):
 *  - Rejecting is always safe: any active approver may reject.
 *  - Approving (or approving with modifications) needs a tier at or above the
 *    policy's minimum for the risk class.
 *  - An unknown / unclassified risk class is NEVER treated as low risk: it
 *    resolves to {@link UNCLASSIFIED_RISK_FALLBACK}. Risk is not accepted from
 *    API callers; until P0-3 stores `risk_class` on the data model, trusted
 *    server code may pass it and everything else is unclassified.
 *  - An unknown approver role has tier 0 and can only reject.
 */

export const RISK_CLASSES = ['low', 'medium', 'high', 'critical'] as const;
export type RiskClass = (typeof RISK_CLASSES)[number];

/** Risk class applied when none is supplied by trusted code. Fail closed. */
export const UNCLASSIFIED_RISK_FALLBACK: RiskClass = 'high';

export const APPROVER_ROLES = ['cashier', 'manager', 'business-owner'] as const;
export type ApproverRole = (typeof APPROVER_ROLES)[number];

/**
 * Authority tier by assignment role code. `approver` is the role written by
 * manual `aba:admin` grants before roles were selectable; it is treated as
 * manager tier, the middle tier, never owner.
 */
export const APPROVER_ROLE_TIER: Readonly<Record<string, number>> = Object.freeze({
  cashier: 1,
  manager: 2,
  approver: 2,
  'business-owner': 3,
});

export type ApprovalOutcome = 'approve' | 'approve_with_modifications' | 'reject';

export interface ApprovalRiskPolicy {
  /** Minimum tier required to approve, per risk class. */
  readonly minimumApproverTier: Readonly<Record<RiskClass, number>>;
}

export const DEFAULT_APPROVAL_RISK_POLICY: ApprovalRiskPolicy = Object.freeze({
  minimumApproverTier: Object.freeze({ low: 1, medium: 2, high: 3, critical: 3 }),
});

export interface ApprovalRequirement {
  readonly riskClass: RiskClass;
  /** True when the caller supplied no (valid) risk class and the fallback applied. */
  readonly unclassified: boolean;
  readonly requiredTier: number;
}

export type ApprovalPolicyVerdict =
  | { readonly allowed: true; readonly requirement: ApprovalRequirement }
  | { readonly allowed: false; readonly requirement: ApprovalRequirement; readonly reason: string };

export function isRiskClass(value: unknown): value is RiskClass {
  return typeof value === 'string' && (RISK_CLASSES as readonly string[]).includes(value);
}

export function approverTier(roleCode: string | null | undefined): number {
  if (typeof roleCode !== 'string') return 0;
  return Object.prototype.hasOwnProperty.call(APPROVER_ROLE_TIER, roleCode) ? APPROVER_ROLE_TIER[roleCode] : 0;
}

export function requirementFor(riskClass: unknown, policy: ApprovalRiskPolicy = DEFAULT_APPROVAL_RISK_POLICY): ApprovalRequirement {
  const classified = isRiskClass(riskClass);
  const resolved: RiskClass = classified ? riskClass : UNCLASSIFIED_RISK_FALLBACK;
  const required = policy.minimumApproverTier[resolved];
  // A malformed policy must not silently allow approval.
  const requiredTier = Number.isFinite(required) && required >= 1 ? required : Number.POSITIVE_INFINITY;
  return { riskClass: resolved, unclassified: !classified, requiredTier };
}

export function evaluateApproval(input: {
  riskClass?: unknown;
  roleCode: string | null | undefined;
  outcome: ApprovalOutcome;
  policy?: ApprovalRiskPolicy;
}): ApprovalPolicyVerdict {
  const requirement = requirementFor(input.riskClass, input.policy);
  if (input.outcome === 'reject') return { allowed: true, requirement };
  const tier = approverTier(input.roleCode);
  if (tier >= requirement.requiredTier) return { allowed: true, requirement };
  const basis = requirement.unclassified
    ? `action risk is unclassified and is treated as ${requirement.riskClass}`
    : `action risk is ${requirement.riskClass}`;
  return {
    allowed: false,
    requirement,
    reason: `${basis}; approver role "${String(input.roleCode)}" is below the required authority tier`,
  };
}
