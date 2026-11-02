# BO-PUB-DEV-02A-R4 — T3 identity, replay and lifecycle certification

**Status:** STRUCTURAL CERTIFICATION ONLY; authority-dependent T3 closure remains blocked. BO inventory-movement record evidence remains `PROPOSED_NOT_ACTIVE` at `0.1.0-proposed`.

**Authoritative main baseline:** `8d0e65d2e26733a8468d6ceccfac48cc4b1dd74a`. The T1 source formula and T2 conservation record are read as prerequisites. T2 draft PR #417 is separate; this branch contains no T2 code or migration.

## What the executable probe demonstrates

The test-only model in `packages/business-operations-runtime/tests/helpers/proposedT3Certification.ts` validates a producer artifact against one BO header's identity, tenant/workspace/business, period, count and ready state. It uses the existing pure verifier, so an altered digest, content, order, scope or historical cost without currency is refused. A content-identical replay with different un-hashed provenance is a no-op candidate; divergent content for the same header is a conflict. A cancelled, changed-version or otherwise stale header is refused. All results explicitly carry `PROPOSED_NOT_ACTIVE` and no result grants publication authority.

The PostgreSQL integration probe uses disposable, uniquely named tables on a dedicated PostgreSQL 16 database. A restricted application role locks the scoped header with `FOR UPDATE` and inserts at most one evidence row and one audit row in one transaction. Simultaneous identical attempts converge to one insert and one replay; a conflict or injected failure rolls back without partial evidence. The fixture has forced tenant/workspace RLS, limited grants, append-only evidence/audit mutation triggers and no public route. Its database administrator creates and removes the transient tables. It is not a migration or production writer.

The existing `OperationalPublicationService` and `BusinessIntakeService.integration.test.ts` were run unchanged on the fully migrated disposable database. The established `ready → dispatched → received` lifecycle, one dispatch handoff/audit and identical dispatch replay remain functional. The proposed evidence probe does not alter that existing path.

## Open authority and activation decisions

The active BO publication service does **not** require durable record evidence before dispatch. That change would activate an unapproved evidence contract. The repository does not establish a canonical business-scoped publisher permission for the proposed artifact; the existing `bo:write` and `bo:admin` permissions cannot be inferred to authorize it. Therefore this block cannot certify an **authorized** evidence-backed dispatch transition, authenticated publisher identity or commit-time authority revalidation. A fixture's publisher reference is only a claim. The positive `STRUCTURAL_DISPATCH_CANDIDATE` result must never be used as an authorization decision.

T3 closure needs an owner-approved publisher authority mapping, durable schema/writer and one-per-header constraints, scoped authorization at the transition, and an explicit contract activation decision. The final implementation must test exact replay and conflicting concurrent publication against that approved schema, and must not silently change the existing BO→BI handoff. T4 source snapshot consistency and T5 BI exact-decimal reader remain separate gates.
