#!/usr/bin/env bash
# H-5A synthetic fail-closed target checks. Never connects to a real database.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
cat > "$TMP/psql" <<'MOCK'
#!/usr/bin/env bash
case "$*" in
  *pg_control_system*) printf '%s\n' "${H5A_MOCK_SYSTEM_ID:-7245555555555555555}" ;;
  *infinicus.restore_target*) printf '%s\n' "${H5A_MOCK_TARGET:-disposable|on|false|16|0}" ;;
  *) echo 'Unexpected query' >&2; exit 15 ;;
esac
MOCK
chmod 700 "$TMP/psql"
export PATH="$TMP:$PATH"
export RESTORE_ADMIN_URL='postgresql://h5a_bootstrap@localhost/postgres'
export RESTORE_EXPECT_SYSTEM_IDENTIFIER='7245555555555555555'
unset PGHOSTADDR PGSERVICE PGSERVICEFILE || true
check_pass() {
  local output
  output="$(bash "$ROOT/restore-proof.sh" --validate-target)"
  [[ "$output" == RESTORE_TARGET=OK* ]] || { echo "Expected pass: $output" >&2; exit 1; }
}
check_refuse() {
  local output status=0
  output="$(bash "$ROOT/restore-proof.sh" --validate-target)" || status=$?
  [[ "$status" == 2 && "$output" == RESTORE_TARGET=REFUSED* ]] || { echo "Expected refusal (status=$status): $output" >&2; exit 1; }
}
check_pass
RESTORE_EXPECT_SYSTEM_IDENTIFIER='7245555555555555556' check_refuse
H5A_MOCK_TARGET='production|on|false|16|0' check_refuse
H5A_MOCK_TARGET='disposable|off|false|16|0' check_refuse
H5A_MOCK_TARGET='disposable|on|false|16|1' check_refuse
RESTORE_EXPECT_SYSTEM_IDENTIFIER='' check_refuse
echo 'H5A_SYNTHETIC_TARGET_GUARD=PASS'
