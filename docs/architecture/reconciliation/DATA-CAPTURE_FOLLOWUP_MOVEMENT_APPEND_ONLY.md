# Data-capture follow-up — `inventory_movements` append-only database guard (migration 0184)

Status: DRAFT PR. Integrity hardening only. Data-capture Blocks B, A, D, E, B2b/B2c/B2d and P0-6 are NOT started. Not applied to live
Supabase (live 0169; 0170-0184 unapplied).

## 1. Purpose

`business_operations.inventory_movements` was documented (0027) as an "append-only stock change ledger" but enforced only by convention.
Movement rows (`quantity`, `movement_type`, `unit_cost`, `unit_cost_currency`, `occurred_at`) are Business Operations evidence that the
B2 COST and EXPECTED_OUTCOME dimensions will read. 0184 makes UPDATE, DELETE and TRUNCATE impossible for every role. **This does not
make any cost valid** — unit-cost validity when present remains data-capture Block B.

## 2. Survey (before allocation)

| Question | Finding |
|---|---|
| Production write paths | One: `OperationalCommandExecutor` (`INSERT INTO business_operations.inventory_movements`). No repository, route, function, trigger, view or script writes the table. |
| Production UPDATE | None in TypeScript, shell or SQL (migrations 0027/0034/0035/0036/0158/0183 only define, index, protect, comment on or alter the table). |
| Production DELETE | None. |
| Foreign keys | All `ON DELETE RESTRICT` (tenant, workspace, business, item, warehouse) except `performed_by -> platform.employees ON DELETE SET NULL`. A referential SET NULL is itself an UPDATE, so deleting an employee referenced by a movement is now refused (see risks). No code deletes employees. |
| Tests/utilities that delete movements | Two cleanups: `bo-repositories.integration.test.ts` and `BusinessIntakeService.integration.test.ts` (superuser `DELETE ... WHERE tenant_id = ANY($1)`). No tenant-erasure test creates movements. |
| Existing patterns | `forbid_mutation()` + `BEFORE UPDATE OR DELETE` row trigger + `BEFORE TRUNCATE` statement trigger (0181 audit_events, 0182 evaluations; the ABA package/capture tables use the same convention in their own schema). BO receipt/claim tables use a differently named `forbid_authorized_action_intake_mutation()`. |
| Selected pattern | The `business_operations.forbid_mutation()` convention of 0182, because `delete-tenant-data.mjs` discovers append-only tables by that function name and retains their rows instead of aborting. |
| Accepted privileged-test pattern | Superuser fixtures run `SET LOCAL session_replication_role = 'replica'` inside one transaction (aapFixtures, intakeFixture). |

**Stop conditions checked:** no legitimate production UPDATE or DELETE exists; 0184 is free (no migration above 0183 on `main`, in any
remote branch, or in an open pull request); a safe cleanup approach exists. None triggered.

## 3. Implementation

- `0184_inventory_movements_append_only.sql`: re-declares `business_operations.forbid_mutation()` identically to 0182 (CREATE OR
  REPLACE; self-contained, idempotent), adds `forbid_mutation_inventory_movements` (`BEFORE UPDATE OR DELETE`, per row) and
  `forbid_truncate_inventory_movements` (`BEFORE TRUNCATE`, per statement), and registers itself. The function has no condition, role test
  or bypass; it raises `integrity_constraint_violation` for every role, including the table owner and superusers.
- No column, constraint, RLS policy, index, grant or role change. The 0183 cost/currency constraints are untouched.
- RLS: unchanged (ENABLE, not FORCE). FORCE RLS was **not** required for this guard and is reported separately, not changed here.
- Test cleanup: `tests/helpers/movementCleanup.ts` (database and BO-runtime test trees) deletes movements for named tenants inside one
  superuser transaction with `SET LOCAL session_replication_role = 'replica'`. The setting is superuser-only; the application role is
  proven unable to use it. The helper lives under `tests/` and is guarded against any production import. The raw `DELETE` in the two
  existing cleanups was replaced by the helper; the Block C test that asserted "no trigger on the movement table" now asserts exactly the
  two 0184 guards.
- Corrections to history are a **new compensating movement** (e.g. `adjustment`), never an edit. No repair path exists.

## 4. Allocation record (MIGRATION-ALLOCATION-POLICY)

| Item | Value |
|---|---|
| Predecessor final migration | `0183_add_explicit_currency_to_inventory_costs.sql` |
| New range | `0184` (single migration) |
| main at allocation | `2bbac7a7c05216fef2067cda0afb13df8af2e401` |
| Open PRs at allocation | none; no remote branch carries a 0184+ migration |
| SHA-256 of frozen 0001-0183 (concatenated, name order) | `8b14ccfeb32946a38530be3f7829e37e967ff43407de56f18968f017283cc964` |
| SHA-256 of frozen 0001-0182 (unchanged) | `9e3893f5ca3885542b3472feef6a673d6f5e5f66cb4fac586aea199e0eab575a` |
| SHA-256 of frozen 0001-0181 (unchanged) | `f612bed7e8af0aa52fdd4835ebd6130f922bc7edc2decbca1e114b49b17c891a` |
| SHA-256 of `0184_inventory_movements_append_only.sql` | `4b53782b1ce7da79f063c21e1043c370fd1d18cc897ae055982d25be8428fd34` |
| Empty install / rerun | clean 0001→0184 on fresh PostgreSQL 16 passes the migration gate; the runner skips 0184 on rerun; applying the SQL twice directly is idempotent (two triggers, one `_migrations` row) |
| Historical upgrade | a database at the 0183 shape holding three rows (cost with NULL currency, no cost, cost with currency) was upgraded through the real runner; row-set MD5 identical before and after; the presence constraint remains NOT VALID |
| Live Supabase | not applied |

## 5. Caveats

1. **Tenant erasure becomes partial for tenants with movements.** `delete-tenant-data.mjs` retains `forbid_mutation` tables; the
   RESTRICT foreign keys from movements then block deleting the tenant's items, warehouses, businesses and the tenant itself (same
   situation as the 0182 evaluations and the 0180 intake tables). The script already reports this as "partially erased". Whether
   inventory movement evidence may be retained after an erasure request is a privacy/legal decision for the owner.
2. **Employee deletion is refused while a movement references the employee** (`performed_by` SET NULL is an UPDATE). Intended; no code
   deletes employees today. If employee erasure is later required, the actor reference needs a deliberate redesign (e.g. pseudonymous
   actor id) — not done here.
3. RLS is ENABLE-only on this table (superuser/BYPASSRLS and the owner bypass it). Not changed; reported for a separate decision.
4. A superuser can still switch off triggers with `session_replication_role = 'replica'` or `ALTER TABLE ... DISABLE TRIGGER`. This is a
   database-administration capability, outside any application role, and is the basis of the test-only cleanup.
5. Existing rows may include a cost with no currency (pre-0183). They stay exactly as they are; B2 COST treats them as INDETERMINATE.
