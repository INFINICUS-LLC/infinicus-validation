-- P3-OWNER-01 read-only evidence collection for the release rehearsal (Outcome Monitoring scope and restore-proof profile candidates).
-- STRICTLY READ-ONLY: SELECT only, aggregate counts and catalog names. No row content, names, emails, tokens, payloads or connection strings.
-- Complements f-na05-2-om-integrity-audit-v2.sql (scope integrity) and production-readonly-discovery.sh (server / image / backups / fingerprint).
-- Run in a session forced read-only, e.g.:
--   PGOPTIONS='-c default_transaction_read_only=on -c statement_timeout=30000 -c lock_timeout=2000' psql -X -v ON_ERROR_STOP=1 -f p3-owner-01-evidence.sql
-- E06 prints proposed restore-proof profile lines built from the REAL counts of this database. They are evidence for a reviewed profile change
-- (infrastructure/backups/expectations/production-pre-0199.profile): review them, do not paste them unreviewed. schema_fingerprint comes from
-- the discovery script (combined-sha256-16), expected 7fd4c419d738de8a at head 0198.
\set QUIET on
\pset format aligned
SELECT 'E01 identity' AS check, current_database() AS db, current_setting('server_version') AS pg, current_setting('transaction_read_only') AS read_only,
       (SELECT count(*) FROM public._migrations) AS ledger_count, (SELECT max(filename) FROM public._migrations) AS ledger_head;

-- E02 total rows of every Outcome Monitoring table (totals are NOT scope checks; ordinary counts need not be zero)
SELECT 'E02 outcome_monitoring table totals' AS check, c.relname AS tbl,
       (xpath('/row/c/text()', query_to_xml(format('select count(*) c from %I.%I', n.nspname, c.relname), false, true, '')))[1]::text AS n
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'outcome_monitoring' AND c.relkind = 'r' ORDER BY c.relname;

-- E03 row-level-security flags and policy count for every Outcome Monitoring table
SELECT 'E03 outcome_monitoring RLS' AS check, c.relname AS tbl, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced,
       (SELECT count(*) FROM pg_policies p WHERE p.schemaname = n.nspname AND p.tablename = c.relname) AS policies
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'outcome_monitoring' AND c.relkind = 'r' ORDER BY c.relname;

-- E04 non-internal trigger names on the Outcome Monitoring tables (names only)
SELECT 'E04 outcome_monitoring triggers' AS check, c.relname AS tbl, string_agg(t.tgname, ', ' ORDER BY t.tgname) AS triggers
  FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'outcome_monitoring' AND NOT t.tgisinternal GROUP BY c.relname ORDER BY c.relname;

-- E05 foreign keys that reference monitored_actions or outcome_observations (schema definitions only)
SELECT 'E05 FKs to monitored_actions / outcome_observations' AS check, conrelid::regclass::text AS tbl, conname, convalidated, pg_get_constraintdef(oid) AS def
  FROM pg_constraint WHERE contype = 'f'
   AND confrelid IN ('outcome_monitoring.monitored_actions'::regclass, 'outcome_monitoring.outcome_observations'::regclass) ORDER BY 2, 3;

-- E06 proposed restore-proof profile lines from the real database (counts only)
SELECT 'E06 profile candidate' AS check, line FROM (
  SELECT 1 AS o, 'ledger_count=' || count(*) AS line FROM public._migrations
  UNION ALL SELECT 2, 'ledger_head=' || max(filename) FROM public._migrations
  UNION ALL SELECT 3 + row_number() OVER (ORDER BY t),
         'count ' || t || '=' || CASE WHEN to_regclass(t) IS NULL THEN 'TABLE_MISSING'
           ELSE (xpath('/row/c/text()', query_to_xml(format('select count(*) c from %s', t), false, true, '')))[1]::text END
    FROM unnest(ARRAY['tenancy.tenants','identity.users','platform.businesses','events.outbox_events','audit.audit_events',
      'business_operations.inventory_movements','business_operations.purchase_receipts','business_operations.purchase_receipt_lines','business_operations.inventory_balances',
      'business_operations.purchase_orders','business_operations.purchase_order_line_items','outcome_monitoring.monitored_actions','outcome_monitoring.monitored_action_versions',
      'outcome_monitoring.monitored_action_status_history','outcome_monitoring.outcome_observations','outcome_monitoring.outcome_observation_versions',
      'outcome_monitoring.action_execution_verifications']) AS t
) x ORDER BY o;

-- E07 outbox classification by event type (type names and counts only; the restore proof fails on rows of any unlisted type)
SELECT 'E07 outbox candidate' AS check, 'outbox ' || event_type || '=' || count(*) AS line FROM events.outbox_events GROUP BY event_type ORDER BY event_type;
