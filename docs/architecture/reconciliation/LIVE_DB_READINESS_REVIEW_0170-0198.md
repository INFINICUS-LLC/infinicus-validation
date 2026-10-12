# Live-database readiness review: migrations 0170-0198 (READ-ONLY; nothing applied, nothing authorised)

Date: 2026-10-12. Repo: `main` at 691fe21 (migrations 0001-0198 contiguous, 198 files). **This review authorises no deployment, no migration, no activation, no role or secret change.**

## 1. Verdict
**Live state is UNVERIFIED, so no apply recommendation can be made today.** The Supabase connector returns no projects (`list_projects` -> `[]`; one organization, `katohuzairu122-png's Org`), so the project reviewed on 2026-10-07 (`infinicus-development`, last ledger row `0169`) could not be re-inspected: it may have been paused, moved, or is outside this connector's scope. The live head is therefore **not assumed**; the last verified value (0169) is 29 migrations old. What follows is the repository-side delta review that the owner can use once live access is restored, plus the pre-flight checks that must be re-run against live first.

## 2. What was and was not checked
| Item | Status |
|---|---|
| Repository migration chain 0170-0198: contiguous, one file per number, no open PR or remote branch with a competing number | verified |
| Fresh-database apply 0001-0198 and re-apply (idempotent) on PostgreSQL 16 | verified in CI and locally for every merged block |
| Live head, live ledger, live row counts, live roles, backups, PITR, exposed schemas | **NOT checkable** (no connector access) |
| PostgreSQL 17 execution of 0170-0198 | **never executed** (CI is 16; live was 17.6 on 2026-10-07) |
| Whether the deployed API connects as a non-BYPASSRLS role | **unknown** (2026-10-07: no such role existed on live) |

## 3. Delta since the last verified live head (0170-0175 were reviewed on 2026-10-07: see `LIVE_MIGRATION_REVIEW_0170-0175.md`)
Classification of 0176-0198 by what they do to a database that already holds data:

| Class | Migrations | Effect on existing rows | Risk |
|---|---|---|---|
| New tables only (RLS, append-only, guards) | 0176, 0177, 0178, 0179, 0180, 0182, 0185, 0191, 0194, 0195 | none (new, empty tables); FKs target existing tables | low |
| Append-only / FORCE RLS added to EXISTING tables | 0181 (`audit.audit_events`), 0184 (`inventory_movements`), 0186 (`inventory_movements` FORCE RLS), 0197 (`purchase_receipts` header) | no rewrite; **after apply, UPDATE / DELETE / TRUNCATE on these tables is refused for every role, the owner included** | **medium: any live job, support script or tenant-deletion routine that updates or deletes these rows breaks** |
| Constraints on existing tables, all `NOT VALID` | 0183 (currency format / presence), 0187 (positive unit cost), 0192 (non-negative reorder values), 0193 (execution result vocabulary, on a table never applied to live) | history is not scanned or judged; only new writes are checked | low |
| Columns / constraints on existing tables, validated at once | 0189 (3 columns on `inventory_balances`; defaults `UNSET`, so every existing row satisfies the CHECKs), 0190 (`outbox_events.claimed_at` + partial index), 0198 (nullable `purchase_order_line_items.inventory_item_id`, FK, partial indexes) | constant default / NULL; brief locks; existing non-zero reorder values stay `UNSET` (no backfill, by ruling) | low |
| Behaviour change | 0183 drops the `purchase_orders.currency_code` DEFAULT: any writer that relied on the silent `USD` default now has to supply a currency | none to rows | **medium: confirm no live publisher omits the currency** |
| Function / trigger replacement | 0188 (approval-decision immutability), 0192 + 0189 (reorder writer guard), 0196 (SECURITY DEFINER governed writers, revokes direct privileges when `grant-app-role.sh` runs), 0198 (replaces the 0197 receipt-line guard) | none to rows | low, but see section 4 |

## 4. Findings that need an owner decision
**A. Application role.** Migrations 0195-0196 harden writes for the *application role* (no direct activation insert, no direct `reorder_point` / `reorder_quantity` update, governed functions only). If live still has no least-privilege application role (true on 2026-10-07), the application connects as `postgres`/`service_role`, and the `grant-app-role.sh` revocations never apply. The triggers and the SECURITY DEFINER checks still hold for every role, but the privilege-level hardening is only real once the role exists and `grant-app-role.sh` has run. Creating the role is outside these migrations and is not authorised here.

**B. Execute grants to Supabase roles.** 0171 and 0196 `REVOKE ... FROM PUBLIC` but do not revoke from `anon` / `authenticated` / `service_role`. On 2026-10-07 `data_acquisition.emit_outbox_event` was found executable by `anon`, which shows Supabase default privileges grant EXECUTE on new functions to those roles. The 0196 functions are self-protecting (they require the transaction tenant/workspace setting, `bo:admin`, and an active membership), and `business_operations` is not expected to be exposed through PostgREST, so the risk is low, but it is a defence-in-depth gap. Recommend (separately authorised, environment step, not a migration per repository policy): revoke EXECUTE on the governed functions from `anon` / `authenticated`, and confirm the exposed-schemas list excludes `business_operations`, `audit` and `events`.

**C. Append-only side effects (0181 / 0184 / 0186 / 0197).** Before applying, search live code paths, jobs and operator runbooks for UPDATE / DELETE of `audit.audit_events`, `business_operations.inventory_movements` and `business_operations.purchase_receipts`. Tenant deletion for the platform is covered by `delete-tenant-data.mjs` (it knows the append-only convention); ad-hoc SQL is not.

**D. Currency default (0183).** Confirm every live purchase-order publisher sets `currencyCode` explicitly; the runtime executor already requires it, so this matters only for direct SQL or an older deployed build.

**E. Ledger integrity (carried over).** `public._migrations` stores filenames only, so live schema cannot be proven byte-identical to the repository. Section 6 lists SHA-256 hashes of 0170-0198 for the owner to compare against any copy of the applied files. The 2026-10-07 findings on the writable ledger (RLS off, `anon` / `authenticated` DML) and on PostgreSQL 17 vs 16, backups / PITR and the migrate-then-deploy order remain open and unchanged by this block.

**F. Application deploy order.** Migrate first, then deploy the application: every new column is nullable or defaulted, so old code on the new schema is safe; new code on the old schema fails (receipt writes need 0197-0198, governed activation / reorder needs 0196).

## 5. Pre-flight for the owner (none executed here)
1. Restore or locate the live project; re-run the read-only checks (ledger last row and count, existing tables, row counts of `audit.audit_events`, `inventory_movements`, `purchase_receipts`, `inventory_balances`).
2. Decide A-D above; confirm backup / PITR and record the restore point.
3. Rehearse the pending range on a restored copy / branch running PostgreSQL 17.6 with `migration-gate.sh`, then `grant-app-role.sh`, then the RLS and append-only smoke checks.
4. Apply only after explicit written authorisation; migrate first, deploy second; production activation stays OFF throughout.
5. Forward-only rollback: no down migrations exist; restore from the recorded point, or add forward fixes (never edit applied files).

## 6. SHA-256 (first 16 hex) of migrations 0170-0198 at main 691fe21
| File | SHA-256 prefix |
|---|---|
| `0170_add_approved_action_source_recommendation.sql` | `d1b392389ed80106` |
| `0171_create_da_webhook_token_lookup.sql` | `600c3a1d8b2d6095` |
| `0172_create_business_event_ledger.sql` | `f038a448b8d170ef` |
| `0173_harden_eventing_scope.sql` | `ea779db00bf2c339` |
| `0174_add_adi_recommendation_risk_validity.sql` | `54dffa00c377155f` |
| `0175_add_aba_review_version_snapshot.sql` | `8a24ae97018cf0f6` |
| `0176_create_authorized_action_packages.sql` | `29900b224d61e05b` |
| `0177_create_authorized_action_capture.sql` | `9cef41a3cb017532` |
| `0178_create_action_governance.sql` | `53f292008660ba55` |
| `0179_create_authorized_action_boundaries.sql` | `f461f7d4a98f59d2` |
| `0180_create_bo_authorized_action_intake.sql` | `57bcc8deb3d41e39` |
| `0181_audit_events_append_only.sql` | `b8017f44f90f9ff5` |
| `0182_create_bo_inventory_policy_evaluations.sql` | `912b33288589e69c` |
| `0183_add_explicit_currency_to_inventory_costs.sql` | `ea792e6ff393386f` |
| `0184_inventory_movements_append_only.sql` | `4b53782b1ce7da79` |
| `0185_create_business_currency_declarations.sql` | `8a57059c708c1cd6` |
| `0186_force_rls_inventory_movements.sql` | `fd97c171aa96d576` |
| `0187_require_positive_inventory_unit_cost.sql` | `07154e2ad0cb76c3` |
| `0188_freeze_decided_approval_decisions.sql` | `11ef3c8aee6a2a3d` |
| `0189_add_inventory_reorder_policy_state.sql` | `d87841d4dd9e37b6` |
| `0190_add_outbox_claimed_at.sql` | `9ed075efa8cf4049` |
| `0191_create_bo_authorized_action_executions.sql` | `f8ee1fcebba749ed` |
| `0192_guard_inventory_reorder_fields.sql` | `38b598d08fee409c` |
| `0193_align_execution_mutation_result_vocabulary.sql` | `1b9de9151d624a2f` |
| `0194_create_om_action_execution_verifications.sql` | `1aad7a4811bc9288` |
| `0195_create_bo_execution_capability_activations.sql` | `cf6cb3e71b028358` |
| `0196_harden_database_authority_activation_and_reorder.sql` | `05c6c0ebe9fde677` |
| `0197_create_purchase_receipt_lines.sql` | `20f43249d0240a3a` |
| `0198_link_purchase_order_lines_to_inventory_items.sql` | `abd49c0d51dd8a6a` |

## 7. Not done
No live query, no migration, no role / grant / secret / Cloudflare / DNS change, no activation, no backfill, no deployment. The live head was not assumed.
