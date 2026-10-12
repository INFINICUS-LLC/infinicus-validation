import { AAP_CANONICAL_VERSION } from '../authorized-action-package/types';
import { computeExecutionEvidenceDigest } from './digest';
import { EXECUTION_EVIDENCE_DIGEST_ALGORITHM } from './types';
import type { ExecutionEvidenceBody, ExecutionEvidenceV1 } from './types';
import { validateExecutionEvidenceBody } from './validator';

export class ExecutionEvidenceInvalidError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`ExecutionEvidence is invalid: ${problems.join('; ')}`);
    this.name = 'ExecutionEvidenceInvalidError';
  }
}

/** Validates the body and attaches its integrity block. Throws {@link ExecutionEvidenceInvalidError} for anything the contract refuses. */
export function sealExecutionEvidence(body: ExecutionEvidenceBody): ExecutionEvidenceV1 {
  const problems = validateExecutionEvidenceBody(body);
  if (problems.length > 0) throw new ExecutionEvidenceInvalidError(problems);
  return { ...body, integrity: { algorithm: EXECUTION_EVIDENCE_DIGEST_ALGORITHM, canonicalVersion: AAP_CANONICAL_VERSION, digest: computeExecutionEvidenceDigest(body) } };
}
