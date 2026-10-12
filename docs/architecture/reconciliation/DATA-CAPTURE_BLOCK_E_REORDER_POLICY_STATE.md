# Data-capture Block E — configured versus unset reorder values (migration 0189)

Authorised by owner ruling O-10 (lands before P0-6c). Specification: `DATA-CAPTURE_RECONCILIATION_inventory-cost-receipts.md` §3E.

## Purpose
`reorder_point = 0` meant both "never configured" (every system-created balance) and "deliberately zero". Block E records the difference so
the rule set (C4) and P0-6c can rely on facts.

## What changed
- `business_operations.inventory_balances`: `reorder_policy_state` (`UNSET` default | `CONFIGURED`), `reorder_policy_configured_at` (database time),
  `reorder_policy_configured_source` (`BO_COMMAND` | `AUTHORIZED_ACTION_PACKAGE`); CHECKs: valid values; UNSET ⇔ no configuration facts, CONFIGURED ⇒ time and source.
- BEFORE INSERT/UPDATE trigger: CONFIGURED, `configured_*` and the reorder values of a configured balance change only inside the BO command
  (transaction-local `app.bo_reorder_policy_writer`); CONFIGURED never returns to UNSET. Convention-level guard (any session able to `SET LOCAL`
  could set it); the architecture test pins the single writer in code.
- BO: command `configure_inventory_reorder_policy` in `OperationalCommandExecutor` (the single writer) and `InventoryReorderPolicyService`.
  Needs an existing balance; values finite, ≥ 0, ≤ 4 decimals, never rounded; re-sending identical configured values is a no-op (no UPDATE, no version bump).

## Not done (deliberately)
- **No backfill**: existing rows, including non-zero values, are `UNSET` (Q-D4 needs an owner ruling). No row is read or rewritten.
- No HTTP route, no ABA/DAL path, no evaluator/verifier change (semantics identical; consuming the state is a later, separately ruled step).
- Not applied to live Supabase (head to be re-verified before any live decision).

## Dependencies / extension
P0-6c's `InventoryReorderPolicyExecutionAdapter` will call this same command with `configurationSource: 'AUTHORIZED_ACTION_PACKAGE'`.
