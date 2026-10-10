# P0-5 Block 3a - AuthorizedActionPackage persistence (migration 0176)

Status: **implemented, draft for owner review.** Authorized by the owner: "P0-5 Block 3 with migration 0176".
Scope of this block: **storage only.** No issuer, no repository, no BO receipt, no event emission, no ABA->BO wiring, no backfill, no data, no live apply.

Chain preserved: `ADI -> ABA -> AuthorizedActionPackage -> BO execution -> ExecutionEvidence -> OM -> CL`. ABA remains the source of truth for what was formally authorized (ABA spec 35); this block only gives the sealed package (`aap/1`, Block 2) a place to live. `approved_actions` is not repurposed (ruling D-4).

## 1. What 0176 creates (`approved_business_action`, owner ruling R-9)

| Table | Role | Mutability |
|---|---|---|
| `authorized_action_packages` | Header: stable identity of one authorized action's package; scope; `action_id`, `decision_id`. **No status column.** | append-only |
| `authorized_action_package_versions` | The sealed package: full `aap/1` document (`package jsonb`), digest, and a queryable copy of key fields. | append-only |
| `authorized_action_package_lifecycle_events` | `ISSUED / REVOKED / SUPERSEDED / EXPIRED / CONSUMED` facts. | append-only |

All three: RLS enabled and **forced** on tenant + workspace (same fail-closed predicate as 0105), `forbid_mutation` on UPDATE/DELETE (reusing the 0106 function), composite foreign keys that keep tenant/workspace/business consistent from header to version to event.

State is **derived** from the lifecycle record and the database clock. `EXECUTED` is not a state (execution truth is BO / ExecutionEvidence); `EXECUTABLE` is a derived validation result and is never stored.

## 2. Database guards (defence in depth, ruling R-8)

The application issuer remains the only intended writer. The database makes these impossible even for a faulty writer:

1. **Issuance verifies the decision.** A `HUMAN_APPROVAL` version needs a decision whose status is `approved` / `approved_with_modifications`, and the document must state that exact status. (Handoff invariant 1.)
2. **Header lineage.** The header's decision must be the decision that authorized the action, in the same scope; the version's action version must belong to the header's action; the document's `actionId` and `decisionId` must equal the header.
3. **Document = columns.** Every copied column (ids, scope, version, level, mode, issuer, issued-at, correlation/causation, contract/canonical/algorithm, digest, supersession, expiry) must equal the sealed document. Comparisons are `IS NOT DISTINCT FROM`, so a **missing document field fails** (found and fixed during this block: a plain `=` lets `NULL` pass a CHECK).
4. **Level / mode pairing.** Level 2 <=> `HUMAN_APPROVAL`; Level 3/4 <=> `RULE_AUTHORIZED`. Levels 0/1 are not storable. Level 4 is representable; whether it is *enabled* stays a policy fact (ruling 12.1), not frozen into the schema.
5. **Expiry.** `NOT_APPLICABLE` <=> `expires_at IS NULL`; `VALUE` <=> the same instant; `UNAVAILABLE` is never storable (R-4). Expiry is after issuance and never later than the decision validity (R-6). Timestamps are millisecond precision.
6. **Supersession is a linear chain** inside one header: version 1 supersedes nothing, version N+1 supersedes exactly N, and N must have no terminal fact.
7. **Lifecycle.** Exactly one `ISSUED` per version, written by the version insert (so a version never exists without its issued fact). At most **one terminal fact per version** (partial unique index), so revoke-after-consume is not a state change (R-5). Facts are stamped with the **database clock** (a writer cannot backdate or postdate). `REVOKED` needs an actor and a reason. `EXPIRED` only after the stored expiry; `CONSUMED` never for an expired package and needs a receipt reference. Inserting version N+1 atomically records `SUPERSEDED` on N.

The digest is **tamper evidence only.** The database does not recompute SHA-256 over the canonical form (the canonicalization lives in the contract package); the application validator does. It does not replace RBAC, approval provenance or BO re-validation.

## 3. Decisions taken in this block (please confirm or overrule)

| # | Decision | Why | Cost if overruled |
|---|---|---|---|
| P-1 | One header per authorized action (`UNIQUE(action_id)`); supersession adds a **version**. | Gives "highest version for this authorized action" (R-10) one anchor and prevents duplicate packages for one action. | The contract allows `supersedes.packageId` to differ; the DB is stricter. Relaxing needs a new migration. |
| P-2 | A version can be superseded only while it has no terminal fact. | ISSUED -> SUPERSEDED is the only supersession edge in the Block 1 table. | Re-authorizing after a revoke/expiry would then be a new action, not a new version. |
| P-3 | `ISSUED` and `SUPERSEDED` are written by a database trigger inside the version insert. | A version can never exist without its issued fact, and the pair is atomic. | Moving it to the issuer is possible but loses the guarantee. |
| P-4 | `consumption_receipt_id` is a soft reference (no FK). | The BO receipt table is a separate, not-yet-authorized migration. | A later migration can add the FK. |
| P-5 | Rule-authorized (Level 3/4) versions skip the decision-status check but still need the header decision. | They carry no human decision status (ruling 12.2). Level 3 cannot actually be *issued* until rule/policy sources exist. | None for storage. |
| P-6 | The audit-event link (`audit_event_id`) on lifecycle events is optional. | The issuance audit write belongs to the issuer block. | Issuer block makes it mandatory where applicable. |

## 4. Deliberately NOT in 0176 (each needs its own authorization and migration number)

- Structured authorized-action capture (original / delta / final parameters, owner assignment, action type and target) - the issuer cannot build a package without it.
- The BO intake/consumption receipt in `business_operations` (names must not trip the BO isolation guard).
- Automation-level / rule-authorization policy sources, action vocabulary, simulation-run reference.
- `ACTION_AUTHORIZED` event contract registration and outbox/ledger emission.
- The issuer, repository, status contract (R-10) and the extended BO isolation guard (next sub-blocks).

## 5. Evidence

**Migration record (MIGRATION-ALLOCATION-POLICY):**

| Item | Value |
|---|---|
| Predecessor final migration | `0175_add_aba_review_version_snapshot.sql` |
| New range | `0176` only |
| Allocation check | no file, branch or open PR used 0176 on `main` `92b6894` |
| SHA-256 of frozen 0001-0175 (concatenated in name order) | `fe4495fb8dfa011247d19dbe4dcc8296349095dd21d9b72fc992026de4673e3a` |
| SHA-256 of `0176_create_authorized_action_packages.sql` | `29900b224d61e05b8119e5ffe8c06f6ef9be3e36a99d313c8c74828575b1eee2` |
| Empty install | 176 migrations applied to a brand-new PostgreSQL 16 database; no error |
| Re-run | runner re-run applies 0; forced re-execution of the 0176 file succeeds (idempotent DDL) |
| Earlier migrations | none modified |

The 0176 hash above is the hash at the time of writing; it is frozen only after owner validation.

**Tests:**
- `migration-p0-5-block3.test.ts` - 9 static tests (no database).
- `p0-5-block3-aap-persistence.integration.test.ts` - 60 live PostgreSQL tests covering every guard above, append-only for a privileged role, and RLS isolation with a least-privilege role.
- **Mutation proofs (8/8 detected):** removing the version guard (6 tests fail), the lifecycle guard (3), version append-only (1), the one-terminal index (1), the document-identity check (19), the expiry-within-decision check (1), RLS on versions (1) and the issue/supersede trigger (14).
- `aba-repositories.integration.test.ts`: the two assertions that hard-coded **46** tables in `approved_business_action` now expect **49** (46 original + 3 new). This is the only existing test touched.

**Not run here:** the full `@infinicus/database` suite on CI infrastructure. In this sandbox, 12 unrelated files fail to load `@infinicus/event-contracts` because the workspace build is unavailable; they fail identically without this change. The pre-existing intermittent bcrypt timeout in the authentication tests is unchanged and out of scope.

## 6. Deployment

0176 joins the **controlled deployment review** with 0170-0175. Live Supabase is at **0169**; **0170-0176 are unapplied.** No deployment, live apply, backfill or data change is authorized or performed.

## 7. Roadmap for the rest of Block 3 (one sub-block at a time, owner approval between)

| Sub-block | Content | Needs |
|---|---|---|
| **3a (this)** | Package storage + DB guards + proofs | done, awaiting review |
| 3b | Repository (insert/read through the guards, derived status function, RLS-scoped) - no issuer | no migration |
| 3c | Capture/owner/policy sources the issuer needs | new migration number, authorization |
| 3d | Issuer (single component, verifies decision/facts/authority, idempotent, atomic audit) | 3b + 3c |
| 3e | BO-side receipt + consumption validator + extended isolation guard | new migration number, authorization |
