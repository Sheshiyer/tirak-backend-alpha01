import { beforeEach, afterEach, describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { adminRoutes } from '@/routes/admin';
import { interestRoutes } from '@/routes/interest';
import { generateJWT } from '@/utils/auth';
import { createTestEnv } from '@tests/setup';

describe('Core interest admin readback', () => {
  let db: DatabaseSync; let env: ReturnType<typeof createTestEnv>; let app: Hono; let failRead = false;
  beforeEach(() => {
    db = new DatabaseSync(':memory:');
    db.exec(`CREATE TABLE users(id TEXT PRIMARY KEY,email TEXT,user_type TEXT,status TEXT);
      INSERT INTO users VALUES ('admin','admin@example.invalid','admin','active'), ('customer','customer@example.invalid','customer','active');
      CREATE TABLE interest_entries(id TEXT PRIMARY KEY,email_normalized TEXT,name TEXT,source TEXT,idempotency_key_hash TEXT,payload_digest TEXT,created_at TEXT DEFAULT (datetime('now')));`);
    failRead = false; env = createTestEnv();
    env.DB = { prepare(sql: string) {
      const statement = (values: any[] = []): any => ({ bind: (...params: any[]) => statement(params),
        first: async () => { if (failRead && sql.includes('interest_entries')) throw new Error('DB unavailable'); return db.prepare(sql).get(...values) ?? null; },
        all: async () => ({ success: true, results: db.prepare(sql).all(...values) }),
        run: async () => ({ success: true, meta: { changes: db.prepare(sql).run(...values).changes } }),
      }); return statement();
    } } as any;
    app = new Hono(); app.route('/api/interest', interestRoutes as any); app.route('/api/admin', adminRoutes as any);
  });
  afterEach(() => db.close());
  const read = async (query = '', user?: string) => app.request('/api/admin/interest' + query, {
    headers: user ? { Authorization: 'Bearer ' + await generateJWT({ sub: user, email: user + '@example.invalid', userType: user === 'admin' ? 'admin' : 'customer' }, env.JWT_SECRET) } : {},
  }, env);
  it('requires active-admin auth and reads the actual public signup with its source, without internal hashes', async () => {
    const receipt = await (await app.request('/api/interest', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify({ email: 'REVIEW@example.invalid', source: 'hero_quick_signup' }) }, env)).json() as any;
    expect((await read()).status).toBe(401); expect((await read('', 'customer')).status).toBe(403);
    const response = await read('?source=hero_quick_signup', 'admin'); expect(response.status).toBe(200); expect(response.headers.get('Cache-Control')).toBe('no-store');
    const body = await response.json() as any; expect(body.data.items).toEqual([{ id: receipt.data.interestId, email: 'review@example.invalid', name: null, source: 'hero_quick_signup', createdAt: expect.any(String) }]); expect(body.data.pagination.total).toBe(1);
    db.exec("UPDATE users SET status='suspended' WHERE id='admin'"); expect((await read('', 'admin')).status).toBe(401);
  });
  it('distinguishes valid empty, invalid filters, and unavailable storage', async () => {
    expect((await (await read('', 'admin')).json() as any).data.items).toEqual([]);
    for (const query of ['?page=0', '?limit=101', '?page=1&page=2', '?source=', '?mode=tirakplus']) expect((await read(query, 'admin')).status).toBe(400);
    failRead = true; const response = await read('', 'admin'); expect(response.status).toBe(500); expect((await response.json() as any).data).toBeUndefined();
  });
});
