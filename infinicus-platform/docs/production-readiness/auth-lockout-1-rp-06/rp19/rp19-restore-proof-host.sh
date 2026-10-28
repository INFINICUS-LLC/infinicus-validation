#!/usr/bin/env bash
# AUTH-LOCKOUT-1.RP-19 step 2 — owner-run on the RESTORE HOST (never the production VM): runs the repository's restore-proof.sh against ONE named
# backup on a THROWAWAY, loopback-only, disposable PostgreSQL, and writes a redacted evidence file. It never touches production and prints no secret.
# The private key passphrase is typed at gpg's own prompt; nothing here reads, stores or prints it.
#
# Usage:
#   bash rp19-restore-proof-host.sh --repo DIR --objects DIR --prefix KEY --key-file FILE [--mode docker|native] [--evidence FILE]
#     --repo       a clone of INFINICUS-LLC/infinicus-validation at main (or newer) than 01973fd3
#     --objects    the directory copied from the VM (contains KEY/manifest.json, db.dump.gpg, roles.sql.gpg)
#     --prefix     the authorized backup prefix (same value used on the VM)
#     --key-file   the offline PRIVATE key file (armored). docker mode only (mounted read-only into the container)
#   docker mode (default): starts postgres:16-bookworm with --network none, marked disposable, and runs the proof inside it (as on 2026-10-21).
#   native mode: uses RESTORE_ADMIN_URL and RESTORE_GNUPGHOME from the environment (a disposable server you provisioned; the script validates it).
# Profile selection is automatic and conservative: ledger_head 0209_create_print_jobs.sql -> production-pre-0210.profile. Any other head is REFUSED
# (a reviewed profile for that state is required; this script never invents expectations and never edits a profile).
set -euo pipefail
umask 077
[[ "$-" != *x* ]] || { echo "refusing: shell tracing"; exit 2; }
REPO=""; OBJ=""; KEY=""; KEYFILE=""; MODE=docker; EVID="rp19-restore-proof-$(date -u +%Y%m%dT%H%M%SZ).txt"
while (( $# )); do case "$1" in
  --repo) REPO="$2"; shift 2;; --objects) OBJ="$2"; shift 2;; --prefix) KEY="$2"; shift 2;; --key-file) KEYFILE="$2"; shift 2;;
  --mode) MODE="$2"; shift 2;; --evidence) EVID="$2"; shift 2;; *) echo "unknown argument: $1"; exit 2;; esac; done
[[ -d "$REPO" && -d "$OBJ" && -n "$KEY" ]] || { sed -n 2,16p "$0"; exit 2; }
[[ "$KEY" =~ ^[A-Za-z0-9._/:-]{1,300}$ && "$KEY" != *..* ]] || { echo "bad --prefix"; exit 2; }
REPO="$(cd "$REPO" && pwd)"; OBJ="$(cd "$OBJ" && pwd)"
P="$REPO/infinicus-platform/infrastructure/backups"
for f in "$P/restore-proof.sh" "$P/expectations/production-pre-0210.profile" "$OBJ/$KEY/manifest.json" "$OBJ/$KEY/db.dump.gpg" "$OBJ/$KEY/roles.sql.gpg"; do
  [[ -f "$f" ]] || { echo "missing: ${f#$REPO/}"; exit 2; }
done
grep -q restored_fingerprint "$P/restore-proof.sh" || { echo "restore-proof.sh in this clone cannot read restored_fingerprint (old copy); use main"; exit 2; }
HEAD_L="$(python3 -I -c 'import json,sys;print(json.load(open(sys.argv[1])).get("ledger_head"))' "$OBJ/$KEY/manifest.json")"
case "$HEAD_L" in
  0209_create_print_jobs.sql) PROFILE=production-pre-0210.profile;;
  *) echo "REFUSED: backup ledger_head is '$HEAD_L'. Only 0209_create_print_jobs.sql has a reviewed profile (production-pre-0210.profile). A backup from another schema state needs a new reviewed profile first; do not edit one to make it pass."; exit 3;;
esac
{
echo "RP-19 RESTORE PROOF EVIDENCE"
echo "utc-start   $(date -u +%Y-%m-%dT%H:%M:%SZ)   mode=$MODE   operator=$(id -un)   restore-host=$(hostname)"
echo "repo-head   $(git -C "$REPO" rev-parse HEAD 2>/dev/null || echo unknown)"
echo "backup      $KEY   ledger_head=$HEAD_L   profile=$PROFILE"
echo "sha256      $(sha256sum "$P/restore-proof.sh" | cut -c1-64)  restore-proof.sh"
echo "sha256      $(sha256sum "$P/expectations/$PROFILE" | cut -c1-64)  $PROFILE"
echo "sha256      $(sha256sum "$OBJ/$KEY/db.dump.gpg" | cut -c1-64)  db.dump.gpg"
echo "sha256      $(sha256sum "$OBJ/$KEY/roles.sql.gpg" | cut -c1-64)  roles.sql.gpg"
echo "-----"
} | tee "$EVID"
run_proof() { # runs inside the environment that has gpg, psql, pg_restore and a disposable RESTORE_ADMIN_URL
  local pp="$1" objs="$2" repo="$3"
  export BACKUP_FETCH_CMD="cat $objs/%KEY%"
  for t in gpg psql pg_restore python3; do command -v $t >/dev/null || { echo "RESTORE_PROOF=FAIL (tool missing: $t)"; return 2; }; done
  bash "$pp/restore-proof.sh" --validate-target || return $?
  RESTORE_REPO_DIR="$repo" RESTORE_EXPECTATIONS="$pp/expectations/$PROFILE" bash "$pp/restore-proof.sh" "$KEY/manifest.json"
}
rc=0
if [[ "$MODE" == native ]]; then
  [[ -n "${RESTORE_ADMIN_URL:-}" && -n "${RESTORE_GNUPGHOME:-}" ]] || { echo "native mode needs RESTORE_ADMIN_URL and RESTORE_GNUPGHOME"; exit 2; }
  set +e; ( run_proof "$P" "$OBJ" "$REPO" ) 2>&1 | tee -a "$EVID"; rc=${PIPESTATUS[0]}; set -e
elif [[ "$MODE" == docker ]]; then
  [[ -f "$KEYFILE" ]] || { echo "docker mode needs --key-file"; exit 2; }
  command -v docker >/dev/null || { echo "docker is not installed"; exit 2; }
  CN="rp19-restore-$$"
  cleanup() { docker rm -f "$CN" >/dev/null 2>&1 || true; }; trap cleanup EXIT INT TERM HUP
  docker run -d --rm --name "$CN" --network none -v "$REPO:/repo:ro" -v "$OBJ:/objects:ro" -v "$KEYFILE:/key/offline.asc:ro" \
    -e POSTGRES_HOST_AUTH_METHOD=trust postgres:16-bookworm -c infinicus.restore_target=disposable >/dev/null
  for _ in $(seq 1 60); do docker exec "$CN" pg_isready -q -h 127.0.0.1 && break; sleep 1; done
  docker exec "$CN" pg_isready -q -h 127.0.0.1 || { echo "RESTORE_PROOF=FAIL (throwaway server did not start)" | tee -a "$EVID"; exit 1; }
  FN="$(declare -f run_proof)"
  echo "-- importing the private key inside the container: gpg will ask for the passphrase"
  set +e
  docker exec -it -e PROFILE="$PROFILE" -e KEY="$KEY" "$CN" bash -c '
    set -e
    export RESTORE_GNUPGHOME=$(mktemp -d); chmod 700 "$RESTORE_GNUPGHOME"
    gpg --homedir "$RESTORE_GNUPGHOME" --import /key/offline.asc
    export RESTORE_ADMIN_URL=postgresql://postgres@127.0.0.1:5432/postgres
    '"$FN"'
    run_proof /repo/infinicus-platform/infrastructure/backups /objects /repo' 2>&1 | tee -a "$EVID"; rc=${PIPESTATUS[0]}; set -e
else echo "--mode must be docker or native"; exit 2; fi
{ echo "-----"; echo "utc-end     $(date -u +%Y-%m-%dT%H:%M:%SZ)"; } | tee -a "$EVID"
if grep -q '^RESTORE_PROOF=PASS' "$EVID"; then echo "RP19_RESULT=PASS (restore proof for $KEY; evidence: $EVID)" | tee -a "$EVID"; else echo "RP19_RESULT=NOT PASS (see lines above; do not edit the profile; evidence: $EVID)" | tee -a "$EVID"; rc=1; fi
echo "Disposal: container is removed on exit; delete '$OBJ' and any temporary copy of the key file; record the times."
exit $rc
