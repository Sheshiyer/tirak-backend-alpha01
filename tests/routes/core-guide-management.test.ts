import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { readFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { companionRoutes } from '@/routes/companions';
import { supplierRoutes } from '@/routes/suppliers';
import { bookingRoutes } from '@/routes/bookings';
import { generateJWT } from '@/utils/auth';
import { createTestEnv } from '@tests/setup';
import { buildMigrationDb, seedStubRow } from '../migrations/helpers/sqlite';

// Transport delivery is owned by the notification suite; this suite verifies booking persistence.
vi.mock('@/routes/notifications', () => ({ createNotification: vi.fn(async () => 'notification-fixture') }));

const guide = '123e4567-e89b-12d3-a456-426614174101';
const other = '123e4567-e89b-12d3-a456-426614174102';
const traveler = '123e4567-e89b-12d3-a456-426614174103';
const payload = { title: 'Market walk', description: 'A local walk', price: 500, currency: 'THB', durationMinutes: 90, keywords: ['Food'], is_active: true };

describe('Core guide management against migrated SQLite', () => {
  let db: DatabaseSync, app: Hono, env: ReturnType<typeof createTestEnv>;
  const tokens: Record<string,string> = {};
  beforeEach(async () => {
    db = buildMigrationDb();
    // These six nullable fields were verified by scoped read-only live PRAGMA on 2026-09-28.
    // They predate this repair but are absent from the canonical baseline: fixture-only,
    // not duplicate ALTER statements in migration 017. Release must preflight this drift.
    for (const column of ['customer_preferences', 'special_requests', 'preferred_language', 'group_composition', 'dietary_requirements', 'experience_id']) {
      db.exec(`ALTER TABLE bookings ADD COLUMN ${column} TEXT`);
    }
    db.exec(readFileSync('migrations/017_core_guide_management.sql', 'utf8'));
    env = createTestEnv();
    const prepare = (sql: string) => {
      const statement = (values: any[] = []): any => ({
        bind: (...params: any[]) => statement(params),
        first: async () => db.prepare(sql).get(...values) ?? null,
        all: async () => ({ results: db.prepare(sql).all(...values), success: true }),
        run: async () => ({ success: true, meta: { changes: Number(db.prepare(sql).run(...values).changes) } }),
      });
      return statement();
    };
    env.DB = { ...env.DB, prepare, batch: async (statements: any[]) => {
      db.exec('BEGIN');
      try { const result = []; for (const statement of statements) result.push(await statement.run()); db.exec('COMMIT'); return result; }
      catch (error) { db.exec('ROLLBACK'); throw error; }
    }};
    for (const id of [guide, other, traveler]) {
      const role = id === traveler ? 'customer' : 'supplier';
      seedStubRow(db, 'users', { id, email: `${id}@example.test`, user_type: role, status: 'active' });
      if (role === 'supplier') seedStubRow(db, 'supplier_profiles', { user_id: id, display_name: 'Guide', verification_status: 'pending', subscription_status: 'active' });
      tokens[id] = await generateJWT({ sub: id, email: `${id}@example.test`, userType: role }, env.JWT_SECRET);
    }
    app = new Hono();
    app.route('/companions', companionRoutes); app.route('/suppliers', supplierRoutes); app.route('/bookings', bookingRoutes);
  });
  afterEach(() => db.close());
  const request = async (path: string, method = 'GET', body?: any, as?: string) => {
    const response = await app.request(`http://localhost${path}`, { method, headers: { 'Content-Type': 'application/json', ...(as ? { Authorization: `Bearer ${tokens[as]}` } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }, env);
    const text = await response.text();
    let parsed; try { parsed = JSON.parse(text); } catch { parsed = { error: text }; }
    return { status: response.status, body: parsed };
  };
  const create = async (as = guide) => request(`/companions/${guide}/experiences`, 'POST', payload, as);
  const approve = () => db.prepare("UPDATE supplier_profiles SET verification_status='verified' WHERE user_id=?").run(guide);
  const weekly = (days: any[]) => request(`/companions/${guide}/availability/settings`, 'PUT', { timeZone: 'Asia/Bangkok', days }, guide);
  const openMonday = () => weekly([{ dayOfWeek: 1, startTime: '09:15', endTime: '17:15', isAvailable: true }]);
  const booking = (id: string, service: string, date: string, status = 'completed', currency = 'THB') => seedStubRow(db, 'bookings', {
    id, supplier_id: guide, customer_id: traveler, service_id: service, scheduled_at: `${date} 10:00:00`, duration: 60, total_amount: 500, currency, status,
  });

  it('pending owners manage real persisted experiences; unauthenticated and unrelated callers cannot mutate', async () => {
    expect((await request(`/companions/${guide}/experiences`, 'POST', payload)).status).toBe(401);
    expect((await create(other)).status).toBe(403);
    expect((await create(traveler)).status).toBe(403);
    const created = await create(); expect(created.status).toBe(201);
    const id = created.body.data.experienceId;
    expect((await request(`/companions/${guide}/experiences`, 'GET', undefined, guide)).body.data.items[0]).toMatchObject({ id, title: payload.title, durationMinutes: 90, keywords: ['Food'] });
    expect((await request(`/companions/${guide}/experiences`, 'GET', undefined, traveler)).status).toBe(404);
    const edit = await request(`/companions/${guide}/experiences/${id}`, 'PUT', { ...payload, title: 'New walk', durationMinutes: 75 }, guide);
    expect(edit.status).toBe(200);
    expect(db.prepare('SELECT title,duration_hours FROM supplier_services WHERE id=?').get(id)).toMatchObject({ title: 'New walk', duration_hours: 1.25 });
  });

  it('archive preserves service FK/history and hides the last service across all public aliases, ignoring stale cache', async () => {
    const id = (await create()).body.data.experienceId; approve(); booking('old-booking', id, '2026-09-01');
    expect((await request(`/companions/${guide}/experiences`, 'GET', undefined, traveler)).status).toBe(200);
    env.CACHE.get = async () => JSON.stringify({ id: guide, displayName: 'Stale cache' });
    for (let n = 0; n < 2; n++) expect((await request(`/companions/${guide}/experiences/${id}`, 'DELETE', undefined, guide)).body.data).toEqual({ experienceId: id, archived: true });
    expect(db.prepare('SELECT b.id,s.title FROM bookings b JOIN supplier_services s ON s.id=b.service_id').get()).toMatchObject({ id: 'old-booking', title: payload.title });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    // A legacy caller toggling active must not resurrect an archived service.
    db.prepare('UPDATE supplier_services SET is_active=1 WHERE id=?').run(id);
    for (const path of [`/companions/${guide}`, `/companions/${guide}/services`, `/companions/${guide}/experiences`, `/suppliers/${guide}`, `/suppliers/${guide}/services`]) expect((await request(path)).status).toBe(404);
    expect((await request('/suppliers/search')).body.data.items).toEqual([]);
    expect((await request(`/companions/${guide}/experiences`, 'GET', undefined, guide)).body.data.items).toEqual([]);
    expect((await request(`/companions/${other}/experiences/${id}`, 'DELETE', undefined, other)).status).toBe(404);
    expect((await request(`/companions/${guide}/experiences/${id}`, 'PUT', payload, guide)).status).toBe(404);
  });

  it('saves weekly defaults and date exceptions without changing another recurrence', async () => {
    expect((await openMonday()).status).toBe(200);
    const range = [{ startDate: '2026-10-05', endDate: '2026-10-05', startTime: '10:00', endTime: '11:00', isAvailable: false }];
    expect((await request(`/companions/${guide}/availability`, 'POST', range, guide)).status).toBe(200);
    const result = await request(`/companions/${guide}/availability?startDate=2026-10-05&endDate=2026-10-12`, 'GET', undefined, guide);
    expect(result.status).toBe(200);
    expect(result.body.data.availability[0]).toMatchObject({ date: '2026-10-05', available: false, timeSlots: [] });
    expect(result.body.data.availability[7].timeSlots[0]).toEqual({ start: '09:15', end: '09:45', available: true });
    expect((await request(`/companions/${guide}/availability/settings`, 'GET', undefined, guide)).body.data.days).toHaveLength(1);
    expect((await request(`/companions/${guide}/availability/settings`, 'GET', undefined, other)).status).toBe(403);
    expect((await request(`/companions/${guide}/availability?startDate=2026-10-05&endDate=2026-10-12`)).status).toBe(404);
  });

  it('validates the entire payload before any writes and bounds calendar expansion', async () => {
    await openMonday();
    const badRanges = [
      { startDate: '2026-10-05', endDate: '2026-10-05', startTime: '10:00', endTime: '11:00', isAvailable: true },
      { startDate: '2026-02-30', endDate: '2026-03-01', startTime: '10:00', endTime: '11:00', isAvailable: true },
    ];
    expect((await request(`/companions/${guide}/availability`, 'POST', badRanges, guide)).status).toBe(400);
    expect(db.prepare('SELECT COUNT(*) AS n FROM supplier_availability_overrides').get()).toMatchObject({ n: 0 });
    for (const query of ['startDate=2026-02-30&endDate=2026-03-01', 'startDate=2026-01-01&endDate=2027-01-01']) expect((await request(`/companions/${guide}/availability?${query}`, 'GET', undefined, guide)).status).toBe(400);
    expect((await weekly([{ dayOfWeek: 1, startTime: '25:00', endTime: '28:00', isAvailable: true }])).status).toBe(400);
    expect((await request(`/companions/${guide}/availability/settings`, 'GET', undefined, guide)).body.data.days[0].startTime).toBe('09:15');
  });

  it('rolls back a weekly replacement if a later database write fails', async () => {
    await openMonday();
    db.exec(`CREATE TRIGGER test_reject_tuesday BEFORE INSERT ON supplier_availability
      WHEN NEW.day_of_week=2 BEGIN SELECT RAISE(ABORT,'test_write_failure'); END`);
    const result = await weekly([
      { dayOfWeek: 1, startTime: '10:00', endTime: '16:00', isAvailable: true },
      { dayOfWeek: 2, startTime: '10:00', endTime: '16:00', isAvailable: true },
    ]);
    expect(result.status).toBe(500);
    expect((await request(`/companions/${guide}/availability/settings`, 'GET', undefined, guide)).body.data.days)
      .toEqual([{ dayOfWeek: 1, startTime: '09:15', endTime: '17:15', isAvailable: true }]);
  });

  it('returns a sanitized server failure exactly once when owner persistence fails', async () => {
    const original = env.DB.prepare.bind(env.DB);
    let attempted = 0;
    env.DB.prepare = (sql: string) => {
      if (sql.includes('INSERT INTO supplier_services')) {
        attempted++;
        throw new Error('private database details');
      }
      return original(sql);
    };
    const result = await create();
    expect(result.status).toBe(500);
    expect(result.body.success).toBe(false);
    expect(JSON.stringify(result.body)).not.toContain('private');
    expect(attempted).toBe(1);
  });

  it.each(['pending', 'rejected'])('legacy public aliases cannot publish a %s guide even with cache data', async status => {
    await create();
    db.prepare('UPDATE supplier_profiles SET verification_status=? WHERE user_id=?').run(status, guide);
    env.CACHE.get = async () => JSON.stringify({ id: guide, displayName: 'Stale cached public guide' });
    for (const path of [`/suppliers/${guide}`, `/suppliers/${guide}/services`]) expect((await request(path)).status).toBe(404);
    expect((await request('/suppliers/search')).body.data.items).toEqual([]);
  });

  it('pending reservations block the entire overlapped slot and simultaneous inserts at database boundary', async () => {
    const id = (await create()).body.data.experienceId; approve(); await openMonday();
    booking('reserved', id, '2026-10-05', 'pending');
    const result = await request(`/companions/${guide}/availability?startDate=2026-10-05&endDate=2026-10-05`);
    expect(result.body.data.availability[0].timeSlots.find((slot: any) => slot.start === '09:45').available).toBe(false);
    expect(result.body.data.availability[0].timeSlots.find((slot: any) => slot.start === '10:15').available).toBe(false);
    expect(() => booking('race', id, '2026-10-05', 'pending')).toThrow(/core_booking_overlap/);
  });

  it('rejects direct booking of pending guide, unset schedule, archived service, invalid date and mismatched end', async () => {
    const id = (await create()).body.data.experienceId;
    const data = { companionId: guide, serviceId: id, date: '2026-10-05', startTime: '10:00', duration: 90 };
    expect((await request('/bookings', 'POST', data, traveler)).status).toBe(404);
    approve();
    expect((await request('/bookings', 'POST', data, traveler)).status).toBe(409);
    await openMonday();
    expect((await request('/bookings', 'POST', { ...data, endTime: '10:30' }, traveler)).status).toBe(400);
    expect((await request('/bookings', 'POST', { ...data, date: '2026-02-30' }, traveler)).status).toBe(400);
    expect((await request('/bookings', 'POST', { ...data, duration: 30 }, traveler)).status).toBe(400);
    const result = await request('/bookings', 'POST', data, traveler);
    expect(result.status).toBe(201);
    expect(result.body.data.booking.service.price).toBe(500);
    expect((await request('/bookings', 'POST', data, traveler)).status).toBe(409);
    await request(`/companions/${guide}/experiences/${id}`, 'DELETE', undefined, guide);
    expect((await request('/bookings', 'POST', data, traveler)).status).toBe(404);
  });

  it('only publishes same-day durations and books the largest supported interval', async () => {
    expect((await request(`/companions/${guide}/experiences`, 'POST', { ...payload, durationMinutes: 1440 }, guide)).status).toBe(400);
    const created = await request(`/companions/${guide}/experiences`, 'POST', { ...payload, durationMinutes: 1439 }, guide);
    expect(created.status).toBe(201);
    expect((await request(`/suppliers/${guide}/services`, 'POST', { title: 'Legacy long service', priceMin: 500, priceMax: 500, currency: 'THB', durationHours: 24 }, guide)).status).toBe(400);
    approve();
    await weekly([{ dayOfWeek: 1, startTime: '00:00', endTime: '23:59', isAvailable: true }]);
    expect((await request('/bookings', 'POST', { companionId: guide, serviceId: created.body.data.experienceId,
      date: '2026-10-05', startTime: '00:00', duration: 1439 }, traveler)).status).toBe(201);
    expect((await request(`/companions/${guide}/experiences/${created.body.data.experienceId}`, 'PUT',
      { ...payload, durationMinutes: 1440 }, guide)).status).toBe(400);
  });

  it('static stats requires guide authentication, aggregates beyond 20 rows and never claims cash earnings', async () => {
    expect((await request('/suppliers/stats')).status).toBe(401);
    expect((await request('/suppliers/stats', 'GET', undefined, traveler)).status).toBe(403);
    const id = (await create()).body.data.experienceId;
    for (let n = 0; n < 25; n++) booking(`book-${n}`, id, '2026-01-01');
    booking('cancelled', id, '2025-12-31', 'cancelled');
    const result = await request('/suppliers/stats', 'GET', undefined, guide);
    expect(result.status).toBe(200);
    expect(result.body.data.data).toMatchObject({ totalBookings: 26, completedBookings: 25, cancelledBookings: 1, bookedValue: 12500, currency: 'THB', totalEarnings: null, averageRating: null, responseRate: null, responseTime: null, profileViews: null });
    expect(result.body.data.data.monthlyStats).toEqual([{ month: '2025-12', bookings: 1, earnings: null, rating: null }, { month: '2026-01', bookings: 25, earnings: null, rating: null }]);
    expect(result.body.data.data.quarterStats.map((row: any) => row.quarter)).toEqual(['2025-Q4', '2026-Q1']);
    expect((await request('/suppliers/stats', 'GET', undefined, other)).body.data.data.totalBookings).toBe(0);
    booking('usd', id, '2026-01-01', 'completed', 'USD');
    expect((await request('/suppliers/stats', 'GET', undefined, guide)).body.data.data).toMatchObject({ bookedValue: null, currency: null });
  });
});
