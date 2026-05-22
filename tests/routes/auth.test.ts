import { describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { authRoutes } from '@/routes/auth';
import { hashPassword } from '@/utils/auth';
import { createMockRequest, createTestEnv, createTestUser } from '@tests/setup';

describe('Auth Routes', () => {
  let app: Hono;
  let testEnv: any;

  beforeEach(() => {
    app = new Hono();
    testEnv = createTestEnv();
    app.route('/auth', authRoutes);
  });

  const statement = (overrides: Record<string, unknown> = {}) => ({
    bind: () => ({
      run: async () => ({ success: true, meta: { changes: 1 } }),
      first: async () => null,
      all: async () => ({ results: [] }),
      ...overrides,
    }),
  });

  it('registers a new customer and returns tokens', async () => {
    testEnv.DB.prepare = () => statement();

    const request = createMockRequest('http://localhost/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        email: 'newuser@example.com',
        password: 'SecurePass123!',
        phone: '+66812345678',
        userType: 'customer',
        firstName: 'John',
        lastName: 'Doe',
      }),
      headers: { 'Content-Type': 'application/json' },
    });

    const response = await app.request(request, undefined, testEnv);
    const data = await response.json();

    expect(response.status).toBe(201);
    expect(data.success).toBe(true);
    expect(data.data.user.email).toBe('newuser@example.com');
    expect(data.data.accessToken).toBeDefined();
    expect(data.data.refreshToken).toBeDefined();
  });

  it('rejects duplicate registration with the current flat error contract', async () => {
    const existingUser = createTestUser({ email: 'existing@example.com' });
    testEnv.DB.prepare = () => statement({
      first: async () => existingUser,
    });

    const request = createMockRequest('http://localhost/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        email: 'existing@example.com',
        password: 'SecurePass123!',
        phone: '+66812345678',
        userType: 'customer',
      }),
      headers: { 'Content-Type': 'application/json' },
    });

    const response = await app.request(request, undefined, testEnv);
    const data = await response.json();

    expect(response.status).toBe(409);
    expect(data.success).toBe(false);
    expect(data.error).toBe('User already exists');
  });

  it('logs in with email or phone identifier and returns profile metadata', async () => {
    const passwordHash = await hashPassword('SecurePass123!');
    const testUser = createTestUser({
      email: 'test@example.com',
      password_hash: passwordHash,
    });

    testEnv.DB.prepare = (query: string) => {
      if (query.includes('COALESCE(cp.display_name')) {
        return statement({ first: async () => ({ display_name: 'Test Customer' }) });
      }

      return statement({ first: async () => testUser });
    };

    const request = createMockRequest('http://localhost/auth/login', {
      method: 'POST',
      body: JSON.stringify({
        email: 'test@example.com',
        password: 'SecurePass123!',
      }),
      headers: { 'Content-Type': 'application/json' },
    });

    const response = await app.request(request, undefined, testEnv);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.success).toBe(true);
    expect(data.data.user.email).toBe('test@example.com');
    expect(data.data.user.displayName).toBe('Test Customer');
    expect(data.data.accessToken).toBeDefined();
  });

  it('rejects invalid login credentials', async () => {
    testEnv.DB.prepare = () => statement({ first: async () => null });

    const request = createMockRequest('http://localhost/auth/login', {
      method: 'POST',
      body: JSON.stringify({
        identifier: 'missing@example.com',
        password: 'WrongPassword123!',
      }),
      headers: { 'Content-Type': 'application/json' },
    });

    const response = await app.request(request, undefined, testEnv);
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.success).toBe(false);
    expect(data.error).toBe('Invalid credentials');
  });

  it('keeps password reset private for unknown accounts', async () => {
    testEnv.DB.prepare = () => statement({ first: async () => null });

    const request = createMockRequest('http://localhost/auth/forgot-password', {
      method: 'POST',
      body: JSON.stringify({ identifier: 'unknown@example.com' }),
      headers: { 'Content-Type': 'application/json' },
    });

    const response = await app.request(request, undefined, testEnv);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.success).toBe(true);
    expect(data.data.sent).toBe(true);
  });

  it('logs out idempotently', async () => {
    const request = createMockRequest('http://localhost/auth/logout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });

    const response = await app.request(request, undefined, testEnv);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.success).toBe(true);
    expect(data.data.loggedOut).toBe(true);
  });
});
