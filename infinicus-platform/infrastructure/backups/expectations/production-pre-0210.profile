# Expected state of the INFINICUS production database at migration-ledger head 0209 (after Phase W2, migrations 0202-0209), for the restore proof of a
# backup taken after the window (for example infinicus-production/2026-10-21/20261021T143056Z-daily). Non-secret. Same syntax as production-pre-0202.profile:
#   ledger_count=N | ledger_head=<file> | schema_fingerprint=<16 hex> | count <schema.table>=N | outbox <event_type>=N
# Sources:
#   - ledger, fingerprint and the empty new tables: the owner's read-only verification after Phase W2 on 2026-10-21 (step W7 and the post-window backup manifest:
#     ledger_head 0209_create_print_jobs.sql, schema_fingerprint 325158ea2a54cde9 = MATCHES_REPOSITORY_0209_PG16; orders, register_sessions, order_payments,
#     printers and print_jobs all 0 rows). See PHASE_W2_EXECUTION_RECORD_0202-0209.md.
#   - tenants, users, businesses and the outbox split: carried from production-pre-0202.profile (restore proof PASS on 2026-10-21 for the W4 backup). They were
#     NOT re-read after the API restarted; a restore proof of a post-window backup is what confirms them.
# STATUS: NOT YET PROVEN. The first restore proof of a backup at head 0209 validates this file. If it fails on a traffic-dependent count, correct that line
# through a reviewed change after reading the restored database; never loosen a rule to make a run pass.
# The five empty-table rules describe a backup taken before the counter is used in production; once real orders or printers exist, make a new profile.
# Only stable tables are asserted.
ledger_count=209
ledger_head=0209_create_print_jobs.sql
schema_fingerprint=325158ea2a54cde9

count tenancy.tenants=16
count identity.users=6
count platform.businesses=16
count events.outbox_events=59
outbox onboarding.step.completed=48
outbox billing.subscription.status_changed=11

# tables that must be empty
count audit.audit_events=0
count business_operations.inventory_movements=0
count business_operations.purchase_receipts=0
count business_operations.inventory_balances=0
count business_operations.purchase_orders=0
count business_operations.purchase_order_line_items=0
count platform.orders=0
count business_operations.register_sessions=0
count business_operations.order_payments=0
count business_operations.printers=0
count business_operations.print_jobs=0
