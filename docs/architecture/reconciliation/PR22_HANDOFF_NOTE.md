# HAND-OFF NOTE FOR THE PR #22 OWNER — BUILD-33 (Cross-Domain Business Event Architecture)

**From:** BUILD-ARCH-RECON-01 (architecture reconciliation)   **Date:** 2026-10-07
**Subject:** `build-33-cross-domain-business-event-architecture` (PR #22, draft, head `301fea4`)
**Status of this note:** written under authorisation E6. **PR #22 was not modified, approved, merged or normalised by the reconciliation.** Everything below is a request to its owner, based on a read-only review (`EVENT_AUDIT.md`).

## Summary

The BUILD-33 design is consistent with the Master Architecture Manifest: the ledger is non-authoritative, append-only, tenant/workspace isolated with `FORCE ROW LEVEL SECURITY`, carries the six provenance classes, requires an ABA reference to replay action-type events, and does not default evidence to ACTUAL. No specification conflict and no direct cross-layer mutation was found. Four things must happen **before it can merge**.

## What PR #22 must do

### 1. Renumber its migrations after PR #14's `0171`

PR #14 (webhook intake) keeps migration **`0171_create_da_webhook_token_lookup.sql`** (decision D1 = a: it is nearer to merge). PR #22 currently adds:

| Today | Required |
|---|---|
| `0171_create_business_event_ledger.sql` | the next free number **after** PR #14's `0171`, expected `0172` |
| `0172_harden_eventing_scope.sql` | the following number, expected `0173` |

- The numbers above assume PR #14 merges first. **Take the actual next free numbers at the time you merge**; do not reserve numbers in advance. Rule: keep the numbers of the branch merged first, renumber only the unmerged branch (`docs/architecture/MIGRATION-ALLOCATION-POLICY.md`).
- Update, in the same change: the filename, the `-- Migration:` header comment, the `INSERT INTO _migrations (filename)` line, and **every test or document that names the old filename** (for example `packages/database/tests/migration-build33-event-architecture.test.ts` and the BUILD-33 documents).
- **Do not touch** migrations `0001`–`0170` (merged) or PR #14's `0171`.
- Numbers must stay **unique and contiguous** from `0001`. The repository guard `platform/tests/01-file-existence.test.mjs` (introduced by PR #23) enforces this and also verifies that `0001`–`0049` are unchanged.

### 2. Update the BUILD-33 specification, §18 and its version notes

`docs/implementation-queue/BUILD-33-CROSS-DOMAIN-BUSINESS-EVENT-ARCHITECTURE-SPECIFICATION.md` §18 names `0171` and `0172` explicitly, and states that migrations `0001–0170` are immutable. After renumbering:

- issue a **new version note** (for example v1.2) recording the renumbering reason, the affected filenames, and that behaviour is unchanged;
- keep the **ARCHITECTURE COMPATIBILITY HOLD on the hardening migration** (currently `0172_harden_eventing_scope.sql`) exactly as written in §18 unless the owner formally lifts it. It is not merge-ready as drafted, regardless of numbering;
- this is a build specification (level 5 in the authority hierarchy), not a locked layer specification. It is the owner's document; the reconciliation did not edit it.

### 3. Merge current `main` before final validation

PR #22's base is `0f3efef` (the BUILD-32 merge). Since then `main` gained migration `0170_add_approved_action_source_recommendation.sql`, the reconciliation documents, the platform bundle guard, and (once merged) PR #25's dependency fixes and PR #14's webhook work.

- Merge `main` into the branch (no rebase or force-push on a shared branch).
- Regenerate `infinicus-platform/pnpm-lock.yaml` **with pnpm 10.33.0**, never by hand.
- Earlier green CI does **not** count after the base changes: re-validate from the refreshed head.

### 4. Re-run migration guards and the relevant event tests

From the refreshed head, on real PostgreSQL (not mocks), run at least:

- the migration gate (`infrastructure/deployment/scripts/migration-gate.sh`) on an empty database, then `grant-app-role.sh`;
- the migration-number guard (unique, contiguous, `0001`–`0049` frozen);
- the BUILD-33 tests (`migration-build33-event-architecture`, `build33-eventing-rls`, `build33-delivery-attempt`, `build33-publication-replay`) and the `event-contracts` tests;
- RLS tests proving tenant/workspace isolation and fail-closed behaviour when the tenant/workspace settings are unset;
- full lint, typecheck, production build, dependency scan, and the image build/smoke jobs.

## Advisory observations (non-blocking, for the owner's judgement)

| ID | Observation |
|---|---|
| A-1 | The append-only trigger is row-level for `UPDATE`/`DELETE`. `TRUNCATE` is not intercepted. The application role has no `TRUNCATE` grant, so exposure is limited to privileged roles; a statement-level `TRUNCATE` trigger would close it. |
| A-2 | `grant-app-role.sh` grants `UPDATE`/`DELETE` on all tables, including the ledger, so protection rests only on the trigger. A `REVOKE UPDATE, DELETE` on the ledger (in the grant script, not in a migration, per repository convention) adds defence in depth. |
| A-3 | The replay rule that requires an ABA reference matches event types by name pattern (`action|approval|execution|…`). An event type outside that vocabulary that still causes an operational effect would not be caught; a registry flag would be more robust. |
| A-4 | Raw events cross the ledger as `payload`/`metadata` JSON. Sensitive-data handling (`sensitivity` column) should be checked against the DAL sensitive-data engine before any real tenant data is written. |

## Constraints that still apply to PR #22

- It must not become a source of business truth, and event replay must never bypass ABA (Manifest §10–11; BUILD-33 §16).
- It must not rely on the approval behaviour that the reconciliation found defective (`ARCHITECTURE_VIOLATIONS.md`, V-01): do not build action-event consumers that treat today's `ApprovedAction` as authorisation to execute.
- Any change to a locked specification requires a new version with explicit migration notes; none is requested here.

## What the reconciliation will and will not do

It **will** re-check the migration numbering and the event findings after PR #22 is refreshed, if asked. It **will not** edit, approve, merge or renumber PR #22 on the owner's behalf unless separately authorised.
