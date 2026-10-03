# BUILD-32 — VALIDATION STATUS

Status: IMPLEMENTATION COMPLETE / FINAL QUEUE TRANSITION BLOCKED
Branch: `build-32-business-operations-runtime`
Draft PR: #15
External blocker: #17 (pre-BUILD-32 legacy regression)

## 1. Formal preflight

Latest dedicated BUILD-32 CI preflight:

```json
{
  "ok": true,
  "buildId": "BUILD-32",
  "currentReadyBuild": "BUILD-32",
  "migrationCount": 170,
  "highestMigration": "0170",
  "migrationSetSha256": "9127a5ee14d1594e5cbe9d0dc2ecf1b2813eb204774c209436f7877a9e3d2507"
}
```

No BUILD-32 migration was added.

## 2. Dedicated BUILD-32 CI

Workflow: `BUILD-32 Operations Runtime CI`

Latest accepted run gates:

- dependency install: PASS
- formal BUILD-32 preflight: PASS
- lint runtime/API dependency graph: PASS
- typecheck runtime/API dependency graph: PASS
- build runtime/API dependency graph: PASS
- least-privilege PostgreSQL role setup: PASS
- migrations 0001–0170 from empty: PASS
- application grants: PASS
- BUILD-32 runtime tests: PASS
- BUILD-32 API integration tests: PASS

### Runtime tests

```text
IntakeMapperRegistry.test.ts              6 passed
BusinessIntakeService.integration.test.ts 10 passed
Runtime total                            16 passed
```

These run against live PostgreSQL where applicable.

### API tests

```text
businessOperations.integration.test.ts
11 passed
1 skipped (environment guard)
12 total
```

The API suite uses live PostgreSQL and the actual Fastify application.

## 3. Verified BUILD-32 behavior

The current BUILD-32 branch validates:

- locked eight-domain ownership;
- dedicated `@infinicus/business-operations-runtime`;
- governed server-side DA publication intake;
- DAL→BO contract validation;
- DA→BO minimum quality 0.80;
- scored-source reliability minimum 0.70;
- critical-limitation rejection;
- provenance requirement for non-empty packages;
- tenant/workspace/business scoping;
- durable success and failure delivery receipts;
- safe retry after rejection;
- replay idempotency after delivery;
- deterministic mapper registry;
- fail-closed unsupported record types;
- explicit operational command model;
- atomic inventory movement + balance + outbox event;
- negative-stock prevention;
- procurement lifecycle policy;
- atomic guarded purchase-order transitions;
- purchase-order approval outbox event in the same transaction;
- canonical supplier/item/warehouse/asset ownership checks;
- Inventory, Procurement, Supplier, Workforce, Asset service boundaries;
- OperationalEventService boundary;
- canonical BO→BI publication package/handoff reuse;
- BO publication idempotency conflict detection;
- dispatch replay protection;
- BO→BI acknowledgement handling;
- Operations read API;
- governed DA→Operations intake API;
- authentication, permission, active subscription and API idempotency guards.

## 4. Migration decision

BUILD-32 required no new migration.

Existing persistence was sufficient, including:

- Stage-2C `business_operations`;
- canonical `platform.*` master entities;
- `data_acquisition.publication_deliveries` for durable DA→BO receipt state;
- `business_operations.bo_publication_packages`;
- `business_operations.bo_handoff_records`;
- existing transactional outbox event functions.

Therefore migration `0171` remains unallocated.

## 5. Repository-wide regression blocker

The platform-wide CI is not green because of a verified pre-existing web build
failure outside BUILD-32:

```text
infinicus-platform/apps/web/app/businesses/page.tsx

Type error:
Property 'length' does not exist on type 'PagedBusinesses'.
```

The platform CI reaches the web production build after other packages compile,
then stops at that legacy defect.

This issue is tracked separately as GitHub issue #17 under the BUILD-01–31
legacy-closure workstream.

BUILD-32 code must not be altered to hide or bypass this failure.

## 6. Queue decision

Keep:

```text
BUILD-32.status = in_progress
currentReadyBuild = BUILD-32
```

until the repository-wide regression is green.

Do NOT:
- mark BUILD-32 completed;
- merge PR #15 into main;
- start BUILD-33;
- weaken platform-wide CI.

## 7. Finalization procedure after issue #17 is merged to main

1. sync current `main` into the BUILD-32 branch;
2. verify BUILD-32 branch is 0 commits behind main;
3. rerun formal BUILD-32 CI;
4. rerun platform-wide CI;
5. require both workflows green;
6. create BUILD-32 completion report;
7. update implementation-status BUILD-32 → completed;
8. set `currentReadyBuild` to null unless BUILD-33 has separately been frozen;
9. convert PR #15 from draft only after final review;
10. merge BUILD-32;
11. stop before BUILD-33.
