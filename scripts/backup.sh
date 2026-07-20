#!/usr/bin/env bash

set -euo pipefail

ENVIRONMENT="${1:-}"
OUTPUT_ROOT="${2:-backups}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

case "$ENVIRONMENT" in
  staging)
    DATABASE_NAME="tirak-staging"
    REQUIRED_AUTHORIZATION="T-024_APPROVED"
    ;;
  production)
    DATABASE_NAME="tirak-mobile-production"
    REQUIRED_AUTHORIZATION="T-072_APPROVED"
    ;;
  *)
    echo "usage: backup.sh <staging|production> [output-root]" >&2
    exit 1
    ;;
esac

[[ "${TIRAK_RELEASE_AUTHORIZATION:-}" == "$REQUIRED_AUTHORIZATION" ]] || {
  echo "backup authorization mismatch for $ENVIRONMENT; expected $REQUIRED_AUTHORIZATION" >&2
  exit 1
}

cd "$PROJECT_DIR"
node scripts/validate-target.mjs "$ENVIRONMENT" "$DATABASE_NAME" "${TIRAK_WRANGLER_CONFIG:-wrangler.toml}"

TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_DIR="$OUTPUT_ROOT/tirak-backend-${ENVIRONMENT}-${TIMESTAMP}"
SQL_FILE="$BACKUP_DIR/d1-export.sql"
mkdir -p "$BACKUP_DIR"

npx --no-install wrangler d1 export "$DATABASE_NAME" \
  --env "$ENVIRONMENT" \
  --remote \
  --output="$SQL_FILE"

[[ -s "$SQL_FILE" ]] || {
  echo "D1 export returned no restorable SQL" >&2
  exit 1
}

./scripts/verify-sql-restore.sh "$SQL_FILE"

SQL_SHA256="$(shasum -a 256 "$SQL_FILE" | awk '{print $1}')"
cat > "$BACKUP_DIR/manifest.json" <<EOF
{
  "environment": "$ENVIRONMENT",
  "database": "$DATABASE_NAME",
  "createdAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "sqlFile": "d1-export.sql",
  "sha256": "$SQL_SHA256",
  "restoreVerified": true
}
EOF

printf '%s\n' "$BACKUP_DIR/manifest.json"
