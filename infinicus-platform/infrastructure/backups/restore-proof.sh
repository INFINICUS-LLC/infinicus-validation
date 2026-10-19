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
#          restore-proof.sh --validate-target        (checks the restore target only; fetches, decrypts and writes nothing)
#   <manifest-key>  e.g. infinicus-prod/2026-10-13/20261013T020000Z-daily/manifest.json
#
# FAIL-CLOSED RESTORE TARGET (checked before anything is fetched, decrypted or written; any doubt refuses with exit 2):
#   - RESTORE_ADMIN_URL must be a postgresql:// URL with NO password (use PGPASSFILE or local socket authentication: a password in the URL would show in
#     process listings), exactly one host, and no query parameter other than sslmode, connect_timeout, application_name, host and port. The host must be
#     loopback (localhost, 127.x.x.x, ::1) or a local socket directory. PGHOSTADDR, PGSERVICE and PGSERVICEFILE must be unset (they can redirect a connection).
#   - The server must be marked disposable by whoever built it: start it with  -c infinicus.restore_target=disposable  (the marker is read from the server,
#     so a production server cannot pass by accident). It must be a superuser connection to a primary (not a replica) of the expected major version
#     (RESTORE_EXPECT_PG_MAJOR, default 16) and must not contain a database named infinicus.
#   - roles.sql comes from an unauthenticated backup, so it is never run as is: every line must match a strict allowlist of what pg_dumpall --roles-only
#     produces (any psql meta-command other than the matching restrict/unrestrict pair, COPY, ALTER SYSTEM, DO, CREATE EXTENSION and so on refuses the
#     restore) and password hashes are removed before it runs. Afterwards no restored role may carry a password and the connection must still be a superuser.
#   - Temporary files: private directory (mode 700, owned by the caller), shell tracing refused, decrypted dump and roles deleted as soon as they are no
#     longer needed, directory wiped on exit, INT, TERM and HUP. Run it on an encrypted disk. pg_restore of the archive itself cannot be sandboxed by this
#     script, so the throwaway server must also be isolated (no secrets, no route to production).
# Environment:
#   BACKUP_FETCH_CMD          required. Writes the object at %KEY% to stdout (e.g.  rclone cat offsite:infinicus-backups/%KEY%).
#   RESTORE_GNUPGHOME         required. gpg home containing the PRIVATE key (decryption).
#   RESTORE_ADMIN_URL         required. libpq URL of a maintenance database (normally .../postgres) on the THROWAWAY server, as a superuser. See the
#                             fail-closed target rules above: loopback or local socket only, no password in the URL, server marked disposable.
#   RESTORE_EXPECT_PG_MAJOR   optional, default 16. The target server must report this major version.
#   RESTORE_DB_NAME           optional, default infinicus_restore_proof. Must not be "infinicus"; must not already exist.
#   RESTORE_REPO_DIR          optional, default the repository this script lives in; used to find the discovery script.
#   RESTORE_EXPECTATIONS      optional, default expectations/production-pre-0171.profile next to this script. The profile name and SHA-256 are printed.
# Output: RESTORE_TIMINGS (non-secret phase durations, evidence only - not an RTO) then a final line RESTORE_PROOF=PASS or RESTORE_PROOF=FAIL (<reason>);
#         exit 0 only on PASS.

set -euo pipefail
umask 077

# shell tracing would print connection details and paths: refuse it before anything else
if [[ "$-" == *x* || -n "${BASH_XTRACEFD:-}" ]]; then echo "RESTORE_PROOF=FAIL (shell tracing is enabled; refusing, because it would print connection details)"; exit 2; fi

KEEP=0; MANIFEST_KEY=""; VALIDATE_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --keep) KEEP=1 ;;
    --validate-target) VALIDATE_ONLY=1 ;;
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
refuse() { # refuse <reason>: the restore target is not acceptable; nothing has been fetched, decrypted or written
  if (( VALIDATE_ONLY )); then echo "RESTORE_TARGET=REFUSED ($1)"; else echo "RESTORE_PROOF=FAIL (restore target refused: $1)"; fi
  exit 2
}
LOOPBACK_RE='^(localhost|127\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}|::1)$'
validate_target() {
  local url="$RESTORE_ADMIN_URL" authority="" query="" hostport="" host="" qhost="" pairs=() kv key val out marker su rec major prodcount h
  [[ -z "${PGHOSTADDR:-}${PGSERVICE:-}${PGSERVICEFILE:-}" ]] || refuse "PGHOSTADDR, PGSERVICE and PGSERVICEFILE must be unset (they can redirect the connection)"
  [[ "$url" =~ ^postgres(ql)?://([^/?#]*)(/[^?#]*)?(\?([^#]*))?$ ]] || refuse "RESTORE_ADMIN_URL must be a postgresql:// URL without a fragment"
  authority="${BASH_REMATCH[2]}"; query="${BASH_REMATCH[5]}"
  [[ "$authority" != *,* ]] || refuse "exactly one host is allowed"
  if [[ "$authority" == *@* ]]; then
    [[ "${authority%@*}" != *:* ]] || refuse "the URL must not contain a password (use PGPASSFILE or local socket authentication)"
  fi
  hostport="${authority##*@}"
  if [[ "$hostport" =~ ^\[([0-9a-fA-F:]+)\](:[0-9]+)?$ ]]; then host="${BASH_REMATCH[1]}"
  elif [[ "$hostport" =~ ^([^]:[]*)(:[0-9]+)?$ ]]; then host="${BASH_REMATCH[1]}"
  else refuse "the host part of the URL cannot be parsed"; fi
  if [[ -n "$query" ]]; then
    IFS='&' read -r -a pairs <<< "$query"
    for kv in "${pairs[@]}"; do
      key="${kv%%=*}"; val="${kv#*=}"
      case "$key" in
        sslmode|connect_timeout|application_name) ;;
        port) [[ "$val" =~ ^[0-9]{1,5}$ ]] || refuse "the port parameter is not a number" ;;
        host) qhost="$val" ;;
        *) refuse "the URL carries a connection parameter that is not allowed (only sslmode, connect_timeout, application_name, host and port)" ;;
      esac
    done
  fi
  [[ -n "$host" || -n "$qhost" ]] || refuse "an explicit host is required (a missing host would fall back to PGHOST or a default socket)"
  for h in "$host" "$qhost"; do
    [[ -n "$h" ]] || continue
    h="${h//%2[Ff]//}"
    if [[ "$h" == /* ]]; then [[ "$h" != *..* ]] || refuse "a socket directory must not contain .."
    elif [[ ! "$h" =~ $LOOPBACK_RE ]]; then refuse "the host must be loopback (localhost, 127.x.x.x, ::1) or a local socket directory"; fi
  done
  command -v psql >/dev/null 2>&1 || refuse "psql is not installed"
  out="$(PGOPTIONS='-c default_transaction_read_only=on -c statement_timeout=15000' PGCONNECT_TIMEOUT=10 psql "$url" -X -At -F '|' -c "select coalesce(current_setting('infinicus.restore_target', true), '<unset>'), current_setting('is_superuser'), pg_is_in_recovery()::text, (current_setting('server_version_num')::int / 10000)::text, (select count(*) from pg_database where datname = 'infinicus')::text" 2>/dev/null)" \
    || refuse "cannot connect to the target (connection details are not printed)"
  IFS='|' read -r marker su rec major prodcount <<< "$out"
  [[ "$marker" == "disposable" ]] || refuse "the target server is not marked disposable (start the throwaway server with -c infinicus.restore_target=disposable)"
  [[ "$su" == "on" ]] || refuse "the target connection is not a superuser"
  [[ "$rec" == "false" ]] || refuse "the target is a replica or in recovery"
  [[ "$major" == "${RESTORE_EXPECT_PG_MAJOR:-16}" ]] || refuse "the target server major version is $major, expected ${RESTORE_EXPECT_PG_MAJOR:-16}"
  [[ "$prodcount" == "0" ]] || refuse "the target cluster contains a database named infinicus (the production database name)"
  # Optional pin: the operator records the throwaway cluster's system identifier when provisioning it (select system_identifier from pg_control_system())
  # and passes it here, so a URL that points at any other cluster is refused even if that cluster carries the marker.
  if [[ -n "${RESTORE_EXPECT_SYSTEM_IDENTIFIER:-}" ]]; then
    [[ "$RESTORE_EXPECT_SYSTEM_IDENTIFIER" =~ ^[0-9]{10,20}$ ]] || refuse "RESTORE_EXPECT_SYSTEM_IDENTIFIER must be the numeric PostgreSQL system identifier"
    local actual_id
    actual_id="$(PGOPTIONS='-c default_transaction_read_only=on -c statement_timeout=15000' PGCONNECT_TIMEOUT=10 psql "$url" -X -At -c 'select system_identifier from pg_control_system()' 2>/dev/null)" || refuse "cannot read the target system identifier"
    [[ "$actual_id" == "$RESTORE_EXPECT_SYSTEM_IDENTIFIER" ]] || refuse "the target system identifier differs from RESTORE_EXPECT_SYSTEM_IDENTIFIER"
  fi
}
[[ -n "${RESTORE_ADMIN_URL:-}" ]] || fail "RESTORE_ADMIN_URL (maintenance database on the throwaway server) is required" 2
if (( VALIDATE_ONLY )); then
  validate_target
  echo "RESTORE_TARGET=OK (loopback or local socket, marked disposable, superuser, primary, expected major version, no production database; nothing was fetched or written)"
  exit 0
fi
[[ -n "$MANIFEST_KEY" && "$MANIFEST_KEY" =~ ^[A-Za-z0-9._/:-]{1,300}$ && "$MANIFEST_KEY" != *..* && "$MANIFEST_KEY" == */manifest.json ]] || fail "a manifest key ending in /manifest.json is required" 2
[[ -n "${BACKUP_FETCH_CMD:-}" && "${BACKUP_FETCH_CMD}" == *%KEY%* ]] || fail "BACKUP_FETCH_CMD (containing %KEY%) is required" 2
[[ -n "${RESTORE_GNUPGHOME:-}" && -d "$RESTORE_GNUPGHOME" ]] || fail "RESTORE_GNUPGHOME (a gpg home with the private key) is required" 2
validate_target
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
# The signal traps are installed BEFORE the temporary directory exists. If they were installed after it, a SIGTERM/INT/HUP arriving in that
# window would hit bash's default action: the script would die at once (killed by the signal, not the documented exit code) and leave the
# directory behind. Bash runs a trap only between commands, so a signal that arrives while the directory is being created is handled after the
# assignment below, with WORK already set, and cleanup removes the directory.
WORK=""
SCRATCH_CREATED=0
# best-effort removal of plaintext (shred is not reliable on journaled or SSD storage: run on an encrypted disk)
wipe_work() {
  [[ -n "$WORK" && -d "$WORK" ]] || return 0
  if command -v shred >/dev/null 2>&1; then find "$WORK" -type f -exec shred -u {} + >/dev/null 2>&1 || true; fi
  rm -rf "$WORK"
}
cleanup() {
  if [[ $SCRATCH_CREATED -eq 1 && $KEEP -eq 0 ]]; then psql "$RESTORE_ADMIN_URL" -X -q -c "DROP DATABASE IF EXISTS \"$DB\"" >/dev/null 2>&1 || true; fi
  wipe_work
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

WORK="$(mktemp -d "${TMPDIR:-/tmp}/restore-proof.XXXXXX")"
chmod 700 "$WORK"
[[ "$(stat -c '%a %u' "$WORK")" == "700 $(id -u)" ]] || { rm -rf "$WORK"; fail "the temporary directory is not private to the caller" 2; }

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
# roles first (cluster-level objects: owners and grantees). roles.sql comes from an unauthenticated backup, so it is validated against a strict
# allowlist and stripped of password hashes before psql sees it. Errors for roles that already exist (e.g. the bootstrap superuser) are expected and ignored.
sanitize_roles() { # sanitize_roles <in> <out>: allowlist every line of pg_dumpall --roles-only output; strip password hashes; refuse anything else
  local in="$1" out="$2" name='([A-Za-z_][A-Za-z0-9_$]*|"[^"]{1,63}")' n=0 bad=0 first_bad="" tok="" end_tok="" sawend=0 line
  local re_set="^SET (default_transaction_read_only|client_encoding|standard_conforming_strings) = ('[A-Za-z0-9_-]+'|on|off);\$"
  local re_create="^CREATE ROLE ${name};\$"
  local re_alter="^ALTER ROLE ${name} WITH [A-Z ]+( CONNECTION LIMIT -?[0-9]+)?( PASSWORD '[^']*')?( VALID UNTIL '[^']*')?;\$"
  local re_comment="^COMMENT ON ROLE ${name} IS '[^']*';\$"
  local val="('[^']*'|[A-Za-z0-9_.-]+)"
  local re_conf="^ALTER ROLE ${name} SET (search_path|statement_timeout|lock_timeout|idle_in_transaction_session_timeout|default_transaction_read_only|row_security|timezone) TO ${val}(, ${val})*;\$"
  local re_grant="^GRANT ${name} TO ${name}( WITH [A-Z0-9 ,]+)?( GRANTED BY ${name})?;\$"
  : > "$out"
  while IFS= read -r line || [[ -n "$line" ]]; do
    n=$((n + 1))
    if [[ -z "$line" || "$line" == --* ]]; then printf '%s\n' "$line" >> "$out"; continue; fi
    if [[ "$line" =~ ^\\restrict\ ([A-Za-z0-9]+)$ ]]; then
      [[ -z "$tok" ]] || { bad=$((bad + 1)); [[ -n "$first_bad" ]] || first_bad="$n"; continue; }
      tok="${BASH_REMATCH[1]}"; printf '%s\n' "$line" >> "$out"; continue
    fi
    if [[ "$line" =~ ^\\unrestrict\ ([A-Za-z0-9]+)$ ]]; then
      if [[ -n "$tok" && "${BASH_REMATCH[1]}" == "$tok" ]]; then sawend=1; printf '%s\n' "$line" >> "$out"; else bad=$((bad + 1)); [[ -n "$first_bad" ]] || first_bad="$n"; fi
      continue
    fi
    if [[ "$line" =~ $re_set || "$line" =~ $re_create || "$line" =~ $re_comment || "$line" =~ $re_conf || "$line" =~ $re_grant ]]; then
      printf '%s\n' "$line" >> "$out"
    elif [[ "$line" =~ $re_alter ]]; then
      printf '%s\n' "$(printf '%s' "$line" | sed -E "s/ PASSWORD '[^']*'//")" >> "$out"
    else
      bad=$((bad + 1)); [[ -n "$first_bad" ]] || first_bad="$n"
    fi
  done < "$in"
  if [[ -n "$tok" && $sawend -eq 0 ]]; then bad=$((bad + 1)); [[ -n "$first_bad" ]] || first_bad="end"; fi
  (( bad == 0 )) || fail "roles.sql has $bad line(s) outside the allowlist of pg_dumpall --roles-only output (first at line $first_bad; the content is not printed); the restore was not attempted" 2
}
sanitize_roles "$WORK/roles.sql" "$WORK/roles.safe.sql"
# The role this restore connects as is never modified by the backup: drop every statement that creates, alters, comments on or grants membership to it
# (pg_dumpall always emits the source bootstrap role, which may share the name). Other roles are restored as before.
conn_role="$(PGOPTIONS='-c default_transaction_read_only=on' psql "$RESTORE_ADMIN_URL" -X -At -c 'select current_user' 2>/dev/null)" || fail "cannot determine the restore connection role"
protect_connecting_role() { # protect_connecting_role <in> <out>
  local in="$1" out="$2" line subj="" grantee="" name='([A-Za-z_][A-Za-z0-9_$]*|"[^"]{1,63}")' dropped=0
  : > "$out"
  while IFS= read -r line || [[ -n "$line" ]]; do
    subj=""; grantee=""
    if [[ "$line" =~ ^(CREATE\ ROLE|ALTER\ ROLE|COMMENT\ ON\ ROLE)\ ${name}([\ ;]|$) ]]; then subj="${BASH_REMATCH[2]}"
    elif [[ "$line" =~ ^GRANT\ ${name}\ TO\ ${name}([\ ;]|$) ]]; then grantee="${BASH_REMATCH[2]}"; fi
    for n in "$subj" "$grantee"; do
      [[ -n "$n" ]] || continue
      if [[ "$n" == \"*\" ]]; then n="${n:1:${#n}-2}"; else n="$(printf '%s' "$n" | LC_ALL=C tr '[:upper:]' '[:lower:]')"; fi
      if [[ "$n" == "$conn_role" ]]; then dropped=$((dropped + 1)); continue 2; fi
    done
    printf '%s\n' "$line" >> "$out"
  done < "$in"
  (( dropped == 0 )) || log "roles.sql: $dropped statement(s) targeting the restore connection role were skipped; that role is not modified by a backup"
}
protect_connecting_role "$WORK/roles.safe.sql" "$WORK/roles.guarded.sql"
psql "$RESTORE_ADMIN_URL" -X -q -v ON_ERROR_STOP=0 -f "$WORK/roles.guarded.sql" >/dev/null 2>"$WORK/roles.err" || true
rm -f "$WORK/roles.sql" "$WORK/roles.safe.sql" "$WORK/roles.guarded.sql"
post_roles="$(PGOPTIONS='-c default_transaction_read_only=on' psql "$RESTORE_ADMIN_URL" -X -At -F '|' -c "select (select count(*) from pg_authid where rolpassword is not null and rolname <> current_user), current_setting('is_superuser')" 2>/dev/null)" || fail "cannot inspect the restored roles"
[[ "$post_roles" == "0|on" ]] || fail "after the roles were restored, a role carries a password or the connection lost superuser (restored $post_roles); the restore was stopped"
psql "$RESTORE_ADMIN_URL" -X -q -c "CREATE DATABASE \"$DB\"" || fail "cannot create the scratch database"
SCRATCH_CREATED=1
SCRATCH_URL="$(printf '%s' "$RESTORE_ADMIN_URL" | sed -E "s#(postgres(ql)?://[^/]*)/[^?]*#\1/$DB#")"
pg_restore --dbname="$SCRATCH_URL" --exit-on-error --no-comments "$WORK/db.dump" 2>"$WORK/restore.err" || fail "pg_restore failed: $(head -c 300 "$WORK/restore.err" | tr '\n' ' ')"
rm -f "$WORK/db.dump"
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
