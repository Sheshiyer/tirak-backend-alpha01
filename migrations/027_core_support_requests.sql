-- Migration 027: Core support requests (contact + privacy/deletion intake).
--
-- Additive only. Creates one new table and its indexes; it does not ALTER,
-- rebuild, or reference users, bookings, or any other existing table, so
-- existing rows and foreign keys are untouched.
--
-- This table is the authoritative receipt/inbox for public support requests.
-- A privacy_deletion row records INTENT ONLY: nothing in this schema or in the
-- request handlers deletes or modifies accounts. There is intentionally no
-- foreign key to users so a request can never cascade into (or be cascaded by)
-- account data.
--
-- idempotency_key_hash is SHA-256 of the client Idempotency-Key (never the raw
-- key). payload_digest is SHA-256 of the normalized payload and is used to tell
-- an exact replay (same reference) from a conflicting reuse (409). The UNIQUE
-- index on idempotency_key_hash is what makes concurrent duplicates atomic.
-- Core (mode = 'tirak') only; Tirak Plus is deliberately not representable.

CREATE TABLE IF NOT EXISTS core_support_requests (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  mode TEXT NOT NULL DEFAULT 'tirak' CHECK (mode = 'tirak'),
  kind TEXT NOT NULL CHECK (kind IN ('contact', 'privacy_deletion')),
  status TEXT NOT NULL DEFAULT 'received'
    CHECK (status IN ('received', 'in_review', 'resolved', 'closed')),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  email_normalized TEXT NOT NULL CHECK (length(email_normalized) BETWEEN 3 AND 254),
  subject TEXT NOT NULL CHECK (length(subject) BETWEEN 1 AND 150),
  message TEXT NOT NULL CHECK (length(message) BETWEEN 1 AND 4000),
  idempotency_key_hash TEXT NOT NULL CHECK (length(idempotency_key_hash) = 64),
  payload_digest TEXT NOT NULL CHECK (length(payload_digest) = 64),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_core_support_requests_idempotency
  ON core_support_requests (idempotency_key_hash);

CREATE INDEX IF NOT EXISTS idx_core_support_requests_inbox
  ON core_support_requests (mode, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_core_support_requests_kind_status
  ON core_support_requests (mode, kind, status, created_at DESC);
