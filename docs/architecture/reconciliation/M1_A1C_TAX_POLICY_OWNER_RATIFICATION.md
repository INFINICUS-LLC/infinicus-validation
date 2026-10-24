# M1-A1C — tax-policy authority owner-ratification package

Status: **PROPOSED, NOT RATIFIED**. Baseline: `main` at `b0d4abe`. Design only: no policy activation, calculator, migration, POS writer, historical rewrite, OM verdict or CL learning. Every value below is a candidate for explicit owner and, where indicated, legal/business approval.

## Existing authority and compatibility facts

BO owns operational order completion. Business Administration's append-only `business_currency_declarations` provides a relevant pattern: business scope, linear versions, actor, permission, reason, database time and audit. Currency declaration currently requires `platform:admin`; ordinary BO catalog creation/update requires `bo:write`, while discount entry requires `bo:admin`. Neither permission automatically authorizes legal tax policy or tax-class approval. A future tax-policy grant must be decided through canonical tenancy authority, not assumed from a broad role.

The POS sellable catalog is `business_operations.products`, separate from `platform.products` and `platform.services`; order lines may also carry custom item descriptions/prices. None has an approved effective-dated POS tax class. Canonical product `unit_of_measure` defaults to `unit`, but BO POS products have no UOM field. Online order quantities allow four decimal places, while offline intake permits only whole quantities. The current `order_line_items.tax_rate` defaults to zero; POS add-line requests contain no tax input. `roundToCurrency` uses JavaScript numbers and half-away rounding; that helper is not an approved exact tax engine.

Offline intake is append-only, unique per `(business_id, client_sale_id)`. A `needs_review` result has no order. Existing `accepted_with_difference` may complete an order after allowed price drift. OFF-1 already reserves later review resolution for a new append-only record; no such authoritative path is implemented. A changed tax-policy payable must therefore not be slipped into the current acceptance path.

## Proposed versioned contracts

**Jurisdiction policy:** `(tenant_id, workspace_id, business_id, jurisdiction_id, policy_version, effective_from_utc, effective_until_utc, status, approved_by, authority_reference, approved_at_db, source_digest, supersedes_version)`. One active version for an instant and scope; no overlaps or implicit fallback. The jurisdiction identifier must be an approved business/legal classification, not geolocation guessed from an address.

**Classification:** `(scope, BO_sellable_id or explicit custom-line class, canonical_product_or_service_reference_if_any, tax_class_code, treatment, valid_from_utc, valid_until_utc, classification_version, provenance, author, approver, audit_digest)`. BO owns the POS classification and any mapping to DAL/platform entities. Missing/expired/ambiguous class refuses tax-aware completion. A later classification appends a version; it does not rewrite a completed line.

**Price, discount and tax:** each line binds price treatment (`INCLUSIVE` or `EXCLUSIVE`), jurisdiction/policy version, class/rate/exemption version, unit-of-measure and quantity precision, source unit price and discount eligibility. An order may contain mixed treatment and rates; calculations are per line and reconciled to an order-level payable. `ZERO_RATED` and `EXEMPT` are distinct explicit classes even when tax is zero. Exact decimal/rational arithmetic carries full intermediate precision and emits signed integer minor units only at the approved rounding stage. The completion snapshot must retain policy IDs and every line component.

**Generic reconciliation:** displayed subtotal includes embedded tax on inclusive lines. `payable = displayed_subtotal - allocated_discounts + exclusive_tax`. For every inclusive taxable line, discounted displayed gross equals exclusive taxable basis plus included tax. Exempt and zero-rated amounts are reported separately. Sum of line payable contributions equals BO order payable and applied tender; no component may be silently inferred from the total.

## Candidate algorithm and illustrative vectors — not active rules

1. Resolve the policy and classification version at trusted BO completion time; reject unknown or overlapping effective versions. Resolve an explicit UOM/quantity rule.
2. Convert exact input decimal prices to a rational minor-unit basis. Calculate each line's pre-discount extended displayed price. Do not use binary floating-point for governed tax arithmetic.
3. For an eligible order discount, allocate integer minor units in proportion to eligible line displayed bases. Take each floor quota; distribute remaining minor units by descending fractional remainder, then ascending immutable line ID. Never allocate to an ineligible line or beyond its basis. Record every allocation and discount type.
4. Apply jurisdiction-specific discount/tax ordering. Candidate default for a jurisdiction that permits discount-reduced taxable basis: exclusive tax is calculated on discounted exclusive base; inclusive tax is extracted from discounted inclusive gross. Round each line/rate component once, half away from zero, then sum. **Both ordering and rounding stage require explicit approval.**

| Illustrative vector | Candidate result |
| --- | --- |
| USD exclusive: 10,000-cent line, 1,000-cent eligible discount, 10% tax | taxable base 9,000; tax 900; payable 9,900 cents |
| USD inclusive: 11,000-cent line including 10% tax, 1,100-cent discount | discounted gross/payable 9,900; included tax 900; exclusive base 9,000 cents |
| Mixed exclusive: two 1,000-cent lines at 10% and 5%, 300-cent proportional discount | allocations 150/150; taxes 85 and 43 after proposed per-line half-away rounding; payable 1,828 cents |
| Residual: two equal eligible lines, one-cent discount | floor allocations 0/0; remaining cent goes to lower stable line ID; total allocation exactly one cent |
| Explicit zero-rated versus exempt 2,000-cent lines | both tax 0, but separate classification and reporting; an unknown class refuses |
| USD fractional: 0.125 kg × 800 cents/kg | extended displayed amount 100 cents if `kg` precision 3 is approved; a `unit` item with precision 0 refuses quantity 0.125 |

These vectors cannot prove legal correctness. An aggregate-rounding rule, inclusive discount rule, rate compounding or other legal requirement may produce different values and must be versioned rather than guessed.

## Proposed offline review-resolution state machine

Keep the original `offline_sales` intake row and request digest immutable. For a changed customer-confirmed payable, expired/changed policy, unknown class, or insufficient cash, the future tax-aware path proposes `needs_review` with **no order** and an explicit reason. Do not change current `accepted_with_difference` behavior in this design block.

An authorized, separately specified append-only BO resolution stream would progress `REVIEW_OPEN → BO_QUOTED → AWAITING_CUSTOMER_REAUTH → AUTHORIZED → FINALIZED`, or to `DECLINED` / `EXPIRED`. Each transition references original `(business_id, client_sale_id, request_digest)`, the new BO quote/policy version and prior resolution event. `AUTHORIZED` requires authenticated online actor authority, explicit customer confirmation of the changed payable, and sufficient settled tender under the approved payment rule. Only `FINALIZED` may create one order through the existing BO completion writer; its database transaction binds the resolution, order and tender. A stale quote, altered device body, changed tax policy or changed amount reopens review with a new version, never edits the intake row. Replays of the same resolution key/digest return the original result; same key with different body conflicts. Database uniqueness prevents two finalized orders for one original intent. Refund/change handling if the customer already paid a different amount is a separate authorized payment decision.

## Owner-decision register

| ID | Exact proposed rule (unratified) | Alternatives considered | Source owner / compatibility impact | Testable acceptance criteria | Approval |
| --- | --- | --- | --- | --- | --- |
| T1 jurisdiction | Business-scoped, effective-dated, nonoverlapping approved policy; unknown refuses | Infer from address; tenant-wide default | Business Administration + BO; new config/read contract | overlap, gap, revoked and cross-business refusal | Owner **and legal/business** |
| T2 grant | Require active canonical business-scoped administrator grant and separate approval evidence; do not assume `bo:write` or `platform:admin` suffices | Reuse `platform:admin`; reuse `bo:admin` | Tenancy/ABA + BO; new authority mapping | wrong role, self-approval, revocation and audit tests | Owner security/business |
| T3 classification | BO POS sellable and custom lines require effective-dated approved class with source mapping | Catalog category as class; zero default | BO catalog, DAL mapping; online/offline line compatibility | missing, expired, ambiguous or foreign class refuses | Owner **and legal/business** |
| T4 price treatment | Explicit inclusive/exclusive treatment per line; mixed basket allowed | One business-wide treatment | BO/POS; API/display and receipt change | mixed basket component/payable reconciliation | Owner **and legal/business** |
| T5 discount | Eligible-line proportional minor allocation, floor plus largest remainder and stable line-ID tie | Equal split; post-tax discount | BO/POS; current negative discount line needs governed allocation | sum exact, ineligible excluded, deterministic residual | Owner **and legal/business** |
| T6 tax/rounding | Explicit effective rates/exemptions; rational intermediate math; proposed per-line/rate half-away rounding | Aggregate rounding; ties-to-even | BO financial policy; replaces governed use of JS-number rounding | boundary, mixed-rate, inclusive and exact-money vectors | Owner **and legal/business** |
| T7 UOM | Per-UOM approved precision 0–4; `unit` proposed 0, offline remains integer; reject unsupported fractional quantity | Universal 4 decimals; universal integers | BO catalog/POS; current online allows 4 decimals, offline whole only | 0.125 kg accepted only if approved; 0.125 unit refused | Owner/business; legal where regulated |
| T8 legacy | No inferred tax or class for historical orders; pre-effective transactions remain nonauthoritative for governed revenue | Backfill from present rates | BO/OM; requires coverage watermark | historical order never gains fabricated snapshot | Owner/business |
| T9 offline | Changed payable or delayed policy → immutable review intake, new linked resolution, explicit customer reauthorization before completion | Auto `accepted_with_difference`; silent total replacement | BO/POS OFF-1/OFF-4; new reason/state/API contract | no order before auth; replay/concurrency/quote-expiry tests | Owner/POS; payment/legal review |
| T10 sales source | Only BO order completion is a governed POS sale; generic `business_events(sale)` remains activity intake and cannot be added again | Sum both sources | BO, BI, OM; readers must deduplicate by authoritative order event | no double count for completion plus business event | Owner/business |

No proposed rule in this register is an approved tax rate, exemption or permission grant. The owner must approve each applicable value and version before implementation.

## Frozen contracts and next blocks

The locked BO spec supports a deterministic POS core, native POS and offline operation; the source-of-truth guardrail keeps BO authoritative. No amendment is made here. Formal review is required for any frozen POS rule that treats the device's provisional total as final or requires automatic acceptance when BO payable changes. The present OFF-1 `accepted_with_difference` and review-reason schema definitely need a separate approved compatibility change before T9 can run. Tax-class/UOM fields and tax-aware response shape also require POS contract review.

Smallest independent post-ratification block: a **read-only tax-policy authority resolver and exact-money calculation vectors** using approved fixture policy versions, with all write/activation paths disabled. After that, separately authorize configuration storage, online/offline compatibility, BO calculator, immutable completion snapshot and production rollout in that order. M1-B refunds, authoritative OM verdicts and CL learning remain closed.
