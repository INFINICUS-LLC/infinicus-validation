/**
 * CL-ACT-06F: owner-approved policy invariants for future shadow governance.
 * Pure specification, not an IAM grant, deployed flag, persistence writer,
 * audit attestation or permission to mutate learning/operations.
 */
export const CL_SHADOW_POLICY_V1 = Object.freeze({
  version: 'cl-shadow-policy/1',
  permission: 'cl:shadow:evaluate',
  issuerDomain: 'canonical-identity-aba',
  implicitAdminInheritance: false,
  humanApproverRequired: true,
  operatorApproverSeparationRequired: true,
  delegationAllowed: false,
  defaultEnabled: false,
  killSwitchOverridesApproval: true,
  auditOwnerDomain: 'continuous-learning',
  assignmentOwnerDomain: 'approved-business-action',
  automaticAuditDeletionAllowed: false,
  revokedOrStaleAuthorityDenied: true,
  learningPublicationAllowed: false,
  modelMutationAllowed: false,
  policyMutationAllowed: false,
  businessOperationsMutationAllowed: false,
} as const);

/** Deliberately outstanding: approving seven principles did not select implementations. */
export const CL_SHADOW_UNRESOLVED_DECISIONS = Object.freeze([
  'AUDIT_RETENTION_PERIOD_AND_LEGAL_DELETION',
  'CANONICAL_RECORD_ENCODING_AND_HASH_ANCHOR',
  'DATABASE_GRANTS_AND_COMPOSITE_SCOPE_AUTHORITY',
  'IDEMPOTENCY_AND_TRANSACTION_OWNERSHIP',
  'KILL_SWITCH_CUSTODIAN_AND_REVOCATION_CHANNEL',
] as const);

export type ShadowPolicyGate = Readonly<{
  specificationApproved: true;
  schemaMigrationAuthorized: false;
  liveShadowAuthorized: false;
  learningActivated: false;
  reasons: readonly string[];
}>;

/** Neither caller input nor a successful review may elevate this policy to runtime authority. */
export function shadowPolicyMigrationGate(): ShadowPolicyGate {
  return Object.freeze({
    specificationApproved: true,
    schemaMigrationAuthorized: false,
    liveShadowAuthorized: false,
    learningActivated: false,
    reasons: CL_SHADOW_UNRESOLVED_DECISIONS,
  });
}
