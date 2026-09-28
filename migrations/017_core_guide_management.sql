-- Additive Core guide management. Apply this selected migration only after backup.
-- Service identifiers and booking foreign keys remain unchanged.
ALTER TABLE supplier_services ADD COLUMN keywords TEXT NOT NULL DEFAULT '[]';
ALTER TABLE supplier_services ADD COLUMN archived_at TEXT;

CREATE TABLE supplier_availability_overrides (
  supplier_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date TEXT NOT NULL CHECK (date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  is_available INTEGER NOT NULL CHECK (is_available IN (0, 1)),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (supplier_id, date)
);

-- Prevent two concurrent requests from reserving the same guide interval.
CREATE TRIGGER core_booking_no_overlap_insert
BEFORE INSERT ON bookings
WHEN NEW.status IN ('pending', 'confirmed', 'in_progress')
BEGIN
  SELECT RAISE(ABORT, 'core_booking_overlap') WHERE EXISTS (
    SELECT 1 FROM bookings b WHERE b.supplier_id = NEW.supplier_id
      AND b.status IN ('pending', 'confirmed', 'in_progress')
      AND datetime(b.scheduled_at) < datetime(NEW.scheduled_at, '+' || NEW.duration || ' minutes')
      AND datetime(b.scheduled_at, '+' || b.duration || ' minutes') > datetime(NEW.scheduled_at)
  );
END;
CREATE TRIGGER core_booking_no_overlap_update
BEFORE UPDATE OF scheduled_at, duration, supplier_id, status ON bookings
WHEN NEW.status IN ('pending', 'confirmed', 'in_progress')
BEGIN
  SELECT RAISE(ABORT, 'core_booking_overlap') WHERE EXISTS (
    SELECT 1 FROM bookings b WHERE b.id != NEW.id AND b.supplier_id = NEW.supplier_id
      AND b.status IN ('pending', 'confirmed', 'in_progress')
      AND datetime(b.scheduled_at) < datetime(NEW.scheduled_at, '+' || NEW.duration || ' minutes')
      AND datetime(b.scheduled_at, '+' || b.duration || ' minutes') > datetime(NEW.scheduled_at)
  );
END;
