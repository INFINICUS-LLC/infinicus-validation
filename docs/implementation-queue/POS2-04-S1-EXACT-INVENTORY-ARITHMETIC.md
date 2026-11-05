# POS2-04-S1: exact-decimal inventory balance arithmetic

Workstream: INFINICUS POS 2.0 / Business Operations inventory. Baseline: `main` at `095a32e1`. Status: DEVELOPMENT, draft. No migration, no deployment, nothing activated. This is step S1 of the minimum safe sequence in `POS2-04-ARCHITECTURE-RECONCILIATION.md`; it changes arithmetic only.

## 1. Baseline (verified)

- `main` = `095a32e1`. #430 (POS2-03) and #431 (POS2-04 decision record) are both **merged** (`8651ed9f`, `6d7a2ebf`), not draft as the authorizing prompt assumed. Latest migration is 0226; this block adds none.
- No other branch has corrected the writer: every branch that touches `OperationalCommandExecutor.ts` is an October branch, and none contains exact balance arithmetic.
- The writer is `OperationalCommandExecutor.applyInventoryMovement`, the single movement-and-balance writer (guarded by `ac2-bo-canonical-writer.architecture.test.ts`). It is unchanged in location and contract.

## 2. What was wrong

The writer read `quantity_on_hand`, added the movement in JavaScript (`Number(on_hand) + delta`, `Math.abs`), compared with `< 0`, and wrote JavaScript numbers back. The columns are `numeric(18,4)`, so the database rounded whatever it was given. Running the new tests against the original writer, 28 of the 42 integration tests fail (the maximum quantity and its overflow, every excess-scale, range and invalid-text refusal, signed adjustments and cycle counts given as text, the keyed path, and the large-balance case), while the cases with small values written as numbers happen to pass. This corrects the earlier planning note: for small values the stored result was usually right; the defects are that exact text could not be passed at all, that the maximum and large balances could not be held exactly, that more than four decimals was silently rounded by the database in the ledger while the in-memory delta used the unrounded value, and that out-of-range values surfaced as raw database errors.

## 3. What changed

- New pure module `inventory/inventoryQuantity.ts`: `parseMovementQuantity`, `movementDelta`, `nextOnHand`, built on the existing exact `Decimal` (BigInt over a power-of-ten scale) used elsewhere in the package.
- The writer validates the quantity before the first SQL statement; reads the locked balance as database text (`quantity_on_hand::text`); computes the new balance exactly; refuses a negative result (message unchanged) or a result of 10^14 or more (new deterministic message); and writes the movement quantity, the new balance and the event quantity as exact `::numeric` text. Nothing passes through JavaScript `Number` arithmetic.
- `RecordInventoryMovementCommand.quantity` is now `number | string`. Text must be plain decimal (sign, digits, optional fraction; no exponent, spaces or separators). A number is accepted only through its shortest round-trip text (the value a person wrote), the convention already used by the package.

## 4. Behaviour that changes (intentional)

| Input | Before | Now |
|---|---|---|
| More than four decimal places (non-zero beyond the 4th) | accepted; the database rounded the ledger row while the balance used the unrounded delta | refused, deterministic message, no effect |
| 10^14 and above, including unsafe integers | database overflow error or a lossy double | refused, deterministic message, no effect |
| Not a finite decimal (text with exponent or spaces, NaN, objects...) | undefined behaviour | refused, deterministic message |
| Exact decimal text | not supported | supported and exact |
| Balance result at 10^14 or above | database overflow error | refused, deterministic message |

Trailing zeros beyond the fourth place are the same value and are accepted (`0.30000` = `0.3000`). Zero stays accepted at executor level, as before (the intake mapper still rejects it).

## 5. Behaviour that does not change

Movement-type semantics (receipts, transfers in and returns add the magnitude; issues, transfers out and write-offs subtract it; adjustments and cycle counts are signed); the movement stores the quantity as given; the non-negative balance rule and its message; the balance row lock (`FOR UPDATE`) and the single atomic transaction; the event emitted; scope checks (item and warehouse must belong to the business); RLS; the append-only ledger; no idempotency identity was added; the intake mapper, purchase-receipt path and reorder-policy path are untouched. No schema change was needed: the columns are `numeric(18,4)` (verified), `quantity_available` is generated, and non-negativity is enforced by the writer, not a CHECK.

## 6. Evidence

- 12 unit tests on the pure module (parsing, ranges, sign semantics, float traps, static guard that the writer has no `Number(`/`Math.abs` on a quantity).
- 42 live PostgreSQL tests as the application role: `0.1+0.2=0.3000` (text and numbers), `1.0000-0.0001=0.9999`, `0.0001+0.0001=0.0002`, the maximum `99999999999999.9999` held exactly and `+0.0001` refused with nothing changed, `0.0000-0.0001` refused, large-balance last digit, all refusals, movement-type semantics, the keyed path, rollback and retry, 40 concurrent mixed movements ending at the exact committed result, concurrent issues against too little stock (exactly the affordable ones commit), cross-business and cross-tenant refusal, row-level security, and the schema assumptions. Comparisons are exact database text.
- 9 mutation proofs, each failing tests: negative check removed, overflow check removed, scale check removed, range check removed, issue sign flipped, row lock removed, movement quantity rounded through `Number`, balance written through `Number`, text quantities taken through `Number`.

## 7. Not done, by design

No sale-effect consumer, mapping, shortage semantics, refund, restoration or POS change; no change to DAL contracts or the intake mapper (a movement with excess scale now fails at execution with a deterministic `OperationalMappingError`; pre-validating it in the mapper is a separate, optional change). Reserved quantity and the generated available quantity are untouched. S2 onward (mapping, effect record, command, consumer) still waits for the owner rulings in the reconciliation document.

## 8. R1 independent review (POS2-04-S1-R1)

Review of the merged-with-main head `072725e4` (hosted CI green, no concurrent change to the executor or `inventory/` on `main`). Two defects in the first implementation were demonstrated by executable probes and fixed; everything else was retained unchanged.

- **D1, a number with more than 15 significant digits was silently altered.** A double reproduces a decimal only up to 15 significant digits. `12345678901234.5678` arrives as the double `12345678901234.568` and was accepted as that; `12345678901234.567` became `12345678901234.566`. Such numbers are now refused (`unsafe_number`, "pass it as exact decimal text"); exact text is accepted. Numbers with up to 15 significant digits are unchanged.
- **D2, unbounded text input.** A text quantity of `0.` followed by 100,000 zeros and a `1` took about 8 seconds to refuse; a million digits took about 260 ms. Text longer than 64 characters is now refused before any parsing (`too_long`); the longest valid quantity is 20 characters.
- **Retained and verified by execution:** the row lock, reading the balance as database text, atomic movement-and-balance update, validation before SQL, scope checks, RLS, and the event contract. New tests show a committed movement emits exactly one `bo.inventory.movement_recorded` event whose payload carries the exact quantity, and a refused or rolled-back movement emits none.
- **Only consumer of the widened `quantity: number | string`** is the movement writer (the other `quantity` reads are a different command).
