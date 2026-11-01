# BO record publication evidence (BO-PUB-DEV-01)

A BO-owned, deterministic, verifiable **evidence artifact** for one domain's records, plus a read-only extractor. **The contract is PROPOSED and NOT ACTIVE** (`status: PROPOSED_NOT_ACTIVE`, version `0.1.0-proposed`). Nothing publishes, persists, routes, emits an event or activates it. No migration, table, permission or API route was added; no operational table was modified.

## Why this block (discovery)

`bo_publication_packages` is a **header** (count + scalar `payload_reference`); the frozen BO→BI contract "carries the intake reference only" (BI-08-DEV-01 discovery). BI therefore has no authoritative records to ingest. Proposed pathway (this block builds only step 1 and the pure verifier of step 2):

```
BO authoritative records -> [1] BO deterministic evidence (this block, proposed)
  -> [2] BO-owned immutable evidence store   (needs migration: BO-PUB-DEV-02)
  -> [3] BI authorized evidence reader        (no direct private BO table access)
  -> [4] BI-08 validation + mapping (merged)  -> [5] warehouse rows + seal (merged) -> [6] BI-10 calculation (merged)
```

## Selected domain: inventory movements

| Criterion | Evidence |
|---|---|
| Published to BI by the frozen BO spec | `INFINICUS_BO_LOCKED_SPEC_v1.1.md` §32 lists "Inventory movement" |
| Stable, approved record schema | `business_operations.inventory_movements` (migration 0027, currency 0183); field rules enforced by BO's own command boundary (`OperationalCommandExecutor`, `unitCost.ts`, `uuidReference.ts`) |
| Immutable source | append-only in the database since migration 0184 (update/delete/truncate refused), so published rows cannot change behind the evidence |
| Tested BO persistence | existing BO integration suites write movements through the one movement writer; the new tests extract from exactly that persistence |
| Scale/shape | flat, scalar record; exact decimals; one natural ordering |

Rejected for now: sales/financial facts (exact-money and tax authority still gated), purchase/receipts (multi-table aggregates).

## What is reused vs proposed

**Reused (approved):** the 8 movement types, 6 reference types, canonical UUIDs, `numeric(18,4)` quantity/cost, cost strictly positive and ≥ 0.0001, explicit ISO-4217-style currency present exactly when a cost is, `occurred_at` as the business instant, `correlation_id`.
**Proposed (binding only on approval):** contract name `bo.inventory_movements.record_evidence`, version `0.1.0-proposed`, record schema `bo.inventory_movement.record.v0.1-proposed`, the property names below, canonicalization `bo-canonical-json-v1`, ordering, digest and evidence-id derivation.

## Record (14 properties, strict allow-list)

`tenantId, workspaceId, businessId` (carried on every record so foreign-scope records are detectable), `movementId, inventoryItemId, warehouseId, movementType, quantity, referenceType, referenceId, unitCost, unitCostCurrency, occurredAt, correlationId`.
Quantities and costs are **canonical decimal text** (no exponent, no trailing zeros, ≤14 integer / ≤4 fractional digits); `occurredAt` is UTC with microseconds (`…SS.ffffffZ`). **Never published, and refused if present:** `notes` (free text), `performed_by` (a person), `created_at` (storage time); any other property is also refused.

## Artifact, ordering and digest

`{ contract, recordSchemaVersion, scope, source{domain, periodStart, periodEnd, boPublicationPackageId|null}, ordering, recordCount, records[], digest{algorithm:sha256, canonicalization, value}, evidenceId, provenance{correlationId, owner} }`.
Records are ordered `occurredAt asc, movementId asc` (total). `digest.value` = SHA-256 of the canonical JSON of everything except `digest`, `evidenceId` and `provenance`; `evidenceId` is derived from the digest. The request correlation id is provenance only, so a replay of the same ledger gives the same digest and id. No clock is read.

## Verification (`verifyInventoryMovementEvidence`, used by the producer on its own output and by any later consumer)

Contract/version/status, record schema version, scope shape, period, every record (schema, scope equality, period membership, sensitive/unknown properties, cost-currency invariant), duplicates, ordering, count, digest and evidence id; optional caller expectations (scope, period, count, digest). Failures are a closed code vocabulary with positions and property names, **never a value**.

## Extractor (`InventoryMovementEvidenceExtractor`)

Read-only, BO-owned. SELECT-only, fixed column list, tenant/workspace/business pinned, half-open period, `LIMIT 100001` (an oversize period is refused whole, never truncated). When a header id is supplied it must agree with the ledger on target layer, published state, period and declared record count. Another party's business is indistinguishable from a missing one (`BUSINESS_NOT_FOUND`).
**Decision exposed:** a historical row with a cost and no currency (before 0183) is currency-**unproven**; the extractor refuses the period (`RECORD_COST_CURRENCY_UNPROVEN`) instead of inventing a currency or dropping the cost.

## Remaining publication-contract decisions (owner)

1. Approve, rename or reject the proposed contract/schema/property names and `bo-canonical-json-v1`.
2. Historical currency-unproven costs: refuse the period (current), publish cost as absent, or backfill by an owner-approved rule.
3. Whether evidence is per period, per header (`bo_publication_packages` row), or per cut-off sequence; who creates it and when a header may move `ready → dispatched` (requires evidence?).
4. Authority/permission and audit event for publishing evidence (none exists; none added).
5. Other domains (each needs its own schema; no universal contract is proposed).
6. BI-08 needs an exact-decimal field type (quantities/costs are text; BI-08 `number` is a JSON number and refuses them) and the BI reader contract.

## Proposed migration for BO-PUB-DEV-02 (NOT applied, for separate owner approval)

Ownership: Business Operations (schema `business_operations`); BI reads through an approved reader only.

```sql
-- scope key so evidence can reference a header with tenant/workspace/business (same pattern as 0223)
ALTER TABLE business_operations.bo_publication_packages
  ADD CONSTRAINT bo_publication_packages_scope_key UNIQUE (id, tenant_id, workspace_id, business_id);

CREATE TABLE business_operations.bo_publication_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenancy.tenants(id) ON DELETE RESTRICT,
  workspace_id uuid NOT NULL REFERENCES tenancy.workspaces(id) ON DELETE RESTRICT,
  business_id uuid NOT NULL REFERENCES platform.businesses(id) ON DELETE RESTRICT,
  publication_package_id uuid NOT NULL,
  contract_name text NOT NULL, contract_version text NOT NULL, record_schema_version text NOT NULL, domain text NOT NULL,
  period_start timestamptz NOT NULL, period_end timestamptz NOT NULL,
  record_count integer NOT NULL CHECK (record_count BETWEEN 0 AND 100000),
  digest_algorithm text NOT NULL CHECK (digest_algorithm = 'sha256'),
  digest char(64) NOT NULL CHECK (digest ~ '^[0-9a-f]{64}$'),
  evidence_id char(64) NOT NULL UNIQUE CHECK (evidence_id ~ '^[0-9a-f]{64}$'),
  canonical_body text NOT NULL,                       -- the exact canonical text that was hashed
  correlation_id uuid NOT NULL, created_by uuid REFERENCES identity.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),      -- database clock; never caller-supplied
  CONSTRAINT bo_publication_evidence_package_fk FOREIGN KEY (publication_package_id, tenant_id, workspace_id, business_id)
    REFERENCES business_operations.bo_publication_packages (id, tenant_id, workspace_id, business_id) ON DELETE RESTRICT,
  CONSTRAINT bo_publication_evidence_period CHECK (period_end > period_start),
  CONSTRAINT bo_publication_evidence_digest_matches CHECK (digest = encode(sha256(convert_to('bo-evidence-body:' || canonical_body, 'UTF8')), 'hex')),
  CONSTRAINT bo_publication_evidence_idempotent UNIQUE (business_id, domain, period_start, period_end, digest),
  CONSTRAINT bo_publication_evidence_scope_key UNIQUE (id, tenant_id, workspace_id, business_id));

CREATE TABLE business_operations.bo_publication_evidence_records (   -- ordered records, for bounded reads by a BI reader
  tenant_id uuid NOT NULL, workspace_id uuid NOT NULL, business_id uuid NOT NULL, evidence_row_id uuid NOT NULL,
  position integer NOT NULL CHECK (position >= 1), record jsonb NOT NULL,
  PRIMARY KEY (evidence_row_id, position),
  FOREIGN KEY (evidence_row_id, tenant_id, workspace_id, business_id) REFERENCES business_operations.bo_publication_evidence (id, tenant_id, workspace_id, business_id) ON DELETE RESTRICT);
```

Required controls: **forced RLS** on both tables with the tenant+workspace policy of migrations 0035/0223; **append-only** triggers (UPDATE, DELETE, TRUNCATE refused for every role, as 0184/0223) and no TRUNCATE privilege; a deferred check at commit that `record_count` equals the number of record rows and positions run `1..n`; sanitized errors; BI access only through a reader that selects from these tables by composite scope key (an architecture guard, as for 0223, forbids BI code reading any other BO table). Because PostgreSQL `jsonb` text differs from `bo-canonical-json-v1`, the DB verifies the digest of `canonical_body` (stored verbatim) and the application verifies that records equal the body. No event or permission is proposed here (decision 4).

## BI-08 integration readiness

The merged BI-08 load validation accepts the proposed record shape end to end (contract-shape test: identity, order, microsecond timestamps, strict unmapped-field refusal). Blocking gaps before BI-08-DEV-02: (a) the durable store and BI reader above, (b) an exact-decimal type for BI-08 fields, (c) the owner decisions listed.
