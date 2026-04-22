-- Vendor/Supplier onboarding applications from the website form
CREATE TABLE IF NOT EXISTS vendor_applications (
    id TEXT PRIMARY KEY,
    brand_name TEXT NOT NULL,
    reg_name TEXT,
    description TEXT NOT NULL,
    website TEXT,
    social TEXT,
    primary_category TEXT NOT NULL,
    price_range TEXT NOT NULL,
    contact_name TEXT NOT NULL,
    contact_role TEXT NOT NULL,
    email TEXT NOT NULL,
    phone TEXT NOT NULL,
    chat_app TEXT NOT NULL DEFAULT 'LINE',
    chat_id TEXT NOT NULL,
    address TEXT NOT NULL,
    maps_url TEXT NOT NULL,
    hours TEXT,
    tax_id TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'reviewed', 'approved', 'rejected')),
    reviewer_notes TEXT,
    reviewed_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_vendor_applications_status ON vendor_applications(status);
CREATE INDEX IF NOT EXISTS idx_vendor_applications_email ON vendor_applications(email);
CREATE INDEX IF NOT EXISTS idx_vendor_applications_category ON vendor_applications(primary_category);
