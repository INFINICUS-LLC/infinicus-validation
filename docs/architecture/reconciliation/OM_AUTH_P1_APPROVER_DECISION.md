# OM-AUTH-P1 — human outcome-verdict approver authority decision

Status: **owner decision required; positive verdict closed**. Base: `main` at `3a2b09c`. A1 was pushed separately but was not present on fetched `main` when this branch was cut. No permission, assignment, route, verdict writer, migration or learning gate is changed.

## Canonical authority reconciliation

ABA owns `approver_assignments`, assignment versions, authority scopes and delegations. Existing ABA decision flows require a previously granted, active assignment for the authenticated principal and reject a different claimed approver. The tenancy permission catalog has `om:read`, `om:write`, `om:admin`, `aba:write` and `aba:admin`; none is an explicit outcome-verification permission. ABA assignment status and scope do not silently extend to an OM verdict. `bo:admin`, ownership of the business, or a generic OM role is not sufficient proof.

The OM-MEASURE-7 preflight accepts advisory `approval.authorityConfirmed` and compares approver to the definition's approver, executor, definition author and attribution assessor. It always returns `verdictAllowed: false`. It does not itself recheck live ABA assignment, membership, permission, delegation, service identity or decision audit. Migration 0215 permits only PENDING/INCONCLUSIVE stored assessments. No positive verdict path exists to attach an authoritative approval proof.

## Exact owner decision requested

1. **Permission.** Approve a dedicated outcome-verification permission code or explicitly identify an existing code and its exact meaning. Recommended: dedicated permission, issued through canonical tenancy/ABA policy. Define which roles may receive it, who grants/revokes it, and whether the grant is tenant-, workspace- or business-scoped. A catalog entry or broad system role alone is not a grant to an individual business.
2. **ABA binding.** Specify the assignment code, version and `approval_authority_scopes` mapping that authorizes an OM verdict for one business and action/metric or criterion version. Define whether both active tenancy membership/permission and active ABA assignment are required at decision time (recommended: both). Require composite tenant/workspace/business checks and deny ambiguous or stale versions.
3. **Principal and delegation.** Require the authenticated human principal, active user and live authorization at decision time; never accept a caller-supplied approver ID as proof. Decide whether delegation is prohibited for the first rollout (recommended) or define the exact ABA delegation proof, validity interval, revocation and scope rules. No automated approver.
4. **Separation of duties.** The approver must differ from the action executor, measurement definition author, attribution assessor and any human who authored or corrected the observation. Specify how an OM service runner is represented and why a service identity cannot act as the human approver. Missing actor IDs refuse.
5. **Decision proof.** Specify a database-issued decision timestamp, assignment/version and permission provenance, membership snapshot or reference, criterion/observation/attribution version IDs and digests, reason and append-only audit event. Define how a later revocation affects an already issued verdict versus a new decision. Recheck source evidence immediately before committing the decision.
6. **Verdict shape.** Approve the separate schema/runtime change needed for VERIFIED and FAILED, including explicit treatment of inconclusive evidence. A failed business outcome must be based on a complete governed observation and approved criterion; missing evidence remains INCONCLUSIVE, not FAILED. Preserve the OM → CL release gate for a later owner decision.

## Implementation gate after approval

Implement a scoped authority resolver against canonical identity, tenancy and ABA records, with the verdict decision and audit written atomically under a least-privilege role. Test on disposable PostgreSQL: wrong tenant/workspace/business, missing/revoked/expired permission or assignment, stale version, delegation, forged principal, service account as approver, all self-approval combinations, concurrent revocation/decision, changed observation/attribution digests, and audit rollback. Independently review any frozen-contract or schema change. P1 approval alone does not activate verdicts or CL learning; M1/M2/M3/O1/A1 and the positive-verdict implementation still require approval and proof.

## Completion-matrix evidence delta

| Capability | Evidence | Authority |
| --- | --- | --- |
| ABA assignments and tenancy permissions | Existing scoped records and generic OM permissions | No outcome-verification mapping |
| OM-MEASURE-7 approver refusal | Advisory, always closed | No live permission proof |
| Human positive-verdict decision | Permission, binding, SoD and audit decisions unresolved | **Closed** |
| OM → CL learning | No authorized positive verdict | **Closed** |
