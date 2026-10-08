# P0-5 handoff — `AuthorizedActionPackage`

Status: **handoff (planning input), not an implementation.** Prepared at the close of P0-4 on `main` `e0e45cc`. Nothing here defines the locked contract; the contract content is fixed by the locked specifications cited below. P0-5 Block 1 (contract/reconciliation and source-of-truth ownership) comes first and needs owner approval before any code.
Authority applied: owner reconciliation order (P0-4 -> P0-5 -> P0-6), violations V-12 and V-13, rulings F4, L-1, SOT-02.

## 1. The locked chain (preserved)
```
ADI -> ABA -> AuthorizedActionPackage -> BO execution -> ExecutionEvidence -> OM -> CL
```
Missing contracts are implementation gaps, not a reason to change the architecture, and must never be replaced by direct calls (F4).

## 2. What P0-5 must NOT do
- Wire ABA directly to BO. ABA->BO wiring is **P0-6**, last, behind a flag that defaults off, and needs explicit owner approval to enable.
- Treat an `ApprovedAction` as execution authority. `ApprovedAction` "describes what was approved - never a record of execution" (table comment, migration 0097).
- Bypass BO re-validation. Locked ABA spec §16: BO must re-check permissions, rules, automation policy, current state and safety constraints before execution.
- Create any execution path before the package contract is proven by contract tests.
- Weaken P0-1 to P0-4: assigned authority, risk policy, persisted-fact gate, atomic audit, expiry audit, explicit route permissions.
- Add an override path, run an owner backfill, apply live migrations, edit locked specs, or add a scheduler.

## 3. Locked sources the contract must derive from (do not paraphrase into new requirements)
- Master Manifest §8.7: `AuthorizedActionPackage` includes action ID, decision ID, exact authorized parameters, approver, owner, execution window, automation level, budget, preconditions, rollback instructions, monitoring metrics, approval record. "Business Operations remains responsible for execution."
- ABA spec §14 (execution plan), §15 (reversibility/rollback), §16 (handoff and BO re-check), §32 (output to BO), §25 (audit record), §35 (ABA is the source of truth for *what action was formally authorized*, and does not override BO, BI, DT, SIM, ADI, OM, CL).
- BO locked spec v1.1 for the consumption side; Manifest §8.8 for the downstream `ExecutionEvidence` (BO->OM), which P0-5 does **not** define (V-13, later).

## 4. What P0-5 should define and validate
Use nullable / explicit-unavailable semantics wherever the source does not exist yet; never invent evidence (same convention as `approval-audit/1` `detail.unavailable`).

| Element | Source today | Note |
|---|---|---|
| Immutable action reference | `approved_actions` + append-only `approved_action_versions` | A package must pin a specific action **version**, not the mutable action row |
| Approved parameters | `approval_decision_modifications`, `approved_action_constraints`, `approved_action_steps` | Exact authorized parameters; modified parameters are currently an ABA §25 *unavailable* field - P0-5 must define where they come from |
| Decision / recommendation lineage | `approval_decisions`, `source_recommendation_id` (0170), `source_recommendation_version_id` on the review version (0175) | Version-level lineage already exists |
| Approver / authority lineage | `approver_assignments`(+versions), authority provenance in `approval_authority_scopes` | Capture assignment id, role at decision time |
| `risk_class` | persisted on the review version (0175), ADI-authored | Copy, never recompute |
| Validity / freshness | persisted `valid_until`, `is_time_sensitive` | Package expiry must not exceed the decision's validity |
| Twin snapshot reference | `twin_snapshot_id` (soft uuid) | Re-assessable via `assessFreshness` |
| Simulation reference | not persisted on the review version | **Unavailable today** -> nullable, explicit |
| Scope | tenant / workspace / business | All three on the package; RLS-confined |
| Authorization provenance | `approval_audit_events` row for the decision | Link by id; the audit event is the approval record |
| Version, status, issuance timestamp, expiration | new | Status machine (e.g. issued / consumed / expired / revoked) to be designed in Block 1 |
| Correlation / causation ids | `correlationId` in audit detail | Carry through; add causation |
| Audit linkage | `approval_audit_events` | Issuance, consumption and rejection should themselves be auditable events |
| BO consumption contract | none (V-12) | Define what BO validates and returns; BO must re-check before execution |
| Rejection of stale / expired / tampered packages | new | Integrity (e.g. content hash or signature reference), freshness against current Twin and `valid_until`, revoked authority |

Execution window, automation level, budget, preconditions, rollback instructions and monitoring metrics are in the locked package definition; where the current data model has no source, they are **explicitly unavailable**, not synthesized.

## 5. Invariants P0-5 must enforce itself (found during P0-4)
1. **Issuance must verify the decision.** `ApprovedActionRepository.createAction` does not assert that the decision is approved; only the choice-route service path creates one, after an approve. The package issuer must verify decision status (`approved` / `approved_with_modifications`), that the review facts are still valid (not expired, not stale), and that the approver's authority was valid at decision time.
2. **Re-validate at consumption**, not just issuance (BO re-check, §16): expiry, staleness against the current published Twin, revoked authority, and package integrity.
3. **The legacy outcome route is not an evidence path.** `POST .../decision-recommendations/outcome` takes a client `approvedActionId` + `outcomeNotes`. It is compatibility-only (SOT-02 gates apply), not ExecutionEvidence, and must stay unverified/manual. P0-5 / V-13 replace it; do not remove it before the retirement gate.
4. **Extend, do not remove, the BO isolation guard** (`boIsolation.architecture.test.ts`): after P0-5, BO may reach ABA output **only** through `AuthorizedActionPackage`. The forbidden list (ABA tables, repositories, entities, execution plans, control gates, ABA-layer imports) stays; the guard additionally requires the package path. The route audit already asserts no BO route accepts an ApprovedAction; keep it.
5. **Authority lineage source** (owner ruling D3, closed): `approval_authority_scopes` is the canonical record of authority grants/revocations; `approval_audit_events` is canonical for approval decision/refusal/expiry. A package references the assignment and the decision's `approval_audit_events` row; it must not re-create or duplicate authority lifecycle events.

## 6. Suggested P0-5 block structure (one block at a time, owner approval before Block 1 code)
1. **Contract/reconciliation and SOT ownership** - map §8.7 / §16 / §32 fields to sources; mark unavailable fields; decide ownership (ABA issues, BO consumes); document the status machine and integrity scheme. No code.
2. **Pure contract + validator** (versioned, deterministic, database-free) with tampered/expired/stale/unavailable-field tests.
3. **Issuer** inside ABA (verifies decision, facts, authority; writes an immutable package + audit event; idempotent). Needs a migration - follow the migration-number rule (next free number 0176; inspect main and open migration-bearing PRs and record the owner first).
4. **BO-side consumption validator** (re-check, no execution yet) and the extended isolation guard.
5. **Contract / e2e tests and mutation proofs**, then docs and handoff into P0-6.
Execution wiring is not part of P0-5.

## 7. Guarantees P0-5 inherits (do not regress)
- Authority: assigned, `aba:admin`-granted, never self-issued; deciding needs `aba:write` + assignment.
- Risk/validity: persisted facts only; expired / stale / unknown / unverifiable block approval; reject allowed; no override.
- Audit: atomic success audit, best-effort refusal audit, idempotent `approval.expired`.
- Routes: every tenant route has an explicit permission (regression test); new package routes must too (suggested: `aba:read` to read a package, `aba:admin` or `aba:write` per the owner's ruling to issue; BO consumption under a `bo:*` permission).
- Live database: 0170-0175 unapplied, live at 0169; P0-5's migration, if any, joins the controlled deployment review. No deployment is authorised.

## 8. Open items P0-5 depends on or should surface
- Owner: deployment review of 0170-0175 before any package migration is applied live; per-table `platform.*` classification (SOT-07); legacy D1 row counts (SOT-02 gate); explicit `aba:admin` grants for the 120 UNPROVEN businesses (no backfill).
- Separate security follow-up: login lockout intermittent UUID error (not a P0-5 dependency).
