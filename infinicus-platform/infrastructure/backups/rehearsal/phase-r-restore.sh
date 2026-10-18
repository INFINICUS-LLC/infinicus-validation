#!/usr/bin/env bash
# Phase R: restore rehearsal of a REAL encrypted backup into a DISPOSABLE PostgreSQL server, run INSIDE a throwaway container.
#
# What it does:
#   1. validates the target (restore-proof.sh --validate-target; fail-closed);
#   2. builds an expectations profile from the backup's own manifest (ledger count, ledger head, schema fingerprint). It invents NO row counts;
#   3. imports the passphrase-protected SECRET SUBKEYS you exported (the primary secret key never leaves your keyring) into a private temporary gpg home,
#      asks for the passphrase on the terminal (hidden, never on a command line, never written to disk) and hands it to the temporary gpg-agent;
#   4. runs restore-proof.sh --keep (verify SHA-256, decrypt, restore roles and database, compare ledger and schema fingerprint with the manifest and profile);
#   5. prints exact row counts per table (names and numbers only, no data) so you can compare them with production read-only;
#   6. wipes the temporary gpg home and stops the temporary agent. The restored database stays in the throwaway server until you remove it.
# It never contacts production and never takes a password in a URL.
#
# Inputs (environment):
#   RESTORE_ADMIN_URL        required. libpq URL of the throwaway server's maintenance database (loopback or local socket, no password).
#   PHASE_R_MANIFEST_KEY     required. Key of manifest.json inside PHASE_R_OBJECTS (e.g. infinicus-production/2026-10-18/<stamp>-pre-release-0198/manifest.json).
#   PHASE_R_OBJECTS          default /objects. Directory holding the downloaded encrypted objects under their original key path.
#   PHASE_R_KEYFILE          default /keys/subkeys.asc. Exported secret subkeys (still passphrase-protected).
#   PHASE_R_DB_NAME          default phase_r_restore. The scratch database to create (must not exist; never "infinicus").
#   PHASE_R_PROFILE          optional. A reviewed expectations profile (e.g. expectations/production-pre-0199.profile) with row-count rules, used instead of the
#                            manifest-only profile. restore-proof.sh still checks the ledger and fingerprint against the manifest AND the profile.
#   RESTORE_EXPECT_SYSTEM_IDENTIFIER  optional cluster pin (see restore-proof.sh).
#   PHASE_R_PASSPHRASE_FD    test hook only: read the passphrase from this file descriptor instead of the terminal.
# Result: last line PHASE_R=PASS or PHASE_R=FAIL (<reason>). Exit 0 only on PASS.

set -euo pipefail
umask 077
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BK="$(cd "$HERE/.." && pwd)"
OBJ="${PHASE_R_OBJECTS:-/objects}"
KEYFILE="${PHASE_R_KEYFILE:-/keys/subkeys.asc}"
DBN="${PHASE_R_DB_NAME:-phase_r_restore}"
MKEY="${PHASE_R_MANIFEST_KEY:?PHASE_R_MANIFEST_KEY is required}"
: "${RESTORE_ADMIN_URL:?RESTORE_ADMIN_URL is required}"
W=""; GH=""

die() { echo "PHASE_R=FAIL ($1)"; exit 1; }
step() { printf '\n== %s\n' "$1"; }
cleanup() {
  local rc=$?
  if [[ -n "$GH" ]]; then GNUPGHOME="$GH" gpgconf --kill gpg-agent >/dev/null 2>&1 || true; rm -rf "$GH"; fi
  [[ -z "$W" ]] || rm -rf "$W"
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT; trap 'exit 143' TERM

[[ "$DBN" =~ ^[a-z_][a-z0-9_]{0,62}$ && "$DBN" != infinicus && "$DBN" != postgres && "$DBN" != template0 && "$DBN" != template1 ]] || die "unsafe scratch database name"
command -v gpg >/dev/null 2>&1 || die "gpg is not installed"
PRESET="$(gpgconf --list-dirs libexecdir 2>/dev/null)/gpg-preset-passphrase"
[[ -x "$PRESET" ]] || PRESET=/usr/lib/gnupg/gpg-preset-passphrase
[[ -x "$PRESET" ]] || die "gpg-preset-passphrase was not found"
[[ -f "$KEYFILE" ]] || die "key file not found: $KEYFILE"
[[ -f "$OBJ/$MKEY" ]] || die "manifest not found: $OBJ/$MKEY"

step "1. target validation (fail-closed)"
bash "$BK/restore-proof.sh" --validate-target || die "the target was refused; nothing was created"

step "2. expectations profile from the manifest (no invented row counts)"
W="$(mktemp -d)"
M="$OBJ/$MKEY"
field() { sed -n "s/.*\"$1\": *\"\{0,1\}\([^\",}]*\)\"\{0,1\}.*/\1/p" "$M" | head -1; }
LC="$(field ledger_count)"; LH="$(field ledger_head)"; SF="$(field schema_fingerprint)"
[[ "$LC" =~ ^[0-9]+$ && "$LH" =~ ^[0-9A-Za-z_.-]+\.sql$ && "$SF" =~ ^[0-9a-f]{16}$ ]] || die "the manifest lacks a valid ledger count, head or schema fingerprint"
if [[ -n "${PHASE_R_PROFILE:-}" ]]; then
  [[ -f "$PHASE_R_PROFILE" ]] || die "profile not found: $PHASE_R_PROFILE"
  cp "$PHASE_R_PROFILE" "$W/expectations.profile"
  echo "using the reviewed profile $(basename "$PHASE_R_PROFILE") (ledger, fingerprint and row-count rules); the manifest values are ledger_count=$LC ledger_head=$LH schema_fingerprint=$SF"
else
  printf 'ledger_count=%s\nledger_head=%s\nschema_fingerprint=%s\n' "$LC" "$LH" "$SF" > "$W/expectations.profile"
  echo "ledger_count=$LC ledger_head=$LH schema_fingerprint=$SF (all taken from the backup manifest; no row-count rules)"
fi

step "3. secret subkeys into a private temporary gpg home; passphrase to the temporary agent only"
GH="$(mktemp -d)"; chmod 700 "$GH"
printf 'allow-preset-passphrase\ndefault-cache-ttl 7200\nmax-cache-ttl 7200\n' > "$GH/gpg-agent.conf"
export GNUPGHOME="$GH"
gpg --batch --quiet --import "$KEYFILE" 2>/dev/null || die "the key file could not be imported (check the GnuPG versions; see the runbook)"
mapfile -t GRIPS < <(gpg --list-secret-keys --with-keygrip --with-colons 2>/dev/null | awk -F: '/^ssb/{f=1;next} /^(sec|pub|sub)/{f=0} f&&/^grp/{print $10}')
(( ${#GRIPS[@]} > 0 )) || die "the key file holds no secret subkey"
if [[ -n "${PHASE_R_PASSPHRASE_FD:-}" ]]; then
  IFS= read -r -u "$PHASE_R_PASSPHRASE_FD" PASS
else
  [[ -t 0 ]] || die "no terminal to read the passphrase from (run the container with -it)"
  read -rs -p "Passphrase for the backup key (typed hidden): " PASS; echo
fi
for g in "${GRIPS[@]}"; do printf '%s' "$PASS" | "$PRESET" --preset "$g" || { unset PASS; die "could not hand the passphrase to the agent"; }; done
unset PASS
echo "subkeys loaded: ${#GRIPS[@]}; passphrase held only in the temporary agent's memory"

step "4. restore proof (real restore-proof.sh --keep)"
export RESTORE_GNUPGHOME="$GH" RESTORE_DB_NAME="$DBN" RESTORE_EXPECTATIONS="$W/expectations.profile"
export BACKUP_FETCH_CMD="cat '$OBJ/%KEY%'"
OUT="$(bash "$BK/restore-proof.sh" --keep "$MKEY" 2>&1)" || { echo "$OUT" | tail -6; die "restore-proof.sh did not pass"; }
echo "$OUT" | tail -4
echo "$OUT" | grep -q '^RESTORE_PROOF=PASS' || die "no RESTORE_PROOF=PASS line"

step "5. exact row counts in the restored copy (names and numbers only)"
DBURL="$(printf '%s' "$RESTORE_ADMIN_URL" | sed -E "s#/[^/?]*(\?|$)#/$DBN\1#")"
psql "$DBURL" -X -At -F ' = ' -c "select table_schema||'.'||table_name, (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', table_schema, table_name), false, true, '')))[1]::text from information_schema.tables where table_type='BASE TABLE' and table_schema not in ('pg_catalog','information_schema') order by 1" > "$W/counts.txt" || die "could not count rows"
wc -l < "$W/counts.txt" | sed 's/^/tables counted: /'
awk -F' = ' '$2+0>0' "$W/counts.txt"
echo "(tables with zero rows are omitted above)"

echo
echo "PHASE_R=PASS (backup $MKEY restored into the throwaway database $DBN; sha256, decrypt, restore, ledger and schema fingerprint all match the manifest). The restored database was KEPT; remove the container when finished."
