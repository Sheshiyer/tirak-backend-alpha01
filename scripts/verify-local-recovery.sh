#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
TEMP_DIR="$(mktemp -d)"
SOURCE_DB="$TEMP_DIR/source.sqlite"
RESTORED_DB="$TEMP_DIR/restored.sqlite"
DUMP_FILE="$TEMP_DIR/recovery.sql"

cleanup() {
  if [[ -n "${TEMP_DIR:-}" && "$TEMP_DIR" == /tmp/* || "$TEMP_DIR" == /var/folders/* ]]; then
    rm -rf "$TEMP_DIR"
  fi
}
trap cleanup EXIT

command -v sqlite3 >/dev/null 2>&1 || {
  echo "sqlite3 is required for the disposable recovery proof" >&2
  exit 1
}

sqlite3 "$SOURCE_DB" <<'SQL'
PRAGMA foreign_keys = ON;
CREATE TABLE users (id TEXT PRIMARY KEY);
CREATE TABLE bookings (id TEXT PRIMARY KEY, customer_id TEXT NOT NULL REFERENCES users(id));
INSERT INTO users(id) VALUES ('customer-1'), ('guide-1');
INSERT INTO bookings(id, customer_id) VALUES ('booking-1', 'customer-1');
SQL

sqlite3 "$SOURCE_DB" < "$PROJECT_DIR/contracts/tirak-payments-v1/target-schema.sql"

sqlite3 "$SOURCE_DB" <<'SQL'
PRAGMA foreign_keys = ON;
INSERT INTO payment_attempts (
  id, booking_id, customer_id, provider, payment_method, idempotency_key,
  attempt_number, provider_charge_id, amount_satang, currency, status
) VALUES (
  'attempt-1', 'booking-1', 'customer-1', 'omise', 'promptpay', 'idem-1',
  1, 'chrg_test_recovery', 12500, 'THB', 'successful'
);
INSERT INTO booking_chat_rooms (
  id, booking_id, customer_id, supplier_id, status
) VALUES ('room-1', 'booking-1', 'customer-1', 'guide-1', 'active');
INSERT INTO booking_chat_messages (
  id, room_id, sender_id, message_type, content
) VALUES ('message-1', 'room-1', 'customer-1', 'text', 'Meeting point confirmed');
SQL

sqlite3 "$SOURCE_DB" .dump > "$DUMP_FILE"
[[ -s "$DUMP_FILE" ]] || {
  echo "disposable backup dump is empty" >&2
  exit 1
}

if [[ "${TIRAK_RECOVERY_INJECT_FAILURE:-0}" == "1" ]]; then
  printf '\nTHIS IS NOT VALID SQL;\n' >> "$DUMP_FILE"
fi

sqlite3 "$RESTORED_DB" < "$DUMP_FILE"

integrity="$(sqlite3 "$RESTORED_DB" 'PRAGMA integrity_check;')"
foreign_keys="$(sqlite3 "$RESTORED_DB" 'PRAGMA foreign_key_check;')"
attempt_count="$(sqlite3 "$RESTORED_DB" "SELECT COUNT(*) FROM payment_attempts WHERE provider_charge_id='chrg_test_recovery' AND amount_satang=12500;")"
message_count="$(sqlite3 "$RESTORED_DB" "SELECT COUNT(*) FROM booking_chat_messages WHERE room_id='room-1';")"

[[ "$integrity" == "ok" ]] || { echo "restored integrity check failed: $integrity" >&2; exit 1; }
[[ -z "$foreign_keys" ]] || { echo "restored foreign-key check failed: $foreign_keys" >&2; exit 1; }
[[ "$attempt_count" == "1" ]] || { echo "restored payment attempt mismatch" >&2; exit 1; }
[[ "$message_count" == "1" ]] || { echo "restored booking chat mismatch" >&2; exit 1; }

printf '{"status":"PASS","integrity":"ok","foreignKeyViolations":0,"paymentAttempts":1,"bookingMessages":1}\n'
