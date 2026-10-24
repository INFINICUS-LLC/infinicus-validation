# CL-ACT-06Q — Canonical Authorization Interface and Business-Scope Security Contract

**Status: TYPE CONTRACT AND REGRESSION TESTS ONLY — NO LIVE AUTHORIZATION.**
Base main: `5646fec8f80405da9ae5209a2ccbf6eee4b7e8a9`. PR #308 (upstream specification) was open at branch creation and must be reconciled at review.

## Implemented
`CanonicalShadowBusinessScope.ts` defines proposed `CanonicalShadowPrincipal`, `AbaShadowPermissionEvidence`, and a pure `reviewShadowBusinessScope` structural preflight. Its inputs are untrusted even where fields claim to be authenticated/verified. Valid structural review **never** produces operator authorization, audit-write permission or learning activation. Tests cover mismatched business, invalid/missing identifiers, unverified session, inherited `bo:admin`, missing explicit permission, revoked/stale assignment, delegation and self-approval. Existing `TenantContext` and ABA repository remain unchanged.

## Trust boundary

A future authenticated composition must resolve identity from a verified canonical session, obtain business membership and current explicit ABA grant/version from the authority owner in the same protected operation, and enforce tenant/workspace/business scope with reviewed composite constraints, RLS, database time and least-privilege writer roles. It must **not** turn caller-supplied booleans into authority, infer authority from free-text assignment names, or use transaction-local `app.user_id` as proof of authentication.

## Unresolved and STOP gates

Exact identity/ABA read port, explicit permission issuance and revocation representation, verified business membership, DB business-scope GUC and trusted role context, composite keys, atomic audit/control writer, external signed audit anchor and named kill-switch custodians still require design review and approval. No migration number, SQL or IAM grant is authorized by CL-ACT-06Q.

**Verification:** Source and tests committed, CI not confirmed. No database changes or PostgreSQL acceptance, no runtime route, no production activation or Continuous Learning publication/model/policy/BO mutations.
