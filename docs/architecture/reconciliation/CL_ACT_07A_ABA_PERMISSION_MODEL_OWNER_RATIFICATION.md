# CL-ACT-07A — ABA Permission Model Owner Ratification & Security Parameter Lock

**Status: OWNER-RATIFIED DEVELOPMENT DESIGN DECISIONS — IMPLEMENTATION PARAMETERS UNRESOLVED; MIGRATION GATE CLOSED.**  
**Date:** 2026-10-24. **Baseline main:** `bfff74aa425456746cc502cfb0c27940e3b5040e`.  
PRs #319, #320 and #321 are now merged into main. The owner explicitly approved the dispositions and protective amendments below on 2026-10-24. This approval does not imply approval of unspecified operational parameters.

## Prior decisions preserved

The owner approved seven core Shadow Mode governance principles and the H-RET/H-HASH/H-AUTH/H-TXN/H-KILL technical policy directions **for development specification only**. Neither approval authorizes ABA grant issuance, database roles/permissions, migrations, production shadow execution or Continuous Learning activation. ABA owns the grant lifecycle; identity owns sessions; canonical membership authority owns membership; CL only consumes read-only evidence and owns advisory audit/control.

## Eight owner-ratified development decisions and outstanding parameter locks

| ID | Recommended development lock | Specific owner/security values still needed | Status |
| --- | --- | --- | --- |
| Z-MODEL | Dedicated ABA-owned typed `cl:shadow:evaluate` grant model, independent of general approver assignment/owner bootstrap, with immutable grant/version IDs; states `pending,active,revoked,expired` | ABA owning team/custodian, authoritative grant relation and exact transition matrix, compatibility and migration strategy | APPROVED — design direction |
| Z-SCOPE | Require canonical active workspace membership **and** separately verified active business relationship; scope all grants by tenant/workspace/business/grantee/permission; no tenant-wide owner inference | Definitive source of business membership for nonowners; composite PK/FK topology and business-state policy | APPROVED WITH AMENDMENT — nonowner operators |
| Z-APPROVE | Distinct authenticated human approver, direct nondelegated approval, no issuer/operator self-approval; explicit ABA-owned issuer/revoker permissions | Role authorities and human approver registry, provenance format, source and approval reference, permission registry | APPROVED — independent direct human |
| Z-IDEMP | Per tenant/workspace/business/grantee/permission scoped idempotency, exact payload equality, one unambiguous active grant and no resurrection of revoked grant | Idempotency key format/TTL, uniqueness/retry indexes, expiry treatment, version algorithm | APPROVED WITH AMENDMENT — safe scoped replay |
| Z-RACE | ABA row lock and ordered current-version read with database-time validation; atomic state transition/provenance, recheck in CL control/audit transaction and every retry | Exact lock order, SQL isolation and retry SQLSTATE/backoff, cancellation/revocation ordering across port boundaries | APPROVED WITH AMENDMENT — fresh authorization |
| Z-RLS | Strict ABA-owned relations, composite scope FKs, FORCE RLS, least-privilege roles and no general app-role direct writes | Owner/writer/auditor role names, GRANT matrix, SECURITY DEFINER design, trusted session/DB context and disposable test authority | APPROVED WITH AMENDMENT — isolated security |
| Z-OPS | Owner-approved metadata-only audit, proposed 24-month legal-conditional retention, versioned SHA-256/JCS signed external anchors, default-blocking kill with two-person recovery | Applicable jurisdictions/privacy decision, KMS signer and anchor storage/key custody, named kill and recovery custodians, incident process | APPROVED WITH AMENDMENT — operational values deferred |
| Z-DEPS | Merge/reconcile #319 and #320 after CI/review; preserve the nine-layer guardrail and run security review before SQL | Actual review/CI evidence, schema security signoff and separate disposable-only implementation authorization | APPROVED — separate implementation gate |


## Owner's explicit 2026-10-24 approval — authoritative development scope

- **Z-MODEL:** APPROVE.
- **Z-SCOPE:** APPROVE WITH AMENDMENT.
- **Z-APPROVE:** APPROVE.
- **Z-IDEMP:** APPROVE WITH AMENDMENT.
- **Z-RACE:** APPROVE WITH AMENDMENT.
- **Z-RLS:** APPROVE WITH AMENDMENT.
- **Z-OPS:** APPROVE WITH AMENDMENT.
- **Z-DEPS:** APPROVE.

**Binding protective amendments (verbatim policy intent):**
1. Preserve existing INFINICUS architecture, business functionality, authority boundaries, and backward compatibility.
2. Permit verified business-specific authorization for eligible **nonowner** operators without inheriting rights from ownership or administrative roles.
3. Require fresh authorization, immediate revocation enforcement, transactional integrity, and default-deny behavior.
4. Require isolated database-security tests, verified rollback, and separately approved production authorization.
5. Shadow Mode remains default **OFF** and Continuous Learning inactive; never automatically activate or mutate BO data, models or policies.

**Still unresolved; not ratified as operational values:** Legal retention jurisdiction, KMS/key custody, named emergency custodians, exact database-role privileges, idempotency parameter values, transaction isolation/lock order, and canonical business-relationship verification interface. No missing details may be inferred from approval of the design direction.

**Hard scope prohibition:** These ratifications are development-specification approvals ONLY. They do **not** authorize issuance/revocation of real CL permissions, database roles/grants, creating/executing migrations, production deployment, Shadow Mode enablement, or Continuous Learning activation. Separate authorization and security evidence are mandatory.

## Ratification entry format

For **each** Z-ID: record (1) decision and exact parameter set/version, (2) explicit owner disposition APPROVE / AMEND / DEFER / REJECT, (3) traceable owner-approval reference and date, (4) DB/identity/ABA/security review disposition, and (5) unresolved operational assignments and constraints.

Owner approval of the recommended *design direction* does not silently approve missing named custodians, legal rules, role grants or schema details. Treat unresolved essential values as **NOT LOCKED**. Do not equate a merged PR or self-asserted status with an independently authorized runtime security decision.

## Migration and activation STOP gate

Until the eight design decisions are explicitly ratified and implementation-level controls verified: no numbered SQL migration or deployed interface, no live ABA permission grants/revocation, no new DB roles/GRANTs, no PostgreSQL execution, no production Shadow Mode, and no learning/model/policy/BO mutation. Even after design ratification, a **separate explicit disposable-only migration authorization** and negative PostgreSQL/RLS proof are required. Test denied cross-scope issuance, inactive/nonmember, delegated/self-approval, duplicate concurrent grants, stale/revoked/expired evidence, tampered provenance, role UPDATE/DELETE/TRUNCATE denial, locked revocation race, kill-switch precedence and zero operational mutation.

**Current verdict:** DEVELOPMENT DESIGN OWNER-RATIFIED WITH AMENDMENTS; UNRESOLVED OPERATIONAL PARAMETERS; MIGRATION READINESS BLOCKED; CONTINUOUS LEARNING DISABLED.
