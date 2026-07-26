import { beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { createRateLimit, rateLimit, rateLimitConfigs } from '@/middleware/rateLimit';
import { createTestEnv } from '@tests/setup';

/**
 * T-062 adversarial suite — rate-limit attacks.
 *
 * The deployed limiter (createRateLimit -> userRateLimit) keys on the
 * authenticated user id, falling back to CF-Connecting-IP only. These tests
 * prove the enforcement boundary, bucket isolation, and header-spoof
 * resistance, and pin two documented findings (see attack report):
 *   F-1  the limiter fails OPEN when the CACHE namespace errors;
 *   F-2  the shipped-but-unused plain rateLimit()/ipRateLimit() helpers are
 *        X-Forwarded-For-spoofable (latent risk if ever mounted).
 */

const mapCache = () => {
  const store = new Map<string, string>();
  return {
    store,
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => { store.set(key, value); },
    delete: async (key: string) => { store.delete(key); },
  };
};

const buildApp = (middleware: any, withUserHeader = true) => {
  const app = new Hono();
  if (withUserHeader) {
    app.use('*', async (c, next) => {
      const testUser = c.req.header('x-test-user');
      if (testUser) c.set('userId', testUser);
      await next();
    });
  }
  app.use('*', middleware);
  app.get('/', (c) => c.json({ ok: true }));
  return app;
};

const hit = (app: Hono, env: any, headers: Record<string, string> = {}) =>
  app.request('http://localhost/', { method: 'GET', headers }, env);

describe('T-062 adversarial: rate-limit attacks', () => {
  let env: any;

  beforeEach(() => {
    env = createTestEnv();
    env.CACHE = mapCache();
  });

  it('enforces the payment boundary: N pass, N+1 is rejected 429', async () => {
    const app = buildApp(createRateLimit('payment')); // 5 req / 1 min
    const headers = { 'x-test-user': 'user-under-attack' };
    for (let index = 0; index < rateLimitConfigs.payment.max; index += 1) {
      const response = await hit(app, env, headers);
      expect(response.status).toBe(200);
    }
    const blocked = await hit(app, env, headers);
    expect(blocked.status).toBe(429);
  });

  it('isolates buckets per user: exhausting user A never throttles user B', async () => {
    const app = buildApp(createRateLimit('payment'));
    for (let index = 0; index < rateLimitConfigs.payment.max; index += 1) {
      await hit(app, env, { 'x-test-user': 'user-a' });
    }
    expect((await hit(app, env, { 'x-test-user': 'user-a' })).status).toBe(429);
    expect((await hit(app, env, { 'x-test-user': 'user-b' })).status).toBe(200);
  });

  it('X-Forwarded-For rotation does NOT bypass the deployed limiter keying', async () => {
    const app = buildApp(createRateLimit('payment'));
    // Unauthenticated surface: key falls back to CF-Connecting-IP only.
    for (let index = 0; index < rateLimitConfigs.payment.max; index += 1) {
      await hit(app, env, {
        'CF-Connecting-IP': '203.0.113.10',
        'X-Forwarded-For': `198.51.100.${index}`,
      });
    }
    const blocked = await hit(app, env, {
      'CF-Connecting-IP': '203.0.113.10',
      'X-Forwarded-For': '198.51.100.99',
    });
    expect(blocked.status).toBe(429);
  });

  it('F-2 (documented): the unused plain rateLimit() helper IS X-Forwarded-For-spoofable', async () => {
    // Latent risk: this helper is shipped but mounted nowhere in src/. The test
    // pins the spoof so any future mount of plain rateLimit()/ipRateLimit()
    // trips this expectation during review.
    const app = buildApp(rateLimit({ windowMs: 60_000, max: 2 }), false);
    const first = await hit(app, env, { 'X-Forwarded-For': '198.51.100.1' });
    const second = await hit(app, env, { 'X-Forwarded-For': '198.51.100.2' });
    const third = await hit(app, env, { 'X-Forwarded-For': '198.51.100.3' });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    // A non-spoofable limiter would reject here; rotation keeps passing.
    expect(third.status).toBe(200);
  });

  it('F-1 (documented): the limiter fails OPEN when the CACHE namespace errors', async () => {
    env.CACHE = {
      get: async () => { throw new Error('namespace unavailable'); },
      put: async () => { throw new Error('namespace unavailable'); },
      delete: async () => undefined,
    };
    const app = buildApp(createRateLimit('payment'));
    for (let index = 0; index < rateLimitConfigs.payment.max + 2; index += 1) {
      const response = await hit(app, env, { 'x-test-user': 'user-under-attack' });
      expect(response.status).toBe(200);
    }
  });

  it('headerless unauthenticated clients share one fail-closed bucket (no bypass)', async () => {
    const app = buildApp(createRateLimit('payment'));
    for (let index = 0; index < rateLimitConfigs.payment.max; index += 1) {
      await hit(app, env, {});
    }
    // Every headerless client maps to ip:unknown; the bucket is shared, so the
    // limit still holds (availability note, not a confidentiality bypass).
    expect((await hit(app, env, {})).status).toBe(429);
  });
});
