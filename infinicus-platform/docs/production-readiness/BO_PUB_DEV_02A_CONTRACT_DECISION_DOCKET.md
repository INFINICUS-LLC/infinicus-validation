# BO-PUB-DEV-02A — Contract finalization decision docket

Status: REVIEW PROPOSAL — NO CONTRACT ACTIVATION
Baseline: main 32dba02681bb1d8386a91961c233ecc29cb5e7a4 (2026-11-01)
Source of truth: docs/bo-record-publication-evidence.md and docs/bi-08-warehouse-load-validation.md.
This document records candidate decisions and blocking questions only. None is an owner approval.

## Inherited, established boundaries

- BO owns inventory movements and the read-only extractor; BI must not query BO operational tables directly.
- bo_publication_packages is a header, not the record payload.
- BO evidence contract remains PROPOSED_NOT_ACTIVE (0.1.0-proposed).
- BI-08 load preparation validates without writing; authentic record-level publication is not yet approved.
- Every record carries tenant/workspace/business; total ordering by occurredAt and movementId; excludes notes, performed_by and storage created_at.
- A cost without independently established currency must never be silently assigned a currency.
- Append-only, forced RLS, scoped foreign keys, verified record conservation and digest validation are required for any future storage implementation.

## Decisions awaiting explicit owner approval

| ID | Choice to make | Recommended proposal (NOT APPROVED) | Reason / release gate |
|---|---|---|---|
| D1 | Contract identity, field names and canonicalization | Retain proposed BO-specific names and bo-canonical-json-v1 subject to golden-vector verification | Must become a versioned immutable wire contract before migration |
| D2 | Pre-0183 cost without currency | Refuse affected period, never drop monetary information or invent currency | Preserves financial integrity; document remediation separately |
| D3 | Evidence granularity and header lifecycle | One immutable artifact per publication header and declared half-open period; require persisted verified evidence before ready-to-dispatched transition | Prevents header/data mismatch; needs BO lifecycle audit |
| D4 | Publishing authority, permission and audit trail | Use BO-owned service boundary, existing approved role/permission if compatible; require audit event; do not invent a permission without owner decision | Fail closed on absent authority; separate authorization design |
| D5 | Domain coverage | Inventory movements only in v1; other domains have separate schemas and sign-off | No universal publication contract |
| D6 | BI-08 decimal / reader | Introduce exact-decimal-as-text field validation in a separately authorized BI block; BI reads only verified BO evidence via a dedicated scoped reader | No lossy JSON number conversion; no direct BO operational reads |

## Mandatory technical reconciliation before approving D1 or migration

**Digest preimage consistency — BLOCKER TO SPEC FREEZE:** The prose describes SHA-256 of canonical JSON excluding digest/evidenceId/provenance, while the proposed SQL check hashes `'bo-evidence-body:' || canonical_body`. Verify the real producer/verifier implementation and freeze a single exact byte-level preimage, UTF-8 encoding, prefix/domain separation, normalization, and golden test vectors. Do not assume these two descriptions match.

**Evidence completeness — BLOCKER TO STORAGE:** Proposed records table stores `record jsonb`, while the header stores `canonical_body text`. Specify a transactionally enforced comparison of ordered records against the canonical body and verified count/positions, including insert completion and rejection of partial commits; a digest check over the body alone does not prove stored rows match it.

**Idempotency and authority — BLOCKER TO STORAGE:** Reconcile deterministic `evidenceId` with proposed UUID primary key, unique digest, package relation, overlap/period identity, a replay after changed source data, and one evidence object per publication header. Define who can create, finalize or read evidence and what publication state permits this.

**Contract lifecycle — BLOCKER TO ACTIVATION:** Define whether historical records from before append-only enforcement or currency migration are allowed, what snapshot/read consistency proves an extracted period, and how retention/erasure can coexist with append-only storage.

**BI-08 exact decimal — BLOCKER TO INGESTION:** Define a strict precision/scale and format contract compatible with numeric(18,4), refuse rounding and float coercion, and test count/ordering/lineage end to end.

## Next-block requirements (none authorized)

After D1–D6 owner sign-off and technical reconciliation, a distinct BO-PUB-DEV-02B implementation block may propose migration, RLS, append-only triggers, transactional evidence conservation, permissions, and standalone tests. BI-08 ingestion stays disabled until separately approved.

## Evidence and stopping rule

This is a docs-only decision docket; no source code, migration, route, API, permissions, database, deployment or production state may be changed by this block. Do not relabel proposed contracts as approved. Do not automatically advance to BO-PUB-DEV-02B.
