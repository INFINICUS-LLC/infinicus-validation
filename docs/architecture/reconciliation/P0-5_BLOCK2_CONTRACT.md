# P0-5 Block 2 — `AuthorizedActionPackage` v1: pure contract, canonicalization, integrity digest, validator

Status: **implemented, pure and database-free.** No persistence, no BO intake table, no ABA→BO wiring, no `ACTION_AUTHORIZED` emission, no event consumer, no owner-assignment or automation-policy persistence, no migration, no live Supabase change, no locked-spec edit. `ApprovedAction` execution semantics are unchanged. Base: `main` at `68d367c`.
Owner rulings applied: P0-5 Block 1 D-1..D-7 + integrity ruling, and R-1..R-11 (this block's authorisation). Companion: `P0-5_BLOCK1_RECONCILIATION.md`.

## 1. Where it lives and why
`packages/handoff-contracts/src/authorized-action-package/` — the shared handoff-contract package (R-9). It already holds every layer-boundary contract (`aba-to-om`, `dal-to-bo`, …), is importable by Business Operations without touching ABA code, and has no runtime dependency. The contract is **pure**: serializable data and functions only, no database, no I/O, no clock (time is always supplied by the caller), no Node built-ins (a pure SHA-256 is included so ABA and BO stay portable).

| File | Purpose |
|---|---|
| `types.ts` | Package v1 types, constants, `Governed<T>`, lifecycle facts, `AuthoritativePackageStatus` |
| `canonical.ts` | `aap-canonical/1` canonicalization and the integrity digest |
| `sha256.ts` | Pure SHA-256 (NIST vectors + differential test against `node:crypto`) |
| `action-types.ts` | Versioned action-type contract interface, registries, parameter specs, governance-impact mapping |
| `primitives.ts` | Small non-backtracking string checks |
| `validator.ts` | Validation, `sealAuthorizedActionPackage`, `validateForExecution`, error taxonomy |

## 2. Contract shape (v1)
`contractVersion: 'aap/1'` plus eleven blocks. Every block is strict: an unknown field is an error (an unsigned extension cannot be smuggled in).

| Block | Content | Manifest §8.7 / ABA coverage |
|---|---|---|
| `identity` | `packageId`, `packageVersion` (≥1), `supersedes` (null or package id + version) | package version (15) |
| `scope` | `tenantId`, `workspaceId`, `businessId` | scope |
| `issuance` | `issuedAt` (database time), `issuerComponent` | issuance timestamp |
| `action` | `actionId`, `actionVersionId`, `type {code, schemaVersion}`, `target {kind,id}`, `parameters` (exact effective authorized set), `automationLevel {level, policy{policyId, policyVersionId}}`, `executionWindow`, `preconditions`, `budget`, `rollback`, `monitoring` | action ID, exact authorized parameters, execution window, automation level, budget, preconditions, rollback instructions, monitoring metrics |
| `lineage` | `recommendation`, `review`, `decision` (ids + version ids), `twinSnapshotId`, `simulationRunId`, `proposedParameters` (ADI original set + source), `modification` (structured delta), `modificationEvaluation` | decision ID, ABA §9, §25 (Twin snapshot, Simulation run, modified parameters) |
| `authorization` | `decisionStatus` (`approved` \| `approved_with_modifications`), `decidedAt`, `approver {userId, assignmentId, assignmentVersionId, roleCode}`, `authorityProvenance {scopeId}`, `permissionUsed`, `risk {riskClass, basis, requiredApproverTier, approverTier}` | approver, approval record, permission used (§25) |
| `accountableOwner` | `identity {userId, membershipId}` (canonical Identity/Tenancy, R-2), `roleCode`, `assignment {assignmentId, assignedByUserId, assignedAt}`, `dueAt`, `escalationPolicy` | owner (ABA §13) |
| `validity` | `isTimeSensitive`, `decisionValidUntil`, `freshness`, `expiryBounds[]`, `expiresAt` | valid-until, freshness (ABA §11-12) |
| `consumption` | `{ mode: 'SINGLE_USE' }` (R-5) | single-use |
| `trace` | `correlationId`, `causationId`, `approvalAuditEventId` | correlation/causation, approval record link |
| `integrity` (sealed only) | `canonicalVersion`, `algorithm`, `digest` | tamper evidence |

**Every Manifest §8.7 field is representable** (action ID, decision ID, exact authorized parameters, approver, owner, execution window, automation level, budget, preconditions, rollback instructions, monitoring metrics, approval record). No STOP condition was triggered.

### 2.1 `VALUE` / `NOT_APPLICABLE` / `UNAVAILABLE` (D-6, R-4)
- Governed fields are `Governed<T>` = `{state:'VALUE', value}` or `{state:'NOT_APPLICABLE', reason:{code, statement}}`. The reason is preserved and digest-covered.
- **There is no `UNAVAILABLE` member in the issued type.** While a candidate is assembled, a missing source is `{state:'UNAVAILABLE', source}`; the validator rejects such a marker at **any path** with `REQUIRED_FIELD_UNAVAILABLE`, and `sealAuthorizedActionPackage` refuses. A knowingly non-executable package can never be issued.
- Never `NOT_APPLICABLE`: action type/target, exact parameters, automation level, approver/provenance, risk, accountable owner, scope/identity, correlation. These are plain required fields.
- `NOT_APPLICABLE` is decided by the **action-type contract** for `executionWindow`, `preconditions`, `budget`, `rollback`, `monitoring` (default REQUIRED; fail closed) and by **consistency rules** for the rest (see 3).

### 2.2 Exact effective parameters, original lineage, modification delta (D-1, D-2)
- `action.parameters` is the ABA-authored effective set; BO executes this set and nothing else.
- `lineage.proposedParameters` carries the ADI original set and its source record (ADI-supplied only where governed evidence exists; otherwise a governed `NOT_APPLICABLE` and ABA authored the whole set).
- `lineage.modification` is a structured delta: reason, modifier, time, and per-parameter `SET` / `ADD` / `REMOVE` changes with before/after values. **Prose-only is not representable.**
- `lineage.modificationEvaluation` carries the fresh governance evidence required by execution-affecting modifications.
- Forward-compat: the three persisted facts (original, delta, final) map one-to-one onto the structured capture the persistence block must add.

## 3. Validator rules
Entry points: `validatePackageBody` (unsealed candidate), `sealAuthorizedActionPackage` (the **only** creation function), `validateAuthorizedActionPackage` (sealed: structure + semantics + digest), `validateForExecution` (BO, pre-execution).

**Order:** supported contract version first (an unsupported version is never interpreted) → whole input in the canonical JSON domain (no `undefined`/NaN/Date/bigint/cycles/lone surrogates; size cap) → forbidden keys (`__proto__`, credential-like) → `UNAVAILABLE` scan → strict structural parse → semantics → (sealed) digest.

**Semantic rules**
- *Action type (R-1):* contract for `(code, schemaVersion)` must exist; target kind allowed; every parameter declared and valid; every required parameter present; `NOT_APPLICABLE` only where the action type allows it.
- *Automation level (R-3):* levels **2 and 3 only** (0-1 do not execute; 4 is future autonomous). **Judgement for owner review.**
- *Risk:* unclassified ⇒ `high`; approver tier ≥ required tier (risk policy passed).
- *Modification (D-2, R-7):* `approved` ⇒ no modification and parameters equal the proposal (if any); `approved_with_modifications` ⇒ original set present, ≥1 change, each change applies cleanly to the original, the result **equals** the effective set exactly, and for the changed parameters the action schema's `governanceImpact` map decides the required dimensions — **an unmapped parameter forces all dimensions (`CONSERVATIVE_FULL`)**, an explicit empty list means none — and fresh `PASSED` evidence must exist for each (evaluated after the modification and before issuance). No numeric thresholds.
- *Validity (R-6):* time-sensitive ⇒ `valid_until` present; Twin reference ⇒ freshness `FRESH`; the bounds list must equal the real sources (decision `valid_until`, execution-window end, optional explicit expiry); **`expiresAt` is the earliest bound** (or `NOT_APPLICABLE` when none applies); expiry already passed at issuance is refused. **A package with no applicable bound is allowed** (`expiresAt` governed `NOT_APPLICABLE`) — judgement for owner review.
- *Timeline:* decision, owner assignment and freshness assessment not after issuance; due date after assignment; window end after start.
- *With a supplied time (database time):* issued-in-future and expired are refused. Timestamps have exactly one accepted form (`YYYY-MM-DDTHH:mm:ss.sssZ`) so equal instants cannot hash differently.

**Pre-execution (`validateForExecution`, R-5, R-10)** — all of the above plus: scope equals BO's own authenticated scope (never read from the package); BO's **capability registry** supports the action type/version; execution window open; and the **authoritative status** answer: it must be present, well-formed, about the **exact** package (id, version, digest), no older than the caller-supplied `statusMaxAgeMs` (no default is invented), not from the future; lifecycle `REVOKED` / `SUPERSEDED` / `EXPIRED` / `CONSUMED` refuse; `ISSUED` with a newer version refuses. **Unable to verify ⇒ fail closed** (`STATUS_UNVERIFIED`). `valid` here *is* the derived EXECUTABLE result; it is never persisted. A closed window is reported as `PACKAGE_EXPIRED` because the window end is always an expiry bound.

**Error taxonomy (`AapErrorCode`, 44 codes):** structure (`NOT_AN_OBJECT`, `MISSING_FIELD`, `UNKNOWN_FIELD`, `INVALID_TYPE`, `INVALID_FORMAT`, `INVALID_VALUE`, `FORBIDDEN_VALUE`); versioning (`UNSUPPORTED_CONTRACT_VERSION`, `UNSUPPORTED_CANONICAL_VERSION`, `UNSUPPORTED_DIGEST_ALGORITHM`, `UNSUPPORTED_CONSUMPTION_MODE`); applicability (`REQUIRED_FIELD_UNAVAILABLE`, `NOT_APPLICABLE_NOT_PERMITTED`); action type (`ACTION_TYPE_UNKNOWN`, `ACTION_TARGET_KIND_INVALID`, `ACTION_PARAMETER_UNKNOWN|MISSING|INVALID`, `ACTION_TYPE_UNSUPPORTED_BY_EXECUTOR`); modification (`MODIFICATION_REQUIRED`, `MODIFICATION_NOT_ALLOWED`, `MODIFICATION_LINEAGE_INCONSISTENT`, `MODIFICATION_EVALUATION_MISSING|INVALID`); authorization (`OWNER_INVALID`, `PROVENANCE_INVALID`, `AUTOMATION_LEVEL_NOT_PERMITTED`, `RISK_INCONSISTENT`); validity (`VALIDITY_INCONSISTENT`, `WINDOW_INVALID`, `EXPIRY_MISMATCH`, `TIMELINE_INCONSISTENT`, `ISSUED_IN_FUTURE`, `PACKAGE_EXPIRED`, `EXECUTION_WINDOW_NOT_OPEN`); integrity (`DIGEST_MALFORMED`, `DIGEST_MISMATCH`); pre-execution (`CONTEXT_INVALID`, `SCOPE_MISMATCH`, `STATUS_UNVERIFIED`, `PACKAGE_REVOKED`, `PACKAGE_SUPERSEDED`, `PACKAGE_ALREADY_CONSUMED`, `PACKAGE_NOT_CURRENT_VERSION`). Errors are `{code, path, message}`; structural errors inside the owner / authorization / trace blocks are reported under `OWNER_INVALID` / `PROVENANCE_INVALID`.

**Versioning (forward-compatible):** `aap/<major>`. Any change to a field's shape or meaning is a new version; a consumer supports an explicit set of versions and rejects the rest. `aap-canonical/<n>` is versioned independently and is part of the digest's domain separation.

## 4. Canonicalization and digest specification
**`aap-canonical/1`** (modelled on RFC 8785, restricted domain):
- JSON values only; `undefined`, functions, symbols, bigint, NaN, ±Infinity, non-plain objects, cycles, sparse arrays, lone surrogates and integers beyond the safe range are **rejected**, never dropped or coerced (money and large quantities are decimal strings).
- Objects: keys sorted by UTF-16 code unit order, no whitespace, `{"k":v,…}`; arrays keep order; numbers use the ECMAScript shortest round-trip form with `-0` as `0`; strings use JSON escaping, UTF-8 on the wire.
- Applicability state is encoded structurally, so a `VALUE`↔`NOT_APPLICABLE` change changes the digest.

**Digest:** `sha256:` + hex of SHA-256 over UTF-8 of `"aap-canonical/1\n" + canonical(package without integrity)` (the version prefix is domain separation). It covers **every field except the `integrity` block** — everything that can change what is executed, for whom, under which authorization and within which validity/constraints. A test mutates **every leaf** of a sealed package and asserts the digest changes. **The digest is tamper evidence only**: it does not establish authorization and does not replace RBAC, approval provenance or BO validation (it proves a package was not altered after sealing, not that it was legitimately issued — that is the issuer's and the authoritative status contract's job).

## 5. Action-vocabulary interface (R-1)
`ActionTypeContract { code, schemaVersion, targetKinds[], parameters{name→ParameterSpec}, governanceImpact{param→dimensions[]}, applicability{field→REQUIRED|NOT_APPLICABLE_ALLOWED} }`. `ParameterSpec` types: `string` (max length), `integer`, `number`, `decimal_string`, `boolean`, `enum`, `identifier` (no free-form regex: avoids ReDoS). `ActionTypeRegistry.resolve(code, schemaVersion)` is ABA-governed; `ActionCapabilityRegistry.supports(code, schemaVersion)` is the BO-owned capability registry. `InMemoryActionTypeRegistry` and `validateActionTypeContract` ship for tests and as the loading target for a later persisted vocabulary. **No concrete action types ship**: the vocabulary and its persistence belong to a later block.

## 6. Tests
`packages/handoff-contracts`: **365 passed** (222 existing + **143 new**): SHA-256 5; canonical + digest 29; validator 77; pre-execution + action-type 28; architecture guard 4. They cover every item in the authorisation: deterministic canonicalization; field-order independence; semantic / lineage / scope / parameter / applicability-state changes change the digest; every leaf is digest-covered; required `UNAVAILABLE` rejected (13 paths); governed `NOT_APPLICABLE` accepted where allowed and refused where required; unsupported contract/canonical/algorithm versions; unknown action schema/version; expired and future-issued packages; malformed owner/provenance; modification-lineage consistency; and that a caller cannot substitute fields after the digest is generated.
**Architecture guard (R-8):** `sealAuthorizedActionPackage` may be referenced only inside the contract package (the allow-list for the issuer is empty until it exists); Business Operations code may not create a package; the contract imports nothing outside itself.
**Mutation proofs (all caught):** digest ignoring a block (4 failed); unavailable scan disabled (14); delta equality unenforced (1); status digest echo unchecked (2); expiry uses the latest bound (36); unsupported version accepted (1); keys unsorted (3); seal skipping validation (14); stale status accepted (1); unknown impact treated as none (2); unknown fields tolerated (3); lone surrogate / `-0` handling removed (2); CONSUMED accepted (1); a BO file referencing the seal function (2 architecture failures).

## 7. CI change (R-11)
`.github/workflows/ci.yml` `validate` test step now also runs `@infinicus/event-contracts` and `@infinicus/handoff-contracts` (neither was gated before). No other workflow changed.

## 8. Judgements made in this block (flagged for owner review)
1. Permitted automation levels are 2 and 3; 0, 1 and 4 are refused.
2. A package with no applicable validity bound may exist (`expiresAt` governed `NOT_APPLICABLE`).
3. `risk.basis` records `UNCLASSIFIED_FAIL_CLOSED_HIGH` so the fail-closed default is explicit rather than fabricated as a persisted class.
4. `permissionUsed` is a required plain field: a decision whose audit lacks it cannot be packaged.
5. Owner identity requires both the user id and the tenancy membership id.
6. `statusMaxAgeMs` has no default; the caller must state how stale an authoritative status may be.
7. A pure SHA-256 is included instead of a `node:crypto` dependency, to keep the contract package dependency-free (verified against NIST vectors and `node:crypto`).

## 9. Unresolved sources the persistence/issuer block (Block 3) must supply
- **Structured authorized-action capture:** original proposed set (or reference), structured modification delta + reason, complete final effective set (`approval_decision_modifications` is text-only and unwritten; `approveWithModifications` takes no input).
- **Action vocabulary and target kinds** persisted and ABA-governed; BO capability registry.
- **Accountable-owner assignment** persistence (R-2): owner identity reference + ABA assignment provenance, due date, escalation policy.
- **Automation-level policy** source (R-3): governed ABA policy + versioned reference.
- **Execution window, preconditions, rollback, budget, monitoring**: tables exist but are never populated; they need authoring paths and an applicability policy per action type.
- **Simulation run reference** on the review version (D-6: value or governed `NOT_APPLICABLE`).
- **Authority at decision time:** assignment version and the provenance scope id linked to the decision; risk tiers and basis at decision time.
- **Package persistence:** header, append-only versions, append-only lifecycle (ISSUED / REVOKED / SUPERSEDED / EXPIRED / CONSUMED), hard-invariant DB guard, RLS.
- **Authoritative status contract** (ABA-owned pull) and the BO **intake/consumption receipt** (canonical CONSUMED truth, R-5).
- **The issuer** (single component), `ACTION_AUTHORIZED` contract registration and outbox/ledger emission (not before explicitly authorised).

## 10. Migration assessment for the persistence block
**Required, not created here.** Expected: (1) structured authorized-action capture (parameters original/delta/final, owner assignment, action type/target, execution boundaries); (2) package header + versions + lifecycle in `approved_business_action`; (3) BO intake/consumption receipt in `business_operations` (names must not trip the BO isolation guard); (4) possibly simulation-reference and monitoring linkage. Numbering follows `MIGRATION-ALLOCATION-POLICY.md` (next free number **0176**; inspect `main` and open migration-bearing PRs and record the owner first). All would join the controlled deployment review (live Supabase is at **0169**; **0170-0175 are unapplied**; no deployment is authorised). This block adds **no** migration.

## 11. Standing prohibitions (unchanged)
No ABA→BO wiring (P0-6, last, flagged off); no override; no owner backfill; no locked-spec edits; no live migration apply; no scheduler; none of P0-1..P0-4 weakened.
