import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { authMiddleware, adminOnly } from '../../middleware/auth';
import { createRateLimit } from '../../middleware/rateLimit';
import { adminCors } from '../../middleware/cors';
import { jsonSuccess, jsonError, jsonPaginated, createPagination } from '../../utils/response';
import { validatePagination, validateUUID } from '../../middleware/validation';
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
  status: z.enum(['active', 'suspended', 'pending']).optional(),
  verified: z.boolean().optional(),
  mode: z.enum(['tirak', 'tirakplus']).default('tirak'),
  sortBy: z.enum(['created_at', 'last_login_at', 'email']).default('created_at'),
  sortOrder: z.enum(['asc', 'desc']).default('desc')
});

const userUpdateSchema = z.object({
  status: z.enum(['active', 'suspended', 'pending']).optional(),
  emailVerified: z.boolean().optional(),
  phoneVerified: z.boolean().optional(),
  preferredLanguage: z.enum(['en', 'th']).optional()
});

const bulkActionSchema = z.object({
  userIds: z.array(z.string().uuid()),
  action: z.enum(['activate', 'suspend', 'verify_email', 'verify_phone']),
  reason: z.string().optional()
});

const supplierVerificationSchema = z.object({
  status: z.enum(['verified', 'rejected', 'pending']),
  reason: z.string().max(500).optional()
});

/**
 * Get all users with filtering and pagination
 */
users.get('/', validatePagination(), zValidator('query', userSearchSchema), async (c) => {
  const { page, limit } = c.get('validatedQuery');
  const { search, userType, status, verified, mode, sortBy, sortOrder } = c.req.valid('query');
  
  try {
    if (mode === 'tirakplus') {
      return jsonPaginated(c, [], createPagination(page, limit, 0), 'Tirak Plus user data is served by the admin app demo layer.');
    }

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
        sp.verification_status,
        sp.verification_status as verificationStatus,
        sp.subscription_status,
        sp.subscription_tier,
        sp.subscription_tier as subscriptionTier,
        sp.categories,
        sp.regions,
        sp.spoken_languages,
        sp.location,
        sp.first_name,
        sp.last_name,
        sp.bio as supplier_bio,
        sp.profile_images,
        cp.profile_image as customer_profile_image,
        cp.preferences as customer_preferences,
        cp.loyalty_points,
        cp.bio as customer_bio,
        sp.rating_average,
        sp.rating_average as ratingAverage,
        sp.rating_count,
        (
          SELECT COUNT(*)
          FROM bookings b
          WHERE b.customer_id = u.id OR b.supplier_id = u.id
        ) as booking_count,
        (
          SELECT COALESCE(SUM(b.total_amount), 0)
          FROM bookings b
          WHERE b.customer_id = u.id AND b.status = 'completed'
        ) as total_spent,
        (
          SELECT COALESCE(SUM(b.total_amount), 0)
          FROM bookings b
          WHERE b.supplier_id = u.id
            AND b.status = 'completed'
            AND DATE(b.created_at) >= DATE('now', '-30 days')
        ) as monthly_earnings
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
 * Get specific user details
 */
users.get('/:userId', validateUUID('userId'), async (c) => {
  const userId = c.req.param('userId');
  const mode = c.req.query('mode') || 'tirak';
  
  try {
    if (mode !== 'tirak' && mode !== 'tirakplus') {
      return jsonError(c, 'Invalid mode', 'Admin user detail mode must be tirak or tirakplus', 400);
    }

    if (mode === 'tirakplus') {
      return jsonError(c, 'User not available', 'Tirak Plus user details are served by the admin app demo layer', 404);
    }

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
        sp.subscription_expires_at,
        sp.location as supplier_location,
        sp.first_name as supplier_first_name,
        sp.last_name as supplier_last_name,
        sp.cover_photo as supplier_cover_photo,
        sp.social_links as supplier_social_links,
        sp.certifications as supplier_certifications,
        sp.experience_stats as supplier_experience_stats,
        cp.bio as customer_bio
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

    const bookingStats = await c.env.DB.prepare(`
      SELECT
        COUNT(*) as total_bookings,
        COUNT(CASE WHEN status = 'completed' THEN 1 END) as completed_bookings,
        COUNT(CASE WHEN status = 'pending' THEN 1 END) as pending_bookings,
        COALESCE(SUM(CASE WHEN customer_id = ? AND status = 'completed' THEN total_amount ELSE 0 END), 0) as total_spent,
        COALESCE(SUM(CASE WHEN supplier_id = ? AND status = 'completed' THEN total_amount ELSE 0 END), 0) as supplier_earnings
      FROM bookings
      WHERE customer_id = ? OR supplier_id = ?
    `).bind(userId, userId, userId, userId).first();

    const favoriteStats = await c.env.DB.prepare(`
      SELECT preferences
      FROM customer_profiles
      WHERE user_id = ?
    `).bind(userId).first();

    let favoriteSuppliers = 0;
    try {
      const preferences = JSON.parse(String((favoriteStats as any)?.preferences || '{}'));
      const favorites = preferences.favoriteSuppliers || preferences.favorite_supplier_ids || [];
      favoriteSuppliers = Array.isArray(favorites) ? favorites.length : 0;
    } catch {
      favoriteSuppliers = 0;
    }

    return jsonSuccess(c, {
      user,
      stats: {
        totalBookings: (bookingStats as any)?.total_bookings || 0,
        completedBookings: (bookingStats as any)?.completed_bookings || 0,
        pendingBookings: (bookingStats as any)?.pending_bookings || 0,
        totalSpent: (bookingStats as any)?.total_spent || 0,
        supplierEarnings: (bookingStats as any)?.supplier_earnings || 0,
        favoriteSuppliers
      },
      recentActivity: recentActivity.results || [],
      activeSessions: sessions.results || []
    }, 'User details retrieved successfully');

  } catch (error) {
    console.error('Admin user details error:', error);
    return jsonError(c, 'Failed to retrieve user', 'An error occurred while retrieving user details', 500);
  }
});

/**
 * Update supplier/local-guide verification status.
 */
users.patch('/:userId/supplier-verification', validateUUID('userId'), zValidator('json', supplierVerificationSchema), async (c) => {
  const userId = c.req.param('userId');
  const { status, reason } = c.req.valid('json');
  const adminUserId = c.get('userId');

  try {
    const supplier = await c.env.DB.prepare(`
      SELECT sp.user_id, u.email
      FROM supplier_profiles sp
      JOIN users u ON u.id = sp.user_id
      WHERE sp.user_id = ?
    `).bind(userId).first();

    if (!supplier) {
      return jsonError(c, 'Supplier not found', 'The specified user does not have a supplier profile', 404);
    }

    await c.env.DB.prepare(`
      UPDATE supplier_profiles
      SET verification_status = ?, updated_at = CURRENT_TIMESTAMP
      WHERE user_id = ?
    `).bind(status, userId).run();

    await c.env.DB.prepare(`
      INSERT INTO notifications (id, user_id, type, title, message, data, read, created_at)
      VALUES (?, ?, ?, ?, ?, ?, FALSE, ?)
    `).bind(
      crypto.randomUUID(),
      userId,
      status === 'verified' ? 'supplier_verified' : status === 'rejected' ? 'supplier_rejected' : 'supplier_review_pending',
      status === 'verified' ? 'Profile verified' : status === 'rejected' ? 'Profile needs updates' : 'Profile review reset',
      reason || (status === 'verified' ? 'Your local guide profile has been verified.' : status === 'rejected' ? 'Your local guide profile was not approved yet.' : 'Your local guide profile is back in review.'),
      JSON.stringify({ status, reason, reviewedBy: adminUserId }),
      new Date().toISOString()
    ).run();

    console.log(`Admin ${adminUserId} updated supplier verification ${userId}:`, { status, reason });

    return jsonSuccess(c, {
      userId,
      verificationStatus: status,
      reason
    }, 'Supplier verification updated successfully');
  } catch (error) {
    console.error('Supplier verification update error:', error);
    return jsonError(c, 'Failed to update supplier', 'An error occurred while updating supplier verification', 500);
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
    // Check if user exists
    const existingUser = await c.env.DB.prepare('SELECT id FROM users WHERE id = ?').bind(userId).first();
    if (!existingUser) {
      return jsonError(c, 'User not found', 'The specified user does not exist', 404);
    }

    // Build update query
    const updateFields = [];
    const params = [];

    if (updates.status !== undefined) {
      updateFields.push('status = ?');
      params.push(updates.status);
    }

    if (updates.emailVerified !== undefined) {
      updateFields.push('email_verified = ?');
      params.push(updates.emailVerified);
    }

    if (updates.phoneVerified !== undefined) {
      updateFields.push('phone_verified = ?');
      params.push(updates.phoneVerified);
    }

    if (updates.preferredLanguage !== undefined) {
      updateFields.push('preferred_language = ?');
      params.push(updates.preferredLanguage);
    }

    if (updateFields.length === 0) {
      return jsonError(c, 'No updates provided', 'At least one field must be updated', 400);
    }

    updateFields.push('updated_at = CURRENT_TIMESTAMP');
    params.push(userId);

    // Update user
    await c.env.DB.prepare(`
      UPDATE users 
      SET ${updateFields.join(', ')}
      WHERE id = ?
    `).bind(...params).run();

    // Log admin action (you might want to create an admin_actions table)
    console.log(`Admin ${adminUserId} updated user ${userId}:`, updates);

    return jsonSuccess(c, { userId, updates }, 'User updated successfully');

  } catch (error) {
    console.error('Admin user update error:', error);
    return jsonError(c, 'Failed to update user', 'An error occurred while updating the user', 500);
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

export { users as userManagementRoutes };
