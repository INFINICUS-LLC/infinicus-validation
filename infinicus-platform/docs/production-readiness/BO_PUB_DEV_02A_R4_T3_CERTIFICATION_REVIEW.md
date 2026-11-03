# BO-PUB-DEV-02A-R4 — T3 certification review (fail-closed verdict)

**Verdict: BLOCKED — NOT CERTIFIED.** This report is a read-only source-level assessment, not executable T3 certification. Contract stays `PROPOSED_NOT_ACTIVE`. No permission, migration, runtime, publication or production behavior is changed.

## Source reviewed

- `packages/business-operations-runtime/src/publication/OperationalPublicationService.ts` on authoritative main `4b99f4ca664ff4b161f7d1074ea69d6c2b458d26`.
- `packages/business-operations-runtime/src/publication/record-evidence/InventoryMovementEvidenceExtractor.ts`.
- Existing proposed evidence design / T1 and T2 completion descriptions.

## Findings

**F1 — existing header dispatch is not evidence-gated.** `OperationalPublicationService.dispatchToBusinessIntelligence` locks a BO package with `FOR UPDATE`, checks `ready` and prior dispatch, inserts a `bo_handoff_records` dispatch row, transitions the package to `dispatched` and emits `business_operations.emit_bo_data_published`. It does not check any durable inventory-movement evidence object, because no approved record-level store exists. This is *current header-only behavior* and must not be mislabeled certified record publication. Changing it requires a separate authorized implementation after contract freeze.

**F2 — no proven publisher-specific entitlement.** The service accepts `TenantContext` and executes through `withTenantTransaction`, but contains no demonstrated explicit role/permission check in its dispatch method. Tenant-scoped transactions alone do not establish publisher authority. An upstream caller permission might exist; it was not certified by this review. Do not invent a permission or claim a bypass.

**F3 — identity model remains proposed.** Pure producer evidenceId is deterministic and separate from the proposed database row UUID; no immutable storage or per-header unique association currently enforces T3 replay semantics.

**F4 — extractor allows headers in ready/dispatched/received and optional package id.** That is read-only proposed evidence extraction, not proof that a durable publisher can bind only a ready header in a race-safe transaction. The durable publisher must require a bound package and validate its state independently.

## Required T3 certification closure

1. Trace all actual dispatch entry points, actor authentication, privileges and tenant/business authorization; prove an explicit fail-closed publisher privilege (or submit a separate owner permission proposal).
2. On disposable PostgreSQL, prove valid same-package identical concurrent requests yield one artifact/one audit and no repeated dispatch; divergent concurrent requests yield sanitized conflict and no mixed rows.
3. Test non-owner/non-BYPASSRLS app role cross-tenant, cross-workspace, sibling-business and insufficient privilege denials; assert **zero durable writes and events**.
4. Prove per-header unique scoped association and stable content identity, transaction rollback at each step, and consistent lock ordering under concurrency.
5. Demonstrate header dispatch cannot move ready → dispatched before verified durable evidence in the *future record-level publication path*, without silently altering the frozen header-only behavior.
6. Check retention and audit metadata restrictions before any append-only publisher event is approved.

## Evidence classification

- VERIFIED — SOURCE: existing header transition and handoff flow; deterministic evidence formula; extractor header states.
- NOT VERIFIED: upstream authorization; database permission effects; T3 concurrency; durable storage; RLS using a non-owner role; executable rollback tests.
- BLOCKED: T3 certification and progression to R5.

No tests, CI, DB certification or deployment were executed by this review. This report is **not a PASS**. Do not merge this draft PR or advance the roadmap until blockers have independently verified closure or the owner explicitly requests a different scoped development action.
