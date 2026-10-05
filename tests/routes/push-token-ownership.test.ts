import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { notificationRoutes } from '@/routes/notifications';
import { commsDatabase } from '../helpers/comms-sqlite';

vi.mock('@/middleware/rateLimit', () => ({ createRateLimit: () => async (_c: any, next: any) => next() }));
vi.mock('@/middleware/auth', () => ({ authMiddleware: async (c: any, next: any) => {
  const user = c.req.header('test-user'); if (!user) return c.json({ success: false }, 401);
  c.set('userId', user); return next();
} }));

describe('authenticated push token ownership', () => {
  let harness: ReturnType<typeof commsDatabase>;
  const app = new Hono().route('/api/notifications', notificationRoutes);
  const token = 'ExpoPushToken[installation-one]';
  const request = (user: string, method = 'POST', value = token) => app.request('http://test/api/notifications/push-token', {
    method, headers: { 'Content-Type': 'application/json', 'test-user': user },
    body: JSON.stringify({ token: value, deviceType: 'ios' }),
  }, { DB: harness.db });
  const owners = () => harness.sqlite.prepare('SELECT user_id FROM user_devices, json_each(push_tokens) WHERE value = ? AND is_active = TRUE').all(token).map((row: any) => row.user_id);
  beforeEach(() => { harness = commsDatabase(`CREATE TABLE user_devices (id TEXT PRIMARY KEY, user_id TEXT, device_type TEXT, push_tokens TEXT, device_info TEXT, is_active INTEGER, last_seen TEXT, created_at TEXT)`); });
  afterEach(() => harness.sqlite.close());
  it('atomically reassigns a token while preserving other installations and making repeats idempotent', async () => {
    expect((await request('alice')).status).toBe(200);
    await request('alice', 'POST', 'ExpoPushToken[other-installation]');
    await request('bob'); await request('bob');
    expect(owners()).toEqual(['bob']);
    expect((harness.sqlite.prepare("SELECT user_id FROM user_devices,json_each(push_tokens) WHERE value='ExpoPushToken[other-installation]'").get() as any).user_id).toBe('alice');
  });
  it('logout can remove only the calling user association and is idempotent', async () => {
    await request('alice'); await request('bob', 'DELETE'); expect(owners()).toEqual(['alice']);
    await request('alice', 'DELETE'); await request('alice', 'DELETE'); expect(owners()).toEqual([]);
  });
  it('serializes concurrent account switches and rolls back failed reassignment', async () => {
    await Promise.all([request('alice'), request('bob')]);
    expect(owners()).toHaveLength(1);
    await request('alice');
    harness.sqlite.exec("CREATE TRIGGER fail_bob BEFORE UPDATE ON user_devices WHEN NEW.user_id = 'bob' BEGIN SELECT RAISE(ABORT, 'test failure'); END");
    expect((await request('bob')).status).toBe(500);
    expect(owners()).toEqual(['alice']);
  });
  it('rejects unauthenticated and malformed registration', async () => {
    expect((await request('')).status).toBe(401);
    expect((await request('alice', 'POST', 'arbitrary-token')).status).toBe(400);
    expect(owners()).toEqual([]);
  });
});
