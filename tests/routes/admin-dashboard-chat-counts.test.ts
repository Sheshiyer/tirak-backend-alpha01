import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { dashboardRoutes } from '@/routes/admin/dashboard';
import { generateJWT } from '@/utils/auth';
import { commsDatabase } from '@tests/helpers/comms-sqlite';
import { seedStubRow } from '@tests/migrations/helpers/sqlite';
import type { Env, Variables } from '@/index';

const MIGRATIONS_DIR = resolve(import.meta.dirname, '../../migrations');

function buildMigratedDb() {
  const baseline = readFileSync(
    resolve(MIGRATIONS_DIR, 'baseline/canonical-baseline.sql'),
    'utf8',
  );
  const migrationFiles = [
    '010_booking_chat_expansion.sql',
    '012_supplier_onboarding.sql',
    '013_supplier_onboarding_review.sql',
    '015_account_trust.sql',
    '017_core_guide_management.sql',
    '019_password_reset_consumptions.sql',
    '020_core_onboarding_lifecycle.sql',
    '021_evidence_interest_cohort.sql',
    '022_core_booking_idempotency.sql',
    '023_core_customer_registration_fields.sql',
    '024_core_api_repairs.sql',
    '025_core_booking_mobile_fields.sql',
    '026_core_notification_prerequisites.sql',
  ];

  return commsDatabase([
    baseline,
    ...migrationFiles.map((name) => readFileSync(resolve(MIGRATIONS_DIR, name), 'utf8')),
  ].join('\n;\n'));
}

function createEnv(db: ReturnType<typeof commsDatabase>['db'], overrides: Partial<Env> = {}): Env {
  return {
    DB: db as unknown as D1Database,
    STORAGE: {
      get: vi.fn().mockResolvedValue(null),
      put: vi.fn().mockResolvedValue({}),
      delete: vi.fn().mockResolvedValue({}),
      head: vi.fn().mockResolvedValue(null),
      list: vi.fn().mockResolvedValue({ objects: [] }),
    } as any,
    CACHE: { get: vi.fn(), put: vi.fn(), delete: vi.fn() } as any,
    SESSIONS: { get: vi.fn(), put: vi.fn(), delete: vi.fn() } as any,
    MODERATION_QUEUE: { send: vi.fn(), sendBatch: vi.fn() } as any,
    ANALYTICS_QUEUE: { send: vi.fn().mockResolvedValue(undefined), sendBatch: vi.fn() } as any,
    NOTIFICATION_QUEUE: { send: vi.fn(), sendBatch: vi.fn() } as any,
    CHAT_ROOM: { idFromName: vi.fn(), get: vi.fn() } as any,
    NOTIFICATION_SERVICE: { get: vi.fn() } as any,
    JWT_SECRET: 'test-admin-dashboard-secret',
    ENVIRONMENT: 'test',
    FRONTEND_URLS: 'http://localhost:3000,http://localhost:5174',
    PUBLIC_ASSET_BASE_URL: 'https://api.example.test/api/uploads/public',
    EMAIL_PROVIDER: 'disabled',
    ...overrides,
  } as Env;
}

function createDashboardApp() {
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();
  app.route('/api/admin/dashboard', dashboardRoutes);
  return app;
}

async function adminAuth(env: Env) {
  return `Bearer ${await generateJWT({
    sub: 'admin-1',
    email: 'admin@test.com',
    userType: 'admin',
  }, env.JWT_SECRET)}`;
}

describe('Admin dashboard chat statistics', () => {
  let sqlite: ReturnType<typeof buildMigratedDb>['sqlite'];
  let db: ReturnType<typeof buildMigratedDb>['db'];

  beforeEach(() => {
    const built = buildMigratedDb();
    sqlite = built.sqlite;
    db = built.db;
  });

  it('counts persisted booking chat and legacy chat without room collisions while keeping completed booking rooms inactive', async () => {
    seedStubRow(sqlite, 'users', {
      id: 'admin-1',
      email: 'admin@test.com',
      phone: '+66000000001',
      password_hash: 'hash',
      user_type: 'admin',
      status: 'active',
      email_verified: 1,
      phone_verified: 1,
      preferred_language: 'en',
      created_at: '2026-10-05T08:00:00Z',
      updated_at: '2026-10-05T08:00:00Z',
    });
    seedStubRow(sqlite, 'users', {
      id: 'traveler-1',
      email: 'traveler@test.com',
      phone: '+66000000002',
      password_hash: 'hash',
      user_type: 'customer',
      status: 'active',
      email_verified: 1,
      phone_verified: 1,
      preferred_language: 'en',
    });
    seedStubRow(sqlite, 'users', {
      id: 'guide-1',
      email: 'guide@test.com',
      phone: '+66000000003',
      password_hash: 'hash',
      user_type: 'supplier',
      status: 'active',
      email_verified: 1,
      phone_verified: 1,
      preferred_language: 'en',
    });
    seedStubRow(sqlite, 'supplier_profiles', {
      user_id: 'guide-1',
      display_name: 'Guide One',
      verification_status: 'verified',
      subscription_status: 'active',
      subscription_tier: 'basic',
      profile_images: '[]',
    });
    seedStubRow(sqlite, 'supplier_services', {
      id: 'service-1',
      supplier_id: 'guide-1',
      title: 'Bangkok Walk',
      price_min: 100,
      price_max: 100,
      duration_hours: 1,
      currency: 'THB',
      is_active: 1,
    });
    seedStubRow(sqlite, 'bookings', {
      id: 'booking-1',
      customer_id: 'traveler-1',
      supplier_id: 'guide-1',
      service_id: 'service-1',
      status: 'completed',
      scheduled_at: '2026-10-05T09:00:00Z',
      duration: 60,
      total_amount: 100,
      currency: 'THB',
      created_at: '2026-10-05T09:00:00Z',
      updated_at: '2026-10-05T09:30:00Z',
    });
    seedStubRow(sqlite, 'booking_chat_rooms', {
      id: 'shared-room',
      booking_id: 'booking-1',
      customer_id: 'traveler-1',
      supplier_id: 'guide-1',
      status: 'active',
      last_message_at: '2026-10-05T10:00:00Z',
      created_at: '2026-10-05T09:00:00Z',
      updated_at: '2026-10-05T10:00:00Z',
    });
    seedStubRow(sqlite, 'booking_chat_messages', {
      id: 'booking-msg-1',
      room_id: 'shared-room',
      sender_id: 'guide-1',
      message_type: 'text',
      content: 'Booking chat message',
      created_at: '2026-10-05T10:00:00Z',
    });
    seedStubRow(sqlite, 'chat_rooms', {
      id: 'shared-room',
      customer_id: 'traveler-1',
      supplier_id: 'guide-1',
      status: 'active',
      last_message_at: '2026-10-05T11:00:00Z',
      created_at: '2026-10-05T08:30:00Z',
      updated_at: '2026-10-05T11:00:00Z',
    });
    seedStubRow(sqlite, 'chat_messages', {
      id: 'legacy-msg-1',
      room_id: 'shared-room',
      sender_id: 'traveler-1',
      message_type: 'text',
      content: 'Legacy chat message',
      created_at: '2026-10-05T11:00:00Z',
    });

    const env = createEnv(db);
    const app = createDashboardApp();
    const authorization = await adminAuth(env);

    const overviewRes = await app.request('http://localhost/api/admin/dashboard/overview?mode=tirak', {
      headers: { Authorization: authorization },
    }, env);

    expect(overviewRes.status).toBe(200);
    const overviewBody = await overviewRes.json();
    expect(overviewBody.success).toBe(true);
    expect(overviewBody.data.chat).toEqual({
      activeRooms: 0,
      totalMessages: 2,
      todayMessages: 2,
    });
    expect(overviewBody.data.recentActivity.chat_message).toBe(2);

    const metricsRes = await app.request('http://localhost/api/admin/dashboard/metrics?mode=tirak&startDate=2026-10-05&endDate=2026-10-06', {
      headers: { Authorization: authorization },
    }, env);

    expect(metricsRes.status).toBe(200);
    const metricsBody = await metricsRes.json();
    expect(metricsBody.success).toBe(true);
    expect(metricsBody.data.chat).toEqual([
      {
        date: '2026-10-05',
        messages: 2,
        active_rooms: 2,
      },
    ]);
  });
});
