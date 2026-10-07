# Owner approval-authority bootstrap, revocation and backfill dry-run (V-01) — implementation note

**Status:** implemented and validated locally on live PostgreSQL. **No migration. No locked specification changed. No ABA→BO wiring.**
**Authority applied:** owner authorisation of D1 (strict ownership proof), D2 (multiple owners = ambiguous), D3 (provenance now, canonical audit in P0-4); the V-01 ruling (authority must be externally established, never self-issued).

## What exists now
| Piece | Where |
|---|---|
| Strict ownership proof (pure classifier) | `packages/database/src/repositories/ownership/classifyOwnership.ts` |
| Evidence loader (read-only; tenant context set, RLS applies) | `…/ownership/OwnershipEvidenceRepository.ts` |
| Atomic, idempotent grant; revoke; provenance history | `ApproverAuthorityRepository` (`grantActiveAssignment`, `revokeAssignment`, `listProvenance`, `findByCode`) and `…/approved_action/authorityProvenance.ts` |
| Bootstrap at onboarding | `packages/onboarding/src/OwnerApproverAuthorityService.ts`, called from `OnboardingService.assignOwner` |
| Manual grant / revoke / history | `DecisionWorkflowService.grantApproverAuthority`, `revokeApproverAuthority`, `getApproverAuthority`; routes below |
| Decision-time re-check | `DecisionWorkflowService.submitApprovalDecision` |
| Backfill dry-run (read-only) | `runOwnerAuthorityDryRun` and `infrastructure/database/scripts/owner-authority-backfill-dry-run.sh` |

## The ownership proof (D1, strict)
A user is a **proven owner of a specific business** only when server-side records prove the business, the user, an **active** owner membership, and that the relationship belongs to **that business**:
1. the onboarding record that created the business names the owner's membership; the membership is `active`, holds the `owner` role, and belongs to the user who initiated onboarding; **or**
2. an `active` membership holds the `owner` role **explicitly scoped to that business** (`membership_roles.business_id`).

**Never proof:** `created_by` alone, tenant-wide owner status alone, browser-supplied ids, inferred ownership, name or email matching. Tenant-wide owners with no business-specific link are reported as **CANDIDATE — NOT AUTO-GRANTED**.

## Classes (used by the bootstrap and the dry-run)
`PROVEN` (exactly one proven owner, no existing assignment; eligible) · `ALREADY_ASSIGNED` (an assignment holds the code in any status; never re-granted automatically) · `AMBIGUOUS` (several valid owners; nobody is granted) · `UNPROVEN` (insufficient evidence; candidates listed) · `INVALID_INACTIVE` (business closed/archived/suspended/deleted, or an ownership link whose membership is not active/consistent).

## Bootstrap behaviour
- Runs when the owner is assigned (and again on retry, so an interrupted first attempt completes). Idempotent; one transaction creates the assignment, its first version and its provenance entry.
- Grantee = the proven owner found in the database; it must equal the authenticated principal (`ctx.userId`), otherwise nothing is issued.
- Never re-grants after a revocation, never overwrites another holder, never picks among several owners.
- The assignment code `business-owner-approver` is unique per business, so it has exactly one holder.

## Provenance (D3) — append-only, no migration
Each grant and each revocation appends one entry (`scope_type = 'provenance'`) to the existing append-only `approval_authority_scopes`: business id, grantee, assignment code and id, **source** (`onboarding` / `manual-admin` / `backfill`), **actor** (system with its authority, or user with `aba:admin`), timestamp, state after the action, correlation id, the **ownership proof reference** (kind, membership id, onboarding id), and for revocations the **reason**. No secrets and no browser-supplied identity claims are stored. P0-4 introduces the canonical authorization/audit event contract.

## Revocation (not permanent)
- `POST /v1/businesses/:businessId/approver-assignments/:assignmentCode/revoke` (`aba:admin`, idempotency key, non-empty reason). Takes effect immediately: only `active` assignments are honoured.
- `GET /v1/businesses/:businessId/approver-assignments/:assignmentCode` (`aba:admin`) returns the assignment and its provenance history.
- **If the ownership relationship lapses** (owner membership suspended or removed, owner role removed), an authority that was issued automatically (`onboarding`/`backfill`) is **refused at decision time** with `ApproverAuthorityNotEstablishedError` and is **not revoked automatically**: an administrator reviews it. Manual administrator grants are explicit decisions and are not re-derived from ownership. The dry-run flags such holders for review.

## Backfill — dry run only
```
ADMIN_DATABASE_URL=postgresql://… infrastructure/database/scripts/owner-authority-backfill-dry-run.sh [report.json]
```
Single `READ ONLY` transaction (the database rejects any write); enumerates tenants/workspaces with the operator connection and sets each tenant's context so row-level security applies. Output: counts per class, and per business the class, reason, proposed grantee (PROVEN only), valid owners (AMBIGUOUS), candidates, existing assignment, and notes. **No grant is ever executed by this module; executing a backfill needs a separate, explicitly authorised step.** Reports contain user ids but no emails or secrets.

## Known limitations (recorded; locked architecture unchanged)
1. **Single holder per code.** `UNIQUE (business_id, assignment_code)` means `business-owner-approver` can belong to one user; several valid owners are reported AMBIGUOUS and need an explicit `aba:admin` decision. This is a model limitation for later review, not a statement that several owners are invalid.
2. **No reinstatement.** A revoked assignment cannot be re-granted under the same code (a manual grant returns a conflict). A new code or a reinstatement operation is a later decision.
3. **Provenance, not canonical audit.** P0-4 adds the canonical audit events; `audit.access_events` has a closed event-type list, so that needs a migration.
4. **Businesses created outside onboarding** with no business-scoped owner role are UNPROVEN until an administrator grants authority.
5. The web workflow form still takes `tenantId`/`workspaceId`/`userId` from form fields; nothing here uses them. Tracked for the V-05/V-04 identity block.

## Migration-number rule (for P0-3/P0-4)
Do not pre-claim `0172` because it looks free on `main`. Before any migration: inspect current `main`, inspect open migration-bearing PRs (especially PR #22), apply `docs/architecture/MIGRATION-ALLOCATION-POLICY.md`, record which branch owns the next number, then create the migration.

## Validation
Database: 14 integration tests (one scenario per class, creator-is-not-proof, tenant-wide-is-candidate-only, atomic and concurrent grant, revoke, provenance history, read-only dry-run, read-only connection rejects writes) and 2 CLI tests. Onboarding: 7. Workflow: 5 (revocation, history, conflict, proof-lapse re-check, manual grant unaffected). API: 4 (revoke then 403, history, validation and 404, member forbidden). Regression proof by planting four weaknesses (tenant-wide treated as proof; principal binding removed; revoke not applied; decision-time re-check removed): each is caught by the intended test.
