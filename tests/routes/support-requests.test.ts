import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { Hono } from 'hono';
import { supportRequestRoutes } from '@/routes/supportRequests';
import { adminRoutes } from '@/routes/admin';
import { coreQaBoundary } from '@/middleware/coreQa';
import { generateJWT } from '@/utils/auth';
import { createTestEnv } from '@tests/setup';

describe('Core support durable receipt', () => {
  let db: DatabaseSync;
  let env: ReturnType<typeof createTestEnv>;
  let app: Hono;
  let failInsert: boolean;
  const key = '123e4567-e89b-12d3-a456-426614174000';
  const payload = { kind: 'contact', name: ' Test ', email: 'TEST@example.invalid', subject: ' Question ', message: ' Hello\r\nthere ' };
  beforeEach(() => {
    db = new DatabaseSync(':memory:');
    db.exec(readFileSync('migrations/027_core_support_requests.sql', 'utf8'));
    db.exec(readFileSync('migrations/029_core_support_review.sql', 'utf8'));
    db.exec(readFileSync('migrations/030_core_support_notifications.sql', 'utf8'));
    db.exec("CREATE TABLE users(id TEXT PRIMARY KEY); INSERT INTO users VALUES ('keep-user'); CREATE TABLE bookings(id TEXT PRIMARY KEY); INSERT INTO bookings VALUES ('keep-booking');");
    failInsert = false;
    env = createTestEnv();
    env.DB = {
      ...env.DB,
      async batch(statements: any[]) {
        db.exec('BEGIN');
        try { const results = []; for (const statement of statements) results.push(await statement.run()); db.exec('COMMIT'); return results; }
        catch (error) { db.exec('ROLLBACK'); throw error; }
      },
      prepare(sql: string) {
        const statement = (values: any[] = []): any => ({
          bind: (...params: any[]) => statement(params),
          first: async () => db.prepare(sql).get(...values) ?? null,
          all: async () => ({ results: db.prepare(sql).all(...values), success: true }),
          run: async () => failInsert ? { success: false, meta: { changes: 0 } } : { success: true, meta: { changes: db.prepare(sql).run(...values).changes } },
        });
        return statement();
      },
    };
    app = new Hono();
    app.route('/api/support-requests', supportRequestRoutes);
    app.route('/api/admin', adminRoutes);
  });
  afterEach(() => { db.close(); vi.restoreAllMocks(); });
  const submit = (body: unknown = payload, id = key) => app.request('/api/support-requests', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': id }, body: JSON.stringify(body),
  }, env);
  const count = () => (db.prepare('SELECT count(*) AS total FROM core_support_requests').get() as any).total;

  it('returns success only after a normalized row exists and replays the same reference', async () => {
    const first = await submit();
    expect(first.status).toBe(201);
    expect(first.headers.get('Cache-Control')).toBe('no-store');
    const receipt = await first.json() as any;
    const row = db.prepare('SELECT * FROM core_support_requests').get() as any;
    expect(row.id).toBe(receipt.data.requestId);
    expect(row.email_normalized).toBe('test@example.invalid');
    expect(row.name).toBe('Test');
    expect(row.message).toBe('Hello\nthere');
    expect(row.idempotency_key_hash).toHaveLength(64);
    const replay = await submit({ ...payload, name: 'Test', message: 'Hello\nthere' });
    expect(replay.status).toBe(200);
    expect((await replay.json() as any).data.requestId).toBe(row.id);
    expect(replay.headers.get('Idempotency-Replayed')).toBe('true');
    expect(count()).toBe(1);
    expect((await submit({ ...payload, message: 'Different' })).status).toBe(409);
    expect(count()).toBe(1);
  });

  it('rejects malformed types, unexpected mode, bot input and invalid keys without inserts', async () => {
    for (const body of [{ ...payload, email: [] }, { ...payload, mode: 'tirakplus' }, { ...payload, honeypot: 'bot' }, { ...payload, name: 'bad\u0000name' }]) {
      expect((await submit(body)).status).toBe(400);
    }
    expect((await submit(payload, 'bad-key')).status).toBe(400);
    expect(count()).toBe(0);
  });

  it('never returns a receipt for an unsuccessful D1 result or logs submitted values', async () => {
    failInsert = true;
    const logger = vi.spyOn(console, 'error').mockImplementation(() => {});
    const response = await submit();
    expect(response.status).toBe(500);
    expect((await response.json() as any).data).toBeUndefined();
    expect(count()).toBe(0);
    expect(JSON.stringify(logger.mock.calls)).not.toContain(payload.email);
    expect(JSON.stringify(logger.mock.calls)).not.toContain(key);
    expect(JSON.stringify(logger.mock.calls)).not.toContain(payload.message);
  });

  it('records privacy intent without modifying accounts or history; exposes no public lookup', async () => {
    expect((await submit({ ...payload, kind: 'privacy_deletion' })).status).toBe(201);
    expect(db.prepare('SELECT * FROM users').all()).toEqual([{ id: 'keep-user' }]);
    expect(db.prepare('SELECT * FROM bookings').all()).toEqual([{ id: 'keep-booking' }]);
    expect(db.prepare('PRAGMA foreign_key_list(core_support_requests)').all()).toEqual([]);
    expect((await app.request('/api/support-requests', {}, env)).status).toBe(404);
    expect((await app.request('/api/support-requests/' + key, {}, env)).status).toBe(404);
  });

  it('links the durable public receipt to a redacted admin summary and private detail', async () => {
    db.exec("ALTER TABLE users ADD email TEXT; ALTER TABLE users ADD user_type TEXT; ALTER TABLE users ADD status TEXT; INSERT INTO users VALUES ('admin', 'admin@example.invalid', 'admin', 'active');");
    const receipt = await (await submit()).json() as any;
    const token = await generateJWT({ sub: 'admin', email: 'admin@example.invalid', userType: 'admin' }, env.JWT_SECRET);
    const read = (path: string) => app.request('/api/admin/support-requests' + path, {
      headers: { Authorization: 'Bearer ' + token },
    }, env);
    const list = await read('');
    expect(list.status).toBe(200);
    expect(list.headers.get('Cache-Control')).toBe('no-store');
    const listBody = await list.json() as any;
    expect(listBody.data.items[0].id).toBe(receipt.data.requestId);
    expect(listBody.data.items[0].email).toBeUndefined();
    expect(listBody.data.items[0].message).toBeUndefined();
    const detail = await read('/' + receipt.data.requestId);
    expect(detail.status).toBe(200);
    const row = (await detail.json() as any).data;
    expect(row.email).toBe('test@example.invalid');
    expect(row.message).toBe('Hello\nthere');
    expect(row.payload_digest).toBeUndefined();
    expect(row.idempotency_key_hash).toBeUndefined();
  });

  it('permits only exact QA intake POST while protecting support reads and nested paths', async () => {
    const qa = new Hono();
    qa.use('*', coreQaBoundary);
    qa.all('*', (c) => c.text('passed'));
    const qaEnv = { ...env, ENVIRONMENT: 'core-qa', CORE_QA_MODE: 'cohort' };
    expect((await qa.request('/api/support-requests', { method: 'POST' }, qaEnv)).status).toBe(200);
    expect((await qa.request('/api/support-requests/', { method: 'POST' }, qaEnv)).status).toBe(200);
    for (const [method, path] of [['GET', '/api/support-requests'], ['POST', '/api/support-requests/id'], ['GET', '/api/admin/support-requests']]) {
      expect((await qa.request(path, { method }, qaEnv)).status).toBe(401);
    }
  });
});
