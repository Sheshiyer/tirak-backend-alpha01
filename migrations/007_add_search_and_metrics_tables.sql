-- Search and metrics tables migration
-- Migration: 007_add_search_and_metrics_tables.sql

-- Search logs table
CREATE TABLE IF NOT EXISTS search_logs (
    id TEXT PRIMARY KEY,
    user_id TEXT REFERENCES users(id),
    search_term TEXT NOT NULL,
    result_count INTEGER,
    filters TEXT, -- JSON object
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    session_id TEXT,
    ip_address TEXT
);

-- System metrics table
CREATE TABLE IF NOT EXISTS system_metrics (
    id TEXT PRIMARY KEY,
    metric_name TEXT NOT NULL,
    metric_value REAL NOT NULL,
    metric_unit TEXT,
    component TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    notes TEXT
);

-- Analytics reports table
CREATE TABLE IF NOT EXISTS analytics_reports (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'generating', 'completed', 'failed')),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    created_by TEXT REFERENCES users(id),
    completed_at DATETIME,
    download_url TEXT,
    report_data TEXT -- JSON object
);

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_search_logs_user_id ON search_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_search_logs_search_term ON search_logs(search_term);
CREATE INDEX IF NOT EXISTS idx_search_logs_created_at ON search_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_search_logs_session_id ON search_logs(session_id);

CREATE INDEX IF NOT EXISTS idx_system_metrics_metric_name ON system_metrics(metric_name);
CREATE INDEX IF NOT EXISTS idx_system_metrics_component ON system_metrics(component);
CREATE INDEX IF NOT EXISTS idx_system_metrics_created_at ON system_metrics(created_at);

CREATE INDEX IF NOT EXISTS idx_analytics_reports_status ON analytics_reports(status);
CREATE INDEX IF NOT EXISTS idx_analytics_reports_created_at ON analytics_reports(created_at);
CREATE INDEX IF NOT EXISTS idx_analytics_reports_created_by ON analytics_reports(created_by);
