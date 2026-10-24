# CL-ACT-03 — Disposable Shadow Mode Rehearsal

Baseline: main ff20121c6ff3a3e730e5448f6ae8d38a3b55a13c (merged CL-ACT-02, PR #287).

## Implemented
- Pure, synthetic **in-memory** rehearsal of the existing OM→CL gate through `evaluateLearningShadow`.
- Positive **hypothetical** input proves the gate is being exercised (not a permanently false stub), while output always denies release, learning application, and mutations.
- Negative fixtures cover tenant/workspace/business mismatches; unsupported evidence source; invalid SHA-256 digest; detached action; pending outcome or execution; conflicting facts sharing an execution ID.
- Deterministic replay and source-code dependency guard enforce the read-only test boundary.

## Boundaries
This block is a disposable *unit/contract rehearsal*, **not** a disposable PostgreSQL integration run, production shadow processing, a live model, or a verified OM outcome. It creates no database tables and connects to no database, sink, queue, API, operational executor, model writer or policy publisher.

`OUTCOME_VERIFIED` is used in an isolated synthetic fixture solely to exercise the positive branch of the existing pure gate. The current OM persistent verdict restrictions remain unchanged. M1–M3, O1, A1, P1 authority decisions remain pending. CL learning activation stays disabled.

## Validation required before merge
1. Execute `pnpm --filter @infinicus/outcome-monitoring-runtime test -- cl-act-03-disposable-shadow.test.ts` from `infinicus-platform/` in the normal CI environment.
2. Execute the whole Outcome Monitoring runtime test suite, lint, typecheck and build.
3. Confirm full GitHub CI and unchanged OM→CL architecture guards.
4. No automatic merge or production deployment.

## Explicit future gate
A genuine disposable PostgreSQL rehearsal of production source lookup, tenant RLS and append-only database evidence must be a distinct authorized block, after relevant authority contracts and schema work. This block does **not** claim such proof.
