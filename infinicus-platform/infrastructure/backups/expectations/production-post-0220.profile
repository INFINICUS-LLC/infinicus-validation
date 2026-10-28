# Expected state of the INFINICUS production database at migration-ledger head 0220 reached by the ISOLATED AUTH-LOCKOUT-1 release: production at 0209 plus
# migration 0220_normalize_access_event_tenant_context.sql ONLY (the 0210-0219 files are deliberately not applied; see ISOLATED_SECURITY_RELEASE_DESIGN.md), for the
# restore proof of a backup taken AFTER that release (for example the on-demand backup of a later window). Non-secret. Same syntax as production-pre-0210.profile:
#   ledger_count=N | ledger_head=<file> | schema_fingerprint=<16 hex> | restored_fingerprint=<16 hex> | count <schema.table>=N | outbox <event_type>=N
# Do NOT use this profile for a backup taken before 0220 (head 0209 -> production-pre-0210.profile) or after any further migration (a new reviewed profile is needed).
#
# Provenance of the schema rules (VERIFIED - REHEARSAL; none of it is production-observed yet):
#   - ledger: the production ledger holds 209 rows (head 0209, owner-observed); migration 0220 inserts its own ledger row (ON CONFLICT DO NOTHING), so 210 rows and
#     max(filename) = 0220_normalize_access_event_tenant_context.sql. The runner orders by filename, so the head is the 0220 file even though 0210-0219 are absent.
#   - schema_fingerprint: the fingerprint (production-readonly-discovery.sh) of a clean database built from the committed migrations 0001-0209 plus 0220
#     (0220 sha256 78a17188e4f01e7dbe78fb422578864345607c9a4eefeb30ea7f9913d1222472). The same procedure applied to 0001-0209 alone gives 325158ea2a54cde9, which
#     production matched (MATCHES_REPOSITORY_0209_PG16), so the clean build is a faithful model of production. Production's post-release value is confirmed ONLY by the
#     owner's post-release discovery output or by the manifest of the post-release backup; if that value differs, this profile does not apply and must not be edited
#     to fit - investigate the difference first.
#   - restored_fingerprint: the fingerprint of a DUMP-AND-RESTORED copy. Observed twice and equal: (a) restore-proof.sh restoring a backup written by backup-offsite.sh
#     from that clean database, (b) pg_dump | pg_restore of the same clean database fingerprinted directly. It differs from the 0209 restored form because 0220 changes
#     the access_events policy text and the same three nested-CHECK constraints are re-parsed on restore (see production-pre-0210.profile).
#   restore-proof.sh accepts it ONLY while the manifest fingerprint equals schema_fingerprint above.
#
# Provenance of the row-count rules: carried unchanged from production-pre-0210.profile, whose counts matched the owner's 2026-10-28 production discovery output.
# Migration 0220 changes a policy, not data, so it cannot alter these counts. They are traffic-dependent and are NOT re-read after the release: if a real restore fails
# on one of these lines, correct that line through a reviewed change after reading the restored database; never loosen a rule to make a run pass.
# The empty-table rules describe a database in which the counter, orders and printers are not yet used in production; once real rows exist, make a new profile.
ledger_count=210
ledger_head=0220_normalize_access_event_tenant_context.sql
schema_fingerprint=c4d9f7f8aebfa5c8
restored_fingerprint=fd30bc44bee4dca0

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
