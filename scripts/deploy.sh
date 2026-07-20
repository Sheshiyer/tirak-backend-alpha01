#!/usr/bin/env bash

set -euo pipefail

ENVIRONMENT="${1:-}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
TEST_MODE="${TIRAK_RELEASE_TEST_MODE:-0}"
FAIL_STEP="${TIRAK_RELEASE_FAIL_STEP:-}"

case "$ENVIRONMENT" in
  staging)
    DATABASE_NAME="tirak-staging"
    REQUIRED_AUTHORIZATION="T-024_APPROVED"
    HEALTH_URL="https://api-staging.tirak.app/health"
    ;;
  production)
    DATABASE_NAME="tirak-mobile-production"
    REQUIRED_AUTHORIZATION="T-072_APPROVED"
    HEALTH_URL="https://api.tirak.app/health"
    ;;
  *)
    echo "usage: deploy.sh <staging|production>" >&2
    exit 1
    ;;
esac

if [[ "$TEST_MODE" == "1" ]]; then
  REQUIRED_AUTHORIZATION="TEST_ONLY"
  [[ -n "${TIRAK_WRANGLER_CONFIG:-}" ]] || {
    echo "test mode requires an isolated TIRAK_WRANGLER_CONFIG fixture" >&2
    exit 1
  }
fi

[[ "${TIRAK_RELEASE_AUTHORIZATION:-}" == "$REQUIRED_AUTHORIZATION" ]] || {
  echo "deployment authorization mismatch for $ENVIRONMENT; expected $REQUIRED_AUTHORIZATION" >&2
  exit 1
}

if [[ "$ENVIRONMENT" == "production" && "$TEST_MODE" != "1" ]]; then
  [[ -n "${TIRAK_PRODUCTION_CHANGE_ID:-}" ]] || {
    echo "production deployment requires TIRAK_PRODUCTION_CHANGE_ID" >&2
    exit 1
  }
fi

cd "$PROJECT_DIR"

fail_if_injected() {
  local step="$1"
  if [[ "$FAIL_STEP" == "$step" ]]; then
    echo "injected $step failure" >&2
    return 97
  fi
}

run_local_step() {
  local step="$1"
  shift
  fail_if_injected "$step"
  "$@"
}

run_external_step() {
  local step="$1"
  shift
  fail_if_injected "$step"
  if [[ "$TEST_MODE" == "1" ]]; then
    printf 'TEST_ONLY external step: %s\n' "$step"
    return 0
  fi
  "$@"
}

run_local_step target node scripts/validate-target.mjs \
  "$ENVIRONMENT" "$DATABASE_NAME" "${TIRAK_WRANGLER_CONFIG:-wrangler.toml}"
run_external_step typecheck npm run typecheck
run_external_step test npm run test:run
run_local_step restore ./scripts/verify-local-recovery.sh
run_external_step backup ./scripts/backup.sh "$ENVIRONMENT"
run_external_step migration npx --no-install wrangler d1 migrations list "$DATABASE_NAME" --env "$ENVIRONMENT" --remote
run_external_step migration npx --no-install wrangler d1 migrations apply "$DATABASE_NAME" --env "$ENVIRONMENT" --remote
run_external_step deploy npx --no-install wrangler deploy --env "$ENVIRONMENT"
run_external_step health curl --fail --show-error --silent --max-time 20 "$HEALTH_URL"

printf '{"status":"PASS","environment":"%s","database":"%s","testMode":%s}\n' \
  "$ENVIRONMENT" "$DATABASE_NAME" "$([[ "$TEST_MODE" == "1" ]] && echo true || echo false)"
