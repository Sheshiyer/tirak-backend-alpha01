import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { authRoutes } from '@/routes/auth';
import { sendOTPSMS, createSMSConfig } from '@/utils/communication';
import { createMockRequest, createTestEnv } from '@tests/setup';

// No SMS provider is integrated. These tests pin that the code never reports
// a simulated "sent" result to callers or users.
describe('SMS delivery honesty', () => {
  it('reports failure for a fully configured Twilio provider instead of simulated success', async () => {
    const config = createSMSConfig({
      TWILIO_ACCOUNT_SID: 'AC_test',
      TWILIO_AUTH_TOKEN: 'test-token',
      TWILIO_FROM_NUMBER: '+10000000000',
    });
    const delivery = await sendOTPSMS(config, '+66812345678', '123456');
    expect(delivery.status).toBe('failed');
    expect(delivery.error).toBe('Twilio SMS delivery is not implemented');
  });

  it('reports failure for a fully configured AWS SNS provider instead of simulated success', async () => {
    const config = createSMSConfig({
      SMS_PROVIDER: 'aws-sns',
      AWS_ACCESS_KEY_ID: 'test-key',
      AWS_SECRET_ACCESS_KEY: 'test-secret',
      AWS_REGION: 'ap-southeast-1',
    });
    const delivery = await sendOTPSMS(config, '+66812345678', '123456');
    expect(delivery.status).toBe('failed');
  });

  it('POST /resend-otp returns 503 rather than claiming the code was sent', async () => {
    const env: any = createTestEnv();
    env.DB.prepare = () => ({
      bind: () => ({
        first: async () => ({
          id: 'user-1',
          email: 'user@example.com',
          phone: '+66812345678',
          user_type: 'customer',
          status: 'active',
          email_verified: 1,
          phone_verified: 0,
        }),
        run: async () => ({ success: true }),
        all: async () => ({ results: [] }),
      }),
    });

    const app = new Hono();
    app.route('/auth', authRoutes);
    const response = await app.request(createMockRequest('http://localhost/auth/resend-otp', {
      method: 'POST',
      body: JSON.stringify({ phone: '+66812345678' }),
      headers: { 'Content-Type': 'application/json' },
    }), undefined, env);

    expect(response.status).toBe(503);
    const body = await response.json() as any;
    expect(body.data?.sent).not.toBe(true);
  });
});
