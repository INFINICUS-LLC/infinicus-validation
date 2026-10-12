# P0-5 Block B2c — BO governance evidence verifier, evaluation route, modifiedAt correction

Status: DRAFT PR. No migration (head stays 0187); no live change (live Supabase stays 0169). B2d, P0-6, execution, `ACTION_AUTHORIZED`
handoff and `ExecutionEvidence` are NOT part of this block. The production BO capability registry stays empty.

Companion record: `P0-5_B2c_SIMULATION_NOT_APPLICABLE_AMENDMENT.md` (the narrow, owner-authorised contract amendment).

## 1. What changed
| Part | Where | Owner |
|---|---|---|
| `BoGovernanceEvidenceVerifier` (implements the shared `GovernanceEvidenceVerifier` port) | `packages/business-operations-runtime/src/inventory-policy/` | Business Operations |
| Composition-root registration | `apps/api/src/app.ts` | API composition root |
| `POST /v1/businesses/:businessId/inventory-policy-evaluations` (`bo:write`) | `apps/api/src/routes/inventoryPolicyEvaluations.ts` | Business Operations |
| `modifiedAt` from the decided decision | `AbaAuthoringService.recordCapture`, `ApprovalDecisionRepository.getModifiedDecisionFinalAt` | ABA |
| 24-hour freshness, one versioned constant | `ruleSet.ts` (`INVENTORY_REORDER_POLICY_V1_MAX_EVIDENCE_AGE_MS`, `maxEvidenceAgeMs`) | BO rule-set registry |
| Simulation `NOT_APPLICABLE` for `inventory_reorder_policy_update@1` | `canonical-actions.ts` + two ABA gates | shared contract |
| Request contract: `actorUserId`, `modifiedAt` added to `GovernanceEvidenceRequest` | `evidence-verifier.ts` | shared contract |
| Evaluation audit (atomic with the rows) | `InventoryPolicyEvaluationRepository.recordAll(..., audit)` | BO |

## 2. Verifier
ABA asks, per required dimension, whether `{kind: 'bo_inventory_policy_evaluation', id}` is authoritative evidence. VERIFIED only when ALL hold:
the kind is supported; the record exists in the caller's tenant, workspace and business (the lookup is scoped, so another scope's record is
indistinguishable from a missing one); the dimension matches and is one of the four evaluated dimensions (never REVERSIBILITY); the item
equals the target; the stored subject digest equals the digest recomputed from the requested final parameters (shared
`computeGovernanceSubjectDigest`) AND the stored subject equals the requested subject; the rule-set version is approved and effective
(`resolveApprovedRuleSet`); the record carries the BO evaluator input envelope (schema, rule-set identity, snapshot digest); the result is
`PASSED`; and on the database clock the record was evaluated at or after `modifiedAt`, not after "now", and not more than the rule set's
maximum evidence age ago. Everything else is REFUSED (a thrown error also becomes REFUSED). FAILED and INDETERMINATE are never converted.
The verifier reads one row and the database clock in one statement; it writes nothing.

Immutability: the evaluation table is append-only for every role (0182 trigger), so a verified record cannot later change.

## 3. Freshness
`EVIDENCE_MAX_AGE = 24 hours` (owner-approved for `inventory-reorder-policy/v1.0.0`). One constant, colocated with the rule-set registry and
exposed as the rule set's `maxEvidenceAgeMs`; the verifier reads it through the resolved rule set. No caller input, no copy in the route or
service, no global default for other action types. Age is `database now − evaluated_at`; **inclusive**: exactly 24 h verifies, 24 h + 1 ms is
stale, an evaluation dated after the database clock is refused. Tests: 24 h − 1 ms, exactly 24 h, 24 h + 1 ms (unit, fake clock) and
23 h 59 m / 24 h 01 m (live PostgreSQL).

## 4. modifiedAt (owner ruling)
**Source: `approval_decisions.updated_at` of the decided `approved_with_modifications` row**, i.e. "the authoritative time at which the
approved-with-modifications decision became final".
- Written by the live approval flow (`decide()` runs one status UPDATE; `set_updated_at` stamps it); database-stamped; one terminal
  transition per decision; the status of a decided row is immutable by trigger (`enforce_decision_immutability`). The read returns null for
  any other state, so it can never be defaulted.
- **Not used:** `approval_decision_modifications.created_at` (the live flow never writes that table; migration 0177 notes it is "text only,
  never written"; it is not backfilled and no rows are invented); the capture time; the request body; the evaluator's time; the audit log.
- Chronology enforced three times: ABA (`evaluatedAt >= modifiedAt` and not after the database clock), the verifier (same, on the BO side),
  and the database/validator (`0177` trigger: `modifiedAt <= captured_at`, `evaluatedAt >= modifiedAt`).
- Precision: `to_char(..., 'MS')` truncates to milliseconds on both sides, so an evaluation stamped in the same millisecond verifies
  (equality is accepted); anything earlier is refused.
- **Finding (reported):** the immutability guard protects the *status* of a decided row, not `updated_at`. A later non-status UPDATE (none
  exists in production code) would re-stamp `updated_at` with `now()` — it can only move *forward* (an explicit earlier value is overridden by
  `set_updated_at`; tested). A later `modifiedAt` can only make the chronology check stricter, never laxer, so this fails closed. A
  hardening that freezes decided rows in every column was ruled (O-14) and delivered as P0-6.0 (migration 0188); it is not part of B2c.

## 5. Evaluation route
`POST /v1/businesses/:businessId/inventory-policy-evaluations` — `bo:write` (existing permission), `Idempotency-Key` required.
Request body (strict): `{ actionType: {code, schemaVersion}, target: {kind, id}, finalParameters, ruleSetVersion }`. Anything else (result,
findings, thresholds, facts, `evaluatedAt`, source, snapshot digest, ownership, dimension, actor, tenant) is a 400. Tenant, workspace and actor
come from the authenticated context; `businessId` is verified against it (404 outside the tenant). Response 201: the subject digest, rule-set
version, snapshot digest, warehouse (or null), and **four evidence references** `{kind, id, dimension, result, evaluatedAt}` — references
to immutable records, not an authorization. An invalid or unresolvable target is a 400 refusal (`TARGET_ID_NOT_UUID`, `TARGET_KIND_INVALID`,
`TARGET_UNRESOLVED`) and writes nothing; the foreign key is untouched.
Idempotency uses the existing plugin: same key + same body replays the stored response (no new rows); same key + different body is a 409; a
new key appends new immutable evidence (facts may have changed). Audit: one `audit.audit_events` row (`bo.inventory_policy_evaluation.requested`:
actor, permission used, tenant/workspace/business, target, correlation id, per-dimension result and time) written on the same client as the
rows, so the facts and their audit commit or roll back together. No second audit store.

## 6. Fact / currency consistency (accepted limitation — not atomic)
**BO facts and declared currency are authoritative but not read under one PostgreSQL snapshot.** BO reads its facts in one statement
(`InventoryPolicyFactsRepository`) and the declared currency through the Business Administration reader (`BusinessDeclaredCurrencyReader`)
in a separate read. Ownership is preserved: the currency is not copied into BO and no second source of truth exists. A missing currency, a
cost/declared mismatch or a declared/cap mismatch is INDETERMINATE (fail closed). `withSharedTenantTransaction` was deliberately NOT
widened. Both values are recorded in the stored `inputs` snapshot. A future cross-domain snapshot/versioning mechanism may address this.

## 7. ABA integration
ABA depends on the `GovernanceEvidenceVerifier` interface only. `AbaAuthoringService` still defaults to `evidenceVerifier: null` (fail closed);
`apps/api/src/app.ts` is the single place that constructs `BoGovernanceEvidenceVerifier` (a test may override it). ABA passes the actor and
the decision-final `modifiedAt`; all four dimensions must verify, and the persisted evaluation is the **verifier's answer** (its time), not the
caller's. Capture fails on an absent, FAILED, INDETERMINATE, wrong-scope, wrong-target, wrong-digest, wrong-action, unsupported-rule-set,
stale, older-than-the-modification or unverifiable dimension.

## 8. Not done / deferred
B2d; P0-6; execution; inventory mutation; `ACTION_AUTHORIZED` handoff; `ExecutionEvidence`; FX; UOM redesign; ISO 4217 membership; the
`approval_decision_modifications` redesign; a hard `updated_at` freeze on decided decisions; a cross-domain snapshot.
