-- Analytics and moderation tables migration
-- Migration: 003_add_analytics_tables.sql

-- Analytics events
CREATE TABLE analytics_events (
    id TEXT PRIMARY KEY,
    event_type TEXT NOT NULL,
    user_id TEXT REFERENCES users(id),
    session_id TEXT,
    properties TEXT, -- JSON object
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    ip_address TEXT,
    user_agent TEXT
);

-- Content moderation queue
CREATE TABLE moderation_queue (
    id TEXT PRIMARY KEY,
    content_type TEXT NOT NULL CHECK (content_type IN ('message', 'profile', 'review', 'image')),
    content_id TEXT NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id),
    status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
    priority TEXT DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high', 'urgent')),
    flagged_reason TEXT,
    moderator_id TEXT REFERENCES users(id),
    moderator_notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    reviewed_at DATETIME
);

-- Analytics indexes
CREATE INDEX idx_analytics_events_event_type ON analytics_events(event_type);
CREATE INDEX idx_analytics_events_user_id ON analytics_events(user_id);
CREATE INDEX idx_analytics_events_timestamp ON analytics_events(timestamp);
CREATE INDEX idx_analytics_events_session_id ON analytics_events(session_id);

-- Moderation indexes
CREATE INDEX idx_moderation_queue_content_type ON moderation_queue(content_type);
CREATE INDEX idx_moderation_queue_user_id ON moderation_queue(user_id);
CREATE INDEX idx_moderation_queue_status ON moderation_queue(status);
CREATE INDEX idx_moderation_queue_priority ON moderation_queue(priority);
CREATE INDEX idx_moderation_queue_created_at ON moderation_queue(created_at);
CREATE INDEX idx_moderation_queue_moderator_id ON moderation_queue(moderator_id);
