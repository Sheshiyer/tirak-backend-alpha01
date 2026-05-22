-- Migration 005: Muse AI foundation
-- Adds consent, session, preference, recommendation, and privacy request tables.

CREATE TABLE IF NOT EXISTS ai_consent_events (
    id TEXT PRIMARY KEY,
    user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    session_id TEXT,
    consent_type TEXT NOT NULL CHECK (consent_type IN ('age_gate', 'ai_personalization', 'profile_assist', 'recommendation_retention', 'privacy_terms')),
    action TEXT NOT NULL CHECK (action IN ('granted', 'revoked', 'updated')),
    policy_version TEXT NOT NULL,
    birth_date_year INTEGER,
    is_adult BOOLEAN,
    metadata TEXT DEFAULT '{}',
    ip_address TEXT,
    user_agent TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS muse_sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    anonymous_id TEXT,
    user_role TEXT CHECK (user_role IN ('traveller', 'companion', 'admin')),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'expired', 'revoked')),
    entry_surface TEXT NOT NULL DEFAULT 'muse_home',
    consent_snapshot TEXT DEFAULT '{}',
    locale TEXT DEFAULT 'en',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at TEXT
);

CREATE TABLE IF NOT EXISTS muse_messages (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES muse_sessions(id) ON DELETE CASCADE,
    user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    sender TEXT NOT NULL CHECK (sender IN ('user', 'muse', 'system')),
    message_type TEXT NOT NULL DEFAULT 'text' CHECK (message_type IN ('text', 'intent', 'recommendation', 'profile_assist', 'system')),
    content TEXT,
    metadata TEXT DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS muse_preference_profiles (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES muse_sessions(id) ON DELETE CASCADE,
    user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    city_context TEXT,
    travel_context TEXT,
    intent_tags TEXT NOT NULL DEFAULT '[]',
    attraction_qualities TEXT NOT NULL DEFAULT '[]',
    experience_tags TEXT NOT NULL DEFAULT '[]',
    language_preferences TEXT NOT NULL DEFAULT '[]',
    safety_preferences TEXT NOT NULL DEFAULT '[]',
    explanation TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS recommendation_runs (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES muse_sessions(id) ON DELETE CASCADE,
    user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    preference_profile_id TEXT REFERENCES muse_preference_profiles(id) ON DELETE SET NULL,
    engine_version TEXT NOT NULL,
    engine_mode TEXT NOT NULL DEFAULT 'deterministic' CHECK (engine_mode IN ('deterministic', 'ai_assisted', 'manual')),
    input_summary TEXT,
    safety_filters TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('queued', 'completed', 'failed', 'redacted')),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS recommendation_items (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES recommendation_runs(id) ON DELETE CASCADE,
    item_type TEXT NOT NULL CHECK (item_type IN ('companion', 'experience', 'city', 'safety_note', 'next_step')),
    item_id TEXT,
    rank INTEGER NOT NULL,
    fit_score REAL,
    reason_codes TEXT NOT NULL DEFAULT '[]',
    explanation TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS privacy_requests (
    id TEXT PRIMARY KEY,
    user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    session_id TEXT REFERENCES muse_sessions(id) ON DELETE SET NULL,
    request_type TEXT NOT NULL CHECK (request_type IN ('export', 'delete', 'revoke_ai', 'correct_profile')),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_review', 'completed', 'rejected')),
    requested_payload TEXT DEFAULT '{}',
    operator_notes TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_ai_consent_events_user_id ON ai_consent_events(user_id);
CREATE INDEX IF NOT EXISTS idx_ai_consent_events_session_id ON ai_consent_events(session_id);
CREATE INDEX IF NOT EXISTS idx_ai_consent_events_type_created ON ai_consent_events(consent_type, created_at);

CREATE INDEX IF NOT EXISTS idx_muse_sessions_user_id ON muse_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_muse_sessions_anonymous_id ON muse_sessions(anonymous_id);
CREATE INDEX IF NOT EXISTS idx_muse_sessions_status ON muse_sessions(status);

CREATE INDEX IF NOT EXISTS idx_muse_messages_session_id ON muse_messages(session_id);
CREATE INDEX IF NOT EXISTS idx_muse_messages_created_at ON muse_messages(created_at);

CREATE INDEX IF NOT EXISTS idx_muse_preference_profiles_session_id ON muse_preference_profiles(session_id);
CREATE INDEX IF NOT EXISTS idx_muse_preference_profiles_user_id ON muse_preference_profiles(user_id);

CREATE INDEX IF NOT EXISTS idx_recommendation_runs_session_id ON recommendation_runs(session_id);
CREATE INDEX IF NOT EXISTS idx_recommendation_runs_user_id ON recommendation_runs(user_id);
CREATE INDEX IF NOT EXISTS idx_recommendation_items_run_id ON recommendation_items(run_id);
CREATE INDEX IF NOT EXISTS idx_recommendation_items_rank ON recommendation_items(run_id, rank);

CREATE INDEX IF NOT EXISTS idx_privacy_requests_user_id ON privacy_requests(user_id);
CREATE INDEX IF NOT EXISTS idx_privacy_requests_status ON privacy_requests(status);
