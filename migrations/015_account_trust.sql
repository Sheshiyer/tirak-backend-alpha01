-- Additive non-payment account verification and consent records.
-- Apply through the approved target migration procedure before deploying these routes.
CREATE TABLE IF NOT EXISTS email_verification_challenges (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    email TEXT NOT NULL,
    code_hash TEXT NOT NULL,
    issued_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    delivery_status TEXT NOT NULL CHECK (delivery_status IN ('pending', 'sent', 'failed', 'consumed'))
);

CREATE TABLE IF NOT EXISTS account_consents (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    marketing_opt_in INTEGER NOT NULL DEFAULT 0 CHECK (marketing_opt_in IN (0, 1)),
    analytics_opt_in INTEGER NOT NULL DEFAULT 0 CHECK (analytics_opt_in IN (0, 1)),
    terms_version TEXT,
    privacy_version TEXT,
    accepted_at TEXT,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS account_consent_events (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    consent_type TEXT NOT NULL CHECK (consent_type IN ('marketing', 'analytics', 'terms', 'privacy')),
    granted INTEGER NOT NULL CHECK (granted IN (0, 1)),
    policy_version TEXT,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_account_consent_events_user ON account_consent_events(user_id, created_at);

CREATE TABLE IF NOT EXISTS chat_socket_tickets (
    ticket_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    room_id TEXT NOT NULL,
    expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chat_socket_ticket_expiry ON chat_socket_tickets(expires_at);
