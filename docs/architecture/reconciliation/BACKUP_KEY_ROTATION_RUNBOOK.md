# Backup encryption key rotation — runbook (PLAN ONLY, owner-run; nothing in it has been executed)

| Field | Value |
|---|---|
| Date written | 2026-10-21 |
| Status | **Runbook, not executed.** Every command below is a template that must be read against the gpg build in use; none was run for this document. |
| Who runs it | The owner. Claude can read pasted output (IDs, fingerprints, log lines) and check it against the pass conditions; Claude never receives key files or passphrases. |
| Touches production | Yes, in steps R5 to R7 (the VM keyring and `/etc/infinicus/backup.env`). Everything else happens on the owner's machine. |
| Builds on | `OFFSITE_BACKUP_PLAN.md`, `infrastructure/backups/README.md`, `PHASE_W2_EXECUTION_RECORD_0202-0209.md` (restore proof PASS, 2026-10-21) |

## 1. Why rotate (facts observed on 2026-10-21)
- Backups are encrypted to the public key named by `BACKUP_GPG_RECIPIENT` in `/etc/infinicus/backup.env`, held in a public-only keyring on the VM. The current key: primary `D636066837F9141B` (sign/certify), encryption subkey `2379B8C95D86BB0B`, created 2026-10-13, no expiry.
- That key carries a **revocation signature dated 2026-10-18**. It is revoked in the owner's keyrings and in the offline file `infinicus-backup-key-OFFLINE.asc`; the VM's public copy is not revoked, so backups still work. Decryption with a revoked key works (the restore proof of 2026-10-21 passed with it), but the key must not be relied on indefinitely.
- The Gpg4win keyring on the owner's PC holds only the revoked primary, not the encryption subkey. **The offline `.asc` is currently the only way to open any backup.** There is one such copy known; the second copy and the custody of the passphrase are not documented.
- The revocation certificate (`revoke-D636066837F9141B.asc`) sits in the same folder as the offline key. That is how a revocation reached the keyring by accident. Keep them apart in the new scheme.
- Importing the offline `.asc` (which carries the revocation) into the VM keyring would make `gpg --encrypt` refuse the key and stop backups, and importing any secret key there makes `backup-offsite.sh --check` fail by design.

## 2. Rules for the whole procedure
1. No key file, passphrase, revocation certificate or secret key is ever pasted into chat, a ticket, an email, a repository or a log. Fingerprints and key IDs are not secret and may be shared.
2. The private key never goes to the VM. Only the public key goes there.
3. Old backups stay readable only with the old private key. **Keep the old offline key until the last backup encrypted to it has aged out of the bucket's retention** (retention period: not recorded in the repository; read the bucket lifecycle before deciding).
4. Do not remove the old public key from the VM, or change `BACKUP_GPG_RECIPIENT`, until the new key has passed the restore proof (R8) — except as stated in R6.
5. Always pass an explicit `--homedir`. The owner's PC has two gpg installations (Git Bash `~/.gnupg` and Gpg4win `%APPDATA%\gnupg`); using the wrong one caused confusion on 2026-10-21.
6. Stop at any red result and read it before continuing.

## 3. Steps
Shell: Git Bash on the owner's PC unless a step says VM. `GPG=/d/GnuPG/bin/gpg` is the Gpg4win binary seen on the PC; adjust if the install differs. Replace nothing by hand: the fingerprint is captured into a variable.

### R1 — Generate the new key in a dedicated home (PC)
```bash
GPG=/d/GnuPG/bin/gpg; NH=~/w2src/newkey-$(date +%Y%m); mkdir -p "$NH" && chmod 700 "$NH"
"$GPG" --homedir "$(cygpath -w "$NH")" --quick-generate-key "INFINICUS Backup encryption $(date +%Y-%m) (Production offsite backup encryption) <infinicusllc@gmail.com>" rsa4096 cert never
NEW=$("$GPG" --homedir "$(cygpath -w "$NH")" --with-colons --list-keys | awk -F: '$1=="fpr"{print $10; exit}'); echo "new fingerprint: $NEW"
"$GPG" --homedir "$(cygpath -w "$NH")" --quick-add-key "$NEW" rsa4096 encr never
"$GPG" --homedir "$(cygpath -w "$NH")" --list-secret-keys --keyid-format long
```
Choose a strong, unique passphrase at the pinentry window and store it in the password manager now. `never` (no expiry) matches the current key; an expired recipient key would stop backups. Pass: a `sec` line `[C]` and an `ssb` line `[E]`.

### R2 — Make the offline copies and the revocation certificate (PC)
```bash
"$GPG" --homedir "$(cygpath -w "$NH")" --armor --export "$NEW" > "$NH/infinicus-backup-public.asc"
"$GPG" --homedir "$(cygpath -w "$NH")" --armor --export-secret-keys "$NEW" > "$NH/infinicus-backup-key-OFFLINE.asc"
"$GPG" --homedir "$(cygpath -w "$NH")" --output "$NH/REVOKE-DO-NOT-STORE-WITH-KEY.asc" --gen-revoke "$NEW"
grep -c "BEGIN PGP PRIVATE KEY BLOCK" "$NH/infinicus-backup-public.asc"   # must print 0
grep -c "BEGIN PGP PRIVATE KEY BLOCK" "$NH/infinicus-backup-key-OFFLINE.asc"   # must print 1
```
Then: copy `infinicus-backup-key-OFFLINE.asc` to **two** separate offline media in two places; store `REVOKE-…asc` somewhere **different from both**; confirm the passphrase is in the password manager. Do not keep these files in `~/w2src` afterwards.

### R3 — Prove the new key works before anything depends on it (PC)
```bash
echo "rotation test" | "$GPG" --homedir "$(cygpath -w "$NH")" --batch --yes --trust-model always -r "$NEW" --encrypt -o "$NH/t.gpg" && "$GPG" --homedir "$(cygpath -w "$NH")" --decrypt "$NH/t.gpg"; rm -f "$NH/t.gpg"
```
Pass: it prints `rotation test` after the passphrase prompt.

### R4 — Send only the public key to the VM (PC)
```bash
scp "$NH/infinicus-backup-public.asc" deploy@2.28.141.151:/home/deploy/infinicus-backup-public-new.asc
echo "$NEW"
```
Write the fingerprint down; it is compared on the VM in R5.

### R5 — Add the public key to the VM's dedicated keyring (VM)
```bash
G=/etc/infinicus/gnupg; grep -c "PRIVATE KEY" ~/infinicus-backup-public-new.asc; GNUPGHOME=$G gpg --import ~/infinicus-backup-public-new.asc && GNUPGHOME=$G gpg --list-keys --fingerprint | grep -E "^pub|^ +[0-9A-F ]{40,}|revoked"
```
The first number must be `0`. Compare the new fingerprint with the one noted in R4, character by character. (If the keyring needs elevated rights, use `sudo -u` for the owner of `/etc/infinicus/gnupg`.) Do not import the old `.asc`.

### R6 — Point the backups at the new key (VM)
```bash
sudo cp -a /etc/infinicus/backup.env /etc/infinicus/backup.env.pre-rotation && sudo grep -n '^BACKUP_GPG_RECIPIENT=' /etc/infinicus/backup.env
```
Edit the single line `BACKUP_GPG_RECIPIENT=` to the new fingerprint (the file holds no secrets by design). Check with the same `grep`, then:
```bash
B=/home/deploy/w2clean/infinicus-release-ccadbf5/infinicus-platform/infrastructure/backups/backup-offsite.sh; BACKUP_ENV_FILE=/etc/infinicus/backup.env COMPOSE_DIR=/opt/infinicus/repo/infinicus-platform/infrastructure/deployment/oci bash $B --check
```
Pass: `CHECK PASSED`. **Rollback for R6:** `sudo cp -a /etc/infinicus/backup.env.pre-rotation /etc/infinicus/backup.env`.

### R7 — Take a backup with the new key (VM)
```bash
sudo systemctl start infinicus-backup.service; echo "exit=$?"; sudo journalctl -u infinicus-backup.service -n 6 --no-pager | cut -c1-180; bash /home/deploy/w2clean/infinicus-release-ccadbf5/infinicus-platform/infrastructure/backups/check-backup-freshness.sh
```
Pass: `BACKUP COMPLETE`, `exit=0`, freshness `OK … 0h ago`. Note the manifest key from the journal.

### R8 — Restore-prove that backup with the NEW key (PC, disposable container)
Repeat the procedure of 2026-10-21 (recorded in `PHASE_W2_EXECUTION_RECORD_0202-0209.md` section 5): copy the three encrypted objects of the R7 backup to the PC, mount the **new** offline key file read-only into a throwaway `postgres:16-bookworm` container, import it there, type the passphrase only at the container prompt, run `restore-proof.sh <manifest-key>` with `RESTORE_EXPECTATIONS=…/production-pre-0210.profile`. Pass: `RESTORE_PROOF=PASS`. A FAIL on a traffic-dependent count means the profile needs a reviewed correction, not a looser rule. Then delete the copied objects.

### R9 — Retire the old key (only after R8 PASS)
- VM: remove the old public key from the dedicated keyring (`GNUPGHOME=/etc/infinicus/gnupg gpg --batch --yes --delete-keys 6FA8FA1079F1EB18466E44C8D636066837F9141B`). Keep `backup.env.pre-rotation` until the next successful daily run.
- Keep the old offline key (`infinicus-backup-key-OFFLINE.asc`, the file carrying the 2026-10-18 revocation) until every backup encrypted to it has expired from retention. Mark that date in the record. Do not import its revocation certificate anywhere that the new key lives.
- Delete the generation folder `~/w2src/newkey-YYYYMM` from the PC once both offline copies are verified readable.

### R10 — Record it
Add a short record next to this document: date, new fingerprint, custody locations (names only), the R7 backup key, the R8 result, the date the old key may be destroyed, and the next rotation date.

## 4. What can go wrong, and the answer
| Situation | Answer |
|---|---|
| R5 import says the key is revoked or expired | Stop. The wrong file was copied; delete it from the VM and use the new public export only. |
| `--check` fails with a secret key in the keyring | A private key reached the VM. Remove it from the dedicated keyring immediately and treat that key as compromised (rotate again). |
| R7 backup fails | Restore `backup.env.pre-rotation`; the old key still works. Read the journal. |
| R8 cannot decrypt | The offline file or passphrase is wrong. Do not retire the old key. Fix custody first. |
| The old offline file is lost before retention ends | Old backups become unreadable. This is the main reason to keep two copies of every offline key. |

## 5. Not covered
Bucket credentials rotation, the S3 lifecycle/retention setting, hardware tokens, and a second recipient (two-key encryption) are separate decisions. A second recipient would remove the single-key risk and could be added in the same change as the rotation.

## 6. Lessons from the first run (2026-10-21), applied to the steps above
- **R1:** gpg 2.5.24 (Gpg4win) creates an automatic revocation certificate inside the key folder (`openpgp-revocs.d/<fingerprint>.rev`), next to the secret key. Move it out at once (R2) and store it apart from the key copies. gpg prints the pinentry passphrase window outside the terminal; test with R3 that the key really asks for its passphrase.
- **R2:** the check "private blocks = 0 in the public file, 1 in the offline file" caught nothing wrong, and is cheap; keep it.
- **R3 before R2** is a good order: prove the passphrase works before exporting anything.
- **R4/R5:** the connection from the owner's PC to the VM needed several attempts (timeouts and resets) before it held. Use `scp -o ConnectTimeout=20 -o ServerAliveInterval=10` inside a retry loop. After R5, compare the **full** fingerprints with `gpg --with-colons --fingerprint` (two `fpr` lines: primary and subkey); the formatted listing does not always print them.
- **R6:** `sed -i` on the single `BACKUP_GPG_RECIPIENT=` line preserved owner, group and mode; `diff` against `backup.env.pre-rotation` showed exactly one changed line.
- **R7:** the backup unit can be started twice by accident; a second backup is harmless.
- **R8 in a Docker container on the owner's PC:** Docker Desktop did not see the removable `E:` drive. A single-file mount from it became an **empty directory** inside the container, and `gpg --import` then processed 0 keys. Mount the key from a folder on `C:` (copy it there, verify the hash, delete the copy afterwards). The key import prompts for the passphrase once and the subkey prompts again when first used; the agent cache set in `gpg-agent.conf` keeps it for the script.
- **R8 verdict:** `restore-proof.sh` reports FAIL for any backup at ledger 0207 or later, because three CHECK constraints are re-parsed with different parentheses after a dump and restore (details and the reproduction are in `PHASE_W2_EXECUTION_RECORD_0202-0209.md`, section 8). Until the script accepts the known post-restore fingerprint for each head, R8 cannot return a clean PASS for a current backup. In that case verify, on the kept scratch database (`--keep`), the ledger and every `count` rule of the profile, record the script verdict honestly as FAIL with the cause, and keep R9 (retiring the old key) on hold.
- **R9:** keep the old public key in the VM keyring while `backup.env.pre-rotation` is the rollback path.
