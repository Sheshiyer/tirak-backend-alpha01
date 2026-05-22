import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import {
  bookingSchema,
  reviewSchema
} from '../utils/validation';
import { validateUUID, validatePagination } from '../middleware/validation';
import { authMiddleware } from '../middleware/auth';
import { createRateLimit } from '../middleware/rateLimit';
import { 
  getUserById, 
  getCustomerProfile,
  updateUser
} from '../utils/database';
import { jsonSuccess, jsonError, jsonPaginated, createPagination } from '../utils/response';
import type { Env, Variables } from '../index';

const customers = new Hono<{ Bindings: Env; Variables: Variables }>();

// Apply authentication middleware to all routes
customers.use('*', authMiddleware);

// Apply rate limiting
customers.use('*', createRateLimit('general'));

const customerListQuerySchema = z.object({
  search: z.string().optional(),
  status: z.string().optional(),
  sortBy: z.string().optional(),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(100).default(20)
});

/**
 * List customers for local-guide workflows.
 */
customers.get('/all', zValidator('query', customerListQuerySchema), async (c) => {
  const userType = c.get('userType');
  const { search, status, sortBy, sortOrder, page, limit } = c.req.valid('query');

  if (!['supplier', 'companion', 'admin'].includes(String(userType))) {
    return jsonError(c, 'Access denied', 'Only local guides can browse customers', 403);
  }

  try {
    const filters: string[] = [`u.user_type = 'customer'`];
    const params: any[] = [];

    if (status) {
      filters.push('u.status = ?');
      params.push(status);
    } else {
      filters.push(`u.status != 'suspended'`);
    }

    if (search) {
      filters.push('(cp.display_name LIKE ? OR u.email LIKE ? OR u.phone LIKE ?)');
      const searchTerm = `%${search}%`;
      params.push(searchTerm, searchTerm, searchTerm);
    }

    const where = `WHERE ${filters.join(' AND ')}`;
    const countResult = await c.env.DB.prepare(`
      SELECT COUNT(*) as total
      FROM users u
      LEFT JOIN customer_profiles cp ON u.id = cp.user_id
      ${where}
    `).bind(...params).first();
    const total = Number(countResult?.total || 0);

    const sortColumns: Record<string, string> = {
      displayName: 'cp.display_name',
      name: 'cp.display_name',
      createdAt: 'u.created_at',
      lastLoginAt: 'u.last_login_at',
      loyaltyPoints: 'cp.loyalty_points'
    };
    const sortColumn = sortColumns[sortBy || 'createdAt'] || 'u.created_at';
    const offset = (page - 1) * limit;

    const customersResult = await c.env.DB.prepare(`
      SELECT
        u.id,
        u.email,
        u.phone,
        u.status,
        u.email_verified,
        u.phone_verified,
        u.preferred_language,
        u.created_at,
        u.last_login_at,
        cp.display_name,
        cp.profile_image,
        cp.preferences,
        cp.loyalty_points
      FROM users u
      LEFT JOIN customer_profiles cp ON u.id = cp.user_id
      ${where}
      ORDER BY ${sortColumn} ${sortOrder.toUpperCase()}
      LIMIT ? OFFSET ?
    `).bind(...params, limit, offset).all();

    const items = customersResult.results?.map((customer: any) => ({
      id: customer.id,
      email: customer.email,
      phone: customer.phone,
      displayName: customer.display_name || customer.email?.split('@')[0] || 'Customer',
      profileImage: customer.profile_image || null,
      status: customer.status,
      loyaltyPoints: Number(customer.loyalty_points || 0),
      emailVerified: Boolean(customer.email_verified),
      phoneVerified: Boolean(customer.phone_verified),
      preferredLanguage: customer.preferred_language || 'en',
      createdAt: customer.created_at,
      lastLoginAt: customer.last_login_at,
      preferences: JSON.parse(customer.preferences || '{}')
    })) || [];

    return c.json({
      success: true,
      data: items,
      pagination: createPagination(page, limit, total),
      message: 'Customers retrieved successfully'
    });

  } catch (error) {
    console.error('Get customers error:', error);
    return jsonError(c, 'Failed to retrieve customers', 'An error occurred while fetching customers', 500);
  }
});

/**
 * Get customer profile
 */
customers.get('/:id', validateUUID('id'), async (c) => {
  const customerId = c.req.param('id') as string;
  const userId = c.get('userId');
  
  // Ensure customer can only access their own profile
  if (userId !== customerId) {
    return jsonError(c, 'Access denied', 'You can only access your own profile', 403);
  }

  try {
    const customer = await getCustomerProfile(customerId, c.env.DB);
    if (!customer) {
      return jsonError(c, 'Customer not found', 'Customer profile does not exist', 404);
    }

    const user = await getUserById(customerId, c.env.DB);
    if (!user) {
      return jsonError(c, 'User not found', 'User does not exist', 404);
    }

    // Get booking statistics
    const bookingStats = await c.env.DB.prepare(`
      SELECT 
        COUNT(*) as total_bookings,
        COUNT(CASE WHEN status = 'completed' THEN 1 END) as completed_bookings,
        COUNT(CASE WHEN status = 'pending' THEN 1 END) as pending_bookings,
        COUNT(CASE WHEN status = 'cancelled' THEN 1 END) as cancelled_bookings
      FROM bookings 
      WHERE customer_id = ?
    `).bind(customerId).first();

    // Get favorite suppliers count
    const favoritesResult = await c.env.DB.prepare(`
      SELECT COUNT(*) as favorites_count
      FROM customer_profiles 
      WHERE user_id = ? AND JSON_EXTRACT(preferences, '$.favoriteSuppliers') IS NOT NULL
    `).bind(customerId).first();

    const customerData = {
      id: customer.userId,
      displayName: customer.displayName,
      profileImage: customer.profileImage,
      loyaltyPoints: customer.loyaltyPoints,
      preferences: customer.preferences,
      memberSince: customer.createdAt,
      statistics: {
        totalBookings: bookingStats?.total_bookings || 0,
        completedBookings: bookingStats?.completed_bookings || 0,
        pendingBookings: bookingStats?.pending_bookings || 0,
        cancelledBookings: bookingStats?.cancelled_bookings || 0,
        favoriteSuppliers: favoritesResult?.favorites_count || 0
      },
      language: user.preferredLanguage,
      emailVerified: user.emailVerified,
      phoneVerified: user.phoneVerified
    };

    return jsonSuccess(c, customerData, 'Customer profile retrieved successfully');

  } catch (error) {
    console.error('Get customer profile error:', error);
    return jsonError(c, 'Failed to retrieve profile', 'An error occurred while fetching the profile', 500);
  }
});

/**
 * Delete customer account.
 */
customers.delete('/:id', validateUUID('id'), async (c) => {
  const customerId = c.req.param('id') as string;
  const userId = c.get('userId');
  const userType = c.get('userType');

  if (userType !== 'admin' && userId !== customerId) {
    return jsonError(c, 'Access denied', 'You can only delete your own customer account', 403);
  }

  try {
    const user = await getUserById(customerId, c.env.DB);
    if (!user || user.userType !== 'customer') {
      return jsonError(c, 'Customer not found', 'The requested customer does not exist', 404);
    }

    const deletedAt = Date.now();
    await updateUser(customerId, {
      status: 'suspended',
      email: `deleted_${deletedAt}_${user.email}`,
      phone: `deleted_${deletedAt}_${user.phone}`
    }, c.env.DB);

    await c.env.ANALYTICS_QUEUE.send({
      eventType: 'account_deletion',
      userId: customerId,
      properties: {
        userType: user.userType,
        accountAge: new Date().getTime() - new Date(user.createdAt).getTime(),
        source: 'customers_route'
      },
      timestamp: new Date().toISOString()
    });

    return jsonSuccess(c, { deleted: true }, 'Customer account deleted successfully');

  } catch (error) {
    console.error('Delete customer account error:', error);
    return jsonError(c, 'Failed to delete account', 'An error occurred while deleting the customer account', 500);
  }
});

/**
 * Get customer booking history
 */
customers.get('/:id/bookings', validateUUID('id'), validatePagination(), async (c) => {
  const customerId = c.req.param('id') as string;
  const userId = c.get('userId');
  const { page, limit } = c.get('validatedQuery');
  
  // Ensure customer can only access their own bookings
  if (userId !== customerId) {
    return jsonError(c, 'Access denied', 'You can only access your own bookings', 403);
  }

  try {
    // Get total count
    const countResult = await c.env.DB.prepare(`
      SELECT COUNT(*) as total 
      FROM bookings 
      WHERE customer_id = ?
    `).bind(customerId).first();
    
    const total = countResult?.total as number || 0;

    // Get bookings with pagination
    const offset = (page - 1) * limit;
    const bookingsResult = await c.env.DB.prepare(`
      SELECT 
        b.id, b.status, b.scheduled_at, b.duration, b.total_amount, 
        b.currency, b.notes, b.created_at, b.updated_at,
        ss.title as service_title, ss.description as service_description,
        sp.display_name as supplier_name, sp.profile_images as supplier_images
      FROM bookings b
      JOIN supplier_services ss ON b.service_id = ss.id
      JOIN supplier_profiles sp ON b.supplier_id = sp.user_id
      WHERE b.customer_id = ?
      ORDER BY b.created_at DESC
      LIMIT ? OFFSET ?
    `).bind(customerId, limit, offset).all();

    const bookings = bookingsResult.results?.map((booking: any) => ({
      id: booking.id,
      status: booking.status,
      scheduledAt: booking.scheduled_at,
      duration: booking.duration,
      totalAmount: booking.total_amount,
      currency: booking.currency,
      notes: booking.notes,
      createdAt: booking.created_at,
      updatedAt: booking.updated_at,
      service: {
        title: booking.service_title,
        description: booking.service_description
      },
      supplier: {
        name: booking.supplier_name,
        profileImage: JSON.parse(booking.supplier_images || '[]')[0] || null
      }
    })) || [];

    const pagination = createPagination(page, limit, total);
    return jsonPaginated(c, bookings, pagination, 'Booking history retrieved successfully');

  } catch (error) {
    console.error('Get booking history error:', error);
    return jsonError(c, 'Failed to retrieve bookings', 'An error occurred while fetching booking history', 500);
  }
});

/**
 * Create new booking
 */
customers.post('/:id/bookings', 
  validateUUID('id'), 
  zValidator('json', bookingSchema),
  async (c) => {
    const customerId = c.req.param('id') as string;
    const userId = c.get('userId');
    const bookingData = c.req.valid('json');
    
    // Ensure customer can only create bookings for themselves
    if (userId !== customerId) {
      return jsonError(c, 'Access denied', 'You can only create bookings for yourself', 403);
    }

    try {
      // Validate service exists and is active
      const service = await c.env.DB.prepare(`
        SELECT ss.*, sp.user_id as supplier_id
        FROM supplier_services ss
        JOIN supplier_profiles sp ON ss.supplier_id = sp.user_id
        WHERE ss.id = ? AND ss.is_active = TRUE
          AND COALESCE(sp.subscription_status, 'active') = 'active'
      `).bind(bookingData.serviceId).first();

      if (!service) {
        return jsonError(c, 'Service not found', 'The requested service is not available', 404);
      }

      // Validate scheduled time is in the future
      const scheduledTime = new Date(bookingData.scheduledAt);
      if (scheduledTime <= new Date()) {
        return jsonError(c, 'Invalid schedule', 'Booking time must be in the future', 400);
      }

      // Check for conflicts (simplified - would be more complex in real implementation)
      const conflictCheck = await c.env.DB.prepare(`
        SELECT COUNT(*) as conflicts
        FROM bookings 
        WHERE supplier_id = ? 
          AND status IN ('pending', 'confirmed')
          AND datetime(scheduled_at) = datetime(?)
      `).bind(service.supplier_id, bookingData.scheduledAt).first();

      if ((conflictCheck?.conflicts as number) > 0) {
        return jsonError(c, 'Time slot unavailable', 'The selected time slot is already booked', 409);
      }

      const bookingId = crypto.randomUUID();
      const totalAmount = service.price_min; // Simplified pricing

      // Create booking
      await c.env.DB.prepare(`
        INSERT INTO bookings 
        (id, customer_id, supplier_id, service_id, status, scheduled_at, 
         duration, total_amount, currency, notes, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        bookingId,
        customerId,
        service.supplier_id,
        bookingData.serviceId,
        'pending',
        bookingData.scheduledAt,
        bookingData.duration,
        totalAmount,
        service.currency,
        bookingData.notes || null,
        new Date().toISOString(),
        new Date().toISOString()
      ).run();

      // Track booking creation
      await c.env.ANALYTICS_QUEUE.send({
        eventType: 'booking_created',
        userId: customerId,
        properties: { 
          bookingId,
          supplierId: service.supplier_id,
          serviceId: bookingData.serviceId,
          amount: totalAmount,
          duration: bookingData.duration
        },
        timestamp: new Date().toISOString()
      });

      // Send notification to supplier (via queue)
      await c.env.MODERATION_QUEUE.send({
        type: 'booking_notification',
        supplierId: service.supplier_id,
        bookingId,
        customerId,
        scheduledAt: bookingData.scheduledAt
      });

      return jsonSuccess(c, { 
        bookingId,
        status: 'pending',
        totalAmount,
        currency: service.currency
      }, 'Booking created successfully', 201);

    } catch (error) {
      console.error('Create booking error:', error);
      return jsonError(c, 'Booking failed', 'An error occurred while creating the booking', 500);
    }
  }
);

/**
 * Get favorite suppliers
 */
customers.get('/:id/favorites', validateUUID('id'), validatePagination(), async (c) => {
  const customerId = c.req.param('id') as string;
  const userId = c.get('userId');
  const { page, limit } = c.get('validatedQuery');
  
  // Ensure customer can only access their own favorites
  if (userId !== customerId) {
    return jsonError(c, 'Access denied', 'You can only access your own favorites', 403);
  }

  try {
    const customer = await getCustomerProfile(customerId, c.env.DB);
    if (!customer) {
      return jsonError(c, 'Customer not found', 'Customer profile does not exist', 404);
    }

    const favoriteSupplierIds = customer.preferences?.favoriteSuppliers || [];
    
    if (favoriteSupplierIds.length === 0) {
      return jsonPaginated(c, [], createPagination(page, limit, 0), 'No favorite suppliers found');
    }

    // Get favorite suppliers with pagination
    const offset = (page - 1) * limit;
    const placeholders = favoriteSupplierIds.map(() => '?').join(',');
    
    const suppliersResult = await c.env.DB.prepare(`
      SELECT 
        sp.user_id as id, sp.display_name, sp.bio, sp.profile_images,
        sp.categories, sp.rating_average, sp.rating_count, sp.verification_status
      FROM supplier_profiles sp
      WHERE sp.user_id IN (${placeholders})
        AND COALESCE(sp.subscription_status, 'active') = 'active'
      ORDER BY sp.rating_average DESC
      LIMIT ? OFFSET ?
    `).bind(...favoriteSupplierIds, limit, offset).all();

    const favorites = suppliersResult.results?.map((supplier: any) => ({
      id: supplier.id,
      displayName: supplier.display_name,
      bio: supplier.bio,
      profileImages: JSON.parse(supplier.profile_images || '[]'),
      categories: JSON.parse(supplier.categories || '[]'),
      rating: {
        average: supplier.rating_average || 0,
        count: supplier.rating_count || 0
      },
      verificationStatus: supplier.verification_status
    })) || [];

    const pagination = createPagination(page, limit, favoriteSupplierIds.length);
    return jsonPaginated(c, favorites, pagination, 'Favorite suppliers retrieved successfully');

  } catch (error) {
    console.error('Get favorites error:', error);
    return jsonError(c, 'Failed to retrieve favorites', 'An error occurred while fetching favorite suppliers', 500);
  }
});

/**
 * Add supplier to favorites
 */
customers.post('/:id/favorites/:supplierId', 
  validateUUID('id'), 
  validateUUID('supplierId'),
  async (c) => {
    const customerId = c.req.param('id') as string;
    const supplierId = c.req.param('supplierId') as string;
    const userId = c.get('userId');
    
    // Ensure customer can only modify their own favorites
    if (userId !== customerId) {
      return jsonError(c, 'Access denied', 'You can only modify your own favorites', 403);
    }

    try {
      // Verify supplier exists
      const supplier = await c.env.DB.prepare(`
        SELECT user_id FROM supplier_profiles WHERE user_id = ?
      `).bind(supplierId).first();

      if (!supplier) {
        return jsonError(c, 'Supplier not found', 'The requested supplier does not exist', 404);
      }

      const customer = await getCustomerProfile(customerId, c.env.DB);
      if (!customer) {
        return jsonError(c, 'Customer not found', 'Customer profile does not exist', 404);
      }

      const currentFavorites = customer.preferences?.favoriteSuppliers || [];
      
      if (currentFavorites.includes(supplierId)) {
        return jsonError(c, 'Already favorited', 'Supplier is already in your favorites', 409);
      }

      const updatedFavorites = [...currentFavorites, supplierId];
      const updatedPreferences = {
        ...customer.preferences,
        favoriteSuppliers: updatedFavorites
      };

      // Update customer preferences
      await c.env.DB.prepare(`
        UPDATE customer_profiles 
        SET preferences = ?, updated_at = ? 
        WHERE user_id = ?
      `).bind(
        JSON.stringify(updatedPreferences),
        new Date().toISOString(),
        customerId
      ).run();

      // Track favorite addition
      await c.env.ANALYTICS_QUEUE.send({
        eventType: 'supplier_favorited',
        userId: customerId,
        properties: { supplierId },
        timestamp: new Date().toISOString()
      });

      return jsonSuccess(c, { 
        added: true,
        totalFavorites: updatedFavorites.length 
      }, 'Supplier added to favorites');

    } catch (error) {
      console.error('Add favorite error:', error);
      return jsonError(c, 'Failed to add favorite', 'An error occurred while adding to favorites', 500);
    }
  }
);

/**
 * Submit review for completed booking
 */
customers.post('/:id/reviews', 
  validateUUID('id'), 
  zValidator('json', reviewSchema),
  async (c) => {
    const customerId = c.req.param('id') as string;
    const userId = c.get('userId');
    const reviewData = c.req.valid('json');
    
    // Ensure customer can only submit reviews for themselves
    if (userId !== customerId) {
      return jsonError(c, 'Access denied', 'You can only submit reviews for yourself', 403);
    }

    try {
      // Verify booking exists and is completed
      const booking = await c.env.DB.prepare(`
        SELECT b.*, sp.user_id as supplier_id
        FROM bookings b
        JOIN supplier_services ss ON b.service_id = ss.id
        JOIN supplier_profiles sp ON ss.supplier_id = sp.user_id
        WHERE b.id = ? AND b.customer_id = ? AND b.status = 'completed'
      `).bind(reviewData.bookingId, customerId).first();

      if (!booking) {
        return jsonError(c, 'Booking not found', 'Booking not found or not completed', 404);
      }

      // Check if review already exists
      const existingReview = await c.env.DB.prepare(`
        SELECT id FROM reviews WHERE booking_id = ? AND reviewer_id = ?
      `).bind(reviewData.bookingId, customerId).first();

      if (existingReview) {
        return jsonError(c, 'Review exists', 'You have already reviewed this booking', 409);
      }

      const reviewId = crypto.randomUUID();

      // Create review
      await c.env.DB.prepare(`
        INSERT INTO reviews 
        (id, booking_id, reviewer_id, reviewee_id, rating, comment, 
         is_public, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        reviewId,
        reviewData.bookingId,
        customerId,
        booking.supplier_id,
        reviewData.rating,
        reviewData.comment || null,
        reviewData.isPublic,
        new Date().toISOString(),
        new Date().toISOString()
      ).run();

      // Update supplier rating
      const ratingUpdate = await c.env.DB.prepare(`
        UPDATE supplier_profiles 
        SET rating_average = (
          SELECT AVG(rating) FROM reviews WHERE reviewee_id = ?
        ),
        rating_count = (
          SELECT COUNT(*) FROM reviews WHERE reviewee_id = ?
        )
        WHERE user_id = ?
      `).bind(booking.supplier_id, booking.supplier_id, booking.supplier_id).run();

      // Track review submission
      await c.env.ANALYTICS_QUEUE.send({
        eventType: 'review_submitted',
        userId: customerId,
        properties: { 
          reviewId,
          supplierId: booking.supplier_id,
          rating: reviewData.rating,
          hasComment: !!reviewData.comment
        },
        timestamp: new Date().toISOString()
      });

      return jsonSuccess(c, { 
        reviewId,
        submitted: true 
      }, 'Review submitted successfully', 201);

    } catch (error) {
      console.error('Submit review error:', error);
      return jsonError(c, 'Review submission failed', 'An error occurred while submitting the review', 500);
    }
  }
);

export { customers as customerRoutes };
