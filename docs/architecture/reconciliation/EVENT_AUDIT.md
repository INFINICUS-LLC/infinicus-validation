# EVENT_AUDIT — BUILD-ARCH-RECON-01, Phase 5

**Status:** COMPLETE for the baseline and for a **read-only review of PR #22 (BUILD-33)**. Nothing in PR #22 was modified, approved, merged or normalised; it was read through git objects without a checkout. PR #22 is **provisional input only**.
**Authority applied:** Master Manifest v1.0 §9 (event rules), §10–11 (ownership, no direct mutation); D6 authorisation of 2026-10-07.
**Baseline:** `main` at `ad6440c`. **Reviewed, not baseline:** PR #22 head `301fea4` (draft, 66 commits, base `0f3efef`, `mergeable_state: clean`).

---

## 1. Manifest event requirements (§9)

Every meaningful cross-domain state change should be an explicit event preserving `event_id, event_type, business_id, timestamp, schema_version, source, correlation_id, causation_id, payload`; historical records must not be silently rewritten. Spec §10 adds: flag missing idempotency, missing tenant/business ids, mutable historical events, ambiguous ownership.

## 2. Baseline findings (`main`) — unchanged from D4 §4.1

| ID | Finding | Class |
|---|---|---|
| E-01 | Outbox rows are updated through status changes; no append-only/immutability trigger on `events.*` (the only trigger on those tables is `updated_at` on `event_subscriptions`). | incomplete implementation |
| E-02 | `PlatformEvent` and `events.outbox_events` have no `source` field; `event_version` plays the schema-version role; `business_id` is nullable in the outbox. | incomplete implementation |
| E-03 | No dedupe key on the outbox; inbox has `UNIQUE (event_id, consumer_name)`. | incomplete implementation |
| E-04 | Producers are per-layer SQL trigger functions (`emit_*`, 11 migration files); no application consumers of the outbox found; cross-layer handoffs do not travel on events. | incomplete implementation |
| E-05 | Manifest example events (`ACTION_AUTHORIZED`, `ACTION_EXECUTED`, `OUTCOME_VERIFIED`, `CALIBRATION_PROPOSED`, `MODEL_VERSION_ACTIVATED`) are not defined; consistent with the missing contracts C-02/C-03. | incomplete implementation |

## 3. PR #22 (BUILD-33) — read-only review

### 3.1 What it implements, and how that maps to the manifest

| Manifest / BUILD-33 requirement | In PR #22 | Verdict |
|---|---|---|
| Canonical envelope with ids, tenant/workspace, nullable business, source domain/service, aggregate, correlation, causation, actor, idempotency key, payload, provenance, schema name/version, sensitivity, occurred/recorded | `events.business_event_ledger` columns cover all of these; checks on `event_type` format, `source_domain` ∈ the 8 platform domains, `sensitivity`, actor pair, non-blank idempotency | **Meets** the manifest field list (adds `source_domain`/`source_service`, closing E-02) |
| Provenance classes `ACTUAL, ASSUMPTION_BASED, BENCHMARK_BASED, ESTIMATED, FORECAST, SIMULATION` (Manifest §15) | `evidence_class` CHECK with exactly these six; `provenance->>'evidenceClass' = evidence_class` enforced; legacy adapter requires an explicit profile `evidenceClass` — **no silent default to ACTUAL found** | **Meets** |
| Append-only | `BEFORE UPDATE OR DELETE` row trigger raises; delivery status kept outside the ledger | **Meets** for UPDATE/DELETE (see A-1) |
| Tenant/workspace isolation | `ENABLE` + `FORCE ROW LEVEL SECURITY`, policy with `USING` and `WITH CHECK` on `app.tenant_id`/`app.workspace_id`; unset context yields NULL, so it fails closed | **Meets** |
| Idempotency | unique index on `(tenant, workspace, source_domain, source_service, idempotency_key)` where key is not null; repository returns the existing record only when the logical event is identical | **Meets** (nullable by design; stable keys required where semantics allow) |
| Ledger is not the source of business truth (Manifest §10) | spec §5 states it; table holds event evidence only | **Meets** |
| Outbox → ledger → consumers | spec §11; legacy outbox compatibility adapter | design matches |
| Replay must not bypass ABA (Manifest §11) | `ReplayAuthorization`: approver and reason required, mode must be `DELIVERY_ONLY`, and events matching action/approval/execution/refund/payment/payout/transfer/purchase_order require an `approvalActionId` (an ABA reference) | **Meets** the no-bypass rule; see A-3 |
| Tenant/workspace/global scope (spec §17) | `TENANT_WORKSPACE / TENANT_GLOBAL / PLATFORM_GLOBAL` scope types designed; **0172 is under "ARCHITECTURE COMPATIBILITY HOLD" per spec §18, not merge-ready** | by design incomplete |

**Overall:** the BUILD-33 design is **consistent with the Master Manifest**. No specification conflict was found, no direct cross-layer mutation, and no authorization bypass. It would close baseline findings E-01, E-02 and (for ledger writes) E-03 once merged; E-04/E-05 remain until producers and consumers are wired.

### 3.2 Pre-merge corrections required (recorded, not made)

| ID | Item | Why | Class |
|---|---|---|---|
| **PM-1** | **Renumber PR #22's migrations.** It adds `0171_create_business_event_ledger.sql` and `0172_harden_eventing_scope.sql`; PR #14 holds **0171** (authorised D1 = a). PR #22 must take the next free numbers **after** PR #14's (that is `0172` and `0173`, or later if more land first) so numbers stay unique and contiguous. `main`'s `0001–0170` stay untouched. | Migration policy + the Fix 2 guard (`platform/tests/01-file-existence.test.mjs`) | pre-merge correction |
| **PM-2** | **BUILD-33 specification §18 names the numbers `0171` and `0172`.** Renumbering therefore needs a recorded version note on the BUILD-33 specification (it is a build specification, level 5 in the authority hierarchy, not a locked layer specification). I did not edit it. | Spec text must match the migration filenames | specification note needed (owner decision) |
| **PM-3** | **The 0172 migration is on the spec's own compatibility hold** and, as drafted, would not be merge-ready regardless of numbering. | Spec §18 | existing hold |
| **PM-4** | PR #22's base is `0f3efef` (the BUILD-32 merge). It predates `main`'s `0170_add_approved_action_source_recommendation.sql` and the reconciliation documents, so it will need `main` merged into it, and a lockfile regeneration with pnpm, before validation can be trusted. | The authorised rule that earlier green CI is not sufficient after the base changes | pre-merge correction |

### 3.3 Advisory observations for the PR #22 author (non-blocking, not applied)

| ID | Observation |
|---|---|
| A-1 | The append-only trigger is row-level for `UPDATE`/`DELETE`; `TRUNCATE` is not intercepted. The application role has no `TRUNCATE` grant (`grant-app-role.sh` grants `SELECT, INSERT, UPDATE, DELETE`), so exposure is limited to privileged roles; a statement-level `TRUNCATE` trigger would close it. |
| A-2 | `grant-app-role.sh` grants `UPDATE`/`DELETE` on all tables in the schema, including this ledger, so protection relies solely on the trigger. Spec §10 asks to "prevent application-role mutation"; a `REVOKE UPDATE, DELETE` on the ledger (outside migrations, in the grant script) would add defence in depth. |
| A-3 | The replay action-event rule is a name-pattern match (`action|approval|execution|…`). Event types outside that vocabulary that still cause operational effects would not require an ABA reference; consider a registry flag instead of a regex. |

## 4. Event audit conclusion

| Spec item | Status |
|---|---|
| Identify cross-domain state changes that should be events | Done (baseline E-05; manifest examples) |
| Required fields | Baseline gaps E-02/E-03; PR #22 meets them |
| Flag missing idempotency / missing tenant-business ids / mutable history / ambiguous ownership | Baseline: E-01, E-02, E-03; PR #22 addresses them once merged |
| **CRITICAL conflict** | **None** |

**Phase 5 is complete.** The event findings stay *incomplete implementation* until PR #22 is renumbered, re-based, validated and merged by its owner's process.
