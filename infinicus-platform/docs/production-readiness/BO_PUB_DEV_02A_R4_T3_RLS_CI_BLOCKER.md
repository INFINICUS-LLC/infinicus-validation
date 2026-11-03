# BO-PUB-DEV-02A-R4 T3 — RLS certification blocker (2026-11-02)

## Evidence

At PR #418 head `cf209a9fa52ce5e014fab686c93650c0f167cbf3`, hosted CI failed:
- BUILD-32 Operations Runtime CI run `41429909210`
- INFINICUS Platform CI run `41429909297`

Both failures are the new integration assertion in `InventoryMovementEvidenceExtractor.integration.test.ts:104`:

```ts
expect(role.header_force_rls).toBe(true);
```

The earlier assertions in that test passed: the application role is not a superuser, has no BYPASSRLS, owns neither table, and both tables have RLS enabled; the inventory ledger has FORCE RLS. The publication header table `business_operations.bo_publication_packages` does **not** have FORCE RLS in the disposable CI database.

## Decision / scope

**BLOCKED — DO NOT CERTIFY T3.** Do not weaken the assertion, treat ordinary RLS as equivalent to FORCE RLS, or apply an unapproved production/shared migration.

The next owner-controlled remediation must reconcile the existing publication-header migration and its security policy. If FORCE RLS is required by the frozen architecture, propose the smallest compatible migration and its role/permission compatibility checks for separate approval; execute on disposable PostgreSQL only after approval. Preserve the existing header-only dispatch and record-evidence contract boundaries.

Publisher-specific authorization and durable record-level atomic publication remain independently unverified and must not be marked PASS.
