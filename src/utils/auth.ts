import * as bcrypt from 'bcryptjs';
import * as jwt from 'jsonwebtoken';
import type { JWTPayload, TokenPair } from '../types/auth';
import type { User } from '../types/database';

/**
 * Hash a password using bcrypt
 */
export async function hashPassword(password: string): Promise<string> {
  const saltRounds = 12;
  return await bcrypt.hash(password, saltRounds);
}

/**
 * Verify a password against its hash
 */
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return await bcrypt.compare(password, hash);
}

/**
 * Generate JWT access and refresh tokens
 */
export async function generateTokens(user: any, jwtSecret: string): Promise<TokenPair> {
  const payload: JWTPayload = {
    sub: user.id,
    email: user.email,
    userType: user.userType,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + (60 * 60 * 24), // 24 hours (increased from 1 hour)
  };

  const refreshPayload = {
    sub: user.id,
    tokenId: crypto.randomUUID(),
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + (60 * 60 * 24 * 30), // 30 days (increased from 7 days)
  };

  const accessToken = jwt.sign(payload, jwtSecret);
  const refreshToken = jwt.sign(refreshPayload, jwtSecret);

  return {
    accessToken,
    refreshToken,
    expiresIn: 86400, // 24 hours in seconds (increased from 3600)
  };
}

/**
 * Verify and decode a JWT token
 */
export async function verifyJWT(token: string, jwtSecret: string): Promise<JWTPayload> {
  try {
    const decoded = jwt.verify(token, jwtSecret) as JWTPayload;
    return decoded;
  } catch (error) {
    throw new Error('Invalid token');
  }
}

/**
 * Generate a 6-digit OTP code
 */
export function generateOTP(): string {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

/**
 * Generate a secure random token for password reset
 */
export function generateResetToken(): string {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return Array.from(array, byte => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Validate email format
 */
export function isValidEmail(email: string): boolean {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

/**
 * Validate phone number format (Thai format)
 */
export function isValidPhone(phone: string): boolean {
  // Thai phone number format: +66XXXXXXXXX or 0XXXXXXXXX
  const phoneRegex = /^(\+66|0)[0-9]{8,9}$/;
  return phoneRegex.test(phone);
}

/**
 * Normalize phone number to international format
 */
export function normalizePhone(phone: string): string {
  // Remove all non-digit characters
  const digits = phone.replace(/\D/g, '');
  
  // Convert Thai format to international
  if (digits.startsWith('0')) {
    return '+66' + digits.substring(1);
  } else if (digits.startsWith('66')) {
    return '+' + digits;
  } else if (digits.startsWith('+66')) {
    return digits;
  }
  
  return phone; // Return as-is if format not recognized
}

/**
 * Validate password strength
 */
export function validatePasswordStrength(password: string): { isValid: boolean; errors: string[] } {
  const errors: string[] = [];
  
  if (password.length < 8) {
    errors.push('Password must be at least 8 characters long');
  }
  
  if (!/[A-Z]/.test(password)) {
    errors.push('Password must contain at least one uppercase letter');
  }
  
  if (!/[a-z]/.test(password)) {
    errors.push('Password must contain at least one lowercase letter');
  }
  
  if (!/[0-9]/.test(password)) {
    errors.push('Password must contain at least one number');
  }
  
  if (!/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(password)) {
    errors.push('Password must contain at least one special character');
  }
  
  return {
    isValid: errors.length === 0,
    errors
  };
}

/**
 * Generate a secure session ID
 */
export function generateSessionId(): string {
  const array = new Uint8Array(16);
  crypto.getRandomValues(array);
  return Array.from(array, byte => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Check if a user has permission for a specific action
 */
export function hasPermission(userType: string, resource: string, action: string): boolean {
  // Admin has all permissions
  if (userType === 'admin') {
    return true;
  }
  
  // Define permission matrix
  const permissions: Record<string, Record<string, string[]>> = {
    customer: {
      profile: ['read', 'update'],
      suppliers: ['search', 'view'],
      chat: ['create', 'participate'],
      bookings: ['create', 'view'],
      reviews: ['create'],
    },
    supplier: {
      profile: ['read', 'update'],
      services: ['create', 'update', 'delete'],
      chat: ['participate'],
      bookings: ['view', 'update'],
      availability: ['manage'],
    }
  };
  
  const userPermissions = permissions[userType];
  if (!userPermissions) return false;
  
  const resourcePermissions = userPermissions[resource];
  if (!resourcePermissions) return false;
  
  return resourcePermissions.includes(action);
}

/**
 * Extract user ID from JWT token without verification (for logging)
 */
export function extractUserIdFromToken(token: string): string | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    
    const payload = JSON.parse(atob(parts[1] || ''));
    return payload.sub || null;
  } catch {
    return null;
  }
}

/**
 * Check if token is expired
 */
export function isTokenExpired(token: string): boolean {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return true;
    
    const payload = JSON.parse(atob(parts[1] || ''));
    const exp = payload.exp;
    
    if (!exp) return true;
    
    return Date.now() >= exp * 1000;
  } catch {
    return true;
  }
}

/**
 * Generate API key for external integrations
 */
export function generateApiKey(): string {
  const prefix = 'tk_';
  const array = new Uint8Array(24);
  crypto.getRandomValues(array);
  const key = Array.from(array, byte => byte.toString(16).padStart(2, '0')).join('');
  return prefix + key;
}
