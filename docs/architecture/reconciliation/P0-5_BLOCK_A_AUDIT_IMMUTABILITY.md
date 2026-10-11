# P0-5/P0-6 preparation — Block A: `audit.audit_events` append-only (migration 0181)

Status: DRAFT PR. Block B (verified governance evaluation evidence) is not started. P0-6 is not authorized.

## 1. Purpose

`audit.audit_events` (0006) was documented as append-only but enforced only by convention. ABA governance history (action types,
policy versions and enablement, capture, owner, boundaries, issuance detail) is written there since the authoring block, so it
must not be alterable after insertion by any role.

## 2. Immutability design

- `audit.forbid_mutation()` always raises `integrity_constraint_violation` (`audit.<table>: append-only table - <OP> is not permitted`).
- `forbid_mutation_audit_events`: `BEFORE UPDATE OR DELETE … FOR EACH ROW`.
- `forbid_truncate_audit_events`: `BEFORE TRUNCATE … FOR EACH STATEMENT` (plain and CASCADE).
- Applies to every role, including the admin role. INSERT, RLS (`audit_events_isolation`), columns, indexes, readers and
  `GovernanceAuditRepository` are unchanged. No data moved, rewritten or backfilled. No GRANT/REVOKE.
- Follows the repository pattern: the function is named `forbid_mutation` like the eight existing per-schema guards, which is
  how `delete-tenant-data.mjs` discovers append-only tables.

### Known, accepted consequences
- **Tenant erasure** (`delete-tenant-data.mjs`): audit rows are now *retained and reported* like every other append-only table, and
  the tenant row itself cannot be removed while those rows exist (the existing `ON DELETE RESTRICT`). This is the script's
  designed behaviour for append-only tables; it needs no change.
- A database superuser can still bypass triggers (`session_replication_role = replica`, `ALTER TABLE … DISABLE TRIGGER`) or the
  table owner can drop the trigger. Row-level triggers cannot prevent that; role separation and the migration-gate
  hash discipline are the controls. The application role cannot do either.
- `audit.entity_versions` and `audit.access_events` are documented append-only in 0006 but are **not** covered here (out of the
  authorized scope). Recommend covering them in a follow-up if you want the whole audit schema immutable.

## 3. Allocation record (MIGRATION-ALLOCATION-POLICY)

| Item | Value |
|---|---|
| Predecessor final migration | `0180_create_bo_authorized_action_intake.sql` |
| New range | `0181` (single migration) |
| main at allocation | `5f9c56c7c106f43b3200a38f4da9518bc21fa82f` |
| Open PRs at allocation | none |
| Branches carrying a 0181+ migration | none (all remote heads scanned) |
| SHA-256 of frozen 0001-0180 (concatenated in name order) | `b599ff7f11150433ed3e442511c1a57e99b3fc15c9c7b2c8ff7f9920832465aa` |
| SHA-256 of frozen 0001-0179 (unchanged) | `756c48a85235846f3d274e0a6b094137fcb9f70abf217e496fc4b43c7e613d9d` |
| SHA-256 of `0181_audit_events_append_only.sql` | `b8017f44f90f9ff50271aeace40663980ad8bcf376b1d8a542d426e99823ff83` |
| Empty-install result | clean install 0001→0181 passes the migration gate on a fresh PostgreSQL 16 database |
| Rerun result | idempotent: re-applying 0181 twice succeeds, leaves exactly two triggers and one `_migrations` row |
| Live Supabase | not applied (live 0169; 0170-0181 unapplied) |

## 4. Tests

- `packages/database/tests/migration-0181-audit-append-only.test.ts` — static guards.
- `packages/database/tests/audit-events-append-only.integration.test.ts` — live PostgreSQL: INSERT works, RLS unchanged, UPDATE /
  DELETE / TRUNCATE (plain and CASCADE) rejected for app and admin roles with the row unchanged, exact trigger catalogue,
  idempotent re-run, `GovernanceAuditRepository` regression, rollback behaviour.
- Mutation proofs: 10 of 10 killed (UPDATE/DELETE trigger removed, weakened to UPDATE-only or DELETE-only, TRUNCATE trigger removed, guard function skipping or allowing instead of raising, either idempotency drop removed, trigger disabled after creation, guard bound to an extra table).
