// Governance evidence verification boundary (P0-5/P0-6 preparation, Block B1; Block B survey rulings).
//
// A governance evidence reference `{kind, id}` is NOT proof. ABA must be able to ask, for each required governance dimension, whether
// the reference is an AUTHORITATIVE, scope-correct, current evaluation that PASSED for the modified parameters - and it must persist
// the verifier's answer, never a caller's assertion.
//
// The interface is the architecture boundary: it is OWNED here (shared contract) and IMPLEMENTED by the layer that owns the
// evaluation (the Business Operations inventory-policy evaluator, BoGovernanceEvidenceVerifier, registered at the API composition
// root). ABA depends only on this interface and never reads another layer's private tables. With no verifier registered ABA fails
// closed. This module is pure types.

import type { GovernanceDimension } from './types';

export interface GovernanceEvidenceRef {
  kind: string;
  id: string;
}

/** What the evidence is claimed to cover: the verifier binds the evaluation to these exact (modified) values. */
export interface GovernanceEvidenceSubject {
  actionId: string;
  actionType: { code: string; schemaVersion: string };
  target: { kind: string; id: string };
  finalParameters: Readonly<Record<string, unknown>>;
}

export interface GovernanceEvidenceRequest {
  tenantId: string;
  workspaceId: string;
  businessId: string;
  /** The authenticated actor on whose behalf ABA asks (never an authority input; the verifier needs a tenant context to read). */
  actorUserId: string;
  /**
   * The authoritative time (millisecond UTC) at which the approved-with-modifications decision became final, taken by ABA from
   * `approval_decisions.updated_at` (B2c ruling). Evidence evaluated before it does not cover the modification. Never caller-supplied.
   */
  modifiedAt: string;
  dimension: GovernanceDimension;
  evidenceRef: GovernanceEvidenceRef;
  subject: GovernanceEvidenceSubject;
}

export type GovernanceEvidenceVerdict =
  | {
      status: 'VERIFIED';
      dimension: GovernanceDimension;
      result: 'PASSED';
      /** Millisecond-precision UTC time at which the authoritative evaluation was made. */
      evaluatedAt: string;
      /** The reference the verifier actually verified; it must equal the requested reference. */
      evidenceRef: GovernanceEvidenceRef;
      /** The owning component that produced the evaluation (for audit). */
      authoritativeSource: { layer: string; component: string };
      /** Immutable version or record identity of the evaluation inside the owning component. */
      sourceVersion: string;
    }
  | { status: 'REFUSED'; reason: string };

export interface GovernanceEvidenceVerifier {
  /** A rejected promise or any non-VERIFIED answer means NOT proven: ABA refuses. */
  verify(request: GovernanceEvidenceRequest): Promise<GovernanceEvidenceVerdict>;
}
