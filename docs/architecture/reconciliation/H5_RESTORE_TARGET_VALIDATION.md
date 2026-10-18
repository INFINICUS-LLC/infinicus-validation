# Block H-5 — fail-closed restore target, protected role restoration, recovery-laptop checks

| Field | Value |
|---|---|
| Date | 2026-10-18 |
| Status | **Implemented in a draft PR; not merged.** No production access, no backup was fetched, downloaded or decrypted, no infrastructure was provisioned, no Phase R/W step was run. |
| Scope | `infinicus-platform/infrastructure/backups/restore-proof.sh`, its tests, `backups/README.md`, this note. |
| Builds on | Block H-4 findings C4 (no technical guard against pointing the restore at a production server) and S1–S7 (recommended safeguards). |
| Evidence labels | `REPO-VERIFIED` read from the repository; `LOCAL-TESTED` disposable PostgreSQL 16.15 with synthetic data only; `NOT VERIFIED` needs the owner. |

## 1. The problem (REPO-VERIFIED, H-4 finding C4)
Before this change `restore-proof.sh` only refused four scratch **database names**. It would have run against any server whose URL it was given, including production. It also applied `roles.sql` (from an unauthenticated backup) with `psql -f`, and a role statement `ALTER ROLE ... PASSWORD` in `pg_dumpall` output changes an existing role even when `CREATE ROLE` fails — so a mistaken target could have had production role passwords reset to the backup's hashes. `roles.sql` was also executed by a client that interprets backslash meta-commands (`\!` runs a shell command), so a tampered backup could have run commands on the recovery machine.

## 2. What the script now enforces (LOCAL-TESTED)
All checks happen **before** anything is fetched, decrypted or written. A refusal exits 2 and prints a reason that never contains a URL, password or file content.

| # | Rule |
|---|---|
| 1 | `RESTORE_ADMIN_URL` is a `postgresql://` URL with **no password**, one host, and only the parameters `sslmode`, `connect_timeout`, `application_name`, `host`, `port`. |
| 2 | The host (and any `host=` parameter) is loopback — `localhost`, `127.x.x.x`, `::1` — or a local socket directory. A missing host is refused (it would fall back to `PGHOST`). |
| 3 | `PGHOSTADDR`, `PGSERVICE`, `PGSERVICEFILE` must be unset. The check connection sets its own `PGOPTIONS`, so the caller's environment cannot spoof the marker. |
| 4 | The server reports `infinicus.restore_target = disposable` (set by whoever started it with `-c infinicus.restore_target=disposable`). Production never carries it unless someone sets it deliberately. |
| 5 | The connection is a superuser, on a primary (not in recovery), of the expected major version (`RESTORE_EXPECT_PG_MAJOR`, default 16), and the cluster has **no database named `infinicus`**. |
| 6 | `roles.sql` is checked line by line against what `pg_dumpall --roles-only` emits: `SET` of three known settings, `CREATE ROLE`, `ALTER ROLE ... WITH <attributes>`, `COMMENT ON ROLE`, `ALTER ROLE ... SET` for a short list of safe settings, `GRANT role TO role`, comments, and the matching `\restrict`/`\unrestrict` pair that PostgreSQL 16.15's `pg_dumpall` now emits. Anything else refuses the restore and prints only the count and the first line number. |
| 7 | Password hashes are removed from `ALTER ROLE` lines before `psql` runs. Afterwards no role (other than the connection role) may carry a password, and the connection must still be a superuser. |
| 8 | The temporary directory must be mode 700 and owned by the caller; shell tracing (`bash -x`, `BASH_XTRACEFD`) is refused; the decrypted dump and roles are deleted as soon as they are no longer needed; the directory is wiped (best-effort `shred`, then `rm`) on exit, `INT`, `TERM`, `HUP`. |

`restore-proof.sh --validate-target` runs rules 1–5 only and touches no backup, so the owner can check a recovery target before any backup exists.

## 3. Tests (LOCAL-TESTED, synthetic data only)
`packages/database/tests/offsite-backup.integration.test.ts` now starts its **own throwaway PostgreSQL cluster** (`initdb`/`pg_ctl`, loopback port, marked disposable) as the restore target; the source database stays on the shared test server. In CI a missing `initdb` is a hard failure, never a silent skip. Added tests cover: acceptance over TCP, `localhost` and a socket; refusal of a password, remote hosts, `host`/`hostaddr`/`options`/`service` overrides, missing and multiple hosts, non-postgres URLs and the three redirecting variables; refusal of an unreachable target, an unmarked server, a non-superuser, a wrong major version and a cluster holding a database named `infinicus`; proof that a refused target stops the run before any fetch and leaves no scratch database or temporary directory; eight hostile `roles.sql` forgeries (meta-command, `COPY ... PROGRAM`, `ALTER SYSTEM`, `DO`, `CREATE EXTENSION`, unsafe role setting, multi-line statement, a second statement on one line) plus a wrong or missing `\unrestrict` — none executes, and a marker file is never created; a mutation control (allowed role statements restore, a forged password is stripped, a role setting is applied); SIGTERM wipes the temporary directory; `bash -x` is refused.
The architecture test `offsiteBackup.architecture.test.ts` pins the new rules in the script text (validation runs before the temporary directory, the manifest fetch and the decrypt; only the sanitized roles file reaches `psql`; cleanup traps).
Mutation controls run once locally (each weakened check made the suite fail, then the script was restored byte for byte): password-in-URL check removed → 2 tests fail; disposable-marker check removed → 1 fails; roles allowlist removed → 1 fails; password stripping removed → 13 fail (the post-restore "no role carries a password" check blocks the restore, a second layer); `infinicus` database check removed → 2 fail; target validation call removed → the architecture test fails.

## 4. What this does **not** protect against
- **The archive itself.** `pg_restore` of an unauthenticated `db.dump` runs as a superuser on the target. A tampered archive could do anything on that server. Mitigation is the environment: a throwaway server with no secrets, no route to production, on an encrypted disk, destroyed afterwards. The manifest is unsigned, so record its SHA-256 out of band when a backup is made (H-4 safeguard S5).
- **A server that lies.** Someone who sets the marker on a production server defeats rule 4; rules 2 and 5 (loopback, no `infinicus` database) are the second line.
- **Publishing a Docker port wider than loopback.** Publish with `-p 127.0.0.1:PORT:5432`.
- **Disk encryption and secure deletion.** `shred` is best-effort on journaled or SSD storage.
- **Authenticity** of a backup, and **bucket permissions, Object Lock and key custody** — unchanged and still NOT VERIFIED (H-4).

## 5. Windows laptop as the recovery machine — read-only checks for the owner
The script is bash; on Windows it runs inside **WSL2** (Ubuntu), with Docker Desktop using the WSL2 backend for the throwaway server. A laptop is only acceptable if every line below is answered; unknown stays NOT VERIFIED. All commands are read-only.

PowerShell (Windows side):
```powershell
Get-ComputerInfo -Property OsName,OsVersion,CsTotalPhysicalMemory,CsNumberOfLogicalProcessors | Format-List
Get-PSDrive -PSProvider FileSystem | Select-Object Name,@{n='FreeGB';e={[math]::Round($_.Free/1GB,1)}},@{n='UsedGB';e={[math]::Round($_.Used/1GB,1)}}
manage-bde -status C:                      # Administrator shell; BitLocker "Protection On" and "Fully Encrypted" expected
wsl --status ; wsl -l -v                   # WSL2 and the distribution version
docker version --format '{{.Server.Version}}' ; docker info --format '{{.OperatingSystem}} {{.MemTotal}}'
docker ps -a --format '{{.Names}} {{.Image}} {{.Ports}}'      # no production-looking containers; nothing published on 0.0.0.0
Get-NetFirewallProfile | Select-Object Name,Enabled
Test-NetConnection 2.28.141.151 -Port 22 -InformationLevel Quiet   # the production host: a True here is a route to production to document, not block silently
```
Inside WSL2 (Ubuntu):
```bash
uname -a ; free -h ; df -h ~ ; nproc
gpg --version | head -1 ; psql --version ; pg_restore --version ; rclone version | head -1
gpg --list-secret-keys --with-colons | awk -F: '$1=="fpr"{print $10}'     # public fingerprints only; compare with the manifest recipient fingerprint
```
Requirements to answer: BitLocker (or equivalent) on; a single administrator; Docker/WSL data stored on the encrypted drive; at least 4 GB RAM free for Docker and 5 GB disk free (the database is about 60 MB); no shared folders mounted into WSL or the container; an antivirus/backup/sync client (OneDrive, Dropbox) must not sync the WSL or Docker data directories; the recovery read-only bucket credential stored only in the laptop's own `rclone` configuration; a written step to destroy the restore (below).

Throwaway server and target check (WSL2):
```bash
docker run --rm -d --name infinicus-restore-target -p 127.0.0.1:55432:5432 \
  -e POSTGRES_PASSWORD="$(openssl rand -hex 16)" postgres:16 -c infinicus.restore_target=disposable
# keep the password in a PGPASSFILE (mode 600), never in the URL:  localhost:55432:*:postgres:<password>
export PGPASSFILE=~/.pgpass-restore RESTORE_ADMIN_URL='postgresql://postgres@127.0.0.1:55432/postgres'
./infrastructure/backups/restore-proof.sh --validate-target       # expect RESTORE_TARGET=OK; nothing is fetched
```
Destruction after a rehearsal: `docker rm -f -v infinicus-restore-target`; delete the PGPASSFILE; remove any `--keep` leftovers; empty the temporary directory; for the key, nothing is deleted (the private key stays in its custody location).

## 6. Not done
Block H-5 did **not**: access any backup or production system, create or restore a backup, change a bucket or credential, import or create a key, install a timer, run Phase R or W, deploy, merge, or touch Cloudflare/DNS. The laptop was not inspected (no access from the build environment); every laptop requirement above is NOT VERIFIED until the owner runs the checks.
