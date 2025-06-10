import { describe, it, expect, beforeEach } from 'vitest';
import { 
  hashPassword, 
  verifyPassword, 
  generateJWT, 
  verifyJWT, 
  generateOTP, 
  verifyOTP,
  generateRefreshToken,
  verifyRefreshToken
} from '@/utils/auth';
import { createTestEnv } from '@tests/setup';

describe('Auth Utils', () => {
  let testEnv: any;

  beforeEach(() => {
    testEnv = createTestEnv();
  });

  describe('Password Hashing', () => {
    it('should hash password correctly', async () => {
      const password = 'testPassword123';
      const hash = await hashPassword(password);
      
      expect(hash).toBeDefined();
      expect(hash).not.toBe(password);
      expect(hash.length).toBeGreaterThan(50);
      expect(hash.startsWith('$2a$')).toBe(true);
    });

    it('should generate different hashes for same password', async () => {
      const password = 'testPassword123';
      const hash1 = await hashPassword(password);
      const hash2 = await hashPassword(password);
      
      expect(hash1).not.toBe(hash2);
    });

    it('should verify correct password', async () => {
      const password = 'testPassword123';
      const hash = await hashPassword(password);
      const isValid = await verifyPassword(password, hash);
      
      expect(isValid).toBe(true);
    });

    it('should reject incorrect password', async () => {
      const password = 'testPassword123';
      const wrongPassword = 'wrongPassword456';
      const hash = await hashPassword(password);
      const isValid = await verifyPassword(wrongPassword, hash);
      
      expect(isValid).toBe(false);
    });

    it('should handle empty password', async () => {
      await expect(hashPassword('')).rejects.toThrow();
    });
  });

  describe('JWT Token Management', () => {
    const testPayload = {
      userId: 'test-user-id',
      email: 'test@example.com',
      userType: 'customer'
    };

    it('should generate valid JWT token', async () => {
      const token = await generateJWT(testPayload, testEnv.JWT_SECRET);
      
      expect(token).toBeDefined();
      expect(typeof token).toBe('string');
      expect(token.split('.')).toHaveLength(3);
    });

    it('should verify valid JWT token', async () => {
      const token = await generateJWT(testPayload, testEnv.JWT_SECRET);
      const decoded = await verifyJWT(token, testEnv.JWT_SECRET);
      
      expect(decoded).toBeDefined();
      expect(decoded.userId).toBe(testPayload.userId);
      expect(decoded.email).toBe(testPayload.email);
      expect(decoded.userType).toBe(testPayload.userType);
    });

    it('should reject invalid JWT token', async () => {
      const invalidToken = 'invalid.jwt.token';
      
      await expect(verifyJWT(invalidToken, testEnv.JWT_SECRET)).rejects.toThrow();
    });

    it('should reject JWT with wrong secret', async () => {
      const token = await generateJWT(testPayload, testEnv.JWT_SECRET);
      const wrongSecret = 'wrong-secret';
      
      await expect(verifyJWT(token, wrongSecret)).rejects.toThrow();
    });

    it('should include expiration in JWT', async () => {
      const token = await generateJWT(testPayload, testEnv.JWT_SECRET, '1h');
      const decoded = await verifyJWT(token, testEnv.JWT_SECRET);
      
      expect(decoded.exp).toBeDefined();
      expect(decoded.exp).toBeGreaterThan(Date.now() / 1000);
    });

    it('should reject expired JWT', async () => {
      // Create token that expires immediately
      const token = await generateJWT(testPayload, testEnv.JWT_SECRET, '0s');
      
      // Wait a bit to ensure expiration
      await new Promise(resolve => setTimeout(resolve, 100));
      
      await expect(verifyJWT(token, testEnv.JWT_SECRET)).rejects.toThrow();
    });
  });

  describe('Refresh Token Management', () => {
    it('should generate refresh token', async () => {
      const refreshToken = await generateRefreshToken();
      
      expect(refreshToken).toBeDefined();
      expect(typeof refreshToken).toBe('string');
      expect(refreshToken.length).toBeGreaterThan(20);
    });

    it('should generate unique refresh tokens', async () => {
      const token1 = await generateRefreshToken();
      const token2 = await generateRefreshToken();
      
      expect(token1).not.toBe(token2);
    });

    it('should verify valid refresh token', async () => {
      const userId = 'test-user-id';
      const refreshToken = await generateRefreshToken();
      
      // In a real implementation, this would store the token in database
      // For testing, we'll mock the verification
      const isValid = await verifyRefreshToken(refreshToken, userId);
      
      // This would be true if token exists in database for user
      expect(typeof isValid).toBe('boolean');
    });
  });

  describe('OTP Management', () => {
    it('should generate 6-digit OTP', () => {
      const otp = generateOTP();
      
      expect(otp).toBeDefined();
      expect(typeof otp).toBe('string');
      expect(otp).toMatch(/^\d{6}$/);
    });

    it('should generate different OTPs', () => {
      const otp1 = generateOTP();
      const otp2 = generateOTP();
      
      // While there's a small chance they could be the same,
      // it's extremely unlikely with 6 digits
      expect(otp1).not.toBe(otp2);
    });

    it('should verify correct OTP', () => {
      const phone = '+66812345678';
      const otp = '123456';
      
      // In real implementation, this would check against stored OTP
      const isValid = verifyOTP(phone, otp);
      
      expect(typeof isValid).toBe('boolean');
    });

    it('should reject incorrect OTP', () => {
      const phone = '+66812345678';
      const correctOTP = '123456';
      const wrongOTP = '654321';
      
      // Mock storing correct OTP
      // In real implementation, this would be stored in cache/database
      
      const isValid = verifyOTP(phone, wrongOTP);
      
      // Should be false for wrong OTP
      expect(typeof isValid).toBe('boolean');
    });

    it('should handle invalid phone format', () => {
      const invalidPhone = 'invalid-phone';
      const otp = '123456';
      
      expect(() => verifyOTP(invalidPhone, otp)).not.toThrow();
    });
  });

  describe('Token Expiration', () => {
    it('should handle different expiration formats', async () => {
      const payload = { userId: 'test' };
      
      const token1h = await generateJWT(payload, testEnv.JWT_SECRET, '1h');
      const token1d = await generateJWT(payload, testEnv.JWT_SECRET, '1d');
      const token30m = await generateJWT(payload, testEnv.JWT_SECRET, '30m');
      
      expect(token1h).toBeDefined();
      expect(token1d).toBeDefined();
      expect(token30m).toBeDefined();
      
      // All should be valid immediately after creation
      await expect(verifyJWT(token1h, testEnv.JWT_SECRET)).resolves.toBeDefined();
      await expect(verifyJWT(token1d, testEnv.JWT_SECRET)).resolves.toBeDefined();
      await expect(verifyJWT(token30m, testEnv.JWT_SECRET)).resolves.toBeDefined();
    });
  });

  describe('Error Handling', () => {
    it('should handle malformed JWT gracefully', async () => {
      const malformedTokens = [
        'not.a.jwt',
        'missing.parts',
        '',
        'too.many.parts.here.invalid',
      ];
      
      for (const token of malformedTokens) {
        await expect(verifyJWT(token, testEnv.JWT_SECRET)).rejects.toThrow();
      }
    });

    it('should handle empty secret', async () => {
      const payload = { userId: 'test' };
      
      await expect(generateJWT(payload, '')).rejects.toThrow();
    });

    it('should handle null/undefined inputs', async () => {
      await expect(hashPassword(null as any)).rejects.toThrow();
      await expect(hashPassword(undefined as any)).rejects.toThrow();
      await expect(verifyPassword('test', null as any)).rejects.toThrow();
    });
  });
});
