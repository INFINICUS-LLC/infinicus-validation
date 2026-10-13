# Closure: Hetzner VM / production-readiness discovery task (2026-10-13)

Status: **RESOLVED / COMPLETE — this task only.** Production migration 0171–0198, worker deployment, backup operationalization and activation remain **PARKED** (`PARKED_PRODUCTION_BACKUP_AND_MIGRATION.md`, unchanged). This is a documentation closure: no application source, SQL migration, deployment file or production state was changed by this record, and Claude executed no production command.

## Recalled task
The deferred Hetzner VM / production-readiness discovery task referenced by the parked register (its "Where things stand" facts), the production-target and live-environment discovery documents and the read-only discovery tooling. The parked register has no single item for it (its items 1–12 are the AWS / GPG / backup / migration / deployment steps), so this note records the closure instead of marking a register row; no new programme is created.

## Resumed and completed (owner-reported; verified by the owner on the server, not by Claude)
| Fact | Result |
|---|---|
| VM `infinicus-prod-01` reachable and running | yes |
| Server repository checkout | `ba1979ee137f2ae54e1108924407be8bbb4169ff` (source updated only) |
| Containers | `oci-api-1` healthy; `oci-postgres-1` healthy; `oci-caddy-1` running |
| PostgreSQL | 16.15 |
| Live migration ledger | exactly 170 migrations; head `0170_add_approved_action_source_recommendation.sql` |
| Schema fingerprint | `MATCHES_REPOSITORY_0170_PG16` |
| Event worker | not deployed; worker subscriptions: 0 |
| Autonomous execution | not activated |
| Running containers | not intentionally rebuilt or restarted onto the new code |

## What is CLOSED
VM accessibility; runtime presence; server checkout synchronization; live migration-head discovery; schema fingerprint verification; confirmation that production remains safely at 0170; that the worker is not deployed; that worker subscriptions are zero.

## What REMAINS PARKED / NOT COMPLETE (not collapsed into the above)
- Migration 0171–0198 (repository head is 0198; production stays at 0170 by design).
- App-role post-migration provisioning and verification.
- Event-worker deployment, including the `infinicus_worker_discovery` role (F4 / conflict C-3) and production worker subscriptions.
- Offsite backup operationalization (parked register items 1–7, 9, 10) and the restore proof.
- Identifying the deployed application SHA and `oci` compose `GIT_SHA` parity (register item 12): the checkout is synchronized, but the running containers were not rebuilt, so the running application build is still not identified by this closure.
- Production activation; live end-to-end validation after migration; production autonomous execution.
- Live findings A–D and runbook entry criteria E1–E14 (`LIVE_DB_READINESS_REVIEW_0170-0198.md`, `PRODUCTION_MIGRATION_RUNBOOK_0171-0198.md`).

## References (historical records, not rewritten)
`PRODUCTION_TARGET_DISCOVERY_AND_MIGRATION_READINESS.md`, `LIVE_ENVIRONMENT_DISCOVERY_AND_PRODUCTION_READINESS.md`, `LIVE_DB_READINESS_REVIEW_0170-0198.md`, `PRODUCTION_MIGRATION_RUNBOOK_0171-0198.md`, `production-discovery/`, `PARKED_PRODUCTION_BACKUP_AND_MIGRATION.md`, `ROADMAP_STATUS_2026-10-13.md`.

## Closure note
Hetzner VM / production-readiness discovery task resumed and completed. Server reachable; runtime healthy; repository synchronized to `ba1979e`; live PostgreSQL fingerprint-confirmed at repository migration 0170; event worker absent; worker subscriptions zero. This closes the VM/discovery task only. Production migration 0171–0198, worker deployment, backup operationalization and activation remain parked.
