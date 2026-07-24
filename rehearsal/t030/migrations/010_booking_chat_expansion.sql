-- Migration 010: additive booking-scoped chat expansion.
--
-- This migration REPLACES the quarantined, destructive 009_booking_scoped_chat.sql,
-- which renames the active legacy tables chat_rooms/chat_messages and re-creates
-- booking-scoped tables under those same names. 009 must NEVER be applied to any
-- release target: it breaks the old Worker immediately and violates the approved
-- migration strategy (docs/contracts/tirak-payments-v1/migration-strategy.md,
-- "Chat expand/contract design").
--
-- Approved additive design (tirak-payments-v1 contract, target-schema.sql):
--   1. New tables booking_chat_rooms / booking_chat_messages are created
--      ALONGSIDE legacy pair-scoped chat_rooms / chat_messages. This file never
--      renames, drops, alters, or reads the legacy tables.
--   2. One room per booking: booking_id is UNIQUE and NOT NULL, so both
--      participants (customer_id, supplier_id) are derived from exactly one
--      booking. No free-form participant rows exist.
--   3. NO legacy data copy: legacy pair conversations cannot be attributed
--      safely to one booking, so nothing is copied. Legacy conversations stay
--      readable by the old Worker during the compatibility window.
--   4. Messages carry a self-referencing reply_to_id FK.
--   5. All timestamps are TEXT (ISO-8601), never DATETIME, per the frozen
--      contract (legacy 009 used DATETIME — that divergence is corrected here).
--   6. Legacy table retirement/renaming is OUT OF SCOPE for this release and
--      requires a separate contract migration after the old Worker is gone.
--
-- Idempotency: every statement uses IF NOT EXISTS, so re-application is a no-op.
-- Index names use the idx_booking_chat_* prefix, which is collision-free against
-- migration 002's idx_chat_* indexes on the legacy tables.
--
-- Apply only through Wrangler's d1_migrations ledger after the canonical baseline
-- (which provides users/bookings/legacy chat) and the corrected payments
-- migration, following disposable rehearsal. Never via raw directory replay.

CREATE TABLE IF NOT EXISTS booking_chat_rooms (
    id TEXT PRIMARY KEY,
    booking_id TEXT NOT NULL UNIQUE REFERENCES bookings(id) ON DELETE CASCADE,
    customer_id TEXT NOT NULL REFERENCES users(id),
    supplier_id TEXT NOT NULL REFERENCES users(id),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closed', 'archived')),
    last_message_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS booking_chat_messages (
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

CREATE INDEX IF NOT EXISTS idx_booking_chat_rooms_customer ON booking_chat_rooms(customer_id);
CREATE INDEX IF NOT EXISTS idx_booking_chat_rooms_supplier ON booking_chat_rooms(supplier_id);
CREATE INDEX IF NOT EXISTS idx_booking_chat_messages_room_time ON booking_chat_messages(room_id, created_at);

PRAGMA foreign_key_check;
