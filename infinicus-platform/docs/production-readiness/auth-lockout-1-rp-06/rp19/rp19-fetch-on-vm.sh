#!/usr/bin/env bash
# AUTH-LOCKOUT-1.RP-19 step 1 — owner-run, on infinicus-prod-01 as the deploy user. Fetches the three ENCRYPTED objects of ONE explicitly named backup
# from the offsite store into a private directory, using the settings the backup unit already uses. It writes nothing to the store, never decrypts
# (the VM holds no private key), never connects to the database and never prints the contents of backup.env.
# Usage:  bash rp19-fetch-on-vm.sh <backup-prefix> [output-dir]
#   <backup-prefix>  the authorized backup, e.g. infinicus-production/2026-10-28/20261028T023834Z-daily  (no default on purpose)
set -euo pipefail
umask 077
[[ "$-" != *x* ]] || { echo "refusing: shell tracing would print secrets"; exit 2; }
KEY="${1:-}"; OUT="${2:-$HOME/rp19-objects}"
[[ -n "$KEY" && "$KEY" =~ ^[A-Za-z0-9._/:-]{1,300}$ && "$KEY" != *..* && "$KEY" != */ && "$KEY" != /* ]] || { echo "usage: $0 <authorized-backup-prefix> [output-dir]"; exit 2; }
ENVF="${BACKUP_ENV_FILE:-/etc/infinicus/backup.env}"
[[ -r "$ENVF" ]] || { echo "cannot read the backup settings file (path not printed)"; exit 2; }
set -a; . "$ENVF"; set +a
[[ -n "${BACKUP_FETCH_CMD:-}" && "$BACKUP_FETCH_CMD" == *%KEY%* ]] || { echo "BACKUP_FETCH_CMD with %KEY% is not defined in the settings file"; exit 2; }
echo "RP-19 fetch  utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)  host=$(hostname)  user=$(id -un)  prefix=$KEY"
mkdir -p "$OUT/$KEY"
for o in manifest.json db.dump.gpg roles.sql.gpg; do
  cmd="${BACKUP_FETCH_CMD//%KEY%/$KEY/$o}"
  if ! bash -c "$cmd" > "$OUT/$KEY/$o" 2>/dev/null || [[ ! -s "$OUT/$KEY/$o" ]]; then echo "FETCH FAILED: $o (nothing else was fetched)"; exit 1; fi
done
echo "--- objects (metadata only)"; ls -l "$OUT/$KEY"; sha256sum "$OUT/$KEY"/*.gpg | sed "s#$OUT/##"
echo "--- manifest summary (no secrets by design)"
python3 -I - "$OUT/$KEY" <<'PY'
import hashlib, json, os, sys
d = sys.argv[1]; m = json.load(open(os.path.join(d, "manifest.json")))
for k in ("created_utc","label","host","pg_server_version","verified_after_upload","ledger_count","ledger_head","schema_fingerprint"):
    print(f"{k:22} {m.get(k)}")
bad = 0
for o in m.get("objects", []):
    h = hashlib.sha256(open(os.path.join(d, o["name"]), "rb").read()).hexdigest()
    ok = h == o["sha256"]; bad += not ok
    print(f"object {o['name']:14} sha256 {'MATCHES manifest' if ok else 'DIFFERS FROM MANIFEST'}")
sys.exit(1 if bad else 0)
PY
echo "FETCH_OK  next: copy '$OUT' to the restore host (scp -r), then run rp19-restore-proof-host.sh there. Delete '$OUT' from the VM afterwards."
