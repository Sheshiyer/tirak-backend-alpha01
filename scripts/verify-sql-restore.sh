#!/usr/bin/env bash

set -euo pipefail

SQL_FILE="${1:-}"
[[ -n "$SQL_FILE" && -s "$SQL_FILE" ]] || {
  echo "usage: verify-sql-restore.sh <non-empty-export.sql>" >&2
  exit 1
}

command -v sqlite3 >/dev/null 2>&1 || {
  echo "sqlite3 is required to verify an exported D1 backup" >&2
  exit 1
}

TEMP_DIR="$(mktemp -d)"
RESTORED_DB="$TEMP_DIR/restored.sqlite"
cleanup() {
  if [[ -n "${TEMP_DIR:-}" && "$TEMP_DIR" == /tmp/* || "$TEMP_DIR" == /var/folders/* ]]; then
    rm -rf "$TEMP_DIR"
  fi
}
trap cleanup EXIT

sqlite3 "$RESTORED_DB" < "$SQL_FILE"
integrity="$(sqlite3 "$RESTORED_DB" 'PRAGMA integrity_check;')"
foreign_keys="$(sqlite3 "$RESTORED_DB" 'PRAGMA foreign_key_check;')"
[[ "$integrity" == "ok" ]] || { echo "restored integrity check failed: $integrity" >&2; exit 1; }
[[ -z "$foreign_keys" ]] || { echo "restored foreign-key check failed: $foreign_keys" >&2; exit 1; }

printf '{"status":"PASS","integrity":"ok","foreignKeyViolations":0}\n'
