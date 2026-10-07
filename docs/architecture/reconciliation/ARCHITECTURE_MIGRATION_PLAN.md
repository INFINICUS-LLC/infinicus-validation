# ARCHITECTURE_MIGRATION_PLAN — BUILD-ARCH-RECON-01, Phase 10 (D7)

**Status:** PLAN. Nothing here is executed. Companion to `ARCHITECTURE_RECONCILIATION_PLAN.md`.
**Safety rules (spec §16):** no destructive change without authorisation; no locked-spec edit; backward compatible by default; every step has a rollback; no direct cross-layer mutation introduced; migrations 0001–0170 immutable.
**DB/RLS gate (spec §17):** every schema change passes the migration gate on an empty Postgres, `grant-app-role.sh`, the migration-number guard, and live RLS tests (tenant/workspace isolation, fail-closed when context unset).

| Step | Forward path | Rollback path | Gate before next step |
|---|---|---|---|
| **M1 Approval authority** (V-01) | Add Business-Administration-issued assignment check; remove self-issue in `submitApprovalDecision`; ship behind no flag (it only tightens). | Revert the commit; no schema change in this step. | Tests: no pre-existing assignment ⇒ approval refused; audit row written. |
| **M2 Risk policy** (V-01/L-1) | Additive policy table + service (new migration, next free number). Default policy = strictest class for unknown actions. | Revert code; table is additive and unused when code is reverted. | Per-risk-class tests; RLS tests. |
| **M3 `risk_class` / `valid_until`** (V-11) | Additive nullable columns, then backfill rule, then NOT NULL only after backfill is verified (separate migration). | Columns stay (additive); code ignores them if reverted. | Locked ABA §§8/11/12 reconciliation written and accepted; stale/expired tests. |
| **M4 Authorization/audit validation** | Contract + end-to-end tests only. | n/a (tests). | All green on live Postgres. |
| **M5 `AuthorizedActionPackage`** (C-02) | New versioned contract, validator, immutable action reference; BO re-checks before execution (ABA §16). | Remove the contract consumer; no execution path exists yet. | Contract tests; guard test: no BO path consumes `ApprovedAction` directly. |
| **M6 Enable ABA→BO** | Feature flag default OFF; enabled per tenant by explicit approval. | Flag OFF (no data migration needed). | Explicit authorisation. |
| **M7 CL fail closed** (V-06) | Replace `?? 0.7`/default-false review with fail-closed; CL activation flag stays OFF for production outcomes. | Revert commit. | Tests: missing confidence/evidence class/review ⇒ `insufficient_evidence`. |
| **M8 Identity** (V-05, V-04) | Server-issued INFINICUS principal id; server-side token exchange; SPA reads new path behind a flag; existing users migrate at next sign-in; old `localStorage` key purged only after a successful exchange. | Flag OFF restores the old path (kept intact until retirement is authorised). | Existing-user login test; no secret in script-readable storage; no provider id in new slugs. |
| **M9 Evidence contracts** (C-03) | `ExecutionEvidence`, `VerifiedOutcomeEvidence`; typed outcomes stay `manual_entry`. | Remove consumers; additive. | CL does not consume unverified outcomes. |
| **M10 Cold start / mode** | Additive (CS-01 first, then maturity, onboarding inputs, provenance, mode, layer guide). | Per-item revert; all additive. | Cold-start e2e and mode-equivalence tests. |
| **M11 Legacy retirement** (SOT-02) | Only after all seven SOT-02 gates and explicit authorisation. | Keep Stack A endpoints deployable until the rollback window closes. | Authorisation. |

**Base-refresh protocol (E2):** after PR #25 merges, update PR #23 and PR #14 from `main`, regenerate `pnpm-lock.yaml` with pnpm 10.33.0, resolve conflicts, then rerun lint, typecheck, build, dependency scan, migration gate, migration-number guard, bundle guard, live PostgreSQL/RLS tests and image build/smoke. Earlier green results do not count.

**Test plan (spec §§18–22) to build:** contract tests for each handoff; end-to-end decision loop ADI→ABA→package→BO→evidence→OM→CL on live Postgres; cold-start e2e (empty business, no false certainty); mode-equivalence test (Guided vs Professional produce identical values, approvals and evidence).
