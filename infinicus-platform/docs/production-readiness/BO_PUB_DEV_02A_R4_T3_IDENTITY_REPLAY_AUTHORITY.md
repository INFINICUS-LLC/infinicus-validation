# BO-PUB-DEV-02A-R4 — T3 artifact identity, replay and publisher authority

**Status:** DESIGN CANDIDATE — NOT CERTIFIED; PROPOSED_NOT_ACTIVE.  
**Baseline:** `4b99f4ca664ff4b161f7d1074ea69d6c2b458d26` (main, after #417).  
**Owner policy:** D3 (one artifact per BO publication header/period) and D4 (BO-owned explicitly authorized publisher with audit trail) conditionally approved; technical implementation and migration separately gated.

## Existing evidence and separation of identities

- The BO-PUB-DEV-01 pure producer computes a deterministic 64-character hex content digest from canonical body, and `evidenceId` from `sha256('bo-evidence-id:' + contractName + ':' + digest)`.
- Provenance correlation is excluded from the digest and evidenceId. Repeated identical evidence under different request correlations has the same content-derived identity.
- The prospective storage schema sketches an independent randomly generated UUID `id` primary key. This **database row id is not the evidenceId**; neither proves authorization.
- The current BO publication package is a *header*, not a record payload. No approved record-level publisher or evidence store is active.
- T2 proof in PR #417 does not authorize creating persistent tables, routes, publisher privileges, or dispatch behavior.

## Proposed identity and uniqueness contract (requires independent approval)

1. Identify one artifact for a single `bo_publication_packages.id` + tenant/workspace/business + declared half-open period + contract version. This is the D3 per-header association, **not merely one artifact per period**.
2. Persist both database UUID row id (database relational identity) and immutable computed evidenceId (content identity). Uniqueness on `evidenceId` alone is insufficient to enforce one artifact per package.
3. Add a **unique scoped association** for packageId + contract identity; explicitly prohibit a second differing digest/evidenceId for that association. Any future allowed version succession requires a separate approved lifecycle/version mechanism, not overwrite.
4. Repeated submission of a byte-identical verified artifact to the same package must return the existing identity without a new evidence row, duplicate records, or duplicate publication/audit events. CorrelationId does not bypass idempotency.
5. Same package, changed content (including same count but different ordered records), scope, declared period or contract must fail closed as a conflict. A matching digest under another package is not authority to bind it there; package binding is included in the canonical source when supplied.
6. Verify a package id in a single tenant/workspace/business scope and its declared count/period/status; a missing or foreign package yields a non-disclosing refusal.

## Proposed transaction and race model

In one authorized BO-owned transaction:

- Establish caller identity, scope and explicit publication entitlement using the existing authority model; refuse absent or ambiguous permission (no new permission implied).
- Lock the scoped publication header (`SELECT ... FOR UPDATE` under a non-bypass RLS application role) before any evidence/dispatch transition.
- Confirm eligible header target layer, status, period and count. Distinguish an eligible creation state from an already dispatched state; do not assume all historically named states are suitable.
- Validate producer evidence and T2 body/ordered-row conservation; re-derive digest and evidenceId; check scoped package association uniqueness.
- Insert the complete immutable artifact and records transactionally or return an existing exactly matching artifact without mutation. Any conflicting replay is an error.
- Record an append-only BO audit event with actor, scope, package, evidenceId, action, and correlation only; never include free-text source notes, secrets, performed_by, or forbidden record fields.
- Permit header `ready → dispatched` only once verified durable evidence exists, and only through a separately authorized publication implementation. Audit and state transition must be atomic or fail closed.

**Lock ordering:** always scoped header first, then evidence association, then append-only audit. Unique index remains a final concurrent-write backstop. No bypass of forced RLS.

## Outstanding authority and schema questions

- Which **existing** BO privilege and subject type authorizes publication? Map it to actual repository guards and a non-owner PostgreSQL role; if no safe permission exists, stop for owner approval.
- What is the exact BO package status enumeration, transition authority and audit schema? Inspect live definitions and migrations before writing code.
- Whether `evidenceId` must be globally unique across packages or unique within contract and scoped association: the current content body includes the package id, but NULL package IDs are possible in the pure producer. Durable publication should refuse unbound evidence.
- Define if the existing header identity and the package scope key support the intended unique FK without changing currently frozen contracts.
- Audit retention/erasure for immutable actor references; do not store more personal data than necessary.

## Required executable proof (not yet run)

1. Two concurrent identical publication requests: one durable artifact, one eligible audit/dispatch event, both callers obtain same logical result.
2. Two concurrent same-package but different-content requests: one succeeds, one fails with sanitized conflict; no mixed rows.
3. Same digest and different correlationId: no duplicate evidence.
4. Foreign tenant/workspace/sibling business/missing package: indistinguishable failures and **zero writes** under non-owner role.
5. Insufficient publisher privilege and revoked permission: fail closed with zero rows, zero events, no state transition.
6. Digest, period, count, contract, version, and canonicalBody/record mismatch: refuse transaction and leave zero partial writes.
7. Crash/rollback at record insert, audit insert and dispatch transition: no partial commitment.
8. Replay after already dispatched: must not redispatch or emit another event.
9. Concurrent transactions and deadlock/backoff behavior: deterministic uniqueness and bounded failure.
10. Test both RLS-enabled and hostile BYPASSRLS administrative scenarios separately; never treat an owner/BYPASSRLS pass as tenant isolation evidence.

## Scope and disposition

This document **does not** implement or certify the above model. Source-level identity formula was inspected previously; no T3 integration tests, role mapping, disposable-DB tests or runtime changes were performed here.

**T3 VERDICT: PARTIAL — proposed design; authorization role and executable proof unresolved.**

Keep the evidence contract PROPOSED_NOT_ACTIVE. No migration, production access, endpoint, event emission, automatic merge, or transition to T4. Do not start T4 unless owner issues NEXT following review and T3 acceptance.
