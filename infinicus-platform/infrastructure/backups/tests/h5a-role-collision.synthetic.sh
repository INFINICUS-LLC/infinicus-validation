#!/usr/bin/env bash
# Exercise the REAL role-collision guard extracted from restore-proof.sh.
# No database, passwords, network, or role-changing SQL is used.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RESTORE_SCRIPT="$SCRIPT_DIR/../restore-proof.sh"
TEST_DIR="$(mktemp -d)"
trap 'rm -rf "$TEST_DIR"' EXIT
# Extract the guard exactly as implemented; fail if it is renamed or removed.
sed -n '/^check_role_is_new() {/,/^done < "\$WORK\/roles.safe.sql"/p' "$RESTORE_SCRIPT" > "$TEST_DIR/guard.sh"
grep -q '^check_role_is_new() {' "$TEST_DIR/guard.sh"
grep -q '^done < "\$WORK/roles.safe.sql"' "$TEST_DIR/guard.sh"
cat > "$TEST_DIR/psql" <<'MOCK'
#!/usr/bin/env bash
# Return the known bootstrap administrator for SELECT only.
args="$*"
case "$args" in
  *'SELECT 1 FROM pg_roles WHERE rolname ='*)
    case "$args" in
      *"'h5a_bootstrap'"*) echo 1 ;;
      *"'fresh_h5a_role'"*) : ;;
      *) exit 91 ;;
    esac ;;
  *) echo "UNEXPECTED_SQL" >&2; exit 92 ;;
esac
MOCK
chmod 700 "$TEST_DIR/psql"
export PATH="$TEST_DIR:$PATH"
export RESTORE_ADMIN_URL='postgresql://h5a_bootstrap@localhost/postgres'
cat > "$TEST_DIR/test-one.sh" <<'RUNNER'
#!/usr/bin/env bash
set -euo pipefail
WORK="$1"
fail() { echo "GUARD_REFUSED: $1"; exit "${2:-1}"; }
source "$WORK/guard.sh"
echo "GUARD_ALLOWED"
RUNNER
chmod 700 "$TEST_DIR/test-one.sh"
run_case() {
  local name="$1" sql="$2" expected="$3" status=0 output
  printf '%s\n' "$sql" > "$TEST_DIR/roles.safe.sql"
  output="$(bash "$TEST_DIR/test-one.sh" "$TEST_DIR")" || status=$?
  if [[ "$expected" == rejected ]]; then
    [[ "$status" == 2 && "$output" == GUARD_REFUSED:* ]] || {
      echo "FAIL $name: expected exit 2 and rejection, got status=$status output=$output"; exit 1;
    }
  else
    [[ "$status" == 0 && "$output" == GUARD_ALLOWED ]] || {
      echo "FAIL $name: expected allowed, got status=$status output=$output"; exit 1;
    }
  fi
}
run_case alter_bootstrap 'ALTER ROLE h5a_bootstrap WITH NOSUPERUSER;' rejected
run_case comment_bootstrap "COMMENT ON ROLE h5a_bootstrap IS 'unsafe';" rejected
run_case grant_to_bootstrap 'GRANT fresh_h5a_role TO h5a_bootstrap;' rejected
run_case create_existing 'CREATE ROLE h5a_bootstrap;' rejected
run_case create_new 'CREATE ROLE fresh_h5a_role;' allowed
run_case alter_new 'ALTER ROLE fresh_h5a_role WITH LOGIN;' allowed
echo 'H5A_SYNTHETIC_ROLE_COLLISION=PASS'
