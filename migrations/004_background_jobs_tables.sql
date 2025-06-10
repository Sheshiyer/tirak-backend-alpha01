-- Migration 004: Background Jobs and Analytics Tables
-- This migration adds tables for moderation, analytics, and notification processing

-- Moderation Results Table
CREATE TABLE IF NOT EXISTS moderation_results (
    id TEXT PRIMARY KEY,
    content_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    job_type TEXT NOT NULL CHECK (job_type IN ('text_analysis', 'image_analysis', 'profile_review', 'manual_review')),
    action TEXT NOT NULL CHECK (action IN ('approve', 'flag', 'remove', 'escalate', 'suspend_user')),
    confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
    reasons TEXT NOT NULL, -- JSON array of reasons
    severity TEXT NOT NULL CHECK (severity IN ('low', 'medium', 'high', 'critical')),
    ai_analysis TEXT, -- JSON object with AI analysis results
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Flagged Content Table
CREATE TABLE IF NOT EXISTS flagged_content (
    id TEXT PRIMARY KEY,
    content_id TEXT NOT NULL,
    content_type TEXT NOT NULL DEFAULT 'message',
    reasons TEXT NOT NULL, -- JSON array of reasons
    flagged_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    resolved_at TEXT,
    resolved_by TEXT,
    resolution_action TEXT,
    FOREIGN KEY (resolved_by) REFERENCES users(id) ON DELETE SET NULL
);

-- Manual Review Queue Table
CREATE TABLE IF NOT EXISTS manual_review_queue (
    id TEXT PRIMARY KEY,
    content_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    job_type TEXT NOT NULL,
    ai_result TEXT, -- JSON object with AI analysis
    priority TEXT NOT NULL CHECK (priority IN ('low', 'medium', 'high', 'urgent')),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_review', 'completed', 'escalated')),
    assigned_to TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at TEXT,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (assigned_to) REFERENCES users(id) ON DELETE SET NULL
);

-- Analytics Events Table (Raw Events)
CREATE TABLE IF NOT EXISTS analytics_events (
    id TEXT PRIMARY KEY,
    event_type TEXT NOT NULL,
    user_id TEXT NOT NULL,
    properties TEXT NOT NULL, -- JSON object with event properties
    timestamp TEXT NOT NULL,
    session_id TEXT,
    device_info TEXT, -- JSON object with device information
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Daily Metrics Table (Aggregated)
CREATE TABLE IF NOT EXISTS daily_metrics (
    id TEXT PRIMARY KEY, -- Format: metric-date
    metric TEXT NOT NULL,
    value REAL NOT NULL,
    dimensions TEXT NOT NULL, -- JSON object with metric dimensions
    date TEXT NOT NULL, -- YYYY-MM-DD format
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Hourly Metrics Table (Aggregated)
CREATE TABLE IF NOT EXISTS hourly_metrics (
    id TEXT PRIMARY KEY, -- Format: metric-date-hour
    metric TEXT NOT NULL,
    value REAL NOT NULL,
    dimensions TEXT NOT NULL, -- JSON object with metric dimensions
    date_hour TEXT NOT NULL, -- YYYY-MM-DD-HH format
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- User Activity Summary Table
CREATE TABLE IF NOT EXISTS user_activity_summary (
    user_id TEXT PRIMARY KEY,
    last_activity TEXT NOT NULL,
    daily_events INTEGER NOT NULL DEFAULT 0,
    session_count INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Business Metrics Table
CREATE TABLE IF NOT EXISTS business_metrics (
    date TEXT PRIMARY KEY, -- YYYY-MM-DD format
    bookings_created INTEGER NOT NULL DEFAULT 0,
    revenue REAL NOT NULL DEFAULT 0,
    chats_started INTEGER NOT NULL DEFAULT 0,
    profile_views INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Notification Results Table
CREATE TABLE IF NOT EXISTS notification_results (
    id TEXT PRIMARY KEY,
    notification_id TEXT NOT NULL,
    channel TEXT NOT NULL CHECK (channel IN ('push', 'email', 'sms', 'in_app', 'all')),
    status TEXT NOT NULL CHECK (status IN ('sent', 'failed', 'pending', 'skipped')),
    delivered_at TEXT,
    error TEXT,
    external_id TEXT, -- ID from external service (FCM, SendGrid, etc.)
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- In-App Notifications Table
CREATE TABLE IF NOT EXISTS in_app_notifications (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    title TEXT NOT NULL,
    message TEXT NOT NULL,
    data TEXT, -- JSON object with notification data
    priority TEXT NOT NULL CHECK (priority IN ('low', 'medium', 'high', 'urgent')),
    is_read BOOLEAN NOT NULL DEFAULT FALSE,
    read_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- User Devices Table (for push notifications)
CREATE TABLE IF NOT EXISTS user_devices (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    device_type TEXT NOT NULL CHECK (device_type IN ('ios', 'android', 'web')),
    push_tokens TEXT, -- JSON array of push tokens
    device_info TEXT, -- JSON object with device information
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    last_seen TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Create indexes for better performance

-- Moderation Results Indexes
CREATE INDEX IF NOT EXISTS idx_moderation_results_user_id ON moderation_results(user_id);
CREATE INDEX IF NOT EXISTS idx_moderation_results_content_id ON moderation_results(content_id);
CREATE INDEX IF NOT EXISTS idx_moderation_results_created_at ON moderation_results(created_at);
CREATE INDEX IF NOT EXISTS idx_moderation_results_action ON moderation_results(action);

-- Flagged Content Indexes
CREATE INDEX IF NOT EXISTS idx_flagged_content_content_id ON flagged_content(content_id);
CREATE INDEX IF NOT EXISTS idx_flagged_content_flagged_at ON flagged_content(flagged_at);
CREATE INDEX IF NOT EXISTS idx_flagged_content_resolved_at ON flagged_content(resolved_at);

-- Manual Review Queue Indexes
CREATE INDEX IF NOT EXISTS idx_manual_review_queue_status ON manual_review_queue(status);
CREATE INDEX IF NOT EXISTS idx_manual_review_queue_priority ON manual_review_queue(priority);
CREATE INDEX IF NOT EXISTS idx_manual_review_queue_assigned_to ON manual_review_queue(assigned_to);
CREATE INDEX IF NOT EXISTS idx_manual_review_queue_created_at ON manual_review_queue(created_at);

-- Analytics Events Indexes
CREATE INDEX IF NOT EXISTS idx_analytics_events_user_id ON analytics_events(user_id);
CREATE INDEX IF NOT EXISTS idx_analytics_events_event_type ON analytics_events(event_type);
CREATE INDEX IF NOT EXISTS idx_analytics_events_timestamp ON analytics_events(timestamp);
CREATE INDEX IF NOT EXISTS idx_analytics_events_session_id ON analytics_events(session_id);

-- Daily Metrics Indexes
CREATE INDEX IF NOT EXISTS idx_daily_metrics_metric ON daily_metrics(metric);
CREATE INDEX IF NOT EXISTS idx_daily_metrics_date ON daily_metrics(date);
CREATE INDEX IF NOT EXISTS idx_daily_metrics_metric_date ON daily_metrics(metric, date);

-- Hourly Metrics Indexes
CREATE INDEX IF NOT EXISTS idx_hourly_metrics_metric ON hourly_metrics(metric);
CREATE INDEX IF NOT EXISTS idx_hourly_metrics_date_hour ON hourly_metrics(date_hour);
CREATE INDEX IF NOT EXISTS idx_hourly_metrics_metric_date_hour ON hourly_metrics(metric, date_hour);

-- User Activity Summary Indexes
CREATE INDEX IF NOT EXISTS idx_user_activity_summary_last_activity ON user_activity_summary(last_activity);
CREATE INDEX IF NOT EXISTS idx_user_activity_summary_updated_at ON user_activity_summary(updated_at);

-- Business Metrics Indexes
CREATE INDEX IF NOT EXISTS idx_business_metrics_date ON business_metrics(date);

-- Notification Results Indexes
CREATE INDEX IF NOT EXISTS idx_notification_results_notification_id ON notification_results(notification_id);
CREATE INDEX IF NOT EXISTS idx_notification_results_channel ON notification_results(channel);
CREATE INDEX IF NOT EXISTS idx_notification_results_status ON notification_results(status);
CREATE INDEX IF NOT EXISTS idx_notification_results_created_at ON notification_results(created_at);

-- In-App Notifications Indexes
CREATE INDEX IF NOT EXISTS idx_in_app_notifications_user_id ON in_app_notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_in_app_notifications_is_read ON in_app_notifications(is_read);
CREATE INDEX IF NOT EXISTS idx_in_app_notifications_created_at ON in_app_notifications(created_at);
CREATE INDEX IF NOT EXISTS idx_in_app_notifications_user_unread ON in_app_notifications(user_id, is_read) WHERE is_read = FALSE;

-- User Devices Indexes
CREATE INDEX IF NOT EXISTS idx_user_devices_user_id ON user_devices(user_id);
CREATE INDEX IF NOT EXISTS idx_user_devices_is_active ON user_devices(is_active);
CREATE INDEX IF NOT EXISTS idx_user_devices_device_type ON user_devices(device_type);

-- Add notification preferences column to users table if it doesn't exist
-- This will be handled by a separate migration or ALTER statement
-- ALTER TABLE users ADD COLUMN notification_preferences TEXT DEFAULT '{"push":true,"email":true,"sms":false,"in_app":true}';

-- Add suspension fields to users table if they don't exist
-- ALTER TABLE users ADD COLUMN suspension_end TEXT;
-- ALTER TABLE users ADD COLUMN suspension_reason TEXT;
