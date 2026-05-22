import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import {
  supplierSearchSchema,
  supplierProfileSchema,
  serviceSchema
} from '../utils/validation';
import { validateUUID, validatePagination } from '../middleware/validation';
import { authMiddleware, supplierOnly, optionalAuthMiddleware } from '../middleware/auth';
import { createRateLimit } from '../middleware/rateLimit';
import { 
  getUserById, 
  getSupplierProfile, 
  updateUser,
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
      WHERE COALESCE(sp.subscription_status, 'active') = 'active'
        AND COALESCE(sp.verification_status, 'pending') != 'rejected'
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
    if (userId) {
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
 * Get individual supplier profile
 */
suppliers.get('/:id', validateUUID('id'), optionalAuthMiddleware, async (c) => {
  const supplierId = c.req.param('id') as string;
  
  try {
    // Check cache first
    const cacheKey = `supplier:${supplierId}`;
    const cached = await c.env.CACHE.get(cacheKey);
    
    if (cached) {
      const supplierData = JSON.parse(cached);
      
      // Track profile view
      const userId = c.get('userId');
      if (userId && userId !== supplierId) {
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
    if (!user || !['supplier', 'companion'].includes(String(user.userType))) {
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
    if (userId && userId !== supplierId) {
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
    const supplierId = c.req.param('id') as string;
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

      return jsonSuccess(c, { updated: true }, 'Supplier profile updated successfully');

    } catch (error) {
      console.error('Update supplier profile error:', error);
      return jsonError(c, 'Update failed', 'An error occurred while updating the profile', 500);
    }
  }
);

/**
 * Delete supplier account.
 *
 * The mobile app calls /api/suppliers/:id when a local guide deletes their
 * account. Keep this as a resource alias for /api/users/:id so mobile does not
 * hit a 404 while still preserving the same soft-delete behavior.
 */
suppliers.delete('/:id', validateUUID('id'), authMiddleware, async (c) => {
  const supplierId = c.req.param('id') as string;
  const userId = c.get('userId');
  const userType = c.get('userType');

  if (userType !== 'admin' && userId !== supplierId) {
    return jsonError(c, 'Access denied', 'You can only delete your own supplier account', 403);
  }

  try {
    const user = await getUserById(supplierId, c.env.DB);
    if (!user || !['supplier', 'companion'].includes(String(user.userType))) {
      return jsonError(c, 'Supplier not found', 'The requested supplier does not exist', 404);
    }

    const deletedAt = Date.now();
    await updateUser(supplierId, {
      status: 'suspended',
      email: `deleted_${deletedAt}_${user.email}`,
      phone: `deleted_${deletedAt}_${user.phone}`
    }, c.env.DB);

    await c.env.CACHE.delete(`supplier:${supplierId}`);

    await c.env.ANALYTICS_QUEUE.send({
      eventType: 'account_deletion',
      userId: supplierId,
      properties: {
        userType: user.userType,
        accountAge: new Date().getTime() - new Date(user.createdAt).getTime(),
        source: 'suppliers_route'
      },
      timestamp: new Date().toISOString()
    });

    return jsonSuccess(c, { deleted: true }, 'Supplier account deleted successfully');

  } catch (error) {
    console.error('Delete supplier account error:', error);
    return jsonError(c, 'Failed to delete account', 'An error occurred while deleting the supplier account', 500);
  }
});

/**
 * Get supplier services
 */
suppliers.get('/:id/services', validateUUID('id'), validatePagination(), async (c) => {
  const supplierId = c.req.param('id') as string;
  const { page, limit } = c.get('validatedQuery');
  
  try {
    // Get total count
    const countResult = await c.env.DB.prepare(`
      SELECT COUNT(*) as total 
      FROM supplier_services 
      WHERE supplier_id = ? AND is_active = TRUE
    `).bind(supplierId).first();
    
    const total = countResult?.total as number || 0;

    // Get services with pagination
    const offset = (page - 1) * limit;
    const servicesResult = await c.env.DB.prepare(`
      SELECT id, title, description, price_min, price_max, currency, 
             duration_hours, is_active, created_at, updated_at
      FROM supplier_services 
      WHERE supplier_id = ? AND is_active = TRUE
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `).bind(supplierId, limit, offset).all();

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

    const pagination = createPagination(page, limit, total);
    return jsonPaginated(c, services, pagination, 'Services retrieved successfully');

  } catch (error) {
    console.error('Get supplier services error:', error);
    return jsonError(c, 'Failed to retrieve services', 'An error occurred while fetching services', 500);
  }
});

/**
 * Create new service (supplier only)
 */
suppliers.post('/:id/services', 
  validateUUID('id'), 
  authMiddleware, 
  supplierOnly,
  zValidator('json', serviceSchema),
  async (c) => {
    const supplierId = c.req.param('id') as string;
    const userId = c.get('userId');
    const serviceData = c.req.valid('json');
    
    // Ensure supplier can only create services for themselves
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

export { suppliers as supplierRoutes };
