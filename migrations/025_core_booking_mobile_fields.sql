-- Core additive booking fields required by the current mobile/Core handlers.
-- Apply only after reviewing the selected target schema metadata. Fresh Core
-- baselines need these columns; legacy targets may already carry some or all
-- via historical drift, so reconcile first and do not blind-apply.

ALTER TABLE bookings ADD COLUMN customer_preferences TEXT;
ALTER TABLE bookings ADD COLUMN special_requests TEXT;
ALTER TABLE bookings ADD COLUMN preferred_language TEXT;
ALTER TABLE bookings ADD COLUMN group_composition TEXT;
ALTER TABLE bookings ADD COLUMN dietary_requirements TEXT;
ALTER TABLE bookings ADD COLUMN experience_id TEXT;
ALTER TABLE bookings ADD COLUMN payment_status TEXT NOT NULL DEFAULT 'pending'
  CHECK (payment_status IN ('pending', 'processing', 'completed', 'failed', 'refunded'));
ALTER TABLE bookings ADD COLUMN location TEXT;
