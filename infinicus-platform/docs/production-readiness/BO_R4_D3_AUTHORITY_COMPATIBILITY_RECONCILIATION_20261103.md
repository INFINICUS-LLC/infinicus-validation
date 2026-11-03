# BO R4 / D3 security, publisher-authority and production-compatibility reconciliation

**Review date:** 2026-11-03. **Baseline:** main `c422fd0a025746f975d7d1c2bed27784bc3f11bc`. **Disposition:** REVIEW COMPLETE; D3 IMPLEMENTATION AND T3 CERTIFICATION BLOCKED. This is a source and hosted-CI evidence review, not a production database inspection or executable D3 proof.

## Verified evidence and limits

- Merged PR #418 contains the R4 identity/replay design, five pure identity/replay tests and header-only concurrent-dispatch regression. Its final branch CI failed at the header FORCE RLS assertion; its merge is not certification.
- Merged PR #420 carries `scripts/setup-r4-ci-force-rls.sh` and CI workflow steps. At its exact PR head `ebf1c89bebf380b0afb4b66bcffacfa2da1acc5e`, BUILD-32 run 41516345262 and Platform run 41516345363 succeeded. Reported BO runtime: 1412 tests; API: 938 passed, 12 skipped in Platform CI. This proves the constrained CI fixture, **not** persistent schema hardening or production role compatibility.
- The CI script requires GitHub Actions, a specific running postgres:16 service container, `infinicus_ci` and `infinicus_ci_admin`; it sets FORCE RLS on `bo_publication_packages` in that disposable database. It is not a numbered migration. Migration 0035 enables RLS but does not force header RLS.
- Merged PR #421 proposes D3 association, marked `PROPOSED_NOT_ACTIVE`. It supplies neither runtime persistence nor a production migration.

## Authority findings

1. `OperationalPublicationService.dispatchToBusinessIntelligence(ctx,businessId,packageId,...)` is directly exposed by `BusinessOperationsService.publication`. It uses `withTenantTransaction`, scoped header ID/business ID and `FOR UPDATE`, then writes the dispatch handoff, advances the header and emits `bo.data.published`. It does **not** check an explicit publisher entitlement. Its replay returns the prior dispatch for a dispatched header. These facts establish header-level transaction mechanics, not an authorized record-evidence publisher.
2. Repository code search for `dispatchToBusinessIntelligence` returned the service, tests and design documents, not a production route or caller. This does not establish that no dynamic or external invocation exists. An end-to-end authenticated actor-to-service-to-DB privilege chain remains unproven.
3. The BI read routes demonstrate `app.authenticate`, `app.resolveTenantContext`, `app.requirePermission('bi:read')`, and business-workspace checks. `bi:read` is a read permission and **must not** be reused as publication authority. No safe existing BO publisher privilege has been demonstrated.
4. Migration 0035 `bo_pkg_isolation` checks tenant and workspace session settings, not business membership. The service's `business_id` predicate narrows header access but does not independently prove the caller is entitled to publish for that business. The D3 proposed role and policy must reject sibling-business access and untrusted session-context forgery.
5. Current header-only dispatch does not require durable record evidence. Preserve it unchanged until a separately approved publisher implementation; do not describe it as record-level publication certification.

**Authority verdict: BLOCKED.** Owner decision required on authenticated publisher subject, existing permission mapping or a proposed new permission, revocation semantics, business membership and the trusted server-to-DB boundary. No new permission is approved by this review.

## D3 schema / production compatibility findings

- Migration 0033 header key is `id` (UUID primary key) and `UNIQUE (business_id,package_code)`, with `period_end > period_start`. It does **not** provide the proposed composite unique parent tuple `(id,tenant_id,workspace_id,business_id,period_start,period_end)`.
- D3's composite FK therefore requires an additional parent uniqueness constraint/index and compatibility review. Parent tuple pinning affects future scope/period edits; historical data and any writers that change those columns must be audited. Existing header `version` increments on status changes, so it is not a substitute for an immutable artifact version.
- The proposed one-row-per-header unique key is stronger than the earlier R4 candidate of package+contract; this is a **contract choice**, not a proven implementation. It precludes a second artifact/version under the same header and needs owner acceptance of version succession and historical headers.
- Existing `bo_pkg_isolation` RLS has tenant/workspace predicates only. D3 requires a business-membership enforcement design and a non-owner, non-BYPASSRLS, non-owner-member application role. FORCE RLS alone cannot establish business entitlement.
- The proposed composite FK checks equality to the header tuple but does not by itself prove `platform.businesses` belongs to that tenant/workspace. Confirm trusted business lineage and avoid a caller-controlled `app.tenant_id` / `app.workspace_id` trust assumption.
- Existing header prepare/dispatch/acknowledge perform UPDATEs. A new parent-key/locking design and forced-RLS migration must preserve these transitions and their role privileges. Test owner, migration, maintenance, backup/restore and constrained runtime roles separately.
- D3's full canonical bytes, digest, evidenceId, immutable creation metadata, retention/erasure, privileged repair, lock ordering, SQLSTATE sanitization, ambiguous-commit recovery and bounded retries are proposed requirements, not existing DB guarantees. JSONB reserialization must not be treated as byte identity.
- The D3 association transaction intentionally emits no dispatch, audit or outbox event. It must not be used to claim D4 publisher audit/entitlement certification.

**Production compatibility verdict: NOT ESTABLISHED.** No production catalog, grants, policy, historical header inventory or migration dry-run was inspected. CI fixture compatibility is narrower than production acceptance.

## Decision register and next independent gates

| Gate | Required decision / proof | Status |
|---|---|---|
| G1 | Owner approve one immutable slot per header, contract version succession and historical-header handling | OPEN |
| G2 | Owner approve composite parent key, period/scope pinning and existing writer compatibility | OPEN |
| G3 | Owner approve canonical byte retention, provenance, retention/erasure and privileged repair | OPEN |
| G4 | Identify/approve BO publisher permission, actor type, revocation, trusted business membership and SQL role grants | BLOCKED |
| G5 | Owner separately authorize **isolated disposable** D3 DDL and test-only adapter; no runtime import | OPEN |
| G6 | Execute D3 acceptance matrix with non-owner role, sibling/tenant isolation, 23503/23505, concurrency overlap, rollback, recovery, immutability, header-only regression | NOT RUN |
| G7 | Independently approve any numbered migration, runtime D4 publisher, audit/outbox and production compatibility | NOT AUTHORIZED |

**Recommendation:** Resolve G1–G5 through explicit owner decisions before implementing the isolated D3 harness. Do not add a numbered migration, production table, route, privilege or runtime dispatch dependency. Keep the evidence contract `PROPOSED_NOT_ACTIVE`. Do not advance to R5 or declare R4/T3 certified.

**Change scope of this review:** documentation only. No database access, production deployment, permission changes, merge or migration.
