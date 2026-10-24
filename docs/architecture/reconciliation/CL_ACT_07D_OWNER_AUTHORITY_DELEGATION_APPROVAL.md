# CL-ACT-07D — Owner Authority Delegation & Security Responsibility Approval

**Date:** 2026-10-24. **Status: RESPONSIBILITY APPROVAL PROTOCOL PROPOSED — NO ACTUAL DELEGATIONS APPROVED OR EXECUTED.**
**Baseline:** `main` at `58b76600261dd7773d51fbfc0398442a8e0dd207`. CL-ACT-07B/#323 and 07C/#324 documents are present on main. Existing document headers that say their predecessors were open are historical snapshots, not current PR status.

## Owner authority reserved

The INFINICUS owner retains ultimate approval of security-policy changes, production access and release, grants and database migrations. **No named individual, role membership, legal controller, KMS principal, service account or emergency custodian is appointed by this document.** A role label is not a delegation or technical access grant. The owner's ratified CL-ACT-07A development decisions and five protective amendments remain in effect.

## Proposed delegation and approval matrix (no appointments)

| Register item | Proposed responsible decision domain | Required independent review | Owner sign-off before binding | Delegation status |
| --- | --- | --- | --- | --- |
| C1 legal retention | Designated privacy/legal decision authority | Independent privacy/compliance counsel | Named controller, jurisdiction and actual retention policy | UNASSIGNED |
| C2 KMS and signed anchors | Designated security/key custody authority | Independent cryptography/key-custody reviewer | Provider, ownership, storage, signing, key rotation and break-glass | UNASSIGNED |
| C3 emergency kill-switch | Two distinct human recovery custodians appointed by owner | Separate security/incident reviewer | Quorum, custody, alternates, availability and emergency test | UNASSIGNED |
| C4 DB privilege/RLS | Designated PostgreSQL security authority | Independent RLS/tenant isolation reviewer | Schema owner, effective DB roles, exact GRANT matrix and rollback | UNASSIGNED |
| C5 grant idempotency | Designated ABA domain authority | Independent API/security reviewer | Key TTL, payload-equivalence, replay and versioning rules | UNASSIGNED |
| C6 transaction locks/revocation | Designated DB concurrency authority jointly with ABA | Independent concurrency/security reviewer | Transaction isolation, lock hierarchy, retry policy and kill-state precedence | UNASSIGNED |
| C7 business relationship | Designated business-domain/membership authority with Identity/ABA concurrence | Independent tenancy/identity reviewer | Business membership proof incl. authorized nonowners, revocation and exact API | UNASSIGNED |

## Separation-of-duty approval requirements

1. Owner nominates each responsible human or committee explicitly, specifying bounded remit, effective date, authority source, reviewer, expiration/replacement rule and revocation path in a protected governance record. Nomination by itself confers **no runtime permissions**.
2. Proposed decision authority may draft options/evidence but cannot self-certify independent review or owner ratification. The human approver for an ABA CL grant must be **independent of its operator**; no delegation of the human approval. Operator, issuer, reviewer and custodians' overlapping roles require conflict checks.
3. An appointed reviewer must approve the specific version of the evidence and negative security tests. The owner explicitly accepts each of C1–C7 with any amendments. An unfilled seat is an unresolved gate.
4. Emergency kill-switch restoration requires two separately verified independent custodians under owner-approved recovery procedure; switch failure is fail-closed. Neither custodian alone enables Shadow Mode.
5. Use least privilege; all technical role grants, key access, migration credentials and emergency access are **separate privileged operations** requiring their own authorization and audit; never store passwords, key material or confidential identities in repository docs.
6. Owner may withdraw or replace a responsibility assignment; record effective revocation and prevent previous appointees from relying on historical approvals or credentials.
7. Preserve existing BO, ABA, authentication, OM and CL architecture; permit verified business-scoped nonowner operators without inherited owner/admin roles. Keep Shadow Mode default OFF and Continuous Learning inactive.

## Required approval packet per responsibility

- C-ID and exact decision version, scope, accountable human/committee reference in a restricted system, reviewer identity, conflict declaration, start/expiry, grant/delegation limits and revocation contact.
- Supporting independent evidence and architectural/security impact with signed disposition, negative tests and rollback/recovery requirements.
- Owner's exact disposition: **APPROVE / AMEND / DEFER / REJECT**, dated and referenced; no approvals inferred from a PR merge.
- For a disposable security test, a separate owner authorization defining environment, SQL/role boundary and data destruction. For production, yet another explicit authorization.

## Current ratification and readiness

| Gate | Outcome |
| --- | --- |
| Owner's seven/eight prior architecture and policy decisions | Preserved, development-only |
| Seven named decision authorities | **0/7 appointed by this record** |
| Seven exact security parameter locks | **0/7 verified ready** |
| Technical principal/access assignments | **None** |
| CI/disposable PostgreSQL and rollback proof | **Not executed** |
| Implementation, migration, or live CL authorization | **DENIED / NOT REQUESTED** |

**Conclusion:** Approval *process* defined for owner review; actual delegations remain pending. This draft does not appoint users or confer authority, issue ABA `cl:shadow:evaluate`, modify DB roles/GRANTs, execute migrations, deploy routes or enable Shadow Mode or Continuous Learning.
