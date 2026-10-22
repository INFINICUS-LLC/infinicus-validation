-- Migration: 0211_enable_rls_da_child_tables
-- Architecture finding V-18 - six Data Acquisition child tables had no row-level security.
--
-- 0021 left them without RLS because they carry no tenant column and are "attached to the parent (already RLS-protected)". A child table is still
-- directly queryable by the application role, so any tenant session that knew a row id could read or change another tenant's row.
--
-- Fix: ENABLE + FORCE row-level security on each child and one policy that admits a row only when its parent row is visible to the caller. The
-- subquery on the parent is itself subject to the parent's tenant+workspace policy (0021), so the child inherits exactly the parent's isolation.
--   publication_deliveries      -> publication_packages
--   api_collection_runs         -> collection_runs
--   database_collection_runs    -> collection_runs
--   duplicate_group_members     -> duplicate_groups
--   entity_match_candidates     -> entity_resolution_results
--   transformation_records      -> provenance_records
-- The policy has no FOR clause, so USING also acts as WITH CHECK: a tenant cannot insert a child row under another tenant's parent.
-- No tenant column, trigger, constraint, index, grant, role or data is added, changed or read. Superusers and BYPASSRLS roles are unaffected
-- (maintenance and test cleanup run as such). With no tenant context the parent is invisible, so the child is invisible: fail closed.
--
-- Out of scope (classified separately, need an ownership decision): platform.data_deletion_events, tenancy.membership_roles, files.file_links,
-- files.file_versions.
--
-- Idempotent: DROP POLICY IF EXISTS before CREATE; ENABLE/FORCE are no-ops when already set.
--
-- ROLLBACK (data is untouched, so this is safe at any time):
--   BEGIN;
--   DROP POLICY IF EXISTS publication_deliveries_isolation ON data_acquisition.publication_deliveries;
--   DROP POLICY IF EXISTS api_collection_runs_isolation ON data_acquisition.api_collection_runs;
--   DROP POLICY IF EXISTS database_collection_runs_isolation ON data_acquisition.database_collection_runs;
--   DROP POLICY IF EXISTS duplicate_group_members_isolation ON data_acquisition.duplicate_group_members;
--   DROP POLICY IF EXISTS entity_match_candidates_isolation ON data_acquisition.entity_match_candidates;
--   DROP POLICY IF EXISTS transformation_records_isolation ON data_acquisition.transformation_records;
--   ALTER TABLE data_acquisition.publication_deliveries NO FORCE ROW LEVEL SECURITY, DISABLE ROW LEVEL SECURITY;   -- repeat for each table
--   DELETE FROM _migrations WHERE filename = '0211_enable_rls_da_child_tables.sql';
--   COMMIT;

BEGIN;

ALTER TABLE data_acquisition.publication_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE data_acquisition.publication_deliveries FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS publication_deliveries_isolation ON data_acquisition.publication_deliveries;
CREATE POLICY publication_deliveries_isolation ON data_acquisition.publication_deliveries
  USING (EXISTS (SELECT 1 FROM data_acquisition.publication_packages p WHERE p.id = publication_package_id));

ALTER TABLE data_acquisition.api_collection_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE data_acquisition.api_collection_runs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS api_collection_runs_isolation ON data_acquisition.api_collection_runs;
CREATE POLICY api_collection_runs_isolation ON data_acquisition.api_collection_runs
  USING (EXISTS (SELECT 1 FROM data_acquisition.collection_runs r WHERE r.id = collection_run_id));

ALTER TABLE data_acquisition.database_collection_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE data_acquisition.database_collection_runs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS database_collection_runs_isolation ON data_acquisition.database_collection_runs;
CREATE POLICY database_collection_runs_isolation ON data_acquisition.database_collection_runs
  USING (EXISTS (SELECT 1 FROM data_acquisition.collection_runs r WHERE r.id = collection_run_id));

ALTER TABLE data_acquisition.duplicate_group_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE data_acquisition.duplicate_group_members FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS duplicate_group_members_isolation ON data_acquisition.duplicate_group_members;
CREATE POLICY duplicate_group_members_isolation ON data_acquisition.duplicate_group_members
  USING (EXISTS (SELECT 1 FROM data_acquisition.duplicate_groups g WHERE g.id = duplicate_group_id));

ALTER TABLE data_acquisition.entity_match_candidates ENABLE ROW LEVEL SECURITY;
ALTER TABLE data_acquisition.entity_match_candidates FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS entity_match_candidates_isolation ON data_acquisition.entity_match_candidates;
CREATE POLICY entity_match_candidates_isolation ON data_acquisition.entity_match_candidates
  USING (EXISTS (SELECT 1 FROM data_acquisition.entity_resolution_results e WHERE e.id = entity_resolution_result_id));

ALTER TABLE data_acquisition.transformation_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE data_acquisition.transformation_records FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS transformation_records_isolation ON data_acquisition.transformation_records;
CREATE POLICY transformation_records_isolation ON data_acquisition.transformation_records
  USING (EXISTS (SELECT 1 FROM data_acquisition.provenance_records v WHERE v.id = provenance_record_id));

INSERT INTO _migrations (filename) VALUES ('0211_enable_rls_da_child_tables.sql')
  ON CONFLICT (filename) DO NOTHING;

COMMIT;
