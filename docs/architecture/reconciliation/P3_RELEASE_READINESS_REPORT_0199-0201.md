# Release readiness report — migrations 0199 → 0201 (P3 evidence consolidation)

| Field | Value |
|---|---|
| Date | 2026-10-17 |
| Status | **REPORT ONLY.** No migration, deployment, backup, restart or other production write was performed in preparing it. The evidence below was produced by the owner running read-only blocks A–F on `infinicus-prod-01` as `deploy`; Claude never had production access. |
| Verdict | **NOT READY for Phase R or Phase W.** Schema, data integrity, exposure and role evidence are good. Backup, restore proof, image provenance, rollback compatibility and the owner decisions of §6 are open. |
| Builds on | `PRODUCTION_RELEASE_SEQUENCE_0199-0201_DESIGN.md` (phases, acceptance criteria A1–A10), `PHASE_R_REHEARSAL_DESIGN_0199-0201.md`, `production-discovery/*`, `infrastructure/backups/README.md` |
| Evidence labels | `OWNER-RUN-OUTPUT` pasted tool output from the owner's session (checksums below identify the saved files, which are **not** in the repository); `REPO-VERIFIED`; `UNKNOWN` |

## 1. Evidence collected (all READ-ONLY, all on 2026-10-17)

Every session below was forced read-only (`default_transaction_read_only=on`), database `infinicus`, PostgreSQL 16.15, ledger head `0198_link_purchase_order_lines_to_inventory_items.sql` (198 rows).

| Block | What ran | Result | Saved file and sha256 |
|---|---|---|---|
| A | host, repo state, script checksums | `infinicus-prod-01`, user `deploy`; VM repo HEAD `130bf5aca118640f4861665c305be5fb4d0aa35a`, `origin/main` was `28d7eb6…` at fetch time | scripts: audit v2 `75c9d08d1abbe9d21d8cfc285596d7f8551067dd5575654b9a8b8982f76e456d`; evidence SQL `088ef7e7bb29278c63e6419365247ce9d60951957aab18bbcc6ea8b6f2038896`; discovery script `e8d947841258044ffd4c9d598f66b4bf728552d7e5b6fc1712d2bf0a7a53566a` (equal to `main` at the time) |
| B | identity | db `infinicus`, read-only `on`, head 0198, 198 ledger rows | — |
| C | audit v2 (OM scope integrity incl. child tables) | exit 0, `ERROR` 0, every C-check 0, no mismatching-row fingerprints, no composite FKs yet (K01/K03 show only the single-column FK and `UNIQUE (business_id, action_code)`), RLS enabled and forced on both key tables | `audit-v2-20261017T132310Z.txt` `38af153941470d0ead821871a7a8a9691f6af0c17e5b1ac18a7e8a4e6c824a2f` |
| D | evidence SQL E01–E07 | exit 0, `ERROR` 0, `TABLE_MISSING` 0; RLS `t/t` and one policy on all 46 OM tables; outbox 48 + 11 = 59 equals `events.outbox_events` | `evidence-20261017T132400Z.txt` `6ca55d22d5a734a1742392e1ab84f2148ef5b0c22ae6066015c1cb8ca910635e` |
| E | `production-readonly-discovery.sh` | `combined-sha256-16=7fd4c419d738de8a`, `fingerprint-verdict=MATCHES_REPOSITORY_0198_PG16`; roles/privileges as designed (see §2) | `discovery-20261017T132655Z.txt` `c0099aaf9c4f138d53023e086b913ba05c6e120019b54302ba54ba0df5ef190f` |
| F | image identity, test containers, ports, backup tooling | see §3 | `blockF-20261017T135600Z.txt` `37aa86c95447150a317a2ff3628095ac115a660d4c0f85003ae10ec96c2f85c7` (the pasted command had a typo on its last line; treat this checksum as recorded, not independently verified) |

Production OM population at the time: 3 observations, 3 monitored actions, 3 action versions, 3 status-history rows, 3 execution observations, 0 execution verifications, 0 scope mismatches anywhere. The three new migrations therefore have nothing to refuse on today.

## 2. Findings that are good

- **Schema identity.** Production equals the clean-PG16 reference for 0198 (`7fd4c419d738de8a`). The reference fingerprints for 0199, 0200 and 0201 exist in `production-discovery/` (REPO-VERIFIED), so criterion A5 can be evaluated after the release.
- **Data integrity.** Audit v2 is clean for every check, so migrations 0200 and 0201 will not refuse (their pre-flight counts would be 0).
- **Authority model.** `app_role` has no ledger privileges, owns no SECURITY DEFINER function, and has no role memberships; `admin_role` owns the schemas and the 120 SECURITY DEFINER functions. Governed functions and protected-table grants are as designed in 0196.
- **Exposure.** Only ports 22, 80 and 443 listen on the host; PostgreSQL is not published. The restore-test database and smoke-test API run on the isolated network `infinicus-restore-test-net` with no published ports.
- **Worker.** Not deployed (no worker container, zero event subscriptions), as the design assumes.
- **Backup directory permissions.** `~/infinicus-db-backups` is mode 700 and the dump is mode 600.

## 3. Gaps and blockers

| # | Gap | Evidence | Needed to close | Owner action |
|---|---|---|---|---|
| G1 | **No fresh, restore-proven backup.** The only dump is `infinicus-20261014T201406Z.dump` (4,128,924 bytes, sha256 `71101eb1544e35a4e07c85c68b84a1c0e805b66cdd4a752e2641b94873dde514`), three days old and local only. | Block F | A backup of the quiesced pre-migration state (W4) and `RESTORE_PROOF=PASS` against it | Authorise the backup step; provide drill machine |
| G2 | **No encryption key on the VM.** `gpg` public key count is 0; `backup-offsite.sh` encrypts to a public key present in the VM keyring. | Block F | Public key imported on the VM; private key only on the drill machine | Create/import the key pair (owner-held) |
| G3 | **Offsite sink untested.** `rclone listremotes` shows `offsite:`; whether it works is not established. The README states the S3 path has not been exercised against a real service. | Block F; `backups/README.md` | `backup-offsite.sh --check` (write-free), then a `--verify` backup | Authorise a read-only `--check` (optional Block G) |
| G4 | **No schedule and no freshness monitor.** No crontab, no backup timer; the `systemd/` units are repo templates only. | Block E/F | Decide whether to install the timer after the release | Separate authorisation |
| G5 | **Running API build is unidentified.** `INFINICUS_BUILD_SHA=unknown` in both `oci-api-1` and the smoke-test container; image `4fba8110ac9c` (created 2026-10-14T21:01Z) cannot be tied to a commit from the container. | Block F | Build the release image with `GIT_SHA` set and record the digest; record the current image id as the rollback identity (criterion A9) | Operator step in W2/W5 |
| G6 | **Rollback image compatibility with 0198 is UNKNOWN.** `oci-api:rollback-20261014` is image `ee6e44c5b7b2` created 2026-10-04 although the tag says 20261014. | Block F | Treat the image running *before* W5 as the rollback image (tag it at W2); do not rely on the existing tag | Operator step in W2 |
| G7 | **Expectations profile for head 0198 does not exist.** `production-pre-0171.profile` fails for 0198 by design. Production counts are live (59 pending outbox rows, 6 users, 16 tenants and businesses) and can change, so a profile committed today could be stale at backup time. | Block D/E | Generate the profile from evidence taken *after the quiesce, immediately before the backup* (§5), reviewed by the owner | Owner decision 6 |
| G8 | **VM capacity.** 1 CPU, 1.9 GB RAM, no swap, 17 GB free disk, 12.6 GB reclaimable build cache; the restore-test database was OOM-killed once (`oom=true`, 1 GB limit). | Block E/F | Run Phase R on a separate machine, not on production; build the image in advance, not inside the stop window | Owner decision 7 |
| G9 | **VM checkout is stale** (HEAD `130bf5a`, `main` has moved on) and contains untracked files (three `discovery-*.txt`, `.env.backup-before-preview-cors`). The `oci` compose project lists a second config file under `/home/deploy/infinicus-release-130bf5a/...`. | Block A/E | Record the exact `-f` pair used by the running project; fast-forward only, clean tree before W5 | Operator step in W5 |
| G10 | **Open from the design (unchanged):** P5 backup-tooling health, P6 rollback identity, release SHA, staging substitute, window and operators. | design §7 | see §6 | Owner decisions 1–5 |

## 4. Acceptance criteria status (design §6)

| # | Criterion | Status today | Basis |
|---|---|---|---|
| A1 | Production identity confirmed | **Evidence available for today** (host, database, compose project, containers); must be re-run in W0 | Blocks A, B, E |
| A2 | Pre-release audit v2 clean | **Met for today's state**; must be repeated in W1 and Phase R | Block C |
| A3 | Restore-proven off-VM backup of the pre-migration state | **Not met** | G1–G3 |
| A4 | Ledger head and constraints validated after migration | Not yet applicable | needs W6/W8 |
| A5 | Fingerprint equals reference for the new head | Reference exists (0201 = REPO-VERIFIED); not yet applicable | needs W8 |
| A6 | App role privileges unchanged, EXECUTE only via grant script | Baseline captured (Block E); not yet applicable | needs W7/W8 |
| A7 | Post-release audit clean, RLS unchanged | Baseline captured (Blocks C/D); not yet applicable | needs W8 |
| A8 | API reports released SHA, memberships route present | Not yet applicable | needs W9/W10 |
| A9 | Rollback image tagged and restorable; rollback rehearsed | **Not met** (G5, G6); rollback logic is LOCAL-TESTED only | design §2 |
| A10 | No change to Cloudflare/DNS/secrets/roles/worker/legacy | Baseline captured (variable names only, Block E) | W11 |

## 5. Addendum to the window runbook (proposed; not yet adopted)

These refine Phase W of the design; they change nothing until the owner adopts them.

1. **Profile at backup time.** After W3 (API stopped, so no application writes) and before the dump in W4, the operator runs, read-only: the evidence SQL (`production-discovery/p3-owner-01-evidence.sql`) and `production-readonly-discovery.sh`, saves both outputs, then runs on the drill machine (or the VM after a normal `git pull` of `main`):
   `infrastructure/backups/make-expectations-profile.sh --evidence <file> --discovery <file> --out <new-file>`.
   The generator refuses on any error, wrong identity, wrong head or wrong verdict, and never overwrites. The owner reviews the generated file (counts must match what they see) and passes it to the restore proof with `RESTORE_EXPECTATIONS=<file>`. The same file is committed afterwards through a normal reviewed PR; it is not hand-edited.
2. **Write-free backup check first.** `backup-offsite.sh --check` runs before the first real backup, as the README requires, with the key (G2) and sink (G3) in place.
3. **Rollback identity.** At W2, record `docker compose -p oci images` and tag the currently running API image id as the rollback image, regardless of the existing `oci-api:rollback-20261014` tag.
4. **Compose file pair.** Record the running project's config files (Block E shows two) and use the identical pair for build, up, and rollback.
5. **Image built in advance** with `GIT_SHA=<SHA>` (build cache can be pruned only with separate authorisation) so that the stop window is W3–W9 only.
6. **No VM reboot** during the programme without telling the release owner; a kernel restart is pending.

## 6. Owner decisions required before Phase R / Phase W

1. Release SHA. `main` now carries 0199, 0200, 0201, the 0199 comment fix, the audit v2, reference fingerprints, the profile generator and the authentication-test timeout hardening; the decision is which `main` SHA is released, after CI is green on it.
2. Accept rehearsal on a restored production backup as the staging substitute (`deploy.sh` requires a prior staging deployment that does not exist).
3. One window for 0199–0201 versus several (recommendation in the design: one).
4. Window length, quiesce policy, time and named operators.
5. Who runs audit v2, and the backup and restore-proof roles (drill machine, key custody).
6. Adopt, amend or reject the §5 addendum, in particular generating the profile at backup time.
7. Where Phase R runs (not the production VM; see G8).
8. Whether to import the gpg public key and exercise `backup-offsite.sh --check` now (Block G), and whether to install the backup timer.

## 7. Housekeeping findings (no action taken; for the owner)

- `.env.backup-before-preview-cors` is mode 664 and untracked inside the repository checkout; check variable **names** only, then restrict it (`chmod 600`) or move it out of the checkout. Check `.env` itself the same way. Nothing was changed.
- `infinicus-restore-test-db` and `infinicus-api-smoke-test` run on the production VM (the former was OOM-killed once). They consume memory the release window needs; stopping or removing them is the owner's decision.
- Three untracked `discovery-*.txt` files in the VM checkout.
- The API image has no `wget`, so the discovery script's in-container health probes fail (the container's own health check reports healthy). The discovery script may be improved separately.
- `ufw` state and root crontab are not visible without sudo; a kernel restart is pending.

## 8. Not done, and not authorised by this report

No migration, deploy, merge, backup, restore, key creation, cleanup, `chmod`, container stop, reboot, Cloudflare/DNS/secret/role/grant change, or Phase R/W start. Each requires its own explicit authorisation from the owner.
