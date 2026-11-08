# POS2-04-S3 — Inert inventory sale-effect evidence

Development-only. This block adds no producer, scheduler, API route, inventory movement, stock deduction, readiness activation, billing change or payment-path integration.

## Storage

Migration `0229_pos_inventory_sale_effect_evidence.sql` adds `business_operations.pos_inventory_sale_effects`. A row snapshots the completed order, line, completion event, catalogue association, mapping, warehouse, inventory item, unit, exact decimal quantity and source correlation identity. The only allowed S3 state is `pending`, which does **not** mean inventory has moved.

A unique order-line identity prevents replay after a mapping changes; the additional (order_line, mapping) uniqueness documents future component identity, but S2 currently permits only one active mapping per product. Future multi-component recipes require a separate contract/migration.

The database verifies that the order is completed, the specified completion event belongs to that order, the original append-only `catalog_line_added` note names this line and catalogue product unambiguously, the mapping is active and scope-matched, and the item and warehouse are active in that same business. It refuses malformed or conflicting source facts. Source quantities are compared in PostgreSQL numeric, not JavaScript floating point.

`ENABLE` and `FORCE RLS` are required. The application role has **no SELECT or write privilege** on this evidence table; this is repeated in `grant-app-role.sh`. The table is append-only (UPDATE/DELETE/TRUNCATE refused). Historical mapping and evidence rows are retained under the current append-only evidence policy; lawful erasure remains an owner decision.

## Source authenticity boundary

Existing POS catalogue association is carried by an append-only order-event note rather than a dedicated order-line foreign key. S3 verifies the note and all scope identities, **but cannot cryptographically attest that the original note was created by the POS route**: an attacker already holding authorized order-event INSERT privileges could forge that note. No externally accessible S3 producer is introduced. Before S5 activation, the Core/POS owner must verify the trusted note-write authority or add a separate authenticated linkage.

## Development stages

- **S3:** Immutable evidence schema and source-validation constraints only. No application writer exposed.
- **S4:** Canonical BO movement command and idempotent reference, independently authorized.
- **S5:** Governed durable pull processor with source authentication, exception handling and closed activation gate.
- **S6:** Optional outbox trigger, only if separately authorized.

## Verification

Integration tests in `packages/database/tests/pos-inventory-sale-effects.integration.test.ts` require a disposable PostgreSQL 16 database and **both** `DATABASE_URL` and `ADMIN_DATABASE_URL`. Apply the repository's app-role grant script and CI-equivalent RLS setup before running them. Do not count a skipped database test as a PASS. CI results must be attributed to the exact S3 commit.

## No-go

No migration to production, no consumer activation, no payment change, no stock movement, no merge or deployment under this block.
