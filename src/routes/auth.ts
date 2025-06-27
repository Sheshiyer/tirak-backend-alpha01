import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import {
  registerSchema,
  loginSchema,
  phoneVerificationSchema,
  passwordResetRequestSchema,
  passwordResetSchema
} from '../utils/validation';
import {
  hashPassword,
  verifyPassword,
  generateTokens,
  normalizePhone,
  isValidEmail,
  isValidPhone
} from '../utils/auth';
import {
  generateOTP,
  createOTPData,
  isOTPValid,
  sendOTPSMS,
  sendOTPEmail,
  createSMSConfig,
  createEmailConfig
} from '../utils/communication';
import {
  createUser,
  getUserByEmail,
  getUserByPhone,
  getUserById,
  createSupplierProfile,
  createCustomerProfile
} from '../utils/database';
import { jsonSuccess, jsonError } from '../utils/response';
import { createRateLimit } from '../middleware/rateLimit';
import type { Env, Variables } from '../index';

const auth = new Hono<{ Bindings: Env; Variables: Variables }>();

// Apply rate limiting to auth endpoints
auth.use('*', createRateLimit('auth'));

/**
 * User registration endpoint
 */
auth.post('/register', zValidator('json', registerSchema), async (c) => {
  const { email, phone, password, userType, preferredLanguage } = c.req.valid('json');
  
  try {
    // Normalize and validate inputs
    const normalizedEmail = email.toLowerCase().trim();
    const normalizedPhone = normalizePhone(phone);
    
    if (!isValidEmail(normalizedEmail)) {
      return jsonError(c, 'Invalid email format', 'Please provide a valid email address', 400);
    }
    
    if (!isValidPhone(normalizedPhone)) {
      return jsonError(c, 'Invalid phone format', 'Please provide a valid phone number', 400);
    }
    
    // Check if user already exists
    const existingUser = await getUserByEmail(normalizedEmail, c.env.DB) || 
                        await getUserByPhone(normalizedPhone, c.env.DB);
    
    if (existingUser) {
      return jsonError(c, 'User already exists', 'An account with this email or phone already exists', 409);
    }

    // Hash password
    const passwordHash = await hashPassword(password);
    const userId = crypto.randomUUID();
    
    // Create user with active status (auto-verify all users)
    const initialStatus = 'active'; // All users start as active
    const user = await createUser({
      id: userId,
      email: normalizedEmail,
      phone: normalizedPhone,
      passwordHash,
      userType,
      preferredLanguage,
      status: initialStatus,
      phoneVerified: true // Auto-verify all users
    }, c.env.DB);

    // Create user profile based on type
    if (userType === 'supplier') {
      await createSupplierProfile({
        userId,
        displayName: normalizedEmail.split('@')[0] || 'User', // Default display name
      }, c.env.DB);
    } else if (userType === 'customer') {
      await createCustomerProfile({
        userId,
        displayName: normalizedEmail.split('@')[0] || 'User', // Default display name
      }, c.env.DB);
    } else if (userType === 'companion') {
      // For companions, create a customer profile for now as a base
      await createCustomerProfile({
        userId,
        displayName: normalizedEmail.split('@')[0] || 'Companion', // Default companion display name
      }, c.env.DB);
    }
    
    // Admin users don't need specific profiles
    
    // Generate tokens
    const tokens = await generateTokens(user, c.env.JWT_SECRET);

    // Comment out analytics queue since it's not available on the free plan
    /*
    await c.env.ANALYTICS_QUEUE.send({
      eventType: 'user_registration',
      userId: user.id,
      properties: { 
        userType: user.userType,
        preferredLanguage: user.preferredLanguage 
      },
      timestamp: new Date().toISOString()
    });
    */

    return jsonSuccess(c, {
      user: {
        id: user.id,
        email: user.email,
        phone: user.phone,
        userType: user.userType,
        status: user.status,
        emailVerified: user.emailVerified,
        phoneVerified: user.phoneVerified
      },
      ...tokens
    }, 'Registration successful.', 201);

  } catch (error) {
    console.error('Registration error:', error);
    return jsonError(c, 'Registration failed', 'An error occurred during registration', 500);
  }
});

/**
 * User login endpoint
 */
auth.post('/login', zValidator('json', loginSchema), async (c) => {
  const { identifier, password, deviceId } = c.req.valid('json');
  
  try {
    // Find user by email or phone
    const user = await getUserByEmail(identifier, c.env.DB) || 
                 await getUserByPhone(identifier, c.env.DB);
    
    if (!user) {
      return jsonError(c, 'Invalid credentials', 'Email/phone or password is incorrect', 401);
    }

    // Verify password
    const isValidPassword = verifyPassword(password, user.passwordHash);
    if (!isValidPassword) {
      return jsonError(c, 'Invalid credentials', 'Email/phone or password is incorrect', 401);
    }

    // Check account status
    if (user.status === 'suspended') {
      return jsonError(c, 'Account suspended', 'Your account has been suspended', 403);
    }

    // Generate tokens
    const tokens = await generateTokens(user, c.env.JWT_SECRET);

    // Update last login
    await c.env.DB.prepare(
      'UPDATE users SET last_login_at = CURRENT_TIMESTAMP WHERE id = ?'
    ).bind(user.id).run();

    // Comment out analytics queue since it's not available on the free plan
    /*
    await c.env.ANALYTICS_QUEUE.send({
      eventType: 'user_login',
      userId: user.id,
      properties: { 
        deviceId, 
        userType: user.userType,
        loginMethod: isValidEmail(identifier) ? 'email' : 'phone'
      },
      timestamp: new Date().toISOString()
    });
    */

    return jsonSuccess(c, {
      user: {
        id: user.id,
        email: user.email,
        phone: user.phone,
        userType: user.userType,
        status: user.status,
        emailVerified: user.emailVerified,
        phoneVerified: user.phoneVerified
      },
      ...tokens
    }, 'Login successful');

  } catch (error) {
    console.error('Login error:', error);
    return jsonError(c, 'Login failed', 'An error occurred during login', 500);
  }
});

/**
 * Password reset request endpoint
 */
auth.post('/forgot-password', zValidator('json', passwordResetRequestSchema), async (c) => {
  const { identifier } = c.req.valid('json');
  
  try {
    // Find user by email or phone
    const user = await getUserByEmail(identifier, c.env.DB) || 
                 await getUserByPhone(identifier, c.env.DB);
    
    if (!user) {
      // Don't reveal if user exists or not
      return jsonSuccess(c, { sent: true }, 'If an account exists, a reset code will be sent');
    }

    // Generate reset token
    const resetToken = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    // Store reset token
    await c.env.CACHE.put(
      `reset:${resetToken}`, 
      JSON.stringify({ userId: user.id, expiresAt: expiresAt.toISOString() }),
      { expirationTtl: 3600 } // 1 hour
    );

    // In production, send email/SMS with reset link
    console.log(`Password reset token for ${user.email}: ${resetToken}`); // Development only

    return jsonSuccess(c, { sent: true }, 'If an account exists, a reset code will be sent');

  } catch (error) {
    console.error('Password reset request error:', error);
    return jsonError(c, 'Reset request failed', 'An error occurred while processing reset request', 500);
  }
});

/**
 * Password reset endpoint
 */
auth.post('/reset-password', zValidator('json', passwordResetSchema), async (c) => {
  const { token, newPassword } = c.req.valid('json');
  
  try {
    // Get reset token data
    const tokenData = await c.env.CACHE.get(`reset:${token}`);
    
    if (!tokenData) {
      return jsonError(c, 'Invalid token', 'Reset token is invalid or has expired', 400);
    }

    const { userId, expiresAt } = JSON.parse(tokenData);
    
    // Check if token has expired
    if (new Date() > new Date(expiresAt)) {
      await c.env.CACHE.delete(`reset:${token}`);
      return jsonError(c, 'Token expired', 'Reset token has expired', 400);
    }

    // Hash new password
    const passwordHash = await hashPassword(newPassword);

    // Update user password
    await c.env.DB.prepare(
      'UPDATE users SET password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
    ).bind(passwordHash, userId).run();

    // Delete reset token
    await c.env.CACHE.delete(`reset:${token}`);

    // Comment out analytics queue since it's not available on the free plan
    /*
    // Track password reset event
    await c.env.ANALYTICS_QUEUE.send({
      eventType: 'password_reset',
      userId,
      timestamp: new Date().toISOString()
    });
    */

    return jsonSuccess(c, { reset: true }, 'Password reset successfully');

  } catch (error) {
    console.error('Password reset error:', error);
    return jsonError(c, 'Reset failed', 'An error occurred while resetting password', 500);
  }
});

/**
 * Logout endpoint
 */
auth.post('/logout', async (c) => {
  try {
    // In a more sophisticated implementation, you would:
    // 1. Invalidate the JWT token (add to blacklist)
    // 2. Clear session data
    // 3. Track logout event

    const userId = c.get('userId');
    if (userId) {
      // Comment out analytics queue since it's not available on the free plan
      /*
      await c.env.ANALYTICS_QUEUE.send({
        eventType: 'user_logout',
        userId,
        timestamp: new Date().toISOString()
      });
      */
    }

    return jsonSuccess(c, { loggedOut: true }, 'Logged out successfully');

  } catch (error) {
    console.error('Logout error:', error);
    return jsonError(c, 'Logout failed', 'An error occurred during logout', 500);
  }
});

export { auth as authRoutes };
