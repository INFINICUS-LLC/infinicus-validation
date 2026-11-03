# R4 CI-only FORCE RLS carry-forward

Date: 2026-11-02. Authorized scope: CI-only setup; no production migrations, merge, deployment, unrelated POS changes, or R5.

PR #419 was externally merged to the parent R4 branch at 7ab3b10a. Parent PR #418 was externally merged to main at c3863a6647a91ebd40d789ef9a82241bd9b1ef0d without the child changes. Inspection of that main tree confirms the two workflow setup steps and script are absent. This draft carries only the previously tested three CI files onto current main; it does not duplicate the other child-PR development changes.

The script targets the current GitHub PostgreSQL service container by ID, requires GitHub Actions/CI, a running postgres:16 service, and the expected database/admin. It transactionally enables header FORCE RLS and rejects owner-member/superuser/BYPASSRLS application roles. Policies, ownership, assertions, production migrations and runtime source are unchanged.

Evidence from b7cc7501196976c08085153fa60f4d16e103dbc7 (prior branch, not fresh evidence for this carry-forward commit):

- BUILD-32 run 41513863073 SUCCESS: BO runtime 1413 passed; API 11 passed / 1 skipped.
- Platform run 41513863072 FAILURE: BO runtime 1413 passed. Later POS tenderCapture.integration.test.ts failed the JPY/KWD currency case, expected HTTP201, received500; image job skipped. No claim that this POS failure is pre-existing or caused by this change. No POS correction is authorized here.
- Local synthetic PostgreSQL16 setup tests passed for Bash syntax, non-CI refusal, malformed ID refusal, enable, idempotence, BYPASSRLS refusal and rollback; disposable container removed.

Fresh CI on this draft is required. Overall R4 certification remains BLOCKED pending broader regression and independent acceptance/authority requirements. No production verification or activation is claimed.

Current Module: BO-PUB-DEV-02A-R4
Completed Blocks: Previously verified CI setup; main merge-gap diagnosis and carry-forward
Remaining Blocks: Fresh CI; separate POS-owner triage; independent R4 acceptance
Next Recommended Block: Review fresh CI and route the POS failure to its owner
Estimated Remaining Blocks: Undetermined
