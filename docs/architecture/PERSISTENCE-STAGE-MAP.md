# INFINICUS Persistence Stage Map

## Purpose

This map defines the ordered database implementation route from the shared foundation through Continuous Learning.

## Stage sequence

```text
Stage 1  Foundation
→ Stage 2A Shared Persistence Foundation
→ Stage 2B Data Acquisition
→ Stage 2C Business Operations
→ Stage 2D Business Intelligence
→ Stage 2E Business Digital Twin
→ Stage 2F Simulation
→ Stage 2G AI Decision Intelligence
→ Stage 2H Approved Business Action
→ Stage 2I Outcome Monitoring
→ Stage 2J Continuous Learning
```

## Stage map

| Build | Stage | Layer | Schema | Primary inbound handoff | Primary outbound handoff | Status |
|---|---|---|---|---|---|---|
| Historical | 1 | Foundation | foundation/public history | — | — | completed |
| Historical | 2A | Shared foundation | tenancy, identity, platform, audit, events, files | — | — | completed |
| Historical | 2B | Data Acquisition | data_acquisition | external sources | dal-to-bo | completed |
| Historical | 2C | Business Operations | business_operations | dal-to-bo | bo-to-bi | completed |
| BUILD-09 | 2D | Business Intelligence | business_intelligence | bo-to-bi | bi-to-dt | completed |
| BUILD-12 | 2E | Business Digital Twin | business_digital_twin | bi-to-dt | dt-to-sim | completed |
| BUILD-13 | 2F | Simulation | simulation | dt-to-sim | sim-to-adi | completed |
| BUILD-14 | 2G | AI Decision Intelligence | ai_decision_intelligence | sim-to-adi | adi-to-aba | completed |
| BUILD-15 | 2H | Approved Business Action | approved_business_action | adi-to-aba | aba-to-om | completed |
| BUILD-16 | 2I | Outcome Monitoring | outcome_monitoring | aba-to-om | om-to-cl | completed |
| BUILD-17 | 2J | Continuous Learning | continuous_learning | om-to-cl | cl-feedback | completed |

> **Status reconciliation (NA-02, 2026-10-15).** Stages 2E–2J were marked `prepared` when this map was written. The completion reports `.claude/state/reports/BUILD-12…BUILD-17-*-completion.md` record each stage as completed, and the repository holds contiguous migrations `0001`–`0198`. `completed` here means *the schema, repositories and tests exist in the repository*. It does **not** mean applied to any live database; live migration state is never inferred from the repository (Guardrail §XIX).

## Dependency rules

- BUILD-12 depends on the completed Stage 2D persistence baseline, not on BUILD-10 browser assembly.
- BUILD-13 depends on BUILD-12 completion.
- BUILD-14 depends on BUILD-13 completion.
- BUILD-15 depends on BUILD-14 completion.
- BUILD-16 depends on BUILD-15 completion.
- BUILD-17 depends on BUILD-16 completion.
- A later stage cannot assign migration numbers until the predecessor’s final migration is frozen.
- Specifications may be prepared in advance, but implementation remains blocked by the predecessor.

## Shared requirements for Stages 2E–2J

Every stage must provide:

1. dedicated PostgreSQL schema;
2. ordered self-registering migrations;
3. foreign keys and indexes;
4. enabled and forced RLS;
5. fail-closed tenant/workspace/business isolation;
6. append-only evidence and history;
7. lifecycle guards;
8. strict TypeScript repositories;
9. inbound and outbound handoff contracts;
10. canonical layer events;
11. atomic transactional outbox;
12. controlled errors;
13. structural tests;
14. live PostgreSQL integration tests;
15. empty-database installation;
16. migration rerun/idempotency;
17. full regression validation;
18. documentation and completion report.

## Layer-specific persistence responsibilities

### Stage 2E — Business Digital Twin

Persists:

- twin definitions;
- twin instances;
- state snapshots;
- variables;
- entities and relationships;
- assumptions and constraints;
- calibration and validation;
- uncertainty and confidence;
- scenario baselines;
- DT publication and deployment.

Does not persist Simulation runs.

### Stage 2F — Simulation

Persists:

- models;
- scenario definitions;
- requests and runs;
- Monte Carlo summaries;
- distributions and percentiles;
- result evidence;
- risk and sensitivity;
- scenario comparisons;
- validation and calibration;
- Simulation publication and deployment.

Does not recommend or approve.

### Stage 2G — AI Decision Intelligence

Persists:

- decision questions and cases;
- structured reasoning-run metadata;
- evidence;
- alternatives;
- recommendations;
- rationale;
- confidence;
- risks;
- limitations;
- monitoring requirements;
- policy and guardrail evaluations;
- ADI publication and deployment.

Does not store hidden chain-of-thought and does not approve or execute.

### Stage 2H — Approved Business Action

Persists:

- review packages;
- approval policies;
- approver authority;
- decisions;
- modifications;
- approved actions;
- execution plans;
- control gates;
- holds and releases;
- exceptions and appeals;
- attestations and audit;
- ABA publication and deployment.

Approval remains distinct from execution.

### Stage 2I — Outcome Monitoring

Persists:

- monitoring plans;
- monitored actions;
- observations;
- measurements and evidence;
- targets and thresholds;
- variance;
- alerts and incidents;
- attribution;
- reviews;
- learning feedback packages;
- OM publication and deployment.

Observed outcomes remain distinct from expected outcomes.

### Stage 2J — Continuous Learning

Persists:

- learning cases;
- feedback;
- lessons;
- patterns;
- model evaluation;
- drift and bias;
- policy evaluation;
- improvement proposals;
- change review and approval;
- release and rollback;
- knowledge artifacts;
- governed feedback publication.

Learning cannot silently mutate frozen historical records.

## Migration management

At each stage:

```text
inspect migration directory
→ identify final predecessor migration
→ freeze predecessor checksum
→ allocate next contiguous range
→ implement stage
→ verify empty install
→ verify rerun
→ freeze new range
```

Never reserve or guess migration numbers in advance.

## Queue execution

Recommended execution:

```text
BUILD-10 browser platform assembly may proceed independently
BUILD-12 Stage 2E
→ BUILD-13 Stage 2F
→ BUILD-14 Stage 2G
→ BUILD-15 Stage 2H
→ BUILD-16 Stage 2I
→ BUILD-17 Stage 2J
```

Parallel work is permitted only when repository queue policy explicitly supports independent tracks and merge conflict risk is controlled.

## Completion definition

The persistence route is complete only when Stage 2J passes:

- all structural tests;
- all live integration tests;
- all contract tests;
- full database regression;
- root browser regression;
- ADI regression;
- lint;
- typecheck;
- build;
- empty database install;
- migration idempotency;
- frozen checksum verification.
