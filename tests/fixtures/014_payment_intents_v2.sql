-- Candidate V2 payment-intent ledger.  This file is intentionally held in a
-- dedicated test-fixture directory: it is not an eligible release-target
-- migration and must not be copied into migrations/ or applied remotely until
-- a release coordinator approves each account-pinned target path.
--
-- Invariants:
--   * V1 Omise tables and routes are untouched.
--   * Provider identifiers are opaque and no QR, redirect, token, signature,
--     or raw event payload is stored here.
--   * A provider event is de-duplicated by provider + provider event reference.
--   * Provider-specific authorization/signature validation stays in a future
--     adapter; this schema is provider-neutral storage only.

CREATE TABLE IF NOT EXISTS payment_intents_v2 (
    id TEXT PRIMARY KEY,
    booking_id TEXT NOT NULL REFERENCES bookings(id),
    customer_id TEXT NOT NULL REFERENCES users(id),
    provider TEXT NOT NULL CHECK (length(trim(provider)) > 0),
    provider_intent_reference TEXT,
    amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
    currency TEXT NOT NULL CHECK (currency GLOB '[A-Z][A-Z][A-Z]'),
    status TEXT NOT NULL CHECK (status IN (
        'draft',
        'requires_payment_method',
        'requires_action',
        'processing',
        'succeeded',
        'refunded',
        'failed',
        'cancelled',
        'expired'
    )),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_intents_v2_provider_reference
    ON payment_intents_v2(provider, provider_intent_reference)
    WHERE provider_intent_reference IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_payment_intents_v2_booking
    ON payment_intents_v2(booking_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_payment_intents_v2_customer
    ON payment_intents_v2(customer_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_payment_intents_v2_status
    ON payment_intents_v2(status, updated_at DESC);

CREATE TABLE IF NOT EXISTS payment_provider_events_v2 (
    id TEXT PRIMARY KEY,
    payment_intent_id TEXT NOT NULL REFERENCES payment_intents_v2(id),
    provider TEXT NOT NULL CHECK (length(trim(provider)) > 0),
    provider_event_reference TEXT NOT NULL CHECK (length(trim(provider_event_reference)) > 0),
    kind TEXT NOT NULL CHECK (kind IN (
        'intent.created',
        'payment_method.required',
        'customer_action.required',
        'provider.processing',
        'provider.succeeded',
        'provider.refunded',
        'provider.failed',
        'provider.cancelled',
        'provider.expired',
        'provider.reconciled'
    )),
    occurred_at TEXT NOT NULL,
    received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_provider_events_v2_provider_reference
    ON payment_provider_events_v2(provider, provider_event_reference);

CREATE INDEX IF NOT EXISTS idx_payment_provider_events_v2_intent_time
    ON payment_provider_events_v2(payment_intent_id, occurred_at DESC);
