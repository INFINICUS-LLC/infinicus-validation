#!/usr/bin/env bash
# Builds a restore-proof expectations profile from REAL read-only evidence, so no expected count is ever typed or invented.
#
# Inputs (both are output files saved by the owner; this script reads files only, it never connects to any database or server):
#   --evidence FILE   output of docs/architecture/reconciliation/production-discovery/p3-owner-01-evidence.sql (E01 identity, E06/E07 profile candidates)
#   --discovery FILE  output of infrastructure/deployment/scripts/production-readonly-discovery.sh (fingerprint verdict and combined hash)
#   --out FILE        profile to write (must not exist; the script never overwrites)
# Optional (defaults are for production at migration 0198):
#   --expect-db NAME  default "infinicus"; the database name the evidence must report
#   --expect-head F   default 0198_link_purchase_order_lines_to_inventory_items.sql
#   --expect-verdict V default MATCHES_REPOSITORY_0198_PG16
#
# It REFUSES (exit 2, nothing written) unless: the evidence reports the expected database, a read-only session, the expected ledger head and a ledger
# count equal to its own ledger_count candidate; no evidence line carries an ERROR or TABLE_MISSING; the discovery output carries the expected
# fingerprint verdict and a 16-hex combined hash; and every generated line matches the restore-proof profile grammar. A profile is a statement of what a
# restore must reproduce: the generated file is a candidate for a REVIEWED repository change (never copy it to a server unreviewed).
set -euo pipefail
umask 077

EVIDENCE=""; DISCOVERY=""; OUT=""
EXPECT_DB="infinicus"; EXPECT_HEAD="0198_link_purchase_order_lines_to_inventory_items.sql"; EXPECT_VERDICT="MATCHES_REPOSITORY_0198_PG16"
die() { echo "REFUSED: $1" >&2; exit 2; }
while [[ $# -gt 0 ]]; do
  case "$1" in
    --evidence) EVIDENCE="${2:-}"; shift 2 ;;
    --discovery) DISCOVERY="${2:-}"; shift 2 ;;
    --out) OUT="${2:-}"; shift 2 ;;
    --expect-db) EXPECT_DB="${2:-}"; shift 2 ;;
    --expect-head) EXPECT_HEAD="${2:-}"; shift 2 ;;
    --expect-verdict) EXPECT_VERDICT="${2:-}"; shift 2 ;;
    *) die "unknown argument $1" ;;
  esac
done
[[ -n "$EVIDENCE" && -r "$EVIDENCE" ]] || die "--evidence FILE (readable) is required"
[[ -n "$DISCOVERY" && -r "$DISCOVERY" ]] || die "--discovery FILE (readable) is required"
[[ -n "$OUT" ]] || die "--out FILE is required"
[[ ! -e "$OUT" ]] || die "$OUT already exists; refusing to overwrite"
[[ "$EXPECT_DB" =~ ^[a-z_][a-z0-9_]{0,62}$ ]] || die "invalid --expect-db"
[[ "$EXPECT_HEAD" =~ ^[A-Za-z0-9._-]+$ ]] || die "invalid --expect-head"
[[ "$EXPECT_VERDICT" =~ ^[A-Z0-9_]+$ ]] || die "invalid --expect-verdict"

trim() { local s="$1"; s="${s#"${s%%[![:space:]]*}"}"; s="${s%"${s##*[![:space:]]}"}"; printf '%s' "$s"; }

grep -q 'ERROR' "$EVIDENCE" && die "the evidence output contains an ERROR line (a failed run is not evidence)"
grep -q 'TABLE_MISSING' "$EVIDENCE" && die "the evidence output reports a missing table (TABLE_MISSING); review which table and why before any profile is made"

# E01 identity: label | db | pg | read_only | ledger_count | ledger_head
E01="$(grep -E '^ *E01 identity *\|' "$EVIDENCE" | head -1 || true)"
[[ -n "$E01" ]] || die "no E01 identity row in the evidence output"
IFS='|' read -r _l DB PG RO LCOUNT LHEAD <<<"$E01"
DB="$(trim "$DB")"; RO="$(trim "$RO")"; LCOUNT="$(trim "$LCOUNT")"; LHEAD="$(trim "$LHEAD")"; PG="$(trim "$PG")"
[[ "$DB" == "$EXPECT_DB" ]] || die "evidence database is '$DB', expected '$EXPECT_DB'"
[[ "$RO" == "on" ]] || die "evidence session was not read-only (transaction_read_only='$RO')"
[[ "$LHEAD" == "$EXPECT_HEAD" ]] || die "evidence ledger head is '$LHEAD', expected '$EXPECT_HEAD'"
[[ "$LCOUNT" =~ ^[0-9]+$ ]] || die "evidence ledger count is not a number"

# E06 / E07 candidates: label | line
cand() { { grep -E "^ *$1 *\|" "$EVIDENCE" || true; } | sed -E 's/^[^|]*\|//' | while IFS= read -r l; do trim "$l"; printf '\n'; done; }
E06="$(cand 'E06 profile candidate')"; E07="$(cand 'E07 outbox candidate')"
[[ -n "$E06" ]] || die "no E06 profile candidate rows in the evidence output"
grep -qx "ledger_count=$LCOUNT" <<<"$E06" || die "E06 ledger_count does not equal the E01 ledger count"
grep -qx "ledger_head=$LHEAD" <<<"$E06" || die "E06 ledger_head does not equal the E01 ledger head"

# discovery: verdict and combined hash
grep -qE "^fingerprint-verdict=$EXPECT_VERDICT\$" "$DISCOVERY" || die "the discovery output does not carry fingerprint-verdict=$EXPECT_VERDICT (production differs from a clean reference: stop and investigate)"
FP="$(sed -n 's/^fingerprint-groups=.* combined-sha256-16=\([0-9a-f]\{16\}\)$/\1/p' "$DISCOVERY" | head -1)"
[[ "$FP" =~ ^[0-9a-f]{16}$ ]] || die "no 16-hex combined-sha256-16 in the discovery output"

# build and re-validate every line against the restore-proof grammar
TMP="$(mktemp)"; trap 'rm -f "$TMP"' EXIT
{
  echo "# Expected state of the INFINICUS production database at migration-ledger head ${LHEAD%%_*}, built from owner-run read-only evidence (not typed)."
  echo "# generated: $(date -u +%Y-%m-%dT%H:%M:%SZ) | evidence sha256:$(sha256sum "$EVIDENCE" | cut -c1-16) | discovery sha256:$(sha256sum "$DISCOVERY" | cut -c1-16) | server: $PG"
  echo "# A CANDIDATE: review it, then commit it through a reviewed change. restore-proof.sh reports PASS only if the restored database equals every value below."
  echo "ledger_count=$LCOUNT"
  echo "ledger_head=$LHEAD"
  echo "schema_fingerprint=$FP"
  echo
  grep -E '^count ' <<<"$E06" || true
  if [[ -n "$E07" ]]; then echo; grep -E '^outbox ' <<<"$E07" || true; fi
} > "$TMP"
while IFS= read -r line; do
  [[ -z "$line" || "$line" == \#* ]] && continue
  if   [[ "$line" =~ ^ledger_count=[0-9]+$ ]]; then :
  elif [[ "$line" =~ ^ledger_head=[A-Za-z0-9._-]+$ ]]; then :
  elif [[ "$line" =~ ^schema_fingerprint=[0-9a-f]{16}$ ]]; then :
  elif [[ "$line" =~ ^count[[:space:]]+[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*=[0-9]+$ ]]; then :
  elif [[ "$line" =~ ^outbox[[:space:]]+[a-z0-9_.]+=[0-9]+$ ]]; then :
  else die "generated line does not match the profile grammar: $line"; fi
done < "$TMP"
grep -qE '^count ' "$TMP" || die "no count rules were generated"
mv "$TMP" "$OUT"; trap - EXIT
echo "WROTE $OUT ($(grep -cE '^count ' "$OUT") count rule(s), $(grep -cE '^outbox ' "$OUT") outbox rule(s)); review it before committing"
