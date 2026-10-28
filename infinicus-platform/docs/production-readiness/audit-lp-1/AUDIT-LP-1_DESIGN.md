# AUDIT-LP-1 — Least-Privilege Design for `audit.access_events`

**Update (RP-17): option B is implemented in the repository; production is unchanged.** Changes: `grant-app-role.sh` revokes `UPDATE, DELETE, TRUNCATE` on `audit.access_events`
(guarded by `to_regclass`, in the hardening block after the blanket grants); `delete-tenant-data.mjs` erases that table's rows for the tenant over the admin connection with an explicit
`tenant_id` predicate (`ADMIN_ERASED_TABLES`), never a blanket delete and never `tenant_id IS NULL`. Tests: static grant/erasure assertions
(`audit-lp-1-access-events-authority.test.ts`), live privilege proof (`audit-lp-1-access-events-privileges.integration.test.ts`: INSERT/SELECT granted; UPDATE, DELETE, TRUNCATE refused with 42501;
the repository still records and counts events) and a live erasure test with another tenant's and a tenantless event that must survive (`delete-tenant-data.integration.test.ts`).
Mutants caught: dropping the revoke, dropping the admin pass (the existing full-footprint erasure test also fails against revoked grants), deleting without the tenant predicate.
Decisions taken as the status quo, not invented: D1 erase (current behaviour), D2 tenantless rows untouched (no purge rule), D3 exit code of the erasure script unchanged (0 on partial erasure, still a hazard
for monitoring), D4 AUDIT-AO-1 not started, D5 partly answered by RP-12A (no cron entry or timer references the table; root's crontab unchecked).
Production rollout is a separate authorized change, §8; note that the operators' copy of `delete-tenant-data.mjs` on the VM is the 2026-10-13 version (stale `/opt/infinicus/repo`), so the new copy must be
delivered with the release export before the revoke is applied.

Status: DESIGN AND DOCUMENTATION ONLY. Nothing here was applied to production or to any shared environment. Rehearsals ran on a disposable local
PostgreSQL 16 database built from the repository migrations (0220 applied), with synthetic tenants.
Authorization: owner authorized the AUDIT-LP-1 design. Implementation, production change and the follow-on AUDIT-AO-1 each need separate authorization.
Independence: this block is NOT part of the AUTH-LOCKOUT-1 isolated release and must not be bundled with it.
Labels: VR = VERIFIED — REPOSITORY, RH = VERIFIED — REHEARSAL, OO = OWNER-OBSERVED — PRODUCTION, INF = INFERRED, UV = UNVERIFIED.

## 1. Problem

OO (RP-04R baseline, not re-observed): `app_role` holds SELECT, INSERT, UPDATE and DELETE on `audit.access_events`; the table has RLS enabled (not forced) and no
user triggers or rules. VR: the grant script gives the application role `SELECT, INSERT, UPDATE, DELETE` on every table of every schema and contains no rule for
this table, so the privileges follow from the blanket grant, not from a decision. The same table carries the failed-login events that drive the lockout counter
(`countRecentFailedPasswordAttempts` counts `failed_auth` rows whose `metadata.reason = 'bad_password'`), and it stores IP address and user agent.

Consequence: any code path or compromised credential running as the application role can delete or rewrite the evidence that bounds password guessing, and can
alter the security history. No application code needs that ability (see §2).

## 2. What the application actually does with the table (VR)

| Access | Where |
|---|---|
| INSERT | `AccessEventRepository.record` (auth outcomes, permission denials) |
| SELECT | `AccessEventRepository` list by user, `countRecentFailedPasswordAttempts` |
| UPDATE | none found in `packages/*/src`, `apps/*/src` |
| DELETE | none in application source. One operational path: `infrastructure/database/scripts/delete-tenant-data.mjs` (tenant erasure) deletes through the **application-role connection** (`DATABASE_URL`) |
| TRUNCATE | not granted by the blanket grant (rehearsal: not granted) |

## 3. Key finding: revoking DELETE breaks tenant erasure (RH)

`delete-tenant-data.mjs` discovers tenant-scoped tables from `pg_policies`, treats tables with a `forbid_mutation`-style trigger as "append-only: retained, not
deleted", and deletes every other table with `DELETE ... WHERE tenant_id = '<tenant>'` over the application-role connection. `audit.access_events` has no such
trigger, so today it is erased with the tenant. Rehearsal on a seeded tenant with two access events:

| Case | Result |
|---|---|
| A. Current grants | `Deleted tenant …`; access events 0 left; tenant row removed; exit 0 |
| B. `REVOKE UPDATE, DELETE, TRUNCATE` from the application role | `Could not delete … audit.access_events`; `Partially erased tenant …`; **2 access-event rows and the tenant row remain; process exit code 0**; application INSERT/SELECT unaffected |
| C. B plus an admin-side `DELETE … WHERE tenant_id = <tenant>` done beforehand | data gone and tenant row removed, but the script still reports `Could not delete` / `Partially erased` because it still attempts the delete as the application role |

Therefore a naive revoke would silently turn right-to-erasure into partial erasure (and the script reports partial erasure with exit code 0, which monitoring
may not notice). The revoke and the erasure change must ship together, and the script must be the one that carries the production operators' copy
(the production checkout used `ccadbf51`'s older script, OO/INF — to be confirmed by the RP-12A output).

## 4. Options

| Option | Content | Verdict |
|---|---|---|
| A | Revoke `UPDATE`, `TRUNCATE` only | Safe and tiny (no application or erasure impact) but leaves DELETE, i.e. leaves the lockout-reset and evidence-removal path open. Acceptable only as an interim step. |
| **B (recommended)** | Revoke `UPDATE`, `DELETE`, `TRUNCATE` from the application role; erase a tenant's access events over the **admin connection** with an explicit tenant filter | Closes the gap and preserves erasure. Needs a script change, tests and the decisions in §7. |
| C | B plus a database trigger refusing UPDATE/DELETE/TRUNCATE for every role (AUDIT-AO-1) | Strongest, but the erasure script then classifies the table as retained append-only and would stop erasing personal data (IP, user agent). Needs a retention/erasure policy first (e.g. erase vs anonymise); not designed here beyond this note. |

## 5. Design of option B (not implemented)

1. **Grant script** (`infrastructure/database/scripts/grant-app-role.sh`, protected-table block, same pattern as `order_events`): after the blanket grants,
   `IF to_regclass('audit.access_events') IS NOT NULL THEN REVOKE UPDATE, DELETE, TRUNCATE ON audit.access_events FROM <app role>`. Idempotent, guarded, re-applied on every
   run so a rerun cannot reopen the privilege. No migration (migrations contain no GRANT/REVOKE by repository rule, VR).
2. **Erasure script:** introduce a small, explicit list of tables erased over `ADMIN_DATABASE_URL` (initially only `audit.access_events`): excluded from the
   application-role delete set, deleted with `WHERE tenant_id = '<tenant>'` (never `IS NULL`, so shared pre-auth rows and other tenants are untouched), counted and
   verified in the existing post-delete check, and recorded in `platform.data_deletion_events` like the other tables. Decision D3 below covers the exit code.
3. **Rows with `tenant_id IS NULL`** (pre-authentication events such as unknown-email attempts) are not tenant data and are not touched by tenant erasure.
   Their retention is decision D2; no period is proposed here.
4. **Application behaviour:** unchanged; `AccessEventRepository` needs only INSERT and SELECT.

## 6. Verification plan (to be built in the implementation block)

- Static test of the grant script, in the style of `migration-0212-membership-roles-file-children-rls.test.ts` (rule present, guarded, after the blanket grants).
- Live test in the style of `DatabaseAuthorityHardening.integration.test.ts`: application role can INSERT and SELECT; UPDATE, DELETE and TRUNCATE fail with SQLSTATE 42501; a
  second grant-script run keeps it that way.
- Erasure integration test extended with `audit.access_events` rows: tenant's rows removed, another tenant's rows and `tenant_id IS NULL` rows untouched, run reports
  complete erasure, `data_deletion_events` records it; a negative test proving that a failed access-event deletion is reported as incomplete.
- Lockout non-regression: `AccessEventRepository` and the lockout integration tests (DB-02) pass with the revoked grants.
- Event-worker authority architecture test (`databaseAuthority.architecture.test.ts`) updated if it enumerates protected tables.
- Whole-suite run on a disposable database, as in RP-09/RP-11.

## 7. Open decisions for the owner (nothing assumed)

| ID | Decision |
|---|---|
| D1 | Is `audit.access_events` tenant personal data to be **erased** on tenant erasure (current behaviour), or must it be **retained** for a period? Option B assumes erase. |
| D2 | Retention/purge rule for `tenant_id IS NULL` rows (who purges, after how long, under which role). No value is proposed. |
| D3 | Should `delete-tenant-data.mjs` exit non-zero on partial erasure? Today it exits 0 (rehearsal case B); changing that alters operator tooling. |
| D4 | Authorize AUDIT-AO-1 (trigger-enforced append-only) after D1/D2, or stop at option B? |
| D5 | Does any scheduled job or operator process outside the repository delete or update rows in this table as `app_role`? The RP-12A discovery output (cron/timer references) should answer this; UV today. |

## 8. Production rollout outline (not authorized; separate release record required)

1. Update the operators' copy of `delete-tenant-data.mjs` first (it must be the version that erases `audit.access_events` over the admin connection).
2. Take/confirm a fresh backup and restore proof (same gate as the AUTH-LOCKOUT-1 release).
3. Apply the revoke as a single admin transaction (one `REVOKE` statement), verify with `has_table_privilege`, rather than re-running the whole grant script from a newer
   checkout, which would also reapply unrelated grants (VR: the script re-applies blanket grants and default privileges to every schema).
4. Verify: INSERT/SELECT still granted, UPDATE/DELETE/TRUNCATE not; logins and lockout still work (synthetic account on a disposable stack first).
5. Rollback: `GRANT UPDATE, DELETE ON audit.access_events TO <app role>` in one transaction; no data or schema change is involved.
6. Sequencing: after the AUTH-LOCKOUT-1 release (0220 and the RC image) is stable; this change has no dependency on it and must not ship in the same window.

## 9. Evidence and gaps

- VR: grant script, repository code paths, erasure script behaviour (source read).
- RH: the three erasure cases in §3 (local disposable database; scratch tenants; grants restored afterwards; database dropped).
- OO only: production privileges and absence of triggers.
- UV: production usage by cron/timers, operator copy of the erasure script, any off-repository job touching the table.
- Not done: no implementation, no test written, no change to the grant or erasure script, no production access.
