# CL-ACT-04 — PostgreSQL-backed Shadow Acceptance

Base: main at `d4e3957af83bbbc32524e1861da22dac779a7c59` (CL-ACT-03 merged).

## Scope and code evidence

Extends the existing `cl-boundary-1.integration.test.ts` PostgreSQL fixture, using real OM repositories and the configured application-role `DATABASE_URL` with tenant/workspace RLS, and the fixture-only `ADMIN_DATABASE_URL` for setup and count verification.

- Inserts an actual `OUTCOME_PENDING` verification. It never forges a PostgreSQL `OUTCOME_VERIFIED` row.
- Loads observation and execution facts via `ActionExecutionVerificationRepository.learningSourcesForObservation` under the current tenant/workspace.
- Calls the pure `evaluateLearningShadow` using the retrieved facts; requires `candidateEligible=false`, `LEARNING_GATE_CLOSED`, `releaseAuthorized=false`, `learningApplied=false` and `mutationsPermitted=false`.
- Replays with unchanged inputs and checks deterministic output.
- Asserts cross-tenant lookup returns no observation or facts and evaluates ineligible.
- Compares admin-visible counts of OM execution verifications, observations, feedback packages, OM publication packages and CL intake packages before and after each shadow rehearsal.

## Restrictions

This is integration **test code only**. It neither creates a production shadow-runner nor writes model/policy/operational changes. Existing OM outcome-state DB constraints and OM→CL learning gate remain untouched. No production migration, deployment or learning activation.

## Execution requirements

The integration suite is conditional on both `DATABASE_URL` and `ADMIN_DATABASE_URL`, pointing to a **disposable** migrated PostgreSQL database with distinct application and administrative roles. Never point this block's fixture writes at a production or shared live database.

Suggested targeted command from `infinicus-platform/` after preparing the disposable database:

`pnpm --filter @infinicus/outcome-monitoring-runtime exec vitest run tests/cl-boundary-1.integration.test.ts`

Execute the entire related architecture suite, typecheck and CI as well. If the environment variables are absent, Vitest **skips** DB tests; skipped tests do not count as acceptance. Record actual results and row/tenant/RLS evidence before merge.

**Limitations:** Table-count equality proves no net new rows in the selected tables, not general database immutability; any other mutation requires independent DB privilege/audit proof. The existing boundary tests separately verify refusal/no sink publication. This block makes no claim of complete production authorization, positive outcome verification, or CL learning readiness.
