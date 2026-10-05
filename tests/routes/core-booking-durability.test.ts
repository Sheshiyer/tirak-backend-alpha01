import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Hono } from 'hono';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { bookingRoutes } from '@/routes/bookings';
import { generateJWT } from '@/utils/auth';
import { createMockRequest, createTestEnv } from '@tests/setup';
import { commsDatabase } from '@tests/helpers/comms-sqlite';

const CUSTOMER_ID = 'a0000001-0000-4000-a000-000000000001';
const OTHER_CUSTOMER_ID = 'a0000002-0000-4000-a000-000000000002';
const GUIDE_ID = 'b0000001-0000-4000-b000-000000000001';
const GUIDE2_ID = 'b0000002-0000-4000-b000-000000000002';
const SERVICE_ID = 'c0000001-0000-4000-c000-000000000001';
const SERVICE2_ID = 'c0000002-0000-4000-c000-000000000002';
const BOOKING_ID = 'd0000001-0000-4000-d000-000000000001';

const FUTURE_DATE = '2026-12-12';
const FUTURE_START = '09:00';
const FIXED_NOW_ISO = '2026-10-05T17:00:00.000Z';
const FIXED_NOW_MS = new Date(FIXED_NOW_ISO).getTime();

function buildCoreSchema(): string {
  const root = resolve(import.meta.dirname, '../..');
  const chain = [
    'migrations/baseline/canonical-baseline.sql',
    'migrations/010_booking_chat_expansion.sql',
    'migrations/012_supplier_onboarding.sql',
    'migrations/013_supplier_onboarding_review.sql',
    'migrations/015_account_trust.sql',
    'migrations/017_core_guide_management.sql',
    'migrations/019_password_reset_consumptions.sql',
    'migrations/022_core_booking_idempotency.sql',
    'migrations/023_core_customer_registration_fields.sql',
    'migrations/025_core_booking_mobile_fields.sql',
    'migrations/026_core_notification_prerequisites.sql',
  ];

  return chain
    .map((migration) => readFileSync(join(root, migration), 'utf8'))
    .join('\n');
}

function seedUser(db: DatabaseSync, o: Record<string, unknown>) {
  const d: Record<string, unknown> = {
    email_verified: 1,
    phone_verified: 1,
    preferred_language: 'en',
    status: 'active',
    password_hash: '$2a$10$test.hash',
    created_at: '2026-10-01T00:00:00Z',
    updated_at: '2026-10-01T00:00:00Z',
    ...o,
  };
  const cols = Object.keys(d);
  db.prepare(`INSERT INTO users (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...Object.values(d));
}

function seedSupplierProfile(db: DatabaseSync, userId: string, o: Record<string, unknown> = {}) {
  const d: Record<string, unknown> = {
    user_id: userId,
    display_name: userId === GUIDE2_ID ? 'Second Guide' : 'Test Guide',
    bio: 'Bio',
    profile_images: '[]',
    categories: '[]',
    regions: '[]',
    spoken_languages: '["en"]',
    rating_average: 4.5,
    rating_count: 10,
    verification_status: 'verified',
    subscription_status: 'active',
    subscription_tier: 'basic',
    subscription_expires_at: null,
    created_at: '2026-10-01T00:00:00Z',
    updated_at: '2026-10-01T00:00:00Z',
    ...o,
  };
  const cols = Object.keys(d);
  db.prepare(`INSERT INTO supplier_profiles (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...Object.values(d));
}

function seedCustomerProfile(db: DatabaseSync, userId: string, o: Record<string, unknown> = {}) {
  const d: Record<string, unknown> = {
    user_id: userId,
    display_name: userId === OTHER_CUSTOMER_ID ? 'Other Traveler' : 'Test Traveler',
    created_at: '2026-10-01T00:00:00Z',
    updated_at: '2026-10-01T00:00:00Z',
    ...o,
  };
  const cols = Object.keys(d);
  db.prepare(`INSERT INTO customer_profiles (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...Object.values(d));
}

function seedService(db: DatabaseSync, supplierId: string, o: Record<string, unknown> = {}) {
  const id = supplierId === GUIDE2_ID ? SERVICE2_ID : SERVICE_ID;
  const d: Record<string, unknown> = {
    id,
    supplier_id: supplierId,
    title: supplierId === GUIDE2_ID ? 'Night Food Walk' : 'Old Town Walk',
    description: 'Walking tour',
    price_min: 1500,
    price_max: 1500,
    currency: 'THB',
    duration_hours: 2,
    is_active: 1,
    archived_at: null,
    keywords: '[]',
    created_at: '2026-10-01T00:00:00Z',
    updated_at: '2026-10-01T00:00:00Z',
    ...o,
  };
  const cols = Object.keys(d);
  db.prepare(`INSERT INTO supplier_services (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...Object.values(d));
}

function seedAvailability(db: DatabaseSync, supplierId: string, dow: number, start: string, end: string) {
  db.prepare(`INSERT INTO supplier_availability (id, supplier_id, day_of_week, start_time, end_time, is_available) VALUES (?, ?, ?, ?, ?, 1)`)
    .run(crypto.randomUUID(), supplierId, dow, start, end);
}

function seedBooking(db: DatabaseSync, o: Record<string, unknown>) {
  const d: Record<string, unknown> = {
    id: crypto.randomUUID(),
    customer_id: CUSTOMER_ID,
    supplier_id: GUIDE_ID,
    service_id: SERVICE_ID,
    status: 'pending',
    scheduled_at: `${FUTURE_DATE} ${FUTURE_START}:00`,
    duration: 120,
    total_amount: 1500,
    currency: 'THB',
    notes: null,
    special_requests: null,
    preferred_language: null,
    group_composition: null,
    dietary_requirements: null,
    experience_id: SERVICE_ID,
    payment_status: 'pending',
    location: 'Bangkok Old Town',
    created_at: '2026-10-05T00:00:00Z',
    updated_at: '2026-10-05T00:00:00Z',
    ...o,
  };
  const cols = Object.keys(d);
  db.prepare(`INSERT INTO bookings (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...Object.values(d));
}

function countBookings(db: DatabaseSync): number {
  return Number((db.prepare('SELECT COUNT(*) AS total FROM bookings').get() as { total: number }).total);
}

function countIdempotency(db: DatabaseSync): number {
  return Number((db.prepare('SELECT COUNT(*) AS total FROM booking_idempotency').get() as { total: number }).total);
}

describe('Core booking durability', () => {
  let app: Hono;
  let db: DatabaseSync;
  let testEnv: ReturnType<typeof createTestEnv>;
  let customerAuth: string;
  let otherCustomerAuth: string;
  let guideAuth: string;

  beforeEach(async () => {
    vi.spyOn(Date, 'now').mockReturnValue(FIXED_NOW_MS);

    testEnv = createTestEnv();
    testEnv.PAYMENT_MODE = 'disabled';
    testEnv.PROMPTPAY_ENABLED = 'false';
    const sqlHarness = commsDatabase(buildCoreSchema());
    testEnv.DB = sqlHarness.db as unknown as D1Database;
    db = sqlHarness.sqlite;

    app = new Hono();
    app.route('/bookings', bookingRoutes);

    seedUser(db, { id: CUSTOMER_ID, email: 'traveler@tirak.test', phone: '+66810000001', user_type: 'customer' });
    seedUser(db, { id: OTHER_CUSTOMER_ID, email: 'traveler2@tirak.test', phone: '+66810000003', user_type: 'customer' });
    seedUser(db, { id: GUIDE_ID, email: 'guide@tirak.test', phone: '+66810000002', user_type: 'supplier' });
    seedUser(db, { id: GUIDE2_ID, email: 'guide2@tirak.test', phone: '+66810000004', user_type: 'supplier' });
    seedCustomerProfile(db, CUSTOMER_ID);
    seedCustomerProfile(db, OTHER_CUSTOMER_ID);
    seedSupplierProfile(db, GUIDE_ID);
    seedSupplierProfile(db, GUIDE2_ID);
    seedService(db, GUIDE_ID);
    seedService(db, GUIDE2_ID);
    seedAvailability(db, GUIDE_ID, 6, '08:00', '18:00');
    seedAvailability(db, GUIDE2_ID, 6, '08:00', '18:00');

    customerAuth = `Bearer ${await generateJWT({ sub: CUSTOMER_ID, email: 'traveler@tirak.test', userType: 'customer' }, testEnv.JWT_SECRET)}`;
    otherCustomerAuth = `Bearer ${await generateJWT({ sub: OTHER_CUSTOMER_ID, email: 'traveler2@tirak.test', userType: 'customer' }, testEnv.JWT_SECRET)}`;
    guideAuth = `Bearer ${await generateJWT({ sub: GUIDE_ID, email: 'guide@tirak.test', userType: 'supplier' }, testEnv.JWT_SECRET)}`;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('timezone-aware validation', () => {
    it('rejects a booking that is already past in Bangkok time with precise 400', async () => {
      const response = await app.request(createMockRequest('http://localhost/bookings', {
        method: 'POST',
        body: JSON.stringify({ companionId: GUIDE_ID, serviceId: SERVICE_ID, date: '2026-10-05', startTime: '16:00', duration: 120 }),
        headers: { Authorization: customerAuth, 'Content-Type': 'application/json' },
      }), undefined, testEnv);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(String(data.message || data.details || data.error)).toMatch(/Bangkok time/i);
    });

    it('accepts the Bangkok-midnight boundary just after the fixed clock and preserves the requested date', async () => {
      seedAvailability(db, GUIDE_ID, 2, '00:00', '23:59');
      const response = await app.request(createMockRequest('http://localhost/bookings', {
        method: 'POST',
        body: JSON.stringify({ companionId: GUIDE_ID, serviceId: SERVICE_ID, date: '2026-10-06', startTime: '00:01', duration: 120 }),
        headers: { Authorization: customerAuth, 'Content-Type': 'application/json' },
      }), undefined, testEnv);
      const data = await response.json();

      expect(response.status).toBe(201);
      expect(data.data.booking.date).toBe('2026-10-06');
      expect(data.data.booking.startTime).toBe('00:01');
    });

    it('computes the reminder queue timestamp as the correct UTC instant three hours before Bangkok start', async () => {
      const sends: any[] = [];
      testEnv.NOTIFICATION_QUEUE.send = async (message: any) => { sends.push(message); return { success: true }; };

      const response = await app.request(createMockRequest('http://localhost/bookings', {
        method: 'POST',
        body: JSON.stringify({ companionId: GUIDE_ID, serviceId: SERVICE_ID, date: FUTURE_DATE, startTime: FUTURE_START, duration: 120 }),
        headers: { Authorization: customerAuth, 'Content-Type': 'application/json', 'Idempotency-Key': '11111111-1111-4111-8111-111111111111' },
      }), undefined, testEnv);

      expect(response.status).toBe(201);
      const reminderPayloads = sends.filter((message) => message?.data?.type === 'booking_reminder');
      expect(reminderPayloads).toHaveLength(2);
      expect(reminderPayloads[0].scheduledFor).toBe('2026-12-11T23:00:00.000Z');
      expect(reminderPayloads[1].scheduledFor).toBe('2026-12-11T23:00:00.000Z');
    });
  });

  describe('booking idempotency and recovery', () => {
    it('requires UUID idempotency keys for new requests while preserving the legacy no-key path', async () => {
      const bad = await app.request(createMockRequest('http://localhost/bookings', {
        method: 'POST',
        body: JSON.stringify({ companionId: GUIDE_ID, serviceId: SERVICE_ID, date: FUTURE_DATE, startTime: FUTURE_START, duration: 120 }),
        headers: { Authorization: customerAuth, 'Content-Type': 'application/json', 'Idempotency-Key': 'not-a-uuid' },
      }), undefined, testEnv);
      expect(bad.status).toBe(400);

      const legacy = await app.request(createMockRequest('http://localhost/bookings', {
        method: 'POST',
        body: JSON.stringify({ companionId: GUIDE_ID, serviceId: SERVICE_ID, date: FUTURE_DATE, startTime: FUTURE_START, duration: 120 }),
        headers: { Authorization: customerAuth, 'Content-Type': 'application/json' },
      }), undefined, testEnv);
      expect(legacy.status).toBe(201);
    });

    it('returns the committed booking on replay even after time passed and the guide later becomes archived/expired', async () => {
      const headers = {
        Authorization: customerAuth,
        'Content-Type': 'application/json',
        'Idempotency-Key': '22222222-2222-4222-8222-222222222222',
      };
      const payload = JSON.stringify({ companionId: GUIDE_ID, serviceId: SERVICE_ID, date: FUTURE_DATE, startTime: FUTURE_START, duration: 120 });

      const first = await app.request(createMockRequest('http://localhost/bookings', { method: 'POST', body: payload, headers }), undefined, testEnv);
      const firstData = await first.json();
      expect(first.status).toBe(201);

      db.prepare("UPDATE supplier_profiles SET subscription_expires_at = '2026-10-01T00:00:00Z' WHERE user_id = ?").run(GUIDE_ID);
      db.prepare('UPDATE supplier_services SET archived_at = ? WHERE id = ?').run('2026-10-06T00:00:00Z', SERVICE_ID);
      vi.mocked(Date.now).mockReturnValue(new Date('2027-01-01T00:00:00.000Z').getTime());
      const replayAuth = `Bearer ${await generateJWT({ sub: CUSTOMER_ID, email: 'traveler@tirak.test', userType: 'customer' }, testEnv.JWT_SECRET)}`;

      const replay = await app.request(createMockRequest('http://localhost/bookings', {
        method: 'POST',
        body: payload,
        headers: { ...headers, Authorization: replayAuth },
      }), undefined, testEnv);
      const replayData = await replay.json();

      expect(replay.status).toBe(200);
      expect(replayData.data.booking.id).toBe(firstData.data.booking.id);
      expect(replayData.data.booking.idempotent).toBe(true);
    });

    it('returns 409 on same-key changed payload including nested arrays', async () => {
      const headers = {
        Authorization: customerAuth,
        'Content-Type': 'application/json',
        'Idempotency-Key': '33333333-3333-4333-8333-333333333333',
      };

      const first = await app.request(createMockRequest('http://localhost/bookings', {
        method: 'POST',
        body: JSON.stringify({
          companionId: GUIDE_ID,
          serviceId: SERVICE_ID,
          date: FUTURE_DATE,
          startTime: FUTURE_START,
          duration: 120,
          preferredLanguages: ['en', 'th'],
          dietaryRestrictions: ['vegan'],
        }),
        headers,
      }), undefined, testEnv);
      expect(first.status).toBe(201);

      const changed = await app.request(createMockRequest('http://localhost/bookings', {
        method: 'POST',
        body: JSON.stringify({
          companionId: GUIDE_ID,
          serviceId: SERVICE_ID,
          date: FUTURE_DATE,
          startTime: FUTURE_START,
          duration: 120,
          preferredLanguages: ['th', 'en'],
          dietaryRestrictions: ['vegan'],
        }),
        headers,
      }), undefined, testEnv);

      expect(changed.status).toBe(409);
      expect(countBookings(db)).toBe(1);
    });

    it('keeps the same raw UUID isolated per user', async () => {
      const key = '44444444-4444-4444-8444-444444444444';
      const firstPayload = { companionId: GUIDE_ID, serviceId: SERVICE_ID, date: FUTURE_DATE, startTime: FUTURE_START, duration: 120 };
      const secondPayload = { companionId: GUIDE2_ID, serviceId: SERVICE2_ID, date: FUTURE_DATE, startTime: FUTURE_START, duration: 120 };

      const first = await app.request(createMockRequest('http://localhost/bookings', {
        method: 'POST', body: JSON.stringify(firstPayload),
        headers: { Authorization: customerAuth, 'Content-Type': 'application/json', 'Idempotency-Key': key },
      }), undefined, testEnv);
      const second = await app.request(createMockRequest('http://localhost/bookings', {
        method: 'POST', body: JSON.stringify(secondPayload),
        headers: { Authorization: otherCustomerAuth, 'Content-Type': 'application/json', 'Idempotency-Key': key },
      }), undefined, testEnv);

      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      expect(countBookings(db)).toBe(2);
      expect(countIdempotency(db)).toBe(2);
    });

    it('survives a response-loss style retry with exactly one committed booking and one key record', async () => {
      const headers = {
        Authorization: customerAuth,
        'Content-Type': 'application/json',
        'Idempotency-Key': '55555555-5555-4555-8555-555555555555',
      };
      const payload = JSON.stringify({ companionId: GUIDE_ID, serviceId: SERVICE_ID, date: FUTURE_DATE, startTime: FUTURE_START, duration: 120 });

      const first = await app.request(createMockRequest('http://localhost/bookings', { method: 'POST', body: payload, headers }), undefined, testEnv);
      expect(first.status).toBe(201);
      expect(countBookings(db)).toBe(1);
      expect(countIdempotency(db)).toBe(1);

      const retry = await app.request(createMockRequest('http://localhost/bookings', { method: 'POST', body: payload, headers }), undefined, testEnv);
      expect(retry.status).toBe(200);
      expect(countBookings(db)).toBe(1);
      expect(countIdempotency(db)).toBe(1);
    });
  });

  describe('transactional integrity and faults', () => {
    it('rolls back the booking row when idempotency insert fails before commit', async () => {
      const faultyDb = commsDatabase(buildCoreSchema(), {
        failRun: (sql) => sql.includes('INSERT INTO booking_idempotency') ? new Error('injected booking_idempotency insert failure') : null,
      });
      db = faultyDb.sqlite;
      testEnv.DB = faultyDb.db as unknown as D1Database;
      app = new Hono();
      app.route('/bookings', bookingRoutes);

      seedUser(db, { id: CUSTOMER_ID, email: 'traveler@tirak.test', phone: '+66810000001', user_type: 'customer' });
      seedUser(db, { id: GUIDE_ID, email: 'guide@tirak.test', phone: '+66810000002', user_type: 'supplier' });
      seedCustomerProfile(db, CUSTOMER_ID);
      seedSupplierProfile(db, GUIDE_ID);
      seedService(db, GUIDE_ID);
      seedAvailability(db, GUIDE_ID, 6, '08:00', '18:00');

      const response = await app.request(createMockRequest('http://localhost/bookings', {
        method: 'POST',
        body: JSON.stringify({ companionId: GUIDE_ID, serviceId: SERVICE_ID, date: FUTURE_DATE, startTime: FUTURE_START, duration: 120 }),
        headers: { Authorization: customerAuth, 'Content-Type': 'application/json', 'Idempotency-Key': '66666666-6666-4666-8666-666666666666' },
      }), undefined, testEnv);

      expect(response.status).toBe(500);
      expect(countBookings(db)).toBe(0);
      expect(countIdempotency(db)).toBe(0);
    });

    it('rolls back the booking row when idempotency persistence fails after booking insert', async () => {
      const faultyDb = commsDatabase(buildCoreSchema(), {
        failRun: (sql) => sql.includes('INSERT INTO booking_idempotency') ? new Error('injected booking_idempotency insert failure') : null,
      });
      db = faultyDb.sqlite;
      testEnv.DB = faultyDb.db as unknown as D1Database;
      app = new Hono();
      app.route('/bookings', bookingRoutes);

      seedUser(db, { id: CUSTOMER_ID, email: 'traveler@tirak.test', phone: '+66810000001', user_type: 'customer' });
      seedUser(db, { id: GUIDE_ID, email: 'guide@tirak.test', phone: '+66810000002', user_type: 'supplier' });
      seedCustomerProfile(db, CUSTOMER_ID);
      seedSupplierProfile(db, GUIDE_ID);
      seedService(db, GUIDE_ID);
      seedAvailability(db, GUIDE_ID, 6, '08:00', '18:00');

      const response = await app.request(createMockRequest('http://localhost/bookings', {
        method: 'POST',
        body: JSON.stringify({ companionId: GUIDE_ID, serviceId: SERVICE_ID, date: FUTURE_DATE, startTime: FUTURE_START, duration: 120 }),
        headers: { Authorization: customerAuth, 'Content-Type': 'application/json', 'Idempotency-Key': '6a666666-6666-4666-8666-666666666666' },
      }), undefined, testEnv);

      expect(response.status).toBe(500);
      expect(countBookings(db)).toBe(0);
      expect(countIdempotency(db)).toBe(0);
    });

    it('bubbles bad SQL instead of swallowing it into empty success', async () => {
      await testEnv.DB.exec('DROP TABLE booking_idempotency');
      const response = await app.request(createMockRequest('http://localhost/bookings', {
        method: 'POST',
        body: JSON.stringify({ companionId: GUIDE_ID, serviceId: SERVICE_ID, date: FUTURE_DATE, startTime: FUTURE_START, duration: 120 }),
        headers: { Authorization: customerAuth, 'Content-Type': 'application/json', 'Idempotency-Key': '77777777-7777-4777-8777-777777777777' },
      }), undefined, testEnv);
      expect(response.status).toBe(500);
      expect(countBookings(db)).toBe(0);
    });

    it('treats a batch implementation that throws as a real DB failure', async () => {
      testEnv.DB = { ...testEnv.DB, batch: async () => { throw new Error('batch unavailable'); } } as D1Database;
      const response = await app.request(createMockRequest('http://localhost/bookings', {
        method: 'POST',
        body: JSON.stringify({ companionId: GUIDE_ID, serviceId: SERVICE_ID, date: FUTURE_DATE, startTime: FUTURE_START, duration: 120 }),
        headers: { Authorization: customerAuth, 'Content-Type': 'application/json', 'Idempotency-Key': '88888888-8888-4888-8888-888888888888' },
      }), undefined, testEnv);
      expect(response.status).toBe(500);
    });
  });

  describe('concurrency invariants', () => {
    it('the overlap trigger prevents oversells', () => {
      seedBooking(db, { id: BOOKING_ID, status: 'confirmed', scheduled_at: `${FUTURE_DATE} 09:00:00` });
      expect(() => seedBooking(db, { id: 'd0000002-0000-4000-d000-000000000002', status: 'pending', scheduled_at: `${FUTURE_DATE} 10:00:00` })).toThrow(/core_booking_overlap/);
    });

    it('same key with the same payload under real concurrency returns one 201 and one 200 with exactly one booking and key record', async () => {
      const headers = {
        Authorization: customerAuth,
        'Content-Type': 'application/json',
        'Idempotency-Key': '91999999-9999-4999-8999-999999999999',
      };
      const payload = JSON.stringify({ companionId: GUIDE_ID, serviceId: SERVICE_ID, date: FUTURE_DATE, startTime: FUTURE_START, duration: 120 });

      const [first, second] = await Promise.all([
        app.request(createMockRequest('http://localhost/bookings', { method: 'POST', body: payload, headers }), undefined, testEnv),
        app.request(createMockRequest('http://localhost/bookings', { method: 'POST', body: payload, headers }), undefined, testEnv),
      ]);

      const statuses = [first.status, second.status].sort((a, b) => a - b);
      const firstData = await first.json();
      const secondData = await second.json();

      expect(statuses).toEqual([200, 201]);
      expect(firstData.data.booking.id).toBe(secondData.data.booking.id);
      expect(countBookings(db)).toBe(1);
      expect(countIdempotency(db)).toBe(1);
    });

    it('same key with a different payload under real concurrency returns one 201 and one 409 with no orphan rows', async () => {
      const headers = {
        Authorization: customerAuth,
        'Content-Type': 'application/json',
        'Idempotency-Key': '99999999-9999-4999-8999-999999999999',
      };

      const [first, second] = await Promise.all([
        app.request(createMockRequest('http://localhost/bookings', {
          method: 'POST',
          body: JSON.stringify({ companionId: GUIDE_ID, serviceId: SERVICE_ID, date: FUTURE_DATE, startTime: FUTURE_START, duration: 120 }),
          headers,
        }), undefined, testEnv),
        app.request(createMockRequest('http://localhost/bookings', {
          method: 'POST',
          body: JSON.stringify({ companionId: GUIDE2_ID, serviceId: SERVICE2_ID, date: FUTURE_DATE, startTime: FUTURE_START, duration: 120 }),
          headers,
        }), undefined, testEnv),
      ]);

      const statuses = [first.status, second.status].sort((a, b) => a - b);
      expect(statuses).toEqual([201, 409]);
      expect(countBookings(db)).toBe(1);
      expect(countIdempotency(db)).toBe(1);
      const persistedSupplierIds = (db.prepare('SELECT supplier_id FROM bookings').all() as Array<{ supplier_id: string }>).map((row) => row.supplier_id);
      expect(Array.from(new Set(persistedSupplierIds))).toHaveLength(1);
      expect([GUIDE_ID, GUIDE2_ID]).toContain(persistedSupplierIds[0]);
    });
  });

  describe('payment-disabled core journey', () => {
    it('never reports paid when payments are disabled', async () => {
      seedBooking(db, { id: BOOKING_ID, status: 'confirmed', payment_status: 'completed' });
      const response = await app.request(createMockRequest(`http://localhost/bookings/${BOOKING_ID}`, {
        method: 'GET', headers: { Authorization: customerAuth },
      }), undefined, testEnv);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.data.booking.paymentStatus).toBe('pending');
    });

    it('skips payment_attempts lookups on cancellation when PAYMENT_MODE is disabled', async () => {
      seedBooking(db, { id: BOOKING_ID, status: 'confirmed' });
      const paymentAttemptsTable = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'payment_attempts'").get() as { name: string } | undefined;
      expect(paymentAttemptsTable).toBeUndefined();

      const response = await app.request(createMockRequest(`http://localhost/bookings/${BOOKING_ID}/status`, {
        method: 'PUT',
        body: JSON.stringify({ status: 'cancelled' }),
        headers: { Authorization: customerAuth, 'Content-Type': 'application/json' },
      }), undefined, testEnv);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.data.booking.status).toBe('cancelled');
      expect(data.data.booking.paymentStatus).toBe('pending');
    });
  });

  describe('auxiliary delivery failures', () => {
    it('preserves the committed booking and replay when both queues reject', async () => {
      const analytics = vi.fn().mockRejectedValue(new Error('analytics unavailable'));
      const notifications = vi.fn().mockRejectedValue(new Error('notifications unavailable'));
      testEnv.ANALYTICS_QUEUE.send = analytics;
      testEnv.NOTIFICATION_QUEUE.send = notifications;
      const headers = {
        Authorization: customerAuth,
        'Content-Type': 'application/json',
        'Idempotency-Key': 'a1111111-1111-4111-8111-111111111111',
      };
      const body = JSON.stringify({ companionId: GUIDE_ID, serviceId: SERVICE_ID, date: FUTURE_DATE, startTime: FUTURE_START, duration: 120 });
      const first = await app.request(createMockRequest('http://localhost/bookings', { method: 'POST', body, headers }), undefined, testEnv);
      const created = await first.json();
      expect(first.status).toBe(201);
      expect(countBookings(db)).toBe(1);
      expect(countIdempotency(db)).toBe(1);
      expect(analytics).toHaveBeenCalled();
      expect(notifications).toHaveBeenCalled();
      const calls = [analytics.mock.calls.length, notifications.mock.calls.length];
      const retry = await app.request(createMockRequest('http://localhost/bookings', { method: 'POST', body, headers }), undefined, testEnv);
      expect(retry.status).toBe(200);
      expect((await retry.json()).data.booking.id).toBe(created.data.booking.id);
      expect([analytics.mock.calls.length, notifications.mock.calls.length]).toEqual(calls);
      expect(countBookings(db)).toBe(1);
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    });

    it('returns persisted confirmation when notification and analytics queues reject', async () => {
      seedBooking(db, { id: BOOKING_ID, status: 'pending' });
      testEnv.ANALYTICS_QUEUE.send = vi.fn().mockRejectedValue(new Error('analytics unavailable'));
      testEnv.NOTIFICATION_QUEUE.send = vi.fn().mockRejectedValue(new Error('notifications unavailable'));
      const response = await app.request(createMockRequest(`http://localhost/bookings/${BOOKING_ID}/status`, {
        method: 'PUT', body: JSON.stringify({ status: 'confirmed' }),
        headers: { Authorization: guideAuth, 'Content-Type': 'application/json' },
      }), undefined, testEnv);
      expect(response.status).toBe(200);
      expect((await response.json()).data.booking.status).toBe('confirmed');
      expect(db.prepare('SELECT status FROM bookings WHERE id = ?').get(BOOKING_ID)?.status).toBe('confirmed');
    });
  });

  describe('history and status responses', () => {
    it('keeps archived guide history readable to booking participants', async () => {
      seedBooking(db, { id: BOOKING_ID, status: 'completed', scheduled_at: '2026-09-15 09:00:00' });
      db.prepare("UPDATE supplier_profiles SET subscription_expires_at = '2026-09-01T00:00:00Z' WHERE user_id = ?").run(GUIDE_ID);
      db.prepare('UPDATE supplier_services SET archived_at = ? WHERE id = ?').run('2026-09-20T00:00:00Z', SERVICE_ID);

      const response = await app.request(createMockRequest(`http://localhost/bookings/${BOOKING_ID}`, {
        method: 'GET', headers: { Authorization: customerAuth },
      }), undefined, testEnv);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.data.booking.id).toBe(BOOKING_ID);
      expect(data.data.booking.status).toBe('completed');
    });

    it('returns the typed mobile-canonical response shape after a status update', async () => {
      seedBooking(db, { id: BOOKING_ID, status: 'pending' });
      const response = await app.request(createMockRequest(`http://localhost/bookings/${BOOKING_ID}/status`, {
        method: 'PUT',
        body: JSON.stringify({ status: 'confirmed' }),
        headers: { Authorization: guideAuth, 'Content-Type': 'application/json' },
      }), undefined, testEnv);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.data.booking.id).toBe(BOOKING_ID);
      expect(data.data.booking.status).toBe('confirmed');
      expect(data.data.booking.companion.id).toBe(GUIDE_ID);
      expect(data.data.booking.customer.id).toBe(CUSTOMER_ID);
      expect(data.data.booking.paymentStatus).toBe('pending');
    });
  });

  describe('validation', () => {
    it('rejects non-integer duration with 400', async () => {
      const response = await app.request(createMockRequest('http://localhost/bookings', {
        method: 'POST',
        body: JSON.stringify({ companionId: GUIDE_ID, serviceId: SERVICE_ID, date: FUTURE_DATE, startTime: FUTURE_START, duration: 90.5 }),
        headers: { Authorization: customerAuth, 'Content-Type': 'application/json' },
      }), undefined, testEnv);
      expect(response.status).toBe(400);
    });

    it('rejects an unavailable weekday with a precise 409 schedule error', async () => {
      const response = await app.request(createMockRequest('http://localhost/bookings', {
        method: 'POST',
        body: JSON.stringify({ companionId: GUIDE_ID, serviceId: SERVICE_ID, date: '2026-12-13', startTime: FUTURE_START, duration: 120 }),
        headers: { Authorization: customerAuth, 'Content-Type': 'application/json' },
      }), undefined, testEnv);
      const data = await response.json();

      expect(response.status).toBe(409);
      expect(String(data.details || data.error)).toMatch(/schedule/i);
    });
  });
});
