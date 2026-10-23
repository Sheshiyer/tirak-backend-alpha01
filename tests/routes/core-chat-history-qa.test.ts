import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { commsDatabase } from '@tests/helpers/comms-sqlite';
import { seedStubRow } from '@tests/migrations/helpers/sqlite';
import { coreQaBoundary } from '@/middleware/coreQa';
import { chatRoutes } from '@/routes/chat';
import { uploadRoutes } from '@/routes/uploads';
import { generateJWT } from '@/utils/auth';
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
      get: vi.fn().mockResolvedValue({
        body: new ReadableStream(),
        httpEtag: 'etag',
        writeHttpMetadata: vi.fn(),
      }),
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
    CHAT_ROOM: {
      idFromName: vi.fn((id: string) => id),
      get: vi.fn(() => ({
        fetch: vi.fn(async () => new Response('Local upgrade forwarded', { status: 200 })),
      })),
    } as any,
    NOTIFICATION_SERVICE: { get: vi.fn() } as any,
    JWT_SECRET: 'test-chat-qa-secret',
    ENVIRONMENT: 'test',
    CORE_QA_MODE: undefined,
    FRONTEND_URLS: 'http://localhost:3000,http://localhost:5174',
    PUBLIC_ASSET_BASE_URL: 'https://api.example.test/api/uploads/public',
    EMAIL_PROVIDER: 'disabled',
    ...overrides,
  } as Env;
}

function createChatApp(env: Env) {
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();
  if (env.ENVIRONMENT === 'core-qa') {
    app.use('/api/*', coreQaBoundary);
  }
  app.route('/api/chat', chatRoutes);
  app.route('/api/uploads', uploadRoutes);
  return app;
}

async function authHeader(env: Env, sub: string, email: string, userType: 'customer' | 'supplier' | 'admin') {
  return `Bearer ${await generateJWT({ sub, email, userType }, env.JWT_SECRET)}`;
}

async function ticketHash(ticket: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ticket));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

describe('Core chat history and QA websocket boundary', () => {
  let sqlite: ReturnType<typeof buildMigratedDb>['sqlite'];
  let db: ReturnType<typeof buildMigratedDb>['db'];

  beforeEach(() => {
    const built = buildMigratedDb();
    sqlite = built.sqlite;
    db = built.db;
  });

  async function seedChatFixture(status: 'confirmed' | 'in_progress' | 'completed' | 'cancelled' = 'completed') {
    seedStubRow(sqlite, 'users', {
      id: 'traveler-1',
      email: 'traveler@test.com',
      phone: '+66000000001',
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
      phone: '+66000000002',
      password_hash: 'hash',
      user_type: 'supplier',
      status: 'active',
      email_verified: 1,
      phone_verified: 1,
      preferred_language: 'en',
    });
    seedStubRow(sqlite, 'users', {
      id: 'outsider-1',
      email: 'outsider@test.com',
      phone: '+66000000003',
      password_hash: 'hash',
      user_type: 'customer',
      status: 'active',
      email_verified: 1,
      phone_verified: 1,
      preferred_language: 'en',
    });
    seedStubRow(sqlite, 'customer_profiles', { user_id: 'traveler-1', display_name: 'Traveler One' });
    seedStubRow(sqlite, 'supplier_profiles', { user_id: 'guide-1', display_name: 'Guide One', profile_images: '[]' });
    seedStubRow(sqlite, 'supplier_services', {
      id: 'service-1',
      supplier_id: 'guide-1',
      title: 'QA Route',
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
      status,
      scheduled_at: '2026-10-01T12:00:00Z',
      duration: 60,
      total_amount: 100,
      currency: 'THB',
    });
    seedStubRow(sqlite, 'booking_chat_rooms', {
      id: '223e4567-e89b-12d3-a456-426614174000',
      booking_id: 'booking-1',
      customer_id: 'traveler-1',
      supplier_id: 'guide-1',
    });
    seedStubRow(sqlite, 'booking_chat_messages', {
      id: 'msg-1',
      room_id: '223e4567-e89b-12d3-a456-426614174000',
      sender_id: 'guide-1',
      message_type: 'text',
      content: 'Historical message',
    });
  }

  async function seedQaCohort() {
    seedStubRow(sqlite, 'users', {
      id: 'qa-admin-1',
      email: 'qa-admin@test.com',
      phone: '+66000000004',
      password_hash: 'hash',
      user_type: 'admin',
      status: 'active',
      email_verified: 1,
      phone_verified: 1,
      preferred_language: 'en',
    });
    await db.prepare(`INSERT INTO supplier_onboarding_applications (
      id, business_name, contact_name, email, email_normalized, phone, location, mode, status, approved_user_id, reviewed_user_id
    ) VALUES ('qa-app-1', 'Guide One', 'Guide One', 'guide@test.com', 'guide@test.com', '', 'Bangkok', 'tirak', 'approved', 'guide-1', 'qa-admin-1')`).run();
    await db.prepare(`INSERT INTO core_qa_accounts (user_id, role, enrolled_at) VALUES ('qa-admin-1', 'admin', datetime('now'))`).run();
    await db.prepare(`INSERT INTO core_qa_accounts (user_id, role, enrolled_at) VALUES ('traveler-1', 'traveler', datetime('now'))`).run();
    await db.prepare(`INSERT INTO core_qa_accounts (user_id, role, source_application_id, enrolled_by, enrolled_at)
      VALUES ('guide-1', 'guide', 'qa-app-1', 'qa-admin-1', datetime('now'))`).run();
  }

  it('allows terminal booking chat history list/detail/search/mark-read to exact participants', async () => {
    await seedChatFixture('completed');
    const env = createEnv(db);
    const app = createChatApp(env);
    const travelerAuth = await authHeader(env, 'traveler-1', 'traveler@test.com', 'customer');

    const listRes = await app.request('/api/chat/rooms', {
      headers: { Authorization: travelerAuth },
    }, env);
    expect(listRes.status).toBe(200);
    const listBody = await listRes.json();
    expect(listBody.data.items).toHaveLength(1);
    expect(listBody.data.items[0].id).toBe('223e4567-e89b-12d3-a456-426614174000');

    const detailRes = await app.request('/api/chat/rooms/223e4567-e89b-12d3-a456-426614174000', {
      headers: { Authorization: travelerAuth },
    }, env);
    expect(detailRes.status).toBe(200);
    expect((await detailRes.json()).data.messages[0].content).toBe('Historical message');

    const searchRes = await app.request('/api/chat/rooms/223e4567-e89b-12d3-a456-426614174000/search?q=Historical', {
      headers: { Authorization: travelerAuth },
    }, env);
    expect(searchRes.status).toBe(200);
    expect((await searchRes.json()).data.count).toBe(1);

    const readRes = await app.request('/api/chat/rooms/223e4567-e89b-12d3-a456-426614174000/read', {
      method: 'POST',
      headers: {
        Authorization: travelerAuth,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ messageId: 'msg-1' }),
    }, env);
    expect(readRes.status).toBe(200);
  });

  it('denies historical chat reads to outsiders and keeps live writes closed after terminal booking', async () => {
    await seedChatFixture('cancelled');
    const env = createEnv(db);
    const app = createChatApp(env);
    const outsiderAuth = await authHeader(env, 'outsider-1', 'outsider@test.com', 'customer');
    const travelerAuth = await authHeader(env, 'traveler-1', 'traveler@test.com', 'customer');

    const outsiderDetail = await app.request('/api/chat/rooms/223e4567-e89b-12d3-a456-426614174000', {
      headers: { Authorization: outsiderAuth },
    }, env);
    expect(outsiderDetail.status).toBe(404);

    const writeRes = await app.request('/api/chat/rooms/223e4567-e89b-12d3-a456-426614174000/messages', {
      method: 'POST',
      headers: {
        Authorization: travelerAuth,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ messageType: 'text', content: 'still live?' }),
    }, env);
    expect(writeRes.status).toBe(404);

    const ticketRes = await app.request('/api/chat/rooms/223e4567-e89b-12d3-a456-426614174000/socket-ticket', {
      method: 'POST',
      headers: { Authorization: travelerAuth },
    }, env);
    expect(ticketRes.status).toBe(404);
  });

  it('QA websocket boundary accepts a valid no-bearer ticket once and chat consumes it atomically', async () => {
    await seedChatFixture('confirmed');
    await seedQaCohort();
    const env = createEnv(db, { ENVIRONMENT: 'core-qa', CORE_QA_MODE: 'cohort' });
    const app = createChatApp(env);
    const rawTicket = 'valid-chat-ticket';
    await db.prepare('INSERT INTO chat_socket_tickets (ticket_hash, user_id, room_id, expires_at) VALUES (?, ?, ?, ?)')
      .bind(await ticketHash(rawTicket), 'guide-1', '223e4567-e89b-12d3-a456-426614174000', Date.now() + 60_000)
      .run();

    const res = await app.request('http://localhost/api/chat/rooms/223e4567-e89b-12d3-a456-426614174000/ws?ticket=valid-chat-ticket', {
      headers: { Upgrade: 'websocket' },
    }, env);

    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-cache, no-store, must-revalidate');
    const ticketRow = await db.prepare('SELECT user_id FROM chat_socket_tickets WHERE room_id = ?')
      .bind('223e4567-e89b-12d3-a456-426614174000')
      .first();
    expect(ticketRow).toBeNull();

    const replay = await app.request('http://localhost/api/chat/rooms/223e4567-e89b-12d3-a456-426614174000/ws?ticket=valid-chat-ticket', {
      headers: { Upgrade: 'websocket' },
    }, env);
    expect(replay.status).toBe(401);
  });

  it('QA websocket boundary rejects expired, foreign-room, revoked, malformed, and non-cohort tickets without bearer fallback', async () => {
    await seedChatFixture('confirmed');
    await seedQaCohort();
    const env = createEnv(db, { ENVIRONMENT: 'core-qa', CORE_QA_MODE: 'cohort' });
    const app = createChatApp(env);

    await db.prepare('INSERT INTO chat_socket_tickets (ticket_hash, user_id, room_id, expires_at) VALUES (?, ?, ?, ?)')
      .bind(await ticketHash('expired-ticket'), 'guide-1', '223e4567-e89b-12d3-a456-426614174000', Date.now() - 1)
      .run();
    expect((await app.request('http://localhost/api/chat/rooms/223e4567-e89b-12d3-a456-426614174000/ws?ticket=expired-ticket', {
      headers: { Upgrade: 'websocket' },
    }, env)).status).toBe(401);

    await db.prepare('INSERT INTO chat_socket_tickets (ticket_hash, user_id, room_id, expires_at) VALUES (?, ?, ?, ?)')
      .bind(await ticketHash('foreign-room-ticket'), 'guide-1', '323e4567-e89b-12d3-a456-426614174000', Date.now() + 60_000)
      .run();
    expect((await app.request('http://localhost/api/chat/rooms/223e4567-e89b-12d3-a456-426614174000/ws?ticket=foreign-room-ticket', {
      headers: { Upgrade: 'websocket' },
    }, env)).status).toBe(401);

    seedStubRow(sqlite, 'users', {
      id: 'non-cohort-1',
      email: 'non-cohort@test.com',
      phone: '+66000000005',
      password_hash: 'hash',
      user_type: 'supplier',
      status: 'active',
      email_verified: 1,
      phone_verified: 1,
      preferred_language: 'en',
    });
    await db.prepare('INSERT INTO chat_socket_tickets (ticket_hash, user_id, room_id, expires_at) VALUES (?, ?, ?, ?)')
      .bind(await ticketHash('non-cohort-ticket'), 'non-cohort-1', '223e4567-e89b-12d3-a456-426614174000', Date.now() + 60_000)
      .run();
    const nonCohort = await app.request('http://localhost/api/chat/rooms/223e4567-e89b-12d3-a456-426614174000/ws?ticket=non-cohort-ticket', {
      headers: { Upgrade: 'websocket' },
    }, env);
    expect(nonCohort.status).toBe(403);
    expect((await nonCohort.json()).error).toBe('QA_ACCESS_DENIED');

    await db.prepare("UPDATE core_qa_accounts SET revoked_at = datetime('now') WHERE user_id = 'guide-1'").run();
    await db.prepare('INSERT INTO chat_socket_tickets (ticket_hash, user_id, room_id, expires_at) VALUES (?, ?, ?, ?)')
      .bind(await ticketHash('revoked-ticket'), 'guide-1', '223e4567-e89b-12d3-a456-426614174000', Date.now() + 60_000)
      .run();
    const revoked = await app.request('http://localhost/api/chat/rooms/223e4567-e89b-12d3-a456-426614174000/ws?ticket=revoked-ticket', {
      headers: { Upgrade: 'websocket' },
    }, env);
    expect(revoked.status).toBe(403);
    expect((await revoked.json()).error).toBe('QA_ACCESS_DENIED');

    expect((await app.request('http://localhost/api/chat/rooms/223e4567-e89b-12d3-a456-426614174000/ws?ticket=' + 'x'.repeat(101), {
      headers: { Upgrade: 'websocket' },
    }, env)).status).toBe(401);

    expect((await app.request('http://localhost/api/chat/rooms/223e4567-e89b-12d3-a456-426614174000/ws', {
      headers: { Upgrade: 'websocket' },
    }, env)).status).toBe(401);
  });

  it('mints socket tickets in core-qa only for cohort rooms with the approved reviewed guide link', async () => {
    await seedChatFixture('confirmed');
    await seedQaCohort();
    seedStubRow(sqlite, 'users', {
      id: 'guide-2',
      email: 'guide-two@test.com',
      phone: '+66000000007',
      password_hash: 'hash',
      user_type: 'supplier',
      status: 'active',
      email_verified: 1,
      phone_verified: 1,
      preferred_language: 'en',
    });
    seedStubRow(sqlite, 'supplier_profiles', {
      user_id: 'guide-2',
      display_name: 'Guide Two',
      profile_images: '[]',
    });
    seedStubRow(sqlite, 'supplier_services', {
      id: 'service-2',
      supplier_id: 'guide-2',
      title: 'Rejected QA Route',
      price_min: 120,
      price_max: 120,
      duration_hours: 1,
      currency: 'THB',
      is_active: 1,
    });
    seedStubRow(sqlite, 'bookings', {
      id: 'booking-2',
      customer_id: 'traveler-1',
      supplier_id: 'guide-2',
      service_id: 'service-2',
      status: 'confirmed',
      scheduled_at: '2026-10-02T12:00:00Z',
      duration: 60,
      total_amount: 120,
      currency: 'THB',
    });
    seedStubRow(sqlite, 'booking_chat_rooms', {
      id: '323e4567-e89b-12d3-a456-426614174000',
      booking_id: 'booking-2',
      customer_id: 'traveler-1',
      supplier_id: 'guide-2',
    });
    await db.prepare(`INSERT INTO supplier_onboarding_applications (
      id, business_name, contact_name, email, email_normalized, phone, location, mode, status, approved_user_id, reviewed_user_id
    ) VALUES ('qa-app-2', 'Guide Two', 'Guide Two', 'guide-two@test.com', 'guide-two@test.com', '', 'Bangkok', 'tirak', 'rejected', 'guide-2', 'qa-admin-1')`).run();

    const env = createEnv(db, { ENVIRONMENT: 'core-qa', CORE_QA_MODE: 'cohort' });
    const app = createChatApp(env);
    const travelerAuth = await authHeader(env, 'traveler-1', 'traveler@test.com', 'customer');

    const rejectedRes = await app.request('/api/chat/rooms/323e4567-e89b-12d3-a456-426614174000/socket-ticket', {
      method: 'POST',
      headers: { Authorization: travelerAuth },
    }, env);
    expect(rejectedRes.status).toBe(404);
    expect(await db.prepare('SELECT user_id FROM chat_socket_tickets WHERE room_id = ?')
      .bind('323e4567-e89b-12d3-a456-426614174000')
      .first()).toBeNull();

    const approvedRes = await app.request('/api/chat/rooms/223e4567-e89b-12d3-a456-426614174000/socket-ticket', {
      method: 'POST',
      headers: { Authorization: travelerAuth },
    }, env);
    expect(approvedRes.status).toBe(200);
    const approvedBody = await approvedRes.json();
    expect(approvedBody.data.ticket).toEqual(expect.any(String));
    expect(await db.prepare('SELECT user_id FROM chat_socket_tickets WHERE room_id = ?')
      .bind('223e4567-e89b-12d3-a456-426614174000')
      .first()).toEqual(expect.objectContaining({ user_id: 'traveler-1' }));
  });

  it('QA boundary keeps final no-cache headers even when downstream route builds public asset cache headers', async () => {
    const env = createEnv(db, { ENVIRONMENT: 'core-qa', CORE_QA_MODE: 'cohort' });
    const app = createChatApp(env);
    seedStubRow(sqlite, 'users', {
      id: 'upload-user-1',
      email: 'upload@test.com',
      phone: '+66000000006',
      password_hash: 'hash',
      user_type: 'customer',
      status: 'active',
      email_verified: 1,
      phone_verified: 1,
      preferred_language: 'en',
    });
    await db.prepare(`INSERT INTO core_qa_accounts (user_id, role, enrolled_at) VALUES ('upload-user-1', 'traveler', datetime('now'))`).run();
    const uploadAuth = await authHeader(env, 'upload-user-1', 'upload@test.com', 'customer');

    const res = await app.request('/api/uploads/public/avatars/demo.jpg', {
      headers: { Authorization: uploadAuth },
    }, env);

    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-cache, no-store, must-revalidate');
    expect(res.headers.get('Pragma')).toBe('no-cache');
    expect(res.headers.get('Expires')).toBe('0');
  });
});
