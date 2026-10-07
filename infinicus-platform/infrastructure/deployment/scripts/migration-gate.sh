#!/usr/bin/env bash
# BUILD-23 — Migration gate: a promotion to any environment must not
# proceed unless its database is successfully migrated first. Reuses
# BUILD-22's advisory-locked runMigrations() directly (not a
# reimplementation) — a concurrent deploy racing against this same gate
# is exactly the scenario that lock protects against.
#
# Exit code: 0 if migrations applied (or were already up to date),
# non-zero on any migration failure — a CI/deploy pipeline should treat
# non-zero here as a hard stop, never proceeding to promote traffic to
# the new version.
#
# Usage:
#   DATABASE_URL="postgresql://<admin-role>:<pw>@<host>:5432/<db>" \
#     ./migration-gate.sh

set -euo pipefail

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "ERROR: DATABASE_URL is required" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIST_INDEX="$SCRIPT_DIR/../../../packages/database/dist/index.js"

if [[ ! -f "$DIST_INDEX" ]]; then
  echo "ERROR: $DIST_INDEX not found — build @infinicus/database first (pnpm --filter @infinicus/database build)" >&2
  exit 1
fi

echo "Running migration gate against target database ..."
node -e "
  const { createPool, runMigrations, closePool } = require('$DIST_INDEX');
  createPool({ connectionString: process.env.DATABASE_URL });
  runMigrations()
    .then(() => closePool())
    .then(() => { process.stdout.write('Migration gate passed.\\n', () => process.exit(0)); })
    .catch((err) => { console.error('Migration gate FAILED:', err); process.exit(1); });
"
