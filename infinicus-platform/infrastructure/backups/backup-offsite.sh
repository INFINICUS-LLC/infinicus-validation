#!/usr/bin/env bash
# Off-VM encrypted logical backup of the production PostgreSQL database (INFINICUS).
#
# What it does (it never writes to the database; pg_dump and the catalog queries are read-only):
#   1. checks prerequisites (--check does only this and writes nothing anywhere);
#   2. records the schema fingerprint, migration-ledger head/count and server version (read-only queries);
#   3. dumps the database in custom format WITH owners and privileges (a restore keeps the security model) and the cluster ROLES (pg_dumpall --roles-only:
#      roles are not part of a database dump, and a disaster-recovery restore needs them);
#   4. encrypts both with gpg to a PUBLIC key before anything leaves the machine (the private key is never on the VM, so a VM compromise cannot read old
#      backups);
#   5. uploads the encrypted objects through the configured sink (any S3-compatible client, e.g. rclone), then uploads manifest.json LAST - a backup exists
#      only if its manifest exists;
#   6. with --verify, fetches every object back and re-checks its SHA-256.
# The script never deletes remote objects (retention belongs to bucket lifecycle rules; give the backup credential no delete permission).
#
# Usage:   backup-offsite.sh [--check] [--verify]      (configuration comes from the environment or BACKUP_ENV_FILE, default /etc/infinicus/backup.env)
# Exit:    0 success; 2 prerequisite/configuration failure; 3 dump/encrypt failure; 4 upload failure; 5 verification failure.
#
# Configuration (all via environment; secrets live only in the root-owned env file and the S3 client's own config, never in command lines or logs):
#   BACKUP_GPG_RECIPIENT   required. Fingerprint/key id of the PUBLIC key to encrypt to (already imported into the keyring used below).
#   BACKUP_SINK_CMD        required. Command that reads the object from stdin and stores it at key %KEY%, e.g.  rclone rcat offsite:infinicus-backups/%KEY%
#   BACKUP_FETCH_CMD       required for --verify and for freshness/restore tooling. Writes the object at %KEY% to stdout, e.g.  rclone cat offsite:infinicus-backups/%KEY%
#   BACKUP_LABEL           optional, default "daily". [A-Za-z0-9._-]{1,40}; use e.g. pre-migration-0171 for a pre-migration backup.
#   BACKUP_PREFIX          optional, default "infinicus-prod". Object key prefix.
#   BACKUP_GNUPGHOME       optional gpg home (default: the caller's).
#   BACKUP_STATE_DIR       optional, default /var/lib/infinicus-backup. Holds last-success.json for the freshness check. Not secret.
#   BACKUP_TMP_DIR         optional, default /var/tmp/infinicus-backup. Holds the ENCRYPTED objects only, mode 0700, removed on exit.
#   COMPOSE_DIR            optional, default $PWD (the directory with docker-compose.yml) for the default database commands.
#   Test/override hooks (the defaults use `docker compose exec -T postgres ...` as admin_role over the container socket, no password):
#   BACKUP_PG_DUMP_CMD, BACKUP_PG_ROLES_CMD, BACKUP_PSQL_CMD, BACKUP_DISCOVERY_SCRIPT.

set -euo pipefail
umask 077

ENV_FILE="${BACKUP_ENV_FILE:-/etc/infinicus/backup.env}"
if [[ -f "$ENV_FILE" ]]; then
  # shellcheck disable=SC1090
  . "$ENV_FILE"
fi

MODE_CHECK=0; MODE_VERIFY=0
for arg in "$@"; do
  case "$arg" in
    --check) MODE_CHECK=1 ;;
    --verify) MODE_VERIFY=1 ;;
    *) echo "ERROR: unknown argument: $arg" >&2; exit 2 ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_DIR="${COMPOSE_DIR:-$PWD}"
LABEL="${BACKUP_LABEL:-daily}"
PREFIX="${BACKUP_PREFIX:-infinicus-prod}"
STATE_DIR="${BACKUP_STATE_DIR:-/var/lib/infinicus-backup}"
TMP_BASE="${BACKUP_TMP_DIR:-/var/tmp/infinicus-backup}"
DISCOVERY="${BACKUP_DISCOVERY_SCRIPT:-$SCRIPT_DIR/../deployment/scripts/production-readonly-discovery.sh}"
READONLY_OPTS='-c default_transaction_read_only=on -c statement_timeout=30000'
[[ -n "${BACKUP_GNUPGHOME:-}" ]] && export GNUPGHOME="$BACKUP_GNUPGHOME"

fail() { echo "ERROR: $1" >&2; exit "${2:-2}"; }
log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1"; }

[[ "$LABEL" =~ ^[A-Za-z0-9._-]{1,40}$ ]] || fail "BACKUP_LABEL must match [A-Za-z0-9._-]{1,40}"
[[ "$PREFIX" =~ ^[A-Za-z0-9._/-]{1,80}$ && "$PREFIX" != *..* ]] || fail "BACKUP_PREFIX has unsafe characters"
[[ -n "${BACKUP_GPG_RECIPIENT:-}" ]] || fail "BACKUP_GPG_RECIPIENT is required (encryption is mandatory; there is no unencrypted mode)"
[[ "$BACKUP_GPG_RECIPIENT" =~ ^[A-Za-z0-9@._:+-]{8,200}$ ]] || fail "BACKUP_GPG_RECIPIENT has unsafe characters"
[[ -n "${BACKUP_SINK_CMD:-}" ]] || fail "BACKUP_SINK_CMD is required (a command reading stdin and storing it at %KEY%)"
[[ "${BACKUP_SINK_CMD}" == *%KEY%* ]] || fail "BACKUP_SINK_CMD must contain %KEY%"
if [[ $MODE_VERIFY -eq 1 || $MODE_CHECK -eq 1 ]]; then
  [[ -n "${BACKUP_FETCH_CMD:-}" && "${BACKUP_FETCH_CMD}" == *%KEY%* ]] || fail "BACKUP_FETCH_CMD (containing %KEY%) is required for --verify and --check"
fi

# --- database access: read-only everywhere ------------------------------------------------------------------------------------------------------
dc_exec() { (cd "$COMPOSE_DIR" && docker compose exec -T "$@"); }
run_psql() { # reads SQL on stdin
  if [[ -n "${BACKUP_PSQL_CMD:-}" ]]; then PGOPTIONS="$READONLY_OPTS" ${BACKUP_PSQL_CMD}
  else dc_exec -e PGOPTIONS="$READONLY_OPTS" postgres psql -U admin_role -d infinicus -X -At; fi
}
run_pg_dump() {
  if [[ -n "${BACKUP_PG_DUMP_CMD:-}" ]]; then ${BACKUP_PG_DUMP_CMD}
  else dc_exec postgres pg_dump -U admin_role -d infinicus --format=custom --compress=6; fi
}
run_pg_roles() {
  if [[ -n "${BACKUP_PG_ROLES_CMD:-}" ]]; then ${BACKUP_PG_ROLES_CMD}
  else dc_exec postgres pg_dumpall -U admin_role --roles-only; fi
}
sub_key() { printf '%s' "${1//%KEY%/$2}"; }
sink() { local key="$1"; bash -c "$(sub_key "$BACKUP_SINK_CMD" "$key")"; }
fetch() { local key="$1"; bash -c "$(sub_key "$BACKUP_FETCH_CMD" "$key")"; }
valid_key() { [[ "$1" =~ ^[A-Za-z0-9._/:-]{1,300}$ && "$1" != *..* ]]; }

# --- prerequisites -----------------------------------------------------------------------------------------------------------------------------
PROBLEMS=0
check() { # check <name> <command...>
  local name="$1"; shift
  if "$@" >/dev/null 2>&1; then log "check ok:   $name"; else log "check FAIL: $name"; PROBLEMS=$((PROBLEMS + 1)); fi
}
first_word_exists() { command -v "${1%% *}" >/dev/null 2>&1; }
gpg --batch --list-keys "$BACKUP_GPG_RECIPIENT" >/dev/null 2>&1 || { log "check FAIL: gpg public key $BACKUP_GPG_RECIPIENT is not in the keyring"; PROBLEMS=$((PROBLEMS + 1)); }
check "gpg present" command -v gpg
check "sink command present" first_word_exists "$BACKUP_SINK_CMD"
[[ -n "${BACKUP_FETCH_CMD:-}" ]] && check "fetch command present" first_word_exists "$BACKUP_FETCH_CMD"
check "discovery script present" test -f "$DISCOVERY"
if [[ "$(printf 'select 1\n' | run_psql 2>/dev/null | tail -1)" == "1" ]]; then log "check ok:   database reachable (read-only SELECT 1)"; else log "check FAIL: database not reachable"; PROBLEMS=$((PROBLEMS + 1)); fi
mkdir -p "$TMP_BASE" "$STATE_DIR" 2>/dev/null || true
check "temp dir writable" test -w "$TMP_BASE"
check "state dir writable" test -w "$STATE_DIR"

DB_BYTES="$(printf 'select pg_database_size(current_database())\n' | run_psql 2>/dev/null | tail -1 || true)"
FREE_BYTES="$(df --output=avail -B1 "$TMP_BASE" 2>/dev/null | tail -1 | tr -d ' ' || true)"
if [[ "$DB_BYTES" =~ ^[0-9]+$ && "$FREE_BYTES" =~ ^[0-9]+$ ]]; then
  if (( FREE_BYTES > DB_BYTES * 2 )); then log "check ok:   free disk ${FREE_BYTES} B > 2 x database ${DB_BYTES} B"
  else log "check FAIL: free disk ${FREE_BYTES} B is not more than 2 x database size ${DB_BYTES} B"; PROBLEMS=$((PROBLEMS + 1)); fi
else
  log "check FAIL: could not determine database size or free disk"; PROBLEMS=$((PROBLEMS + 1))
fi

if [[ $MODE_CHECK -eq 1 ]]; then
  if (( PROBLEMS == 0 )); then log "CHECK PASSED: prerequisites satisfied (nothing was dumped, uploaded or written remotely)"; exit 0; fi
  log "CHECK FAILED: $PROBLEMS problem(s)"; exit 2
fi
(( PROBLEMS == 0 )) || fail "prerequisite checks failed ($PROBLEMS); run with --check to see them" 2

# --- the backup --------------------------------------------------------------------------------------------------------------------------------
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DAY="$(date -u +%Y-%m-%d)"
BASE_KEY="$PREFIX/$DAY/$STAMP-$LABEL"
valid_key "$BASE_KEY" || fail "derived object key is unsafe: $BASE_KEY"
WORK="$(mktemp -d "$TMP_BASE/run.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
chmod 700 "$WORK"

SERVER_VERSION="$(printf 'show server_version\n' | run_psql | tail -1)"
DB_NAME="$(printf 'select current_database()\n' | run_psql | tail -1)"
LEDGER="$(printf 'select count(*)||chr(124)||coalesce(max(filename),chr(45)) from public._migrations\n' | run_psql | tail -1)"
LEDGER_COUNT="${LEDGER%%|*}"; LEDGER_HEAD="${LEDGER#*|}"
[[ "$LEDGER_COUNT" =~ ^[0-9]+$ ]] || fail "could not read the migration ledger" 3
# values that go into manifest.json are restricted to a JSON-safe alphabet (no quotes, backslashes or control characters)
for v in "$SERVER_VERSION" "$DB_NAME" "$LEDGER_HEAD"; do [[ -n "$v" && ! "$v" =~ [^A-Za-z0-9._\ \(\)+:-] ]] || fail "a database-derived value is not manifest-safe: $v" 3; done
FINGERPRINT="$(INFINICUS_DISCOVERY_ONLY=fingerprint INFINICUS_DISCOVERY_PSQL="${BACKUP_PSQL_CMD:-}" COMPOSE_DIR="$COMPOSE_DIR" REPO_DIR="${REPO_DIR:-/opt/infinicus/repo}" bash "$DISCOVERY" 2>/dev/null | sed -n 's/^fingerprint-groups=.* combined-sha256-16=\([0-9a-f]\{16\}\)$/\1/p' | head -1)"
[[ "$FINGERPRINT" =~ ^[0-9a-f]{16}$ ]] || fail "could not compute the schema fingerprint" 3
HOST_NAME="$(hostname | tr -c 'A-Za-z0-9._-' '_')"
RECIPIENT_FPR="$(gpg --batch --with-colons --fingerprint "$BACKUP_GPG_RECIPIENT" 2>/dev/null | awk -F: '$1=="fpr"{print $10; exit}')"
[[ "$RECIPIENT_FPR" =~ ^[0-9A-F]{16,64}$ ]] || fail "could not resolve the recipient key fingerprint" 2

log "backup start: key prefix $BASE_KEY label=$LABEL ledger=$LEDGER_COUNT head=$LEDGER_HEAD fingerprint=$FINGERPRINT server=$SERVER_VERSION"

encrypt() { gpg --batch --yes --quiet --trust-model always --compress-algo none --encrypt --recipient "$BACKUP_GPG_RECIPIENT"; }
# pipefail makes a failing pg_dump/pg_dumpall/gpg fail the whole pipeline
run_pg_dump | encrypt > "$WORK/db.dump.gpg" || fail "database dump or encryption failed" 3
run_pg_roles | encrypt > "$WORK/roles.sql.gpg" || fail "roles dump or encryption failed" 3
[[ -s "$WORK/db.dump.gpg" && -s "$WORK/roles.sql.gpg" ]] || fail "an encrypted object is empty" 3

OBJ_JSON=""
for name in db.dump.gpg roles.sql.gpg; do
  key="$BASE_KEY/$name"; valid_key "$key" || fail "unsafe object key $key"
  sha="$(sha256sum "$WORK/$name" | cut -d' ' -f1)"; bytes="$(stat -c %s "$WORK/$name")"
  log "upload $key ($bytes bytes)"
  sink "$key" < "$WORK/$name" || fail "upload failed for $key" 4
  OBJ_JSON+="${OBJ_JSON:+,}{\"name\":\"$name\",\"bytes\":$bytes,\"sha256\":\"$sha\"}"
  if [[ $MODE_VERIFY -eq 1 ]]; then
    back="$(fetch "$key" | sha256sum | cut -d' ' -f1)" || fail "could not fetch $key back" 5
    [[ "$back" == "$sha" ]] || fail "verification FAILED for $key: uploaded $sha, fetched $back" 5
    log "verified   $key"
  fi
done

MANIFEST="{\"format\":1,\"created_utc\":\"$STAMP\",\"label\":\"$LABEL\",\"host\":\"$HOST_NAME\",\"database\":\"$DB_NAME\",\"pg_server_version\":\"$SERVER_VERSION\",\"ledger_count\":$LEDGER_COUNT,\"ledger_head\":\"$LEDGER_HEAD\",\"schema_fingerprint\":\"$FINGERPRINT\",\"gpg_recipient_fingerprint\":\"$RECIPIENT_FPR\",\"verified_after_upload\":$([[ $MODE_VERIFY -eq 1 ]] && echo true || echo false),\"objects\":[$OBJ_JSON]}"
printf '%s\n' "$MANIFEST" > "$WORK/manifest.json"
sink "$BASE_KEY/manifest.json" < "$WORK/manifest.json" || fail "manifest upload failed" 4
log "manifest uploaded: $BASE_KEY/manifest.json"

mkdir -p "$STATE_DIR" && printf '{"finished_utc":"%s","key":"%s/manifest.json","label":"%s","ledger_head":"%s","schema_fingerprint":"%s","verified":%s}\n' \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$BASE_KEY" "$LABEL" "$LEDGER_HEAD" "$FINGERPRINT" "$([[ $MODE_VERIFY -eq 1 ]] && echo true || echo false)" > "$STATE_DIR/last-success.json"
log "BACKUP COMPLETE: $BASE_KEY (encrypted; restore proof still required to call it recoverable)"
