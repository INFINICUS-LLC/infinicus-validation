-- BO-PUB-DEV-02A-R4: DISPOSABLE DATABASE CERTIFICATION PROPOSAL ONLY.
-- Not part of numbered migrations. Never execute on production/shared databases.
-- Existing migration 0035 enables RLS and installs bo_pkg_isolation,
-- but does not force RLS for the BO publication header.
BEGIN;
ALTER TABLE business_operations.bo_publication_packages FORCE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class
    WHERE oid = 'business_operations.bo_publication_packages'::regclass
      AND relrowsecurity AND relforcerowsecurity
  ) THEN
    RAISE EXCEPTION 'BO publication header FORCE RLS certification failed';
  END IF;
END $$;
COMMIT;
-- Run the non-owner application-role integration tests separately after applying
-- this script to a disposable, migrated PostgreSQL database.
-- CAUTION: table owners are now subject to RLS; verify migration/maintenance
-- roles, policy coverage, and existing header-only prepare/dispatch/acknowledge.
