import { describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { authRoutes } from '@/routes/auth';
import { createTestEnv, createMockRequest, createTestUser } from '@tests/setup';

describe('Auth Routes', () => {
  let app: Hono;
  let testEnv: any;

  beforeEach(() => {
    app = new Hono();
    testEnv = createTestEnv();
    app.route('/auth', authRoutes);
  });

  describe('POST /auth/register', () => {
    it('should register a new user successfully', async () => {
      const userData = {
        email: 'newuser@example.com',
        password: 'SecurePass123!',
        phone: '+66812345678',
        userType: 'customer',
        firstName: 'John',
        lastName: 'Doe'
      };

      const request = createMockRequest('http://localhost/auth/register', {
        method: 'POST',
        body: JSON.stringify(userData),
        headers: { 'Content-Type': 'application/json' }
      });

      // Mock successful database operations
      testEnv.DB.prepare = () => ({
        bind: () => ({
          run: async () => ({ success: true, meta: { changes: 1 } }),
          first: async () => null // No existing user
        })
      });

      const response = await app.request(request, testEnv);
      const data = await response.json();

      expect(response.status).toBe(201);
      expect(data.success).toBe(true);
      expect(data.data.user.email).toBe(userData.email);
      expect(data.data.accessToken).toBeDefined();
      expect(data.data.refreshToken).toBeDefined();
    });

    it('should reject registration with existing email', async () => {
      const userData = {
        email: 'existing@example.com',
        password: 'SecurePass123!',
        phone: '+66812345678',
        userType: 'customer'
      };

      const request = createMockRequest('http://localhost/auth/register', {
        method: 'POST',
        body: JSON.stringify(userData),
        headers: { 'Content-Type': 'application/json' }
      });

      // Mock existing user
      testEnv.DB.prepare = () => ({
        bind: () => ({
          first: async () => ({ id: 'existing-user-id', email: userData.email })
        })
      });

      const response = await app.request(request, testEnv);
      const data = await response.json();

      expect(response.status).toBe(409);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('EMAIL_EXISTS');
    });

    it('should reject registration with invalid data', async () => {
      const invalidData = {
        email: 'invalid-email',
        password: '123', // Too weak
        userType: 'invalid-type'
      };

      const request = createMockRequest('http://localhost/auth/register', {
        method: 'POST',
        body: JSON.stringify(invalidData),
        headers: { 'Content-Type': 'application/json' }
      });

      const response = await app.request(request, testEnv);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('VALIDATION_ERROR');
    });

    it('should handle missing required fields', async () => {
      const incompleteData = {
        email: 'test@example.com'
        // Missing password and userType
      };

      const request = createMockRequest('http://localhost/auth/register', {
        method: 'POST',
        body: JSON.stringify(incompleteData),
        headers: { 'Content-Type': 'application/json' }
      });

      const response = await app.request(request, testEnv);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.error.details).toBeDefined();
    });
  });

  describe('POST /auth/login', () => {
    it('should login with valid email and password', async () => {
      const loginData = {
        email: 'test@example.com',
        password: 'SecurePass123!'
      };

      const request = createMockRequest('http://localhost/auth/login', {
        method: 'POST',
        body: JSON.stringify(loginData),
        headers: { 'Content-Type': 'application/json' }
      });

      // Mock user exists with correct password
      const mockUser = createTestUser({
        email: loginData.email,
        password_hash: '$2a$10$test.hash.for.testing.only' // Mock bcrypt hash
      });

      testEnv.DB.prepare = () => ({
        bind: () => ({
          first: async () => mockUser
        })
      });

      const response = await app.request(request, testEnv);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.data.user.email).toBe(loginData.email);
      expect(data.data.accessToken).toBeDefined();
      expect(data.data.refreshToken).toBeDefined();
    });

    it('should login with valid phone and password', async () => {
      const loginData = {
        phone: '+66812345678',
        password: 'SecurePass123!'
      };

      const request = createMockRequest('http://localhost/auth/login', {
        method: 'POST',
        body: JSON.stringify(loginData),
        headers: { 'Content-Type': 'application/json' }
      });

      const mockUser = createTestUser({
        phone: loginData.phone,
        password_hash: '$2a$10$test.hash.for.testing.only'
      });

      testEnv.DB.prepare = () => ({
        bind: () => ({
          first: async () => mockUser
        })
      });

      const response = await app.request(request, testEnv);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.data.user.phone).toBe(loginData.phone);
    });

    it('should reject login with invalid credentials', async () => {
      const loginData = {
        email: 'test@example.com',
        password: 'WrongPassword123!'
      };

      const request = createMockRequest('http://localhost/auth/login', {
        method: 'POST',
        body: JSON.stringify(loginData),
        headers: { 'Content-Type': 'application/json' }
      });

      // Mock user exists but password doesn't match
      testEnv.DB.prepare = () => ({
        bind: () => ({
          first: async () => null // No user found or password mismatch
        })
      });

      const response = await app.request(request, testEnv);
      const data = await response.json();

      expect(response.status).toBe(401);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('INVALID_CREDENTIALS');
    });

    it('should reject login with non-existent user', async () => {
      const loginData = {
        email: 'nonexistent@example.com',
        password: 'SecurePass123!'
      };

      const request = createMockRequest('http://localhost/auth/login', {
        method: 'POST',
        body: JSON.stringify(loginData),
        headers: { 'Content-Type': 'application/json' }
      });

      testEnv.DB.prepare = () => ({
        bind: () => ({
          first: async () => null
        })
      });

      const response = await app.request(request, testEnv);
      const data = await response.json();

      expect(response.status).toBe(401);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('INVALID_CREDENTIALS');
    });
  });

  describe('POST /auth/refresh', () => {
    it('should refresh token with valid refresh token', async () => {
      const refreshData = {
        refreshToken: 'valid-refresh-token'
      };

      const request = createMockRequest('http://localhost/auth/refresh', {
        method: 'POST',
        body: JSON.stringify(refreshData),
        headers: { 'Content-Type': 'application/json' }
      });

      // Mock valid refresh token
      testEnv.DB.prepare = () => ({
        bind: () => ({
          first: async () => ({
            id: 'test-user-id',
            refresh_token: refreshData.refreshToken,
            expires_at: new Date(Date.now() + 86400000).toISOString() // Valid
          })
        })
      });

      const response = await app.request(request, testEnv);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.data.accessToken).toBeDefined();
      expect(data.data.refreshToken).toBeDefined();
    });

    it('should reject expired refresh token', async () => {
      const refreshData = {
        refreshToken: 'expired-refresh-token'
      };

      const request = createMockRequest('http://localhost/auth/refresh', {
        method: 'POST',
        body: JSON.stringify(refreshData),
        headers: { 'Content-Type': 'application/json' }
      });

      // Mock expired refresh token
      testEnv.DB.prepare = () => ({
        bind: () => ({
          first: async () => ({
            id: 'test-user-id',
            refresh_token: refreshData.refreshToken,
            expires_at: new Date(Date.now() - 86400000).toISOString() // Expired
          })
        })
      });

      const response = await app.request(request, testEnv);
      const data = await response.json();

      expect(response.status).toBe(401);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('INVALID_REFRESH_TOKEN');
    });

    it('should reject invalid refresh token', async () => {
      const refreshData = {
        refreshToken: 'invalid-refresh-token'
      };

      const request = createMockRequest('http://localhost/auth/refresh', {
        method: 'POST',
        body: JSON.stringify(refreshData),
        headers: { 'Content-Type': 'application/json' }
      });

      testEnv.DB.prepare = () => ({
        bind: () => ({
          first: async () => null // Token not found
        })
      });

      const response = await app.request(request, testEnv);
      const data = await response.json();

      expect(response.status).toBe(401);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('INVALID_REFRESH_TOKEN');
    });
  });

  describe('POST /auth/logout', () => {
    it('should logout successfully with valid token', async () => {
      const request = createMockRequest('http://localhost/auth/logout', {
        method: 'POST',
        headers: { 
          'Authorization': 'Bearer valid-jwt-token',
          'Content-Type': 'application/json'
        }
      });

      // Mock successful token invalidation
      testEnv.DB.prepare = () => ({
        bind: () => ({
          run: async () => ({ success: true, meta: { changes: 1 } })
        })
      });

      const response = await app.request(request, testEnv);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.message).toContain('logged out');
    });

    it('should handle logout without token', async () => {
      const request = createMockRequest('http://localhost/auth/logout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });

      const response = await app.request(request, testEnv);
      const data = await response.json();

      expect(response.status).toBe(401);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('UNAUTHORIZED');
    });
  });

  describe('POST /auth/send-otp', () => {
    it('should send OTP to valid phone number', async () => {
      const otpData = {
        phone: '+66812345678'
      };

      const request = createMockRequest('http://localhost/auth/send-otp', {
        method: 'POST',
        body: JSON.stringify(otpData),
        headers: { 'Content-Type': 'application/json' }
      });

      const response = await app.request(request, testEnv);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.message).toContain('OTP sent');
    });

    it('should reject invalid phone number', async () => {
      const otpData = {
        phone: 'invalid-phone'
      };

      const request = createMockRequest('http://localhost/auth/send-otp', {
        method: 'POST',
        body: JSON.stringify(otpData),
        headers: { 'Content-Type': 'application/json' }
      });

      const response = await app.request(request, testEnv);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('POST /auth/verify-otp', () => {
    it('should verify correct OTP', async () => {
      const verifyData = {
        phone: '+66812345678',
        otp: '123456'
      };

      const request = createMockRequest('http://localhost/auth/verify-otp', {
        method: 'POST',
        body: JSON.stringify(verifyData),
        headers: { 'Content-Type': 'application/json' }
      });

      // Mock valid OTP
      testEnv.CACHE.get = async () => '123456'; // Stored OTP

      const response = await app.request(request, testEnv);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.message).toContain('verified');
    });

    it('should reject incorrect OTP', async () => {
      const verifyData = {
        phone: '+66812345678',
        otp: '654321'
      };

      const request = createMockRequest('http://localhost/auth/verify-otp', {
        method: 'POST',
        body: JSON.stringify(verifyData),
        headers: { 'Content-Type': 'application/json' }
      });

      // Mock different stored OTP
      testEnv.CACHE.get = async () => '123456';

      const response = await app.request(request, testEnv);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('INVALID_OTP');
    });

    it('should reject expired OTP', async () => {
      const verifyData = {
        phone: '+66812345678',
        otp: '123456'
      };

      const request = createMockRequest('http://localhost/auth/verify-otp', {
        method: 'POST',
        body: JSON.stringify(verifyData),
        headers: { 'Content-Type': 'application/json' }
      });

      // Mock no stored OTP (expired)
      testEnv.CACHE.get = async () => null;

      const response = await app.request(request, testEnv);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('OTP_EXPIRED');
    });
  });
});
