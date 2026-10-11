// The exact subject a governance evaluation is bound to (P0-5/P0-6 preparation, Block B2a).
//
// An evaluation produced for one parameter set must never verify another. The evaluator (writer) and the verifier (reader) both
// derive the SAME digest from the SAME canonical subject with this helper, so the binding cannot drift between layers. The subject is
// the action type, the target and the FINAL (modified) parameters; the action id, scope, times and users are deliberately excluded
// because they are not what the evaluation is about. Tamper evidence only; it is not an authorization.
//
// Pure: no database, no I/O, no clock.

import { canonicalize, sha256HexOfText } from './canonical';
import type { JsonValue } from './types';

export const GOVERNANCE_SUBJECT_CANONICAL_VERSION = 'governance-subject/1';

export interface GovernanceSubject {
  actionType: { code: string; schemaVersion: string };
  target: { kind: string; id: string };
  finalParameters: { [key: string]: JsonValue };
}

/** The four members that define the subject, copied explicitly so extra properties on the input can never change the digest. */
export function canonicalGovernanceSubject(subject: GovernanceSubject): GovernanceSubject {
  return {
    actionType: { code: subject.actionType.code, schemaVersion: subject.actionType.schemaVersion },
    target: { kind: subject.target.kind, id: subject.target.id },
    finalParameters: subject.finalParameters,
  };
}

/** `sha256:<64 lowercase hex>` over the versioned canonical form of the subject. */
export function computeGovernanceSubjectDigest(subject: GovernanceSubject): string {
  return `sha256:${sha256HexOfText(`${GOVERNANCE_SUBJECT_CANONICAL_VERSION}\n${canonicalize(canonicalGovernanceSubject(subject))}`)}`;
}
