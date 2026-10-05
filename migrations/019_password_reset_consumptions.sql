-- Additive single-use authority for KV reset and invitation tokens carrying an explicit expiry.
-- Store only SHA-256 token digests. No raw token, recipient, or message content.
CREATE TABLE IF NOT EXISTS password_reset_consumptions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_password_reset_consumptions_expiry ON password_reset_consumptions(expires_at);
-- Retain consumption records until an explicit maintenance policy is reviewed.
-- Never remove an unexpired record: KV deletion alone does not prevent replay.
