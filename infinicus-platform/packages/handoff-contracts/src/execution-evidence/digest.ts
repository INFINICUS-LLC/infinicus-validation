import { canonicalize, sha256HexOfText } from '../authorized-action-package/canonical';

/** SHA-256 over the canonical JSON of the body (everything except `integrity`). Tamper evidence only - never authorization. */
export function computeExecutionEvidenceDigest(body: unknown): string {
  return `sha256:${sha256HexOfText(canonicalize(body))}`;
}
