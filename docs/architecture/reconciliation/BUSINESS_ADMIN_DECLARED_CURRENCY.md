# Business Administration — governed, business-scoped DECLARED CURRENCY (migration 0185)

Status: DRAFT PR. Not applied to live Supabase (live 0169). B2b, P0-6, data-capture Blocks B/A/D/E, FX, a per-currency cap table and
rule-set approval/activation are NOT part of this block.

## 1. Purpose and boundary

Answers one question: *what currency has this business explicitly declared for governance and cost evaluation?* It never answers
*what currency can be guessed from old defaults?* The B2 COST dimension (rule set v1.0.0) reads this value; v1 compares it with the
owner's `ORDER_VALUE_CAP_CURRENCY` (USD) and returns `CAP_CURRENCY_MISMATCH` for any other currency. No FX conversion exists.

## 2. Survey of existing currency fields (read-only)

| Field | Owner | Scope | Default | Explicit vs default distinguishable? | History | Governance SOT? |
|---|---|---|---|---|---|---|
| `tenancy.tenants.default_currency` | Business Administration | tenant | `'USD'` (silent) | No | None | **No** |
| `business_operations.business_profile_extensions.default_currency` | BO | business | `'USD'` (silent) | No | None; no code reads or writes the table | **No** |
| `purchase_orders.currency_code`, orders, invoices, quotations, supplier agreements | BO | document | Block C removed the PO default; others `'USD'` | per document | per document | **No** (document currency, not business declaration) |
| `inventory_movements.unit_cost_currency` (0183) | BO | movement | none | yes | append-only | No (cost currency; compared with the declaration) |

No existing field proves an explicit, governed, business-scoped selection, so nothing was duplicated. The locked manifest assigns
"Currency" to Business Administration.

## 3. Design

- `platform.business_currency_declarations`: append-only linear version chain per business (`version`, `declared_currency`,
  `supersedes_version`, `prior_declared_currency`, `provenance`, `declared_by_user_id`, `permission_used`, `reason`, `correlation_id`,
  database-stamped `declared_at`). **No row = UNDECLARED**; no separate marker is needed, and nothing can be mistaken for a value.
- Database-enforced: `^[A-Z]{3}$` (no normalisation); first row is version 1; each later row is previous + 1, records the prior
  currency, must change the currency and must carry a reason; the business must be in the same tenant and workspace; RLS forced on
  tenant + workspace; UPDATE/DELETE/TRUNCATE rejected (`platform.forbid_mutation`).
- The migration seeds and backfills nothing and never reads either `default_currency` column.
- Write: `BusinessDeclaredCurrencyService` (`@infinicus/onboarding`) → `BusinessDeclaredCurrencyRepository`; the declaration and its
  `audit.audit_events` row use ONE transaction client, so an audit failure rolls the declaration back. An exact replay (same value) is a
  no-op: no row, no audit. A change needs `expectedVersion` equal to the current version (else 409) and a reason; a stale writer can
  never revert a newer declaration.
- Read: `BusinessDeclaredCurrencyReader` (no write method) is the governed boundary for B2b/B2c/BO/ABA: `UNDECLARED` or the exact
  declared record.
- API: `PUT /v1/businesses/:id/declared-currency` (`platform:admin`, Idempotency-Key, strict body: currency, expectedVersion, reason),
  `GET …/declared-currency` and `GET …/history` (`bo:read`). Tenant, workspace and actor come only from the authenticated context.
- Permission: no permission was invented. `platform:admin` (owner role; the `admin` role does not hold it) is the only existing
  Business Administration administration permission.

## 4. Allocation record (MIGRATION-ALLOCATION-POLICY)

| Item | Value |
|---|---|
| Predecessor | `0184_inventory_movements_append_only.sql` (main `abe5a18`, CI run 38150864572 SUCCESS) |
| New range | `0185` |
| SHA-256 frozen 0001-0184 | `68d466fa1877929c1f9e5e668cf48e919b956c1026ad2cfa03ff3f23b9228b41` |
| SHA-256 frozen 0001-0183 (unchanged) | `8b14ccfeb32946a38530be3f7829e37e967ff43407de56f18968f017283cc964` |
| SHA-256 of `0185_create_business_currency_declarations.sql` | `8a57059c708c1cd615fc8c2a533c70336ba4c187f434022515602e31bd8c45f6` |
| Live Supabase | not applied |

## 5. Rulings recorded (owner, this block)

- **Why the existing `default_currency` fields are not governance evidence.** Both are `NOT NULL DEFAULT 'USD'`: a stored `USD` is identical
  whether someone chose it or the database filled it in, and neither has an actor, a time of choice or a history. Using either would turn a
  silent default into governed evidence. They are left exactly as they are and are never read by the declaration code (architecture guard).
- **Why a separate explicit declaration.** Only a row that an authorised actor created on purpose can prove a choice; its absence is the
  only honest representation of "not declared".
- **Ownership.** Business Administration owns the write. The Data Acquisition layer has no write authority; Business Operations and ABA are
  read-only consumers through `BusinessDeclaredCurrencyReader` (no write method).
- **`platform:admin` is temporary.** It is the only existing Business Administration administration permission (owner role). A narrower
  business-settings permission is a later decision; none is invented here.
- **Read permission.** `GET` uses `bo:read`. Verified against the existing matrix: the business record itself (`GET /v1/businesses`,
  `platform.businesses`) and the workflow view are already gated by `bo:read`, so a business-level fact read at the same level is consistent;
  no layer reads the fact through the HTTP route (BO/ABA use the Reader). This does not reclassify ownership.
- **No ISO 4217 list in v1.** Three uppercase letters only (`^[A-Z]{3}$`, database and service). No lowercase normalisation: `usd` is refused.
- **Version/history.** Linear chain; version 1 is the first declaration; a change appends version + 1 with the prior currency and a reason;
  nothing is updated or deleted; the current value is the latest version; the full history is readable.
- **Idempotency.** (a) `Idempotency-Key` replays the stored HTTP response; (b) semantically, declaring the value already in force is a no-op
  (HTTP 200, no row, no audit); (c) a different value needs `expectedVersion` = current version (else 409), so a stale writer can never revert a
  newer declaration; concurrent writers serialise on the business row lock, with `UNIQUE (business_id, version)` as the backstop.
- **Audit rollback.** The declaration and its `audit.audit_events` row are written on one transaction client; if the audit write fails,
  the declaration is rolled back (tested with an injected failure and with a real database error).
- **Tenant-erasure retention.** The history stays append-only and is never deleted or backfilled to simplify erasure. Because the table
  uses the `forbid_mutation` convention, `delete-tenant-data.mjs` retains it and reports a partial erasure. Whether such governance
  history may be retained after an erasure request is a future legal/privacy decision.
- **B2 consumption boundary.** B2b/B2c read the declared currency only through the Reader: `UNDECLARED` → COST INDETERMINATE
  (`DECLARED_CURRENCY_MISSING`); declared but not USD → `CAP_CURRENCY_MISMATCH` (`ORDER_VALUE_CAP_CURRENCY = USD`); cost currency must equal
  the declared currency. This block implements none of that evaluator.
- **No default promotion.** The migration inserts nothing but its own registration; no code path copies, falls back to, or infers a currency
  from any default, locale, environment or document currency.

## 6. Caveats

1. Format-only validation (three uppercase letters), like Block C: a well-formed but non-ISO code such as `ZZZ` is accepted. Only `USD`
   can ever satisfy the v1 cap rule, so this does not weaken B2.
2. `platform:admin` is broader than ideal; a narrower business-settings permission is a separate decision.
3. The table uses the `forbid_mutation` convention, so a tenant erasure retains its rows and blocks deleting the business (same as 0182).
4. Until a business declares a currency, B2 COST is INDETERMINATE (`DECLARED_CURRENCY_MISSING`) — by design.
