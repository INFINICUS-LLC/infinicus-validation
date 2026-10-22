# NEW-ARCHITECTURE COMPLETION MATRIX

Workstream NEW-ARCHITECTURE-01. Baseline as of 2026-10-22 on main `5fc8489`. Data: `docs/architecture/completion-matrix/work-packages.json`. Calculator/validator: `infinicus-platform/scripts/completion-matrix.mjs` (`--check`, `--json`). Scope: Stack B only; Stack A is frozen and not scored.

## 1. Headline (two bases, reported separately)

| Basis | Score | Definition |
|---|---|---|
| Full scope | **29.7%** | every requirement unit of the 8 domains / 9 layers (246 units, 69 work packages) |
| Guardrail slice | **78.9%** | the 13 acceptance criteria (G-A..G-M) of the first governed action |

**Owner decision needed:** which basis defines the 90% target. The slice is the narrow, evidence-heavy view; the full scope is the honest view of the whole architecture. No cherry-picking: both are published on every checkpoint.

## 2. Method

Weights: specification 10%, functional 35%, end-to-end integration 25%, automated verification 20%, operational readiness 10%.

`score = 0.10*spec + 0.35*(impl*100) + 0.25*(impl*integration) + 0.20*(impl*verification) + 0.10*(impl*operational)` (inputs 0-100, impl 0-1). Integration, verification and operational credit scales with implementation so unbuilt work cannot earn them. Aggregation is weighted by requirement units. Every row carries an evidence string. Levels rubric:

- **spec**: 100 locked spec + schema + a Stack B contract artifact; 75 locked spec + schema; 50 locked spec or owner-approved block document only; 25 direction only; 0 none
- **impl**: fraction of the cluster's requirement units that work in Stack B (a unit that exists only as a table or repository counts 0.25; a vertical slice for one action counts 0.5-0.75); multiplied into functional, integration, verification and operational
- **integration**: 100 end to end through the real API and database AND the user-facing path; 75 cross-layer end to end through API and database, no UI; 50 reachable through an API route with integration tests; 25 repository or service level only; 0 none
- **verification**: 100 unit + integration + architecture guards + mutation or negative proofs; 75 integration + architecture guards; 50 integration or unit only; 25 structural only; 0 none
- **operational**: 100 deployed and observed in production (nothing qualifies); 50 runbook + health or monitoring endpoint + kill switch + CI gate; 25 runbook or health endpoint only; 0 none. An undeployed feature is never production accepted.

## 3. Results by layer

| Layer | Units | Score |
|---|---|---|
| DAL | 25 | 32.1% |
| BO | 25 | 48.6% |
| BI | 25 | 20.9% |
| BDT | 24 | 22.7% |
| SIM | 27 | 26.6% |
| ADI | 25 | 34.6% |
| ABA | 25 | 59.9% |
| OM | 25 | 19.4% |
| CL | 25 | 8.6% |

## 4. Results by domain

| Domain | Units | Score |
|---|---|---|
| DATA | 29 | 34% |
| BUSINESS ADMINISTRATION | 7 | 28.6% |
| COMMERCE | 8 | 54% |
| OPERATIONS | 14 | 36.5% |
| FINANCE | 1 | 38.8% |
| INTELLIGENCE | 100 | 26.8% |
| EXPERIENCE | 10 | 20.6% |
| CONTROL LOOP | 77 | 29.2% |

## 5. Work packages

| ID | Title | Units | Score |
|---|---|---|---|
| DAL-1 | Sources, connectors, credential references, schedules | 4 | 46.5% |
| DAL-2 | Collection channels (webhook, file, API, database, manual, streaming) | 6 | 31% |
| DAL-3 | Preparation pipeline (schema detection, validation, cleaning, normalization, entity resolution, dedup, classification, sensitive data, missing data) | 9 | 15.1% |
| DAL-4 | Quality scoring, source reliability, provenance | 3 | 53.6% |
| DAL-5 | Core runtime, publication handoff, assembly | 3 | 44.4% |
| BO-1 | Core runtime, business profile, organization | 3 | 54.2% |
| BO-2 | Catalogue, customers, pipeline, pricing, orders, payments | 6 | 53.2% |
| BO-3 | Procurement, suppliers, inventory, warehouse, fulfilment | 5 | 64.7% |
| BO-4 | Workforce, tasks, scheduling, assets | 4 | 35% |
| BO-5 | Expenses and operational finance | 1 | 38.8% |
| BO-6 | Service quality and incident/exception handling | 2 | 20.3% |
| BO-7 | Compliance and operational risk | 1 | 7.5% |
| BO-8 | Operational event publication, data handoff, assembly | 3 | 61.1% |
| BI-1 | Core, mapping, ingestion, validation, cleaning, entity resolution, transformation | 7 | 12.6% |
| BI-2 | Warehouse, metric registry, metric calculation | 3 | 30.2% |
| BI-3 | Domain intelligence (financial, sales, customer, marketing, operations, inventory, workforce, market) | 8 | 20.6% |
| BI-4 | Trend, anomaly and root-cause analysis | 3 | 19% |
| BI-5 | Dashboards, reporting, alerts | 2 | 24.4% |
| BI-6 | Twin publication handoff, assembly | 2 | 36.1% |
| BDT-1 | Core, identity/instance registry, ontology, intake validation | 4 | 50.8% |
| BDT-2 | Entity graph and domain twins (organization, financial, demand, sales, marketing, operations, inventory, workforce, assets, market) | 11 | 13.7% |
| BDT-3 | Synchronization, transitions, constraints, risk, opportunity | 5 | 10.4% |
| BDT-4 | Integrity, history, scenario baseline, simulation handoff | 4 | 35% |
| SIM-1 | Operating modes, simulation basis, baseline vs proposed | 3 | 42% |
| SIM-2 | Monte Carlo, distributions, risk metrics, sensitivity | 4 | 42% |
| SIM-3 | Scenario comparison, verdict, calibration | 3 | 36.3% |
| SIM-4 | Cold start, stress testing, constraint/dependency awareness, economy, customer effects | 6 | 15.2% |
| SIM-5 | Forecast boundary, immutable history, reporting | 3 | 27.6% |
| SIM-6 | Scenario-first UX, navigation, layer guide, guided mode, data maturity | 5 | 10% |
| SIM-7 | Outputs to ADI, OM and CL | 3 | 30.2% |
| ADI-1 | Core, request intake, ownership/access, context, twin and simulation adapters, evidence registry | 7 | 49.4% |
| ADI-2 | Goals, triggers, problem definition, evidence assembly, objectives and constraints | 5 | 19% |
| ADI-3 | Alternatives, feasibility, impact, simulation orchestration, risk, ranking | 6 | 29.3% |
| ADI-4 | Confidence, explainability, next best action, challenge, human review gate | 5 | 35% |
| ADI-5 | ABA package handoff and assembly | 2 | 36.1% |
| ABA-1 | Core, package intake, action ontology, lifecycle | 4 | 81.7% |
| ABA-2 | Authority, approval policy, multi-stage workflow, approval evidence | 4 | 81.7% |
| ABA-3 | Contract generation, scope boundaries, revalidation, collision | 4 | 77.1% |
| ABA-4 | Decomposition, assignment, reservation, scheduling, adapters, dry run | 6 | 19.2% |
| ABA-5 | Controlled execution, failure handling, evidence, completion verification | 4 | 64.3% |
| ABA-6 | Monitoring contract, OM handoff, assembly | 3 | 54.2% |
| OM-1 | Core, contract intake, metric registry, observation sources | 4 | 41.4% |
| OM-2 | Observation collection, validation, baselines/targets, windows, normalization | 5 | 16.1% |
| OM-3 | Progress, variance, alerts, attribution, causation, confounders | 6 | 5% |
| OM-4 | Expected vs actual, confidence, benefit, adverse outcomes, exceptions | 5 | 5% |
| OM-5 | Audit trail, verdict, learning package, CL handoff, assembly | 5 | 36.7% |
| CL-1 | Core, intake, evidence registry, taxonomy, scope, confidence, duplicates, comparison | 8 | 10.9% |
| CL-2 | Learning types (assumptions, rules, policy, risk, forecast, simulation, twin, data quality, process, outcomes) | 10 | 7.5% |
| CL-3 | Recommendations, governance, controlled update, deployment, verification, publication, assembly | 7 | 7.5% |
| X-01 | Authentication and session management | 1 | 51.9% |
| X-02 | Business onboarding | 1 | 15.3% |
| X-03 | Workspace and branch administration | 1 | 7.1% |
| X-04 | User roles and permissions administration | 1 | 10.1% |
| X-05 | Business administration (profile, currency, subscription) | 1 | 12.7% |
| X-06 | Navigation between operating modules | 1 | 36.3% |
| X-07 | Standard and Professional modes | 1 | 10% |
| X-08 | Consistent errors, loading and empty states; accessibility | 1 | 42.5% |
| X-09 | Catalogue and product management screens | 1 | 36.3% |
| X-10 | Inventory screens | 1 | 2.5% |
| X-11 | Sales and orders screens (POS counter, history, printers) | 1 | 76.9% |
| X-12 | Suppliers and purchasing screens | 1 | 2.5% |
| X-13 | Staff and workforce screens | 1 | 2.5% |
| X-14 | Data import screens | 1 | 2.5% |
| X-15 | Business intelligence presentation | 1 | 16.5% |
| X-16 | Digital Twin inspection | 1 | 22.3% |
| X-17 | Running and reading simulations | 1 | 16.5% |
| X-18 | Actionable recommendations | 1 | 22.3% |
| X-19 | Authorized decision submission | 1 | 33.1% |
| X-20 | Action execution and outcome monitoring screens | 1 | 19.4% |

## 6. Guardrail slice criteria

| ID | Criterion | Score |
|---|---|---|
| G-A | DAL: canonical data enters with provenance for the first action | 78.6% |
| G-B | BO: canonical truth, one authoritative writer, transactional safety | 86.3% |
| G-C | BI / BDT / SIM evidence for the first action | 72.7% |
| G-D | ADI: governed recommendation; cannot execute | 83.8% |
| G-E | ABA: review, approve, sealed package, revoke/expire/supersede | 86.3% |
| G-F | BO execution with fresh authority, lock, baseline CAS, evidence, recovery | 88.8% |
| G-G | Events: authorization and execution handoffs durable and idempotent | 86.3% |
| G-H | OM: execution independently verified; pending/inconclusive fail closed | 86.3% |
| G-I | CL: no unverified result can enter learning; boundary proven | 83.8% |
| G-J | Security and tenancy: authorization, isolation, no browser-derived authority, RLS | 63.4% |
| G-K | Database: migrations validated, live delta reviewed, runbook, rollback/backup | 76.9% |
| G-L | Operations: backup/restore, observability for execution failures, deployment runbook | 49% |
| G-M | End to end: data to OM with negative paths | 83.8% |

## 7. Checkpoints

| Checkpoint | Full scope | Slice | Status |
|---|---|---|---|
| Baseline | 29.1% | 78.9% | recorded |
| NEW-BI-01 (draft PR; ESTIMATE until merged and CI-verified) | 29.7% | 78.9% | estimated |
| 75% | - | - | pending |
| 80% | - | - | pending |
| 85% | - | - | pending |
| 90% | - | - | pending |

## 8. Rules for updating

- Raise a score only with evidence merged on main (code, test, CI result). Unmerged branches do not count.
- Owner-decision and hardware items stay at their current score and are marked BLOCKED, never estimated.
- Run `node scripts/completion-matrix.mjs --check` before committing changes to the data file.
- Weights, rubric and units are changed only by owner decision; record the change here.
