# Data-capture Block B — a present unit cost must be positive (migration 0187)

Status: DRAFT PR. Not applied to live Supabase (live 0169). Blocks A, D, E, B2b/B2c/B2d, P0-6 and any change to the approved rule set
`inventory-reorder-policy/v1.0.0` are NOT part of this block.

## 1. Purpose and invariant

`unit_cost` stays optional. After Block B (with Block C / 0183) the evidence invariant for NEW rows is:

| | unit_cost | unit_cost_currency |
|---|---|---|
| no cost | NULL | NULL |
| cost present | finite, **> 0**, ≥ 0.0001 | present, `^[A-Z]{3}$` |

This block does not implement the B2 COST evaluator and does not make COST pass; it only guarantees that a cost written from now on is a
valid positive amount.

## 2. Survey (read-only, before coding)

| Question | Finding |
|---|---|
| unit_cost writers | exactly one: `OperationalCommandExecutor` (`INSERT INTO business_operations.inventory_movements`) |
| unit_cost readers in production | none (the B2b evaluator does not exist); the digital-twin block's JS `unitCost` is an unrelated model field |
| DAL contract | the DAL publishes `inventory_movement` records; `inventory_movement` mapper v2 validates them; the DAL writes no BO table |
| Mapper before | cost: any finite number (zero and negative accepted); pairing with currency required (Block C) |
| Executor before | pairing and currency format only |
| Database before | pairing (NOT VALID) and currency format (0183); append-only (0184); FORCE RLS (0186) |
| Tests/fixtures relying on zero or negative cost | none found |
| Historical invalid rows | unknown for live (0183+ not applied); none locally; if any exist they stay untouched |

Another production writer would have been a stop condition; none exists.

## 3. Implementation

- **Migration 0187** adds `inventory_movements_unit_cost_positive`: `CHECK (unit_cost IS NULL OR (unit_cost > 0 AND unit_cost <> 'NaN'::numeric)) NOT VALID`.
  - **Finding:** PostgreSQL `numeric` orders NaN above every number, so `unit_cost > 0` alone **accepts NaN**; the live test caught it and the check
    excludes NaN explicitly. `numeric(18,4)` already rejects Infinity.
  - `NOT VALID` still **enforces** the check for every new row; it only skips validating existing rows. It is never VALIDATEd here.
  - Because the column is `numeric(18,4)`, a positive amount below 0.0001 is rounded to 0.0000 by PostgreSQL and is therefore refused by the check too.
- **Shared rule** `packages/business-operations-runtime/src/unitCost.ts` (`unitCostProblem`, `UNIT_COST_MINIMUM_STORABLE = 0.0001`): not finite,
  not positive, or below the smallest storable positive cost. Used by both layers so they cannot drift. Nothing is rounded or coerced.
- **Mapper** (`inventory_movement`, version stays 2): refuses `unitCost_not_positive` and `unitCost_below_minimum_precision`; NaN, Infinity,
  strings and other non-numbers remain `unitCost_invalid`; the Block C pairing is unchanged.
- **Executor** (defence in depth for commands built outside the mapper): refuses non-finite, non-positive and unstorable costs.
- The write path is unchanged: DAL publication → BusinessIntakeService → mapper → `record_inventory_movement` → executor → database. No second cost
  writer, no DAL write, no repair path.

## 4. Allocation record (MIGRATION-ALLOCATION-POLICY)

| Item | Value |
|---|---|
| Predecessor | `0186_force_rls_inventory_movements.sql` (main `4998a64`; last executable main CI, run 38155571371 for `a082468`, SUCCESS; #83/#84 changed docs only) |
| New range | `0187`; no open PR and no remote branch claimed it |
| SHA-256 frozen 0001-0186 | `3eb93de0b523eb00af4e3daf1daa1695e075389b94e141e142fa61e8302bbbfc` |
| SHA-256 frozen 0001-0185 (unchanged) | `1b1e2692c377260a76d07128b0aae5469ffb931e31b5216bfc3f44c07ad0d7f5` |
| SHA-256 of `0187_require_positive_inventory_unit_cost.sql` | `07154e2ad0cb76c35bb4fe7919106922438fb947b347f5f489da345aa263f395` |
| Live Supabase | not applied |

## 5. Historical data

No backfill, repair, rewrite, deletion or currency inference. A historical row with a non-positive cost stays exactly as it is and remains
INDETERMINATE evidence for B2. Proven through the real migration runner on a database holding costs of 0, −7.5 and 3 plus a cost-less row: the row set
is byte-identical before and after, the constraint stays NOT VALID, and a new zero-cost insert is refused.

## 6. Caveats

1. The smallest accepted cost is 0.0001 (the column's scale); finer prices must be expressed per larger unit. Owner decision if a smaller scale is needed.
2. The largest storable cost is bounded by `numeric(18,4)` (pre-existing; unchanged).
3. Existing publishers that send a zero or negative cost are now refused with an explicit reason.
4. Live databases that already hold non-positive costs keep them; they are never validated away.
