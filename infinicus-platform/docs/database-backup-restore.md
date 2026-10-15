# Database Backup and Restore

> **Correction (NA-02, 2026-10-15).** This document was written at Stage 2A on the assumption that production would be **Neon PostgreSQL**. The deployment actually in use is **self-hosted PostgreSQL 16 in Docker** on a Hetzner server (`infrastructure/deployment/hetzner`, project name `oci` on the live host). The Neon sections below are a **superseded assumption** and are kept for history only; no Neon account is part of the deployment. For the current backup tooling see `infrastructure/backups/README.md` (encrypted off-VM backup, restore proof, freshness check; tested with a file sink, **not** against real S3) and `docs/incident-response/runbooks/{restore-procedure,migration-rollback,deployment-rollback}.md`. No production backup or restore rehearsal is documented in the repository; the owner has reported a restore rehearsal in an isolated environment (see `docs/architecture/reconciliation/PRODUCTION_FACTS_OWNER_REPORTED_2026-10-15.md`).

## Assumptions

*(Superseded — see correction above.)* The INFINICUS platform was originally assumed to target **Neon PostgreSQL** for production. Neon provides:

- Continuous WAL-based backup (branching from any point in time)
- Branch-level restore via the Neon console or API
- Project-level export via `pg_dump`

No separate backup infrastructure is required at Stage 2A. This document records the procedure outline to follow when a self-hosted PostgreSQL or replica is used.

## Backup procedure (pg_dump)

```bash
# Full schema + data dump (compressed)
pg_dump \
  --no-password \
  --format=custom \
  --schema=public \
  --schema=tenancy \
  --schema=identity \
  --schema=platform \
  --schema=audit \
  --schema=events \
  --schema=files \
  --file="infinicus_$(date +%Y%m%d_%H%M%S).pgdump" \
  "$DIRECT_DATABASE_URL"
```

Store dumps in an object store (S3/R2/GCS) with versioning enabled. Never store database dumps in the repository.

## Restore procedure

```bash
# Restore into an empty target database
pg_restore \
  --no-password \
  --clean \
  --if-exists \
  --format=custom \
  --dbname="$RESTORE_DATABASE_URL" \
  infinicus_<timestamp>.pgdump
```

## Retention rules

| Type                 | Retention   |
|----------------------|-------------|
| Daily full dumps     | 30 days     |
| Audit schema exports | 7 years (regulatory minimum) |
| Event archive        | 90 days active; archive to cold storage after |
| File metadata only   | Follows tenant data lifecycle |

Binary file content is never stored in PostgreSQL. Retention of object storage files follows the storage provider's lifecycle policies configured per bucket.

## Neon point-in-time restore (superseded assumption — not applicable to the Hetzner deployment)

```bash
# Via Neon API — create a branch from a historical timestamp
curl -X POST https://console.neon.tech/api/v2/projects/<project_id>/branches \
  -H "Authorization: Bearer $NEON_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"branch": {"parent_timestamp": "2026-07-18T00:00:00Z"}}'
```

## Tenant data deletion

Deleting a tenant's data requires:
1. Soft-delete the `tenancy.tenants` record (`deleted_at = now()`).
2. Schedule a hard-delete job after the applicable retention period.
3. Cascade via FK constraints only for join records (`ON DELETE CASCADE`).
4. Do not cascade-delete historical audit or financial records unless legally required.

## What remains for Stage 2B

- Automated backup validation (restore-and-verify job)
- Per-tenant export capability
- Cross-region replication configuration
