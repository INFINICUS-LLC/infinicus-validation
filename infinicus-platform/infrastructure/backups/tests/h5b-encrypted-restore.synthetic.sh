#!/usr/bin/env bash
# H-5B: real encrypted synthetic backup -> restore-proof.sh -> positive and integrity-negative proofs.
# Run ONLY against an independently provisioned disposable PostgreSQL 16 cluster, isolated from production.
# Requires bash, psql, pg_dump, pg_restore, gpg, sha256sum, python3 and the repository discovery script.
# RESTORE_ADMIN_URL and RESTORE_EXPECT_SYSTEM_IDENTIFIER must be set by the operator.
set -euo pipefail
umask 077
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DISCOVERY="$ROOT/../deployment/scripts/production-readonly-discovery.sh"
[[ -f "$DISCOVERY" ]] || { echo "H5B=FAIL missing discovery script"; exit 2; }
[[ -n "${RESTORE_ADMIN_URL:-}" && -n "${RESTORE_EXPECT_SYSTEM_IDENTIFIER:-}" ]] || { echo "H5B=FAIL target URL and system identifier required"; exit 2; }
for tool in bash psql pg_dump pg_restore gpg sha256sum python3; do command -v "$tool" >/dev/null || { echo "H5B=FAIL missing $tool"; exit 2; }; done
# Validate the target before creating ANY fixture data.
bash "$ROOT/restore-proof.sh" --validate-target
TMP="$(mktemp -d "${TMPDIR:-/tmp}/h5b-synthetic.XXXXXXXX")"
chmod 700 "$TMP"
SOURCE="h5b_synthetic_source"
TARGET="h5b_synthetic_restored"
STORE="$TMP/objects/h5b"
mkdir -p "$STORE" "$TMP/gnupg"
chmod 700 "$TMP/gnupg"
cleanup() {
  # Never drop a DB unless this run created it; and only on an attested disposable cluster.
  if [[ "${CREATED_TARGET:-0}" == 1 ]]; then psql "$RESTORE_ADMIN_URL" -X -q -c "DROP DATABASE IF EXISTS $TARGET" >/dev/null 2>&1 || true; fi
  if [[ "${CREATED_SOURCE:-0}" == 1 ]]; then psql "$RESTORE_ADMIN_URL" -X -q -c "DROP DATABASE IF EXISTS $SOURCE" >/dev/null 2>&1 || true; fi
  rm -rf "$TMP"
}
trap cleanup EXIT
for db in "$SOURCE" "$TARGET"; do
  present="$(psql "$RESTORE_ADMIN_URL" -X -At -v ON_ERROR_STOP=1 -c "SELECT 1 FROM pg_database WHERE datname = '$db'")"
  [[ -z "$present" ]] || { echo "H5B=FAIL $db exists; refusing to touch"; exit 2; }
done
psql "$RESTORE_ADMIN_URL" -X -q -v ON_ERROR_STOP=1 -c "CREATE DATABASE $SOURCE"
CREATED_SOURCE=1
SOURCE_URL="${RESTORE_ADMIN_URL%/postgres}/$SOURCE"
# RESTORE_ADMIN_URL must end in /postgres for this synthetic fixture, with no URL query.
[[ "$RESTORE_ADMIN_URL" == */postgres ]] || { echo "H5B=FAIL fixture requires RESTORE_ADMIN_URL ending /postgres"; exit 2; }
psql "$SOURCE_URL" -X -q -v ON_ERROR_STOP=1 <<'SQL'
CREATE TABLE public._migrations (filename text PRIMARY KEY);
INSERT INTO public._migrations VALUES ('0001_h5b_synthetic.sql');
CREATE TABLE public.synthetic_orders (id integer PRIMARY KEY, amount_minor bigint NOT NULL);
INSERT INTO public.synthetic_orders VALUES (1, 125500), (2, 89750), (3, 240000);
CREATE SCHEMA events;
CREATE TABLE events.outbox_events (id bigint PRIMARY KEY, event_type text NOT NULL);
INSERT INTO events.outbox_events VALUES (1, 'synthetic.sale.created'), (2, 'synthetic.sale.created');
SQL
pg_dump --dbname="$SOURCE_URL" -Fc --no-owner --no-acl -f "$TMP/db.dump"
printf '%s\n' '-- H-5B synthetic roles fixture: deliberately no global role mutations' > "$TMP/roles.sql"
FP="$(INFINICUS_DISCOVERY_ONLY=fingerprint INFINICUS_DISCOVERY_PSQL="psql $SOURCE_URL" REPO_DIR="${RESTORE_REPO_DIR:-$ROOT/../../..}" bash "$DISCOVERY" 2>/dev/null | sed -n 's/^fingerprint-groups=.* combined-sha256-16=\([0-9a-f]\{16\}\)$/\1/p' | head -1)"
[[ "$FP" =~ ^[0-9a-f]{16}$ ]] || { echo "H5B=FAIL cannot compute canonical schema fingerprint"; exit 1; }
cat > "$TMP/expectations.profile" <<EOF
ledger_count=1
ledger_head=0001_h5b_synthetic.sql
schema_fingerprint=$FP
count public.synthetic_orders=3
count events.outbox_events=2
outbox synthetic.sale.created=2
EOF
GNUPGHOME="$TMP/gnupg" gpg --batch --quiet --passphrase '' --quick-generate-key "H5B Synthetic Restore <h5b@example.invalid>" default default never
RECIPIENT="$(GNUPGHOME="$TMP/gnupg" gpg --batch --with-colons --list-keys | awk -F: '$1=="fpr" {print $10; exit}')"
[[ -n "$RECIPIENT" ]] || { echo "H5B=FAIL no synthetic encryption key"; exit 1; }
for name in db.dump roles.sql; do
  GNUPGHOME="$TMP/gnupg" gpg --batch --yes --quiet --trust-model always --recipient "$RECIPIENT" --encrypt --output "$STORE/$name.gpg" "$TMP/$name"
done
DB_SHA="$(sha256sum "$STORE/db.dump.gpg" | cut -d' ' -f1)"
ROLE_SHA="$(sha256sum "$STORE/roles.sql.gpg" | cut -d' ' -f1)"
# Single-line object entries follow the restore script's current manifest reader contract.
cat > "$STORE/manifest.json" <<EOF
{"schema_fingerprint":"$FP","ledger_head":"0001_h5b_synthetic.sql","ledger_count":1,"pg_server_version":"16","objects":[{"name":"db.dump.gpg","sha256":"$DB_SHA"},{"name":"roles.sql.gpg","sha256":"$ROLE_SHA"}]}
EOF
export BACKUP_FETCH_CMD="cat $TMP/objects/%KEY%"
export RESTORE_GNUPGHOME="$TMP/gnupg"
export RESTORE_EXPECTATIONS="$TMP/expectations.profile"
export RESTORE_DB_NAME="$TARGET"
export RESTORE_REPO_DIR="${RESTORE_REPO_DIR:-$ROOT/../../..}"
# The real script normally removes the scratch database on exit; --keep permits independent comparison.
bash "$ROOT/restore-proof.sh" h5b/manifest.json --keep
CREATED_TARGET=1
RESULT="$(psql "${RESTORE_ADMIN_URL%/postgres}/$TARGET" -X -At -v ON_ERROR_STOP=1 -c 'SELECT count(*)::text || chr(124) || sum(amount_minor)::text FROM public.synthetic_orders')"
[[ "$RESULT" == "3|455250" ]] || { echo "H5B=FAIL restored rows do not match: $RESULT"; exit 1; }
echo "H5B_ENCRYPTED_RESTORE=PASS"
# Negative test: corrupt the ciphertext and require SHA-256 rejection before decryption/restore.
printf '\ncorrupted' >> "$STORE/db.dump.gpg"
set +e
NEG_OUTPUT="$(bash "$ROOT/restore-proof.sh" h5b/manifest.json 2>&1)"
NEG_RC=$?
set -e
if [[ "$NEG_RC" -eq 0 || "$NEG_OUTPUT" != *"SHA-256 mismatch for db.dump.gpg"* ]]; then
  echo "H5B_CORRUPT_ARTIFACT=FAIL"
  exit 1
fi
echo "H5B_CORRUPT_ARTIFACT=PASS"
echo "H5B=PASS (synthetic encrypted restore and integrity-negative test)"
