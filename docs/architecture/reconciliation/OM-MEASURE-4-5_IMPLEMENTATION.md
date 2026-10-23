# OM-MEASURE-4/5 — inventory source and fail-closed measurement runner

This branch adds a BO-owned read port for immutable inventory `issue` movements and an OM runner that produces deterministic PENDING or INCONCLUSIVE assessments. It does not turn an issue movement into a stock-out, success claim, or attribution result. OBSERVED, VERIFIED, FAILED, receipt issuance, and learning release remain closed.

## Source contract (OM-MEASURE-4)

`InventoryOutcomeEvidenceRepository.readIssues` accepts a tenant-scoped business and inventory item plus explicit baseline and window bounds. One SQL statement reads the BO balance cardinality, the item/warehouse's append-only issue movements, and the database time from one snapshot. It returns exact decimal quantity strings, a SHA-256 digest over ordered facts and bounds, and a `truncated` marker after 10,000 events. Missing or multiple balances cannot be treated as a measured target. The digest changes if late/backdated movements are inserted. No BO rows are written.

The source is **demand evidence only**. The current BO schema does not hold an authoritative stock-out event series or a reconstruction-safe historical balance. Current inventory balance values are mutable and are not used to infer past stock-outs.

## Runner contract (OM-MEASURE-5)

`GovernedMeasurementRunner.assess` reads the scoped execution verification, approved definitions, the database clock, and BO issue evidence. It requires an active service account in the same tenant and workspace. It uses only a versioned definition for `inventory_issue_count`; it supplies no default window, baseline, threshold, or sufficiency rule. The assessment digest is deterministic for identical inputs. `runAndRecord` persists it through `GovernedMeasurementVerdictRepository`, which requires a dedicated, non-superuser, non-BYPASSRLS database role.

Migration 0215 permits only PENDING and INCONCLUSIVE rows, with a stable reason code, source/assessment digests, and a scoped service account. It rejects positive states and incomplete record shapes. A unique index makes exact replays idempotent. The application role retains no direct write privilege on governed verdicts. The append-only triggers and forced RLS remain.

Provisioning the runner role is a separate environment action: create a dedicated `LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE` role, apply `grant-om-measure-runner-role.sh` with `ADMIN_DATABASE_URL` and `OM_RUNNER_ROLE`, and supply that role's connection pool to the writer. This branch does not provision credentials, schedule a worker, or activate a deployment.

## Gates still closed

- No owner-approved definition values or source semantics have been supplied. An absent definition produces `NO_DEFINITION` and cannot reach OBSERVED.
- `inventory_issue_count` is a bounded evidence metric, not a stock-out frequency or benefit measure. Owner approval of the first metric and its values is required.
- OM-MEASURE-6 must govern attribution before an observed outcome can be defensible. Migration 0215 expressly refuses OBSERVED.
- The runner is callable by a service with an injected pool. Scheduling, retry-limit policy, and deployment configuration are not enabled here.
