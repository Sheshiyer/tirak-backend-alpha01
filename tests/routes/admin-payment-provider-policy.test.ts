import { beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { adminPaymentRoutes } from '@/routes/admin/payments';
import { adminRoutes } from '@/routes/admin';
import {
  PAYMENT_PROVIDER_POLICY_KEY,
  parseStoredPaymentProviderPolicy,
} from '@/payments/provider-policy';
import { createTestEnv } from '@tests/setup';
import { generateJWT } from '@/utils/auth';

describe('admin payment provider policy routes', () => {
  let app: Hono;
  let env: ReturnType<typeof createTestEnv> & Record<string, any>;
  let stored: string | null;
  let putCalls: Array<{ key: string; value: string }>;

  beforeEach(() => {
    stored = null;
    putCalls = [];
    env = {
      ...createTestEnv(),
      ENVIRONMENT: 'staging',
      PAYMENT_MODE: 'test',
      PROMPTPAY_ENABLED: 'true',
      PAYMENT_ADMIN_USER_IDS: 'admin-1',
      PAYMENT_PRODUCTION_POLICY_WRITES_ENABLED: 'false',
      OMISE_SECRET_KEY: 'skey_test_fixture',
      OMISE_WEBHOOK_SECRET: 'webhook-fixture',
      PAYMENT_CONFIG_KV: {
        get: async () => stored,
        put: async (key: string, value: string) => {
          putCalls.push({ key, value });
          stored = value;
        },
      },
    };
    app = new Hono();
    app.use('*', async (c, next) => {
      c.set('userId', 'admin-1');
      await next();
    });
    app.route('/admin/payments', adminPaymentRoutes);
  });

  const patch = (body: unknown) => app.request('/admin/payments/provider-policy', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, env);

  it('GET returns a fail-closed non-secret view when no policy exists', async () => {
    const response = await app.request('/admin/payments/provider-policy', undefined, env);
    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(body.data).toMatchObject({
      configured: false,
      provider: 'omise',
      mode: 'disabled',
      enabled: false,
      revision: 0,
      readiness: { credentialsBound: true, webhookSecretBound: true },
      effective: { enabled: false, reason: 'provider_policy_absent', adapter: null },
    });
    expect(JSON.stringify(body)).not.toContain(env.OMISE_SECRET_KEY);
    expect(JSON.stringify(body)).not.toContain(env.OMISE_WEBHOOK_SECRET);
  });

  it('PATCH stores policy and before/after audit in one KV write', async () => {
    const response = await patch({
      provider: 'omise',
      environment: 'staging',
      mode: 'test',
      enabled: true,
      supportedMethods: ['promptpay'],
      expectedRevision: 0,
    });
    expect(response.status).toBe(200);
    expect(putCalls).toHaveLength(1);
    expect(putCalls[0]?.key).toBe(PAYMENT_PROVIDER_POLICY_KEY);
    const document = parseStoredPaymentProviderPolicy(putCalls[0]?.value);
    expect(document).not.toBeNull();
    expect(document?.policy).toMatchObject({ enabled: true, revision: 1 });
    expect(document?.auditTrail).toEqual([expect.objectContaining({
      actorId: 'admin-1',
      before: null,
      after: expect.objectContaining({ enabled: true, revision: 1 }),
    })]);
    const body = await response.json() as any;
    expect(body.data.effective).toEqual({
      enabled: true,
      reason: null,
      adapter: 'omise-promptpay',
    });
  });

  it.each(['secretKey', 'credentials', 'webhookSecret'])('rejects the secret-like field %s without writing', async (field) => {
    const response = await patch({
      provider: 'omise',
      environment: 'staging',
      mode: 'test',
      enabled: true,
      supportedMethods: ['promptpay'],
      [field]: 'must-not-be-accepted',
    });
    expect(response.status).toBe(400);
    expect(putCalls).toHaveLength(0);
  });

  it.each([
    ['enabled disabled-mode policy', { environment: 'staging', mode: 'disabled' }],
    ['enabled live-mode staging policy', { environment: 'staging', mode: 'live' }],
    ['enabled test-mode production policy', { environment: 'production', mode: 'test' }],
  ])('rejects an incoherent %s without replacing the current policy', async (_name, override) => {
    const before = stored;
    const response = await patch({
      provider: 'omise',
      enabled: true,
      supportedMethods: ['promptpay'],
      ...override,
    });
    expect(response.status).toBe(400);
    expect(stored).toBe(before);
    expect(putCalls).toHaveLength(0);
  });

  it('keeps production/live activation locked without the release-owner gate', async () => {
    const response = await patch({
      provider: 'omise',
      environment: 'production',
      mode: 'live',
      enabled: true,
      supportedMethods: ['promptpay'],
    });
    expect(response.status).toBe(403);
    expect(stored).toBeNull();
    expect(putCalls).toHaveLength(0);
  });

  it('requires payment-admin membership for updates', async () => {
    env.PAYMENT_ADMIN_USER_IDS = 'different-admin';
    const response = await patch({
      provider: 'omise',
      environment: 'staging',
      mode: 'disabled',
      enabled: false,
      supportedMethods: ['promptpay'],
    });
    expect(response.status).toBe(403);
    expect(putCalls).toHaveLength(0);
  });

  it('reports the combined runtime and provider effective state', async () => {
    expect((await patch({
      provider: 'omise',
      environment: 'staging',
      mode: 'test',
      enabled: true,
      supportedMethods: ['promptpay'],
    })).status).toBe(200);

    env.PROMPTPAY_ENABLED = 'false';
    const response = await app.request('/admin/payments/provider-policy', undefined, env);
    const body = await response.json() as any;
    expect(body.data.effective).toEqual({
      enabled: false,
      reason: 'creation_disabled',
      adapter: null,
    });
  });

  it('preserves the old policy when persistence fails', async () => {
    const initial = await patch({
      provider: 'omise',
      environment: 'staging',
      mode: 'disabled',
      enabled: false,
      supportedMethods: ['promptpay'],
    });
    expect(initial.status).toBe(200);
    const before = stored;
    env.PAYMENT_CONFIG_KV.put = async () => {
      throw new Error('simulated KV failure');
    };
    const failed = await patch({
      provider: 'omise',
      environment: 'staging',
      mode: 'test',
      enabled: true,
      supportedMethods: ['promptpay'],
      expectedRevision: 1,
    });
    expect(failed.status).toBe(503);
    expect(stored).toBe(before);
    expect(parseStoredPaymentProviderPolicy(stored)?.policy).toMatchObject({
      enabled: false,
      revision: 1,
    });
  });

  it('rejects a stale revision without writing', async () => {
    await patch({
      provider: 'omise',
      environment: 'staging',
      mode: 'disabled',
      enabled: false,
      supportedMethods: ['promptpay'],
    });
    putCalls = [];
    const response = await patch({
      provider: 'omise',
      environment: 'staging',
      mode: 'test',
      enabled: true,
      supportedMethods: ['promptpay'],
      expectedRevision: 0,
    });
    expect(response.status).toBe(409);
    expect(putCalls).toHaveLength(0);
  });
});

describe('admin payment provider policy RBAC', () => {
  const userRow = (userType: 'customer' | 'admin') => ({
    id: `${userType}-1`,
    email: `${userType}@example.com`,
    phone: '+66812345678',
    password_hash: 'unused',
    user_type: userType,
    status: 'active',
    email_verified: 1,
    phone_verified: 1,
    preferred_language: 'en',
    created_at: '2026-09-17T00:00:00.000Z',
    updated_at: '2026-09-17T00:00:00.000Z',
  });

  async function requestAs(userType?: 'customer' | 'admin', method: 'GET' | 'PATCH' = 'GET') {
    const app = new Hono();
    app.route('/api/admin', adminRoutes);
    const env: any = {
      ...createTestEnv(),
      PAYMENT_CONFIG_KV: {
        get: async () => null,
        put: async () => undefined,
      },
      PAYMENT_ADMIN_USER_IDS: 'admin-1',
    };
    if (userType) {
      env.DB.prepare = () => ({
        bind: () => ({ first: async () => userRow(userType) }),
      });
    }
    const token = userType
      ? await generateJWT({
        sub: `${userType}-1`,
        email: `${userType}@example.com`,
        userType,
      }, env.JWT_SECRET)
      : null;
    return app.request('/api/admin/payments/provider-policy', {
      method,
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      ...(method === 'PATCH' ? {
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          provider: 'omise',
          environment: 'staging',
          mode: 'disabled',
          enabled: false,
          supportedMethods: ['promptpay'],
        }),
      } : {}),
    }, env);
  }

  it('rejects an unauthenticated request', async () => {
    expect((await requestAs()).status).toBe(401);
  });

  it('rejects an authenticated non-admin request', async () => {
    expect((await requestAs('customer')).status).toBe(403);
  });

  it('allows an authenticated admin request', async () => {
    expect((await requestAs('admin')).status).toBe(200);
  });

  it('rejects a non-admin policy update before payment-admin evaluation', async () => {
    expect((await requestAs('customer', 'PATCH')).status).toBe(403);
  });

  it('allows a listed payment administrator to update policy', async () => {
    expect((await requestAs('admin', 'PATCH')).status).toBe(200);
  });
});
