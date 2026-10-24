# CL-ACT-05 — Shadow Operational Controls (preparatory)

**Status:** isolated code proposal only. Not a deployed feature flag or production authorization system.

The `evaluateControlledShadow` function provides an explicit opt-in, default-off, kill-switch-protected and tenant/workspace/business-scoped path to the existing pure shadow evaluator. Regardless of candidate eligibility, it returns `releaseAuthorized: false`, `learningApplied: false`, and `mutationsPermitted: false`. Kill switch and invalid scope refuse evaluation before calling the shadow gate. No database, queue, event publisher, model writer, policy writer, or Business Operations executor is accessible.

**Control limitations:** Controls are supplied by the caller for an offline rehearsal; this is not a canonical authorization source, signed control record, or authenticated operator permission. The caller must be trusted and the API must not expose this function to arbitrary external requests. The result is an ephemeral immutable evaluation record suitable for tests; it is **not** durable audit evidence. Creating operator-managed flags, signed audit storage, or live shadow processing requires separate authority, security review and acceptance.

**Verification:** Tests for default-off, kill switch priority, three-scope isolation, malformed input, no-mutation outputs and dependency guard are committed. Automated test execution, typecheck and CI are not yet independently confirmed.

**Unchanged:** OM authority decisions M1–M3, O1, A1, P1; OM→CL one learning gate; positive outcome verdict restriction; production learning disabled. No migration, production deployment or Stack A work.
