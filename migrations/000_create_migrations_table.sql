-- Migration: 000_create_migrations_table.sql
-- Creates the _migrations table to track applied migrations

-- Create migrations tracking table if it doesn't exist
CREATE TABLE IF NOT EXISTS _migrations (
  name TEXT PRIMARY KEY,
  applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Insert record for this migration
INSERT OR IGNORE INTO _migrations (name, applied_at) 
VALUES ('000_create_migrations_table', CURRENT_TIMESTAMP); 