# BO-PUB-DEV-02A-R1 — T1 source-level digest reconciliation

**Status:** SOURCE FORMULA VERIFIED; CROSS-IMPLEMENTATION PARITY AND GOLDEN VECTORS NOT EXECUTED.
**Scope:** docs-only verification addendum, no publication activation.

## Source inspected

`packages/business-operations-runtime/src/publication/record-evidence/inventoryMovementEvidence.ts` on main `32dba02681bb1d8386a91961c233ecc29cb5e7a4`.

The producer canonicalizes an object recursively by sorting every object’s keys with JavaScript `Object.keys(...).sort()`, retaining array order, and serializing primitives with `JSON.stringify`. The specific digest body contains exactly `contract, recordSchemaVersion, scope, source, ordering, recordCount, records`. `digest`, `evidenceId` and `provenance` are excluded.

Actual formula:
```text
canonicalBody = canonicalJson({contract, recordSchemaVersion, scope, source, ordering, recordCount, records})
digest = SHA256(UTF8("bo-evidence-body:" + canonicalBody))
evidenceId = SHA256(UTF8("bo-evidence-id:" + INVENTORY_MOVEMENT_EVIDENCE.contract + ":" + digest))
```

The migration sketch in `docs/bo-record-publication-evidence.md` proposes:
```sql
digest = encode(sha256(convert_to('bo-evidence-body:' || canonical_body, 'UTF8')), 'hex')
```
**Assessment:** the *digest prefix* matches the source formula. The original prose omits the prefix and should be clarified in the later frozen contract. This is not evidence of a mismatch in the actual implementation. The sketch does **not** independently prove that the proposed stored `canonical_body` equals the current producer’s `canonicalJson(body)`, or that separately stored `jsonb` rows are conserved.

## Precise T1 closure tests still required

1. Construct canonical valid artifacts with 0 and 1 record via the actual producer, not a reimplementation.
2. Capture the exact UTF-8 preimage bytes, digest and derived evidenceId as golden vectors, including non-ASCII permitted strings (if permitted by the evidence schema), microsecond timestamps and canonical numeric text.
3. Demonstrate recursive property-key permutation invariance and array record-order sensitivity, using the actual verifier and its scope/count/order rules.
4. With disposable PostgreSQL, pass the producer's exact canonicalBody text as a parameter and assert `encode(sha256(convert_to('bo-evidence-body:' || $1::text, 'UTF8')), 'hex') = $2`.
5. Verify explicit tampering of record, declared count, scope, period, digest, or evidenceId is rejected; distinguish verifier failures from DB digest-only coverage.
6. Freeze a canonicalization contract only after these test vectors have been reproduced by an independent implementation. Preserve the proposed status in the interim.

## Other technical gates

- **T2 (record conservation):** storing canonicalBody and separate ordered `jsonb` rows requires a real transactional equality/integrity check; body digest alone is insufficient.
- **T3 (identity/authority):** distinguish the content-addressed 64-character evidenceId from random database row UUID. Define one-per-header and divergent replay conflicts before storage.
- **T4 (source consistency):** snapshot extraction; fail-closed missing historical currency; retention/erasure assessment.
- **T5 (BI decimal reader):** exact decimal-text grammar and scoped evidence reader; never coerce via IEEE-754.

No tests, DB connections, migrations, permissions, production reads or CI runs were performed in preparing this source-level analysis. All technical gates remain OPEN pending executable proof.
