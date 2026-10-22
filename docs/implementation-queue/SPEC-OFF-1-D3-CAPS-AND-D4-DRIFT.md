# SPEC OFF-1 — D3 monetary caps (to build) and D4 price-drift controls (as built)

| Field | Value |
|---|---|
| Date | 2026-10-22 |
| Status | **SPECIFICATION ONLY.** Nothing in this document is implemented. No code, migration, configuration or production change. |
| Builds on | OFF-1 as merged to `main` (design `DESIGN-OFF-1-SERVER-OFFLINE-SALE-PROCESSING.md`; migration 0210; service; route), decision record D3/D4 |
| Owner inputs | **No figure is proposed or approved here.** Caps, drift limits and the clock-skew bound stay owner decisions. Examples below are labelled as examples and are not defaults. |
| Offline selling | **Disabled** (the route answers 503) and must stay disabled until the owner has approved actual caps and authorized enablement. |

## 1. D3 — mandatory per-currency monetary caps (specification)

### 1.1 What is decided and what is not (record D3)
Decided: maximum offline duration **24 hours** (enforced today: `OFFLINE_MAX_AGE_SECONDS`, refused at the door), maximum **100** queued sales (device side, OFF-2), maximum individual sale value **per currency: not decided**. This section specifies how the value cap is enforced once the owner approves figures.

### 1.2 Requirements (from the owner directive)
1. Server-side enforcement. The device may mirror the cap for the cashier's benefit; the server decides.
2. Exact integer arithmetic in minor units (KWD 3, USD 2, JPY 0 decimals). No floating point, no rounding in the comparison.
3. Business-scoped configuration, not a deployment-wide constant.
4. **No monetary defaults** anywhere (no built-in number, no migration seed, no example in `.env.example`).
5. **Fail closed** when a cap is absent.
6. No weakening of order/payment consistency, replay, tenant/workspace/business isolation, append-only evidence.
7. No enablement until the owner approves actual caps.

### 1.3 Configuration (business-scoped, append-only, versioned)
A new table, e.g. `business_operations.offline_sale_limits`, one row per version of one (business, currency) pair:

| Column | Rule |
|---|---|
| `tenant_id`, `workspace_id`, `business_id` | composite FK to the business; `FORCE ROW LEVEL SECURITY` with the standard tenant+workspace policy (as `offline_sales`) |
| `currency_code` | ISO code; must equal a currency the business has declared |
| `max_sale_minor` | `bigint`, `CHECK (max_sale_minor > 0 AND max_sale_minor <= 10^15)` so it is always a safe integer; **no DEFAULT**, `NOT NULL` |
| `drift_limit_minor` | `bigint`, `CHECK (>= 0)`; **no DEFAULT**; recommended home for the D4 limit (see 2.4) |
| `version`, `set_by_user_id`, `set_at`, `reason` | append-only history like `business_currency_declarations`; the latest version per pair is in force |

- Append-only via the existing `forbid_mutation()` pattern; changing a cap inserts a new version.
- Writes through `PUT /v1/businesses/:businessId/offline-limits` guarded by `bo:admin` (D8 sets `bo:admin` as the resolver role for offline exceptions; the same role is proposed here for limits), active subscription, business-workspace visibility, Idempotency-Key, optimistic `expectedVersion`. Reads need `bo:read`.
- Audit: every change records who, when, old and new value.
- The numbers are entered by the owner through that endpoint (or a reviewed one-off) at enablement time. **Migrations seed nothing.**
- Migration number: the next free number at write time (0211 is reserved for kitchen routing; the repository guard requires no gaps). It needs its own plan, rollback block, local proof, reference fingerprint, window and authorization, like 0208–0210.

### 1.4 Enforcement points
1. **Enablement gate (route level, before idempotency).** After permission and business-workspace checks and the existing global gate, the route requires a cap row in force for the business's declared currency. If none: answer **503 "offline selling is not enabled for this business"** (not cached, no record), exactly like the global gate. Absent cap = closed.
2. **Per-sale check (service, inside the shared transaction, before any order is created).** Compute `saleValueMinor = max(serverTotalMinor, provisionalTotalMinor)` in integers (the larger of what the server recomputes and what the customer was shown). If `saleValueMinor > max_sale_minor` the outcome is `needs_review` with a new review reason `amount_cap_exceeded`, **no order is created**, and the row is recorded. Equal to the cap is allowed ("maximum" means inclusive). With the D4 policy, the honoured displayed price is already part of the larger total.
3. **Request digest unchanged** (the cap is server state, not part of the request); replay returns the first recorded answer even if the cap changed later.
4. **Record the evidence.** The `offline_sales` row gains `cap_minor_applied` and `limits_version_id` so every decision can be audited later (new nullable columns or a small detail json; migration).
5. The cap is read at `received_at` (server clock), never from the device.

### 1.5 Schema consequences (all in the same future migration)
- Add `amount_cap_exceeded` to the `review_reason` CHECK of `offline_sales` (drop and re-add the named constraint; existing rows are unaffected).
- Add the evidence columns above.
- Update the reference fingerprint, the discovery script verdict and the static migration tests, as for 0210.

### 1.6 Tests (each with a mutation proof)
Boundary per currency: cap-1, cap, cap+1 minor unit for KWD (3), USD (2), JPY (0). Absent cap -> 503, nothing stored. Cap present for another currency or another business -> still 503. Provisional total above cap while the server total is below -> review. Honoured drift price pushing the total above cap -> review. Cap raised or lowered between queueing and sync -> the cap at receipt applies, recorded. Replay unaffected. Cross-tenant, cross-workspace, cross-business isolation. `max_sale_minor` of 0, negative, or above 10^15 refused by the database. No default exists anywhere (static test over migrations, `.env.example`, config). Property test: random totals vs random caps never accept a sale above the cap. Existing OFF-1 suites stay green (order total equals payments, append-only, RLS).

### 1.7 Why the cap matters (threat note)
OFF-1 authenticates the session and permission, but the sale content comes from the device. A device with a live session can post fabricated offline sales. The server totals, the 24 h age limit, the cash-only rule and the cap bound the damage per sale; the shell PIN (OFF-2) and session revocation bound who can post at all.

### 1.8 Not decided here
The figures. Whether the same endpoint also carries the D4 limits (recommended, 2.4). Whether an aggregate per-device or per-day value limit is wanted (a larger decision, OFF-5).

## 2. D4 — price-drift controls (what exists, what is still required)

### 2.1 Approved policy (record D4)
Honour the price shown to the customer where policy permits, record the difference, send every other conflict to owner/admin review. Payment consistency is preserved.

### 2.2 Behaviour as built (merged OFF-1, `planOfflineSale`)
- The server recomputes every line from the product price in integer minor units. A line whose server price equals the shown price is not drift.
- A difference is **honoured only if both** hold: (1) the product changed **after** the catalogue snapshot the device used (`products.updated_at > catalogue_snapshot_at`), and (2) the difference `(shown - server) x quantity` per line is within the owner-set limit for the currency, and so is the **net** difference for the whole sale.
- Honoured: outcome `accepted_with_difference`, the order is completed at the shown price, the signed difference is recorded (`difference_minor = server - device`).
- Anything else with a difference (product unchanged since the snapshot, a limit of zero, over the limit, a price that is not an exact number of minor units): outcome `needs_review`, reason `price_drift_not_allowed` (or `invariant_failed` for a non-exact price), **no order is created**.
- Underpayment is a separate review reason `underpaid`; unavailable or foreign products `product_unavailable`.
- **The limit is a parameter with no built-in figure.** A currency with no limit configured has limit **zero**: every difference goes to review. This is the fail-closed direction and needs no further change.
- Replay returns the first answer; a different body under the same id is refused (409).

### 2.3 Configuration still required
| Item | Today | Needed |
|---|---|---|
| Per-currency drift limit | `OFFLINE_SALES_DRIFT_LIMITS` environment variable on the API (JSON, minor units), deployment-wide | Owner-approved figures per currency. No figure is approved. |
| Where it lives | environment of the API process | Recommended: move into the business-scoped table of 1.3 so limits are per business, versioned and audited. A separate owner decision; until then the environment variable works and defaults to zero. |
| Clock-skew bound | `OFFLINE_SALES_FUTURE_TOLERANCE_SECONDS` (unset = offline selling disabled) | Owner-approved value; see the recommendation in the completion report (a proposal, not an approval). |

### 2.4 Required follow-ups (not done)
1. Owner approves the figures. Until then enablement stays blocked.
2. Optional: migrate D4 limits to the business-scoped table in the same block as D3 (one admin surface, one audit trail, one fail-closed rule).
3. The catalogue snapshot time used by the device must be a **server-issued** time (see OFF-2 spec, finding F-B); otherwise a device clock error changes which products count as "changed after the snapshot".

## 3. Findings recorded while preparing this specification
- **F-1.** `OFFLINE_SALES_*` are deployment-wide; the owner asked for business-scoped limits (1.3).
- **F-2.** A sale refused at the door (too old, bad total, non-cash, clock ahead) leaves no server record. The shell must keep such intents for manual handling and never drop them (OFF-2 spec).
- **F-3.** The request carries no cashier field; the server attributes a synced sale to the syncing session's user. Whether a sale may be synced by a different user than the one who rang it up is an owner decision (OFF-2 spec, section 9).
