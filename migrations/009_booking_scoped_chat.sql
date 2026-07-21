-- Migration 009: replace pair-scoped chat with booking-scoped chat.
--
-- Legacy rooms cannot be attributed to one booking without risking cross-booking
-- disclosure. Preserve them intact for audit/recovery, but do not expose or copy
-- them into the active tables. New rooms are one-to-one with bookings.
-- Apply during a controlled release so old Worker code cannot write pair rooms
-- after these tables are archived.

ALTER TABLE chat_messages RENAME TO legacy_pair_chat_messages;
ALTER TABLE chat_rooms RENAME TO legacy_pair_chat_rooms;

CREATE TABLE chat_rooms (
    id TEXT PRIMARY KEY,
    booking_id TEXT NOT NULL UNIQUE REFERENCES bookings(id) ON DELETE CASCADE,
    customer_id TEXT NOT NULL REFERENCES users(id),
    supplier_id TEXT NOT NULL REFERENCES users(id),
    status TEXT DEFAULT 'active' CHECK (status IN ('active', 'closed', 'archived')),
    last_message_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE chat_messages (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL REFERENCES chat_rooms(id) ON DELETE CASCADE,
    sender_id TEXT NOT NULL REFERENCES users(id),
    message_type TEXT NOT NULL CHECK (message_type IN ('text', 'image', 'system')),
    content TEXT,
    image_url TEXT,
    metadata TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    delivered_at TEXT,
    read_at TEXT,
    reply_to_id TEXT
);

CREATE INDEX idx_booking_chat_rooms_customer_id ON chat_rooms(customer_id);
CREATE INDEX idx_booking_chat_rooms_supplier_id ON chat_rooms(supplier_id);
CREATE INDEX idx_booking_chat_rooms_status ON chat_rooms(status);
CREATE INDEX idx_booking_chat_rooms_last_message_at ON chat_rooms(last_message_at);
CREATE INDEX idx_booking_chat_rooms_created_at ON chat_rooms(created_at);

CREATE INDEX idx_booking_chat_messages_room_id ON chat_messages(room_id);
CREATE INDEX idx_booking_chat_messages_sender_id ON chat_messages(sender_id);
CREATE INDEX idx_booking_chat_messages_message_type ON chat_messages(message_type);
CREATE INDEX idx_booking_chat_messages_created_at ON chat_messages(created_at);
CREATE INDEX idx_booking_chat_messages_room_time ON chat_messages(room_id, created_at);
CREATE INDEX idx_booking_chat_messages_read_at ON chat_messages(read_at);
CREATE INDEX idx_booking_chat_messages_delivered_at ON chat_messages(delivered_at);
CREATE INDEX idx_booking_chat_messages_reply_to_id ON chat_messages(reply_to_id);

PRAGMA foreign_key_check;
