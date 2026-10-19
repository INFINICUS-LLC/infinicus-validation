# Expected state of the INFINICUS production database at migration-ledger head 0201 (before migrations 0202-0206, the POS-4/5 window), as observed
# by the owner on production on 2026-10-19 after Phase W (Hetzner infinicus-prod-01, PostgreSQL 16.15). Non-secret. One rule per line (same syntax as
# production-pre-0199.profile):
#   ledger_count=N | ledger_head=<file> | schema_fingerprint=<16 hex> | count <schema.table>=N | outbox <event_type>=N
# Sources: ledger, fingerprint and counts from the owner's read-only post-window verification (Phase W step W7, PHASE_W_EXECUTION_RECORD_0199-0201.md):
# fingerprint 61ef99d74289c3b3 = MATCHES_REPOSITORY_0201_PG16, ledger 201, tenants 16, users 6, businesses 16, outbox 59. The outbox split (48 + 11) is
# carried from the head-0198 profile: the total (59) did not change through Phase W, so no event was added; the split itself was not re-read. The six business-operations tables
# below were absent from the restored row-count listing (the listing omits empty tables), i.e. empty.
# Only stable tables are asserted. Tables that change with traffic (sessions, access events, idempotency keys, error events) are deliberately NOT listed.
# platform.orders and business_operations.register_sessions are NOT asserted here: they are expected to be empty but that was not observed after the
# window; the window plan (PHASE_W2_WINDOW_PLAN_0202-0206.md, step W0) reads them on the day.
# Update only through a reviewed change after a deliberate production change.
ledger_count=201
ledger_head=0201_enforce_om_monitored_action_child_scope_integrity.sql
schema_fingerprint=61ef99d74289c3b3

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
