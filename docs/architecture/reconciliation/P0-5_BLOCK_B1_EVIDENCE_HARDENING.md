# P0-5/P0-6 preparation — Block B1: evidence hardening (no migration)

Status: DRAFT PR. Follows `P0-5_BLOCK_B_EVIDENCE_SURVEY.md`. No migration, no route, permission or event change. Not P0-6.

## 1. Purpose

Stop persisting a caller-asserted PASSED as authoritative truth, and stop accepting a simulation reference that is only a
well-formed UUID.

## 2. Architecture

```
route (unchanged) → AbaAuthoringService
   ├─ recordCapture   → GovernanceEvidenceVerifier.verify(...)   shared port (handoff-contracts), NO implementation registered
   └─ authorBoundaries → SimulationRunReferenceVerifier           workflow adapter over the Simulation layer's own public repository
```

- `GovernanceEvidenceVerifier` (handoff-contracts, pure types): request = scope + dimension + evidence reference + the
  server-derived subject (action, target, final parameters); answer = `VERIFIED {dimension, PASSED, evaluatedAt, evidenceRef,
  authoritativeSource, sourceVersion}` or `REFUSED {reason}`.
- The composition root registers a verifier through `buildApp(config, { abaAuthoring: { evidenceVerifier } })`. **Production
  registers none.**

## 3. Behavior

- **Modified approval, no verifier registered:** capture is refused (409) and nothing is stored. A reference alone is not proof.
- **Verifier registered:** every required dimension is verified. The stored evaluation is the verifier's answer (its time and
  reference), not a value stamped by ABA. Refused when the verdict is non-VERIFIED, for another dimension, not PASSED, for a
  different reference, malformed, dated before the modification (not fresh) or after the database clock. A verifier error fails
  the request; nothing is stored.
- **Plain approval:** no evaluation is required or accepted; no verifier is called.
- **Caller input:** the body still carries references only. Results, times and sources are rejected by the strict schema.
- **Simulation reference (boundaries):** must be a run that exists in the caller's tenant and workspace, belongs to the business, and
  is `completed`. Otherwise 409 and no boundaries are stored. NOT_APPLICABLE is still refused for this type (D3D-1).

## 4. What this does not prove (stated deliberately)

- A verified simulation reference proves the run exists and finished. It does **not** prove the run evaluated this action: the only
  engine today is a new-venture cash-flow Monte Carlo and there is no persisted ADI↔Simulation lineage.
- No authoritative evaluator exists for CONSTRAINTS, RESOURCE_REQUIREMENTS, COST or EXPECTED_OUTCOME. With none registered, modified
  approvals for `inventory_reorder_policy_update@1` cannot be captured. Plain approvals can, once a completed simulation run is
  referenced.
- The issuer does not re-read the Simulation layer at issuance; the reference is verified when the boundaries are authored.
- Freshness ordering for a real verifier (evaluation must not predate `modifiedAt`, which is stamped at capture) is deliberately
  strict and fail-closed; the real evaluator block must settle the order of "record modification" versus "evaluate".

## 5. Tests

- `apps/api/tests/abaAuthoring.integration.test.ts`: the existing 30 tests now use real completed simulation runs and a controllable
  fake verifier; 7 new tests cover the no-verifier default, plain approval, the persisted verdict, eight refusal modes, forged
  caller keys, the five simulation-reference refusals, and the package lineage.
- `packages/workflow/tests/abaAuthoring.architecture.test.ts`: the service persists no caller-asserted PASSED.
- Mutation proofs: see the PR report.

## 6. Next (not started)

Block B2: the BO-owned inventory policy evaluator (owner direction: Option A) and the production `GovernanceEvidenceVerifier`
implementation, with its own specification, migration (if any) and authorization. Then P0-6.
