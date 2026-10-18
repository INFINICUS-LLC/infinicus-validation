#!/usr/bin/env bash
# Synthetic end-to-end backup + restore rehearsal (H-5B acceptance). SYNTHETIC DATA ONLY.
#
# Runs the REAL backup-offsite.sh and restore-proof.sh against ONE disposable PostgreSQL server:
#   1. validates the target (fail-closed rules of restore-proof.sh);
#   2. creates a synthetic source database (migration ledger, tables, an owner role, a marker row);
#   3. creates throwaway gpg keys (public key for the backup side, private key for the restore side);
#   4. backup-offsite.sh --check, then the encrypted backup with --verify, into a local directory standing in for the bucket;
#   5. DROPS the synthetic source database and owner role (disaster simulation), then runs restore-proof.sh;
#   6. checks the restored data and that the owner role came back from roles.sql;
#   7. corrupts one encrypted object and checks that the restore is REFUSED and leaves no scratch database;
#   8. removes everything it created.
# It never touches a database it did not create (names h5b_synth_*) and refuses to run unless the target passes restore-proof.sh --validate-target.
#
# Usage:  RESTORE_ADMIN_URL=postgresql://<superuser>@127.0.0.1:<port>/postgres [RESTORE_EXPECT_SYSTEM_IDENTIFIER=<id>] synthetic-rehearsal.sh
# Needs:  bash, psql, pg_dump, pg_dumpall, pg_restore (server major version), gpg, sha256sum. No password may be in the URL.
# Result: the last line is H5B_REHEARSAL=PASS or H5B_REHEARSAL=FAIL (<reason>). Exit 0 only on PASS.

set -euo pipefail
umask 077
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BK="$(cd "$HERE/.." && pwd)"
ADMIN="${RESTORE_ADMIN_URL:?RESTORE_ADMIN_URL is required}"
SRC=h5b_synth_src; DST=h5b_synth_restore; OWNER=h5b_synth_owner
MARK="SYNTHETIC-CUSTOMER-$(date -u +%s)"
FAIL=""; W=""

die() { echo "H5B_REHEARSAL=FAIL ($1)"; exit 1; }
step() { printf '\n== %s\n' "$1"; }
dburl() { printf '%s' "$ADMIN" | sed -E "s#/[^/?]*(\?|$)#/$1\1#"; }
q() { psql "$(dburl "$1")" -X -At -v ON_ERROR_STOP=1 -c "$2"; }
cleanup() {
  local rc=$?
  psql "$ADMIN" -X -q -c "DROP DATABASE IF EXISTS $DST" >/dev/null 2>&1 || true
  psql "$ADMIN" -X -q -c "DROP DATABASE IF EXISTS $SRC" >/dev/null 2>&1 || true
  psql "$ADMIN" -X -q -c "DROP ROLE IF EXISTS $OWNER" >/dev/null 2>&1 || true
  [[ -z "$W" ]] || rm -rf "$W"
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT; trap 'exit 143' TERM

command -v gpg >/dev/null 2>&1 || die "gpg is not installed (in a postgres container: apt-get update && apt-get install -y gnupg)"

step "1. target validation (fail-closed)"
bash "$BK/restore-proof.sh" --validate-target || die "the target was refused; nothing was created"
for d in "$SRC" "$DST"; do [[ -z "$(q postgres "select 1 from pg_database where datname='$d'")" ]] || die "database $d already exists; refusing to touch it"; done
[[ -z "$(q postgres "select 1 from pg_roles where rolname='$OWNER'")" ]] || die "role $OWNER already exists; refusing to touch it"
MAJOR="$(q postgres "select (current_setting('server_version_num')::int/10000)")"

step "2. synthetic source database"
q postgres "CREATE ROLE $OWNER NOLOGIN" >/dev/null
q postgres "CREATE DATABASE $SRC OWNER $OWNER" >/dev/null
psql "$(dburl "$SRC")" -X -q -v ON_ERROR_STOP=1 <<SQL
CREATE TABLE public._migrations (id serial primary key, filename text not null unique);
INSERT INTO public._migrations (filename) VALUES ('0001_foundation.sql'), ('0170_add_approved_action_source_recommendation.sql');
CREATE SCHEMA tenancy AUTHORIZATION $OWNER;
CREATE TABLE tenancy.customers (id serial primary key, name text not null);
ALTER TABLE tenancy.customers OWNER TO $OWNER;
INSERT INTO tenancy.customers (name) VALUES ('$MARK');
CREATE SCHEMA events; CREATE TABLE events.outbox_events (id serial primary key, event_type text not null, status text not null default 'pending');
INSERT INTO events.outbox_events (event_type) VALUES ('a.done'),('a.done'),('a.done'),('b.changed'),('b.changed');
CREATE SCHEMA audit; CREATE TABLE audit.audit_events (id serial primary key);
CREATE SCHEMA business_operations; CREATE TABLE business_operations.purchase_orders (id serial primary key);
SQL

step "3. throwaway gpg keys (public on the backup side, private on the restore side)"
W="$(mktemp -d)"; mkdir -p "$W/gpg-restore" "$W/gpg-backup" "$W/sink" "$W/state" "$W/tmp"; chmod 700 "$W/gpg-restore" "$W/gpg-backup"
RCPT="h5b-synth-$$@example.test"
cat > "$W/key.batch" <<EOF
%no-protection
Key-Type: eddsa
Key-Curve: ed25519
Subkey-Type: ecdh
Subkey-Curve: cv25519
Subkey-Usage: encrypt
Name-Real: h5b-synthetic
Name-Email: $RCPT
Expire-Date: 0
%commit
EOF
gpg --batch --quiet --homedir "$W/gpg-restore" --gen-key "$W/key.batch" 2>/dev/null || die "gpg key generation failed"
gpg --batch --homedir "$W/gpg-restore" --export "$RCPT" > "$W/pub.gpg"
gpg --batch --quiet --homedir "$W/gpg-backup" --import "$W/pub.gpg" 2>/dev/null || die "gpg public key import failed"

step "4. encrypted backup (real backup-offsite.sh): --check then --verify"
SRCURL="$(dburl "$SRC")"
export BACKUP_ENV_FILE="$W/none.env" BACKUP_GPG_RECIPIENT="$RCPT" BACKUP_GNUPGHOME="$W/gpg-backup"
export BACKUP_SINK_CMD="mkdir -p \"\$(dirname '$W/sink/%KEY%')\" && cat > '$W/sink/%KEY%'"
export BACKUP_FETCH_CMD="cat '$W/sink/%KEY%'"
export BACKUP_PG_DUMP_CMD="pg_dump -d $SRCURL --format=custom --compress=6"
export BACKUP_PG_ROLES_CMD="pg_dumpall -d $SRCURL --roles-only"
export BACKUP_PSQL_CMD="psql $SRCURL -X -At"
export BACKUP_STATE_DIR="$W/state" BACKUP_TMP_DIR="$W/tmp" BACKUP_PREFIX=h5b-synthetic BACKUP_LABEL=synthetic-h5b
export BACKUP_PG_DUMP_VERSION_CMD="pg_dump --version" BACKUP_PG_RESTORE_VERSION_CMD="pg_restore --version" BACKUP_EXPECT_PG_MAJOR="$MAJOR"
bash "$BK/backup-offsite.sh" --check || die "backup preflight failed"
bash "$BK/backup-offsite.sh" --verify || die "backup or verification failed"
MANIFEST="$(cd "$W/sink" && find . -name manifest.json -type f | sed 's#^\./##' | sort | tail -1)"
[[ -n "$MANIFEST" ]] || die "no manifest was produced"
echo "manifest key: $MANIFEST"; ls -l "$W/sink/$(dirname "$MANIFEST")" | sed 's/^/  /'
grep -aq "$MARK" "$W"/sink/"$(dirname "$MANIFEST")"/* && die "the synthetic marker is readable in an encrypted artifact"
FP="$(sed -n 's/.*"schema_fingerprint": *"\([^"]*\)".*/\1/p' "$W/sink/$MANIFEST" | head -1)"
[[ -n "$FP" ]] || die "the manifest has no schema fingerprint"
cat > "$W/expectations.profile" <<EOF
# synthetic profile
ledger_count=2
ledger_head=0170_add_approved_action_source_recommendation.sql
schema_fingerprint=$FP
count tenancy.customers=1
count events.outbox_events=5
outbox a.done=3
outbox b.changed=2
count audit.audit_events=0
count business_operations.purchase_orders=0
EOF

step "5. disaster simulation: drop the source database and its owner role, then restore"
q postgres "DROP DATABASE $SRC" >/dev/null; q postgres "DROP ROLE $OWNER" >/dev/null
[[ -z "$(q postgres "select 1 from pg_roles where rolname='$OWNER'")" ]] || die "the owner role was not removed"
export RESTORE_GNUPGHOME="$W/gpg-restore" RESTORE_DB_NAME="$DST" RESTORE_EXPECTATIONS="$W/expectations.profile"
OUT="$(bash "$BK/restore-proof.sh" --keep "$MANIFEST" 2>&1)" || { echo "$OUT" | tail -5; die "restore-proof.sh did not pass"; }
echo "$OUT" | tail -3
echo "$OUT" | grep -q '^RESTORE_PROOF=PASS' || die "no RESTORE_PROOF=PASS line"

step "6. restored data and roles"
[[ "$(q "$DST" "select count(*) from tenancy.customers where name='$MARK'")" == 1 ]] || die "the synthetic customer row was not restored"
[[ "$(q "$DST" "select count(*) from events.outbox_events")" == 5 ]] || die "outbox rows were not restored"
[[ "$(q "$DST" "select count(*) from public._migrations")" == 2 ]] || die "ledger rows were not restored"
[[ "$(q postgres "select 1 from pg_roles where rolname='$OWNER'")" == 1 ]] || die "the owner role did not come back from roles.sql"
[[ "$(q "$DST" "select tableowner from pg_tables where tablename='customers' and schemaname='tenancy'")" == "$OWNER" ]] || die "table ownership was not preserved"
[[ "$(q postgres "select rolsuper from pg_roles where rolname=current_user")" == t ]] || die "the connecting role lost superuser"
echo "restored: 1 customer row, 5 outbox rows, 2 ledger rows, owner role and ownership preserved, connecting role still superuser"

step "7. tampered artifact must be refused"
q postgres "DROP DATABASE $DST" >/dev/null
DUMP="$(cd "$W/sink" && find "$(dirname "$MANIFEST")" -type f ! -name manifest.json | sort | head -1)"
printf 'X' | dd of="$W/sink/$DUMP" bs=1 seek=40 conv=notrunc status=none
if OUT2="$(bash "$BK/restore-proof.sh" "$MANIFEST" 2>&1)"; then die "a tampered artifact was NOT refused"; fi
echo "$OUT2" | grep -q '^RESTORE_PROOF=FAIL' || die "the tampered restore did not report RESTORE_PROOF=FAIL"
echo "$OUT2" | tail -1
[[ -z "$(q postgres "select 1 from pg_database where datname='$DST'")" ]] || die "a scratch database was left behind after the refused restore"

echo
echo "H5B_REHEARSAL=PASS (synthetic: encrypted backup verified, restore proof PASS after dropping the source, data and roles restored, tampered artifact refused, nothing left behind)"
