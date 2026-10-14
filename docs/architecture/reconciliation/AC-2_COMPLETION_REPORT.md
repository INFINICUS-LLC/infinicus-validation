# AC-2 First-Action Evidence Chain Completion — completion report

PROJECT: INFINICUS-LLC/infinicus-validation (platform in `infinicus-platform`)
BLOCK: AC-2 Blocks 1–13 (Block 13 = final verification)
ARCHITECTURE LAYER(S): DAL, BO, BI, BDT, SIM (governed NOT_APPLICABLE), ADI, ABA, OM; CL boundary checked, not changed
COMPLETION CRITERIA CLOSED: A, C, M moved PARTIAL -> COMPLETE (code-level); D re-confirmed COMPLETE (code-level). Pending the owner's acceptance. J, K, L untouched.

1. WHAT WAS DONE
Source records for `inventory_reorder_policy_update@1` now travel DAL -> BO -> BI/BDT -> ADI -> ABA -> BO -> OM in one proof with nothing seeded. Merged PRs: #118 (survey, canonical base risk `medium`), #120 (DAL ingestion), #121 (BO truth, once-only baseline route), #122 (BI evidence), #123 (BDT state), #124 (ADI input boundary), #125 (principal proof), #126 (failure proofs, ownership guards), #127 (criteria reassessment).

2. DAL INGESTION PATH
DAL manual intake (validation, provenance, publication package) -> BO intake mappers: new `inventory_item` v1 and `warehouse` v1 record types, `inventory_movement` v3 (natural keys, business instant). 15 records, 15 provenance records, no operational row written by DAL.

3. BO CANONICAL TRUTH
`OperationalCommandExecutor` stays the single writer (item, warehouse, keyed movement, balance). The first reorder policy is a BO-owned, once-only route (`bo:admin`, audited, 409 if already configured). Currency comes from the business-admin declaration. DAL never sets either (rulings D2, D3).

4. BI EVIDENCE
`InventoryBiEvidenceService`: three metric definitions/calculations in an insight package version carrying the BO facts digest; valid 24 hours. BO supplies facts only through a read-only port joined at the API composition root.

5. BDT CURRENT STATE
`InventoryItemTwinService`: derived snapshot of the item, built from BI evidence only, referencing the BI version; BO never reads it.

6. RISK GOVERNANCE
Base risk class `medium` comes from the canonical contract (`CANONICAL_BASE_RISK_CLASS`), not ADI. The producer uses it as a floor and package issuance refuses a persisted class below it. Rule set `inventory-reorder-policy/v1.1.0`; v1.0.0 stays immutable.

7. ADI INPUT BOUNDARY
Producer v1.2.0 refuses without current BI evidence and BDT state, and on any digest mismatch, expiry or superseded twin. The proposal cites the BI version, twin snapshot and BO facts; ABA capture requires those references and a structured proposal.

8. PRINCIPAL END-TO-END PROOF
`ac2-principal-first-action.e2e.test.ts` (4 tests, real PostgreSQL, production `buildApp`, real worker in-process): plain approval, modified approval, baseline changed before execution, and a self-scan that it seeds nothing. Result: balance 170/190 -> 175/190 `CONFIGURED`, `SUCCEEDED / APPLIED`, OM `EXECUTION_VERIFIED / OUTCOME_PENDING`, CL ineligible, no dead letters.

9. FAIL-CLOSED TESTS
`ac2-failure-proofs.integration.test.ts` (34): malformed (10) and missing-field (6) source data, stale or thin or missing evidence, wrong tenant or business, currency mismatch, BI/BDT mismatch, unsupported action, narrative-only recommendation, baseline changed (plain and modified). `ac2-chain-ownership.architecture.test.ts` (10) guards the lanes of DAL, BI, BDT, ADI, ABA, BO, OM and CL.

10. FILES / MIGRATIONS
No migration added (last is 0198). Changes: `handoff-contracts` canonical actions; `business-operations-runtime` (types, executor, mappers, baseline service, facts service); `workflow` (BI and BDT services, producer v1.2.0, issuance policy); `apps/api` (compositions, routes, schemas, 12 new test files); existing guards extended additively. Docs: AC-2 survey (sections 1–13), gap assessment, this report.

11. TESTS ACTUALLY RUN (head fdac5b6, freshly migrated private PostgreSQL 16)
- Full Turbo test, 39/39 tasks: database 3501 passed / 26 skipped; api 374 / 12; business-operations-runtime 612; handoff-contracts 549; workflow 274 / 1; event-worker 196; data-acquisition-runtime 94 / 1; authentication 54 / 1; configuration 46; event-contracts 38; onboarding 29 / 1; authorization 25 / 1; observability 18; web 14. Nothing failed.
- lint, typecheck, build: 75/75 tasks (existing warnings only). `workspace:validate`: passed.
- Browser-secret scan: passed (apps/web/src, apps/admin/src, 5 known secrets). Dependency scan: passed, 6 advisories all allowlisted (tinypool, dev/test only, issue #24, review by 2026-11-06).
- AC-2 per-file counts (from each block's run, all inside the totals above): DAL ingestion 6; BO truth 7 and writer guard 7; BI 9 + 6 guards; BDT 8 + 5 unit + 7 guards; ADI boundary 8 + 7 guards (+4 contract tests); principal E2E 4; failure proofs 34; ownership guards 10.

12. CI STATUS
Block 13 itself adds this report only; its draft PR's CI is unchecked at the time of writing. CI was green on #126 (all four checks); #127 was merged by the owner.

13. CRITERIA A/C/D/M REASSESSMENT
A COMPLETE code-level 85%; C COMPLETE code-level 80%; D COMPLETE code-level 88%; M COMPLETE code-level on a private database 80%. Detail and evidence: survey section 13. Awaiting owner acceptance.

14. ARCHITECTURE CONFLICTS
None open. C-1 (simulation) ruled: governed NOT_APPLICABLE stands. C-2 (producer) resolved by AC-1.

15. REMAINING GAP
- Nothing has run in production or staging; the worker is driven in-process, not deployed.
- Baseline policy and currency are not DAL-fed (rulings).
- Intake is manual; no connector or scheduled source.
- BI/BDT cover this one action; `layers/*` directories remain placeholders.
- Failure-proof reason codes and ownership guards were not mutation-tested.
- J (security/tenancy scope), K and L (parked #114) remain PARTIAL.

16. DELIBERATELY NOT DONE
No second action type, no BI/BDT generalization, no LLM, no arbitrary simulation, no CL change, no deploy, no live migration, no parked #114 work, no browser identity remediation, no speculative abstractions, no merge.

17. PR / BRANCH / COMMIT
Merged work: #118, #120–#127 (last merge commit fdac5b6). This report: branch `feat/ac2-block13-final`, draft PR (see the PR list).
