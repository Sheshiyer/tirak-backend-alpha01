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
  createEmailConfig,
  sendEmail,
  renderBasicEmail
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
import { awardReferralCoins } from './referrals';

const auth = new Hono<{ Bindings: Env; Variables: Variables }>();

// Apply rate limiting to auth endpoints
auth.use('*', createRateLimit('auth'));

/**
 * User registration endpoint
 */
auth.post('/register', zValidator('json', registerSchema), async (c) => {
  const {
    display_name,
    displayName,
    name,
    firstName,
    lastName,
    first_name,
    last_name,
    email,
    phone,
    password,
    userType,
    preferredLanguage,
    referralCode,
    dateOfBirth,
    gender
  } = c.req.valid('json');
  
  try {
    // Normalize and validate inputs
    const normalizedEmail = email.toLowerCase().trim();
    const generatedPhoneSuffix = Array.from(
      crypto.getRandomValues(new Uint8Array(8)),
      digit => String(digit % 10)
    ).join('');
    const normalizedPhone = phone
      ? normalizePhone(phone)
      : `+669${generatedPhoneSuffix}`;
    const normalizedUserType = userType === 'companion' ? 'supplier' : userType;
    const providedFirstName = (firstName || first_name || '').trim();
    const providedLastName = (lastName || last_name || '').trim();
    const joinedName = [providedFirstName, providedLastName].filter(Boolean).join(' ');
    const resolvedDisplayName = (display_name || displayName || name || joinedName || normalizedEmail.split('@')[0] || 'User').trim();
    const safeGender = gender === 'prefer_not_to_say' ? undefined : gender;
    
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
    
    // Create user
    const user = await createUser({
      id: userId,
      email: normalizedEmail,
      phone: normalizedPhone,
      passwordHash,
      userType: normalizedUserType,
      preferredLanguage
    }, c.env.DB);

    // Create user profile based on type
    if (normalizedUserType === 'supplier') {
      const [derivedFirstName, ...derivedLastNameParts] = resolvedDisplayName.split(/\s+/).filter(Boolean);
      await createSupplierProfile({
        userId,
        displayName: resolvedDisplayName,
        firstName: providedFirstName || derivedFirstName || resolvedDisplayName,
        lastName: providedLastName || derivedLastNameParts.join(' '),
        dateOfBirth,
        gender: safeGender,
        spokenLanguages: preferredLanguage ? [preferredLanguage] : [],
      }, c.env.DB);
    } else {
      await createCustomerProfile({
        userId,
        displayName: resolvedDisplayName,
        dateOfBirth,
        gender: safeGender,
      }, c.env.DB);
    }

    await awardReferralCoins(c.env.DB, userId, referralCode);

    // Generate tokens
    const tokens = await generateTokens(user, c.env.JWT_SECRET);

    // Track registration event
    await c.env.ANALYTICS_QUEUE.send({
      eventType: 'user_registration',
      userId: user.id,
      properties: { 
        userType: user.userType,
        preferredLanguage: user.preferredLanguage 
      },
      timestamp: new Date().toISOString()
    });

    return jsonSuccess(c, {
      user: {
        id: user.id,
        name: resolvedDisplayName,
        displayName: resolvedDisplayName,
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
    const isValidPassword = await verifyPassword(password, user.passwordHash);
    if (!isValidPassword) {
      return jsonError(c, 'Invalid credentials', 'Email/phone or password is incorrect', 401);
    }

    // Check account status
    if (user.status === 'suspended') {
      return jsonError(c, 'Account suspended', 'Your account has been suspended', 403);
    }

    if (user.status === 'pending') {
      await c.env.DB.prepare(
        'UPDATE users SET status = ?, email_verified = TRUE, phone_verified = TRUE, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
      ).bind('active', user.id).run();
      user.status = 'active';
      user.emailVerified = true;
      user.phoneVerified = true;
    }

    // Generate tokens
    const tokens = await generateTokens(user, c.env.JWT_SECRET);
    const profileNameRow = await c.env.DB.prepare(`
      SELECT COALESCE(cp.display_name, sp.display_name) AS display_name
      FROM users u
      LEFT JOIN customer_profiles cp ON u.id = cp.user_id
      LEFT JOIN supplier_profiles sp ON u.id = sp.user_id
      WHERE u.id = ?
    `).bind(user.id).first<{ display_name?: string }>();
    const displayName = profileNameRow?.display_name || user.email.split('@')[0] || 'User';

    // Update last login
    await c.env.DB.prepare(
      'UPDATE users SET last_login_at = CURRENT_TIMESTAMP WHERE id = ?'
    ).bind(user.id).run();

    // Track login activity
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

    return jsonSuccess(c, {
      user: {
        id: user.id,
        name: displayName,
        displayName,
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
 * Phone verification endpoint
 */
auth.post('/verify-phone', zValidator('json', phoneVerificationSchema), async (c) => {
  const { phone, otp } = c.req.valid('json');

  try {
    const normalizedPhone = normalizePhone(phone);

    // Get stored OTP data
    const storedOtpData = await c.env.CACHE.get(`otp:${normalizedPhone}`);

    if (!storedOtpData) {
      return jsonError(c, 'Invalid OTP', 'No verification code found for this phone number', 400);
    }

    const otpData = JSON.parse(storedOtpData);

    // Increment attempts
    otpData.attempts += 1;
    await c.env.CACHE.put(`otp:${normalizedPhone}`, JSON.stringify(otpData), { expirationTtl: 600 });

    if (!isOTPValid(otpData, otp)) {
      if (otpData.attempts >= 3) {
        await c.env.CACHE.delete(`otp:${normalizedPhone}`);
        return jsonError(c, 'Too many attempts', 'Maximum verification attempts exceeded', 429);
      }
      return jsonError(c, 'Invalid OTP', 'The verification code is incorrect or has expired', 400);
    }

    // Update user's phone verification status
    const result = await c.env.DB.prepare(
      'UPDATE users SET phone_verified = TRUE, status = ? WHERE phone = ? AND status = ?'
    ).bind('active', normalizedPhone, 'pending').run();

    if (!result.success) {
      return jsonError(c, 'Verification failed', 'User not found or already verified', 400);
    }

    // Clear OTP from cache
    await c.env.CACHE.delete(`otp:${normalizedPhone}`);

    // Track verification event
    const user = await getUserByPhone(normalizedPhone, c.env.DB);
    if (user) {
      await c.env.ANALYTICS_QUEUE.send({
        eventType: 'phone_verification',
        userId: user.id,
        properties: { phone: normalizedPhone },
        timestamp: new Date().toISOString()
      });
    }

    return jsonSuccess(c, { verified: true }, 'Phone number verified successfully');

  } catch (error) {
    console.error('Phone verification error:', error);
    return jsonError(c, 'Verification failed', 'An error occurred during verification', 500);
  }
});

/**
 * Resend OTP endpoint
 */
auth.post('/resend-otp', async (c) => {
  try {
    const { phone } = await c.req.json();
    const normalizedPhone = normalizePhone(phone);
    
    if (!isValidPhone(normalizedPhone)) {
      return jsonError(c, 'Invalid phone format', 'Please provide a valid phone number', 400);
    }

    // Check if user exists
    const user = await getUserByPhone(normalizedPhone, c.env.DB);
    if (!user) {
      return jsonError(c, 'User not found', 'No account found with this phone number', 404);
    }

    if (user.phoneVerified) {
      return jsonError(c, 'Already verified', 'Phone number is already verified', 400);
    }

    // Generate new OTP
    const otpData = createOTPData();
    await c.env.CACHE.put(`otp:${normalizedPhone}`, JSON.stringify(otpData), { expirationTtl: 600 }); // 10 minutes

    // Send OTP via SMS
    try {
      const smsConfig = createSMSConfig(c.env);
      await sendOTPSMS(smsConfig, normalizedPhone, otpData.code);
    } catch (error) {
      console.error('Failed to send OTP SMS:', error);
      // Continue even if SMS fails
    }

    console.log(`New OTP for ${normalizedPhone}: ${otpData.code}`); // Development only

    return jsonSuccess(c, { sent: true }, 'Verification code sent successfully');

  } catch (error) {
    console.error('Resend OTP error:', error);
    return jsonError(c, 'Failed to send OTP', 'An error occurred while sending verification code', 500);
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

    const resetLink = `tirak://auth/new?token=${encodeURIComponent(resetToken)}`;
    const webResetLink = `https://tirak.app/auth/new?token=${encodeURIComponent(resetToken)}`;

    try {
      const emailConfig = createEmailConfig(c.env);
      await sendEmail(
        emailConfig,
        user.email,
        'Reset your Tirak password',
        renderBasicEmail(
          'Reset your Tirak password',
          'Use the button below to choose a new password. This link expires in one hour. If you did not request this, you can ignore this email.',
          { label: 'Reset password', url: resetLink }
        ) + `\n<!-- Web fallback: ${webResetLink} -->`,
        'password_reset'
      );
    } catch (error) {
      console.error('Failed to send password reset email:', error);
      if (c.env.ENVIRONMENT !== 'production') {
        console.log(`Password reset token for ${user.email}: ${resetToken}`);
      }
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

    // Track password reset event
    await c.env.ANALYTICS_QUEUE.send({
      eventType: 'password_reset',
      userId,
      timestamp: new Date().toISOString()
    });

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
      await c.env.ANALYTICS_QUEUE.send({
        eventType: 'user_logout',
        userId,
        timestamp: new Date().toISOString()
      });
    }

    return jsonSuccess(c, { loggedOut: true }, 'Logged out successfully');

  } catch (error) {
    console.error('Logout error:', error);
    return jsonError(c, 'Logout failed', 'An error occurred during logout', 500);
  }
});

export { auth as authRoutes };
