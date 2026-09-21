import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import type { DatabaseSync } from 'node:sqlite';
import { companionRoutes } from '@/routes/companions';
import { createTestEnv } from '@tests/setup';
import { buildMigrationDb, seedStubRow } from '../migrations/helpers/sqlite';

describe('public companion discovery uses real profiles and truthful metrics', () => {
  let db: DatabaseSync;
  let app: Hono;
  let env: ReturnType<typeof createTestEnv>;
  const realId = '123e4567-e89b-12d3-a456-426614174001';
  const sameNameId = '123e4567-e89b-12d3-a456-426614174002';
  const reviewId = '30c6d267-22d1-4cd0-8bdc-46993c14c143';
  const reviewEmailId = '123e4567-e89b-12d3-a456-426614174003';
  const pendingId = '123e4567-e89b-12d3-a456-426614174004';
  const noServiceId = '123e4567-e89b-12d3-a456-426614174005';

  const seedGuide = (
    id: string,
    email: string,
    name: string,
    price: number,
    rating = 4.5,
    languages = ['en'],
    options: { verificationStatus?: string; withService?: boolean; profileImages?: string } = {},
  ) => {
    seedStubRow(db, 'users', { id, email, user_type: 'supplier', status: 'active' });
    seedStubRow(db, 'supplier_profiles', {
      user_id: id, display_name: name, subscription_status: 'active', verification_status: options.verificationStatus || 'verified',
      categories: '["walks"]', regions: '["bangkok"]', spoken_languages: JSON.stringify(languages),
      profile_images: options.profileImages || '[]', rating_average: rating, rating_count: 2,
    });
    if (options.withService !== false) {
      seedStubRow(db, 'supplier_services', { id: `service-${id}`, supplier_id: id, price_min: price, price_max: price, duration_hours: 1, is_active: 1 });
    }
  };

  beforeEach(() => {
    db = buildMigrationDb();
    app = new Hono();
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
    seedStubRow(db, 'categories', { id: 'walks', name_en: 'Walks', name_th: 'Walks', is_active: 1 });
    seedStubRow(db, 'regions', { id: 'bangkok', name_en: 'Bangkok', name_th: 'Bangkok', is_active: 1 });
    seedGuide(realId, 'real@example.test', 'Real guide', 100, 4.9, ['en'], {
      profileImages: JSON.stringify([
        'file:///data/user/0/com.tirak.app/cache/profile.jpg',
        'https://cdn.example.test/real-guide.jpg',
      ]),
    });
    seedGuide(sameNameId, 'test-name-but-real@example.test', 'Test Companion', 200, 3.5, ['th']);
    seedGuide(reviewId, 'renamed-review@example.test', 'Renamed review fixture', 1);
    seedGuide(reviewEmailId, ' TEST.COMPANION.TIRAK@GMAIL.COM ', 'Other review fixture', 90000);
    seedGuide(pendingId, 'pending@example.test', 'Pending guide', 300, 4, ['en'], { verificationStatus: 'pending' });
    seedGuide(noServiceId, 'no-service@example.test', 'No service guide', 400, 4, ['en'], { withService: false });
    app.route('/companions', companionRoutes);
  });
  afterEach(() => db.close());

  const read = async (path = '') => {
    const response = await app.request(`http://localhost/companions${path}`, {}, env);
    return { status: response.status, body: await response.json() };
  };

  it('excludes exact review identities before pagination and from filter counts/range', async () => {
    const result = await read('?limit=1');
    expect(result.status).toBe(200);
    expect(result.body.data.companions.map((guide: any) => guide.id)).toEqual([realId]);
    expect(result.body.data.pagination).toMatchObject({ total: 2, totalPages: 2 });
    expect(result.body.data.filters.categories).toContainEqual({ id: 'walks', name: 'Walks', count: 2 });
    expect(result.body.data.filters.locations).toContainEqual({ id: 'bangkok', name: 'Bangkok', count: 2 });
    expect(result.body.data.filters.priceRange).toEqual({ min: 100, max: 200 });
    const second = await read('?limit=1&page=2');
    expect(second.body.data.companions.map((guide: any) => guide.id)).toEqual([sameNameId]);
    expect(db.prepare('SELECT COUNT(*) AS count FROM users').get()).toMatchObject({ count: 6 });
  });

  it.each([pendingId, noServiceId])('does not publish unapproved or incomplete guide %s', async (id) => {
    const list = await read();
    expect(list.body.data.companions.map((guide: any) => guide.id)).not.toContain(id);

    for (const suffix of ['', '/services', '/availability?startDate=2026-10-01&endDate=2026-10-02']) {
      const detail = await read(`/${id}${suffix}`);
      expect(detail.status).toBe(404);
    }
  });

  it('removes phone-local image references from public responses', async () => {
    const list = await read();
    const guide = list.body.data.companions.find((item: any) => item.id === realId);
    expect(guide.profileImage).toBe('https://cdn.example.test/real-guide.jpg');

    const detail = await read(`/${realId}`);
    expect(detail.body.data.profileImage).toBe('https://cdn.example.test/real-guide.jpg');
    expect(detail.body.data.gallery).toEqual(['https://cdn.example.test/real-guide.jpg']);
  });

  it.each([reviewId, reviewEmailId])('returns 404 on public details/services/availability for review identity %s', async (id) => {
    for (const suffix of ['', '/services', '/availability?startDate=2026-10-01&endDate=2026-10-02']) {
      const result = await read(`/${id}${suffix}`);
      expect(result.status).toBe(404);
    }
  });

  it('does not infer a demo identity from a real guide name', async () => {
    const result = await read(`/${sameNameId}`);
    expect(result.status).toBe(200);
    expect(result.body.data.name).toBe('Test Companion');
  });

  it('reports unmeasured performance as null in list and details', async () => {
    const list = await read();
    expect(list.body.data.companions.find((guide: any) => guide.id === realId)).toMatchObject({ responseTime: null, completionRate: null });
    const detail = await read(`/${realId}`);
    expect(detail.status).toBe(200);
    expect(detail.body.data).toMatchObject({ responseTime: null, completionRate: null });
  });

  it.each(['?languages=en', '?rating=4.5', '?minPrice=50&maxPrice=150'])('counts exactly the filtered result set for %s', async (query) => {
    const result = await read(query);
    expect(result.status).toBe(200);
    expect(result.body.data.companions.map((guide: any) => guide.id)).toEqual([realId]);
    expect(result.body.data.pagination.total).toBe(1);
  });
});
