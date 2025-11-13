import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import {
  registerSchema,
  loginSchema,
  phoneVerificationSchema,
  passwordResetRequestSchema,
  passwordResetSchema,
  refreshTokenSchema
} from '../utils/validation';
import {
  hashPassword,
  verifyPassword,
  generateTokens,
  verifyJWT,
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
  const { email, phone, password, userType, preferredLanguage, display_name } = c.req.valid('json');
  
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
    let displayName = display_name || '';
    if (userType === 'supplier') {
      await createSupplierProfile({
        userId,
        displayName,
      }, c.env.DB);
    } else if (userType === 'customer') {
      await createCustomerProfile({
        userId,
        displayName,
      }, c.env.DB);
    } else if (userType === 'companion') {
      // For companions, create a customer profile for now as a base
      await createCustomerProfile({
        userId,
        displayName: displayName || 'Companion',
      }, c.env.DB);
    }
    
    // Admin users don't need specific profiles
    
    // Generate tokens
    const tokens = await generateTokens(user, c.env.JWT_SECRET);

    if (c.env.ANALYTICS_QUEUE && typeof c.env.ANALYTICS_QUEUE.send === 'function') {
      await c.env.ANALYTICS_QUEUE.send({
        eventType: 'user_registration',
        userId: user.id,
        properties: { 
          userType: user.userType,
          preferredLanguage: user.preferredLanguage 
        },
        timestamp: new Date().toISOString()
      });
    }

    return jsonSuccess(c, {
      user: {
        id: user.id,
        email: user.email,
        phone: user.phone,
        userType: user.userType,
        status: user.status,
        emailVerified: user.emailVerified,
        phoneVerified: user.phoneVerified,
        name: displayName
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

    // Fetch display name from profile
    let name = null;
    if (user.userType === 'supplier') {
      const profile = await c.env.DB.prepare('SELECT display_name FROM supplier_profiles WHERE user_id = ?').bind(user.id).first();
      name = profile?.display_name || null;
    } else if (user.userType === 'customer') {
      const profile = await c.env.DB.prepare('SELECT display_name FROM customer_profiles WHERE user_id = ?').bind(user.id).first();
      name = profile?.display_name || null;
    } else if (user.userType === 'companion') {
      const profile = await c.env.DB.prepare('SELECT display_name FROM companion_profiles WHERE user_id = ?').bind(user.id).first();
      name = profile?.display_name || null;
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

    if (c.env.ANALYTICS_QUEUE && typeof c.env.ANALYTICS_QUEUE.send === 'function') {
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
    }

    return jsonSuccess(c, {
      user: {
        id: user.id,
        email: user.email,
        phone: user.phone,
        userType: user.userType,
        status: user.status,
        emailVerified: user.emailVerified,
        phoneVerified: user.phoneVerified,
        name
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

    // Get user display name from profile
    let displayName = user.email;
    try {
      if (user.userType === 'supplier') {
        const profile = await c.env.DB.prepare('SELECT display_name FROM supplier_profiles WHERE user_id = ?').bind(user.id).first() as { display_name?: string } | null;
        displayName = profile?.display_name || user.email;
      } else if (user.userType === 'customer') {
        const profile = await c.env.DB.prepare('SELECT display_name FROM customer_profiles WHERE user_id = ?').bind(user.id).first() as { display_name?: string } | null;
        displayName = profile?.display_name || user.email;
      } else if (user.userType === 'companion') {
        const profile = await c.env.DB.prepare('SELECT display_name FROM companion_profiles WHERE user_id = ?').bind(user.id).first() as { display_name?: string } | null;
        displayName = profile?.display_name || user.email;
      }
    } catch (profileError) {
      console.warn('Could not fetch user display name:', profileError);
    }

    // Send password reset email
    if (c.env.EMAIL_WORKER) {
      try {
        const response = await c.env.EMAIL_WORKER.fetch('https://tirak-email-worker.tirak-court.workers.dev', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            to: user.email,
            subject: 'Password Reset Request - Tirak',
            template: 'password_reset',
            data: {
              resetToken,
              resetUrl: `tirak://reset-password?token=${resetToken}`,
              userName: displayName,
              expiresIn: '1 hour'
            }
          })
        });
        
        if (response.ok) {
          console.log(`Password reset email sent to ${user.email}`);
        } else {
          console.error('Failed to send password reset email:', await response.text());
        }
      } catch (emailError) {
        console.error('Failed to send password reset email:', emailError);
        // Still return success to user for security
      }
    } else {
      // Development mode - log token to console
      console.log(`Password reset token for ${user.email}: ${resetToken}`);
    }

    if (c.env.ANALYTICS_QUEUE && typeof c.env.ANALYTICS_QUEUE.send === 'function') {
      await c.env.ANALYTICS_QUEUE.send({
        eventType: 'password_reset_request',
        userId: user.id,
        properties: { 
          identifier,
          resetToken
        },
        timestamp: new Date().toISOString()
      });
    }

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

    if (c.env.ANALYTICS_QUEUE && typeof c.env.ANALYTICS_QUEUE.send === 'function') {
      await c.env.ANALYTICS_QUEUE.send({
        eventType: 'password_reset',
        userId,
        timestamp: new Date().toISOString()
      });
    }

    return jsonSuccess(c, { reset: true }, 'Password reset successfully');

  } catch (error) {
    console.error('Password reset error:', error);
    return jsonError(c, 'Reset failed', 'An error occurred while resetting password', 500);
  }
});

/**
 * Refresh token endpoint
 */
auth.post('/refresh', zValidator('json', refreshTokenSchema), async (c) => {
  const { refreshToken } = c.req.valid('json');
  
  try {
    // Verify the refresh token
    let decoded;
    try {
      decoded = await verifyJWT(refreshToken, c.env.JWT_SECRET);
    } catch (error) {
      return jsonError(c, 'Invalid refresh token', 'The refresh token is invalid or expired', 401);
    }

    // Extract user ID from token
    const userId = decoded.sub;
    if (!userId) {
      return jsonError(c, 'Invalid token', 'Token does not contain user information', 401);
    }

    // Get user from database
    const user = await getUserById(userId, c.env.DB);
    if (!user) {
      return jsonError(c, 'User not found', 'User associated with token does not exist', 404);
    }

    // Check account status
    if (user.status === 'suspended') {
      return jsonError(c, 'Account suspended', 'Your account has been suspended', 403);
    }

    // Generate new tokens
    const tokens = await generateTokens(user, c.env.JWT_SECRET);

    // Fetch display name from profile
    let name = null;
    try {
      if (user.userType === 'supplier') {
        const profile = await c.env.DB.prepare('SELECT display_name FROM supplier_profiles WHERE user_id = ?').bind(user.id).first();
        name = profile?.display_name || null;
      } else if (user.userType === 'customer') {
        const profile = await c.env.DB.prepare('SELECT display_name FROM customer_profiles WHERE user_id = ?').bind(user.id).first();
        name = profile?.display_name || null;
      } else if (user.userType === 'companion') {
        const profile = await c.env.DB.prepare('SELECT display_name FROM companion_profiles WHERE user_id = ?').bind(user.id).first();
        name = profile?.display_name || null;
      }
    } catch (profileError) {
      console.warn('Could not fetch user display name:', profileError);
    }

    // Track token refresh
    if (c.env.ANALYTICS_QUEUE && typeof c.env.ANALYTICS_QUEUE.send === 'function') {
      await c.env.ANALYTICS_QUEUE.send({
        eventType: 'token_refreshed',
        userId: user.id,
        properties: { 
          userType: user.userType
        },
        timestamp: new Date().toISOString()
      });
    }

    return jsonSuccess(c, {
      user: {
        id: user.id,
        email: user.email,
        phone: user.phone,
        userType: user.userType,
        status: user.status,
        emailVerified: user.emailVerified,
        phoneVerified: user.phoneVerified,
        name
      },
      ...tokens
    }, 'Token refreshed successfully');

  } catch (error) {
    console.error('Refresh token error:', error);
    return jsonError(c, 'Token refresh failed', 'An error occurred while refreshing the token', 500);
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
      if (c.env.ANALYTICS_QUEUE && typeof c.env.ANALYTICS_QUEUE.send === 'function') {
        await c.env.ANALYTICS_QUEUE.send({
          eventType: 'user_logout',
          userId,
          timestamp: new Date().toISOString()
        });
      }
    }

    return jsonSuccess(c, { loggedOut: true }, 'Logged out successfully');

  } catch (error) {
    console.error('Logout error:', error);
    return jsonError(c, 'Logout failed', 'An error occurred during logout', 500);
  }
});

export { auth as authRoutes };
