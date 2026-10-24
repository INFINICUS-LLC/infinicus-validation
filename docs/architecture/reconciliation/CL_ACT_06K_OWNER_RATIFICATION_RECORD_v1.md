# CL-ACT-06K — Final Owner Decision Ratification Record v1

**Status: OWNER RATIFICATION REQUESTED — NOT YET GIVEN.**

Date: 2026-10-24. Base: main `2c48d9d2d1b49464b8856b01dfa3f337945864e1` (PR #301 merged). This is a decision package, not evidence of approval. The user's request to begin CL-ACT-06K authorizes preparation of this record, **not** approval of the implementation-specific values.

## Existing approved principles (unchanged)
Canonical identity/ABA issues explicit `cl:shadow:evaluate` rights (never implicit `bo:admin`); independent human approver and no delegation; default OFF with kill switch overriding approval; CL owns audit evidence and ABA owns assignment authority; no automatic deletion until a retention policy is authorized; immediately deny stale/revoked authority; advisory-only evaluation without CL publication, model, policy or BO mutations.

## Final ratification matrix

| ID | Recommended baseline for review | Still requires explicit owner choices |
| --- | --- | --- |
| H-RET | Store audit metadata, scoped IDs, digests and bounded reason codes only. No automatic purge before legal/privacy approval. | Governing jurisdiction(s), lawful basis, retention term(s), hold/erasure process, data controller |
| H-HASH | Server-side versioned canonical serialization, domain-separated SHA-256 chain with independent off-DB signed head anchors. | Canonical byte format, external key custody, signing cadence, anchor storage, rotation and recovery |
| H-AUTH | Canonical session identity, ABA-issued explicit scoped permission, distinct human approver, no delegation, guarded insert with FORCE RLS and composite-scope validation. | Exact issuer API, permission and revocation representation, DB role/GRANT matrix, security-definer design |
| H-TXN | CL-owned control state and audit transition in one transaction; scoped idempotent replay, reject payload collisions, lock/version-check, audit failure rolls back. | Control schema, idempotency domain, lock order, serialization/retry and revocation race policy |
| H-KILL | Default-deny switch checked first and inside transition; separate emergency recovery with two-person approval, auditable actions. | Named custodian role/person, backing store, quorum, escalation, out-of-band shutdown and incident SLA |

## Ratification entry requirements

A ratification needs, for **each** ID, (a) the exact approved parameter values and specification version, (b) a traceable owner approval reference, (c) security/DB review, and (d) explicit scope limited to disposable development/acceptance. A generic acknowledgement, merged PR, or self-supplied record is not permission to deploy or migrate.

**Owner actions requested:** approve or amend each H-RET through H-KILL with the missing operational values in the table. No values are assumed or silently set by developer defaults.

## Pre-migration STOP conditions

- Until ratification: no numbered schema migration, database role grant, credential issuance, SQL execution in production, runtime enablement or CL learning.
- Even after policy ratification: run architecture/security review on the numbered migration candidate and canonical authority read/write port; verify in disposable migrated PostgreSQL with owner, app and fixture roles, FORCE RLS/tenant isolation, update/delete/truncate denial, revocation and independent approver, concurrency and rollback, protected cryptographic anchor, kill-switch precedence, and no model/policy/BO mutation. Only a separate explicit migration authorization can move past the gate.
- This document does **not** supersede CL-ACT-06I or CL-ACT-06J, and it is not an approval token.

## Block verification

Document-only. No PostgreSQL test run, no migration, no production activation, no new permission.
