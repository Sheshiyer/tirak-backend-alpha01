import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { authMiddleware, adminOnly } from '../../middleware/auth';
import { createRateLimit } from '../../middleware/rateLimit';
import { adminCors } from '../../middleware/cors';
import { jsonSuccess, jsonError, jsonPaginated, createPagination } from '../../utils/response';
import { validatePagination, validateUUID } from '../../middleware/validation';
import { hashPassword } from '../../utils/auth';
import type { Env, Variables } from '../../index';

const users = new Hono<{ Bindings: Env; Variables: Variables }>();

// Apply admin-specific middleware
users.use('*', adminCors());
users.use('*', authMiddleware);
users.use('*', adminOnly);
users.use('*', createRateLimit('admin'));

// Validation schemas
const userSearchSchema = z.object({
  search: z.string().optional(),
  userType: z.enum(['customer', 'supplier', 'admin']).optional(),
  status: z.enum(['active', 'suspended', 'pending', 'inactive']).optional(),
  verified: z.boolean().optional(),
  sortBy: z.enum(['created_at', 'last_login_at', 'email']).default('created_at'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
  page: z.string().optional().transform(val => val ? parseInt(val, 10) : 1),
  limit: z.string().optional().transform(val => val ? parseInt(val, 10) : 20)
}).refine(data => data.page > 0, {
  message: 'Page must be greater than 0',
  path: ['page']
}).refine(data => data.limit > 0 && data.limit <= 100, {
  message: 'Limit must be between 1 and 100',
  path: ['limit']
});

const userUpdateSchema = z.object({
  status: z.enum(['active', 'suspended', 'pending', 'inactive']).optional(),
  emailVerified: z.boolean().optional(),
  phoneVerified: z.boolean().optional(),
  preferredLanguage: z.enum(['en', 'th']).optional(),
  // Additional fields for customer/supplier profile updates
  name: z.string().optional(),
  email: z.string().email().optional(),
  phone: z.string().optional(),
  location: z.string().optional()
});

const userCreateSchema = z.object({
  name: z.string().min(1, "Name is required"),
  email: z.string().email("Invalid email format"),
  phone: z.string().min(1, "Phone is required"),
  userType: z.enum(['customer', 'supplier', 'admin']),
  status: z.enum(['active', 'suspended', 'pending', 'inactive']).default('active'),
  verificationStatus: z.enum(['verified', 'pending', 'rejected']).optional(),
  location: z.string().optional(),
  category: z.string().optional(),
  subscription: z.enum(['basic', 'premium']).optional()
});

const bulkActionSchema = z.object({
  userIds: z.array(z.string().uuid()),
  action: z.enum(['activate', 'suspend', 'verify_email', 'verify_phone']),
  reason: z.string().optional()
});

// Stats query schema
const statsQuerySchema = z.object({
  userType: z.string().optional().transform(val => {
    // Validate if provided, but make it optional
    if (val && ['customer', 'supplier', 'admin'].includes(val)) {
      return val;
    }
    return undefined;
  })
});

/**
 * Get user stats grouped by user type or filtered by specific user type
 */
users.get('/stats', async (c) => {
  // Get userType query param directly
  const userType = c.req.query('userType');
  
  try {
    // Base WHERE clause
    let whereClause = '';
    const params: any[] = [];
    
    if (userType) {
      whereClause = 'WHERE user_type = ?';
      params.push(userType);
    }
    
    // Get user counts by status
    const userStatusStats = await c.env.DB.prepare(`
      SELECT 
        user_type,
        status,
        COUNT(*) as count
      FROM users
      ${whereClause}
      GROUP BY user_type, status
    `).bind(...params).all();

    // Get user verification stats
    const verificationStats = await c.env.DB.prepare(`
      SELECT 
        user_type,
        COUNT(CASE WHEN email_verified = TRUE THEN 1 END) as email_verified_count,
        COUNT(CASE WHEN phone_verified = TRUE THEN 1 END) as phone_verified_count,
        COUNT(*) as total_count
      FROM users
      ${whereClause}
      GROUP BY user_type
    `).bind(...params).all();

    // Get activity stats
    const activityStats = await c.env.DB.prepare(`
      SELECT 
        user_type,
        COUNT(CASE WHEN last_login_at >= datetime('now', '-7 days') THEN 1 END) as active_last_week,
        COUNT(CASE WHEN last_login_at >= datetime('now', '-30 days') THEN 1 END) as active_last_month,
        COUNT(*) as total
      FROM users
      ${whereClause}
      GROUP BY user_type
    `).bind(...params).all();

    // Get supplier specific stats if requested
    let supplierStats = null;
    if (userType === 'supplier' || !userType) {
      supplierStats = await c.env.DB.prepare(`
        SELECT 
          verification_status,
          subscription_status,
          COUNT(*) as count
        FROM supplier_profiles
        GROUP BY verification_status, subscription_status
      `).all();
    }

    // Get customer specific stats if requested
    let customerStats = null;
    if (userType === 'customer' || !userType) {
      customerStats = await c.env.DB.prepare(`
        SELECT 
          COUNT(*) as total,
          AVG(loyalty_points) as avg_loyalty_points
        FROM customer_profiles
      `).first();
    }

    return jsonSuccess(c, {
      statusStats: userStatusStats.results || [],
      verificationStats: verificationStats.results || [],
      activityStats: activityStats.results || [],
      supplierStats: supplierStats?.results || [],
      customerStats: customerStats || {}
    }, 'User statistics retrieved successfully');

  } catch (error) {
    console.error('User stats error:', error);
    return jsonError(c, 'Failed to retrieve user statistics', 'An error occurred while retrieving user statistics', 500);
  }
});

/**
 * Get all users with filtering and pagination
 */
users.get('/', zValidator('query', userSearchSchema), async (c) => {
  const { page, limit, search, userType, status, verified, sortBy, sortOrder } = c.req.valid('query');
  
  try {
    // Build WHERE clause
    const conditions = [];
    const params = [];

    if (search) {
      conditions.push('(u.email LIKE ? OR u.phone LIKE ? OR cp.display_name LIKE ? OR sp.display_name LIKE ?)');
      const searchTerm = `%${search}%`;
      params.push(searchTerm, searchTerm, searchTerm, searchTerm);
    }

    if (userType) {
      conditions.push('u.user_type = ?');
      params.push(userType);
    }

    if (status) {
      conditions.push('u.status = ?');
      params.push(status);
    }

    if (verified !== undefined) {
      if (verified) {
        conditions.push('(u.email_verified = TRUE AND u.phone_verified = TRUE)');
      } else {
        conditions.push('(u.email_verified = FALSE OR u.phone_verified = FALSE)');
      }
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // Get total count
    const countQuery = `
      SELECT COUNT(*) as total 
      FROM users u
      LEFT JOIN customer_profiles cp ON u.id = cp.user_id
      LEFT JOIN supplier_profiles sp ON u.id = sp.user_id
      ${whereClause}
    `;
    
    const countResult = await c.env.DB.prepare(countQuery).bind(...params).first();
    const total = countResult?.total as number || 0;

    // Get users with profiles
    const offset = (page - 1) * limit;
    const usersQuery = `
      SELECT 
        u.id,
        u.email,
        u.phone,
        u.user_type,
        u.status,
        u.email_verified,
        u.phone_verified,
        u.preferred_language,
        u.created_at,
        u.updated_at,
        u.last_login_at,
        COALESCE(cp.display_name, sp.display_name) as display_name,
        sp.verification_status as supplier_verification,
        sp.subscription_status,
        sp.rating_average,
        sp.rating_count
      FROM users u
      LEFT JOIN customer_profiles cp ON u.id = cp.user_id
      LEFT JOIN supplier_profiles sp ON u.id = sp.user_id
      ${whereClause}
      ORDER BY u.${sortBy} ${sortOrder.toUpperCase()}
      LIMIT ? OFFSET ?
    `;

    const usersResult = await c.env.DB.prepare(usersQuery)
      .bind(...params, limit, offset)
      .all();

    const pagination = createPagination(page, limit, total);

    return jsonPaginated(c, usersResult.results || [], pagination, 'Users retrieved successfully');

  } catch (error) {
    console.error('Admin users list error:', error);
    return jsonError(c, 'Failed to retrieve users', 'An error occurred while retrieving users', 500);
  }
});

/**
 * Create a new user
 */
users.post('/', zValidator('json', userCreateSchema), async (c) => {
  const userData = c.req.valid('json');
  const adminUserId = c.get('userId');
  
  try {
    // Check if user with this email already exists
    const existingUser = await c.env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(userData.email).first();
    if (existingUser) {
      return jsonError(c, 'User already exists', 'A user with this email already exists', 409);
    }
    
    // Generate a UUID for the new user
    const userId = crypto.randomUUID();
    
    // Generate a random temporary password and hash it
    const tempPassword = `Temp${Math.random().toString(36).substring(2, 10)}${Math.floor(Math.random() * 10000)}!`;
    const passwordHash = await hashPassword(tempPassword);
    
    // Insert the new user
    await c.env.DB.prepare(`
      INSERT INTO users (
        id, 
        email, 
        phone, 
        user_type, 
        status, 
        email_verified, 
        phone_verified, 
        preferred_language,
        password_hash,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).bind(
      userId,
      userData.email,
      userData.phone,
      userData.userType,
      userData.status,
      false, // email_verified
      false, // phone_verified
      'en',  // preferred_language
      passwordHash // password_hash
    ).run();
    
    // Insert additional profile data based on user type
    if (userData.userType === 'customer') {
      await c.env.DB.prepare(`
        INSERT INTO customer_profiles (
          user_id,
          display_name,
          created_at,
          updated_at
        ) VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `).bind(
        userId,
        userData.name
      ).run();
    } else if (userData.userType === 'supplier') {
      await c.env.DB.prepare(`
        INSERT INTO supplier_profiles (
          user_id,
          display_name,
          verification_status,
          subscription_status,
          subscription_tier,
          categories,
          regions,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `).bind(
        userId,
        userData.name,
        userData.verificationStatus || 'pending',
        'active',
        userData.subscription || 'basic',
        userData.category ? JSON.stringify([userData.category]) : '[]',
        userData.location ? JSON.stringify([userData.location]) : '[]'
      ).run();
    }
    
    // Log admin action
    console.log(`Admin ${adminUserId} created new user ${userId} of type ${userData.userType}`);
    
    return jsonSuccess(c, { 
      id: userId,
      ...userData,
      tempPassword: tempPassword // Include the temporary password in the response
    }, 'User created successfully with temporary password');
    
  } catch (error) {
    console.error('Error creating user:', error);
    return jsonError(c, 'Failed to create user', 'An error occurred while creating the user', 500);
  }
});

/**
 * Get specific user details
 */
users.get('/:userId', validateUUID('userId'), async (c) => {
  const userId = c.req.param('userId');
  
  try {
    // Get user with profile data
    const user = await c.env.DB.prepare(`
      SELECT 
        u.*,
        cp.display_name as customer_display_name,
        cp.profile_image as customer_profile_image,
        cp.preferences as customer_preferences,
        cp.loyalty_points,
        sp.display_name as supplier_display_name,
        sp.bio as supplier_bio,
        sp.profile_images as supplier_profile_images,
        sp.categories as supplier_categories,
        sp.regions as supplier_regions,
        sp.spoken_languages as supplier_spoken_languages,
        sp.rating_average,
        sp.rating_count,
        sp.verification_status,
        sp.subscription_status,
        sp.subscription_tier,
        sp.subscription_expires_at
      FROM users u
      LEFT JOIN customer_profiles cp ON u.id = cp.user_id
      LEFT JOIN supplier_profiles sp ON u.id = sp.user_id
      WHERE u.id = ?
    `).bind(userId).first();

    if (!user) {
      return jsonError(c, 'User not found', 'The specified user does not exist', 404);
    }

    // Get user's recent activity
    const recentActivity = await c.env.DB.prepare(`
      SELECT 
        'booking' as type,
        created_at,
        'Booking created' as description
      FROM bookings 
      WHERE customer_id = ? OR supplier_id = ?
      
      UNION ALL
      
      SELECT 
        'chat' as type,
        created_at,
        'Chat message sent' as description
      FROM chat_messages 
      WHERE sender_id = ?
      
      ORDER BY created_at DESC
      LIMIT 10
    `).bind(userId, userId, userId).all();

    // Get user's sessions
    const sessions = await c.env.DB.prepare(`
      SELECT 
        id,
        device_id,
        ip_address,
        user_agent,
        created_at,
        last_active_at,
        expires_at
      FROM user_sessions 
      WHERE user_id = ? AND expires_at > datetime('now')
      ORDER BY last_active_at DESC
    `).bind(userId).all();

    return jsonSuccess(c, {
      user,
      recentActivity: recentActivity.results || [],
      activeSessions: sessions.results || []
    }, 'User details retrieved successfully');

  } catch (error) {
    console.error('Admin user details error:', error);
    return jsonError(c, 'Failed to retrieve user', 'An error occurred while retrieving user details', 500);
  }
});

/**
 * Update user status and settings
 */
users.patch('/:userId', validateUUID('userId'), zValidator('json', userUpdateSchema), async (c) => {
  const userId = c.req.param('userId');
  const updates = c.req.valid('json');
  const adminUserId = c.get('userId');
  
  try {
    // Check if user exists and get user type
    const existingUser = await c.env.DB.prepare('SELECT id, user_type FROM users WHERE id = ?').bind(userId).first();
    if (!existingUser) {
      return jsonError(c, 'User not found', 'The specified user does not exist', 404);
    }

    // Build update query for users table
    const userUpdateFields = [];
    const userParams = [];

    if (updates.status !== undefined) {
      userUpdateFields.push('status = ?');
      userParams.push(updates.status);
    }

    if (updates.emailVerified !== undefined) {
      userUpdateFields.push('email_verified = ?');
      userParams.push(updates.emailVerified);
    }

    if (updates.phoneVerified !== undefined) {
      userUpdateFields.push('phone_verified = ?');
      userParams.push(updates.phoneVerified);
    }

    if (updates.preferredLanguage !== undefined) {
      userUpdateFields.push('preferred_language = ?');
      userParams.push(updates.preferredLanguage);
    }

    if (updates.email !== undefined) {
      userUpdateFields.push('email = ?');
      userParams.push(updates.email);
    }

    if (updates.phone !== undefined) {
      userUpdateFields.push('phone = ?');
      userParams.push(updates.phone);
    }

    // Update user table if there are fields to update
    if (userUpdateFields.length > 0) {
      userUpdateFields.push('updated_at = CURRENT_TIMESTAMP');
      userParams.push(userId);

      await c.env.DB.prepare(`
        UPDATE users 
        SET ${userUpdateFields.join(', ')}
        WHERE id = ?
      `).bind(...userParams).run();
    }

    // Update profile table based on user type
    if (updates.name !== undefined || updates.location !== undefined) {
      if (existingUser.user_type === 'customer') {
        // Update customer profile
        const profileUpdateFields = [];
        const profileParams = [];

        if (updates.name !== undefined) {
          profileUpdateFields.push('display_name = ?');
          profileParams.push(updates.name);
        }

        // Note: customer_profiles table doesn't have a location column
        // We'll store location in preferences as JSON if needed in the future

        if (profileUpdateFields.length > 0) {
          profileUpdateFields.push('updated_at = CURRENT_TIMESTAMP');
          profileParams.push(userId);

          await c.env.DB.prepare(`
            UPDATE customer_profiles 
            SET ${profileUpdateFields.join(', ')}
            WHERE user_id = ?
          `).bind(...profileParams).run();
        }
      } else if (existingUser.user_type === 'supplier') {
        // Update supplier profile
        const profileUpdateFields = [];
        const profileParams = [];

        if (updates.name !== undefined) {
          profileUpdateFields.push('display_name = ?');
          profileParams.push(updates.name);
        }

        if (updates.location !== undefined) {
          profileUpdateFields.push('regions = ?');
          profileParams.push(JSON.stringify([updates.location]));
        }

        if (profileUpdateFields.length > 0) {
          profileUpdateFields.push('updated_at = CURRENT_TIMESTAMP');
          profileParams.push(userId);

          await c.env.DB.prepare(`
            UPDATE supplier_profiles 
            SET ${profileUpdateFields.join(', ')}
            WHERE user_id = ?
          `).bind(...profileParams).run();
        }
      }
    }

    // Log admin action
    console.log(`Admin ${adminUserId} updated user ${userId}:`, updates);

    return jsonSuccess(c, { 
      userId, 
      updates,
      userType: existingUser.user_type
    }, 'User updated successfully');

  } catch (error) {
    console.error('Admin user update error:', error);
    return jsonError(c, 'Failed to update user', 'An error occurred while updating the user', 500);
  }
});

/**
 * Delete a user
 */
users.delete('/:userId', validateUUID('userId'), async (c) => {
  const userId = c.req.param('userId');
  const adminUserId = c.get('userId');
  
  try {
    // Check if user exists
    const existingUser = await c.env.DB.prepare('SELECT id, user_type FROM users WHERE id = ?').bind(userId).first();
    if (!existingUser) {
      return jsonError(c, 'User not found', 'The specified user does not exist', 404);
    }

    // Start a transaction
    const userType = existingUser.user_type;
    
    // Delete user's profile data based on user type
    if (userType === 'customer') {
      await c.env.DB.prepare('DELETE FROM customer_profiles WHERE user_id = ?').bind(userId).run();
    } else if (userType === 'supplier') {
      await c.env.DB.prepare('DELETE FROM supplier_profiles WHERE user_id = ?').bind(userId).run();
    }
    
    // Delete user's sessions
    await c.env.DB.prepare('DELETE FROM user_sessions WHERE user_id = ?').bind(userId).run();
    
    // Delete the user
    await c.env.DB.prepare('DELETE FROM users WHERE id = ?').bind(userId).run();

    // Log admin action
    console.log(`Admin ${adminUserId} deleted user ${userId} of type ${userType}`);
    
    // Queue analytics event
    if (c.env.ANALYTICS_QUEUE && typeof c.env.ANALYTICS_QUEUE.send === 'function') {
      await c.env.ANALYTICS_QUEUE.send({
        action: 'user_deleted',
        userId: userId,
        adminId: adminUserId,
        userType: userType,
        timestamp: new Date().toISOString()
      });
    }

    return jsonSuccess(c, { userId }, 'User deleted successfully');

  } catch (error) {
    console.error('Error deleting user:', error);
    return jsonError(c, 'Failed to delete user', 'An error occurred while deleting the user', 500);
  }
});

/**
 * Bulk actions on multiple users
 */
users.post('/bulk-action', zValidator('json', bulkActionSchema), async (c) => {
  const { userIds, action, reason } = c.req.valid('json');
  const adminUserId = c.get('userId');
  
  try {
    const results = [];

    for (const userId of userIds) {
      try {
        let updateQuery = '';
        let params = [];

        switch (action) {
          case 'activate':
            updateQuery = 'UPDATE users SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?';
            params = ['active', userId];
            break;
          case 'suspend':
            updateQuery = 'UPDATE users SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?';
            params = ['suspended', userId];
            break;
          case 'verify_email':
            updateQuery = 'UPDATE users SET email_verified = TRUE, updated_at = CURRENT_TIMESTAMP WHERE id = ?';
            params = [userId];
            break;
          case 'verify_phone':
            updateQuery = 'UPDATE users SET phone_verified = TRUE, updated_at = CURRENT_TIMESTAMP WHERE id = ?';
            params = [userId];
            break;
        }

        await c.env.DB.prepare(updateQuery).bind(...params).run();
        results.push({ userId, success: true });

      } catch (error) {
        results.push({ userId, success: false, error: error instanceof Error ? error.message : 'Unknown error' });
      }
    }

    // Log bulk action
    console.log(`Admin ${adminUserId} performed bulk action ${action} on users:`, userIds, 'Reason:', reason);

    return jsonSuccess(c, { 
      action, 
      results,
      successful: results.filter(r => r.success).length,
      failed: results.filter(r => !r.success).length
    }, 'Bulk action completed');

  } catch (error) {
    console.error('Admin bulk action error:', error);
    return jsonError(c, 'Bulk action failed', 'An error occurred while performing bulk action', 500);
  }
});

/**
 * Update a companion's verification status
 */
const companionStatusSchema = z.object({
  status: z.enum(['pending', 'verified', 'rejected']),
  rejectionReason: z.string().optional()
});

users.put('/:id/status', validateUUID('id'), zValidator('json', companionStatusSchema), async (c) => {
  const userId = c.req.param('id');
  const { status, rejectionReason } = c.req.valid('json');

  try {
    // Check if the user is a companion/supplier
    const user = await c.env.DB.prepare('SELECT user_type FROM users WHERE id = ?').bind(userId).first();

    if (!user) {
      return jsonError(c, 'User not found', 'The specified user does not exist.', 404);
    }

    if (user.user_type !== 'supplier' && user.user_type !== 'companion') {
      return jsonError(c, 'Invalid user type', 'This action can only be performed on a companion.', 400);
    }
    
    // Update the verification_status in the supplier_profiles table
    const result = await c.env.DB.prepare(
      'UPDATE supplier_profiles SET verification_status = ?, rejection_reason = ? WHERE user_id = ?'
    ).bind(status, status === 'rejected' ? rejectionReason : null, userId).run();

    if (result.meta.changes === 0) {
      return jsonError(c, 'Profile not found', 'No companion profile exists for this user to update.', 404);
    }

    // Optionally, send a notification to the companion about the status change
    if (c.env.NOTIFICATION_QUEUE) {
      await c.env.NOTIFICATION_QUEUE.send({
        type: 'verification_status_update',
        userId: userId,
        payload: {
          status,
          reason: rejectionReason
        }
      });
    }

    return jsonSuccess(c, { updated: true, status: status }, `Companion verification status updated to ${status}.`);

  } catch (error) {
    console.error(`Failed to update companion status for ${userId}:`, error);
    return jsonError(c, 'Database Error', 'Failed to update companion verification status.', 500);
  }
});

export { users as userManagementRoutes };
