#!/usr/bin/env bash
# BUILD-23 — Post-deploy smoke test: the minimum set of checks that must
# pass before a newly-promoted instance is considered healthy. Run this
# against a freshly started/deployed apps/api instance before routing
# real traffic to it (or, in a rollback scenario, before considering a
# rollback target healthy).
#
# Exit code: 0 if every check passes, non-zero (with the failing check
# named) on the first failure — a CI/deploy pipeline should treat
# non-zero here as a hard stop / automatic rollback trigger.
#
# Usage:
#   BASE_URL="http://localhost:3000" ./smoke-test.sh
#   BASE_URL=... EXPECTED_BUILD_SHA=<git commit> ./smoke-test.sh   # S-3: also require GET /v1/health to report exactly that commit
#
# EXPECTED_BUILD_SHA (optional, 7-40 hex): when set, the running instance must report this commit in /v1/health "version". "unknown" means the
# image was built without GIT_SHA, so the running code cannot be tied to a commit, and that FAILS. A reported id that is a prefix of the expected
# one (a short-sha build) is accepted. Commit ids are not secrets, so both are printed on a mismatch.

set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"

check() {
  local path="$1"
  local expected="$2"
  local status
  # curl's -w '%{http_code}' already writes "000" on a connection failure
  # (refused/timeout/DNS) — the `|| true` only stops set -e from aborting
  # on curl's own non-zero exit in that case; it must not print anything
  # itself, or the two "000"s concatenate into a bogus "000000".
  status=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "${BASE_URL}${path}" || true)
  if [[ "$status" != "$expected" ]]; then
    echo "FAIL: GET ${path} expected ${expected}, got ${status:-<no response>}" >&2
    exit 1
  fi
  echo "OK:   GET ${path} -> ${status}"
}

echo "Smoke testing ${BASE_URL} ..."
check "/v1/health" "200"
check "/v1/ready" "200"
check "/documentation/json" "200"

if [[ -n "${EXPECTED_BUILD_SHA:-}" ]]; then
  expected="$(printf '%s' "$EXPECTED_BUILD_SHA" | tr 'A-F' 'a-f')"
  if [[ ! "$expected" =~ ^[0-9a-f]{7,40}$ ]]; then
    echo "FAIL: EXPECTED_BUILD_SHA must be a 7-40 character hex commit id" >&2
    exit 1
  fi
  body=$(curl -s --max-time 10 "${BASE_URL}/v1/health" || true)
  actual=$(printf '%s' "$body" | sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
  if [[ -z "$actual" ]]; then
    echo "FAIL: GET /v1/health did not report a version" >&2
    exit 1
  fi
  if [[ "$actual" == "unknown" ]]; then
    echo "FAIL: the running API reports version \"unknown\" (image built without GIT_SHA); expected ${expected}. Rebuild with GIT_SHA=\$(git rev-parse HEAD) docker compose build, then restart." >&2
    exit 1
  fi
  if [[ "${#actual}" -lt 7 || "$expected" != "$actual"* ]]; then
    echo "FAIL: the running API reports version ${actual}; expected ${expected}" >&2
    exit 1
  fi
  echo "OK:   running build ${actual} matches the commit being deployed"
fi

echo "Smoke test passed: process is live, database is reachable, OpenAPI spec is being served."
