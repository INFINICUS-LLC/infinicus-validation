# NEW-BDT-SIM-01.SEC-01: Twin Confidence, hand-off persistence and freshness remediation

Workstream CORE-ARCHITECTURE-01. Baseline: main `10634e36`. Status: development only; unmerged draft PR; nothing deployed, no production access. Corrects defects D1-D3 of the merged NEW-BDT-SIM-01 (#350).

## Decision summary

| Defect | Authority found | Outcome |
|---|---|---|
| D1 unsupported `quality.confidence = 1` | The frozen specs name the **seven factors** (BDT locked spec section 15) and the **0.75 default threshold** (layer-handoff-contracts section 29), and the frozen `dt-to-sim` contract needs a number in 0..1. They define **no formula, weights, scale or per-factor measurement**. | **STOPPED at the architecture decision gate for the score itself.** The gate is implemented and **closed (default deny)**; the amendment proposal is A1 below. No score is computed or defaulted anywhere. |
| D2 envelope not persisted | layer-handoff-contracts section 30: "No handoff should exist only in memory"; lists what to persist. | **Resolved.** Migration 0221 + repositories; the database enforces persist-before-publication. |
| D3 stale evidence qualifies | The frozen specs define **no maximum evidence age**. They require the twin to expose freshness and stale sources (BDT section 16). | **Resolved for supersession** (exact, digest-based, no clock). **A maximum age is NOT implemented**: it needs the owner policy A2 below. |

## What changed

**Containment (default deny).** The hand-off service now needs a `TwinConfidencePolicy` (the one port a ratified methodology enters through). The production composition injects none, so the service uses `UnratifiedTwinConfidencePolicy`, which assesses nothing: every request is refused with `CONFIDENCE_UNAVAILABLE` and **nothing is persisted**. Authorization (`dt:write`), the subscription check, the Idempotency-Key and the strict body are unchanged. No data is deleted; existing evidence is never touched.

**D1 gate (`twinConfidencePolicy.ts`).** When a policy returns an assessment it is accepted only if it names a ratified methodology (id, version, ratification), accounts for **all seven factors exactly once with recorded evidence** (an unavailable factor is never silently counted as complete), carries a score in 0..1 with at most four decimals (the `twin_confidence_scores` column), and meets the threshold: the platform minimum 0.75, which a policy may raise but the service refuses to lower (constructor guard). The score and its basis (methodology, score, factors with evidence references, canonical JSON) are recorded in the existing append-only `twin_confidence_scores`. Evidence integrity (digests, the cross-report revenue check) remains a precondition, not a confidence; Twin Confidence is evidence-state quality, not a forecast.

**D2 persistence (migration 0221, `dt_handoff_envelopes`).** One append-only row per publication package holding the **complete frozen envelope** (contract and schema versions, scope, snapshot identity and version, evidence references, variables with units, quality and confidence, assumptions, lineage), its SHA-256, the confidence score it rests on, the correlation and causation ids (the snapshot version), and the re-verified source digest and time. The database enforces: the envelope can only be recorded while the package is a **draft**; a performance hand-off package (idempotency key `bdt-performance-sim:%`) **cannot become ready or dispatched without it**; the package, snapshot version and confidence score must belong to the envelope's own tenant, workspace and business (and the score to the same snapshot version); the envelope's own scope, hand-off id, idempotency key, contract version and layers must agree with the row; no update, delete or truncate; forced row-level security. `verifyPersistedHandoff` reconstructs and independently validates a stored hand-off from the rows alone (digest, frozen contract validator, scope, recorded score and its complete basis).

**D3 freshness (`BusinessPerformanceTwinService.currentEvidence` + the gate).** Immediately before committing, the BI financial and sales reports are re-read and the evidence is re-assembled; its digest must equal the evidence the twin state was published from. A difference is `SOURCE_SUPERSEDED` (publish a new twin state first); any failure to re-derive it (a report unavailable, the reports now disagreeing) is `SOURCE_UNVERIFIABLE`. The original data times and provenance are preserved in the envelope (`effectiveAt` stays the twin state's). **A replay is subject to the same gates** and also verifies the persisted envelope; a package with no persisted envelope (for example one dispatched by the pre-SEC-01 code) is refused as `PERSISTED_HANDOFF_INVALID`, never replayed as valid.

Order inside the service (pinned by an architecture test): validate -> twin state and integrity -> readiness -> source revalidation -> confidence gate -> replay lookup -> frozen-contract dry validation -> one transaction { baseline, inputs, publish, insight version, draft package, confidence score, contract validation, envelope record, ready, dispatch }.

## Proposed specification amendments (owner decisions required)

**A1. Twin Confidence methodology (amend BDT locked spec section 15).** The owner must ratify, per factor, how it is measured from recorded evidence and how the factors combine. Questions the amendment must answer (no numbers are proposed here, because none are defensible without the owner):
- *Measurement per factor.* What Stack B can measure today as inputs: DATA_COMPLETENESS (domains provided, currencies covered), DATA_FRESHNESS (twin observation time, BI period end, both against a reference time), DATA_QUALITY (cross-report agreement; BI coverage codes; the share of sale lines with cost evidence), HISTORICAL_DEPTH (number and length of published periods), MODEL_CALIBRATION (this twin is a verbatim representation, not a model: is the factor not-applicable, and what then?), DEPENDENCY_COVERAGE (which other domain twins Simulation needs), SOURCE_RELIABILITY (no BI reliability measure exists).
- *Combination rule* (weights, minimum-of, or otherwise), the scale, and the treatment of a factor that cannot be assessed (today the gate refuses it).
- *Ratification record* (id, version, date, approver) stored with each score; the policy then returns it through `TwinConfidencePolicy`.
- *Tenant policy:* where a tenant-raised threshold is configured (today only a constructor argument; the platform minimum 0.75 cannot be lowered).

**A2. Freshness policy (amend BDT section 16 / handoff section 29).** Define a maximum age, if any, for a twin state or its BI evidence at hand-off: the reference time (observation time or period end), the limit per use, whether it differs by data maturity level, and per-tenant overrides. Until then only exact supersession is enforced; no age limit is invented.

**A3. Variable grammar.** Ratify `NEW-BDT-SIM-01_VARIABLE_GRAMMAR.md` (or amend it) before Simulation's intake is authorized; in particular the unit spellings (a bare currency code for financial decimals versus `<CUR> minor units (10^-N)` for sales).

## Frozen contracts
`dt-to-sim.ts` and `bi-to-dt.ts` are **unchanged**; the BI performance-evidence contracts are unchanged (the unmerged `core-architecture/new-bdt-01-verification` branch was neither touched nor depended on). No frozen semantics are changed: `quality.confidence` keeps its Twin Confidence meaning, now enforced instead of assumed.

## Limitations
- While A1 is unratified the hand-off is closed in every environment; this is the intended containment, not a defect.
- A package dispatched by the pre-SEC-01 code has no envelope; it is left untouched (nothing is deleted) and is refused on replay.
- The package-tenant and package-workspace checks inside the scope trigger are redundant with the package-business check (a business fixes its tenant and workspace through foreign keys); they are kept as defence in depth.
- Simulation's intake, acceptance and any consumption of the envelope remain unbuilt and unauthorized.
