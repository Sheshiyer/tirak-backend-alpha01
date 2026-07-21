-- Contract-only target schema for tirak-payments-v1.
-- This file is exercised against a disposable SQLite fixture. It is not a
-- Wrangler migration and MUST NOT be applied to D1 directly.

CREATE TABLE payment_attempts (
    id TEXT PRIMARY KEY,
    booking_id TEXT NOT NULL REFERENCES bookings(id),
    customer_id TEXT NOT NULL REFERENCES users(id),
    provider TEXT NOT NULL CHECK (provider = 'omise'),
    payment_method TEXT NOT NULL CHECK (payment_method = 'promptpay'),
    idempotency_key TEXT NOT NULL UNIQUE,
    attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
    provider_charge_id TEXT UNIQUE,
    amount_satang INTEGER NOT NULL CHECK (amount_satang > 0),
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

CREATE UNIQUE INDEX uq_payment_attempt_active_booking
    ON payment_attempts(booking_id)
    WHERE status IN ('creating', 'indeterminate', 'pending');
CREATE INDEX idx_payment_attempts_customer ON payment_attempts(customer_id, created_at DESC);
CREATE INDEX idx_payment_attempts_charge ON payment_attempts(provider_charge_id);

CREATE TABLE payment_webhook_events (
    replay_key TEXT PRIMARY KEY,
    provider_event_id TEXT UNIQUE,
    provider_charge_id TEXT NOT NULL,
    signature_timestamp INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('received', 'processed', 'ignored', 'failed')),
    received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    processed_at TEXT
);

CREATE INDEX idx_payment_webhook_events_charge
    ON payment_webhook_events(provider_charge_id, received_at DESC);

CREATE TABLE payment_restitutions (
    id TEXT PRIMARY KEY,
    booking_id TEXT NOT NULL REFERENCES bookings(id),
    payment_attempt_id TEXT NOT NULL UNIQUE REFERENCES payment_attempts(id),
    provider_charge_id TEXT NOT NULL UNIQUE,
    customer_id TEXT NOT NULL REFERENCES users(id),
    amount_satang INTEGER NOT NULL CHECK (amount_satang > 0),
    currency TEXT NOT NULL CHECK (currency = 'THB'),
    reason TEXT NOT NULL,
    recipient_reference TEXT,
    evidence_uri TEXT,
    approver_user_id TEXT REFERENCES users(id),
    status TEXT NOT NULL CHECK (status IN ('restitution_pending', 'restituted', 'restitution_failed')),
    requested_at TEXT NOT NULL,
    approved_at TEXT,
    completed_at TEXT,
    failed_at TEXT,
    failure_reason TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK (
      (status = 'restitution_pending' AND completed_at IS NULL AND failed_at IS NULL)
      OR
      (status = 'restituted' AND recipient_reference IS NOT NULL AND evidence_uri IS NOT NULL AND approver_user_id IS NOT NULL AND approved_at IS NOT NULL AND completed_at IS NOT NULL AND failed_at IS NULL)
      OR
      (status = 'restitution_failed' AND evidence_uri IS NOT NULL AND approver_user_id IS NOT NULL AND approved_at IS NOT NULL AND failed_at IS NOT NULL AND failure_reason IS NOT NULL AND completed_at IS NULL)
    )
);

CREATE INDEX idx_payment_restitutions_booking ON payment_restitutions(booking_id, requested_at DESC);
CREATE INDEX idx_payment_restitutions_customer ON payment_restitutions(customer_id, requested_at DESC);

CREATE TABLE booking_chat_rooms (
    id TEXT PRIMARY KEY,
    booking_id TEXT NOT NULL UNIQUE REFERENCES bookings(id) ON DELETE CASCADE,
    customer_id TEXT NOT NULL REFERENCES users(id),
    supplier_id TEXT NOT NULL REFERENCES users(id),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closed', 'archived')),
    last_message_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE booking_chat_messages (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL REFERENCES booking_chat_rooms(id) ON DELETE CASCADE,
    sender_id TEXT NOT NULL REFERENCES users(id),
    message_type TEXT NOT NULL CHECK (message_type IN ('text', 'image', 'system')),
    content TEXT,
    image_url TEXT,
    metadata TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    delivered_at TEXT,
    read_at TEXT,
    reply_to_id TEXT REFERENCES booking_chat_messages(id)
);

CREATE INDEX idx_booking_chat_rooms_customer ON booking_chat_rooms(customer_id);
CREATE INDEX idx_booking_chat_rooms_supplier ON booking_chat_rooms(supplier_id);
CREATE INDEX idx_booking_chat_messages_room_time ON booking_chat_messages(room_id, created_at);

PRAGMA foreign_key_check;
