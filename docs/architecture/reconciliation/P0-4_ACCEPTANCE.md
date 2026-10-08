# P0-4 — Authorization and audit validation: acceptance record

Status: **COMPLETE** against the reconciliation-plan gate ("all tests green; audit trail complete"), with **one owner confirmation outstanding (D3, section 6)**. Documentation only; this block changes no production behaviour, no migration, no locked specification. Base: `main` at `e0e45cc`.
Companions: `P0-4_APPROVAL_AUDIT.md` (design record, Blocks 1-2), `P0-4_BLOCK3_AUTHORIZATION_AUDIT.md` (route matrix and findings), `P0-5_HANDOFF.md`, `P0-3_HANDOFF.md`.

## 1. What was delivered

| Block | PR (merged) | Merge commit | Delivered |
|---|---|---|---|
| 1 | #45 | `faca727` | Approval audit trail: audit event for approve / approve_with_modifications / reject (atomic with the decision) and for refusals (`approval.denied`, `approval.blocked`); ABA §25 contract `approval-audit/1` |
| 2 | #46 | `772447b` | Expiry audit on detection (`approval.expired`), idempotent per review version, no scheduler, no migration; read-only `getReviewApprovalStatus` (service level) |
| 3 | #47 | `e0e45cc` | Route-permission remediation F1/F2/F3, reusable `requireAllPermissions`, choice-route audit context (N3), route-permission regression audit, 17 ABA contract/e2e tests over HTTP with real database fault injection, expiry concurrency test |

Merged by the owner; CI green on each head (`validate`, `operations-runtime`, `build-and-smoke-test-image`).

## 2. Implementation guarantees (what is true on `main` now)

**Authority**
- Approval authority comes only from explicit approver assignments. Grant / read / revoke of an assignment require `aba:admin`; deciding requires `aba:write` AND an active assignment. Neither alone suffices.
- No route self-issues approval authority: deciding without an assignment creates none and is denied (`approval.denied`, `AUTHORITY_NOT_ESTABLISHED`).
- A revoked assignment can no longer decide.
- Owner bootstrap remains strict-proof only (`OWNER_AUTHORITY_BOOTSTRAP.md`). **No owner-authority backfill has been executed**; every existing business remains UNPROVEN until an explicit `aba:admin` grant.
- `approverUserId` in a decision body is never authority: it must equal the authenticated user, else refused.

**Risk and validity** (P0-2 / P0-3, re-proven over HTTP in Block 3)
- Approval uses persisted, ADI-authored facts snapshotted by ABA; a caller cannot inject `risk_class`, `is_time_sensitive`, `valid_until` or `twin_snapshot_id`.
- Blocked for approve / approve_with_modifications: expired (database clock), unknown `is_time_sensitive`, time-sensitive without `valid_until`, stale Twin (newer published snapshot), unverifiable Twin reference. Recovery: RECALCULATE DECISION. No override exists.
- Reject is always allowed (authority only).
- `is_time_sensitive=true` without `valid_until` cannot be authored by ADI, so it is unreachable over HTTP; its ABA-side block is proven at service level.

**Audit** (table `approved_business_action.approval_audit_events`, append-only, RLS)
- approve / approve_with_modifications / reject: exactly one event, written **in the same transaction** as the decision. If the audit insert fails the decision is not finalised (proven by real database fault injection).
- Refusals are audited best-effort; a failed refusal-audit write is logged and **never** turns a refusal into success or makes an expired review approvable.
- Event semantics:
  - `approval.approved`, `approval.approved_with_modifications`, `approval.rejected` - a decision was recorded (carries decision id and prior/new state).
  - `approval.denied` - refused for authority (`AUTHORITY_NOT_ESTABLISHED`) or risk policy (`RISK_POLICY`); no decision row.
  - `approval.blocked` - refused by the persisted-fact gate, with the gate codes (`EXPIRED`, `STALE`, `TIME_SENSITIVITY_UNKNOWN`, `TIME_SENSITIVE_WITHOUT_VALIDITY`, `TWIN_SNAPSHOT_UNVERIFIABLE`, `REVIEW_FACTS_MISSING`); no decision row.
  - `approval.expired` - the persisted `valid_until` is at or before database time; recorded on detection (approval attempt or status read), **once per review version**, with `detectedAt` from the database clock, never from the caller. Does not change the review.
- Expiry idempotency: a transaction-scoped advisory lock keyed on the review version plus an existence check. Proven under concurrency; removing the lock produces duplicates in 5 of 5 runs, so the lock is necessary and sufficient. **No scheduler exists. Migration 0176 was not required and was not created.**
- `permissionUsed` and `correlationId` propagate from both the decisions route and the choice route.

**Route authorization**
- Every tenant-scoped route runs `authenticate -> resolveTenantContext -> explicit permission`, in that order (88 handlers audited; matrix in `P0-4_BLOCK3_AUTHORIZATION_AUDIT.md`). A regression test fails on any new route that lacks a permission; there is no permanent allowlist.
- F1 `GET /v1/businesses` -> `bo:read`.
- F2 `GET /v1/businesses/:businessId/workflow` -> ALL of `bo:read bi:read dt:read sim:read adi:read aba:read om:read`.
- F3 `GET /v1/billing/subscription` -> `platform:admin`.
- No business route treats authenticated as authorized. No client-supplied user, tenant or workspace identifier is trusted as authority. Onboarding steps 2 and 3 accept `tenantId`/`workspaceId` in the body only as lookup keys: identity is the session, `OnboardingService` rechecks `initiatedBy == session user`, and RLS confines the lookup (documented bootstrap exception, not a bypass).

## 3. Final validation record (Block 3, on `b8b7e0e`; merged as `e0e45cc`)
- Route matrix complete (88 handlers). 
- ABA contract/e2e: 17 passed; route-permission audit: 10 passed; expiry concurrency: 5/5 runs clean.
- Turbo test set 36/36 tasks, fresh PostgreSQL: database 2978 passed | 26 skipped; workflow 124 | 1; api 135 | 12; event-contracts 15; authentication 54 | 1; authorization 25 | 1; onboarding 20 | 1; web 14; BO runtime 22; DA runtime 94 | 1; configuration 46; observability 18. Root `platform/tests` 12/12. Bundle guard OK. Smoke and DAST pass.
- RLS: database RLS suites and the API tenant-isolation tests pass with the RLS-enforced application role.
- Migration gate green on a fresh database through 0175.
- BO isolation guard (`boIsolation.architecture.test.ts`, 6 tests) green; re-run on this base. No Business Operations route accepts an ApprovedAction (asserted in the route audit). BO does not consume ApprovedAction.
- Event-contract tests green. Source-of-truth ownership and layer ownership unchanged; no locked spec edited.
- Mutation proofs (all caught): F1/F2/F3 removal or weakening, all-of reduced to first-only, choice context dropped, unpermissioned route added, audit failure swallowed inside the decision transaction, advisory lock removed.

## 4. Intentional deferrals (NOT P0-4 defects)
- **A. `getReviewApprovalStatus`** is service-level only; no HTTP route. If a route is added later it requires `aba:read`.
- **B. Expiry** is detected on access. No scheduler. No unique expiry-event index; the advisory lock plus existence check is sufficient and proven. A scheduler needs a concrete requirement (proactive notification, lifecycle materialisation, batch housekeeping).
- **C. ABA §25 fields with no data source** are recorded `null` and named under `detail.unavailable`, never fabricated: action ID, modified parameters, simulation run ID, model/version metadata.
- **D. Legacy outcome route.** `POST /v1/businesses/:businessId/decision-recommendations/outcome` is compatibility-only (SOT-02 retirement gates apply; resolved by P0-5 / V-13 and cutover). It is NOT ExecutionEvidence, NOT VerifiedOutcomeEvidence and NOT the canonical BO->OM handoff. Its observations stay manual/unverified and must not satisfy OM verification or CL verified-learning requirements.
- **E. Public `/documentation`** (Swagger UI and spec) is a deployment-hardening observation, not an authorization defect.
- **F. Login lockout, intermittent UUID error.** The lockout count query logged `invalid input syntax for type uuid: ""` and failed open 31 times in one ABA test run; a separate probe still returned HTTP 429 after 5 bad attempts, so lockout enforces in that path. Pre-existing and documented in the code as deliberately fail-open. **Separate security follow-up; not modified in P0-4.**
- **G. Billing compatibility.** `GET /v1/billing/subscription` now requires `platform:admin`, which only the `owner` system role holds. `admin`, `member` and `viewer` lose HTTP read of the subscription. The web app does not call this route.
- **H. Workflow aggregate compatibility.** Custom roles missing any of the seven read permissions cannot read the aggregate - intentional least-privilege tightening. The four system roles hold all seven and keep access.

## 5. Live database state
- Repository migrations: through **0175** (next free number **0176**, not used).
- Live Supabase: through **0169**. **0170-0175 remain unapplied.**
- **No deployment authorisation was given during P0-4.** Nothing was applied. The controlled deployment review (`LIVE_MIGRATION_REVIEW_0170-0175.md`) remains separate and still requires explicit authorisation.
- P0-4 added no migration, so it adds nothing to the unapplied set.

## 6. Observations recorded during the handoff (for owner confirmation)
- **D3 - canonical audit of authority grant/revoke (needs owner confirmation).** The owner's D3 ruling and `P0-1_APPROVAL_AUTHORITY.md` list a canonical audit trail for authority changes as a P0-4 follow-up. P0-4 as scoped (plan row: "audit record on every approve/deny/expire") is delivered. Grants and revocations are recorded, append-only, with actor (and the authority it acted under), source, timestamp, correlation id and, for revocations, the reason, as provenance entries in `approval_authority_scopes` (`scope_type='provenance'`), and are visible via `GET .../approver-assignments/:code`. They are **not** also written to `approval_audit_events`, and the comment in `authorityProvenance.ts` ("until P0-4") is stale. This is not an authorization defect. If the owner wants authority changes in the canonical audit table too, it is a small follow-up needing no migration (`event_type` is open text, e.g. `authority.granted` / `authority.revoked`). Until the owner rules, treat P0-4 as complete under the plan gate and this item as open.
- **ApprovedAction creation does not itself assert an approved decision** (`ApprovedActionRepository.createAction`). The only route path (the choice route) creates one after an approve, and a reject returns before creation, so no HTTP route can create an ApprovedAction from a non-approved decision. It is an invariant P0-5 issuance must enforce itself (see `P0-5_HANDOFF.md`).

## 7. Open owner items (carried forward)
1. Controlled deployment review for migrations 0170-0175 (items A-F in `LIVE_MIGRATION_REVIEW_0170-0175.md`); any apply needs separate explicit authorisation.
2. E5 production webhook rate limits (test defaults only).
3. Remaining `platform.*` per-table classification (SOT-07).
4. Legacy D1 row counts for the SOT-02 retirement gate.
5. Explicit `aba:admin` grants for the 120 UNPROVEN businesses (no backfill executed).
6. Login lockout intermittent UUID issue (F above).
7. Public documentation production-gating review (E above).
8. D3 confirmation (section 6).
9. Incident `affectedTenantIds` under `platform:admin`: later platform-operator contract review (N7).

## 8. P0-4 exit gate
- Blocks 1-3 merged (#45, #46, #47) and CI green: yes.
- Documentation matches the implementation: yes, verified against `main` at `e0e45cc` (the stale `authorityProvenance.ts` comment is recorded in section 6, not edited in this documentation-only block).
- Unresolved P0-4 authorization defect: none found.
- Architecture conflict hidden as a deferral: none. Section 6 lists the two items a reader might otherwise miss.

**P0-4 is COMPLETE**, conditional only on the owner's D3 confirmation. P0-5 may start after the owner merges this record.
