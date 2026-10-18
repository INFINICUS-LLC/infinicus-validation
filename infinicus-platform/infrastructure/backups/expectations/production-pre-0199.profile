# Expected state of the INFINICUS production database at migration-ledger head 0198 (before migrations 0199-0201), as supplied by the owner
# (Hetzner infinicus-prod-01, PostgreSQL 16.15). Non-secret. One rule per line (same syntax as production-pre-0171.profile):
#   ledger_count=N | ledger_head=<file> | schema_fingerprint=<16 hex> | count <schema.table>=N | outbox <event_type>=N
# Sources: ledger and fingerprint from the head-0198 backup manifest (infinicus-production/2026-10-18/20261018T173225Z-pre-release-0198) and the
# owner's earlier read-only discovery; row counts from the owner's read-only count query run on production on 2026-10-18 (counts and event-type names only).
# Only stable tables are asserted. Tables that change with traffic (sessions, access events, idempotency keys, error events) are deliberately NOT listed.
# Update only through a reviewed change after a deliberate production change.
ledger_count=198
ledger_head=0198_link_purchase_order_lines_to_inventory_items.sql
schema_fingerprint=7fd4c419d738de8a

count tenancy.tenants=16
count identity.users=6
count platform.businesses=16
count events.outbox_events=59
outbox onboarding.step.completed=48
outbox billing.subscription.status_changed=11

# tables that must be empty (no business-operations data and no audit events exist yet)
count audit.audit_events=0
count business_operations.inventory_movements=0
count business_operations.purchase_receipts=0
count business_operations.inventory_balances=0
count business_operations.purchase_orders=0
count business_operations.purchase_order_line_items=0
