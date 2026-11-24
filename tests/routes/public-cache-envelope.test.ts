import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { publicRoutes } from '@/routes/public';
import { createTestEnv } from '@tests/setup';

// /categories, /regions and /config must return the same canonical envelope
// whether the response comes from D1 (cache miss) or KV (cache hit).
function createEnv() {
  const env: any = createTestEnv();
  const store = new Map<string, string>();
  env.CACHE = {
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => { store.set(key, value); },
    delete: async (key: string) => { store.delete(key); },
  };
  let dbCalls = 0;
  env.DB.prepare = (query: string) => {
    const statement = {
      first: async () => { dbCalls += 1; return { total: 1 }; },
      all: async () => {
        dbCalls += 1;
        return query.includes('FROM categories')
          ? { results: [{ id: 'c1', name_en: 'Food', name_th: 'อาหาร', description_en: 'd', description_th: 'd', icon_url: null, sort_order: 1 }] }
          : { results: [{ id: 'r1', name_en: 'Bangkok', name_th: 'กรุงเทพ', country_code: 'TH', sort_order: 1 }] };
      },
      run: async () => ({ success: true }),
    };
    return { ...statement, bind: () => statement };
  };
  return { env, store, dbCalls: () => dbCalls };
}

const app = new Hono();
app.route('/api/public', publicRoutes);

describe('public cache envelope consistency', () => {
  for (const [path, id] of [['categories', 'c1'], ['regions', 'r1']] as const) {
    it(`GET /api/public/${path} returns { success, data: { items, pagination } } on miss and hit`, async () => {
      const { env, store, dbCalls } = createEnv();

      const miss = await app.request(`http://localhost/api/public/${path}`, {}, env);
      expect(miss.status).toBe(200);
      const missBody = await miss.json() as any;
      expect(missBody.success).toBe(true);
      expect(missBody.data.items[0].id).toBe(id);
      expect(missBody.data.pagination).toMatchObject({ page: 1, total: 1 });
      expect(missBody[path]).toBeUndefined();

      const cachedKeys = [...store.keys()].filter(key => key.includes(path));
      expect(cachedKeys).toHaveLength(1);
      expect(JSON.parse(store.get(cachedKeys[0])!)).toEqual(missBody);

      const callsAfterMiss = dbCalls();
      const hit = await app.request(`http://localhost/api/public/${path}`, {}, env);
      expect(hit.status).toBe(200);
      expect(dbCalls()).toBe(callsAfterMiss);
      expect(await hit.json()).toEqual(missBody);
    });
  }

  it('GET /api/public/config returns { success, data } on miss and hit', async () => {
    const { env } = createEnv();
    const miss = await (await app.request('http://localhost/api/public/config', {}, env)).json() as any;
    expect(miss.success).toBe(true);
    expect(miss.data.app.name).toBe('Tirak');
    const hit = await (await app.request('http://localhost/api/public/config', {}, env)).json();
    expect(hit).toEqual(miss);
  });
});
