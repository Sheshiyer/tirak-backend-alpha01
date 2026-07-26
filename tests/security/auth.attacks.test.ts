import { beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { bookingRoutes } from '@/routes/bookings';
import { generateJWT } from '@/utils/auth';
import { createMockRequest, createTestEnv, createTestUser } from '@tests/setup';

/**
 * T-062 adversarial suite — authentication attacks.
 *
 * Every protected surface funnels through src/middleware/auth.ts; the bookings
 * list endpoint is used here as the representative protected surface. Each
 * attack must fail closed with 401 and must never reach the route handler.
 */
describe('T-062 adversarial: authentication attacks', () => {
  let app: Hono;
  let env: any;
  const user = createTestUser({ id: 'victim-user-id', userType: 'customer' });

  const usersStatement = (row: any) => ({
    bind: () => ({
      run: async () => ({ success: true, meta: { changes: 1 } }),
      first: async () => row,
      all: async () => ({ results: [] }),
    }),
  });

  const installUsers = (row: any) => {
    env.DB.prepare = (query: string) => {
      if (query.includes('FROM users WHERE id')) return usersStatement(row);
      return usersStatement(null);
    };
  };

  const listBookings = (headers: Record<string, string> = {}) =>
    app.request(createMockRequest('http://localhost/bookings', { method: 'GET', headers }), undefined, env);

  beforeEach(() => {
    app = new Hono();
    env = createTestEnv();
    app.route('/bookings', bookingRoutes);
  });

  it('rejects a request with no token at all', async () => {
    installUsers(user);
    const response = await listBookings();
    const data = await response.json();
    expect(response.status).toBe(401);
    expect(data.success).toBe(false);
  });

  it('rejects a malformed bearer token', async () => {
    installUsers(user);
    const response = await listBookings({ Authorization: 'Bearer not-a-jwt' });
    expect(response.status).toBe(401);
  });

  it('rejects a token signed with the wrong secret', async () => {
    installUsers(user);
    const forged = await generateJWT(
      { sub: user.id, email: user.email, userType: user.userType },
      'attacker-controlled-secret',
    );
    const response = await listBookings({ Authorization: `Bearer ${forged}` });
    expect(response.status).toBe(401);
  });

  it('rejects an expired token', async () => {
    installUsers(user);
    const expired = await generateJWT(
      { sub: user.id, email: user.email, userType: user.userType },
      env.JWT_SECRET,
      -60,
    );
    const response = await listBookings({ Authorization: `Bearer ${expired}` });
    expect(response.status).toBe(401);
  });

  it('rejects a token with a tampered payload segment', async () => {
    installUsers(user);
    const genuine = await generateJWT(
      { sub: user.id, email: user.email, userType: user.userType },
      env.JWT_SECRET,
    );
    const [header, , signature] = genuine.split('.');
    const forgedPayload = Buffer.from(
      JSON.stringify({ sub: 'admin-user-id', email: 'admin@tirak.local', userType: 'admin' }),
    ).toString('base64url');
    const tampered = `${header}.${forgedPayload}.${signature}`;
    const response = await listBookings({ Authorization: `Bearer ${tampered}` });
    expect(response.status).toBe(401);
  });

  it('rejects a valid token whose user no longer exists', async () => {
    installUsers(null);
    const token = await generateJWT(
      { sub: 'deleted-user-id', email: 'ghost@example.com', userType: 'customer' },
      env.JWT_SECRET,
    );
    const response = await listBookings({ Authorization: `Bearer ${token}` });
    const data = await response.json();
    expect(response.status).toBe(401);
    expect(data.error).toBe('User not found');
  });

  it('rejects a valid token whose account is not active', async () => {
    installUsers({ ...user, status: 'suspended' });
    const token = await generateJWT(
      { sub: user.id, email: user.email, userType: user.userType },
      env.JWT_SECRET,
    );
    const response = await listBookings({ Authorization: `Bearer ${token}` });
    const data = await response.json();
    expect(response.status).toBe(401);
    expect(data.error).toBe('Account is not active');
  });

  it('control: a valid token for an active user reaches the handler', async () => {
    installUsers(user);
    const token = await generateJWT(
      { sub: user.id, email: user.email, userType: user.userType },
      env.JWT_SECRET,
    );
    const response = await listBookings({ Authorization: `Bearer ${token}` });
    expect(response.status).not.toBe(401);
    expect(response.status).toBe(200);
  });

  it('control: a valid cookie token for an active user reaches the handler', async () => {
    installUsers(user);
    const token = await generateJWT(
      { sub: user.id, email: user.email, userType: user.userType },
      env.JWT_SECRET,
    );
    const response = await listBookings({ Cookie: `auth-token=${token}` });
    expect(response.status).toBe(200);
  });
});
