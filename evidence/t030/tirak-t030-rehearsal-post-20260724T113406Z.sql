PRAGMA defer_foreign_keys=TRUE;
CREATE TABLE d1_migrations(
		id         INTEGER PRIMARY KEY AUTOINCREMENT,
		name       TEXT UNIQUE,
		applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
);
INSERT INTO "d1_migrations" ("id","name","applied_at") VALUES(1,'canonical-baseline.sql','2026-07-24 11:36:39');
INSERT INTO "d1_migrations" ("id","name","applied_at") VALUES(2,'008_omise_promptpay_payments.sql','2026-07-24 11:36:56');
INSERT INTO "d1_migrations" ("id","name","applied_at") VALUES(3,'010_booking_chat_expansion.sql','2026-07-24 11:36:57');
INSERT INTO "d1_migrations" ("id","name","applied_at") VALUES(4,'011_payment_restitutions.sql','2026-07-24 11:36:57');
CREATE TABLE users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    phone TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    user_type TEXT NOT NULL CHECK (user_type IN ('customer', 'supplier', 'admin')),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('active', 'suspended', 'pending')),
    email_verified BOOLEAN DEFAULT FALSE,
    phone_verified BOOLEAN DEFAULT FALSE,
    preferred_language TEXT DEFAULT 'en' CHECK (preferred_language IN ('en', 'th')),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_login_at DATETIME
);
INSERT INTO "users" ("id","email","phone","password_hash","user_type","status","email_verified","phone_verified","preferred_language","created_at","updated_at","last_login_at") VALUES('t030_u_customer','t030+cust@rehearsal.invalid','+66000030001','x','customer','active',0,0,'en','2026-07-24 11:48:13','2026-07-24 11:48:13',NULL);
INSERT INTO "users" ("id","email","phone","password_hash","user_type","status","email_verified","phone_verified","preferred_language","created_at","updated_at","last_login_at") VALUES('t030_u_supplier','t030+supp@rehearsal.invalid','+66000030002','x','supplier','active',0,0,'en','2026-07-24 11:48:13','2026-07-24 11:48:13',NULL);
INSERT INTO "users" ("id","email","phone","password_hash","user_type","status","email_verified","phone_verified","preferred_language","created_at","updated_at","last_login_at") VALUES('t030_u_approver','t030+appr@rehearsal.invalid','+66000030003','x','admin','active',0,0,'en','2026-07-24 11:48:13','2026-07-24 11:48:13',NULL);
CREATE TABLE supplier_profiles (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    display_name TEXT NOT NULL,
    bio TEXT,
    profile_images TEXT, 
    categories TEXT, 
    regions TEXT, 
    spoken_languages TEXT, 
    rating_average REAL DEFAULT 0.0,
    rating_count INTEGER DEFAULT 0,
    verification_status TEXT DEFAULT 'pending' CHECK (verification_status IN ('pending', 'verified', 'rejected')),
    subscription_status TEXT DEFAULT 'inactive' CHECK (subscription_status IN ('active', 'inactive', 'expired')),
    subscription_tier TEXT DEFAULT 'basic' CHECK (subscription_tier IN ('basic', 'premium', 'enterprise')),
    subscription_expires_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
, first_name TEXT, last_name TEXT, cover_photo TEXT, location TEXT, social_links TEXT DEFAULT '{}', date_of_birth TEXT, gender TEXT CHECK (gender IN ('male', 'female', 'other')), certifications TEXT DEFAULT '[]', experience_stats TEXT DEFAULT '{}');
CREATE TABLE customer_profiles (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    display_name TEXT NOT NULL,
    profile_image TEXT,
    preferences TEXT, 
    loyalty_points INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
, bio TEXT);
CREATE TABLE supplier_services (
    id TEXT PRIMARY KEY,
    supplier_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    description TEXT,
    price_min REAL NOT NULL,
    price_max REAL NOT NULL,
    currency TEXT DEFAULT 'THB',
    duration_hours INTEGER NOT NULL,
    is_active BOOLEAN DEFAULT TRUE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "supplier_services" ("id","supplier_id","title","description","price_min","price_max","currency","duration_hours","is_active","created_at","updated_at") VALUES('t030_svc_1','t030_u_supplier','Rehearsal Service',NULL,100,100,'THB',1,1,'2026-07-24 11:48:13','2026-07-24 11:48:13');
CREATE TABLE supplier_availability (
    id TEXT PRIMARY KEY,
    supplier_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    day_of_week INTEGER NOT NULL CHECK (day_of_week BETWEEN 0 AND 6), 
    start_time TEXT NOT NULL, 
    end_time TEXT NOT NULL, 
    is_available BOOLEAN DEFAULT TRUE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(supplier_id, day_of_week)
);
CREATE TABLE chat_rooms (
    id TEXT PRIMARY KEY,
    customer_id TEXT NOT NULL REFERENCES users(id),
    supplier_id TEXT NOT NULL REFERENCES users(id),
    status TEXT DEFAULT 'active' CHECK (status IN ('active', 'closed', 'archived')),
    last_message_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(customer_id, supplier_id)
);
CREATE TABLE chat_messages (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL REFERENCES chat_rooms(id) ON DELETE CASCADE,
    sender_id TEXT NOT NULL REFERENCES users(id),
    message_type TEXT NOT NULL CHECK (message_type IN ('text', 'image', 'system')),
    content TEXT,
    image_url TEXT,
    metadata TEXT, 
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE bookings (
    id TEXT PRIMARY KEY,
    customer_id TEXT NOT NULL REFERENCES users(id),
    supplier_id TEXT NOT NULL REFERENCES users(id),
    service_id TEXT NOT NULL REFERENCES supplier_services(id),
    status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'completed', 'cancelled')),
    scheduled_at DATETIME NOT NULL,
    duration INTEGER NOT NULL, 
    total_amount REAL NOT NULL,
    currency TEXT DEFAULT 'THB',
    notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "bookings" ("id","customer_id","supplier_id","service_id","status","scheduled_at","duration","total_amount","currency","notes","created_at","updated_at") VALUES('t030_bk_1','t030_u_customer','t030_u_supplier','t030_svc_1','confirmed','2026-07-25 10:00:00',1,100,'THB',NULL,'2026-07-24 11:48:13','2026-07-24 11:48:13');
CREATE TABLE reviews (
    id TEXT PRIMARY KEY,
    booking_id TEXT NOT NULL REFERENCES bookings(id),
    reviewer_id TEXT NOT NULL REFERENCES users(id),
    reviewee_id TEXT NOT NULL REFERENCES users(id),
    rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
    comment TEXT,
    is_public BOOLEAN DEFAULT TRUE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(booking_id, reviewer_id)
);
CREATE TABLE categories (
    id TEXT PRIMARY KEY,
    name_en TEXT NOT NULL,
    name_th TEXT NOT NULL,
    description_en TEXT,
    description_th TEXT,
    icon_url TEXT,
    is_active BOOLEAN DEFAULT TRUE,
    sort_order INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE regions (
    id TEXT PRIMARY KEY,
    name_en TEXT NOT NULL,
    name_th TEXT NOT NULL,
    country_code TEXT DEFAULT 'TH',
    is_active BOOLEAN DEFAULT TRUE,
    sort_order INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE user_sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    refresh_token_hash TEXT NOT NULL,
    device_id TEXT,
    ip_address TEXT,
    user_agent TEXT,
    expires_at DATETIME NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_active_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE analytics_events (
    id TEXT PRIMARY KEY,
    event_type TEXT NOT NULL,
    user_id TEXT REFERENCES users(id),
    session_id TEXT,
    properties TEXT, 
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    ip_address TEXT,
    user_agent TEXT
);
CREATE TABLE moderation_queue (
    id TEXT PRIMARY KEY,
    content_type TEXT NOT NULL CHECK (content_type IN ('message', 'profile', 'review', 'image')),
    content_id TEXT NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id),
    status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
    priority TEXT DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high', 'urgent')),
    flagged_reason TEXT,
    moderator_id TEXT REFERENCES users(id),
    moderator_notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    reviewed_at DATETIME
);
CREATE TABLE moderation_results (
    id TEXT PRIMARY KEY,
    content_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    job_type TEXT NOT NULL CHECK (job_type IN ('text_analysis', 'image_analysis', 'profile_review', 'manual_review')),
    action TEXT NOT NULL CHECK (action IN ('approve', 'flag', 'remove', 'escalate', 'suspend_user')),
    confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
    reasons TEXT NOT NULL, 
    severity TEXT NOT NULL CHECK (severity IN ('low', 'medium', 'high', 'critical')),
    ai_analysis TEXT, 
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE TABLE flagged_content (
    id TEXT PRIMARY KEY,
    content_id TEXT NOT NULL,
    content_type TEXT NOT NULL DEFAULT 'message',
    reasons TEXT NOT NULL, 
    flagged_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    resolved_at TEXT,
    resolved_by TEXT,
    resolution_action TEXT,
    FOREIGN KEY (resolved_by) REFERENCES users(id) ON DELETE SET NULL
);
CREATE TABLE manual_review_queue (
    id TEXT PRIMARY KEY,
    content_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    job_type TEXT NOT NULL,
    ai_result TEXT, 
    priority TEXT NOT NULL CHECK (priority IN ('low', 'medium', 'high', 'urgent')),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_review', 'completed', 'escalated')),
    assigned_to TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at TEXT,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (assigned_to) REFERENCES users(id) ON DELETE SET NULL
);
CREATE TABLE daily_metrics (
    id TEXT PRIMARY KEY, 
    metric TEXT NOT NULL,
    value REAL NOT NULL,
    dimensions TEXT NOT NULL, 
    date TEXT NOT NULL, 
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE hourly_metrics (
    id TEXT PRIMARY KEY, 
    metric TEXT NOT NULL,
    value REAL NOT NULL,
    dimensions TEXT NOT NULL, 
    date_hour TEXT NOT NULL, 
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE user_activity_summary (
    user_id TEXT PRIMARY KEY,
    last_activity TEXT NOT NULL,
    daily_events INTEGER NOT NULL DEFAULT 0,
    session_count INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE TABLE business_metrics (
    date TEXT PRIMARY KEY, 
    bookings_created INTEGER NOT NULL DEFAULT 0,
    revenue REAL NOT NULL DEFAULT 0,
    chats_started INTEGER NOT NULL DEFAULT 0,
    profile_views INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE notification_results (
    id TEXT PRIMARY KEY,
    notification_id TEXT NOT NULL,
    channel TEXT NOT NULL CHECK (channel IN ('push', 'email', 'sms', 'in_app', 'all')),
    status TEXT NOT NULL CHECK (status IN ('sent', 'failed', 'pending', 'skipped')),
    delivered_at TEXT,
    error TEXT,
    external_id TEXT, 
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE in_app_notifications (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    title TEXT NOT NULL,
    message TEXT NOT NULL,
    data TEXT, 
    priority TEXT NOT NULL CHECK (priority IN ('low', 'medium', 'high', 'urgent')),
    is_read BOOLEAN NOT NULL DEFAULT FALSE,
    read_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE TABLE user_devices (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    device_type TEXT NOT NULL CHECK (device_type IN ('ios', 'android', 'web')),
    push_tokens TEXT, 
    device_info TEXT, 
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    last_seen TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE TABLE ai_consent_events (
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
CREATE TABLE muse_sessions (
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
CREATE TABLE muse_messages (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES muse_sessions(id) ON DELETE CASCADE,
    user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    sender TEXT NOT NULL CHECK (sender IN ('user', 'muse', 'system')),
    message_type TEXT NOT NULL DEFAULT 'text' CHECK (message_type IN ('text', 'intent', 'recommendation', 'profile_assist', 'system')),
    content TEXT,
    metadata TEXT DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE muse_preference_profiles (
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
CREATE TABLE recommendation_runs (
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
CREATE TABLE recommendation_items (
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
CREATE TABLE privacy_requests (
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
CREATE TABLE referral_accounts (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    referral_code TEXT UNIQUE NOT NULL,
    referred_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    coin_balance INTEGER NOT NULL DEFAULT 0,
    total_earned INTEGER NOT NULL DEFAULT 0,
    total_redeemed INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE referral_events (
    id TEXT PRIMARY KEY,
    referrer_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    referred_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    referral_code TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'awarded' CHECK (status IN ('pending', 'awarded', 'reversed')),
    coins_awarded INTEGER NOT NULL DEFAULT 100,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at TEXT,
    UNIQUE(referred_user_id)
);
CREATE TABLE coin_transactions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    amount INTEGER NOT NULL,
    transaction_type TEXT NOT NULL CHECK (transaction_type IN ('referral_bonus', 'redemption', 'admin_adjustment')),
    reason TEXT NOT NULL,
    related_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    referral_event_id TEXT REFERENCES referral_events(id) ON DELETE SET NULL,
    metadata TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE payment_attempts (
    id TEXT PRIMARY KEY,
    booking_id TEXT NOT NULL REFERENCES bookings(id),
    customer_id TEXT NOT NULL REFERENCES users(id),
    provider TEXT NOT NULL CHECK (provider = 'omise'),
    payment_method TEXT NOT NULL CHECK (payment_method = 'promptpay'),
    idempotency_key TEXT NOT NULL UNIQUE,
    attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
    provider_charge_id TEXT UNIQUE,
    amount_satang INTEGER NOT NULL CHECK (amount_satang > 0),
    currency TEXT NOT NULL CHECK (currency = 'THB'),
    status TEXT NOT NULL CHECK (status IN ('creating', 'indeterminate', 'pending', 'successful', 'failed', 'expired')),
    qr_code_url TEXT,
    expires_at TEXT,
    last_checked_at TEXT,
    indeterminate_at TEXT,
    last_error_at TEXT,
    last_error_code TEXT,
    recovered_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (booking_id, attempt_number)
);
INSERT INTO "payment_attempts" ("id","booking_id","customer_id","provider","payment_method","idempotency_key","attempt_number","provider_charge_id","amount_satang","currency","status","qr_code_url","expires_at","last_checked_at","indeterminate_at","last_error_at","last_error_code","recovered_at","created_at","updated_at") VALUES('t030_pa_1','t030_bk_1','t030_u_customer','omise','promptpay','t030_idem_1',1,'chrg_t030_1',10000,'THB','successful',NULL,NULL,NULL,NULL,NULL,NULL,NULL,'2026-07-24 11:48:13','2026-07-24 11:48:13');
INSERT INTO "payment_attempts" ("id","booking_id","customer_id","provider","payment_method","idempotency_key","attempt_number","provider_charge_id","amount_satang","currency","status","qr_code_url","expires_at","last_checked_at","indeterminate_at","last_error_at","last_error_code","recovered_at","created_at","updated_at") VALUES('t030_pa_2','t030_bk_1','t030_u_customer','omise','promptpay','t030_idem_2',2,'chrg_t030_2',10000,'THB','successful',NULL,NULL,NULL,NULL,NULL,NULL,NULL,'2026-07-24 11:48:13','2026-07-24 11:48:13');
INSERT INTO "payment_attempts" ("id","booking_id","customer_id","provider","payment_method","idempotency_key","attempt_number","provider_charge_id","amount_satang","currency","status","qr_code_url","expires_at","last_checked_at","indeterminate_at","last_error_at","last_error_code","recovered_at","created_at","updated_at") VALUES('t030_pa_3','t030_bk_1','t030_u_customer','omise','promptpay','t030_idem_3',3,'chrg_t030_3',10000,'THB','successful',NULL,NULL,NULL,NULL,NULL,NULL,NULL,'2026-07-24 11:48:13','2026-07-24 11:48:13');
INSERT INTO "payment_attempts" ("id","booking_id","customer_id","provider","payment_method","idempotency_key","attempt_number","provider_charge_id","amount_satang","currency","status","qr_code_url","expires_at","last_checked_at","indeterminate_at","last_error_at","last_error_code","recovered_at","created_at","updated_at") VALUES('t030_pa_4','t030_bk_1','t030_u_customer','omise','promptpay','t030_idem_4',4,'chrg_t030_4',10000,'THB','successful',NULL,NULL,NULL,NULL,NULL,NULL,NULL,'2026-07-24 11:48:13','2026-07-24 11:48:13');
CREATE TABLE payment_webhook_events (
    replay_key TEXT PRIMARY KEY,
    provider_event_id TEXT UNIQUE,
    provider_charge_id TEXT NOT NULL,
    signature_timestamp INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('received', 'processed', 'ignored', 'failed')),
    received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    processed_at TEXT
);
CREATE TABLE booking_chat_rooms (
    id TEXT PRIMARY KEY,
    booking_id TEXT NOT NULL UNIQUE REFERENCES bookings(id) ON DELETE CASCADE,
    customer_id TEXT NOT NULL REFERENCES users(id),
    supplier_id TEXT NOT NULL REFERENCES users(id),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closed', 'archived')),
    last_message_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "booking_chat_rooms" ("id","booking_id","customer_id","supplier_id","status","last_message_at","created_at","updated_at") VALUES('t030_br_1','t030_bk_1','t030_u_customer','t030_u_supplier','active',NULL,'2026-07-24 11:49:20','2026-07-24 11:49:20');
CREATE TABLE booking_chat_messages (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL REFERENCES booking_chat_rooms(id) ON DELETE CASCADE,
    sender_id TEXT NOT NULL REFERENCES users(id),
    message_type TEXT NOT NULL CHECK (message_type IN ('text', 'image', 'system')),
    content TEXT,
    image_url TEXT,
    metadata TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    delivered_at TEXT,
    read_at TEXT,
    reply_to_id TEXT REFERENCES booking_chat_messages(id)
);
INSERT INTO "booking_chat_messages" ("id","room_id","sender_id","message_type","content","image_url","metadata","created_at","delivered_at","read_at","reply_to_id") VALUES('t030_bm_1','t030_br_1','t030_u_supplier','text','hello from new worker',NULL,NULL,'2026-07-24 11:49:20',NULL,NULL,NULL);
CREATE TABLE payment_restitutions (
    id TEXT PRIMARY KEY,
    booking_id TEXT NOT NULL REFERENCES bookings(id),
    payment_attempt_id TEXT NOT NULL UNIQUE REFERENCES payment_attempts(id),
    provider_charge_id TEXT NOT NULL UNIQUE,
    customer_id TEXT NOT NULL REFERENCES users(id),
    amount_satang INTEGER NOT NULL CHECK (amount_satang > 0),
    currency TEXT NOT NULL CHECK (currency = 'THB'),
    reason TEXT NOT NULL,
    recipient_reference TEXT,
    evidence_uri TEXT,
    approver_user_id TEXT REFERENCES users(id),
    status TEXT NOT NULL CHECK (status IN ('restitution_pending', 'restituted', 'restitution_failed')),
    requested_at TEXT NOT NULL,
    approved_at TEXT,
    completed_at TEXT,
    failed_at TEXT,
    failure_reason TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK (
      (status = 'restitution_pending' AND completed_at IS NULL AND failed_at IS NULL)
      OR
      (status = 'restituted' AND recipient_reference IS NOT NULL AND evidence_uri IS NOT NULL AND approver_user_id IS NOT NULL AND approved_at IS NOT NULL AND completed_at IS NOT NULL AND failed_at IS NULL)
      OR
      (status = 'restitution_failed' AND evidence_uri IS NOT NULL AND approver_user_id IS NOT NULL AND approved_at IS NOT NULL AND failed_at IS NOT NULL AND failure_reason IS NOT NULL AND completed_at IS NULL)
    )
);
INSERT INTO "payment_restitutions" ("id","booking_id","payment_attempt_id","provider_charge_id","customer_id","amount_satang","currency","reason","recipient_reference","evidence_uri","approver_user_id","status","requested_at","approved_at","completed_at","failed_at","failure_reason","created_at","updated_at") VALUES('t030_rt_pending','t030_bk_1','t030_pa_1','chrg_t030_1','t030_u_customer',10000,'THB','duplicate charge',NULL,NULL,NULL,'restitution_pending','2026-07-24T11:40:00Z',NULL,NULL,NULL,NULL,'2026-07-24 11:50:47','2026-07-24 11:50:47');
INSERT INTO "payment_restitutions" ("id","booking_id","payment_attempt_id","provider_charge_id","customer_id","amount_satang","currency","reason","recipient_reference","evidence_uri","approver_user_id","status","requested_at","approved_at","completed_at","failed_at","failure_reason","created_at","updated_at") VALUES('t030_rt_done','t030_bk_1','t030_pa_2','chrg_t030_2','t030_u_customer',10000,'THB','service cancelled','promptpay-0812345678','r2://tirak-evidence/t030/receipt.pdf','t030_u_approver','restituted','2026-07-24T11:40:00Z','2026-07-24T11:41:00Z','2026-07-24T11:42:00Z',NULL,NULL,'2026-07-24 11:50:47','2026-07-24 11:50:47');
INSERT INTO "payment_restitutions" ("id","booking_id","payment_attempt_id","provider_charge_id","customer_id","amount_satang","currency","reason","recipient_reference","evidence_uri","approver_user_id","status","requested_at","approved_at","completed_at","failed_at","failure_reason","created_at","updated_at") VALUES('t030_rt_failed','t030_bk_1','t030_pa_3','chrg_t030_3','t030_u_customer',10000,'THB','service cancelled',NULL,'r2://tirak-evidence/t030/attempt.pdf','t030_u_approver','restitution_failed','2026-07-24T11:40:00Z','2026-07-24T11:41:00Z',NULL,'2026-07-24T11:43:00Z','provider rejected refund','2026-07-24 11:50:47','2026-07-24 11:50:47');
DELETE FROM sqlite_sequence;
INSERT INTO "sqlite_sequence" ("name","seq") VALUES('d1_migrations',4);
CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_phone ON users(phone);
CREATE INDEX idx_users_user_type ON users(user_type);
CREATE INDEX idx_users_status ON users(status);
CREATE INDEX idx_users_created_at ON users(created_at);
CREATE INDEX idx_supplier_profiles_verification_status ON supplier_profiles(verification_status);
CREATE INDEX idx_supplier_profiles_subscription_status ON supplier_profiles(subscription_status);
CREATE INDEX idx_supplier_profiles_rating_average ON supplier_profiles(rating_average);
CREATE INDEX idx_supplier_profiles_created_at ON supplier_profiles(created_at);
CREATE INDEX idx_supplier_services_supplier_id ON supplier_services(supplier_id);
CREATE INDEX idx_supplier_services_is_active ON supplier_services(is_active);
CREATE INDEX idx_supplier_services_price_min ON supplier_services(price_min);
CREATE INDEX idx_supplier_services_price_max ON supplier_services(price_max);
CREATE INDEX idx_supplier_availability_supplier_id ON supplier_availability(supplier_id);
CREATE INDEX idx_supplier_availability_day_of_week ON supplier_availability(day_of_week);
CREATE INDEX idx_supplier_availability_is_available ON supplier_availability(is_available);
CREATE INDEX idx_chat_rooms_customer_id ON chat_rooms(customer_id);
CREATE INDEX idx_chat_rooms_supplier_id ON chat_rooms(supplier_id);
CREATE INDEX idx_chat_rooms_status ON chat_rooms(status);
CREATE INDEX idx_chat_rooms_last_message_at ON chat_rooms(last_message_at);
CREATE INDEX idx_chat_rooms_created_at ON chat_rooms(created_at);
CREATE INDEX idx_chat_messages_room_id ON chat_messages(room_id);
CREATE INDEX idx_chat_messages_sender_id ON chat_messages(sender_id);
CREATE INDEX idx_chat_messages_message_type ON chat_messages(message_type);
CREATE INDEX idx_chat_messages_created_at ON chat_messages(created_at);
CREATE INDEX idx_bookings_customer_id ON bookings(customer_id);
CREATE INDEX idx_bookings_supplier_id ON bookings(supplier_id);
CREATE INDEX idx_bookings_service_id ON bookings(service_id);
CREATE INDEX idx_bookings_status ON bookings(status);
CREATE INDEX idx_bookings_scheduled_at ON bookings(scheduled_at);
CREATE INDEX idx_bookings_created_at ON bookings(created_at);
CREATE INDEX idx_reviews_booking_id ON reviews(booking_id);
CREATE INDEX idx_reviews_reviewer_id ON reviews(reviewer_id);
CREATE INDEX idx_reviews_reviewee_id ON reviews(reviewee_id);
CREATE INDEX idx_reviews_rating ON reviews(rating);
CREATE INDEX idx_reviews_is_public ON reviews(is_public);
CREATE INDEX idx_reviews_created_at ON reviews(created_at);
CREATE INDEX idx_categories_is_active ON categories(is_active);
CREATE INDEX idx_categories_sort_order ON categories(sort_order);
CREATE INDEX idx_regions_country_code ON regions(country_code);
CREATE INDEX idx_regions_is_active ON regions(is_active);
CREATE INDEX idx_regions_sort_order ON regions(sort_order);
CREATE INDEX idx_user_sessions_user_id ON user_sessions(user_id);
CREATE INDEX idx_user_sessions_expires_at ON user_sessions(expires_at);
CREATE INDEX idx_user_sessions_last_active_at ON user_sessions(last_active_at);
CREATE INDEX idx_suppliers_search ON supplier_profiles(verification_status, subscription_status, rating_average);
CREATE INDEX idx_chat_messages_room_time ON chat_messages(room_id, created_at);
CREATE INDEX idx_bookings_supplier_status ON bookings(supplier_id, status);
CREATE INDEX idx_reviews_reviewee_public ON reviews(reviewee_id, is_public);
CREATE INDEX idx_analytics_events_event_type ON analytics_events(event_type);
CREATE INDEX idx_analytics_events_user_id ON analytics_events(user_id);
CREATE INDEX idx_analytics_events_timestamp ON analytics_events(timestamp);
CREATE INDEX idx_analytics_events_session_id ON analytics_events(session_id);
CREATE INDEX idx_moderation_queue_content_type ON moderation_queue(content_type);
CREATE INDEX idx_moderation_queue_user_id ON moderation_queue(user_id);
CREATE INDEX idx_moderation_queue_status ON moderation_queue(status);
CREATE INDEX idx_moderation_queue_priority ON moderation_queue(priority);
CREATE INDEX idx_moderation_queue_created_at ON moderation_queue(created_at);
CREATE INDEX idx_moderation_queue_moderator_id ON moderation_queue(moderator_id);
CREATE INDEX idx_moderation_results_user_id ON moderation_results(user_id);
CREATE INDEX idx_moderation_results_content_id ON moderation_results(content_id);
CREATE INDEX idx_moderation_results_created_at ON moderation_results(created_at);
CREATE INDEX idx_moderation_results_action ON moderation_results(action);
CREATE INDEX idx_flagged_content_content_id ON flagged_content(content_id);
CREATE INDEX idx_flagged_content_flagged_at ON flagged_content(flagged_at);
CREATE INDEX idx_flagged_content_resolved_at ON flagged_content(resolved_at);
CREATE INDEX idx_manual_review_queue_status ON manual_review_queue(status);
CREATE INDEX idx_manual_review_queue_priority ON manual_review_queue(priority);
CREATE INDEX idx_manual_review_queue_assigned_to ON manual_review_queue(assigned_to);
CREATE INDEX idx_manual_review_queue_created_at ON manual_review_queue(created_at);
CREATE INDEX idx_daily_metrics_metric ON daily_metrics(metric);
CREATE INDEX idx_daily_metrics_date ON daily_metrics(date);
CREATE INDEX idx_daily_metrics_metric_date ON daily_metrics(metric, date);
CREATE INDEX idx_hourly_metrics_metric ON hourly_metrics(metric);
CREATE INDEX idx_hourly_metrics_date_hour ON hourly_metrics(date_hour);
CREATE INDEX idx_hourly_metrics_metric_date_hour ON hourly_metrics(metric, date_hour);
CREATE INDEX idx_user_activity_summary_last_activity ON user_activity_summary(last_activity);
CREATE INDEX idx_user_activity_summary_updated_at ON user_activity_summary(updated_at);
CREATE INDEX idx_business_metrics_date ON business_metrics(date);
CREATE INDEX idx_notification_results_notification_id ON notification_results(notification_id);
CREATE INDEX idx_notification_results_channel ON notification_results(channel);
CREATE INDEX idx_notification_results_status ON notification_results(status);
CREATE INDEX idx_notification_results_created_at ON notification_results(created_at);
CREATE INDEX idx_in_app_notifications_user_id ON in_app_notifications(user_id);
CREATE INDEX idx_in_app_notifications_is_read ON in_app_notifications(is_read);
CREATE INDEX idx_in_app_notifications_created_at ON in_app_notifications(created_at);
CREATE INDEX idx_in_app_notifications_user_unread ON in_app_notifications(user_id, is_read) WHERE is_read = FALSE;
CREATE INDEX idx_user_devices_user_id ON user_devices(user_id);
CREATE INDEX idx_user_devices_is_active ON user_devices(is_active);
CREATE INDEX idx_user_devices_device_type ON user_devices(device_type);
CREATE INDEX idx_ai_consent_events_user_id ON ai_consent_events(user_id);
CREATE INDEX idx_ai_consent_events_session_id ON ai_consent_events(session_id);
CREATE INDEX idx_ai_consent_events_type_created ON ai_consent_events(consent_type, created_at);
CREATE INDEX idx_muse_sessions_user_id ON muse_sessions(user_id);
CREATE INDEX idx_muse_sessions_anonymous_id ON muse_sessions(anonymous_id);
CREATE INDEX idx_muse_sessions_status ON muse_sessions(status);
CREATE INDEX idx_muse_messages_session_id ON muse_messages(session_id);
CREATE INDEX idx_muse_messages_created_at ON muse_messages(created_at);
CREATE INDEX idx_muse_preference_profiles_session_id ON muse_preference_profiles(session_id);
CREATE INDEX idx_muse_preference_profiles_user_id ON muse_preference_profiles(user_id);
CREATE INDEX idx_recommendation_runs_session_id ON recommendation_runs(session_id);
CREATE INDEX idx_recommendation_runs_user_id ON recommendation_runs(user_id);
CREATE INDEX idx_recommendation_items_run_id ON recommendation_items(run_id);
CREATE INDEX idx_recommendation_items_rank ON recommendation_items(run_id, rank);
CREATE INDEX idx_privacy_requests_user_id ON privacy_requests(user_id);
CREATE INDEX idx_privacy_requests_status ON privacy_requests(status);
CREATE INDEX idx_referral_accounts_code ON referral_accounts(referral_code);
CREATE INDEX idx_referral_events_referrer ON referral_events(referrer_id);
CREATE INDEX idx_referral_events_referred ON referral_events(referred_user_id);
CREATE INDEX idx_coin_transactions_user ON coin_transactions(user_id);
CREATE UNIQUE INDEX uq_payment_attempt_active_booking
    ON payment_attempts(booking_id)
    WHERE status IN ('creating', 'indeterminate', 'pending');
CREATE INDEX idx_payment_attempts_customer
    ON payment_attempts(customer_id, created_at DESC);
CREATE INDEX idx_payment_attempts_charge
    ON payment_attempts(provider_charge_id);
CREATE INDEX idx_payment_webhook_events_charge
    ON payment_webhook_events(provider_charge_id, received_at DESC);
CREATE INDEX idx_booking_chat_rooms_customer ON booking_chat_rooms(customer_id);
CREATE INDEX idx_booking_chat_rooms_supplier ON booking_chat_rooms(supplier_id);
CREATE INDEX idx_booking_chat_messages_room_time ON booking_chat_messages(room_id, created_at);
CREATE INDEX idx_payment_restitutions_booking
    ON payment_restitutions(booking_id, requested_at DESC);
CREATE INDEX idx_payment_restitutions_customer
    ON payment_restitutions(customer_id, requested_at DESC);
