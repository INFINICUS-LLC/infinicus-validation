# P0-5/P0-6 preparation — Block B survey: verified governance evaluation evidence

Status: read-only survey (no code), recorded after owner authorization. Findings reviewed at main `96f3872`.
Companion: `P0-5_BLOCK_B1_EVIDENCE_HARDENING.md` (the interim hardening that followed).

## 1. Question

An evidence reference `{kind, id}` is not proof. For each governance dimension, is there an authoritative, immutable,
scope-correct source that ABA can ask — through a boundary, not by reading another layer's private tables — whether a PASSED
evaluation exists for the (possibly modified) parameters of an action?

## 2. What is trusted today and what is caller-influenced

| Item | Source | Trust |
|---|---|---|
| Risk class | Persisted ADI recommendation version (0174) + P0-2 policy, loaded by the issuer | Server-side, authoritative |
| Validity bound | Persisted `valid_until`, execution window, governed expiry (P0-3), loaded by the issuer | Server-side, authoritative |
| Simulation run reference | `boundaries.simulation_run` | Caller-chosen UUID, shape-checked only before B1 |
| Modification evaluation evidence | Capture `modification_evaluation` | Caller-chosen references stamped PASSED by ABA before B1 |

Evaluation evidence is required only for `approved_with_modifications`, for the dimensions the changed parameters declare. For
`inventory_reorder_policy_update@1`: CONSTRAINTS, RESOURCE_REQUIREMENTS, EXPECTED_OUTCOME (`reorderPoint`) and COST
(`reorderQuantity`). The simulation reference is mandatory for the type (ruling D3D-1).

## 3. Governance Dimension Matrix

| Dimension | Owner | Existing source | Verifiable PASSED for modified values? | Gap | Confidence |
|---|---|---|---|---|---|
| SIMULATION | Simulation | `simulation.simulation_runs` (scoped, status, history, inputs) | Existence/scope/completed only | The only engine is a new-venture cash-flow Monte Carlo; it cannot evaluate reorder parameters; no persisted ADI↔Simulation lineage | 90% |
| RISK | ADI | Persisted `risk_class` + P0-2 policy | Yes for the persisted class (already server-loaded) | No fresh re-evaluation of modified values | 90% |
| VALIDITY | ADI / P0-3 | Persisted `valid_until` + gates | Yes (already server-loaded) | None | 90% |
| CONSTRAINTS | ADI / DT | `decision_constraints`, `decision_policy_evaluations`, `decision_guardrail_violations`, `twin_constraint_evaluations` | No | No production code writes these; they describe the original recommendation | 85% |
| RESOURCE_REQUIREMENTS | none | none | No | No source, no owner | 85% |
| COST | none | `alternative_outcome_estimates` (generic metric store, never populated) | No | No source, no owner | 85% |
| REVERSIBILITY | none | none | No | Not required by the current canonical type; required only if a parameter is unmapped (`CONSERVATIVE_FULL`) | 85% |
| EXPECTED_OUTCOME | ADI / Simulation | `alternative_outcome_estimates`, simulation result metrics (original recommendation) | No | Nothing evaluates modified parameters; nothing writes these in production | 85% |

Repository-wide: `recordEvaluation`, `addOutcomeEstimate`, `addRiskProfile`, `recordGuardrailViolation` and `recordRiskResult` are
called only from tests. No ADI, Simulation, DT or BI code evaluates inventory reorder parameters; reorder logic exists only in BO.

## 4. Recommended verifier architecture

- A shared port in `handoff-contracts` (`GovernanceEvidenceVerifier`), implemented by the layer that owns each evaluation; ABA
  depends on the port only and persists the verifier's answer (source, version, evaluation time), never the caller's assertion.
- Default: no verifier registered, ABA fails closed.
- Migration needed: not for the port or wiring; probably yes later for whichever layer-owned evaluation records are created.
- Locked-spec conflict: none found in the reviewed material (about 80% confidence; the locked spec text was not re-read).
- Can a full implementation proceed safely: **no** — RESOURCE_REQUIREMENTS, COST and REVERSIBILITY have no owner or source, and the
  other dimensions have storage but no authoritative evaluation of a modified reorder policy.

## 5. Owner rulings recorded

1. Interim hardening authorized (Block B1).
2. Evaluation owner: direction recorded as **Option A — a BO-owned inventory policy evaluator** for CONSTRAINTS,
   RESOURCE_REQUIREMENTS, COST and EXPECTED_OUTCOME; it is its own later block and needs its own specification and authorization.
3. REVERSIBILITY stays out of scope while the canonical type has no unmapped parameter.
4. This survey is recorded in the repository.

Consequence: until an authoritative simulation and evaluation source exists, `inventory_reorder_policy_update@1` modified approvals
cannot be captured, and the simulation reference is verified only as an existing, in-scope, completed run.
