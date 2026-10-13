# Expected state of the INFINICUS production database at migration-ledger head 0170, as supplied by the owner (Hetzner infinicus-prod-01, PostgreSQL 16.15).
# restore-proof.sh reports RESTORE_PROOF=PASS only if the RESTORED database equals every value below. Non-secret. One rule per line:
#   ledger_count=N | ledger_head=<file> | schema_fingerprint=<16 hex> | count <schema.table>=N | outbox <event_type>=N
# `outbox` lines classify events.outbox_events by event_type; rows of any type NOT listed make the proof fail. The proof only counts rows (read-only);
# it never consumes, updates or replays an outbox event.
# Update this file only through a reviewed change after a deliberate production change (for example after migrations 0171-0198 are applied).
ledger_count=170
ledger_head=0170_add_approved_action_source_recommendation.sql
schema_fingerprint=38eabb12fde135b5

count tenancy.tenants=15
count identity.users=6
count platform.businesses=15
count events.outbox_events=56
outbox onboarding.step.completed=45
outbox billing.subscription.status_changed=11

# tables that must be empty (no business-operations data and no audit events exist yet)
count audit.audit_events=0
count business_operations.inventory_movements=0
count business_operations.purchase_receipts=0
count business_operations.inventory_balances=0
count business_operations.purchase_orders=0
count business_operations.purchase_order_line_items=0
