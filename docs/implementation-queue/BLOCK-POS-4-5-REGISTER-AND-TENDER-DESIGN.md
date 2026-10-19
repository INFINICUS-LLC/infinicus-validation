# BLOCK POS-4 / POS-5: register link and payment (tender) capture: design proposal

Status: **PROPOSAL for owner decision. Docs only. No code, no migration, no production action.** Written 2026-10-19 after POS-1 to POS-3 and POS-1.5 were merged. Migration numbers below are provisional: they must follow whatever head exists after the 0199-0201 release (Phase W).

## 1. Verified current state (read from the repository, not assumed)

| Area | Fact |
|---|---|
| Register sessions | `business_operations.register_sessions` (0165-0168): `opening_cash`, `closing_cash`, `expected_cash`, `variance`, `status open/closed`, RLS on tenant and workspace. **One open session per business**, enforced in `RegisterSessionRepository.open` (the `register_name` column is not part of that rule). API: open, get open, close, list (`bo:write` to change, `bo:read` to read, idempotency key on writes). |
| Close formula | `expected_cash = opening_cash + SUM(business_events.amount WHERE event_type='sale' AND business_id=? AND occurred_at >= opened_at)`. It counts **every sale of the business as cash**, including sales that happened on another register, and it has no upper bound at `closed_at`. The source comments call it a placeholder until payments exist. |
| Orders | `platform.orders` has no register-session id and no payment columns. Currency is now set from the declared currency (POS-1.5). |
| Complete | One tenant transaction: order status to `completed`, an `order_events` row, and a `business_events` `sale` row. No payment fields anywhere (`business_events` has only amount, quantity, notes). |
| Money rounding | `OrderRepository` rounds line totals with `round2` (2 decimals). The web `formatAmount` always shows 2 decimals. |

## 2. Finding that blocks tender capture: currencies are not all 2-decimal

The owner trades in Kuwait. **KWD has 3 decimal places** (1 dinar = 1000 fils); JPY has 0. With `round2`, a line of 1 x 0.125 KWD is stored as 0.13 (or 0.12), and the screen cannot show 0.125. Tender amounts, change and cash reconciliation must be exact, so this has to be fixed first.

Proposal **POS-1.6 (code only, no migration)**: one small table of ISO 4217 minor-unit exponents in the shared code (default fails closed for an unknown currency), used by `OrderRepository` (line and total rounding) and by the web display and input. Columns are already `numeric(18,4)`, so 3 decimals fit without a migration. Tests for KWD (3), USD (2) and JPY (0).

## 3. Proposed design

### 3.1 POS-4: register link
- `ALTER TABLE platform.orders ADD COLUMN register_session_id uuid REFERENCES business_operations.register_sessions(id)` (nullable: existing orders stay NULL). Index on it.
- `ALTER TABLE business_operations.register_sessions ADD COLUMN currency_code text` (nullable for old rows; format check `^[A-Z]{3}$`). The application fills it at open from the business's declared currency and fails closed (409) if undeclared, so opening cash and tenders share a currency.
- **Creating an order requires an open register session** (409 with a plain code if none); the order stores that session id. Completing re-checks that the session is still open (409 otherwise), so a sale cannot land in a closed session.
- New read endpoint: session summary (opening cash, order count, tender totals by method, expected cash).
- Web: open and close register on the counter, with the float and the counted cash typed in the business's currency.

### 3.2 POS-5: tender capture (append-only)
New table `business_operations.order_payments`:

| Column | Rule |
|---|---|
| id, tenant_id, workspace_id, business_id, order_id (FK `platform.orders`), register_session_id (FK) | RLS on tenant and workspace, same policy pattern as the other BO tables |
| method | `cash`, `card` or `other` |
| currency_code | must equal the order's currency (checked in the transaction) |
| amount_tendered | `> 0`, what the customer handed over |
| amount_applied | `> 0`, the part counted against the order; `<= amount_tendered` |
| change_given | `amount_tendered - amount_applied`; **only non-zero for cash** (CHECK) |
| reference | optional text, at most 64 characters, for a slip number. **Never a card number**: the application rejects any run of 13 or more digits. No card data is processed or stored. |
| created_by, created_at, correlation_id | actor and trace |

- **Append-only:** UPDATE and DELETE are refused by trigger, like other ledgers. There is no edit path; a mistake before completion is avoided by recording tender only inside the completion transaction.
- **Recorded only inside `complete`:** `POST .../orders/:id/complete` takes `{ payments: [{ method, amountTendered, reference? }] }`. In the same transaction the server computes `amount_applied` and change, requires `SUM(amount_applied) = order total` exactly (split tender allowed), and writes the payment rows, the order event and the sale event together. So **no payment row can exist without a completed order**, and a voided order has none.
- **Fail closed:** `complete` without payments is refused (400) once POS-5 ships. This is a deliberate change to the API; the only client is the counter, and current data is test data.
- **Close formula replaced:** `expected_cash = opening_cash + SUM(amount_applied) of cash payments WHERE register_session_id = this session`. Card and other totals are reported separately and are not counted as cash. Change given is already excluded. Other registers and other sessions no longer leak in.
- Web: the "Complete sale" confirmation becomes a tender step: choose method, enter the amount tendered, see the change due, confirm.

### 3.3 Migrations (additive; provisional numbers)
`0202` order_payments table; `0203` its indexes; `0204` its RLS; `0205` its append-only triggers; `0206` `orders.register_session_id` and `register_sessions.currency_code`. Every statement is additive, so rolling the code back leaves harmless unused columns and an empty table. Each file follows the existing `_migrations` ledger convention and goes through `migration-gate.sh`. The app role must get SELECT and INSERT on `order_payments` (the grant script is re-run in the window); the trigger, not the grant, enforces append-only.

### 3.4 Order of work
1. **POS-1.6** minor units (code only; can ship any time).
2. **Release window** (after Phase W): apply 0202-0206 on production only with the owner's authorization, fresh backup first, then deploy code.
3. **POS-4** code (register link, summary, web register screens).
4. **POS-5** code (tender in `complete`, new close formula, web tender step).
POS-4 and POS-5 migrations can ship in one window; the code can follow in two PRs.

## 4. Decisions for the owner (with recommendations)

| # | Decision | Recommendation |
|---|---|---|
| 1 | Tender methods | `cash`, `card` (recorded only, no card processing), `other`. |
| 2 | Split tender | Allow it (several payment rows per order). |
| 3 | Require tender to complete | Yes, always; no sale without a payment record. |
| 4 | Orders require an open register | Yes (fail closed), as with currency. |
| 5 | Several registers per business | Not now. Keep one open session per business; revisit with POS-6. |
| 6 | Minor units first | Yes: POS-1.6 before POS-5. |
| 7 | Card/slip reference | Optional free text, no digit runs of 13 or more, no card data. |
| 8 | Window | Migrations 0202-0206 in the first release window after Phase W, with a fresh backup and the migration gate. |
| 9 | Refund of a completed sale | Out of scope here (survey F4); a separate block after v1. |
| 10 | Sessions open at deploy time | Close them before the window; sales recorded before POS-5 have no payment rows and would be missing from expected cash. |

## 5. Tests the build must include
Currency minor units (KWD, USD, JPY); an order cannot be created without an open session and a closed session refuses completion; complete without payments is refused; underpayment and overpayment of a card/other tender are refused; cash change is computed; split tender sums exactly; payments in a currency other than the order's are refused; UPDATE and DELETE on `order_payments` are refused; RLS isolation between tenants; the close formula counts only this session's cash applied; card and other are not in expected cash; a reference containing 13 or more digits is refused; idempotent replay of `complete` writes payments once; migration gate and fingerprint tests updated for the new objects.

## 6. Not in this proposal
No migration written or applied, no production change, no code, no refund or reversal, no discounts, no card processing, no receipts (POS-6), no offline queue (POS-7).
