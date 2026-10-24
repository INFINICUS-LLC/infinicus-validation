# OM-AUTH-O1 — governed observation writer and lineage decision

Status: **owner decision required; writer closed**. Base: `main` at `4f586b4`. O1 can be reviewed independently of the unmerged M2A branch. No observation writer, migration, permission, positive verdict or learning release is authorized here.

## Existing authority and gaps

- `outcome_observations` / `outcome_observation_versions` are the existing OM identity and version tables. The legacy repository creates a draft observation and version, accepts caller-supplied measurement JSON and evidence references, and can move a draft to `recorded`, `verified` or `disputed`. These methods do not establish a machine writer or BO source provenance.
- Version numbers are unique per observation, but there is no governed binding to execution verification, approved measurement and criterion versions, currency, exact baseline/window values, source IDs/digest, service identity, or superseded version. A code/comment claim of append-only history is insufficient: migration 0121's UPDATE triggers reject a status change after a decided status but permit changes to other columns; no matching DELETE/TRUNCATE prohibition was found for these legacy tables.
- `outcome_measurements` and `outcome_evidence` reference a version by ID but do not, through that foreign key alone, enforce matching tenant/workspace/business. Their value/reference payloads do not certify source integrity or immutability.
- Migration 0215 permits only PENDING/INCONCLUSIVE governed assessments, with observation and value fields null. `assessVerificationRefusal` always denies verdict authority. The existing inventory runner does not provide a revenue observation writer.

## Owner decision requested

1. **Single identity.** Decide whether each governed machine observation uses the existing `outcome_observations` ID and `outcome_observation_versions` ID as canonical identity, with a governed extension keyed to those IDs. Recommended: reuse these IDs and keep legacy human-entered observations explicitly ineligible; do not create a second independent sales or OM observation ledger.
2. **Writer and authorization.** Name the OM service role and exact scoped permission; require active service identity at write time. Define whether the existing legacy repository remains available for manual observations and prevent it from writing the governed extension. Client-supplied authority booleans are not grants.
3. **Binding.** Approve required immutable references to execution verification ID/digest; measurement definition, calculation and criterion versions; tenant/workspace/business, metric and currency; exact integer-minor-unit baseline/measured values; half-open UTC bounds; BO source IDs and canonical digest; writer identity and database-issued time. Enforce composite scope across every referenced row.
4. **Replay and correction.** Approve an idempotency key from canonical inputs, deterministic digest format and collision handling. Identical replay returns the same version; changed BO evidence requires a new monotonic version that names the superseded version. Historical versions remain readable and cannot be reinterpreted by a later criterion. Decide how a previously decided legacy status is reconciled with new versions without rewriting history.
5. **Integrity.** Approve database restrictions on UPDATE, DELETE and TRUNCATE for governed versions and their measurement/evidence payloads, plus scoped foreign keys and integrity checks. A future verifier must reread BO references and recompute the digest before any verdict. Missing, corrected, truncated or ambiguous inputs remain INCONCLUSIVE.

## Proposed implementation sequence after approval

Amend the OM contract and database schema in a separate reviewed change; keep BO as the operational source and BI as a possible calculation layer. Add a dedicated least-privilege OM writer and read port. Test on disposable PostgreSQL: scope and RLS; wrong-role refusal; exact amounts and currency; replay versus changed source; monotonic supersession; mismatched or missing execution/definition/source; forged digest/time; concurrent writes; UPDATE/DELETE/TRUNCATE refusal; and legacy-observation ineligibility. Do not infer attribution PASS or human approval from a stored observation. O1 alone must not enable VERIFIED, FAILED or OM → CL learning.

## Completion-matrix evidence delta

| Capability | Evidence | Authority |
| --- | --- | --- |
| Legacy observation identity/version | Existing OM tables and repository | Legacy workflow only |
| Governed machine observation and provenance | Binding, writer, correction and immutability decisions unresolved | **Closed** |
| Revenue verdict and learning | M1/M2/M3 plus O1/A1/P1 approvals incomplete | **Closed** |

No runtime or schema code is changed in this block because the missing binding and source-of-truth semantics require the explicit owner ruling above.
