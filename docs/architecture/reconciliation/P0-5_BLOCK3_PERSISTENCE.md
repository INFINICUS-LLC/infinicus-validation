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
| 3b | Repository (insert/read through the guards, derived status, revoke, expiry detection, RLS-scoped) - no issuer | no migration, **merged (#62)** |
| 3c-1 | Structured capture (original / delta / final parameters) + accountable-owner assignment | migration 0177, **merged (#63)** |
| 3c-2 | Governed action-type registry + automation-level policy (Level 2 enablement) | migration 0178, **merged (#65); registry ships EMPTY - vocabulary still needed from the owner** |
| 3c-3 | Execution-boundary authoring (window, preconditions, rollback, budget, monitoring) + simulation reference | migration 0179, **merged (#66)** |
| **3d (this PR)** | Issuer (single component, verifies decision/facts/authority, idempotent, atomic audit) | 3b + 3c; **no migration** |
| 3e | BO-side receipt + consumption validator + extended isolation guard | new migration number, authorization |

## 8. Block 3b - AuthorizedActionPackageRepository (no migration)

Status: implemented, draft for owner review. Authorized: "P0-5 Block 3b". **No migration, no issuer, no events, no BO receipt, no ABA->BO wiring.**

`packages/database/src/repositories/approved_action/AuthorizedActionPackageRepository.ts`, exported from `@infinicus/database`. Every method runs in a tenant transaction (RLS-confined).

| Method | Behaviour |
|---|---|
| `ensureHeader` | Creates the single stable package identity for an authorized action (or returns it). Idempotent and concurrency-safe; re-pointing the action to a different decision/business is a `ConflictError`. The id is what the issuer puts in `identity.packageId` before sealing. |
| `insertVersion(document)` | Stores an already-sealed document. The queryable columns are **read from the document** (one source of truth; any missing/malformed field is a `ValidationError` before the database is touched). Idempotent replay (also after supersession); a different document for the same version is a `ConflictError`; scope must equal the caller's; size-bounded (256 KiB). The 0176 guards re-verify everything. |
| `getVersion` / `getLatestVersion` / `getHeaderByActionId` / `listLifecycle` | Reads. Other tenants see nothing. |
| `getAuthoritativeStatus` | The R-10 pull answer, **derived on the database clock**: a recorded terminal fact wins; otherwise a package past its expiry is `EXPIRED` even if nobody recorded it; otherwise `ISSUED`. Echoes the digest and reports the latest version. `null` for an unknown version. |
| `revoke` | Explicit, attributable (actor), reasoned (bounded) `REVOKED` fact. Refuses a version that already has any terminal fact (so revoke-after-consume and double revoke are conflicts). The document is never touched. |
| `recordExpiryIfDue` | Idempotent expiry detection (P0-4 `approval.expired` pattern; no scheduler exists). Records `EXPIRED` only when due; returns `NOT_DUE` / `NOT_APPLICABLE` / `ALREADY_TERMINAL` otherwise. |

**Deliberately not here:** issuing (decision / authority / freshness checks - Block 3d), sealing and contract validation (the issuer validates with `@infinicus/handoff-contracts` before calling `insertVersion`; persistence has **no dependency on the contract package**), recording `CONSUMED` (it comes from the BO receipt, Block 3e), `SUPERSEDED` (written atomically by the 0176 trigger), event emission.

**BO isolation guard extended (not loosened).** `boIsolation.architecture.test.ts` gains a rule: BO code may not name `AuthorizedActionPackageRepository` or the three package tables. The contract name `AuthorizedActionPackage` stays allowed - BO reaches a package only through the validated contract (handoff invariant 4). Existing rules are unchanged.

**Evidence.**
- `p0-5-block3b-aap-repository.integration.test.ts` - 45 live PostgreSQL tests (including concurrency: 6 simultaneous header creations, identical inserts, revocations and expiry detections each yield exactly one fact), run as the least-privilege application role.
- `p0-5-block3b-aap-repository.architecture.test.ts` - 5 static tests (imports, tables touched, no issuance reads, no UPDATE/DELETE, every query in a tenant transaction).
- **Mutation proofs (9/9 detected):** replay pre-check, clock-derived expiry, the insert lock, the revoke/expiry lock, the revoke terminal check, the scope check, accepting an UNAVAILABLE expiry, the size bound, and header re-pointing.
- 3a's 60 live tests pass unchanged after moving their fixtures to `tests/helpers/aapFixtures.ts`. BO isolation: 7 tests (1 new).
- Full `@infinicus/database` suite on a migrated database: 3012 passed, 0 failed. In this sandbox 11 unrelated files cannot load `@infinicus/event-contracts` (workspace build unavailable), identically to `main`.

**Open questions for the owner**
- Q-1: `revoke` is not yet bound to a permission or an `approval_audit_events` write. The permission (suggested `aba:admin`) and the atomic audit belong to the route/issuer layer; `auditEventId` is accepted but optional. Confirm that placement.
- Q-2: `recordExpiryIfDue` has no caller yet and no scheduler (consistent with P0-4). Confirm it should be invoked on read by the status contract (3d/3e) rather than by a job.

## 9. Block 3c-1 - authorized-action capture and owner assignment (migration 0177)

Status: implemented, draft for owner review. Authorized: "3c-1 with migration 0177". **No issuer, no package change, no event emission, no BO receipt, no change to the approval route, no data, no backfill, no live apply.**

**What 0177 creates** (`approved_business_action`, append-only, RLS forced on tenant + workspace):

| Table | Role |
|---|---|
| `authorized_action_captures` | The one immutable decision-time capture per authorized action: original proposed parameters (governed), structured modification delta + reason (governed), recorded governance evidence (governed), and the **complete final effective parameter set**; action type + schema version; target; decision, decision version and status. |
| `authorized_action_owner_assignments` | The accountable owner as a linear version chain: owner user + membership, role, assigner, assignment time, due date and escalation (both governed). Re-assignment is a new version. |

**Guards the database enforces (second line behind the repository):**
- The final set is **re-derived**: `approved` => final equals the proposed set and no modification or evaluation; `approved_with_modifications` => a structured delta over a proposed set, and `final = original with the delta applied` (the contract's ADD / SET / REMOVE rules, one change per parameter, SET must change the value, `before` must equal the original). A final set that disagrees can never be stored (`MODIFICATION_LINEAGE_INCONSISTENT` in the contract).
- The decision must be approved and the capture must state exactly its status; the decision version and the action must belong to the decision, in the same scope.
- Governed fields are `VALUE` or `NOT_APPLICABLE` with a code + statement; `UNAVAILABLE` is never storable. Modification must not post-date the capture; evidence must be recorded as PASSED, within the known dimensions, and not predate the modification.
- The owner must be a real user holding an **ACTIVE membership in this tenant and workspace** (Identity/Tenancy stay the truth; ABA stores only the assignment and provenance). Due date must be after the assignment.
- Facts are stamped with the **database clock**; sizes are bounded; `UPDATE` and `DELETE` are rejected for every role.

**Repository** (`AuthorizedActionCaptureRepository`, `@infinicus/database`): `recordCapture` (idempotent; an identical replay returns the stored row, a different capture is a `ConflictError`), `getCaptureByActionId`, `requireCapture`, `assignOwner` (idempotent for the same owner; otherwise the next linear version), `getCurrentOwner`, `getOwnerVersion`, `listOwnerVersions`, and `toAccountableOwnerShape` (the assignment as the contract's `accountableOwner` block). Guard rejections surface as `ValidationError` carrying the database's own message. It is **not imported by any route, service or layer** (architecture-tested).

**BO isolation guard extended (not loosened):** BO code may not name the capture repository or the two tables.

### Decisions taken in this block (please confirm or overrule)

| # | Decision | Why / cost if overruled |
|---|---|---|
| C-1 | **One capture per action**, immutable (`UNIQUE(action_id)`). A different set of authorized parameters is a new decision and a new action, never an amendment. | The capture is the decision-time record (Block 1 5.2). Versioning it would let authorized parameters change under an unchanged decision. Relaxing needs a new migration. |
| C-2 | The **owner** is a version chain, because re-assignment is legitimate after issuance (a package version can then pick it up). | Matches P-1 (one package header, many versions). |
| C-3 | The modification **evaluation evidence is recorded here but not decided here**; whether an evaluation is *required* for a given change depends on the action-type contract (3c-2). The issuer / validator enforces that. | No vocabulary exists yet; inventing one would violate "no fabricated values". |
| C-4 | `action_type_code` / `schema_version` are **soft references** until the registry exists (3c-2). | Registry is the next sub-block. |
| C-5 | The capture is **not wired into the approve path.** `approveWithModifications` is unchanged. | Wiring it atomically with the decision touches P0-1..P0-4 behaviour and is still an open owner decision (atomic with approval vs a separate ABA step before issuance). |
| C-6 | **No backfill.** Existing decisions have no capture and therefore no package; nothing is fabricated. | Standing rule. |

### Open owner decisions
- **Placement of the capture write** (atomic with the approval vs a separate step) - still open from the 3c proposal; blocks any wiring, not this storage.
- The **initial action vocabulary and parameter schemas** (3c-2) - not invented.
- 3a's P-1..P-6 and 3b's Q-1/Q-2 remain unconfirmed.

### Evidence
**Migration record (MIGRATION-ALLOCATION-POLICY):**

| Item | Value |
|---|---|
| Predecessor final migration | `0176_create_authorized_action_packages.sql` (unchanged; hash below still matches the 3a record) |
| New range | `0177` only |
| Allocation check | no file, branch or open PR used 0177 on `main` `2af1a82` |
| SHA-256 of frozen 0001-0176 (concatenated in name order) | `26ee2c41b93cd439520e119f374d2c36506abf4c8859e7e46dadc98bee1b0d8d` |
| SHA-256 of `0177_create_authorized_action_capture.sql` | `9cef41a3cb0175322eb20b4b87607a9e80f1007c2c18efb6511863356744fbe4` |
| Empty install | 177 migrations applied to a brand-new PostgreSQL 16 database via the runner's exact logic; no error |
| Re-run | runner re-run applies 0; forced re-execution of the 0177 file succeeds (idempotent DDL) |
| Earlier migrations | none modified |

The 0177 hash is the hash at the time of writing; it is frozen only after owner validation.

**Tests:**
- `migration-p0-5-block3c1.test.ts` - 9 static tests. `p0-5-block3c1-capture.architecture.test.ts` - 6 static tests (imports, tables touched, no authority/package logic, append-only, tenant transactions, not wired anywhere).
- `p0-5-block3c1-capture.integration.test.ts` - 54 live PostgreSQL tests as the least-privilege role, including the delta arithmetic (every ADD / SET / REMOVE rule), decision relationship, shapes, immutability, RLS, Identity/Tenancy binding, direct-to-database guards that bypass the repository, and concurrency (repeated rounds).
- **Mutation proofs:** 12 of 12 effective migration mutants detected (duplicate-parameter check, SET-must-change, final-set derivation, plain-approval equality, decision-status check, stale evidence, future modification, active-membership, membership-user match, past due date, owner chain, RLS enabled, append-only trigger) and 6 of 6 repository mutants (replay comparison, capture lock, owner idempotency, owner lock, governed check, guard-error mapping). One mutant, `FORCE ROW LEVEL SECURITY`, is *equivalent* for the non-owner application role and is covered by the static test instead. A surviving concurrency mutant (capture lock) led to a stronger repeated-round test.
- `aba-repositories.integration.test.ts`: the two table-count assertions move **49 -> 51** (the only existing test touched). BO isolation: 8 tests (1 new).
- **Shared-database footprint:** the owner-authority dry-run test scans every business in the shared CI database under a 5 s timeout. The 3c-1 tests therefore reuse two shared worlds (tenant/workspace/business) instead of creating one per test, adding 2 businesses rather than about 100. 3a/3b fixtures were left as merged.
- Full `@infinicus/database` suite on a migrated database: 3081 passed, 0 failed. In this sandbox 11 unrelated files cannot load `@infinicus/event-contracts` (workspace build unavailable), identically to `main`.

### Deployment
0177 joins the **controlled deployment review** with 0170-0176. Live Supabase is at **0169**; **0170-0177 are unapplied.** No deployment, live apply, backfill or data change is authorized or performed.

## 10. Block 3c-2 - action-type registry and automation-level policy (migration 0178)

Status: implemented, draft for owner review. Authorized: "3c-2 with migration 0178". **No vocabulary and no policy are seeded. No issuer, no package/capture/owner change, no events, no BO registry, no change to the approval route, no data, no live apply.**

**What 0178 creates** (`approved_business_action`, append-only, RLS forced on tenant + workspace):

| Table | Role |
|---|---|
| `action_type_definitions` | Immutable definition of one action type at one schema version: target kinds, parameter specs, parameter -> governance-dimension impact (R-7), and which governed fields may be NOT_APPLICABLE (D-6). A change is a **new schema version**. |
| `action_type_status_events` | `ACTIVE` once, then (optionally, with a reason) `RETIRED` once. No event = DRAFT = unusable. State is derived. |
| `automation_level_policies` | The governed policy identity a package cites as `action.automationLevel.policy.policyId`. One automation level (2, 3 or 4) per policy. |
| `automation_level_policy_versions` | Immutable linear versions (the `policyVersionId` a package cites). |
| `automation_level_policy_enablement_events` | `ENABLED` / `DISABLED` facts with actor and reason. The latest event wins; none = not enabled. |

**Guards the database enforces:**
- A definition must be well formed (`aap_action_type_problems`, an immutable SQL function reporting every problem), in both a `CHECK` and a trigger. It mirrors the contract's `validateActionTypeContract` and is **stricter in 7 documented ways** (unique and non-blank target kinds, valid `maxLength`, integer bounds for integer parameters, no foreign properties on a parameter spec, a boolean `required`, a bounded code length). A shared **golden-case file** (`handoff-contracts/tests/fixtures/action-type-golden-cases.json`, 30 cases) is run by the contract package and by the database tests, and asserts that **whatever the database accepts, the contract also accepts**.
- Status: legal transitions only (activate once; retire only an ACTIVE type, with a reason; no re-activation). Facts are stamped with the **database clock**.
- Enablement: **Level 2 only**; only the **latest** version of a policy; **one enabled version per level and scope** (disable the other first, serialized by an advisory lock so it cannot race); only an enabled version can be disabled; a reason is required. Levels 3 and 4 can be defined but not enabled (ruling 12.1, P-5).
- Policy versions form a linear chain tied to the policy's level. `UPDATE` and `DELETE` are rejected for every role.

**Repositories** (`@infinicus/database`): `ActionTypeRegistryRepository` (`define` - idempotent, a different definition at the same version is a `ConflictError`; `activate`; `retire`; `get`; `getById`; `resolveActive` - ACTIVE only; `listActive`; `toActionTypeContract`) and `AutomationLevelPolicyRepository` (`createPolicy` with version 1, `addVersion`, `enable`, `disable`, `getEnablement` - shape-compatible with the contract's `PackageEnablementPolicy`, `getEffectivePolicy`, reads). Guard rejections surface as `ValidationError` with the database's own message. **Neither is imported by any route, service or layer** (architecture-tested). `BO isolation guard` extended, not loosened: BO may not name either repository or the five tables. "BO can execute this" remains Business Operations' own capability registry.

### Decisions taken in this block (please confirm or overrule)

| # | Decision | Why / cost if overruled |
|---|---|---|
| G-1 | The registry and policies are **workspace-scoped** (tenant + workspace), not platform-global. | The platform doctrine is tenant isolation on every persistent table; a global table needs a new RLS pattern and a privileged authoring path. If you want one platform-wide vocabulary, that is a new migration (the tables are empty, so it is cheap). |
| G-2 | **Nothing is seeded.** Until action types are defined and activated and a Level 2 policy is enabled, nothing can be issued. | The owner has not supplied a vocabulary; none is invented. |
| G-3 | Definitions are immutable and **activated once**; a corrected definition is a new schema version. | Keeps history auditable and stops authorized parameters changing under an active type. |
| G-4 | **Level 2 only** can be enabled; Levels 3 and 4 can be defined. | The scope this block was authorised for; Level 3 also lacks its provenance sources (P-5). |
| G-5 | **One enabled version per (scope, level)**, latest version only; changing policy is an explicit disable then enable. | Makes "the" governed policy for a level unambiguous. |
| G-6 | **Who may define, activate or enable** (suggested `aba:admin`) is a route-layer decision, like Q-1: the repositories take an actor id and write it, and bind no permission. | No route exists yet. |

### Open owner decisions
- **The initial action vocabulary and parameter schemas**, and the first Level 2 policy. Without them nothing is issuable. (Still not supplied.)
- Platform-global vs workspace-scoped registry (G-1); permission model (G-6).
- The still-open capture-placement decision, and 3a P-1..P-6, 3b Q-1/Q-2, 3c-1 C-1..C-6.

### Evidence
**Migration record (MIGRATION-ALLOCATION-POLICY):**

| Item | Value |
|---|---|
| Predecessor final migration | `0177_create_authorized_action_capture.sql` (unchanged; 0176 and 0177 hashes still match their records) |
| New range | `0178` only |
| Allocation check | no file, branch or open PR used 0178 on `main` `6f61ec8` |
| SHA-256 of frozen 0001-0177 (concatenated in name order) | `d3b32b165f498a0cc5a7383e2c1aae049e864006341b83b902d826064b7b9bf2` |
| SHA-256 of `0178_create_action_governance.sql` | `53f292008660ba552acecf7f5f63d79576a53d29c10ea5dc131b8f0ff6e97f48` |
| Empty install | 178 migrations applied to a brand-new PostgreSQL 16 database via the runner's exact logic; no error; all five tables empty |
| Re-run | runner re-run applies 0; forced re-execution of the 0178 file succeeds (idempotent DDL) |
| Earlier migrations | none modified |

The 0178 hash is the hash at the time of writing; it is frozen only after owner validation.

**Tests:**
- `migration-p0-5-block3c2.test.ts` - 10 static tests (incl. "seeds NO data"). `p0-5-block3c2-governance.architecture.test.ts` - 13 static tests (both repositories). `aap-action-type-golden.contract.test.ts` - 32 tests in the contract package.
- `p0-5-block3c2-governance.integration.test.ts` - 36 live PostgreSQL tests as the least-privilege role: the empty start, the full DRAFT -> ACTIVE -> RETIRED lifecycle, the validator (11 invalid-definition cases, the 30 golden cases, direct writes that bypass the repository), enablement rules, concurrency (repeated rounds), append-only, RLS and tenant isolation.
- **Mutation proofs:** 16 of 16 effective migration mutants detected (validator: code pattern, enum duplicates, empty range, impact on an undeclared parameter, unknown spec property; definition trigger; retire without ACTIVE; any level enabled; stale version enabled; several enabled per level; disable of a non-enabled version; policy chain; RLS enabled; append-only trigger). Two mutants are *equivalent by design* because two layers enforce the same rule: the validator `CHECK` (the trigger also enforces it) and the "activated once" trigger check (the unique index also enforces it).
- A real bug was found by running the validator first: appending a bare string literal to a `text[]` is parsed as an array literal; every append now uses `array_append`.
- `aba-repositories.integration.test.ts`: the two table-count assertions move **51 -> 56** (the only existing test touched). BO isolation: 9 tests (1 new).
- **Shared-database footprint:** these tests create bare tenant + workspace scopes (no business rows), so they add no businesses to the table the owner-authority dry-run test scans.
- Full `@infinicus/database` suite on a migrated database: 3140 passed, 0 failed; `handoff-contracts`: 432 passed. In this sandbox 11 unrelated database files cannot load `@infinicus/event-contracts` (workspace build unavailable), identically to `main`.

### Deployment
0178 joins the **controlled deployment review** with 0170-0177. Live Supabase is at **0169**; **0170-0178 are unapplied.** No deployment, live apply, backfill or data change is authorized or performed.

## 11. Block 3c-3 - execution boundaries and simulation reference (migration 0179)

Status: implemented, draft for owner review. Authorized: "3c-3 with migration 0179". **No issuer, no package/capture/owner/registry change, no events, no BO registry, no change to the approval route, no data (nothing seeded), no live apply.**

**What 0179 creates** - one append-only, RLS-forced, tenant + workspace table, `approved_business_action.authorized_action_boundaries`: a **linear version chain per authorized action** holding the six governed fields the package needs, each in exactly the `aap/1` Governed shape (a real value, or a governed `NOT_APPLICABLE` with a reason; `UNAVAILABLE` is never storable): execution window `{startsAt, endsAt|null}`, preconditions `[{code, operator, operand}]`, budget `{amount, currency}`, rollback `{instructions}`, monitoring `{metrics[{metricCode, target, unit}]}`, and the simulation run reference (a uuid or a governed `NOT_APPLICABLE`, ruling D-6). Re-authoring a window, budget or plan is a **new version**, never an edit.

**Guards the database enforces (second line behind the repository):**
- The action must have its **immutable capture** (0177), and the capture's action type must be an **ACTIVE** governed definition (0178): draft, retired and undefined types cannot be authorized.
- Every field has exactly the contract's shape (`aap_boundary_problems`, an immutable SQL function reporting every problem, in both a `CHECK` and a trigger). A shared **golden-case file** (`handoff-contracts/tests/fixtures/boundary-golden-cases.json`, 60 cases) is run by the contract package (against `validateAuthorizedActionPackage`, field by field) and by the database tests, and asserts that **whatever the database accepts, the contract also accepts**. In the current cases the two agree exactly.
- **Applicability:** a field may be `NOT_APPLICABLE` only where the action type's `applicability` says `NOT_APPLICABLE_ALLOWED`; an unlisted or `REQUIRED` field must carry a value (fail closed). The simulation reference is not gated, as the contract does not gate it.
- The window ends after it starts; sizes are bounded; facts are stamped with the **database clock**; `UPDATE` and `DELETE` are rejected for every role.

**Repository** (`AuthorizedActionBoundaryRepository`, `@infinicus/database`): `recordBoundaries` (next version; **idempotent** for identical boundaries, even with a new correlation id or reordered keys; concurrency-safe), `getCurrent`, `getVersion`, `listVersions`, and `toPackageBoundaryParts` (the stored boundaries placed exactly where the contract puts them: five `action.*` fields and `lineage.simulationRunId`). Guard rejections surface as `ValidationError` with the database's own message. It is **not imported by any route, service, layer or other repository** (architecture-tested), and it depends on no other repository.
**BO isolation guard extended, not loosened:** BO may not name the repository or the table.

### Decisions taken in this block (please confirm or overrule)

| # | Decision | Why / cost if overruled |
|---|---|---|
| B-1 | A **dedicated table**; the existing, never-populated tables (`action_execution_windows`, `approved_action_steps`, `approved_action_constraints`, ADI monitoring requirements) are **not reused** and are left untouched. | They hang off mutable plan headers and carry different semantics; reusing them would mix two models. Cost of overruling: a new migration to bridge or retire them. |
| B-2 | The **simulation reference lives here** (a governed soft uuid, no foreign key, no read of the simulation layer), not on the review version. | Avoids altering the P0-3 review write path. If the owner also wants it snapshotted at review time, that is an additive nullable column later. |
| B-3 | Boundaries are **versioned**, and re-stating an older version is a new version. | A package version can legitimately pick up new boundaries (P-1). |
| B-4 | A **retired** action type stops NEW boundaries but never invalidates existing ones. | Retirement is about future authorization, not history. |
| B-5 | The **boundary `NOT_APPLICABLE` reason code must be UPPER_SNAKE** (the contract's rule). | Mirrors the contract exactly so a stored value can always be issued. |
| B-6 | **Authoring permission** (suggested `aba:admin`) is a route-layer decision, like Q-1 / G-6; the repository records only the actor id. | No route exists yet. |
| B-7 | The window is **not** checked against the decision's `valid_until` here. | Package expiry is derived from the validity bounds at issuance (R-6); that is the issuer's computation. |

**Finding for the owner (not changed here):** the 3c-1 capture stores governed `NOT_APPLICABLE` reasons checking only that the code and statement are non-blank, whereas the contract also requires an UPPER_SNAKE code. A capture with a lower-case reason code would therefore be storable but would fail contract validation at issuance. 3c-1 is merged and immutable, so the safe place to catch it is the issuer (3d), or a tightening migration if you prefer it enforced at write time.

### Open owner decisions
- The **initial action vocabulary and first Level 2 policy** (still not supplied: nothing is authorizable until then); capture placement (atomic with approval vs a separate step); 3c-2 G-1..G-6, 3c-1 C-1..C-6, 3b Q-1/Q-2, 3a P-1..P-6; and this block's B-1..B-7.

### Evidence
**Migration record (MIGRATION-ALLOCATION-POLICY):**

| Item | Value |
|---|---|
| Predecessor final migration | `0178_create_action_governance.sql` (unchanged; 0176, 0177, 0178 hashes still match their records) |
| New range | `0179` only |
| Allocation check | no file, branch or open PR used 0179 on `main` `a192f8e` |
| SHA-256 of frozen 0001-0178 (concatenated in name order) | `bd8ecb4ac9fa8aa5db9672516877059dfd6e2cfb4d88e4426fe064d086191915` |
| SHA-256 of `0179_create_authorized_action_boundaries.sql` | `f461f7d4a98f59d2db5a0f5fb1f95ba731ca5a1f0c7dd5d3e871e8be5198739e` |
| Empty install | 179 migrations applied to a brand-new PostgreSQL 16 database via the runner's exact logic; no error; the table is empty |
| Re-run | runner re-run applies 0; forced re-execution of the 0179 file succeeds (idempotent DDL) |
| Earlier migrations | none modified |

The 0179 hash is the hash at the time of writing; it is frozen only after owner validation.

**Tests:**
- `migration-p0-5-block3c3.test.ts` - 8 static tests (incl. "seeds NO data"). `p0-5-block3c3-boundaries.architecture.test.ts` - 6 static tests. `aap-boundary-golden.contract.test.ts` - 62 tests in the contract package (60 golden cases).
- `p0-5-block3c3-boundaries.integration.test.ts` - 35 live PostgreSQL tests as the least-privilege role: storage and the contract placement, idempotency and linear versioning, concurrency (repeated rounds), the capture and ACTIVE-type requirements, the applicability rule per field (fail closed, explicit `REQUIRED`, permitted), shapes, direct writes that bypass the repository, append-only, the database clock, RLS isolation and the 60 golden cases.
- **Mutation proofs:** 17 of 17 effective migration mutants detected (capture required; ACTIVE type required; retired excluded; applicability enforced; unlisted treated as required; shape validator in the trigger; window ordering; budget amount; currency; operator; empty metrics; unknown keys; reason-code pattern; simulation uuid; version chain; RLS enabled; append-only trigger) and 3 of 3 repository mutants (idempotency, lock, UNAVAILABLE). One more repository mutant ("capture not compared on replay") is *equivalent*: the database permits exactly one capture per action, so two boundaries for one action can never differ by capture.
- `aba-repositories.integration.test.ts`: the two table-count assertions move **56 -> 57** (the only existing test touched). BO isolation: 10 tests (1 new).
- **Shared-database footprint:** these tests reuse two shared worlds (tenant/workspace/business) and add 2 businesses in total.
- Full `@infinicus/database` suite on a migrated database: 3189 passed, 0 failed; `handoff-contracts`: 494 passed. In this sandbox 11 unrelated database files cannot load `@infinicus/event-contracts` (workspace build unavailable), identically to `main`.
- During review of my own work the 3c-1 "not wired" guard correctly flagged a type import from the capture repository; the types are now defined locally so the repositories stay decoupled and no merged test was loosened.

### Deployment
0179 joins the **controlled deployment review** with 0170-0178. Live Supabase is at **0169**; **0170-0179 are unapplied.** No deployment, live apply, backfill or data change is authorized or performed.

## 12. Block 3d - the ABA package issuer (no migration)

Status: implemented, draft for owner review. Authorized: "P0-5 Block 3d". **No migration (head stays 0179), no ABA->BO wiring, no `ACTION_AUTHORIZED` event, no BO consumer, no live Supabase change, no backfill, no override, no scheduler, no locked-spec edit.**

**Purpose.** One ABA-owned component, `AuthorizedActionPackageIssuer` (`@infinicus/workflow`), turns an approved, captured and bounded authorized action into a sealed `aap/1` package. It accepts identifiers only (`{ actionId, correlationId? }`); every authorization fact is loaded server-side.

**Owner rulings applied.**
- Canonical action type `inventory_reorder_policy_update` v1, target kind `inventory_item`, parameters `reorderPoint` / `reorderQuantity` (numbers, min 0), impacts as ruled, no automatic Simulation requirement. **The code is snake_case (owner approved option B)** because the `aap/1` contract and migration 0178 both fix action codes to `[a-z][a-z0-9_]*`; the dotted spelling would have needed contract + migration changes. The canonical contract lives in `@infinicus/handoff-contracts` (`canonical-actions.ts`); the workspace registry row must EQUAL it (`actionTypeMatchesCanonical`) and may never redefine it.
- Canonical applicability is fail-closed and **confirmed (ruling D3D-1)**: execution window, preconditions, budget, rollback, monitoring, the simulation reference and at least one authoritative validity bound are all REQUIRED for this type. No `valid_until`, no bounded window and no governed expiry => `VALIDITY_BOUND_REQUIRED`; a NOT_APPLICABLE simulation => `SIMULATION_REQUIRED`. Absence of a source is never converted to NOT_APPLICABLE. The rule is per `code@schemaVersion` (the allow-set `SIMULATION_NOT_APPLICABLE_ALLOWED` is empty; a future type states its own applicability in its canonical definition) and is not generalized.
- Level 2 only. Issuance needs an ENABLED Level 2 policy whose version `specification.actionTypes` lists `{code, schemaVersion}` of the action type (the representation of the ruled "Level 2 template"; no schema change). Level 3 / Level 4 are never issuable (0178 cannot even enable them; the seal enablement is `[2]`).
- Capture is a separate ABA step; approved-without-capture is not issuable. NOT_APPLICABLE reason codes must already be UPPER_SNAKE (checked on the whole candidate and the sealed package; never normalized).

**Architecture.**

| Piece | Where | Role |
|---|---|---|
| `withSharedTenantTransaction` | `database/src/client.ts` | Opt-in AsyncLocalStorage scope: every `withTenantTransaction` call inside it JOINS one transaction (cross-tenant/workspace and nesting fail closed). Outside the scope nothing changes. |
| `AuthorizedActionIssuanceRepository` | `database/.../approved_action/` | Reads upstream facts (action, decision, approval audit, assignment version and provenance as of the decision, review version, recommendation lineage, DB clock); writes only issuance/refusal audit rows. Decides nothing. |
| `packageIssuancePolicy.ts` | `workflow/src` | Pure judgement + candidate assembly; reuses `evaluateApproval` (P0-2) and `evaluateApprovalGate` (P0-3). |
| `AuthorizedActionPackageIssuer.ts` | `workflow/src` | Orchestration, sealing (the only caller of `sealAuthorizedActionPackage` outside the contract), idempotency, audit, one transaction. |

**Authoritative sources loaded (all by id, server-side).** `approved_actions` + its latest version; `approval_decisions` + latest version; the single `approval.approved*` row in `approval_audit_events` (approval-audit/1: approver, assignment, permission used, review facts); `approver_assignments`, the `approver_assignment_versions` row in force at the decision instant, and the `approval_authority_scopes` provenance (canonical, ruling D3) as of the decision; the review version named by the audit facts (risk class, time-sensitivity, `valid_until`, Twin id) and its recommendation version; Twin freshness (`assessFreshness`); the capture (final parameters re-derived by the database); the current owner assignment; the current boundaries and simulation reference; the workspace action-type registration and its status; the enabled Level 2 policy and its version; the database clock.

**Issuance / refusal matrix.**

| Condition | Result |
|---|---|
| Approved or approved-with-modifications, audited once, authority granted before and not revoked since, risk tier passes, fresh, captured, owned, bounded, canonical type ACTIVE and equal, Level 2 policy covers it | **ISSUED** |
| Same authoritative inputs again | **REPLAYED** (existing package; no new version, no new audit) |
| Changed inputs, latest version still ISSUED | next version, atomically **SUPERSEDES** the previous (never an overwrite) |
| No capture / owner / boundaries / simulation reference | `CAPTURE_MISSING` / `OWNER_MISSING` / `BOUNDARIES_MISSING` |
| Lowercase or malformed NOT_APPLICABLE code | `NOT_APPLICABLE_REASON_CODE_INVALID` |
| Type not canonical / not ACTIVE / registry row differs from canonical | `ACTION_TYPE_NOT_CANONICAL` / `ACTION_TYPE_NOT_ACTIVE` / `ACTION_TYPE_DIVERGES_FROM_CANONICAL` |
| No enabled Level 2 policy, or it does not name the type AND schema version (a v1 policy never authorizes v2) | `LEVEL2_POLICY_NOT_ENABLED` |
| No canonical grant at decision time / revoked since | `AUTHORITY_NOT_ESTABLISHED` / `AUTHORITY_REVOKED` |
| NOT_APPLICABLE simulation reference for a type that requires it | `SIMULATION_REQUIRED` |
| No valid_until, no bounded window, no governed expiry | `VALIDITY_BOUND_REQUIRED` |
| Role below the P0-2 tier | `RISK_POLICY` |
| Expired, stale Twin, unknown time-sensitivity | `FRESHNESS_GATE` |
| Approval audit missing / ambiguous / disagrees with decision, assignment or review | `APPROVAL_AUDIT_*` |
| Stored latest package fails validation (tampered) | `STORED_PACKAGE_INVALID` |
| Identical package revoked/expired/consumed; changed inputs but latest has a terminal fact | `EXISTING_PACKAGE_NOT_REPLAYABLE` / `SUPERSESSION_BLOCKED` |
| Contract validation of the candidate fails | `PACKAGE_INVALID` (with every contract error) |
| Audit or package write fails | `AUDIT_FAILED` / `PERSISTENCE_FAILED` (whole issuance rolled back) |
| Unknown action, or another tenant's | `ACTION_NOT_FOUND` |

**Transaction boundary.** `lock(action)` -> load -> judge -> seal -> **issuance audit** -> **package insert (+ trigger-written ISSUED / SUPERSEDED facts)** run in ONE shared tenant transaction; any error rolls everything back (including the package header). A refusal is audited afterwards, in its own transaction, as `package.issuance_refused` with every reason code (unattributable refusals, i.e. an unknown action, have no business to attach to). P0-1..P0-4 approval transaction semantics are untouched.

**Audit.** Success: `package.issued` (schema `package-issuance-audit/1`) carrying action, decision, the approval audit event id, package id/version/digest, supersession link, level and policy, action type, simulation reference and the modification delta; `trace.causationId` of the package is the approval audit event. Failure: `package.issuance_refused`. The lifecycle ISSUED fact is trigger-written (0176) and has no audit column, so the link runs audit -> package by id and digest.

**Idempotency.** Compares the candidate with the stored latest package after removing only volatile facts (version, supersession link, issue time, freshness assessment time, trace correlation id, digest). A per-action advisory lock serialises concurrent issuers.

**Re-validation.** The issuer re-judges every authoritative fact on every call, including replays: if authority has since been revoked, or the package would already be expired, the call is refused. Consumption-time re-validation remains the BO validator's job (Block 3e / P0-6).

**Tests (all new, 5 existing files touched only by additive edits).**
- `AuthorizedActionPackageIssuer.integration.test.ts` - 48 live PostgreSQL tests as the least-privilege role (issuance of plain and modified approvals, NOT_APPLICABLE acceptance only where the canonical contract allows it, simulation required, 24 refusal cases, replay, concurrency, versioning/supersession, revoked package, tampered package, caller cannot substitute facts, audit and persistence rollback).
- `packageIssuancePolicy.test.ts` - 18; `issuer.architecture.test.ts` - 11 (only the issuer seals; not imported elsewhere; no events, no BO, no consumption path; pure policy; reader writes only audit rows).
- `aap-canonical-actions.contract.test.ts` - 12 (handoff-contracts: 494 -> 506); `p0-5-block3d-shared-transaction.integration.test.ts` - 8 (rollback, atomic commit, scope isolation, fail-closed tenant crossing, no nesting, concurrency).
- Extended guards: BO isolation (+1 test, +1 forbidden-pattern rule for the issuer, reader, seal and audit names) and the contract architecture test (the seal allow-list now holds exactly `packages/workflow/src/AuthorizedActionPackageIssuer.ts`).
- **Mutation proofs:** 35 of 35 temporary mutants detected (simulation required, validity bound required, policy schema version, simulation allow-set, capture, UPPER_SNAKE, ACTIVE status, canonical divergence, Level 2 policy and its action-type scope, risk policy, freshness gate, later revocation, authority at decision, owner, boundaries, approval audit, permission used, idempotency key, decidedAt, final parameters, single transaction, tamper check, supersession of a terminal version, action lock, refusal audit, replay of a non-ISSUED package, Level 3 enablement, recommendation lineage, capture/decision match, assignment version as-of decision, approval event filter, shared-transaction join / tenant check / nesting).
- Full CI-scoped suites on a migrated database: handoff-contracts 506, workflow 195 (+1 skipped), api 135, authentication 54, BO runtime 27, event-contracts 15, database 3280 passed. The two `owner-authority` dry-run tests time out (5 s) ONLY in this sandbox's shared database, which had accumulated ~2900 businesses from repeated runs; both pass on a clean migrated database (16/16), where the new suites add about 61 businesses.

**Owner rulings D3D-1..D3D-4 (recorded; PR #67 review-ready).**
- **D3D-1** applicability: fail-closed as above; strict for this action type only, never silently generalized.
- **D3D-2** Level 2 policy shape confirmed: `specification.actionTypes = [{code, schemaVersion}]`; authorization is bound to code AND schema version (test: a v2-only policy does not authorize v1).
- **D3D-3** authority: valid at decision time AND at issuance time. Revoked after approval but before issuance => `AUTHORITY_REVOKED`; the historic approval and decision are untouched. Consumption-time authority/status revalidation remains required later (Block 3e / P0-6).
- **D3D-4** `approved_action_versions` is lineage/descriptive only. The issuer pins the latest row's id (same action, tenant, workspace and business) and reads nothing else from it; exact parameters come only from `authorized_action_captures.final_parameters`; no free-text description reaches a package (tested, plus an architecture guard). **If `approved_action_versions` ever gains executable semantics, STOP AND REPORT before continuing with this model.**
- Canonical code `inventory_reorder_policy_update` accepted; no migration 0180 for dotted codes; the `[a-z][a-z0-9_]*` constraint stays.

### Deployment
No migration. The issuer is not wired to any route, job or event. Production is non-issuable until a workspace activates the action type and a Level 2 policy through a later authorized administration path (`aba:admin`).
