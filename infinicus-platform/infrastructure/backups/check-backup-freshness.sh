#!/usr/bin/env bash
# Freshness check for the off-VM backup (read-only). Intended for cron / a systemd timer / an uptime monitor.
# Reads the state file written by backup-offsite.sh after every successful run.
# Exit: 0 fresh; 1 warning (older than BACKUP_WARN_HOURS, default 26); 2 critical (older than BACKUP_CRIT_HOURS, default 50, or missing/unreadable).
set -euo pipefail
STATE_DIR="${BACKUP_STATE_DIR:-/var/lib/infinicus-backup}"
WARN_H="${BACKUP_WARN_HOURS:-26}"; CRIT_H="${BACKUP_CRIT_HOURS:-50}"
f="$STATE_DIR/last-success.json"
[[ -r "$f" ]] || { echo "CRITICAL: no successful backup recorded ($f missing)"; exit 2; }
fin="$(sed -n 's/.*"finished_utc":"\([^"]*\)".*/\1/p' "$f" | head -1)"
[[ "$fin" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:]{8}Z$ ]] || { echo "CRITICAL: state file has no valid finished_utc"; exit 2; }
age_h=$(( ( $(date -u +%s) - $(date -u -d "$fin" +%s) ) / 3600 ))
key="$(sed -n 's/.*"key":"\([^"]*\)".*/\1/p' "$f" | head -1)"
if (( age_h >= CRIT_H )); then echo "CRITICAL: last successful backup ${age_h}h ago ($key)"; exit 2; fi
if (( age_h >= WARN_H )); then echo "WARNING: last successful backup ${age_h}h ago ($key)"; exit 1; fi
echo "OK: last successful backup ${age_h}h ago ($key)"
