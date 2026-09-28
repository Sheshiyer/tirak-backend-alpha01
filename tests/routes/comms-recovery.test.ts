import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { Hono } from 'hono';
import { authRoutes } from '@/routes/auth';
import { createTestEnv } from '../setup';
import { commsDatabase } from '../helpers/comms-sqlite';
import { verifyPassword } from '@/utils/auth';

vi.mock('@/middleware/rateLimit', () => ({ createRateLimit: () => async (_c: any, next: any) => next() }));

describe('password recovery provider and single-use contract', () => {
  let harness: ReturnType<typeof commsDatabase>;
  let env: any;
  let cache: Map<string, string>;
  const app = new Hono().route('/api/auth', authRoutes);
  const post = (path: string, body: unknown) => app.request(`http://untrusted.invalid/api/auth/${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }, env);
  beforeEach(() => {
    harness = commsDatabase(`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT, phone TEXT, password_hash TEXT, status TEXT, updated_at TEXT);` + readFileSync('migrations/019_password_reset_consumptions.sql', 'utf8'));
    harness.sqlite.prepare("INSERT INTO users VALUES ('owner','owner@example.test','+660001','old-hash','pending',NULL)").run();
    cache = new Map();
    env = { ...createTestEnv(), DB: harness.db, EMAIL_PROVIDER: 'cloudflare', EMAIL_FROM: 'noreply@tirak.app',
      EMAIL: { send: vi.fn().mockResolvedValue({ messageId: 'provider-id' }) },
      CACHE: { get: async (key: string) => cache.get(key) ?? null, put: async (key: string, value: string) => { cache.set(key, value); }, delete: async (key: string) => { cache.delete(key); } },
    };
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => { harness.sqlite.close(); vi.restoreAllMocks(); vi.useRealTimers(); });
  it('connects request, provider payload, native/browser links, password update and stale-KV replay denial', async () => {
    const response = await post('forgot-password', { identifier: 'owner@example.test' });
    expect(response.status).toBe(200);
    const email = env.EMAIL.send.mock.calls[0][0];
    const token = email.html.match(/tirak:\/\/auth\/new\?token=([^"<]+)/)[1];
    expect(email.html).toContain(`https://tirak-backend.tirak-court.workers.dev/auth/new#token=${token}`);
    expect(email.html).not.toContain('untrusted.invalid');
    expect(email.text).toContain(`https://tirak-backend.tirak-court.workers.dev/auth/new#token=${token}`);
    const stored = cache.get(`reset:${token}`)!;
    expect((await post('reset-password', { token, newPassword: 'ChangedPassword123!' })).status).toBe(200);
    const user = harness.sqlite.prepare('SELECT * FROM users').get() as any;
    expect(await verifyPassword('ChangedPassword123!', user.password_hash)).toBe(true);
    expect(user.status).toBe('active');
    cache.set(`reset:${token}`, stored); // Model KV eventual consistency after delete.
    expect((await post('reset-password', { token, newPassword: 'AnotherPassword123!' })).status).toBe(400);
    expect((harness.sqlite.prepare('SELECT COUNT(*) AS n FROM password_reset_consumptions').get() as any).n).toBe(1);
  });
  it('keeps identical public responses for provider rejection and missing accounts, without leaking sensitive errors', async () => {
    env.EMAIL.send.mockRejectedValue(Object.assign(new Error('owner@example.test private code123'), { code: 'E_SENDER_NOT_VERIFIED' }));
    const existing = await (await post('forgot-password', { identifier: 'owner@example.test' })).json() as any;
    const missing = await (await post('forgot-password', { identifier: 'missing@example.test' })).json() as any;
    expect(existing.data).toEqual(missing.data); expect(existing.message).toBe(missing.message);
    expect(cache.size).toBe(0);
    const logs = JSON.stringify(vi.mocked(console.info).mock.calls);
    expect(logs).toContain('E_SENDER_NOT_VERIFIED'); expect(logs).toContain('failed');
    expect(logs).not.toMatch(/owner@example|code123|private/);
  });
  it('retains an expiring token on uncertain timeout and records unknown delivery', async () => {
    vi.useFakeTimers();
    env.EMAIL.send.mockImplementation(() => new Promise(() => {}));
    const response = post('forgot-password', { identifier: 'owner@example.test' });
    await vi.advanceTimersByTimeAsync(10001);
    expect((await response).status).toBe(200);
    expect(cache.size).toBe(1);
    expect(JSON.stringify(vi.mocked(console.info).mock.calls)).toContain('unknown');
  });
  it('denies expired and malformed expiries without changing password', async () => {
    for (const expiry of [new Date(Date.now() - 1).toISOString(), 'invalid']) {
      const token = crypto.randomUUID(); cache.set(`reset:${token}`, JSON.stringify({ userId: 'owner', expiresAt: expiry }));
      expect((await post('reset-password', { token, newPassword: 'ChangedPassword123!' })).status).toBe(400);
    }
    expect((harness.sqlite.prepare('SELECT password_hash FROM users').get() as any).password_hash).toBe('old-hash');
  });
  it('allows only one simultaneous consumer of a legacy invite token', async () => {
    const token = crypto.randomUUID(); cache.set(`reset:${token}`, JSON.stringify({ userId: 'owner', expiresAt: new Date(Date.now() + 3600000).toISOString() }));
    const results = await Promise.all(['FirstPassword123!', 'SecondPassword123!'].map(newPassword => post('reset-password', { token, newPassword })));
    expect(results.map(result => result.status).sort()).toEqual([200, 400]);
  });
  it('does not report reset failure when analytics is unavailable after successful consumption', async () => {
    env.ANALYTICS_QUEUE.send = vi.fn().mockRejectedValue(new Error('offline'));
    const token = crypto.randomUUID(); cache.set(`reset:${token}`, JSON.stringify({ userId: 'owner', expiresAt: new Date(Date.now() + 3600000).toISOString() }));
    expect((await post('reset-password', { token, newPassword: 'ChangedPassword123!' })).status).toBe(200);
  });
});
