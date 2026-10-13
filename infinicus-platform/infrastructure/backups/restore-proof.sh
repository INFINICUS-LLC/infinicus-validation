#!/usr/bin/env bash
# Restore proof for an off-VM INFINICUS backup: fetch -> verify SHA-256 -> decrypt -> restore into a SCRATCH database on a THROWAWAY server -> compare the
# restored schema fingerprint and migration ledger with the backup manifest. A backup is not "recoverable" until this has passed.
#
# Run it on a machine that holds the PRIVATE key and has a disposable PostgreSQL server of the same major version (never on the production VM, never
# against the production database). It never touches production: it only reads objects from the backup store and writes to the scratch server.
#
# PASS requires ALL of: object SHA-256 = manifest; archive restores; ledger count/head and schema fingerprint = manifest AND = the expectations profile;
# every `count` row count and every `outbox` event-type count in the profile matches the RESTORED database (and no outbox row of an unlisted type exists).
# Only SELECT count(*) runs against the restored data: outbox events are never consumed, updated or replayed.
#
# Usage:   restore-proof.sh <manifest-key> [--keep]
#   <manifest-key>  e.g. infinicus-prod/2026-10-13/20261013T020000Z-daily/manifest.json
# Environment:
#   BACKUP_FETCH_CMD          required. Writes the object at %KEY% to stdout (e.g.  rclone cat offsite:infinicus-backups/%KEY%).
#   RESTORE_GNUPGHOME         required. gpg home containing the PRIVATE key (decryption).
#   RESTORE_ADMIN_URL         required. libpq URL of a maintenance database (normally .../postgres) on the THROWAWAY server, as a superuser.
#   RESTORE_DB_NAME           optional, default infinicus_restore_proof. Must not be "infinicus"; must not already exist.
#   RESTORE_REPO_DIR          optional, default the repository this script lives in; used to find the discovery script.
#   RESTORE_EXPECTATIONS      optional, default expectations/production-pre-0171.profile next to this script. The profile name and SHA-256 are printed.
# Output: RESTORE_TIMINGS (non-secret phase durations, evidence only - not an RTO) then a final line RESTORE_PROOF=PASS or RESTORE_PROOF=FAIL (<reason>);
#         exit 0 only on PASS.

set -euo pipefail
umask 077

KEEP=0; MANIFEST_KEY=""
for arg in "$@"; do
  case "$arg" in
    --keep) KEEP=1 ;;
    -*) echo "RESTORE_PROOF=FAIL (unknown argument $arg)"; exit 2 ;;
    *) MANIFEST_KEY="$arg" ;;
  esac
done
TIMINGS=""
fail() { emit_timings; echo "RESTORE_PROOF=FAIL ($1)"; exit "${2:-1}"; }
now() { date +%s.%N; }
secs() { awk -v a="$1" -v b="$2" 'BEGIN{printf "%.1f", b - a}'; }
phase_done() { TIMINGS+="${TIMINGS:+ }$1=$(secs "$2" "$(now)")s"; }
emit_timings() { [[ -z "$TIMINGS" ]] || echo "RESTORE_TIMINGS $TIMINGS (evidence only; not an RTO)"; }
log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1"; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DISCOVERY="${BACKUP_DISCOVERY_SCRIPT:-$SCRIPT_DIR/../deployment/scripts/production-readonly-discovery.sh}"
[[ -n "$MANIFEST_KEY" && "$MANIFEST_KEY" =~ ^[A-Za-z0-9._/:-]{1,300}$ && "$MANIFEST_KEY" != *..* && "$MANIFEST_KEY" == */manifest.json ]] || fail "a manifest key ending in /manifest.json is required" 2
[[ -n "${BACKUP_FETCH_CMD:-}" && "${BACKUP_FETCH_CMD}" == *%KEY%* ]] || fail "BACKUP_FETCH_CMD (containing %KEY%) is required" 2
[[ -n "${RESTORE_GNUPGHOME:-}" && -d "$RESTORE_GNUPGHOME" ]] || fail "RESTORE_GNUPGHOME (a gpg home with the private key) is required" 2
[[ -n "${RESTORE_ADMIN_URL:-}" ]] || fail "RESTORE_ADMIN_URL (maintenance database on the throwaway server) is required" 2
DB="${RESTORE_DB_NAME:-infinicus_restore_proof}"
[[ "$DB" =~ ^[a-z_][a-z0-9_]{0,62}$ && "$DB" != infinicus && "$DB" != postgres && "$DB" != template0 && "$DB" != template1 ]] || fail "unsafe or production scratch database name: $DB" 2
[[ -f "$DISCOVERY" ]] || fail "discovery script not found: $DISCOVERY" 2

# expectations profile (strict syntax; an unknown line is an error so a typo can never weaken the proof)
PROFILE="${RESTORE_EXPECTATIONS:-$SCRIPT_DIR/expectations/production-pre-0171.profile}"
[[ -f "$PROFILE" ]] || fail "expectations profile not found: $PROFILE" 2
E_COUNT=""; E_HEAD=""; E_FP=""; EXP_COUNTS=(); EXP_OUTBOX=()
while IFS= read -r line || [[ -n "$line" ]]; do
  line="${line%%#*}"; line="${line#"${line%%[![:space:]]*}"}"; line="${line%"${line##*[![:space:]]}"}"
  [[ -z "$line" ]] && continue
  if   [[ "$line" =~ ^ledger_count=([0-9]+)$ ]]; then E_COUNT="${BASH_REMATCH[1]}"
  elif [[ "$line" =~ ^ledger_head=([A-Za-z0-9._-]+)$ ]]; then E_HEAD="${BASH_REMATCH[1]}"
  elif [[ "$line" =~ ^schema_fingerprint=([0-9a-f]{16})$ ]]; then E_FP="${BASH_REMATCH[1]}"
  elif [[ "$line" =~ ^count[[:space:]]+([a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*)=([0-9]+)$ ]]; then EXP_COUNTS+=("${BASH_REMATCH[1]}=${BASH_REMATCH[2]}")
  elif [[ "$line" =~ ^outbox[[:space:]]+([a-z0-9_.]+)=([0-9]+)$ ]]; then EXP_OUTBOX+=("${BASH_REMATCH[1]}=${BASH_REMATCH[2]}")
  else fail "invalid line in the expectations profile: $line" 2; fi
done < "$PROFILE"
[[ -n "$E_COUNT" && -n "$E_HEAD" ]] || fail "the expectations profile must define ledger_count and ledger_head" 2
PROFILE_SHA="$(sha256sum "$PROFILE" | cut -c1-16)"
T_TOTAL="$(now)"

fetch() { bash -c "${BACKUP_FETCH_CMD//%KEY%/$1}"; }
WORK="$(mktemp -d "${TMPDIR:-/tmp}/restore-proof.XXXXXX")"
chmod 700 "$WORK"
SCRATCH_CREATED=0
cleanup() {
  if [[ $SCRATCH_CREATED -eq 1 && $KEEP -eq 0 ]]; then psql "$RESTORE_ADMIN_URL" -X -q -c "DROP DATABASE IF EXISTS \"$DB\"" >/dev/null 2>&1 || true; fi
  rm -rf "$WORK"
}
trap cleanup EXIT

# 1. manifest
T_DL="$(now)"
fetch "$MANIFEST_KEY" > "$WORK/manifest.json" 2>/dev/null || fail "cannot fetch the manifest (a backup without a manifest is not a valid backup)"
[[ -s "$WORK/manifest.json" ]] || fail "manifest is empty"
field() { sed -n "s/.*\"$1\":\"\([^\"]*\)\".*/\1/p" "$WORK/manifest.json" | head -1; }
numfield() { sed -n "s/.*\"$1\":\([0-9]*\).*/\1/p" "$WORK/manifest.json" | head -1; }
M_FINGERPRINT="$(field schema_fingerprint)"; M_HEAD="$(field ledger_head)"; M_COUNT="$(numfield ledger_count)"; M_VERSION="$(field pg_server_version)"
[[ "$M_FINGERPRINT" =~ ^[0-9a-f]{16}$ && -n "$M_HEAD" && "$M_COUNT" =~ ^[0-9]+$ ]] || fail "manifest lacks fingerprint / ledger information"
log "manifest: head=$M_HEAD count=$M_COUNT fingerprint=$M_FINGERPRINT source=$M_VERSION"
BASE_KEY="${MANIFEST_KEY%/manifest.json}"

# 2. objects: fetch, verify SHA-256 against the manifest
for name in db.dump.gpg roles.sql.gpg; do
  exp="$(tr ',' '\n' < "$WORK/manifest.json" | grep -A2 "\"name\":\"$name\"" | sed -n 's/.*"sha256":"\([0-9a-f]\{64\}\)".*/\1/p' | head -1)"
  [[ "$exp" =~ ^[0-9a-f]{64}$ ]] || fail "manifest has no SHA-256 for $name"
  fetch "$BASE_KEY/$name" > "$WORK/$name" 2>/dev/null || fail "cannot fetch $name"
  got="$(sha256sum "$WORK/$name" | cut -d' ' -f1)"
  [[ "$got" == "$exp" ]] || fail "SHA-256 mismatch for $name (manifest $exp, fetched $got): the object is corrupted or tampered with"
  log "verified   $name sha256=$got"
done
phase_done download "$T_DL"

# 3. decrypt with the private key
T_DEC="$(now)"
export GNUPGHOME="$RESTORE_GNUPGHOME"
gpg --batch --quiet --decrypt "$WORK/db.dump.gpg" > "$WORK/db.dump" 2>"$WORK/gpg.err" || fail "cannot decrypt db.dump.gpg (missing or wrong private key)"
gpg --batch --quiet --decrypt "$WORK/roles.sql.gpg" > "$WORK/roles.sql" 2>>"$WORK/gpg.err" || fail "cannot decrypt roles.sql.gpg"
pg_restore --list "$WORK/db.dump" >/dev/null 2>&1 || fail "decrypted dump is not a valid pg_dump archive"
phase_done decrypt "$T_DEC"

# 4. restore into a scratch database on the throwaway server
T_RES="$(now)"
exists="$(psql "$RESTORE_ADMIN_URL" -X -At -c "select 1 from pg_database where datname = '$DB'")"
[[ -z "$exists" ]] || fail "scratch database $DB already exists on the target server; refusing to touch it" 2
# roles first (cluster-level objects: owners and grantees). Errors for roles that already exist (e.g. the bootstrap superuser) are expected and ignored.
psql "$RESTORE_ADMIN_URL" -X -q -v ON_ERROR_STOP=0 -f "$WORK/roles.sql" >/dev/null 2>"$WORK/roles.err" || true
psql "$RESTORE_ADMIN_URL" -X -q -c "CREATE DATABASE \"$DB\"" || fail "cannot create the scratch database"
SCRATCH_CREATED=1
SCRATCH_URL="$(printf '%s' "$RESTORE_ADMIN_URL" | sed -E "s#(postgres(ql)?://[^/]*)/[^?]*#\1/$DB#")"
pg_restore --dbname="$SCRATCH_URL" --exit-on-error --no-comments "$WORK/db.dump" 2>"$WORK/restore.err" || fail "pg_restore failed: $(head -c 300 "$WORK/restore.err" | tr '\n' ' ')"
log "restored into scratch database $DB"
phase_done restore "$T_RES"

# 5. verification: ledger and fingerprint (manifest AND profile), then row counts and the outbox classification, all read-only on the restored copy
T_VER="$(now)"
MISMATCH=()
LEDGER="$(psql "$SCRATCH_URL" -X -At -c "select count(*)||chr(124)||coalesce(max(filename),chr(45)) from public._migrations")"
R_COUNT="${LEDGER%%|*}"; R_HEAD="${LEDGER#*|}"
[[ "$R_COUNT" == "$M_COUNT" && "$R_HEAD" == "$M_HEAD" ]] || fail "ledger differs after restore (restored $R_COUNT/$R_HEAD, manifest $M_COUNT/$M_HEAD)"
R_FP="$(INFINICUS_DISCOVERY_ONLY=fingerprint INFINICUS_DISCOVERY_PSQL="psql $SCRATCH_URL" REPO_DIR="${RESTORE_REPO_DIR:-$SCRIPT_DIR/../../..}" bash "$DISCOVERY" 2>/dev/null | sed -n 's/^fingerprint-groups=.* combined-sha256-16=\([0-9a-f]\{16\}\)$/\1/p' | head -1)"
[[ "$R_FP" == "$M_FINGERPRINT" ]] || fail "schema fingerprint differs after restore (restored $R_FP, manifest $M_FINGERPRINT)"
[[ "$R_COUNT" == "$E_COUNT" && "$R_HEAD" == "$E_HEAD" ]] || MISMATCH+=("ledger restored $R_COUNT/$R_HEAD, expected $E_COUNT/$E_HEAD")
[[ -z "$E_FP" || "$R_FP" == "$E_FP" ]] || MISMATCH+=("schema fingerprint restored $R_FP, expected $E_FP")

q() { PGOPTIONS='-c default_transaction_read_only=on -c statement_timeout=60000' psql "$SCRATCH_URL" -X -At -c "$1" 2>/dev/null; }
for entry in ${EXP_COUNTS[@]+"${EXP_COUNTS[@]}"}; do
  tbl="${entry%%=*}"; want="${entry#*=}"
  got="$(q "select count(*) from $tbl")" || { MISMATCH+=("cannot count $tbl in the restored database"); continue; }
  if [[ "$got" == "$want" ]]; then log "verified   count $tbl = $got"; else MISMATCH+=("count $tbl restored $got, expected $want"); fi
done
if (( ${#EXP_OUTBOX[@]} > 0 )); then
  types=""
  for entry in "${EXP_OUTBOX[@]}"; do
    typ="${entry%%=*}"; want="${entry#*=}"; types+="${types:+,}'$typ'"
    got="$(q "select count(*) from events.outbox_events where event_type = '$typ'")" || { MISMATCH+=("cannot classify events.outbox_events by event_type"); continue; }
    if [[ "$got" == "$want" ]]; then log "verified   outbox $typ = $got"; else MISMATCH+=("outbox $typ restored $got, expected $want"); fi
  done
  other="$(q "select count(*) from events.outbox_events where event_type not in ($types)")" || other="?"
  if [[ "$other" == "0" ]]; then log "verified   no outbox event of an unlisted type"; else MISMATCH+=("outbox rows of unlisted event types: $other, expected 0"); fi
fi
phase_done verify "$T_VER"
TIMINGS+=" total=$(secs "$T_TOTAL" "$(now)")s"
if (( ${#MISMATCH[@]} > 0 )); then
  for m in "${MISMATCH[@]}"; do log "MISMATCH   $m"; done
  fail "restored data differs from the expectations profile (${#MISMATCH[@]} mismatch(es); first: ${MISMATCH[0]})"
fi

log "ledger $R_COUNT rows, head $R_HEAD; fingerprint $R_FP equals the manifest; ${#EXP_COUNTS[@]} row-count rule(s) and ${#EXP_OUTBOX[@]} outbox classification rule(s) satisfied (profile $(basename "$PROFILE") sha256:$PROFILE_SHA)"
emit_timings
echo "RESTORE_PROOF=PASS (backup $BASE_KEY restores into a clean scratch database; ledger, schema fingerprint, critical row counts and outbox classification all match)"
