# P0-6.0 — hard freeze of finalized approval decisions (migration 0188)

Status: DRAFT PR; not applied to live Supabase (the live head is re-checked before any live decision, owner ruling O-15). Owner ruling O-14.

## Purpose
`approval_decisions.updated_at` of an `approved_with_modifications` decision is the authoritative modification time (B2c: `modifiedAt`), and a
decided row is where ABA exercises approval authority. Before 0188 the guard rejected only a change of `status` on a decided row; a
non-status UPDATE (none exists in production code) could re-stamp `updated_at` forward through `set_updated_at`. B2c documented this as
fail-closed but not frozen.

## Change
`CREATE OR REPLACE FUNCTION` for `enforce_decision_immutability()` and `enforce_decision_version_immutability()`: **any UPDATE whose OLD row
is decided (`approved`, `approved_with_modifications`, `rejected`) is rejected**, in every column. The error text is unchanged
(`decided decisions are immutable` / `decided decision versions are immutable`), so callers and tests keep matching it.

## Not changed
- The valid transition INTO a decided state (OLD.status not decided) — `decide()` updates the decision and its version while they are still
  draft, so the approval flow, authority checks and RLS are untouched.
- No data is read, rewritten or backfilled; no table, column, index, policy or trigger definition changes (only two function bodies).
- Superseded/draft rows are not frozen (the ruling concerns decided rows).
- A privileged operator who must alter a decided row has to disable the trigger explicitly (the same deliberate pattern the test suites use).

## Proof
`migration-0188-freeze-decided-decisions.test.ts` (static) and `aba-repositories.integration.test.ts` (real PostgreSQL): every decided state is
frozen against status, `latest_version`, `updated_at` and `decision_code` updates even for the superuser role; versions likewise; a draft stays
updatable and the transition into each decided state still works; `getModifiedDecisionFinalAt` is unchanged after refused updates.
The earlier B2c test that demonstrated forward drift now asserts refusal. Mutation proofs: see the PR.
