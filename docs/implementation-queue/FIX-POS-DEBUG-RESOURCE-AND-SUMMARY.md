# POS debug corrections — resource-bound replay and register summaries

Date: 2026-10-21. Owner authorization: make corrections to the two confirmed findings in the five-build debug review.

Base: main 7a57f21, including Claude's discounts, order notes, connectivity and receipt printing. This is a corrective build, not an independent feature block.

## Corrections

1. Idempotency fingerprints include every validated path parameter, sorted by name, with a versioned prefix and the existing body representation. Tenant/route/key storage is unchanged. Reusing a key on another order, business or line item conflicts instead of returning another resource's response. Exact same-resource retries still replay the original result.
2. Register summaries use generation and session identity checks. Load/open/close invalidate pending summary answers. Older responses cannot overwrite newer summaries or restore one after closing. Mismatched session data is refused; failed background reads keep the previous valid summary.

## Compatibility

Parameterless requests keep their historical body-only fingerprint. Historical parameterized cache entries lack resource identity and intentionally return 409, including same-resource retries, rather than replaying an unbound success or running another mutation. Existing rows are not rewritten. Reconcile the affected resource through its authoritative read; no automatic retry with a fresh key is introduced. Owner/Claude review must account for this limitation before release.

## Validation scope

Tests cover the two original reproductions, original-resource replay, different-order and different-business key reuse, changed bodies, legacy cache refusal without duplicate payments, stable parameter ordering, summary races, close/load transitions and mismatched session data. Existing payment/register/currency/permission and Claude discount, connectivity and printing regressions are retained.

No migration, production database access, deployment, H-5A/recovery change, locked-spec edit, role/branch policy, new ledger or source of truth. Shared API replay identity changes for parameterized routes; operational calculations and mutation repositories remain unchanged. Submit for mutual Claude/owner review and do not merge automatically.
