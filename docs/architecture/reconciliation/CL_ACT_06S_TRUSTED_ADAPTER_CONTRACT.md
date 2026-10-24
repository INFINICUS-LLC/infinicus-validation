# CL-ACT-06S — Canonical Identity/ABA Adapter Contract & Security Regression Tests

**Status: ISOLATED TYPE CONTRACT AND TESTS ONLY; NOT A TRUSTED ADAPTER IMPLEMENTATION.**

Baseline main: `c8b5df548cae67318af46e22a97e8b11360f8818`. At branch creation CL-ACT-06Q replacement PR #310 and 06R specification PR #311 were open. Reconcile `src/index.ts` against new main before merging if those PRs land first.

## Deliverables

- `TrustedShadowAuthorizationPorts.ts`: proposed read-only canonical session, business membership, ABA permission evidence and port types. `assessShadowAdapterEvidence` checks only internal consistency, scope alignment, explicit `cl:shadow:evaluate`, current unrevoked grant, independent human approval and absence of delegation.
- `TrustedShadowAuthorizationPorts.test.ts`: synthetic positive structural case and negatives for missing evidence, cross-tenant/business/user scope, forged source-label strings, malformed IDs, inherited `bo:admin`, inactive/revoked/stale/expired grants, self-approval, delegation and nonhuman approver.
- Package export from `src/index.ts`.

## Critical trust limitations

The verified-looking property names are **TypeScript interfaces**, not cryptographic attestations. Any JS caller can forge their values. The preflight returns `operationallyAuthorized:false`, `auditWritePermitted:false` and `learningActivated:false` even for structurally consistent data. It may not be connected to a live route or treated as a security decision.

A future identity owner must supply real canonical session verification and business-membership resolution. ABA's owner must specify and implement an explicit read port for authoritative `cl:shadow:evaluate` grants/version provenance with current database-clock revocation checks; CL must not mutate ABA grant tables. Business scope, RLS and transaction ownership require independently reviewed database design. No app GUC or caller-provided session/membership flags can provide identity proof.

## Exit criteria for future trusted implementation

Identify exact identity and business membership source, ABA issuer and read APIs, trusted principal transport, composite tenant/workspace/business FK enforcement, restricted Postgres writer role, atomic audit/control transition, independent external hash anchors, and kill-switch custodians. Test these with a disposable PostgreSQL instance **only after separate authorization**.

**No code here issues permission, performs database/network calls, creates migrations, deploys routes, or activates Shadow Mode/Continuous Learning.** Tests committed; CI and disposable PostgreSQL have not been executed in this block.
