import { readFileSync } from 'node:fs';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authRoutes } from '@/routes/auth';
import type { Env } from '@/index';
import { commsDatabase } from '@tests/helpers/comms-sqlite';
import { createTestEnv } from '@tests/setup';

const schema = [
  'baseline/canonical-baseline.sql',
  '015_account_trust.sql',
  '023_core_customer_registration_fields.sql',
].map((file) => readFileSync(new URL(`../../migrations/${file}`, import.meta.url), 'utf8')).join('\n');

const password = 'SyntheticSignup123!';

describe('registration contact numbers', () => {
  let harness: ReturnType<typeof commsDatabase>;
  let app: Hono;
  let env: ReturnType<typeof createTestEnv> & Pick<Env, 'EMAIL_PROVIDER' | 'EMAIL_FROM' | 'EMAIL'>;
  let emails: string[];

  beforeEach(() => {
    harness = commsDatabase(schema);
    app = new Hono().route('/api/auth', authRoutes);
    emails = [];
    env = {
      ...createTestEnv(),
      DB: harness.db as unknown as ReturnType<typeof createTestEnv>['DB'],
      EMAIL_PROVIDER: 'cloudflare',
      EMAIL_FROM: 'noreply@example.test',
      EMAIL: {
        async send({ html }) {
          emails.push(html ?? '');
          return { messageId: 'local-email' };
        },
      },
    };
  });

  afterEach(() => harness.sqlite.close());

  function post(path: string, body: object, token?: string) {
    return app.request(`/api/auth${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    }, env);
  }

  function register(phone?: string, email = 'traveler@example.test') {
    return post('/register', { email, phone, password, userType: 'customer' });
  }

  it.each<[string | undefined, string | RegExp]>([
    ['+44 (0)20 7946 0958', '+442079460958'],
    ['+91 98765 43210', '+919876543210'],
    ['+1 (202) 555-0108', '+12025550108'],
    ['+39 02 3661 8300', '+390236618300'],
    ['081-234-5678', '+66812345678'],
    ['66 81 234 5678', '+66812345678'],
    ['+66 (0)81 234 5678', '+66812345678'],
    [undefined, /^\+669\d{8}$/],
  ])('stores %s as a canonical phone number', async (input, canonical) => {
    const result = await register(input);
    expect(result.status).toBe(201);
    const { data } = await result.json();
    if (typeof canonical === 'string') expect(data.user.phone).toBe(canonical);
    else expect(data.user.phone).toMatch(canonical);
    expect(harness.sqlite.prepare('SELECT phone FROM users').get()).toEqual({ phone: data.user.phone });
    expect(data.user).toMatchObject({ emailVerified: false, phoneVerified: false });
    expect(data.emailVerification.deliveryStatus).toBe('sent');
    expect(emails).toHaveLength(1);
  });

  it('rejects malformed numbers with guidance and never creates an account', async () => {
    for (const phone of ['44 20 7946 0958', '+44 20', '+999 123456789', '+1 +202 555 0108', '+0812345678', '+44 20 7946 0958 ext 1']) {
      const result = await register(phone);
      expect(result.status).toBe(400);
      expect(await result.json()).toMatchObject({
        success: false,
        error: 'Invalid phone format',
        message: expect.stringContaining('include + and the country code'),
      });
    }
    expect(harness.sqlite.prepare('SELECT COUNT(*) AS count FROM users').get()).toEqual({ count: 0 });
    expect(emails).toHaveLength(0);
  });

  it('returns a conflict for equivalent numbers during and after simultaneous signup', async () => {
    const prepare = vi.spyOn(harness.db, 'prepare');
    const results = await Promise.all([
      register('+44 (0)20 7946 0958', 'first@example.test'),
      register('+442079460958', 'second@example.test'),
    ]);

    expect(results.map(({ status }) => status).sort()).toEqual([201, 409]);
    expect(prepare.mock.calls.filter(([sql]) => sql.includes('INSERT INTO users'))).toHaveLength(2);
    const conflict = results.find(({ status }) => status === 409);
    expect(await conflict?.json()).toMatchObject({ success: false, error: 'User already exists' });
    expect((await register('+44 20 7946-0958')).status).toBe(409);
    expect(harness.sqlite.prepare('SELECT phone FROM users').all()).toEqual([{ phone: '+442079460958' }]);
    expect(emails).toHaveLength(1);
  });

  it('redeems the emailed code once and signs in with email and password', async () => {
    const result = await register('+44 20 7946 0958');
    expect(result.status).toBe(201);
    const { data: { accessToken } } = await result.json();
    const code = emails[0]?.match(/code is (\d{6})/)?.[1];
    expect(code).toBeTruthy();

    const verified = await post('/verify-email', { code }, accessToken);
    expect(verified.status).toBe(200);
    expect(await verified.json()).toMatchObject({ data: { emailVerified: true } });
    expect((await post('/verify-email', { code }, accessToken)).status).toBe(400);

    const login = await post('/login', { email: 'traveler@example.test', password });
    expect(login.status).toBe(200);
    expect(await login.json()).toMatchObject({ data: { user: { emailVerified: true, phoneVerified: false } } });
  });
});
