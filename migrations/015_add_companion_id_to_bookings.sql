-- Add companion_id to bookings table
ALTER TABLE bookings ADD COLUMN companion_id TEXT;

-- Optional: Add a foreign key constraint if companion_profiles table exists and has a user_id column
-- Note: SQLite does not support adding a foreign key constraint with ALTER TABLE directly
-- in older versions. For D1, this should be fine.
-- If this fails, you might need to recreate the table.

-- For now, we'll just add the column. You can populate it with a separate script. 