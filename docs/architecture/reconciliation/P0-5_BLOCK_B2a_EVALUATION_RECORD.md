# P0-5/P0-6 preparation — Block B2a: BO-owned inventory policy evaluation record (migration 0182)

Status: DRAFT PR. Persistence only. B2b (evaluator), B2c (adapter, route, `modifiedAt` fix), B2d and P0-6 are NOT started.
Specification: `P0-5_BLOCK_B2_EVALUATOR_SPEC.md`.

## 1. Purpose

Create the immutable, Business Operations-owned boundary that will hold authoritative governance evaluations. **This block stores
results; it evaluates nothing.** No rules, thresholds, capacity conversions, freshness windows or defaults exist anywhere in this
block. ABA may later *verify* a row through an adapter; ABA is never the source of truth for it.

## 2. Owner rulings applied

| Ruling | How it appears in B2a |
|---|---|
| Q1 rule set | `rule_set_version`, `result`, `inputs`, `findings` are stored; no rule or number is implemented |
| Q2 INDETERMINATE | `PASSED`, `FAILED`, `INDETERMINATE` are distinct; only PASSED may ever qualify as verified evidence (a later verifier rule) |
| Q3 plain approvals | no evaluator requirement introduced |
| Q4 evidence age (24 h) | **not** in persistence; it belongs to the later versioned policy |
| Q5 permission `bo:write` | no route in B2a |
| Q6 Simulation option 2 | canonical reason `NO_APPLICABLE_SIMULATION_MODEL`; the canonical-contract change is **not** made here (belongs to B2c/B2d, reported) |
| Q7 `modifiedAt` source | not implemented; ordering `modification <= evaluation <= capture` is a later workflow fix |
| Q8 capacity units | no semantics assigned; absent or incompatible capacity will be INDETERMINATE in the evaluator |

## 3. Evaluation table: `business_operations.inventory_policy_evaluations`

- **Ownership:** Business Operations. No foreign key into any ABA, Simulation or ADI table; `requested_by_user_id` is a soft reference
  so a referential action can never undermine append-only.
- **One row** = one authoritative evaluation of one dimension for one exact action subject.
- **Columns:** `id`, `tenant_id`, `workspace_id`, `business_id`, `inventory_item_id` (FK `platform.inventory_items`), `warehouse_id`
  (nullable FK `platform.warehouses`; null = item-level), `dimension`, `result`, `subject`, `subject_digest`, `rule_set_version`,
  `inputs`, `findings`, `evaluated_at`, `requested_by_user_id`, `correlation_id`.
- **Dimension vocabulary:** `CONSTRAINTS`, `RESOURCE_REQUIREMENTS`, `COST`, `EXPECTED_OUTCOME`. REVERSIBILITY, SIMULATION, RISK and
  VALIDITY are deliberately not accepted.
- **Result vocabulary:** `PASSED`, `FAILED`, `INDETERMINATE`.
- **Subject binding:** `subject` stores the canonical `{ actionType: {code, schemaVersion}, target: {kind, id}, finalParameters }`
  verbatim; `subject_digest` is `sha256:<64 hex>` computed with the shared helper `computeGovernanceSubjectDigest`
  (`handoff-contracts`, version `governance-subject/1`). The helper covers only those four members, so identity and time can never
  change what an evaluation is about, and different final parameters always give a different digest. The database enforces the digest
  shape and the subject shape; it cannot recompute the digest (canonicalization lives in the contract package). **The verifier (B2c)
  must recompute the digest from the stored `subject` and from the request subject and require both to match.**
- **Time:** `evaluated_at` is stamped by a trigger from the database clock (`clock_timestamp()`, millisecond UTC); a caller-supplied
  value is overwritten.
- **Shape checks only, no rule logic:** valid vocabularies, non-empty `rule_set_version`, `inputs` is an object, `findings` is an array,
  size bounds. A missing subject member fails (the CHECK is wrapped in `COALESCE(..., false)`; a bare CHECK that evaluates to NULL
  passes — found and fixed by the live test).
- **Scope:** an insert guard requires the item, and the warehouse when given, to belong to the same tenant, workspace and business.
- **Append-only:** UPDATE and DELETE (row trigger) and TRUNCATE (statement trigger) are rejected for every role through
  `business_operations.forbid_mutation()`. A changed evaluation is a new row.
- **RLS:** enabled and forced; policy on tenant + workspace (the same hardened pattern as 0180). There is no business-level RLS
  setting in the platform, so business scoping is enforced by the repository on every read and by the insert guard.

## 4. Repository: `InventoryPolicyEvaluationRepository` (BO storage; `packages/database`)

- `record(ctx, input)` — validates, then appends one row; returns it.
- `getById(ctx, businessId, id)` — scoped to tenant, workspace **and** business; otherwise `NotFoundError`.
- `findForSubject(ctx, businessId, subjectDigest, dimension?)` — evaluations of one exact subject, newest first.
- `listForBusiness(ctx, businessId, limit)` — bounded, newest first.
- Every call runs through `withTenantTransaction`: it joins a caller's shared tenant transaction or opens an RLS-confined one.
- **Idempotency:** none, by design. The same content recorded twice is two distinct facts with their own database time; nothing is
  silently merged. Callers wanting the latest read it with `findForSubject`.
- No UPDATE/DELETE, no evaluation logic, no ABA/workflow/issuer import, no event, no inventory write.

## 5. Allocation record (MIGRATION-ALLOCATION-POLICY)

| Item | Value |
|---|---|
| Predecessor final migration | `0181_audit_events_append_only.sql` |
| New range | `0182` (single migration) |
| main at allocation | `ae28285a72f5da4654b8194f1ba24a11b4138dd0` |
| Open PRs at allocation | #73 (docs only; no migration) |
| Branches carrying a 0182+ migration | none (all remote heads scanned) |
| SHA-256 of frozen 0001-0181 (concatenated in name order) | `f612bed7e8af0aa52fdd4835ebd6130f922bc7edc2decbca1e114b49b17c891a` |
| SHA-256 of frozen 0001-0180 (unchanged) | `b599ff7f11150433ed3e442511c1a57e99b3fc15c9c7b2c8ff7f9920832465aa` |
| SHA-256 of `0182_create_bo_inventory_policy_evaluations.sql` | `912b33288589e69cb31ce4826341529d0fac4503ca4c042175f7e0f5c35524d4` |
| Empty-install result | clean install 0001→0182 passes the migration gate on a fresh PostgreSQL 16 database |
| Rerun result | runner skips 0182; applying the SQL twice directly is idempotent (same three triggers, one `_migrations` row) |
| Live Supabase | not applied (live 0169; 0170-0182 unapplied) |

## 6. Open items carried forward (not decided here)

- **Target identity:** the canonical target `id` is an opaque string (a SKU in tests) while this table stores `inventory_item_id`
  (uuid). B2b must define how the evaluator resolves `target.id` to an item and refuses ambiguity; B2a does not map them.
- **Tenant erasure:** the table uses the `forbid_mutation` convention, so `delete-tenant-data.mjs` retains and reports its rows.
  The 0180 intake tables use a differently named guard and are not discovered by that script — a pre-existing inconsistency, not
  changed here.
- **Simulation (Q6):** the per-type `NO_APPLICABLE_SIMULATION_MODEL` applicability change to the canonical contract and issuer is a
  B2c/B2d item.

## 7. Tests and mutation proofs

- Static migration guards (9), live PostgreSQL tests (16), repository architecture guard (6), shared subject-digest contract tests (4).
- Mutation proofs: **27 of 27 effective mutants killed.** Mutants: each append-only guard (UPDATE/DELETE trigger removed, UPDATE-only,
  DELETE-only, TRUNCATE trigger removed, guard skipping instead of raising); RLS not enabled, not forced, workspace condition dropped;
  REVERSIBILITY accepted as a dimension; VERIFIED accepted as a result; weakened digest shape; item and warehouse scope guards
  removed entirely and their business comparisons removed; `evaluated_at` no longer database-stamped; the NULL-passes-CHECK defect
  reintroduced; empty rule-set version; inputs and findings shape checks removed; repository reads ignoring the business; repository
  validation of digest, dimension and rule set removed; repository silently de-duplicating content.
- **Survivors, explained:** two first-draft mutants (item and warehouse guard "removed") survived because my edit left the workspace
  and business comparisons active and `NULL IS DISTINCT FROM x` is true when RLS hides the row, so they were equivalent mutants. They
  were replaced by four stronger mutants (guard removed entirely; business comparison removed), all killed. One further mutant
  (`COALESCE` removed) first failed to build because of a bad edit and was redone correctly (killed).
- Equivalent by design (not mutated): the repository's explicit `tenant_id` filter is redundant with forced RLS (defence in depth).
