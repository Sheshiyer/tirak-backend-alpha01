import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { readFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { publicRoutes } from '@/routes/public';
import { companionRoutes } from '@/routes/companions';
import { createTestEnv } from '@tests/setup';
import { buildMigrationDb, seedStubRow } from '../migrations/helpers/sqlite';

const id = (n: number) => `123e4567-e89b-12d3-a456-4266141740${String(n).padStart(2, '0')}`;
const ELIGIBLE_A = id(1);
const ELIGIBLE_B = id(2);
const ELIGIBLE_C = id(3);
const SUSPENDED = id(4);
const UNVERIFIED = id(5);
const EXPIRED = id(6);
const MALFORMED_EXPIRY = id(7);
const NO_SERVICE = id(8);
const ARCHIVED_ONLY = id(9);
const INACTIVE_ONLY = id(10);
const FIXTURE_ID = 'companion_001';
const FIXTURE_EMAIL = id(11);
const FUTURE_TRIAL = id(12);
const LOW_RATING = id(13);

describe('public discovery applies the shared guide visibility predicate', () => {
  let db: DatabaseSync;
  let app: Hono;
  let env: ReturnType<typeof createTestEnv>;
  let kv: Map<string, string>;

  const seedGuide = (
    guideId: string,
    email: string,
    name: string,
    opts: {
      userStatus?: string;
      verification?: string;
      expires?: string | null;
      service?: 'active' | 'none' | 'archived' | 'inactive';
      rating?: number;
      count?: number;
    } = {},
  ) => {
    seedStubRow(db, 'users', { id: guideId, email, user_type: 'supplier', status: opts.userStatus ?? 'active' });
    seedStubRow(db, 'supplier_profiles', {
      user_id: guideId,
      display_name: name,
      subscription_status: 'active',
      verification_status: opts.verification ?? 'verified',
      subscription_expires_at: opts.expires ?? null,
      categories: '["walks"]',
      regions: '["bangkok"]',
      profile_images: '[]',
      rating_average: opts.rating ?? 4.5,
      rating_count: opts.count ?? 10,
    });
    const service = opts.service ?? 'active';
    if (service !== 'none') {
      seedStubRow(db, 'supplier_services', {
        id: `service-${guideId}`,
        supplier_id: guideId,
        price_min: 100,
        price_max: 100,
        duration_hours: 1,
        is_active: service === 'inactive' ? 0 : 1,
        archived_at: service === 'archived' ? '2026-01-01T00:00:00Z' : null,
      });
    }
  };

  beforeEach(() => {
    db = buildMigrationDb();
    db.exec(readFileSync('migrations/017_core_guide_management.sql', 'utf8'));
    kv = new Map();
    env = createTestEnv();
    env.DB = {
      ...env.DB,
      prepare(sql: string) {
        const statement = (values: any[] = []): any => ({
          bind: (...params: any[]) => statement(params),
          first: async () => db.prepare(sql).get(...values) ?? null,
          all: async () => ({ results: db.prepare(sql).all(...values), success: true }),
          run: async () => ({ success: true, meta: { changes: db.prepare(sql).run(...values).changes } }),
        });
        return statement();
      },
    };
    env.CACHE = {
      get: async (key: string) => kv.get(key) ?? null,
      put: async (key: string, value: string) => { kv.set(key, value); },
      delete: async (key: string) => { kv.delete(key); },
    } as any;

    seedGuide(ELIGIBLE_A, 'a@example.test', 'Alpha Guide', { rating: 4.9, count: 20 });
    seedGuide(ELIGIBLE_B, 'b@example.test', 'Bravo Guide', { rating: 4.7, count: 12 });
    seedGuide(ELIGIBLE_C, 'c@example.test', 'Charlie Guide', { rating: 4.2, count: 6 });
    seedGuide(FUTURE_TRIAL, 'future@example.test', 'Future Trial Guide', { rating: 4.1, count: 7, expires: '2999-01-01 00:00:00' });
    seedGuide(LOW_RATING, 'low@example.test', 'Low Rating Guide', { rating: 3.0, count: 20 });
    seedGuide(SUSPENDED, 'suspended@example.test', 'Alpha Suspended', { userStatus: 'suspended', rating: 5, count: 50 });
    seedGuide(UNVERIFIED, 'unverified@example.test', 'Alpha Unverified', { verification: 'pending', rating: 5, count: 50 });
    seedGuide(EXPIRED, 'expired@example.test', 'Alpha Expired', { expires: '2020-01-01 00:00:00', rating: 5, count: 50 });
    seedGuide(MALFORMED_EXPIRY, 'bad-expiry@example.test', 'Alpha Malformed', { expires: 'not-a-date', rating: 5, count: 50 });
    seedGuide(NO_SERVICE, 'noservice@example.test', 'Alpha NoService', { service: 'none', rating: 5, count: 50 });
    seedGuide(ARCHIVED_ONLY, 'archived@example.test', 'Alpha Archived', { service: 'archived', rating: 5, count: 50 });
    seedGuide(INACTIVE_ONLY, 'inactive@example.test', 'Alpha Inactive', { service: 'inactive', rating: 5, count: 50 });
    seedGuide(FIXTURE_ID, 'fixture-by-id@example.test', 'Alpha Fixture Id', { rating: 5, count: 50 });
    seedGuide(FIXTURE_EMAIL, ' DEMO.COMPANION@TIRAK.COM ', 'Alpha Fixture Email', { rating: 5, count: 50 });

    seedStubRow(db, 'users', { id: 'customer-real', email: 'customer@example.test', user_type: 'customer', status: 'active' });
    seedStubRow(db, 'users', { id: 'demo_customer_001', email: 'demo.customer@tirak.com', user_type: 'customer', status: 'active' });
    seedStubRow(db, 'users', { id: 'customer-suspended', email: 'cs@example.test', user_type: 'customer', status: 'suspended' });

    app = new Hono();
    app.route('/public', publicRoutes);
    app.route('/companions', companionRoutes);
  });
  afterEach(() => db.close());

  const read = async (path: string) => {
    const response = await app.request(`http://localhost${path}`, {}, env);
    return { status: response.status, cacheControl: response.headers.get('Cache-Control'), body: await response.json() as any };
  };

  const eligibleIds = [ELIGIBLE_A, ELIGIBLE_B, ELIGIBLE_C, FUTURE_TRIAL, LOW_RATING].sort();
  const ineligibleIds = [SUSPENDED, UNVERIFIED, EXPIRED, MALFORMED_EXPIRY, NO_SERVICE, ARCHIVED_ONLY, INACTIVE_ONLY, FIXTURE_ID, FIXTURE_EMAIL];

  it('companions and public featured agree on eligible inventory, and featured excludes every ineligible guide', async () => {
    const companions = await read('/companions?limit=50');
    expect(companions.status).toBe(200);
    expect(companions.body.data.companions.map((g: any) => g.id).sort()).toEqual(eligibleIds);

    const featured = await read('/public/featured-suppliers?limit=50');
    expect(featured.status).toBe(200);
    const featuredIds = featured.body.data.items.map((g: any) => g.id);
    for (const hidden of ineligibleIds) expect(featuredIds).not.toContain(hidden);
    // Featured is the rating>=4 / count>=5 subset of exactly the companion-visible set.
    expect(featuredIds).toEqual([ELIGIBLE_A, ELIGIBLE_B, ELIGIBLE_C, FUTURE_TRIAL]);
    for (const guideId of featuredIds) expect(eligibleIds).toContain(guideId);
    expect(featured.body.data.pagination.total).toBe(4);
  });

  it('featured list, count and pagination agree page by page', async () => {
    const seen: string[] = [];
    for (let page = 1; page <= 4; page++) {
      const result = await read(`/public/featured-suppliers?limit=1&page=${page}`);
      expect(result.body.data.pagination).toMatchObject({ total: 4, totalPages: 4 });
      expect(result.body.data.items).toHaveLength(1);
      seen.push(result.body.data.items[0].id);
    }
    expect(seen).toEqual([ELIGIBLE_A, ELIGIBLE_B, ELIGIBLE_C, FUTURE_TRIAL]);
    const beyond = await read('/public/featured-suppliers?limit=1&page=5');
    expect(beyond.body.data.items).toEqual([]);
    expect(beyond.body.data.pagination.total).toBe(4);
  });

  it('featured returns nothing when only ineligible guides would qualify', async () => {
    db.prepare("UPDATE supplier_profiles SET rating_average = 1 WHERE user_id IN (?, ?, ?, ?, ?)")
      .run(ELIGIBLE_A, ELIGIBLE_B, ELIGIBLE_C, FUTURE_TRIAL, LOW_RATING);
    const featured = await read('/public/featured-suppliers');
    expect(featured.body.data.items).toEqual([]);
    expect(featured.body.data.pagination.total).toBe(0);
  });

  it('stats report only visible guides/services and non-fixture customers; booking history is untouched', async () => {
    const stats = await read('/public/stats');
    expect(stats.status).toBe(200);
    const data = stats.body.data;
    expect(data.suppliers.verified).toBe(5);
    expect(data.users.suppliers).toBe(5);
    expect(data.users.customers).toBe(1);
    // Active accounts remain distinct from publicly eligible guide inventory.
    expect(data.users.total).toBe(12);
    expect(data.services.total).toBe(5);
    // mean of 4.9, 4.7, 4.2, 4.1, 3.0 = 4.18 -> 4.2
    expect(data.suppliers.averageRating).toBe(4.2);
    const companionTotal = (await read('/companions?limit=50')).body.data.pagination.total;
    expect(data.suppliers.verified).toBe(companionTotal);
    expect(data.bookings).toEqual({ total: 0, completed: 0 });
  });

  it('stats service count excludes services of hidden guides and archived/inactive services of visible guides', async () => {
    seedStubRow(db, 'supplier_services', { id: 'extra-archived', supplier_id: ELIGIBLE_A, price_min: 1, price_max: 1, duration_hours: 1, is_active: 1, archived_at: '2026-01-01T00:00:00Z' });
    seedStubRow(db, 'supplier_services', { id: 'extra-inactive', supplier_id: ELIGIBLE_A, price_min: 1, price_max: 1, duration_hours: 1, is_active: 0 });
    seedStubRow(db, 'supplier_services', { id: 'extra-active', supplier_id: ELIGIBLE_A, price_min: 1, price_max: 1, duration_hours: 1, is_active: 1 });
    const stats = await read('/public/stats');
    expect(stats.body.data.services.total).toBe(6);
  });

  it('search suggestions never surface hidden guides', async () => {
    const result = await read('/public/search-suggestions?q=Alpha&type=suppliers');
    expect(result.status).toBe(200);
    expect(result.body.data.map((g: any) => g.id)).toEqual([ELIGIBLE_A]);
    const all = await read('/public/search-suggestions?q=Guide');
    for (const hidden of ineligibleIds) expect(all.body.data.map((g: any) => g.id)).not.toContain(hidden);
  });

  it('keeps the same public envelopes and removes withdrawn inventory on the next request', async () => {
    const featuredPath = '/public/featured-suppliers';
    const suggestionsPath = '/public/search-suggestions?q=alpha&type=suppliers';
    const statsPath = '/public/stats';

    expect((await read(featuredPath)).body.data.items[0].id).toBe(ELIGIBLE_A);
    expect((await read(suggestionsPath)).body.data).toMatchObject([{ id: ELIGIBLE_A }]);
    expect((await read(statsPath)).body.data.suppliers.verified).toBe(5);

    for (const prefix of ['', 'v2:']) {
      kv.set(`public:${prefix}featured:1:20`, JSON.stringify({ suppliers: [{ id: ELIGIBLE_A }], pagination: { total: 4 } }));
      kv.set(`public:${prefix}stats`, JSON.stringify({ suppliers: { verified: 5 } }));
      kv.set(`suggestions:${prefix}suppliers:alpha`, JSON.stringify([{ id: ELIGIBLE_A }]));
    }
    db.prepare("UPDATE users SET status = 'suspended' WHERE id = ?").run(ELIGIBLE_A);

    const [featured, suggestions, stats] = await Promise.all([read(featuredPath), read(suggestionsPath), read(statsPath)]);
    for (const result of [featured, suggestions, stats]) {
      expect(result).toMatchObject({ status: 200, cacheControl: 'no-store', body: { success: true } });
    }
    expect(featured.body.data.items.map((guide: { id: string }) => guide.id)).not.toContain(ELIGIBLE_A);
    expect(featured.body.data.pagination.total).toBe(3);
    expect(suggestions.body.data).toEqual([]);
    expect(stats.body.data).toMatchObject({ suppliers: { verified: 4 }, services: { total: 4 } });
  });

  it('does not mutate any rows (read-only)', async () => {
    const before = db.prepare('SELECT (SELECT COUNT(*) FROM users) u, (SELECT COUNT(*) FROM supplier_profiles) p, (SELECT COUNT(*) FROM supplier_services) s').get();
    await read('/public/stats');
    await read('/public/featured-suppliers');
    await read('/public/search-suggestions?q=Guide');
    expect(db.prepare('SELECT (SELECT COUNT(*) FROM users) u, (SELECT COUNT(*) FROM supplier_profiles) p, (SELECT COUNT(*) FROM supplier_services) s').get()).toEqual(before);
  });
});
