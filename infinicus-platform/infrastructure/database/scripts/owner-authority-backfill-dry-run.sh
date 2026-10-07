#!/usr/bin/env bash
# Owner approval-authority backfill — DRY RUN ONLY.
#
# Classifies every existing business and reports what a backfill of the
# `business-owner-approver` assignment WOULD do. It never writes: the whole
# run is a single READ ONLY transaction, so the database itself rejects any
# write. Executing grants is a separate step that requires explicit owner
# authorisation and is NOT implemented here.
#
# Classes: PROVEN (eligible for grant) | ALREADY_ASSIGNED | AMBIGUOUS
#          (several valid owners) | UNPROVEN (insufficient evidence; tenant-wide
#          owners are listed as "CANDIDATE — NOT AUTO-GRANTED") |
#          INVALID_INACTIVE (ownership/membership/business not active).
#
# Usage:
#   ADMIN_DATABASE_URL=postgresql://... \
#     infrastructure/database/scripts/owner-authority-backfill-dry-run.sh [report.json]
#
# Needs an operator connection that can enumerate tenants (ADMIN_DATABASE_URL, not the
# application role), and @infinicus/database built. The JSON report goes to the file given
# (default: owner-authority-dry-run-<timestamp>.json in the current directory); a human summary
# goes to stdout. User ids are included; emails and secrets never are.
set -euo pipefail

if [[ -z "${ADMIN_DATABASE_URL:-}" ]]; then
  echo "ERROR: ADMIN_DATABASE_URL is required (an operator connection able to enumerate tenants)" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIST_INDEX="$SCRIPT_DIR/../../../packages/database/dist/index.js"
if [[ ! -f "$DIST_INDEX" ]]; then
  echo "ERROR: $DIST_INDEX not found — build @infinicus/database first (pnpm --filter @infinicus/database build)" >&2
  exit 1
fi

OUT="${1:-owner-authority-dry-run-$(date -u +%Y%m%dT%H%M%SZ).json}"
export DRY_RUN_OUT="$OUT" DRY_RUN_DIST="$DIST_INDEX"

node -e "
  const fs = require('node:fs');
  const { createPool, getDatabasePool, closePool, runOwnerAuthorityDryRun } = require(process.env.DRY_RUN_DIST);
  createPool({ connectionString: process.env.ADMIN_DATABASE_URL });
  (async () => {
    const report = await runOwnerAuthorityDryRun(await getDatabasePool());
    fs.writeFileSync(process.env.DRY_RUN_OUT, JSON.stringify(report, null, 2) + '\n');
    console.log('OWNER AUTHORITY BACKFILL — DRY RUN (read-only, nothing was granted)');
    console.log('generated: ' + report.generatedAt);
    console.log('tenants scanned: ' + report.tenantsScanned + '   businesses scanned: ' + report.businessesScanned);
    for (const [name, count] of Object.entries(report.counts)) console.log('  ' + name.padEnd(18) + String(count).padStart(6));
    const candidates = report.entries.filter((e) => e.candidates.length > 0).length;
    console.log('  businesses with CANDIDATE — NOT AUTO-GRANTED owners: ' + candidates);
    const lapsed = report.entries.filter((e) => e.classification === 'ALREADY_ASSIGNED' && e.holderStillProvenOwner === false).length;
    console.log('  assignments whose holder is no longer a proven owner (review): ' + lapsed);
    for (const w of report.warnings) console.log('WARNING: ' + w);
    console.log('report written to: ' + process.env.DRY_RUN_OUT);
    await closePool();
  })().catch(async (err) => { console.error('Dry run FAILED:', err.message); await closePool().catch(() => {}); process.exit(1); });
"
