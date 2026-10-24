# CL-ACT-06N — Owner-ratified development security policies (2026-10-24)

**Decision status: APPROVED FOR DEVELOPMENT SPECIFICATION ONLY.**
**Migration authorization: DENIED. Production activation: DENIED.**
Baseline main `5646fec8f80405da9ae5209a2ccbf6eee4b7e8a9` (PR #305 merged).

## Owner approval evidence

On 2026-10-24, the owner explicitly submitted: `H-RET: approve`, `H-HASH: approve`, `H-AUTH: approve`, `H-TXN: approve`, `H-KILL: approve`, `Amendments and details: None`. The owner expressly limited approval to development specifications: **do not grant permissions, execute database migrations, or activate Continuous Learning**. The approved content is the five proposals displayed in the preceding owner-decision response, not unspecified parameters inferred afterward.

The prior seven baseline governance principles remain mandatory: explicit identity/ABA-issued `cl:shadow:evaluate`; independent human approver/no delegation; default OFF/kill-switch priority; separate CL audit and ABA assignment ownership; no automatic audit deletion before lawful approval; revoked/stale authority fail-closed; advisory-only shadow with no learning/model/policy/BO mutation.

## Approved specification values

### H-RET — approved design direction
- **Proposed retention target:** 24 months for routine audit metadata, **subject to applicable legal/privacy review**. This is not a legally ratified retention schedule or deletion authorization.
- Minimal records only: scoped IDs, event types/timestamps, SHA-256 digests and bounded refusal codes. Exclude credentials, raw customer records and payment information.
- No automatic deletion before an applicable retention schedule is legally approved. Hold exceptions and erasure requests require controlled privacy review.
- Proposed controller: INFINICUS LLC, conditional on jurisdiction and legal-controller confirmation.

### H-HASH — approved design direction
- Versioned, domain-separated SHA-256 event hashing using canonical JSON serialization (RFC 8785 / JCS proposed).
- Server/trusted-writer generated digest, deterministic scoped predecessor chain and sequence.
- Independently controlled KMS signing custody with anchors outside the audit database.
- Proposed checkpoint cadence: every **15 minutes or 1,000 events, whichever occurs first**, plus controlled-shutdown checkpoint. Anchoring deployment remains blocked pending a key/storage/custody selection.

### H-AUTH — approved design direction
- Canonical identity/ABA issues `cl:shadow:evaluate` explicitly for tenant/workspace/business; current authority version, revocation and database clock are verified in the protected operation.
- Operator != independent human approver; no delegation, `bo:admin` inheritance or caller-supplied principal proof.
- Separate owner, restricted writer, read-only auditor and test-fixture DB roles; guarded authenticated insert port, composite-scope enforcement and FORCE ROW LEVEL SECURITY.

### H-TXN — approved design direction
- CL owns shadow control and audit states; single atomic PostgreSQL transaction for authority revalidation, control transition and append-only audit.
- Scope idempotency to tenant/workspace/business/control/operation/key. Identical canonical request replays the original response; changed input with same key refuses.
- Consistent control-row locking and monotonically ordered scoped event sequence; audit write failure aborts transition.
- Serialization failures: at most **three bounded retries**, with full authority recheck on each retry. Retry timing and SQLSTATE rules remain to be finalized.

### H-KILL — approved design direction
- Emergency kill switch defaults **ON (blocking)** and overrides all permissions; inability to verify state means deny.
- Designated INFINICUS LLC security administrator is proposed primary custodian; two *different* authorized custodians required to restore/clear kill state.
- Emergency blocking of Shadow Mode does not require two-person permission. Audit kill/recovery failures, revocation and attempted recovery.
- Proposed incident acknowledgement objective: **15 minutes**, not a guaranteed operational SLA or assignment to a named person.
- Strongly controlled, auditable switch state; documented emergency fallback and recovery review.

## Unresolved binding operational parameters — STOP conditions

| Decision | Exact parameters still absent |
| --- | --- |
| H-RET | Applicable jurisdictions, confirmed legal controller and lawful basis, privacy reviewer, legal approval of 24-month duration or alternative, holds/DSAR/erasure procedure, deletion authority |
| H-HASH | Canonical JCS byte schema and versioned domain separator, key-management provider and key IDs, named independent signer/custodian, external anchor store and verifier, rotation and incident recovery |
| H-AUTH | Exact canonical issuer/grant/revoke/read-port API, permission representation, immutable scope/version provenance, database role names/GRANT/REVOKE matrix, trusted session context, guarded-function ownership, tested composite FK/RLS predicates |
| H-TXN | Authoritative control-state schema, event sequence and lock ordering, isolation level, input equality/canonical hash, SQLSTATE retry conditions/backoff, revocation race behavior, transaction owner |
| H-KILL | Named security administrator and two recovery custodians, authority repository and storage/replication design, independently verifiable kill state, out-of-band shutdown, incident workflow/on-call coverage and enforceable SLA |

Owner acceptance of the proposal **does not fill in these unspecified values**. These unresolved controls must be separately approved/verified before a numbered migration or operational IAM grant is authorized.

## Migration-readiness verdict

**NOT AUTHORIZED / NOT READY.** Previous review documents, CI tests and owner approval of development policies do not constitute database-security acceptance.

Next isolated gate: reconcile candidate SQL against actual ABA identity/scope constraints, lock exact missing values and obtain *separate explicit disposable-only implementation authorization*. Only then implement an independent migration and prove forced RLS, least-privilege roles, app-role UPDATE/DELETE/TRUNCATE denial, cross-scope refusal, revocation, independent approval, hash-chain anchoring, idempotent concurrency/rollback, kill-switch priority and zero learning/model/policy/BO mutation in a disposable PostgreSQL environment. No production DB, permissions, CL release or runtime flags are changed by this record.

**This document is a record of approval for development design, never an approval token for migration or activation.**
