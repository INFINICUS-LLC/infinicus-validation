# P0-5 Block B2d — end-to-end modified-approval authoring proof (pre-execution only)

Status: DRAFT PR. Tests, architecture guards and this record only — **no production code change, no migration** (head 0187), no live
change (live Supabase 0169). The chain ends at the sealed `AuthorizedActionPackage`. P0-6, BO intake/claim/consumption, execution,
`ACTION_AUTHORIZED` handoff and `ExecutionEvidence` are NOT part of this block; the production BO capability registry stays empty.

## 1. The chain proven (one suite, real components, real PostgreSQL with RLS)
`apps/api/tests/p0-5-b2d-modified-approval-authoring.e2e.test.ts` builds the production application (`buildApp` with the real composition
root; no injected or fake verifier) and drives the actual routes:

```
approver authority → decision (approve_with_modifications)            DecisionWorkflowService
  → modifiedAt = approval_decisions.updated_at (decided row)           ApprovalDecisionRepository.getModifiedDecisionFinalAt
  → POST /v1/businesses/:id/inventory-policy-evaluations (bo:write)    BO evaluator, B2a repository, DB-stamped evaluated_at
  → four PASSED records (CONSTRAINTS, RESOURCE_REQUIREMENTS, COST, EXPECTED_OUTCOME), subject digest, rule set v1.0.0
  → POST …/authorized-actions/:id/capture                              AbaAuthoringService → BoGovernanceEvidenceVerifier (port)
  → POST …/owner                                                       canonical Identity/Tenancy membership, DB-verified
  → POST …/boundaries   (Simulation = governed NOT_APPLICABLE / NO_APPLICABLE_SIMULATION_MODEL)
  → POST …/package      (identifiers only)                             AuthorizedActionPackageIssuer → sealed aap/1 package
  ⏹ STOP
```
Asserted along the way: the decision is final before any evaluation; four rows persisted, all `PASSED`, bound to one digest; the capture
stores the verifier's answer (the BO record's own database time); `authorized_action_captures.final_parameters` is the only executable
parameter set and the package's `action.parameters` equals it; `modification.modifiedAt` equals the decision time; the package validates
under `aap/1` (structure, semantics, digest); lineage carries the proposal, the modification and the four evidence references; the
accountable owner is pinned; the Simulation field is the exact governed `NOT_APPLICABLE`; validity is bounded; replay returns the same
package and digest; balances/items/movements are byte-for-byte unchanged (the reorder policy is not changed); BO intake has no receipt;
no `ACTION_AUTHORIZED`, no consumption, no `ExecutionEvidence`.

**Chronology proven:** `decision final time ≤ every evaluation.evaluated_at ≤ capture time ≤ package issuance time` (and strictly before issuance).

## 2. Integrity
Canonicalisation is deterministic (reversed key order canonicalises to the same string and still validates). Tampering with final
parameters, target, owner identity, boundaries (budget / window), Simulation state or reason, evidence lineage or scope makes validation
fail; content the contract still accepts as well-formed is caught by `DIGEST_MISMATCH`, and a swapped digest on untouched content is
invalid. The digest is tamper evidence only — authorization is the persisted authority chain, not SHA-256.

## 3. Negative end to end (each stops before a package exists)
Not approve_with_modifications (plain approve with a modification; rejected) · no evaluation · each of four dimensions missing · FAILED ·
INDETERMINATE · other business · other target in the same business · other final parameters · evidence predating the decision · stale
(>24 h) · unsupported rule-set version · owner missing · owner of another tenant / unknown user · each required boundary missing or
NOT_APPLICABLE · Simulation absent / wrong reason / lowercase reason · a non-approver trying to author · caller-supplied issuer body ·
issuance needing a fabricated fact (action without a version) · **approver authority revoked between boundaries and issuance** (refused
`AUTHORITY_REVOKED`; the decision, its time and the capture are untouched; the refusal is audited).

## 4. Audit (existing conventions, no second store)
`audit.audit_events`: `bo.inventory_policy_evaluation.requested` (bo:write), `aba.capture.recorded`, `aba.owner.assigned`,
`aba.boundaries.authored` — each with actor, permission used, scope and correlation id; issuance in the approval audit trail
(`package.issued`, `package.issuance_refused`) atomically with the package. Audit rows are append-only.

## 5. Findings
- No defect in production code was found by the end-to-end proof; every deviation failed closed with a specific reason.
- Some tests are killed by a *message* rather than a distinct refusal path where two independent checks overlap (for example the
  target, digest and stored-subject comparisons all reject wrong-target evidence). The mutation run removes them together as well as singly.
- Boundary applicability is enforced twice with the same canonical contract and the same message: by `AbaAuthoringService` and by the
  database trigger on `authorized_action_boundaries`. Removing the application gate alone therefore changes nothing observable (the mutant
  survives by design — defence in depth); only removing both would open the hole.
- `createAbaFixture` (upstream ADI→Simulation fixture) creates a Simulation run in the tenant; the proof shows it is neither required nor
  referenced by the boundaries or the package.

## 6. Deferred (unchanged)
P0-6 planning and implementation; BO intake extension; hard `updated_at` freeze for decided decisions; cross-domain fact/currency
snapshot; UOM; FX; ISO 4217 membership; `approval_decision_modifications` redesign.
