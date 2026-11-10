# POS2-04-S5A — Trusted catalogue-line association

**Development-only; source-authority hardening. No S5 producer, pull processor, external API route, automatic stock movement, merge or deployment.**

Authoritative source baseline: `669b3cff9fcf30cdedf07f904aecbe435f5d8974`, the merged S5 preflight PR #439. Migration 0231 is additive; migrations 0229 and 0230 remain untouched.

## Source contract

The BO sellable catalogue is `business_operations.products` and is not the canonical `platform.products` FK. The compatibility `catalog_line_added` order event note remains for existing clients, but notes are **not inventory provenance**. A caller with the app database role can INSERT notes and supply an earlier `occurred_at`.

A **trusted origin** is instead inserted into the append-only `business_operations.pos_catalog_line_origins` table *only within* `business_operations.create_pos_catalog_line`. The SECURITY DEFINER entry point creates a fresh `order_line_items` row and the matching origin in one PostgreSQL transaction. There is no method to attach an origin to an existing or completed line. The app role has no direct origin read or write privileges; a database trigger restricts origin INSERT to the owner-governed creator and refuses UPDATE/DELETE/TRUNCATE. FORCE RLS scopes the evidence by tenant and workspace, while the function validates business, order, catalogue product, actor and membership/bo:write permission.

Existing app code continues to resolve the catalogue price/name and calculate money as before. The DB creator rechecks that the product is active and scope-matched, that the order is planned, and that a non-drift sale uses the canonical catalogue unit price. An accepted offline honoured-price-drift sale invokes the same creator with the server-planned price. **Price-drift acceptance is owned by the already-existing `planOfflineSale` validation, not by this origin function**. The database role can invoke the governed creator for a legitimate active product if it has a valid scoped actor; it cannot turn a completed/free-text line into an inventory-backed line with a forged note.

Source kinds: `online`, `offline_catalog`, `offline_honoured_drift`. No new route or client-side capability exposes source override fields; the public Fastify input schemas remain strict. The new internal optional metadata is used only by the existing offline ingestion service.

## Evidence and legacy safety

Migration 0231 replaces the S3 `verify_pos_inventory_sale_effect` validation so new evidence requires a same-line, same-business, same-product trusted origin created no later than the completion event. Notes no longer satisfy this gate, regardless of apparent timestamp or count.

S4 `applyPosSaleEffectOn` also revalidates trusted origin before any balance lock or inventory movement. This second gate blocks pre-existing S3 evidence inserted under the superseded, note-based verifier.

No backfill, conversion or recognition of historic `catalog_line_added` notes. A legacy order line has no trusted origin and therefore remains **ineligible**. Removing a planned line is still supported; its append-only origin is retained as a tombstone without a line FK and can never be reused to authorize S3/S4 because both independently verify the original line identity. Quantity edits to planned lines remain supported; S3 snapshots the final line quantity at completion.

Historical tombstone retention, erasure workflow and export authority require separate governance. Neither erasure nor policy activation is implemented here.

## Test and security requirements

Run on disposable PostgreSQL 16 with the repository's grant-app-role.sh script, DATABASE_URL, ADMIN_DATABASE_URL, and CI-equivalent RLS. Test that the app role cannot access the origin ledger directly, the privileged entry point creates both records atomically, offline drift keeps the correct product identity, a completed order or foreign product cannot gain an origin, forged notes alone never validate S3 evidence, S4 cannot process legacy note-only evidence, and canonical stock movement stays unwired.

**S5A mergeability is not S5 activation approval.** Next independently authorized block is an inert, governed evidence producer/pull processor with execution identity, source scope, idempotency, rate limits, failure handling and a closed activation gate. No deployment, no auto-merge.

## Known residual boundary

The transaction's tenant/workspace/user values are supplied through the repository's existing trusted API session context. This block does not introduce an independent cryptographic workload identity for arbitrary holders of the shared DB application credential. Authentication, database-role least privilege and the future S5 workload identity must be independently reviewed before consumer activation. The governed creator attests line **construction and catalogue attribution**, not that every calling application component is uncompromised.
