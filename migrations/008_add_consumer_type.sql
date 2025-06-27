-- Migration to add 'companion' user type to users table constraint
-- Migration: 008_add_companion_type.sql

-- Modify the CHECK constraint on the user_type column to include 'companion'
ALTER TABLE users DROP CONSTRAINT user_type;
ALTER TABLE users ADD CONSTRAINT user_type CHECK (user_type IN ('customer', 'supplier', 'admin', 'companion'));

-- Log the migration
INSERT INTO _migrations (name, applied_at) 
VALUES ('008_add_companion_type', CURRENT_TIMESTAMP); 