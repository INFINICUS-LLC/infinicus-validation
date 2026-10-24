# CL-ACT-06H — Audit schema & authorization specification reconciliation

Status: **FINALIZED FOR REVIEW, NOT APPROVED FOR MIGRATION.** Base main `71bbcb3652947884c75e5432050dc1aadab82aca`. Reviewed against CL-ACT-06F owner-approved seven principles and open PRs #296 (DDL candidate) / #298 (security acceptance contract). Those PRs are independent and must be reconciled before promotion.

## 1. Frozen owner-approved behavior

Only the canonical identity/ABA owner can issue an explicit `cl:shadow:evaluate` permission. No `bo:admin` inheritance. Independent human approval; no delegation. Default disabled and kill switch wins. CL owns audit history; ABA owns authorization assignments. No automatic audit purge before retention approval. Revoked/stale permissions refuse on a current canonical check. Shadow may assess but cannot publish CL release or mutate models, policies, or BO state.

## 2. Source-of-truth boundaries and trust model

- Identity authenticates the request principal and does not accept caller-provided operator ID as proof.
- ABA verifies an explicit, current business-scoped permission assignment/version/provenance and independent approver. The CL service can consume only a verified read-port result; it may not write ABA-owned tables.
- CL exclusively owns the shadow-control event audit; it must never become an alternate authority ledger. A CL audit receipt cannot grant IAM privileges.
- Database timestamp is authoritative for expiry. Controls and auditable transitions must be checked and appended in one transaction to prevent time-of-check/time-of-use gaps. No user-supplied flags or self-certified checklist authorize the write.
- Kill switch is checked before authorization and again within the atomic transition. If an audit append fails, the transition fails with it. Production publication and model/BO writes have no permitted composition.

## 3. Schema design (review specification; no migration issued)

Proposed CL-owned `continuous_learning.shadow_control_audit_events` (separate from CL intake) must have: event UUID; tenant/workspace/business UUID; authenticated operator UUID; independent approver UUID when required; ABA assignment ID and **version ID**; control UUID/version; explicit event type; scoped idempotency key; refusal code array with bounded values; canonical payload/version and source hash; predecessor hash; database-issued timestamp; permanently FALSE release/learning/mutation flags. No raw PII or customer payload in audit body.

Hard database invariants:
1. Composite-scope FKs/constraints must prevent mixing authority assignment, assignment version and business/tenant/workspace across entities. Simple separate FKs are insufficient.
2. Each idempotency key is unique for the correct tenant/workspace/business/control + operation. Same key/same canonical input returns the original result; same key/different input fails closed. Concurrent retries must serialize without duplicate events.
3. Audit rows are insert-only. Enforce denial of UPDATE/DELETE/TRUNCATE by privilege design, triggers for permitted non-owner paths and explicit tests. Document that table owners/superusers can bypass controls; require independent protected anchors.
4. FORCE RLS plus least-privileged role policies with explicit per-scope predicates, proper authenticated context, and no unguarded INSERT privileges. A trusted writer verifies authorization in the same transaction and inserts via a narrow reviewed port.
5. Audit digests are generated server-side from approved canonical serialization, with version/domain separation and protected external anchors. A caller digest cannot be trusted. Chain ordering and multi-business concurrency must be deterministic.
6. An audit event alone cannot activate a control: the atomic authoritative control state/transition store and version-lock owner must be selected in the same approved schema review.
7. Retention, redaction, DSAR and lawful deletion must be specified without compromising forensic proof; absence of an approved schedule means **no automatic purge**, not indefinite-retention approval.

## 4. PR #296 reconciliation — changes mandatory before any numbered migration

The draft SQL in PR #296 has standalone ABA foreign keys instead of composite scope verification; a caller-supplied record digest; no authenticated writer; no narrow RLS allow policies or grants; no protected external anchor; and no authoritative atomic control-state relation. It therefore remains non-executable design material. **Do not merge the proposal as a migration.** PR #298's 15-point contract is likewise a checklist, not trusted acceptance evidence.

## 5. Explicit unresolved implementation decisions

| Decision ID | Must be approved before migration |
| --- | --- |
| H-RET | Exact retention duration/jurisdiction, legal deletion/redaction and privacy review |
| H-HASH | Canonical encoding bytes, domain separation/version, signing/anchor custodian and rotation |
| H-AUTH | Exact canonical identity/ABA authorization read-port, assignment-scope constraints, role names and grants |
| H-TXN | Control-state source, transaction lock ordering, idempotency domain and supersession/revocation behavior |
| H-KILL | Named emergency custodian(s), kill-switch storage, quorum/recovery and incident audit procedure |

None of these is implied by approval of the seven principles.

## 6. Disposable PostgreSQL acceptance package — required, not yet executed

Provision isolated, migrated PostgreSQL with separate owner, fixture-admin and restricted app roles, **never production**. Capture run identifiers, PostgreSQL version, applied schema hash, role/privilege matrix and tests:

1. Positive scoped read by genuinely authenticated app principal against approved explicit ABA assignment/version, and negative missing/revoked/expired/stale/cross-tenant grants. Self-approval and delegation denied.
2. Deny cross-tenant/workspace/business SELECT/INSERT, unauthorized direct writes and spoofed session claims. Validate composite FKs and FORCE RLS as restricted app role.
3. Verify direct UPDATE/DELETE/TRUNCATE fail; inserts require a reviewed guarded writer. Validate monotonic event sequence, server-created timestamp/digest and independent protected anchor.
4. Race two identical requests and two conflicting requests; prove one atomic audit/control transition, deterministic replay, rejection of changed payload and rollback on write failure.
5. Kill switch overrides otherwise valid operator authorization. Ensure no CL publication/intake release, model/policy update or Business Operations mutation through the tested path.
6. Record CI result, exact commands, complete failure traces, row-difference proofs and privilege inspection. Skipped tests do not count.

**Release gate:** no numbered migration or grant, no production shadow activation, no learning, until decisions H-RET/H-HASH/H-AUTH/H-TXN/H-KILL and these database proofs are explicitly reviewed. This block does not claim DB acceptance.
