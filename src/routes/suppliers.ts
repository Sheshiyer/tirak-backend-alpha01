import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import {
  supplierSearchSchema,
  supplierProfileSchema,
  serviceSchema,
  serviceUpdateSchema
} from '../utils/validation';
import { validateUUID, validatePagination } from '../middleware/validation';
import { authMiddleware, supplierOnly, optionalAuthMiddleware } from '../middleware/auth';
import { createRateLimit } from '../middleware/rateLimit';
import { 
  getUserById, 
  getSupplierProfile, 
  buildWhereClause, 
  paginateQuery 
} from '../utils/database';
import { jsonSuccess, jsonError, jsonPaginated, createPagination } from '../utils/response';
import type { Env, Variables } from '../index';

const suppliers = new Hono<{ Bindings: Env; Variables: Variables }>();

// Apply rate limiting
suppliers.use('*', createRateLimit('search'));

/**
 * Search suppliers with advanced filtering
 */
suppliers.get('/search', zValidator('query', supplierSearchSchema), optionalAuthMiddleware, async (c) => {
  const { region, category, priceMin, priceMax, language, page, limit, sortBy, sortOrder } = c.req.valid('query');
  
  try {
    // Build base query
    let query = `
      SELECT 
        sp.user_id as id,
        sp.display_name,
        sp.bio,
        sp.profile_images,
        sp.categories,
        sp.regions,
        sp.spoken_languages,
        sp.rating_average,
        sp.rating_count,
        sp.verification_status,
        sp.subscription_status,
        sp.created_at,
        MIN(ss.price_min) as min_price,
        MAX(ss.price_max) as max_price
      FROM supplier_profiles sp
      LEFT JOIN supplier_services ss ON sp.user_id = ss.supplier_id AND ss.is_active = TRUE
      WHERE sp.subscription_status = 'active' 
        AND sp.verification_status = 'verified'
    `;

    const queryParams: any[] = [];

    // Add filters
    if (region) {
      query += ` AND JSON_EXTRACT(sp.regions, '$') LIKE ?`;
      queryParams.push(`%"${region}"%`);
    }

    if (category) {
      query += ` AND JSON_EXTRACT(sp.categories, '$') LIKE ?`;
      queryParams.push(`%"${category}"%`);
    }

    if (language) {
      query += ` AND JSON_EXTRACT(sp.spoken_languages, '$') LIKE ?`;
      queryParams.push(`%"${language}"%`);
    }

    // Group by supplier
    query += ` GROUP BY sp.user_id`;

    // Add price filtering after grouping
    if (priceMin !== undefined) {
      query += ` HAVING min_price >= ?`;
      queryParams.push(priceMin);
    }

    if (priceMax !== undefined) {
      query += ` ${priceMin !== undefined ? 'AND' : 'HAVING'} max_price <= ?`;
      queryParams.push(priceMax);
    }

    // Add sorting
    const sortColumn = sortBy === 'rating' ? 'sp.rating_average' :
                      sortBy === 'price' ? 'min_price' :
                      sortBy === 'distance' ? 'sp.created_at' : // Placeholder for distance
                      'sp.created_at';
    
    query += ` ORDER BY ${sortColumn} ${sortOrder.toUpperCase()}`;

    // Get total count for pagination
    const countQuery = `
      SELECT COUNT(*) as total FROM (${query})
    `;
    
    const countResult = await c.env.DB.prepare(countQuery).bind(...queryParams).first();
    const total = countResult?.total as number || 0;

    // Add pagination
    const { query: paginatedQuery, offset } = paginateQuery(query, page, limit);
    queryParams.push(limit, offset);

    // Execute search
    const results = await c.env.DB.prepare(paginatedQuery).bind(...queryParams).all();

    // Transform results
    const suppliers = results.results?.map((row: any) => ({
      id: row.id,
      displayName: row.display_name,
      bio: row.bio,
      profileImages: JSON.parse(row.profile_images || '[]'),
      categories: JSON.parse(row.categories || '[]'),
      regions: JSON.parse(row.regions || '[]'),
      spokenLanguages: JSON.parse(row.spoken_languages || '[]'),
      rating: {
        average: row.rating_average || 0,
        count: row.rating_count || 0
      },
      verificationStatus: row.verification_status,
      priceRange: {
        min: row.min_price,
        max: row.max_price,
        currency: 'THB'
      },
      memberSince: row.created_at
    })) || [];

    // Cache results for 5 minutes
    const cacheKey = `search:${JSON.stringify(c.req.query())}`;
    await c.env.CACHE.put(cacheKey, JSON.stringify({ suppliers, total }), { expirationTtl: 300 });

    // Track search event
    const userId = c.get('userId');
    if (userId && c.env.ANALYTICS_QUEUE && typeof c.env.ANALYTICS_QUEUE.send === 'function') {
      await c.env.ANALYTICS_QUEUE.send({
        eventType: 'supplier_search',
        userId,
        properties: { 
          filters: { region, category, priceMin, priceMax, language },
          resultsCount: suppliers.length,
          page
        },
        timestamp: new Date().toISOString()
      });
    }

    const pagination = createPagination(page, limit, total);
    return jsonPaginated(c, suppliers, pagination, 'Suppliers retrieved successfully');

  } catch (error) {
    console.error('Supplier search error:', error);
    return jsonError(c, 'Search failed', 'An error occurred while searching suppliers', 500);
  }
});

/**
 * Get supplier statistics and performance metrics
 * Accessible to both suppliers and companions
 */
suppliers.get('/stats', authMiddleware, async (c) => {
  const userId = c.get('userId');
  const userType = c.get('userType');
  
  // Ensure userId is defined
  if (!userId) {
    return jsonError(c, 'Authentication error', 'User ID not found', 401);
  }
  
  // Check user type - only suppliers and companions can access
  if (userType !== 'supplier' && userType !== 'companion') {
    return jsonError(c, 'Access denied', 'Only suppliers and companions can access stats', 403);
  }
  
  try {
    // Get user info
    const user = await getUserById(userId, c.env.DB);
    if (!user) {
      return jsonError(c, 'User not found', 'User does not exist', 404);
    }

    // Get profile based on user type
    let profile;
    let displayName;
    let ratingAverage = 0;
    let ratingCount = 0;
    
    if (userType === 'supplier') {
      const supplierProfile = await getSupplierProfile(userId, c.env.DB);
      if (!supplierProfile) {
        return jsonError(c, 'Supplier not found', 'Supplier profile does not exist', 404);
      }
      profile = supplierProfile;
      displayName = supplierProfile.displayName;
      ratingAverage = supplierProfile.ratingAverage || 0;
      ratingCount = supplierProfile.ratingCount || 0;
    } else if (userType === 'companion') {
      // Get companion profile
      const companionProfile = await c.env.DB.prepare(`
        SELECT * FROM companion_profiles WHERE user_id = ?
      `).bind(userId).first() as Record<string, any>;
      
      if (!companionProfile) {
        return jsonError(c, 'Companion not found', 'Companion profile does not exist', 404);
      }
      
      profile = companionProfile;
      displayName = companionProfile.display_name as string;
      ratingAverage = Number(companionProfile.rating_average || 0);
      ratingCount = Number(companionProfile.rating_count || 0);
    } else {
      return jsonError(c, 'Invalid user type', 'Only suppliers and companions can access stats', 403);
    }

    // Calculate profile image
    let profileImage = null;
    if (userType === 'supplier' && profile) {
      profileImage = profile.profileImages?.[0] || null;
    } else if (userType === 'companion' && profile) {
      profileImage = (profile as any).profile_photo || null;
    }

    // Get booking statistics
    const bookingStats = await c.env.DB.prepare(`
      SELECT 
        COUNT(*) as total_bookings,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed_bookings,
        SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) as cancelled_bookings,
        SUM(CASE WHEN status = 'completed' THEN total_amount - service_fee ELSE 0 END) as total_earnings,
        SUM(CASE WHEN status = 'completed' AND date >= strftime('%Y-%m-01', 'now') THEN total_amount - service_fee ELSE 0 END) as this_month_earnings,
        SUM(CASE WHEN status = 'completed' AND date >= strftime('%Y-%m-01', datetime('now', '-1 month')) AND date < strftime('%Y-%m-01', 'now') THEN total_amount - service_fee ELSE 0 END) as last_month_earnings
      FROM bookings
      WHERE companion_id = ?
    `).bind(userId).first();

    // Get response rate
    const responseStats = await c.env.DB.prepare(`
      SELECT 
        COUNT(*) as total_requests,
        SUM(CASE WHEN status IN ('confirmed', 'completed', 'in_progress') THEN 1 ELSE 0 END) as accepted_requests
      FROM bookings
      WHERE companion_id = ?
    `).bind(userId).first();

    const totalRequests = responseStats?.total_requests ? Number(responseStats.total_requests) : 0;
    const acceptedRequests = responseStats?.accepted_requests ? Number(responseStats.accepted_requests) : 0;
    const responseRate = totalRequests > 0 ? Math.round((acceptedRequests / totalRequests) * 100) : 0;

    // Get profile views
    const viewsResult = await c.env.DB.prepare(`
      SELECT COUNT(*) as view_count
      FROM analytics_events
      WHERE event_type = 'supplier_profile_view' AND JSON_EXTRACT(properties, '$.supplierId') = ?
    `).bind(userId).first();

    const profileViews = viewsResult?.view_count ? Number(viewsResult.view_count) : 0;

    // Get average response time in hours
    const responseTimeResult = await c.env.DB.prepare(`
      SELECT AVG((julianday(updated_at) - julianday(created_at)) * 24 * 60 / 60) as avg_response_time
      FROM bookings
      WHERE companion_id = ? AND status != 'pending'
    `).bind(userId).first();

    const responseTime = responseTimeResult?.avg_response_time ? Number(responseTimeResult.avg_response_time) : 0;

    // Get monthly stats for the last 6 months
    const monthlyStatsResult = await c.env.DB.prepare(`
      SELECT 
        strftime('%Y-%m', date) as month,
        COUNT(*) as bookings,
        SUM(CASE WHEN status = 'completed' THEN total_amount - service_fee ELSE 0 END) as earnings,
        AVG(CASE WHEN status = 'completed' THEN rating ELSE NULL END) as rating
      FROM bookings
      LEFT JOIN reviews ON bookings.id = reviews.booking_id
      WHERE companion_id = ?
      AND date >= date('now', '-6 months')
      GROUP BY strftime('%Y-%m', date)
      ORDER BY month ASC
    `).bind(userId).all();

    const monthlyStats = monthlyStatsResult.results?.map((stat: any) => ({
      month: stat.month,
      bookings: stat.bookings,
      earnings: stat.earnings || 0,
      rating: stat.rating || 0
    })) || [];

    // Get weekly stats for the last 4 weeks
    const weeklyStatsResult = await c.env.DB.prepare(`
      SELECT 
        strftime('%Y-%W', date) as week,
        COUNT(*) as bookings,
        SUM(CASE WHEN status = 'completed' THEN total_amount - service_fee ELSE 0 END) as earnings,
        AVG(CASE WHEN status = 'completed' THEN rating ELSE NULL END) as rating
      FROM bookings
      LEFT JOIN reviews ON bookings.id = reviews.booking_id
      WHERE companion_id = ?
      AND date >= date('now', '-28 days')
      GROUP BY strftime('%Y-%W', date)
      ORDER BY week ASC
    `).bind(userId).all();

    const weeklyStats = weeklyStatsResult.results?.map((stat: any) => ({
      week: stat.week,
      bookings: stat.bookings,
      earnings: stat.earnings || 0,
      rating: stat.rating || 0
    })) || [];

    // Get quarterly stats for the last 4 quarters
    const quarterlyStatsResult = await c.env.DB.prepare(`
      SELECT 
        substr(strftime('%Y', date), 1, 4) || '-Q' || ((cast(strftime('%m', date) as integer) + 2) / 3) as quarter,
        COUNT(*) as bookings,
        SUM(CASE WHEN status = 'completed' THEN total_amount - service_fee ELSE 0 END) as earnings,
        AVG(CASE WHEN status = 'completed' THEN rating ELSE NULL END) as rating
      FROM bookings
      LEFT JOIN reviews ON bookings.id = reviews.booking_id
      WHERE companion_id = ?
      AND date >= date('now', '-12 months')
      GROUP BY substr(strftime('%Y', date), 1, 4) || '-Q' || ((cast(strftime('%m', date) as integer) + 2) / 3)
      ORDER BY substr(strftime('%Y', date), 1, 4), ((cast(strftime('%m', date) as integer) + 2) / 3) ASC
    `).bind(userId).all();

    const quarterStats = quarterlyStatsResult.results?.map((stat: any) => ({
      quarter: stat.quarter,
      bookings: stat.bookings,
      earnings: stat.earnings || 0,
      rating: stat.rating || 0
    })) || [];

    // Get service performance
    const servicePerformanceResult = await c.env.DB.prepare(`
      SELECT 
        s.title as service_name,
        COUNT(b.id) as booking_count,
        AVG(r.rating) as avg_rating,
        SUM(CASE WHEN b.status = 'completed' THEN b.total_amount - b.service_fee ELSE 0 END) as total_earnings
      FROM bookings b
      JOIN supplier_services s ON b.service_id = s.id
      LEFT JOIN reviews r ON b.id = r.booking_id
      WHERE b.companion_id = ?
      GROUP BY s.id
      ORDER BY total_earnings DESC
      LIMIT 3
    `).bind(userId).all();

    const servicePerformance = servicePerformanceResult.results?.map((service: any) => ({
      name: service.service_name,
      bookings: service.booking_count,
      rating: service.avg_rating || 0,
      earnings: service.total_earnings || 0
    })) || [];

      // Calculate profile completion percentage
    const profileCompletion = (() => {
      let total = 0;
      let completed = 0;
      
      if (userType === 'supplier' && profile) {
        const supplierProfile = profile as any;
        // Check supplier profile fields
        if (supplierProfile.displayName) completed++;
        total++;
        
        if (supplierProfile.bio) completed++;
        total++;
        
        if (supplierProfile.profileImages && supplierProfile.profileImages.length > 0) completed++;
        total++;
        
        if (supplierProfile.categories && supplierProfile.categories.length > 0) completed++;
        total++;
        
        if (supplierProfile.regions && supplierProfile.regions.length > 0) completed++;
        total++;
        
        if (supplierProfile.spokenLanguages && supplierProfile.spokenLanguages.length > 0) completed++;
        total++;
      } else if (userType === 'companion' && profile) {
        const companionProfile = profile as Record<string, any>;
        // Check companion profile fields
        if (companionProfile.display_name) completed++;
        total++;
        
        if (companionProfile.bio) completed++;
        total++;
        
        if (companionProfile.profile_images) {
          try {
            const images = JSON.parse(companionProfile.profile_images || '[]');
            if (images && images.length > 0) completed++;
          } catch (e) {}
        }
        total++;
        
        if (companionProfile.specialties) {
          try {
            const specialties = JSON.parse(companionProfile.specialties || '[]');
            if (specialties && specialties.length > 0) completed++;
          } catch (e) {}
        }
        total++;
        
        if (companionProfile.available_locations) {
          try {
            const locations = JSON.parse(companionProfile.available_locations || '[]');
            if (locations && locations.length > 0) completed++;
          } catch (e) {}
        }
        total++;
        
        if (companionProfile.languages) {
          try {
            const languages = JSON.parse(companionProfile.languages || '[]');
            if (languages && languages.length > 0) completed++;
          } catch (e) {}
        }
        total++;
      }
      
      return total > 0 ? Math.round((completed / total) * 100) : 0;
    })();

    // Format the response
    const stats = {
      totalBookings: bookingStats?.total_bookings ? Number(bookingStats.total_bookings) : 0,
      completedBookings: bookingStats?.completed_bookings ? Number(bookingStats.completed_bookings) : 0,
      cancelledBookings: bookingStats?.cancelled_bookings ? Number(bookingStats.cancelled_bookings) : 0,
      totalEarnings: bookingStats?.total_earnings ? Number(bookingStats.total_earnings) : 0,
      thisMonthEarnings: bookingStats?.this_month_earnings ? Number(bookingStats.this_month_earnings) : 0,
      lastMonthEarnings: bookingStats?.last_month_earnings ? Number(bookingStats.last_month_earnings) : 0,
      profileViews: profileViews,
      responseRate: responseRate,
      responseTime: responseTime,
      averageRating: ratingAverage,
      totalReviews: ratingCount,
      profileCompletion: profileCompletion,
      monthlyStats,
      weeklyStats,
      quarterStats,
      servicePerformance
    };

    return jsonSuccess(c, {
      user: {
        name: displayName,
        status: user.status,
        totalRatings: ratingAverage,
        totalReviews: ratingCount,
        userType: userType,
        profileImage: user.profile_image_url || profileImage
      },
      data: stats
    }, `${userType === 'supplier' ? 'Supplier' : 'Companion'} statistics retrieved successfully`);

  } catch (error) {
    console.error('Get supplier stats error:', error);
    return jsonError(c, 'Failed to retrieve statistics', 'An error occurred while fetching supplier statistics', 500);
  }
});

/**
 * Get individual supplier profile
 */
suppliers.get('/:id', validateUUID('id'), optionalAuthMiddleware, async (c) => {
  const supplierId = c.req.param('id');
  
  try {
    // Check cache first
    const cacheKey = `supplier:${supplierId}`;
    const cached = await c.env.CACHE.get(cacheKey);
    
    if (cached) {
      const supplierData = JSON.parse(cached);
      
      // Track profile view
      const userId = c.get('userId');
      if (userId && userId !== supplierId && c.env.ANALYTICS_QUEUE && typeof c.env.ANALYTICS_QUEUE.send === 'function') {
        await c.env.ANALYTICS_QUEUE.send({
          eventType: 'supplier_profile_view',
          userId,
          properties: { supplierId, source: 'cache' },
          timestamp: new Date().toISOString()
        });
      }
      
      return jsonSuccess(c, supplierData, 'Supplier profile retrieved successfully');
    }

    // Get supplier profile
    const supplier = await getSupplierProfile(supplierId, c.env.DB);
    if (!supplier) {
      return jsonError(c, 'Supplier not found', 'The requested supplier does not exist', 404);
    }

    // Get user info
    const user = await getUserById(supplierId, c.env.DB);
    if (!user || user.userType !== 'supplier') {
      return jsonError(c, 'Supplier not found', 'The requested supplier does not exist', 404);
    }

    // Get services
    const servicesResult = await c.env.DB.prepare(`
      SELECT id, title, description, price_min, price_max, currency, duration_hours, created_at
      FROM supplier_services 
      WHERE supplier_id = ? AND is_active = TRUE
      ORDER BY created_at DESC
    `).bind(supplierId).all();

    const services = servicesResult.results?.map((service: any) => ({
      id: service.id,
      title: service.title,
      description: service.description,
      priceMin: service.price_min,
      priceMax: service.price_max,
      currency: service.currency,
      durationHours: service.duration_hours,
      createdAt: service.created_at
    })) || [];

    // Get availability (placeholder - would be more complex in real implementation)
    const availability = [
      { dayOfWeek: 1, startTime: '09:00', endTime: '17:00', isAvailable: true },
      { dayOfWeek: 2, startTime: '09:00', endTime: '17:00', isAvailable: true },
      { dayOfWeek: 3, startTime: '09:00', endTime: '17:00', isAvailable: true },
      { dayOfWeek: 4, startTime: '09:00', endTime: '17:00', isAvailable: true },
      { dayOfWeek: 5, startTime: '09:00', endTime: '17:00', isAvailable: true },
      { dayOfWeek: 6, startTime: '10:00', endTime: '16:00', isAvailable: true },
      { dayOfWeek: 0, startTime: '10:00', endTime: '16:00', isAvailable: false }
    ];

    // Get recent reviews (last 10)
    const reviewsResult = await c.env.DB.prepare(`
      SELECT r.rating, r.comment, r.created_at, cp.display_name as reviewer_name
      FROM reviews r
      JOIN customer_profiles cp ON r.reviewer_id = cp.user_id
      WHERE r.reviewee_id = ? AND r.is_public = TRUE
      ORDER BY r.created_at DESC
      LIMIT 10
    `).bind(supplierId).all();

    const reviews = reviewsResult.results?.map((review: any) => ({
      rating: review.rating,
      comment: review.comment,
      createdAt: review.created_at,
      reviewerName: review.reviewer_name
    })) || [];

    const supplierData = {
      id: supplier.userId,
      displayName: supplier.displayName,
      bio: supplier.bio,
      profileImages: supplier.profileImages,
      categories: supplier.categories,
      regions: supplier.regions,
      spokenLanguages: supplier.spokenLanguages,
      rating: {
        average: supplier.ratingAverage,
        count: supplier.ratingCount
      },
      verificationStatus: supplier.verificationStatus,
      subscriptionStatus: supplier.subscriptionStatus,
      services,
      availability,
      reviews,
      memberSince: supplier.createdAt,
      responseTime: '< 1 hour', // Placeholder
      languages: user.preferredLanguage
    };

    // Cache for 10 minutes
    await c.env.CACHE.put(cacheKey, JSON.stringify(supplierData), { expirationTtl: 600 });

    // Track profile view
    const userId = c.get('userId');
    if (userId && userId !== supplierId && c.env.ANALYTICS_QUEUE && typeof c.env.ANALYTICS_QUEUE.send === 'function') {
      await c.env.ANALYTICS_QUEUE.send({
        eventType: 'supplier_profile_view',
        userId,
        properties: { supplierId, source: 'database' },
        timestamp: new Date().toISOString()
      });
    }

    return jsonSuccess(c, supplierData, 'Supplier profile retrieved successfully');

  } catch (error) {
    console.error('Get supplier profile error:', error);
    return jsonError(c, 'Failed to retrieve profile', 'An error occurred while fetching the supplier profile', 500);
  }
});

/**
 * Update supplier profile (supplier only)
 */
suppliers.put('/:id', 
  validateUUID('id'), 
  authMiddleware, 
  supplierOnly,
  zValidator('json', supplierProfileSchema),
  async (c) => {
    const supplierId = c.req.param('id');
    const userId = c.get('userId');
    const updates = c.req.valid('json');
    
    // Ensure supplier can only update their own profile
    if (userId !== supplierId) {
      return jsonError(c, 'Access denied', 'You can only update your own profile', 403);
    }

    try {
      const supplier = await getSupplierProfile(supplierId, c.env.DB);
      if (!supplier) {
        return jsonError(c, 'Supplier not found', 'Supplier profile does not exist', 404);
      }

      // Update supplier profile
      await c.env.DB.prepare(`
        UPDATE supplier_profiles 
        SET display_name = ?, bio = ?, categories = ?, regions = ?, 
            spoken_languages = ?, profile_images = ?, updated_at = ?
        WHERE user_id = ?
      `).bind(
        updates.displayName,
        updates.bio || null,
        JSON.stringify(updates.categories),
        JSON.stringify(updates.regions),
        JSON.stringify(updates.spokenLanguages),
        JSON.stringify(updates.profileImages || []),
        new Date().toISOString(),
        supplierId
      ).run();

      // Clear cache
      await c.env.CACHE.delete(`supplier:${supplierId}`);

      // Track profile update
      if (c.env.ANALYTICS_QUEUE && typeof c.env.ANALYTICS_QUEUE.send === 'function') {
        await c.env.ANALYTICS_QUEUE.send({
          eventType: 'supplier_profile_update',
          userId: supplierId,
          properties: { 
            updatedFields: Object.keys(updates),
            categoriesCount: updates.categories.length,
            regionsCount: updates.regions.length
          },
          timestamp: new Date().toISOString()
        });
      }

      return jsonSuccess(c, { updated: true }, 'Supplier profile updated successfully');

    } catch (error) {
      console.error('Update supplier profile error:', error);
      return jsonError(c, 'Update failed', 'An error occurred while updating the profile', 500);
    }
  }
);

/**
 * Get supplier services
 */
suppliers.get('/:id/services', validateUUID('id'), validatePagination(), async (c) => {
  const supplierId = c.req.param('id');
  const { page = '1', limit = '20' } = c.req.query();
  const pageNum = Number(page) || 1;
  const limitNum = Number(limit) || 20;
  
  try {
    // Get total count
    const countResult = await c.env.DB.prepare(`
      SELECT COUNT(*) as total 
      FROM supplier_services 
      WHERE supplier_id = ? AND is_active = TRUE
    `).bind(supplierId).first();
    
    const total = countResult?.total as number || 0;

    // Get services with pagination
    const offset = (pageNum - 1) * limitNum;
    const servicesResult = await c.env.DB.prepare(`
      SELECT id, title, description, price_min, price_max, currency, 
             duration_hours, is_active, created_at, updated_at
      FROM supplier_services 
      WHERE supplier_id = ? AND is_active = TRUE
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `).bind(supplierId, limitNum, offset).all();

    const services = servicesResult.results?.map((service: any) => ({
      id: service.id,
      title: service.title,
      description: service.description,
      priceMin: service.price_min,
      priceMax: service.price_max,
      currency: service.currency,
      durationHours: service.duration_hours,
      isActive: Boolean(service.is_active),
      createdAt: service.created_at,
      updatedAt: service.updated_at
    })) || [];

    const pagination = createPagination(pageNum, limitNum, total);
    return jsonPaginated(c, services, pagination, 'Services retrieved successfully');

  } catch (error) {
    console.error('Get supplier services error:', error);
    return jsonError(c, 'Failed to retrieve services', 'An error occurred while fetching services', 500);
  }
});

/**
 * Create new service (supplier and companion only)
 */
suppliers.post('/:id/services', 
  validateUUID('id'), 
  authMiddleware, 
  zValidator('json', serviceSchema),
  async (c) => {
    const supplierId = c.req.param('id');
    const userId = c.get('userId');
    const userType = c.get('userType');
    const serviceData = c.req.valid('json');
    
    // Only suppliers and companions can create services
    if (userType !== 'supplier' && userType !== 'companion') {
      return jsonError(c, 'Access denied', 'Only suppliers and companions can create services', 403);
    }
    
    // Ensure user can only create services for themselves
    if (userId !== supplierId) {
      return jsonError(c, 'Access denied', 'You can only create services for your own profile', 403);
    }

    try {
      const serviceId = crypto.randomUUID();
      
      await c.env.DB.prepare(`
        INSERT INTO supplier_services 
        (id, supplier_id, title, description, price_min, price_max, 
         currency, duration_hours, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        serviceId,
        supplierId,
        serviceData.title,
        serviceData.description || null,
        serviceData.priceMin,
        serviceData.priceMax,
        serviceData.currency,
        serviceData.durationHours,
        new Date().toISOString(),
        new Date().toISOString()
      ).run();

      // Clear supplier cache
      await c.env.CACHE.delete(`supplier:${supplierId}`);

      // Track service creation
      if (c.env.ANALYTICS_QUEUE && typeof c.env.ANALYTICS_QUEUE.send === 'function') {
        await c.env.ANALYTICS_QUEUE.send({
          eventType: 'service_created',
          userId: supplierId,
          properties: { 
            serviceId,
            priceRange: `${serviceData.priceMin}-${serviceData.priceMax}`,
            duration: serviceData.durationHours
          },
          timestamp: new Date().toISOString()
        });
      }

      return jsonSuccess(c, { 
        serviceId,
        created: true 
      }, 'Service created successfully', 201);

    } catch (error) {
      console.error('Create service error:', error);
      return jsonError(c, 'Failed to create service', 'An error occurred while creating the service', 500);
    }
  }
);

/**
 * Update service (supplier and companion only)
 */
suppliers.put('/services/:serviceId', 
  validateUUID('serviceId'), 
  authMiddleware, 
  zValidator('json', serviceUpdateSchema),
  async (c) => {
    const serviceId = c.req.param('serviceId');
    const userId = c.get('userId');
    const userType = c.get('userType');
    const updates = c.req.valid('json');
    
    // Only suppliers and companions can update services
    if (userType !== 'supplier' && userType !== 'companion') {
      return jsonError(c, 'Access denied', 'Only suppliers and companions can update services', 403);
    }
    
    try {
      // Check if service exists and belongs to the supplier
      const serviceResult = await c.env.DB.prepare(`
        SELECT id, supplier_id, title, description, price_min, price_max, 
               currency, duration_hours, is_active, created_at, updated_at
        FROM supplier_services 
        WHERE id = ? AND supplier_id = ?
      `).bind(serviceId, userId).first();

      if (!serviceResult) {
        return jsonError(c, 'Service not found', 'Service does not exist or you do not have permission to update it', 404);
      }

      // Build update query dynamically
      const updateFields = [];
      const params = [];

      if (updates.title !== undefined) {
        updateFields.push('title = ?');
        params.push(updates.title);
      }

      if (updates.description !== undefined) {
        updateFields.push('description = ?');
        params.push(updates.description);
      }

      if (updates.priceMin !== undefined) {
        updateFields.push('price_min = ?');
        params.push(updates.priceMin);
      }

      if (updates.priceMax !== undefined) {
        updateFields.push('price_max = ?');
        params.push(updates.priceMax);
      }

      if (updates.currency !== undefined) {
        updateFields.push('currency = ?');
        params.push(updates.currency);
      }

      if (updates.durationHours !== undefined) {
        updateFields.push('duration_hours = ?');
        params.push(updates.durationHours);
      }

      if (updates.isActive !== undefined) {
        updateFields.push('is_active = ?');
        params.push(updates.isActive ? 1 : 0);
      }

      if (updateFields.length === 0) {
        return jsonError(c, 'No updates provided', 'At least one field must be updated', 400);
      }

      updateFields.push('updated_at = ?');
      params.push(new Date().toISOString());
      params.push(serviceId);

      // Update service
      await c.env.DB.prepare(`
        UPDATE supplier_services 
        SET ${updateFields.join(', ')}
        WHERE id = ?
      `).bind(...params).run();

      // Clear supplier cache
      await c.env.CACHE.delete(`supplier:${userId}`);

      // Track service update
      if (c.env.ANALYTICS_QUEUE && typeof c.env.ANALYTICS_QUEUE.send === 'function') {
        await c.env.ANALYTICS_QUEUE.send({
          eventType: 'service_updated',
          userId: userId,
          properties: { 
            serviceId,
            updatedFields: Object.keys(updates),
            priceRange: updates.priceMin !== undefined || updates.priceMax !== undefined 
              ? `${updates.priceMin || serviceResult.price_min}-${updates.priceMax || serviceResult.price_max}`
              : undefined
          },
          timestamp: new Date().toISOString()
        });
      }

      // Get updated service data
      const updatedService = await c.env.DB.prepare(`
        SELECT id, title, description, price_min, price_max, 
               currency, duration_hours, is_active, created_at, updated_at
        FROM supplier_services 
        WHERE id = ?
      `).bind(serviceId).first();

      if (!updatedService) {
        return jsonError(c, 'Service not found', 'Service was not found after update', 404);
      }

      const service = {
        id: updatedService.id,
        title: updatedService.title,
        description: updatedService.description,
        priceMin: updatedService.price_min,
        priceMax: updatedService.price_max,
        currency: updatedService.currency,
        durationHours: updatedService.duration_hours,
        isActive: Boolean(updatedService.is_active),
        createdAt: updatedService.created_at,
        updatedAt: updatedService.updated_at
      };

      return jsonSuccess(c, { service }, 'Service updated successfully');

    } catch (error) {
      console.error('Update service error:', error);
      return jsonError(c, 'Failed to update service', 'An error occurred while updating the service', 500);
    }
  }
);

suppliers.delete('/:id', validateUUID('id'), authMiddleware, async (c) => {
  const supplierId = c.req.param('id');
  const userId = c.get('userId');
  const userType = c.get('userType');

  // Only suppliers can delete their own account
  if (userType !== 'supplier' || userId !== supplierId) {
    return jsonError(c, 'Access denied', 'You can only delete your own account', 403);
  }

  try {
    // Verify supplier exists
    const supplier = await c.env.DB.prepare(`
      SELECT user_id FROM supplier_profiles sp
      JOIN users u ON sp.user_id = u.id
      WHERE sp.user_id = ? AND u.user_type = 'supplier'
    `).bind(supplierId).first();

    if (!supplier) {
      return jsonError(c, 'Supplier not found', 'The requested supplier does not exist', 404);
    }

    // Get user info for anonymization
    const user = await getUserById(supplierId, c.env.DB);
    if (!user) {
      return jsonError(c, 'User not found', 'User account does not exist', 404);
    }

    const now = new Date().toISOString();

    try {
      // 1. Cancel any pending bookings (check for both supplier_id and companion_id)
      // First check if supplier_id column exists
      const bookingsCheck = await c.env.DB.prepare(`
        SELECT sql FROM sqlite_master WHERE type='table' AND name='bookings'
      `).first();
      
      if (bookingsCheck?.sql) {
        const hasSupplierId = (bookingsCheck.sql as string).includes('supplier_id');
        const hasCompanionId = (bookingsCheck.sql as string).includes('companion_id');
        
        if (hasSupplierId) {
          await c.env.DB.prepare(`
            UPDATE bookings 
            SET status = 'cancelled', updated_at = ?
            WHERE supplier_id = ? AND status IN ('pending', 'confirmed')
          `).bind(now, supplierId).run();
        } else if (hasCompanionId) {
          // If bookings only has companion_id, suppliers might not have bookings
          // This is fine, just skip
        }
      }
    } catch (error) {
      console.error('Error cancelling bookings:', error);
      // Continue with deletion even if booking cancellation fails
    }

    try {
      // 2. Soft delete supplier profile (update timestamp)
      await c.env.DB.prepare(`
        UPDATE supplier_profiles 
        SET updated_at = ?
        WHERE user_id = ?
      `).bind(now, supplierId).run();
    } catch (error) {
      console.error('Error updating supplier profile:', error);
      throw error; // This is critical, rethrow
    }

    try {
      // 3. Soft delete all services
      await c.env.DB.prepare(`
        UPDATE supplier_services 
        SET is_active = FALSE, updated_at = ?
        WHERE supplier_id = ?
      `).bind(now, supplierId).run();
    } catch (error) {
      console.error('Error soft deleting services:', error);
      // Continue even if services update fails
    }

    try {
      // 4. Delete availability
      await c.env.DB.prepare(`
        DELETE FROM supplier_availability 
        WHERE supplier_id = ?
      `).bind(supplierId).run();
    } catch (error) {
      console.error('Error deleting availability:', error);
      // Continue even if availability deletion fails
    }

    try {
      // 5. Delete user sessions (check if table exists)
      const sessionsCheck = await c.env.DB.prepare(`
        SELECT name FROM sqlite_master WHERE type='table' AND name='user_sessions'
      `).first();
      
      if (sessionsCheck) {
        await c.env.DB.prepare(`
          DELETE FROM user_sessions 
          WHERE user_id = ?
        `).bind(supplierId).run();
      }
    } catch (error) {
      console.error('Error deleting user sessions:', error);
      // Continue even if sessions deletion fails
    }

    try {
      // 6. Clear cache
      await c.env.CACHE.delete(`supplier:${supplierId}`);
    } catch (error) {
      console.error('Error clearing cache:', error);
      // Continue even if cache clear fails
    }

    try {
      // 7. Soft delete user account (anonymize email/phone, set status to suspended)
      // Note: Using 'suspended' instead of 'deleted' because the CHECK constraint only allows ('active', 'suspended', 'pending')
      await c.env.DB.prepare(`
        UPDATE users 
        SET status = 'suspended',
            email = ?,
            phone = ?,
            updated_at = ?
        WHERE id = ?
      `).bind(
        `deleted_${Date.now()}_${user.email}`,
        `deleted_${Date.now()}_${user.phone}`,
        now,
        supplierId
      ).run();
    } catch (error) {
      console.error('Error updating user account:', error);
      throw error; // This is critical, rethrow
    }

    // Track supplier deletion
    try {
      if (c.env.ANALYTICS_QUEUE && typeof c.env.ANALYTICS_QUEUE.send === 'function') {
        await c.env.ANALYTICS_QUEUE.send({
          eventType: 'supplier_deleted',
          userId: supplierId,
          properties: { 
            supplierId,
            deletedAt: now,
            accountAge: new Date().getTime() - new Date(user.createdAt).getTime()
          },
          timestamp: now
        });
      }
    } catch (error) {
      console.error('Error tracking deletion analytics:', error);
      // Don't fail deletion if analytics fails
    }

    return jsonSuccess(c, { 
      deleted: true 
    }, 'Supplier account deleted successfully');

  } catch (error) {
    console.error('Delete supplier error:', error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorStack = error instanceof Error ? error.stack : undefined;
    console.error('Error details:', { errorMessage, errorStack, supplierId });
    return jsonError(c, 'Failed to delete supplier', `An error occurred while deleting the supplier account: ${errorMessage}`, 500);
  }
});

export { suppliers as supplierRoutes };
