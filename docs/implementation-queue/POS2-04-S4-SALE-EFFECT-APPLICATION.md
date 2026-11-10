# POS2-04-S4 — Unwired canonical sale-effect application and durable outcomes

Development only. Starting baseline PR #437 merged into main at `59c32584`. Migration `0230_pos_inventory_sale_effect_outcomes.sql` is additive.

The S4 command `OperationalCommandExecutor.applyPosSaleEffectOn` is intentionally **not** part of `OperationalCommand`, the published-record intake mapper, public API or scheduling. It takes an existing PostgreSQL transaction client with privileged Business Operations authority. The method refuses to run outside a transaction because its first operation is a SAVEPOINT. S5 must separately establish an authorized trusted workload before calling it.

Source: only immutable S3 evidence. The command locks the effect, checks existing terminal outcome, revalidates order completion and S2 mapping/item/warehouse, and locks inventory availability. One success writes through the **existing** `applyInventoryMovement` routine, recording `issue`/`order_line` against the original line. S4 never writes the movement or balance directly.

The outcome is an immutable terminal record with unique effect ID and optional matching canonical movement; successful movement and outcome share the caller's transaction. No additional movement may result from replay because the effect row lock serializes callers and the unique outcome persists. Insufficient available stock creates one durable `INSUFFICIENT_STOCK` exception and no movement, and leaves the POS sale completed. Correction/recovery is NOT implemented; no existing terminal record is overwritten.

Application roles have **no direct SELECT/INSERT/UPDATE/DELETE** on outcome evidence, re-applied through grant script. S4 does not grant privileged execution to them. FORCE RLS, composite source/movement scope foreign keys, DB uniqueness, append-only protection and source snapshot matching apply.

Limitations: S3 catalogue-note trust must be verified before S5 activation. No retry/settlement protocol after an exception is in S4. Tenant export must use its separately restricted read-only export principal. Later activation needs independent security review of caller privileges, workflow provenance and manual erasure policy. No deployment, merge, processor or scheduling is authorized.

Verification: disposable PG16, both DATABASE_URL and ADMIN_DATABASE_URL, CI-equivalent grants and FORCE RLS. Run the S4 integration suite with S1-S3 regressions and exact-head hosted CI. Absence of a local execution result is UNKNOWN, never PASS.
