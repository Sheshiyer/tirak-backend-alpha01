-- Fresh Core baseline prerequisites. Rehearse against the selected schema;
-- existing targets with legacy mobile columns require metadata reconciliation,
-- not blind replay of this ALTER or quarantined migration 004.
CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  data TEXT,
  read BOOLEAN NOT NULL DEFAULT FALSE CHECK (read IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_notifications_user_id ON notifications(user_id);
ALTER TABLE users ADD COLUMN notification_preferences TEXT DEFAULT '{}';
