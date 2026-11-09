-- Additive Core inbox workflow; does not modify accounts or bookings.
ALTER TABLE core_support_requests ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
CREATE TABLE core_support_review_events (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES core_support_requests(id) ON DELETE RESTRICT,
  actor_id TEXT NOT NULL,
  from_status TEXT NOT NULL,
  to_status TEXT NOT NULL,
  from_revision INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  note TEXT NOT NULL CHECK(length(note) BETWEEN 1 AND 1000),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(request_id, revision)
);
