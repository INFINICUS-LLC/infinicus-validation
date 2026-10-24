# CL-ACT-07C — Security Parameter Authority Assignment & Resolution Register

**Date:** 2026-10-24. **Status:** DRAFT RESPONSIBILITY REGISTER; **NO NAMED AUTHORITY APPOINTED**, **NO OPERATIONAL PARAMETERS RATIFIED**.  
**Base main:** `9a4ef79af02ee9cdd982b39ad351881c22daf3af` (#322 merged). Predecessor #323 (07B) remains OPEN. Reconcile before treating this register as an accepted readiness record.

## Scope and constraints

The owner's eight CL-ACT-07A development decisions and five protective amendments are binding. Preserve the existing nine-layer architecture, existing operational behavior and backward compatibility; include eligible business-scoped nonowner operators; mandate independent nondelegated human ABA approval, fresh revocation-safe authorization and default denial. Shadow Mode remains OFF and Continuous Learning inactive. This is a **role proposal**, not assignment of any real person, company, database principal or legal duty.

## Resolution register — all seven remain UNRESOLVED

| ID | Security parameter | Proposed accountable decision authority (not yet appointed) | Proposed technical steward / independent reviewer | Decision evidence required | Acceptance criterion / current disposition |
| --- | --- | --- | --- | --- | --- |
| C1 | Legal retention jurisdiction/controller | Owner-nominated legal/privacy controller | Privacy/security counsel; independent compliance reviewer | Actual applicable jurisdiction(s), named controller, records classes, legal basis, hold/deletion/DSAR policy, signed retention schedule | Legal determination and explicit owner ratification; **UNRESOLVED** |
| C2 | KMS/key custody and external audit anchors | Owner-nominated security/key custodian | Infrastructure cryptography steward; independent key-custody reviewer | KMS/provider and location, signer/key IAM, rotation and break-glass, protected external anchor sink, verifier and threat model; no keys in repo | Two-person/segregated controls and verified signatures/recovery on isolated assets; **UNRESOLVED** |
| C3 | Emergency CL kill-switch custodians | Owner appoints two independent human recovery custodians and alternates | Incident commander/security operations; independent audit reviewer | Named roles and authenticated identities (stored in restricted governance record), quorum, authoritative switch store, default-ON failure mode, tabletop/recovery proof | Independent custodians and no unilateral reopening, fail-closed outage evidence; **UNRESOLVED** |
| C4 | Database role and privilege matrix | Owner-appointed database security authority | Postgres DBA and ABA/Identity maintainers; independent RLS reviewer | Actual app/service roles, exact GRANT/REVOKE matrix, schema ownership, composite FKs, FORCE RLS, trusted DB context, SECURITY DEFINER/bypass analysis and rollback | Disposable PostgreSQL cross-tenant/business denial evidence with production parity; **UNRESOLVED** |
| C5 | Idempotency/replay policy | ABA domain authority formally designated by owner | API and security reviewer | Key format and cryptographic uniqueness, tenant/workspace/business/grantee/permission scope, TTL, payload equivalence, conflict and regrant/version rules | Concurrent duplicate/replay/expired-key outcomes defined, versioned and tested; **UNRESOLVED** |
| C6 | Transaction isolation and lock order | DB concurrency/security authority appointed by owner jointly with ABA owner | PostgreSQL concurrency reviewer and CL audit writer steward | SQL isolation level, canonical lock order for ABA grant/CL audit/kill state, retryable SQLSTATEs, max retry, revocation linearization, rollback and outage handling | Deterministic concurrent revoke/read/write proof in disposable DB, current checks after retry; **UNRESOLVED** |
| C7 | Canonical business-relationship verification interface | Owner-designated business membership/domain authority with Identity and ABA concurrence | Business/Identity API maintainer and independent tenancy reviewer | Canonical source record and trusted API, active tenant/workspace/business membership, nonowner support, lifecycle/revocation semantics, evidence provenance and RLS scope | Reject caller-asserted scope, inactive/nonmembers and cross-business claims; preserve business-specific nonowner access; **UNRESOLVED** |

## Proposed workflow for every register entry

1. **Nominate:** Owner expressly names an accountable decision authority and independent reviewer (use a restricted source for confidential identities); nomination is not an approval of the proposed configuration.
2. **Specify:** Authority submits an exact, versioned decision and concrete parameters. Never infer values from generic policy, role titles, comments or merge status.
3. **Independently review:** Record source evidence and security/architecture effects, negative tests required, operational runbook/rollback and the independent reviewer's signed disposition.
4. **Approve:** Owner explicitly accepts or amends that version and separately determines whether it is only design-valid or authorized for *disposable testing*.
5. **Lock and trace:** Store nonsecret approved configuration/specification reference and immutable approval/decision timestamp in the repository; hold secrets, custody identities and access credentials in approved restricted stores.
6. **Verify:** Execute disposable PostgreSQL/permissions tests only after separate authorization, capturing test command, environment, effective DB roles, schema fingerprint, CI results, negative outcomes and rollback evidence.
7. **Promote:** Any production migration, real ABA permission grant, live Shadow Mode or CL activation always requires a **new, independent, explicit production decision**. No automatic step progression.

## Dependency and risk register

- #323 (CL-ACT-07B) remains open at initial inspection; reconcile its content and CI status before accepting this successor.
- The recommended role labels are functional responsibilities, **not named custodians, authorized identity groups or approved grant recipients**.
- Existing ABA approver assignment/grant/revoke provenance is not a CL `cl:shadow:evaluate` source; CL must never inherit `bo:admin` or owner status.
- No legal jurisdiction, KMS provider, role grant, TTL, SQL isolation/lock order, exact business relationship source or kill-custodian identity is chosen here.
- Default OFF means Shadow Mode disabled; kill-switch policy remains default blocking. The design must distinguish the two switches in implementation and tests.
- Preserve backward compatibility and zero BO/model/policy/learning mutation.

## Gate result

**Register structure: PREPARED. Authority appointments: 0/7 confirmed. Executable parameter locks: 0/7. Implementation readiness: BLOCKED.**

This document does not change database schemas, roles, permissions, endpoints, or runtime state. No CI, disposable PostgreSQL or production check was executed. No actual grant/revocation or migration is authorized.
