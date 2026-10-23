-- 022: Core booking idempotency and durability.
-- Additive migration. Apply after backup; do not replay 020/021.
-- Stores idempotency keys for booking creation so the same request
-- deterministically returns the same booking without creating duplicates.
-- Payload digest enables 409 conflict on changed payloads.

CREATE TABLE IF NOT EXISTS booking_idempotency (
  user_id     TEXT NOT NULL REFERENCES users(id),
  key_hash    TEXT NOT NULL,              -- SHA-256 of Idempotency-Key
  booking_id  TEXT NOT NULL REFERENCES bookings(id),
  payload     TEXT NOT NULL,              -- canonical JSON of the original request body
  payload_digest TEXT NOT NULL,           -- SHA-256 of canonical JSON for conflict detection
  status      TEXT NOT NULL DEFAULT 'committed' CHECK (status IN ('committed', 'pending')),
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at  TEXT NOT NULL,              -- auto-cleanup after 24 hours
  PRIMARY KEY (user_id, key_hash)
);

CREATE INDEX IF NOT EXISTS idx_booking_idempotency_user
  ON booking_idempotency(user_id, created_at);

CREATE INDEX IF NOT EXISTS idx_booking_idempotency_booking
  ON booking_idempotency(booking_id);

CREATE INDEX IF NOT EXISTS idx_booking_idempotency_expires
  ON booking_idempotency(expires_at);
