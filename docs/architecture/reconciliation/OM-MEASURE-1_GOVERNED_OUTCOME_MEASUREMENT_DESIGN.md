# OM-MEASURE-1 - governed outcome measurement: design proposal

Date: 2026-10-21. Workstream CORE-ARCHITECTURE-01. **Design only.** No code, no migration, no state, no permission and no learning activation is introduced by this document. Every decision below is a proposal for the owner; nothing here is approved.

Grounded in what exists today: Guardrail Sections XI and XII; `execution-evidence/states.ts` (the one learning gate); `P0-6d_OUTCOME_MEASUREMENT_AUTHORITY.md` and `observationAuthority.ts` (what OM can and cannot observe); OM-EVID-1 (the database refuses any outcome beyond PENDING / INCONCLUSIVE); CL-BOUNDARY-1 (the dormant release boundary); OM-OBS-1 (the read-only health view).

## 1. The problem in one paragraph

Outcome Monitoring can prove that an action *happened* (EXECUTION_VERIFIED). It cannot prove that it *helped*, so every applied change rests at `OUTCOME_PENDING` and every non-applied one at `OUTCOME_INCONCLUSIVE`, and the learning gate (which needs `OUTCOME_VERIFIED`) is closed for everything. That is correct today and must stay correct until a measurement can be trusted. The tables for targets, thresholds, observations, measurements, evidence, attribution and variance already exist in the `outcome_monitoring` schema but nothing governs how a number in them becomes a *verified outcome*. This proposal defines that governance.

## 2. Principles (non-negotiable, inherited)

1. **Executed is not effective.** An outcome is a separate fact from an execution, with its own evidence, its own author and its own timestamp. No outcome state is derived from the execution fact alone.
2. **Fail closed.** Any missing, stale, unattributable, out-of-scope or contradictory input yields `OUTCOME_INCONCLUSIVE`, never a pass.
3. **Append-only.** An outcome verdict is a new row. Nothing is updated or deleted; a correction is a later verdict that supersedes, and both remain.
4. **One gate.** Learning eligibility stays `learningEligibility`; this design adds a *producer* of `OUTCOME_VERIFIED`, not a second consumer rule.
5. **No invented numbers.** Windows, thresholds and attribution rules come from an approved, versioned measurement definition, never from code.

## 3. What counts as reliable outcome evidence

Evidence is reliable only if **all** of the following hold; any failure means the measurement is `INCONCLUSIVE` with the failed condition recorded as a stable reason code.

| # | Condition | How it is proved |
|---|---|---|
| E1 | **Governed source.** The data comes from a registered source for that metric (for example BO inventory movements), read through that domain's read port - never from a table OM writes, never from user-typed text. | The measurement definition names the source; the reader returns it with a content digest. |
| E2 | **Scope.** Tenant, workspace, business and the target entity (for example the same item and warehouse) equal those of the execution. | Compared field by field, as the execution verification already does. |
| E3 | **Baseline.** A pre-change value exists and is itself evidenced, taken before the execution's recorded time. | The execution evidence already carries `mutation.before`; behaviour metrics need an equivalent evidenced baseline series. |
| E4 | **Window.** The observation window is complete (has fully elapsed on the database clock) and has the approved length for that action type. | The approved definition holds the window; "complete" is a database-clock comparison, never a caller assertion. |
| E5 | **Sufficiency.** The data in the window meets the approved minimum (for example a minimum number of demand events). | Counted by the reader and recorded with the digest. |
| E6 | **Attribution.** No other action on the same target changed the same driver inside baseline or window (the approved attribution rule), or the interference is quantified and within the approved bound. | An attribution run (existing tables) evaluates the rule and records its result and inputs. |
| E7 | **Integrity.** Inputs are immutable once used: each input set is stored by reference plus a SHA-256 digest, as execution evidence is today, and re-read at verification time. | Digest recomputed; mismatch is `INCONCLUSIVE(EVIDENCE_CHANGED)`. |

Evidence that is never reliable: a free-text note, a screenshot, a manual figure entered through the legacy observation workflow, or any figure OM cannot re-derive from a governed source.

## 4. From observed to verified

Two different acts, deliberately separated.

**OBSERVED** is a mechanical statement: *a governed measurement was taken and its inputs satisfied E1-E7 as of time T.* It carries the measured value, the baseline, the window, the definition version and the evidence digests. Producing it needs no human; it is performed by the OM measurement runner under a system identity. Observed says nothing about success.

**VERIFIED** is an evaluative statement: *the observed value meets the approved success criterion for this action type, and the result is attributable to the action.* It is the only state that opens the learning gate. It requires, in order:

1. an `OBSERVED` verdict for the same execution that is current (not superseded);
2. the approved success criterion of the measurement definition, evaluated by a pure function over the observed record (no judgement in code beyond the stored comparison and threshold);
3. a passing attribution result (E6);
4. an authorization step (section 5) where the definition requires one; and
5. an append-only verdict row that references the observation, the criterion version and the verifier.

Outcomes that are observed but do **not** meet the criterion are `OUTCOME_FAILED` (measured and unsuccessful) - a legitimate, valuable lesson, but still never positive evidence and never learning-eligible through the current gate. Anything that cannot reach the point of being measured stays `PENDING` (not yet) or `INCONCLUSIVE` (cannot be).

State flow (vocabulary unchanged; it already exists in `OUTCOME_STATES`):

```
EXECUTION_VERIFIED -> OUTCOME_PENDING -> OUTCOME_OBSERVED -> OUTCOME_VERIFIED
                          |                    |                (criterion met, attributable, authorized)
                          |                    +-> OUTCOME_FAILED     (measured, criterion not met)
                          +-> OUTCOME_INCONCLUSIVE                   (any E1-E7 condition failed, or nothing applied)
```

Because the verification table is append-only and its CHECK admits only PENDING/INCONCLUSIVE today, outcome verdicts must live in a **new append-only verdict record** (proposed below), not in an update of that table. The CHECK on the execution table stays as the permanent proof that an execution record can never claim an outcome.

## 5. Who may authorize verification

Three distinct roles; no single actor can both measure and approve.

| Act | Who | Basis |
|---|---|---|
| Define a measurement (metric, source, baseline, window, sufficiency, attribution rule, success criterion) for an action type | Business owner or an `admin`, through an approved, **versioned** definition; a definition is immutable once any verdict references it | Existing `bo:admin` operator authority (a new permission only if the owner rules one is needed - not proposed here) |
| Take the measurement (OBSERVED) | The OM runner (system identity); never a user, never ADI, never CL | It only reads governed sources and writes an append-only verdict |
| Verify (VERIFIED / FAILED) | Automatic when the definition says `AUTO` and every condition holds; otherwise a **named human approver other than the definition's author**, whose authority is checked with the same ABA approver-authority mechanism that already governs approvals | Separation of duties: author of the definition, runner and approver are distinct identities, and the verdict records all three |

Proposal for the first rollout: **every VERIFIED requires a human approver** (`MANUAL`), because the first definitions have no track record. `AUTO` is a later, separately authorized step, per action type, after a period of observed-versus-approved agreement.

No LLM or ADI output can verify an outcome. ADI may *propose* a definition or *explain* a verdict as text, but the verdict is produced by the runner and the approver.

## 6. Provenance and evidence integrity

Every verdict row records, at minimum: tenant, workspace, business; execution id and the execution evidence digest it extends; measurement definition id and version; the input evidence references with their digests; baseline and window bounds (database clock); the attribution run id and result; the runner identity and, for VERIFIED/FAILED, the approver and the definition author; a reason code; a correlation id; the database timestamp. Lineage back to the approved action and the proposing recommendation is by reference only (ids already on the verification).

Integrity rules: inputs are re-read and their digests recomputed at the moment of verification; a verdict is rejected if any digest differs from the observed record; the record is stored with a self digest; the table is append-only and `FORCE ROW LEVEL SECURITY`, with a trigger that refuses update and delete for every role, as `action_execution_verifications` does; the database clock stamps every verdict (a caller cannot supply a time); the CHECK constraint admits only the five states in `OUTCOME_STATES` and requires the shape each state needs (for example VERIFIED requires an approver, a criterion version and a passing attribution reference; PENDING/INCONCLUSIVE require none).

## 7. Separation of execution success from business effectiveness

- The execution record (`action_execution_verifications`) is never altered and can never hold more than PENDING/INCONCLUSIVE. This stays enforced by the database CHECK and by the OM-EVID-1 / CL-BOUNDARY-1 architecture tests.
- Effectiveness lives only in the new verdict record, joined to the execution by `execution_id`.
- The gate reads the **latest non-superseded verdict** joined to the execution fact; it still requires `executionOutcome = SUCCEEDED` and `mutationResult = APPLIED` from the execution side. A verified outcome on a refused, failed or no-op execution is impossible by construction and by gate.
- Reports and the OM-OBS-1 view keep two separate sections: execution health and outcome verdicts. A rising count of EXECUTION_VERIFIED is never shown as a success rate.

## 8. Tenant isolation

Every new table carries `tenant_id`, `workspace_id`, `business_id`, is `FORCE ROW LEVEL SECURITY` with the same scope policy as the other `outcome_monitoring` tables, and references its parents through composite foreign keys that include tenant, workspace and business (the pattern of migration 0200), so the database refuses a verdict that points at another tenant's execution. Measurement readers receive the scope as an argument and must return evidence stamped with that scope, which OM compares (E2). A foreign-tenant or nonexistent resource is a plain 404. The runner works per scope using the same scope-discovery pattern as the event worker; it never reads across tenants in one query.

## 9. Learning-gate eligibility

- No change to `learningEligibility`. It already requires `EXECUTION_VERIFIED`, `OUTCOME_VERIFIED`, `SUCCEEDED` and `APPLIED`.
- The CL-BOUNDARY-1 boundary's source lookup is extended (a later block) to read the latest verdict. Until a real VERIFIED verdict exists, the boundary refuses everything, exactly as today.
- The boundary stays dormant; wiring a sink and enabling learning are separate owner authorizations after at least one end-to-end rehearsal in a non-production database, and are not part of OM-MEASURE-1.
- Eligibility is recomputed at release time from stored facts, never cached in a flag.

## 10. Failure and inconclusive conditions (stable reason codes)

| Code | Meaning | Verdict |
|---|---|---|
| `NO_DEFINITION` | no approved measurement definition for the action type/version | INCONCLUSIVE |
| `NOTHING_APPLIED` | the execution applied no change | INCONCLUSIVE (as today) |
| `WINDOW_OPEN` | the approved window has not elapsed | PENDING |
| `SOURCE_UNAVAILABLE` | the governed source could not be read (retryable) | PENDING, retried; INCONCLUSIVE after the approved retry limit |
| `INSUFFICIENT_DATA` | sufficiency (E5) not met | INCONCLUSIVE |
| `BASELINE_MISSING` / `BASELINE_AFTER_EXECUTION` | E3 failed | INCONCLUSIVE |
| `SCOPE_MISMATCH` | E2 failed | INCONCLUSIVE, security-relevant, alerted |
| `CONFOUNDED` | another action changed the same driver in the window (E6) | INCONCLUSIVE |
| `EVIDENCE_CHANGED` | a digest differs on re-read (E7) | INCONCLUSIVE, alerted |
| `DATA_QUALITY` | inputs fail the definition's quality rules (for example unit cost unprovable) | INCONCLUSIVE |
| `CRITERION_NOT_MET` | measured, within bounds, criterion not satisfied | FAILED |
| `APPROVER_NOT_AUTHORIZED` / `SELF_APPROVAL` | the approver lacks authority or is the definition's author | verification refused, no verdict |
| `DEFINITION_SUPERSEDED` | a newer definition exists | previous verdicts stay; new run uses the new version |

A stuck PENDING (no window length, source never available) is surfaced by the existing health view as a limitation, not hidden.

## 11. First scope and the owner decisions this needs

Proposed first target: `inventory_reorder_policy_update@1`, the only verifiable action type today. Its measurements are listed in `P0-6d_OUTCOME_MEASUREMENT_AUTHORITY.md`; three of the four cannot be authoritative until owner decisions and data-capture blocks land. The recommended first *governed* metric is the narrowest one that can be defended: the number of reorder-below-point evaluations or stock-outs on the same balance in a window, compared with an equal-length baseline, with an attribution rule of "no other policy change or large adjustment on that balance".

Owner decisions required before any implementation:

1. The approved window length, baseline length and minimum-data rule per action type.
2. The attribution rule (and how confounding is bounded).
3. The success criterion form (threshold, direction, tolerance).
4. Whether the first verification is `MANUAL` only (recommended).
5. Whether a new permission (for example for approving outcomes) is wanted, or `bo:admin` plus ABA approver authority is enough (recommended: reuse).
6. Data-capture prerequisites for cost-based metrics (unit cost > 0, currency, purchase-order to item linkage).
7. Migration number assignment (0210+ is not independently assigned).

## 12. Proposed implementation blocks (each its own authorization; none started)

| Block | Content | Migration |
|---|---|---|
| OM-MEASURE-2 | Measurement definition model: versioned, immutable, with approval; read-only authoring API and tests; no runner | yes (definitions table) |
| OM-MEASURE-3 | Append-only outcome verdict record with CHECK shape per state, FORCE RLS, composite scope FKs, append-only triggers, digest columns; DB-level proof tests; nothing writes it yet | yes (verdict table) |
| OM-MEASURE-4 | Governed source reader port for inventory evidence plus digesting; read-only; contract tests | no |
| OM-MEASURE-5 | Measurement runner producing PENDING / INCONCLUSIVE / OBSERVED only, system identity, idempotent, per-scope; no verification | no |
| OM-MEASURE-6 | Attribution evaluation using the existing attribution tables | maybe |
| OM-MEASURE-7 | Verification act: approver authority, separation of duties, VERIFIED/FAILED verdicts; learning still closed | no |
| CL-BOUNDARY-2 | Boundary reads the latest verdict; rehearsal against a non-production database | no |
| LEARN-ACTIVATE | Wire a sink and enable learning; separate owner decision, not before a rehearsal | no |

Dead-letter replay remains a separate, authorization-gated workstream and is unaffected by this design.

## 13. Risks

- **Spurious causality.** The largest risk is declaring VERIFIED for a coincidence. Mitigation: mandatory attribution rule, `MANUAL` first, and `FAILED` / `INCONCLUSIVE` as first-class outcomes.
- **Definition drift.** Mitigated by immutable, versioned definitions referenced by every verdict.
- **Operator burden.** A human step for each verdict may not scale; `AUTO` is deliberately deferred until agreement is demonstrated.
- **Data quality.** Cost-based metrics are blocked by data-capture gaps and are out of the first scope.
- **Premature learning.** Prevented structurally: the gate, the dormant boundary and the architecture tests all stay closed until a separate activation decision.
