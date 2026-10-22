-- Migration: 0212_enable_rls_membership_roles_and_file_children
-- Architecture finding V-18 (continued) - three more child tables had no row-level security: tenancy.membership_roles, files.file_versions,
-- files.file_links. None carries a tenant column; each is "attached to a parent that is already RLS-protected" (tenancy.memberships, files.file_objects),
-- yet each is directly queryable by the application role, so a tenant session that knew an id could read or change another tenant's row (for
-- membership_roles that is another tenant's role assignments, i.e. authority evidence).
--
-- Fix: ENABLE row-level security and one policy per table that admits a row only when its parent row is visible. The parent subquery is itself subject to
-- the parent's tenant+workspace policy, so the child inherits exactly the parent's isolation. The policy has no FOR clause, so USING also acts as
-- WITH CHECK (a tenant cannot attach a child to another tenant's parent).
--   tenancy.membership_roles -> tenancy.memberships
--   files.file_versions      -> files.file_objects
--   files.file_links         -> files.file_objects
--
-- ENABLE only, NOT FORCE: the parents (0011) are ENABLE-only too. The table owner and superuser/BYPASSRLS roles keep their unfiltered access, which
-- the SECURITY DEFINER authority function (0196, reads membership_roles), the erasure/export/backup tooling and the migration role rely on. The runtime
-- application role is not the owner and is not BYPASSRLS, so the policy applies to it. Every application path to membership_roles
-- (MembershipRepository, OwnershipEvidenceRepository) already runs inside withTenantTransaction and reaches the table through a visible membership.
--
-- No column, trigger, constraint, index, grant, role or data is added, changed or read. Idempotent. Not applied to production by this change.
--
-- ROLLBACK (data is untouched, so this is safe at any time):
--   BEGIN;
--   DROP POLICY IF EXISTS membership_roles_isolation ON tenancy.membership_roles;
--   DROP POLICY IF EXISTS file_versions_isolation ON files.file_versions;
--   DROP POLICY IF EXISTS file_links_isolation ON files.file_links;
--   ALTER TABLE tenancy.membership_roles DISABLE ROW LEVEL SECURITY;
--   ALTER TABLE files.file_versions DISABLE ROW LEVEL SECURITY;
--   ALTER TABLE files.file_links DISABLE ROW LEVEL SECURITY;
--   DELETE FROM _migrations WHERE filename = '0212_enable_rls_membership_roles_and_file_children.sql';
--   COMMIT;

BEGIN;

ALTER TABLE tenancy.membership_roles ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS membership_roles_isolation ON tenancy.membership_roles;
CREATE POLICY membership_roles_isolation ON tenancy.membership_roles
  USING (EXISTS (SELECT 1 FROM tenancy.memberships m WHERE m.id = membership_id));

ALTER TABLE files.file_versions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS file_versions_isolation ON files.file_versions;
CREATE POLICY file_versions_isolation ON files.file_versions
  USING (EXISTS (SELECT 1 FROM files.file_objects f WHERE f.id = file_object_id));

ALTER TABLE files.file_links ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS file_links_isolation ON files.file_links;
CREATE POLICY file_links_isolation ON files.file_links
  USING (EXISTS (SELECT 1 FROM files.file_objects f WHERE f.id = file_object_id));

INSERT INTO _migrations (filename) VALUES ('0212_enable_rls_membership_roles_and_file_children.sql')
  ON CONFLICT (filename) DO NOTHING;

COMMIT;
