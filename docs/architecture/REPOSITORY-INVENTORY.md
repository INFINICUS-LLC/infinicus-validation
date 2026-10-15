# INFINICUS Repository Inventory

## Purpose

This document gives Claude a fast repository map so later builds do not repeat broad repository discovery.

This inventory must be updated after each completed build.

## Project tracks

### Browser/layer-assembly track

Completed browser bundles:

| Layer | Build | Browser surface |
|---|---:|---|
| Digital Twin | BUILD-01 | root DT blocks and bundle |
| Business Intelligence | BUILD-02 | root BI blocks and bundle |
| Approved Business Action | BUILD-03 | root ABA blocks and bundle |
| Outcome Monitoring | BUILD-04 | root OM blocks and bundle |
| Continuous Learning | BUILD-05 | root CL blocks and bundle |
| AI Decision Intelligence | BUILD-06 | root ADI blocks and bundle |
| Simulation integration | BUILD-07 | Engine v3 adapter and SIM→ADI integration |
| Data Acquisition | BUILD-08 | root DA blocks and bundle |
| Platform assembly | BUILD-10 | specification prepared; implementation state must be read from queue |

Business Operations currently has persistence but no completed browser bundle.

### Database persistence track

| Stage | Layer | Schema | Status |
|---|---|---|---|
| 1 | Foundation | public/history foundation | completed |
| 2A | Shared foundation | tenancy, identity, platform, audit, events, files | completed |
| 2B | Data Acquisition | data_acquisition | completed |
| 2C | Business Operations | business_operations | completed |
| 2D | Business Intelligence | business_intelligence | completed |
| 2E | Business Digital Twin | business_digital_twin | completed |
| 2F | Simulation | simulation | completed |
| 2G | AI Decision Intelligence | ai_decision_intelligence | completed |
| 2H | Approved Business Action | approved_business_action | completed |
| 2I | Outcome Monitoring | outcome_monitoring | completed |
| 2J | Continuous Learning | continuous_learning | completed |

## Important repository paths

```text
CLAUDE.md
CLAUDE-QUEUE-INSTRUCTIONS.md
.claude/state/implementation-status.json
.claude/state/reports/
docs/implementation-queue/
docs/architecture/
index.html
platform/
infinicus-platform/
infinicus-platform/packages/database/
infinicus-platform/packages/event-contracts/
infinicus-platform/packages/handoff-contracts/
infinicus-platform/docs/
```

## Browser namespaces

Expected existing namespaces include:

```text
window.INFINICUS.DA
window.INFINICUS.DT
window.INFINICUS.BI
window.INFINICUS.ABA
window.INFINICUS.OM
window.INFINICUS.CL
window.INFINICUS.ADI
window.INFINICUS.SIMULATION
window.INFINICUS.PLATFORM
```

Business Operations does not currently expose a browser namespace.

Exact runtime methods are non-uniform and must be inspected before use. Known method families include:

```text
invoke
callRoute
dispatch
call
diagnose
diagnostics
```

Do not normalize them without a frozen compatibility plan.

## Handoff-contract inventory

Expected handoff files:

```text
dal-to-bo.ts
bo-to-bi.ts
bi-to-dt.ts
dt-to-sim.ts
sim-to-adi.ts
adi-to-aba.ts
aba-to-om.ts
om-to-cl.ts
cl-feedback.ts
```

Previously completed contracts:

```text
dal-to-bo.ts
bo-to-bi.ts
sim-to-adi.ts
```

Prepared persistence stages complete the remaining contracts in dependency order.

The current file contents must be inspected before implementation because later work may already have completed some placeholders.

## Event-contract inventory

Canonical event types are exported from:

```text
infinicus-platform/packages/event-contracts/src/
```

Do not create duplicate event synonyms.

Each new database stage must add or reuse layer-owned events and atomic outbox wrappers.

## Database package inventory

Primary location:

```text
infinicus-platform/packages/database/
```

Important areas:

```text
migrations/
src/repositories/
src/services/
src/types/
tests/
```

Repository conventions include:

- strict TypeScript;
- branded tenant/workspace/business IDs;
- shared transaction client;
- tenant-scoped transactions;
- atomic outbox writes;
- controlled errors;
- structural tests;
- live PostgreSQL integration tests;
- empty-database installation;
- migration rerun/idempotency.

## Frozen migration boundary

As of BUILD-09:

```text
0001–0049
```

Later builds must inspect the migration directory to determine the actual current boundary before assigning numbers.

**Current repository boundary (NA-02, verified 2026-10-15 at `main` `130bf5a`):** `0001`–`0198`, 198 files, contiguous, no duplicates. The `0001–0049` line above is the historical BUILD-09 boundary only. Stages 2E–2J are recorded as completed in `.claude/state/reports/` (code, repositories and tests in the repository; not evidence of live application). The live database state is not derived from this inventory; see `docs/architecture/reconciliation/PRODUCTION_FACTS_OWNER_REPORTED_2026-10-15.md`.

## RLS conventions

Stages 2A–2C established fail-closed RLS.

Stage 2D strengthened the convention to:

```sql
ENABLE ROW LEVEL SECURITY;
FORCE ROW LEVEL SECURITY;
```

Stages 2E–2J must retain this strengthened convention.

## Append-only conventions

The repository contains a shared mutation-prohibition trigger pattern, including `forbid_mutation()` or its canonical equivalent.

Use it for:

- status history;
- evidence;
- results;
- observations;
- audit;
- publication events;
- deployment and rollback history.

Dedicated lifecycle guards are required for published or released aggregates.

## Existing validation baselines

Known completed-build baselines include:

```text
root browser regression: 180 tests
ADI source regression: 106 tests
handoff-contract suite after BUILD-09: 45 tests
database package after BUILD-09: 702/703 with one intentional skip
lint: 21/21 tasks
build: 21/21 tasks
```

These are historical baselines, not substitutes for reading the latest test output.

## Documentation inventory

Important documentation families:

```text
docs/implementation-queue/
docs/architecture/
infinicus-platform/docs/database-stage-*.md
.claude/state/reports/
```

Every database stage must add:

- authoritative specification;
- queue metadata;
- completion report;
- database-stage documentation;
- migration checksum evidence.

## Update rule

After each build:

1. update statuses and migration boundary;
2. record new repositories;
3. record new contracts and events;
4. record exact current test totals;
5. preserve historical baselines separately;
6. do not claim implementation from specification files alone.
