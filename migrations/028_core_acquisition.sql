-- Accepted Core campaign submissions. No user or booking changes.
CREATE TABLE IF NOT EXISTS core_acquisition_conversions (
  resource_kind TEXT NOT NULL CHECK(resource_kind IN ('interest','guide_application')),
  resource_id TEXT NOT NULL,
  landing_path TEXT NOT NULL,
  utm_source TEXT,
  utm_medium TEXT,
  utm_campaign TEXT,
  utm_content TEXT,
  accepted_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY(resource_kind, resource_id)
);
CREATE INDEX IF NOT EXISTS idx_core_acquisition_campaign ON core_acquisition_conversions(utm_campaign, accepted_at);
