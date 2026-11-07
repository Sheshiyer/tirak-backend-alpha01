-- Durable notification intent for new Core support receipts only.
CREATE TABLE core_support_notification_outbox (
  request_id TEXT PRIMARY KEY REFERENCES core_support_requests(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','retry_due','unconfigured','provider_accepted','needs_review')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  lease_token TEXT,
  lease_until INTEGER,
  first_attempt_at INTEGER,
  config_digest TEXT,
  provider_request_id TEXT,
  accepted_at INTEGER,
  last_error_code TEXT,
  updated_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_core_support_notifications_due ON core_support_notification_outbox(status,next_attempt_at);
