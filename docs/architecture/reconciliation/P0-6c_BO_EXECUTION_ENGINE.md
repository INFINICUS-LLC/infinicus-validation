# P0-6c — Business Operations execution engine (migrations 0191, 0192)

Programme Phase 5 (rulings O-2, O-3, O-4, O-7, O-8, O-11, O-12). **Built and unwired**: nothing calls the engine, no event is emitted, the production capability registry is still empty, no activation exists. A claim becomes an execution only when a later block (P0-6e) wires the trigger and the governed gate.

## What a claim is, and is not
A BO claim (`CONSUMED`) means "BO took this package version for ONE execution attempt". It confers **no authority**. The engine re-establishes authority, under locks, every time.

## The engine (`AuthorizedActionExecutionService.executeClaim`)
One tenant transaction per attempt:
1. per-claim advisory lock; a claim that already has a terminal outcome returns it (**replay is idempotent**);
2. re-verify BO's immutable copy of the sealed package (structure + digest) and that it is the claimed one; read target and values from it only;
3. refuse unsupported action types (BO capability registry) and a **closed or throwing activation gate** (`CAPABILITY_DISABLED`);
4. **lock the target balance row `FOR UPDATE`**; none → `NO_BALANCE`, several → `TARGET_AMBIGUOUS` (no balance is ever created, no warehouse guessed);
5. **only then** ask ABA's status provider (a lock wait cannot age the answer); judge it against the **database clock** with `validateForExecutionAfterClaim`: about this exact id/version/digest, age ≤ `executionStatusMaxAgeMs` (required argument, no default; the composition root supplies 5000, O-2), lifecycle `ISSUED` or `CONSUMED`-by-THIS-receipt, current version, in window, unexpired, in scope, supported, and authority `CURRENT` and fresh;
6. runtime preconditions in BO's vocabulary (`stock_available`; an unknown code/operator/operand is `UNSUPPORTED_PRECONDITION` — never ignored);
7. **baseline compare-and-set (O-4)**: a modified approval's baseline is the persisted snapshot of BO's own evaluation records (each bound to this target and these parameters by subject digest; all four must agree on the one balance); a plain approval has none → `NO_BASELINE_EVIDENCE`; a live balance that differs → `BASELINE_CHANGED` (the newer state is never overwritten);
8. mutation through the **single BO writer** (`configureInventoryReorderPolicy`, source `AUTHORIZED_ACTION_PACKAGE`, with `expectedBaseline` and a `WHERE` guard) behind a savepoint, or a recorded **no-op** (`NO_CHANGE`: no UPDATE, no version bump, state untouched — O-12);
9. the terminal execution row (with the sealed evidence document and digest) and the audit row, in the **same transaction**. A crash rolls everything back: there is no durable "started but unknown" state.

Outcomes: `SUCCEEDED` (`APPLIED`/`NO_CHANGE`), `REFUSED` (deterministic; nothing mutated), `FAILED` (deterministic rejection of the mutation, or operational retries exhausted). Terminal rows are never re-driven; a new authorization is the only way to try again (O-3).

## Retries and recovery (O-3, constants in `constants.ts`)
"Could not find out yet" (status unavailable/stale/wrong, authority unverifiable, operational error) is an **attempt row**, not an outcome. At most 3 attempts; backoff 1 s / 5 s / 15 s; a claim with no outcome and no attempt is recovered 60 s after it was claimed (`runDue`). Exhaustion writes a terminal `REFUSED(RETRIES_EXHAUSTED)` (authority/status) or `FAILED(RETRIES_EXHAUSTED)` (operational).

## Database (migration 0191)
`authorized_action_executions` (one terminal row per claim, **and** per package version) and `authorized_action_execution_attempts`: append-only for every role, RLS forced, database-clock stamped. The database itself enforces: the execution matches its claim (receipt, package, digest, scope, claim time) and the receipt's action type/target; `SUCCEEDED` requires verdict `CURRENT`, recorded status/authority verification times, a balance and the before/requested states (no success without proven authority); `REFUSED/FAILED` require `NOT_APPLICABLE` and a reason; no attempt may follow a terminal row. No threshold is encoded in SQL.

## M3 (migration 0192, ruling O-11)
Any change to `reorder_point`/`reorder_quantity` — an UNSET balance included — requires the transaction-local marker that only the BO configure command sets, so "the adapter/command is the only writer" is a database fact (convention-level: any session able to `SET LOCAL` could set it). `CHECK (reorder_point >= 0 AND reorder_quantity >= 0) NOT VALID`: new/updated rows are checked, existing rows are never scanned or rewritten.

## Accepted limits (stated, not hidden)
- **Residual race (planning section 7):** authority verified CURRENT and revoked before commit cannot be told apart from a revocation just after commit; the evidence records `statusVerifiedAt`, so the exposure is provable and bounded by `executionStatusMaxAgeMs` plus commit time.
- A **no-op leaves the balance `UNSET`** (O-12 forbids an UPDATE); the execution row is the record that the policy was authorized to equal the live values.
- The evidence document is built and sealed here; P0-6d standardizes the shared `execution-evidence/1` contract/validator for exactly this shape and adds the OM verification.
- Budget, rollback and monitoring are **record-only** (O-8): copied into the evidence, never enforced.

## Not done
No wiring, event, worker trigger, activation, registry entry or live-DB change. `PRODUCTION_SUPPORTED_ACTION_TYPES` is empty. No OM intake.
