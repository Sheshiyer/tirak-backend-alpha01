-- Omise PromptPay payment attempts for confirmed Tirak bookings.
-- Amounts are stored in the gateway's integer minor unit (satang).

CREATE TABLE IF NOT EXISTS payment_attempts (
    id TEXT PRIMARY KEY,
    booking_id TEXT NOT NULL REFERENCES bookings(id),
    customer_id TEXT NOT NULL REFERENCES users(id),
    provider TEXT NOT NULL CHECK (provider = 'omise'),
    payment_method TEXT NOT NULL CHECK (payment_method = 'promptpay'),
    idempotency_key TEXT NOT NULL UNIQUE,
    attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
    provider_charge_id TEXT UNIQUE,
    amount INTEGER NOT NULL CHECK (amount > 0),
    currency TEXT NOT NULL CHECK (currency = 'THB'),
    status TEXT NOT NULL CHECK (status IN ('creating', 'indeterminate', 'pending', 'successful', 'failed', 'expired')),
    qr_code_url TEXT,
    expires_at TEXT,
    last_checked_at TEXT,
    indeterminate_at TEXT,
    last_error_at TEXT,
    last_error_code TEXT,
    recovered_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (booking_id, attempt_number)
);

CREATE INDEX IF NOT EXISTS idx_payment_attempts_booking
    ON payment_attempts(booking_id, attempt_number DESC);

CREATE INDEX IF NOT EXISTS idx_payment_attempts_customer
    ON payment_attempts(customer_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_payment_attempts_charge
    ON payment_attempts(provider_charge_id);

CREATE TABLE IF NOT EXISTS payment_webhook_events (
    replay_key TEXT PRIMARY KEY,
    provider_event_id TEXT UNIQUE,
    provider_charge_id TEXT NOT NULL,
    signature_timestamp INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('received', 'processed', 'ignored', 'failed')),
    received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    processed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_payment_webhook_events_charge
    ON payment_webhook_events(provider_charge_id, received_at DESC);
