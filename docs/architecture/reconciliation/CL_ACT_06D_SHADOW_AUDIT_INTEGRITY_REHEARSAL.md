# CL-ACT-06D — Audit integrity rehearsal and authority gate

Status: **PARTIAL — preparatory pure-code block only**. Baseline main `5335a26b96fa7209186652568cabfb41252cfbf0` (PR #293 merged).

## Implemented

`ShadowAuditChainRehearsal` performs a deterministic, pure SHA-256 predecessor-chain consistency check over explicitly supplied versioned/canonical payload strings. Tests cover intact synthetic chains, tampered content, broken predecessor, missing first record, reordering, sequence gaps and malformed values. Every result explicitly denies `auditAcceptedAsAuthority` and `persisted`.

The caller supplies `canonicalPayload`. This is only a **proposed hash scheme**; the actual approved canonical encoding, collision-domain separation, writer identity and immutable historical anchors do not yet exist. An attacker who can rewrite all records may regenerate a valid chain, so a passing rehearsal does not prove tamper-proof persistence. This module contains no database, producer, authentication, operator permission or model/BO mutation functionality.

## Owner authority remains blocked

Before a real permission or append-only audit migration, owner must approve:
- Grant/revoke authority for the proposed `cl:shadow:evaluate` permission and the independent approver policy.
- CL audit domain ownership, retention, legal deletion strategy, canonical hash/anchor format and tamper evidence.
- Control transition/version authority, concurrent idempotency rules and kill-switch custody.
- Database migration reservation and production change window separately.

Do **not** treat a request naming CL-ACT-06D as the explicit values for these policies.

## PostgreSQL/RLS acceptance (not executed)

After owner decision, the database owner can introduce the audit table and write-port under a dedicated reviewed migration. Required disposable Postgres tests: application/admin role separation, forced RLS, scoped FK integrity, actor and approver revocation, append-only UPDATE/DELETE/TRUNCATE refusal, replay/idempotency and concurrent collisions, atomic transaction rollback, digest re-verification, kill-switch precedence and no OM→CL release.

No migration created or executed, no permission granted, no live shadow evaluation, no learning activation.
