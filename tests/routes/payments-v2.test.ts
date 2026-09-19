import { beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { paymentIntentsV2 } from '@/routes/paymentIntentsV2';
import { generateJWT } from '@/utils/auth';
import { createMockRequest, createTestEnv, createTestUser } from '@tests/setup';

describe('payment-intent V2 readiness route', () => {
  let app: Hono;
  let env: any;
  let authorization: string;
  let statementRuns: number;

  beforeEach(async () => {
    app = new Hono();
    env = createTestEnv();
    statementRuns = 0;
    env.DB.prepare = () => ({
      bind: () => ({
        first: async () => createTestUser({ id: 'v2-customer', userType: 'customer' }),
        all: async () => ({ results: [] }),
        run: async () => {
          statementRuns += 1;
          return { success: true, meta: { changes: 1 } };
        },
      }),
    });
    authorization = `Bearer ${await generateJWT(
      { sub: 'v2-customer', email: 'customer@example.com', userType: 'customer' },
      env.JWT_SECRET,
    )}`;
    app.route('/payment-intents-v2', paymentIntentsV2);
  });

  it('is authenticated and declares all V2 payment activity disabled', async () => {
    const unauthenticated = await app.request(createMockRequest(
      'http://localhost/payment-intents-v2/readiness',
    ), undefined, env);
    expect(unauthenticated.status).toBe(401);

    const response = await app.request(createMockRequest(
      'http://localhost/payment-intents-v2/readiness',
      { headers: { Authorization: authorization } },
    ), undefined, env);
    const payload = await response.json() as any;

    expect(response.status).toBe(200);
    expect(payload.data).toEqual({
      contractVersion: 'tirak-payment-intents-v2',
      status: 'disabled',
      reason: 'source_only_v2_not_activated',
      capabilities: {
        intentCreation: false,
        providerEventIngestion: false,
        moneyMovement: false,
        ledgerWrites: false,
        paymentReadModel: false,
      },
    });
    expect(statementRuns).toBe(0);
  });

  it('has no mutation endpoint while the V2 ledger is unapproved', async () => {
    const response = await app.request(createMockRequest(
      'http://localhost/payment-intents-v2/readiness',
      { method: 'POST', headers: { Authorization: authorization } },
    ), undefined, env);

    expect(response.status).toBe(404);
    expect(statementRuns).toBe(0);
  });
});
