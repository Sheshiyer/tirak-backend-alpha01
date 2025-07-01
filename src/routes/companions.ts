import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { validateUUID, validatePagination } from '../middleware/validation';
import { authMiddleware, optionalAuthMiddleware } from '../middleware/auth';
import { createRateLimit } from '../middleware/rateLimit';
import { jsonSuccess, jsonError, jsonPaginated, createPagination } from '../utils/response';
import { experienceSchema, locationSchema, availabilitySchema } from '../utils/validation';
import type { Env, Variables } from '../index';

const companions = new Hono<{ Bindings: Env; Variables: Variables }>();

// Apply optional authentication and rate limiting
companions.use('*', optionalAuthMiddleware);
companions.use('*', createRateLimit('search'));

// Companion search schema
const companionSearchSchema = z.object({
  search: z.string().optional(),
  category: z.string().optional(),
  location: z.string().optional(),
  minPrice: z.number().min(0).optional(),
  maxPrice: z.number().min(0).optional(),
  rating: z.number().min(1).max(5).optional(),
  languages: z.string().optional(), // comma-separated
  available: z.boolean().optional(),
  verified: z.boolean().optional(),
  page: z.number().min(1).default(1),
  limit: z.number().min(1).max(50).default(20),
  sortBy: z.enum(['rating', 'price', 'distance', 'reviews']).default('rating'),
  sortOrder: z.enum(['asc', 'desc']).default('desc')
});

/**
 * Get companions list (mobile-optimized)
 */
companions.get('/', zValidator('query', companionSearchSchema), async (c) => {
  const searchParams = c.req.valid('query');
  const userId = c.get('userId');

  try {
    // First check if companion_experiences table exists to avoid D1 errors
    const tableCheck = await c.env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='companion_experiences'"
    ).first();
    
    if (!tableCheck?.name) {
      console.error('Missing required table: companion_experiences');
      // Return a response without joining with non-existent table
      return jsonError(
        c, 
        'System maintenance', 
        'The system is currently undergoing maintenance. Please try again in a few minutes.', 
        503
      );
    }

    // Build base query
    let query = `
      SELECT 
        sp.user_id as id,
        sp.display_name as name,
        sp.display_name,
        sp.bio,
        sp.profile_images,
        sp.categories,
        sp.regions,
        sp.spoken_languages as languages,
        sp.rating_average as rating,
        sp.rating_count,
        sp.verification_status as verified,
        u.status as online,
        u.last_login_at,
        MIN(ce.price) as price
      FROM supplier_profiles sp
      JOIN users u ON sp.user_id = u.id
      LEFT JOIN companion_experiences ce ON sp.user_id = ce.companion_id AND ce.is_active = TRUE
      WHERE u.user_type = 'companion'
        AND sp.subscription_status = 'active' 
        AND sp.verification_status = 'verified'
        AND u.status = 'active'
    `;

    const queryParams = [];

    // Apply filters
    if (searchParams.search) {
      query += ` AND (sp.display_name LIKE ? OR sp.bio LIKE ?)`;
      const searchTerm = `%${searchParams.search}%`;
      queryParams.push(searchTerm, searchTerm);
    }

    if (searchParams.category) {
      query += ` AND JSON_EXTRACT(sp.categories, '$') LIKE ?`;
      queryParams.push(`%"${searchParams.category}"%`);
    }

    if (searchParams.location) {
      query += ` AND JSON_EXTRACT(sp.regions, '$') LIKE ?`;
      queryParams.push(`%"${searchParams.location}"%`);
    }

    if (searchParams.minPrice !== undefined) {
      query += ` AND ce.price >= ?`;
      queryParams.push(searchParams.minPrice);
    }

    if (searchParams.maxPrice !== undefined) {
      query += ` AND ce.price <= ?`;
      queryParams.push(searchParams.maxPrice);
    }

    if (searchParams.rating) {
      query += ` AND sp.rating_average >= ?`;
      queryParams.push(searchParams.rating);
    }

    if (searchParams.languages) {
      const langs = searchParams.languages.split(',');
      const langConditions = langs.map(() => `JSON_EXTRACT(sp.spoken_languages, '$') LIKE ?`).join(' OR ');
      query += ` AND (${langConditions})`;
      langs.forEach(lang => queryParams.push(`%"${lang.trim()}"%`));
    }

    if (searchParams.verified) {
      query += ` AND sp.verification_status = 'verified'`;
    }

    // Group by companion
    query += ` GROUP BY sp.user_id`;

    // Add sorting
    const sortColumn = searchParams.sortBy === 'rating' ? 'sp.rating_average' :
                      searchParams.sortBy === 'price' ? 'price' :
                      searchParams.sortBy === 'reviews' ? 'sp.rating_count' :
                      'sp.created_at';
    
    query += ` ORDER BY ${sortColumn} ${searchParams.sortOrder.toUpperCase()}`;

    // Get total count
    const countQuery = `SELECT COUNT(*) as total FROM (${query})`;
    const countResult = await c.env.DB.prepare(countQuery).bind(...queryParams).first();
    const total = countResult?.total as number || 0;

    // Get paginated results
    const offset = (searchParams.page - 1) * searchParams.limit;
    const paginatedQuery = `${query} LIMIT ? OFFSET ?`;
    const companionsResult = await c.env.DB.prepare(paginatedQuery)
      .bind(...queryParams, searchParams.limit, offset).all();

    // Format companions data
    const companionsList = companionsResult.results.map((companion: any) => {
      const profileImages = JSON.parse(companion.profile_images || '[]');
      const categories = JSON.parse(companion.categories || '[]');
      const regions = JSON.parse(companion.regions || '[]');
      const languages = JSON.parse(companion.languages || '[]');

      return {
        id: companion.id,
        name: companion.name,
        displayName: companion.display_name,
        profileImage: profileImages[0] || null,
        gallery: profileImages,
        location: regions[0] || null,
        rating: Math.round((companion.rating || 0) * 10) / 10,
        reviewCount: companion.rating_count || 0,
        price: companion.price || 0,
        services: [], // Will be populated separately if needed
        languages: languages,
        verified: companion.verified === 'verified',
        online: companion.online === 'active',
        categories: categories,
        bio: companion.bio,
        age: null, // Calculate from date_of_birth if available
        responseTime: '< 1 hour', // Default response time
        completionRate: 95, // Default completion rate
        distance: null // Would calculate if user location available
      };
    });

    // Get filter options for the response
    const filtersResult = await c.env.DB.prepare(`
      SELECT 
        c.id as category_id,
        c.name_en as category_name,
        COUNT(DISTINCT sp.user_id) as category_count
      FROM categories c
      LEFT JOIN supplier_profiles sp ON JSON_EXTRACT(sp.categories, '$') LIKE '%"' || c.id || '"%'
        AND sp.subscription_status = 'active' 
        AND sp.verification_status = 'verified'
      LEFT JOIN users u ON sp.user_id = u.id AND u.user_type = 'companion'
      WHERE c.is_active = TRUE
      GROUP BY c.id, c.name_en
      ORDER BY category_count DESC
    `).all();

    const locationsResult = await c.env.DB.prepare(`
      SELECT 
        r.id as location_id,
        r.name_en as location_name,
        COUNT(DISTINCT sp.user_id) as location_count
      FROM regions r
      LEFT JOIN supplier_profiles sp ON JSON_EXTRACT(sp.regions, '$') LIKE '%"' || r.id || '"%'
        AND sp.subscription_status = 'active' 
        AND sp.verification_status = 'verified'
      LEFT JOIN users u ON sp.user_id = u.id AND u.user_type = 'companion'
      WHERE r.is_active = TRUE
      GROUP BY r.id, r.name_en
      ORDER BY location_count DESC
    `).all();

    const priceRangeResult = await c.env.DB.prepare(`
      SELECT 
        MIN(ce.price) as min_price,
        MAX(ce.price) as max_price
      FROM companion_experiences ce
      JOIN supplier_profiles sp ON ce.companion_id = sp.user_id
      JOIN users u ON sp.user_id = u.id
      WHERE ce.is_active = TRUE 
        AND sp.subscription_status = 'active'
        AND sp.verification_status = 'verified'
        AND u.user_type = 'companion'
    `).first();

    const filters = {
      categories: (filtersResult.results || []).map((cat: any) => ({
        id: cat.category_id,
        name: cat.category_name,
        count: cat.category_count
      })),
      locations: (locationsResult.results || []).map((loc: any) => ({
        id: loc.location_id,
        name: loc.location_name,
        count: loc.location_count
      })),
      priceRange: {
        min: priceRangeResult?.min_price || 0,
        max: priceRangeResult?.max_price || 10000
      },
      languages: [
        { id: 'en', name: 'English', count: 0 },
        { id: 'th', name: 'Thai', count: 0 }
      ]
    };

    return jsonSuccess(c, {
      companions: companionsList,
      pagination: createPagination(searchParams.page, searchParams.limit, total),
      filters
    }, 'Companions retrieved successfully');

  } catch (error) {
    console.error('Get companions error:', error);
    return jsonError(c, 'Failed to retrieve companions', 'An error occurred while fetching companions', 500);
  }
});

/**
 * Get companion details
 */
companions.get('/:id', validateUUID('id'), async (c) => {
  const companionId = c.req.param('id');

  try {
    // Get companion profile
    const companion = await c.env.DB.prepare(`
      SELECT
        sp.*,
        u.status as user_status,
        u.last_login_at,
        u.created_at as joined_date
      FROM supplier_profiles sp
      JOIN users u ON sp.user_id = u.id
      WHERE sp.user_id = ?
        AND u.user_type = 'companion'
        AND sp.subscription_status = 'active'
        AND sp.verification_status = 'verified'
        AND u.status = 'active'
    `).bind(companionId).first();

    if (!companion) {
      return jsonError(c, 'Companion not found', 'The requested companion does not exist or is not available', 404);
    }

    // Get experiences
    const experiences = await c.env.DB.prepare(`
      SELECT *
      FROM companion_experiences
      WHERE companion_id = ? AND is_active = TRUE
      ORDER BY price ASC
    `).bind(companionId).all();

    // Get locations
    const locations = await c.env.DB.prepare(`
      SELECT *
      FROM companion_locations
      WHERE companion_id = ?
      ORDER BY is_popular DESC, city ASC
    `).bind(companionId).all();

    // Get availability
    const availability = await c.env.DB.prepare(`
      SELECT day_of_week, start_time, end_time, is_available
      FROM supplier_availability
      WHERE supplier_id = ?
      ORDER BY day_of_week
    `).bind(companionId).all();

    // Get recent reviews
    const reviews = await c.env.DB.prepare(`
      SELECT
        r.*,
        cp.display_name as customer_name,
        cp.profile_images as customer_images
      FROM reviews r
      JOIN customer_profiles cp ON r.reviewer_id = cp.user_id
      WHERE r.reviewee_id = ?
      ORDER BY r.created_at DESC
      LIMIT 10
    `).bind(companionId).all();

    // Format data
    const profileImages = companion.profile_images ? JSON.parse(companion.profile_images as string) : [];
    const categories = companion.categories ? JSON.parse(companion.categories as string) : [];
    const regions = companion.regions ? JSON.parse(companion.regions as string) : [];
    const languages = companion.spoken_languages ? JSON.parse(companion.spoken_languages as string) : [];

    const weeklySchedule: Record<string, Array<{start: string, end: string}>> = {
      monday: [],
      tuesday: [],
      wednesday: [],
      thursday: [],
      friday: [],
      saturday: [],
      sunday: []
    };

    const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const;

    (availability.results || []).forEach((avail: any) => {
      const dayName = dayNames[avail.day_of_week] as keyof typeof weeklySchedule;
      if (avail.is_available && dayName && weeklySchedule[dayName]) {
        weeklySchedule[dayName].push({
          start: avail.start_time,
          end: avail.end_time
        });
      }
    });

    const companionData = {
      id: companion.user_id,
      name: companion.display_name,
      displayName: companion.display_name,
      profileImage: profileImages[0] || null,
      gallery: profileImages,
      location: regions[0] || null,
      rating: Math.round((Number(companion.rating_average) || 0) * 10) / 10,
      reviewCount: companion.rating_count || 0,
      price: 0, // Will be set from experiences
      experiences: experiences.results.map((exp: any) => ({
        id: exp.id,
        title: exp.title,
        description: exp.description,
        durationMinutes: exp.duration_minutes,
        keywords: JSON.parse(exp.keywords || '[]'),
        price: exp.price,
        currency: exp.currency,
        isActive: exp.is_active,
        createdAt: exp.created_at,
        updatedAt: exp.updated_at
      })),
      locations: locations.results.map((loc: any) => ({
        id: loc.id,
        city: loc.city,
        region: loc.region,
        isPopular: loc.is_popular,
        description: loc.description,
        createdAt: loc.created_at,
        updatedAt: loc.updated_at
      })),
      languages: languages,
      verified: companion.verification_status === 'verified',
      online: companion.user_status === 'active',
      lastSeen: companion.last_login_at,
      categories: categories,
      bio: companion.bio,
      age: null, // Calculate from date_of_birth if available
      responseTime: '< 1 hour',
      completionRate: 95,
      joinedDate: companion.joined_date,
      availability: {
        weeklySchedule,
        exceptions: [] // Would come from a separate table
      },
      reviews: reviews.results.map((review: any) => ({
        id: review.id,
        user: {
          id: review.reviewer_id,
          name: review.customer_name,
          profileImage: JSON.parse(review.customer_images || '[]')[0] || null
        },
        rating: review.rating,
        comment: review.comment,
        date: review.created_at,
        verified: review.is_public
      }))
    };

    // Set price from cheapest experience
    if (experiences.results.length > 0) {
      companionData.price = Math.min(...experiences.results.map((exp: any) => exp.price));
    }

    return jsonSuccess(c, companionData, 'Companion details retrieved successfully');

  } catch (error) {
    console.error('Get companion details error:', error);
    return jsonError(c, 'Failed to retrieve companion', 'An error occurred while fetching companion details', 500);
  }
});

/**
 * Get companion availability
 */
companions.get('/:id/availability', validateUUID('id'), async (c) => {
  const companionId = c.req.param('id');
  const startDate = c.req.query('startDate');
  const endDate = c.req.query('endDate');

  if (!startDate || !endDate) {
    return jsonError(c, 'Missing parameters', 'startDate and endDate are required', 400);
  }

  try {
    // Verify companion exists
    const companion = await c.env.DB.prepare(`
      SELECT user_id FROM supplier_profiles sp
      JOIN users u ON sp.user_id = u.id
      WHERE sp.user_id = ? AND u.user_type = 'companion' 
        AND sp.subscription_status = 'active' AND sp.verification_status = 'verified'
    `).bind(companionId).first();

    if (!companion) {
      return jsonError(c, 'Companion not found', 'The requested companion does not exist', 404);
    }

    // Get weekly availability
    const weeklyAvailability = await c.env.DB.prepare(`
      SELECT day_of_week, start_time, end_time, is_available
      FROM supplier_availability
      WHERE supplier_id = ?
    `).bind(companionId).all();

    // Get existing bookings in the date range
    const bookings = await c.env.DB.prepare(`
      SELECT date, start_time, end_time
      FROM bookings
      WHERE companion_id = ?
        AND date BETWEEN ? AND ?
        AND status IN ('confirmed', 'in_progress')
    `).bind(companionId, startDate, endDate).all();

    // Generate availability for each day in the range
    const availability = [];
    const start = new Date(startDate);
    const end = new Date(endDate);

    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      const dayOfWeek = d.getDay();
      const dateStr = d.toISOString().split('T')[0];
      
      // Find weekly availability for this day
      const dayAvailability = weeklyAvailability.results.find((wa: any) => wa.day_of_week === dayOfWeek);
      
      if (dayAvailability && dayAvailability.is_available) {
        // Check for existing bookings on this date
        const dayBookings = bookings.results.filter((booking: any) => booking.date === dateStr);
        
        availability.push({
          date: dateStr,
          available: dayBookings.length === 0, // Simplified - would need more complex logic for partial availability
          slots: dayBookings.length === 0 ? [
            {
              start: dayAvailability.start_time,
              end: dayAvailability.end_time,
              available: true
            }
          ] : []
        });
      } else {
        availability.push({
          date: dateStr,
          available: false,
          slots: []
        });
      }
    }

    return jsonSuccess(c, { availability }, 'Availability retrieved successfully');

  } catch (error) {
    console.error('Get companion availability error:', error);
    return jsonError(c, 'Failed to retrieve availability', 'An error occurred while fetching availability', 500);
  }
});

// Protected routes for companion management (require authentication)
companions.use('/*/experiences*', authMiddleware);
companions.use('/*/locations*', authMiddleware);
companions.use('/*/availability*', authMiddleware);

/**
 * Create companion experience
 */
companions.post('/:id/experiences', validateUUID('id'), zValidator('json', experienceSchema), async (c) => {
  const companionId = c.req.param('id');
  const userId = c.get('userId');
  const userType = c.get('userType');
  const experienceData = c.req.valid('json');

  // Only companions can create experiences for themselves
  if (userType !== 'companion' || userId !== companionId) {
    return jsonError(c, 'Access denied', 'You can only create experiences for your own profile', 403);
  }

  try {
    const experienceId = crypto.randomUUID();
    const now = new Date().toISOString();

    console.log('Creating experience:', { 
      experienceId, 
      companionId,
      title: experienceData.title,
      price: experienceData.price 
    });

    const result = await c.env.DB.prepare(`
      INSERT INTO companion_experiences (
        id, companion_id, title, description, duration_minutes, 
        keywords, price, currency, is_active, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      experienceId,
      companionId,
      experienceData.title,
      experienceData.description || null,
      experienceData.durationMinutes,
      JSON.stringify(experienceData.keywords || []),
      experienceData.price,
      experienceData.currency,
      experienceData.is_active === undefined ? true : experienceData.is_active,
      now,
      now
    ).run();

    // Verify insertion
    console.log('Insert result:', result);
    
    // Double-check that the experience was inserted
    const verifyInsert = await c.env.DB.prepare(`
      SELECT id FROM companion_experiences WHERE id = ?
    `).bind(experienceId).first();
    
    console.log('Verification result:', verifyInsert);

    if (!verifyInsert) {
      console.error('Experience was not properly inserted');
      return jsonError(c, 'Database error', 'Experience could not be inserted', 500);
    }

    // Track experience creation
    if (c.env.ANALYTICS_QUEUE && typeof c.env.ANALYTICS_QUEUE.send === 'function') {
      await c.env.ANALYTICS_QUEUE.send({
        eventType: 'experience_created',
        userId: companionId,
        properties: { 
          experienceId,
          price: experienceData.price,
          duration: experienceData.durationMinutes
        },
        timestamp: now
      });
    }

    return jsonSuccess(c, { 
      experienceId,
      created: true 
    }, 'Experience created successfully', 201);

  } catch (error) {
    console.error('Create experience error:', error);
    return jsonError(c, 'Failed to create experience', 'An error occurred while creating the experience', 500);
  }
});

/**
 * Get companion experiences
 */
companions.get('/:id/experiences', validateUUID('id'), async (c) => {
  const companionId = c.req.param('id');
  const page = parseInt(c.req.query('page') || '1');
  const limit = parseInt(c.req.query('limit') || '20');
  
  console.error('DEBUG - Get experiences route called with ID:', companionId);
  c.header('X-Debug-CompanionId', companionId);
  
  try {
    // Get total count
    const countResult = await c.env.DB.prepare(`
      SELECT COUNT(*) as total 
      FROM companion_experiences 
      WHERE companion_id = ?
    `).bind(companionId).first();
    
    const total = countResult?.total as number || 0;
    console.log('Total experiences found:', total);

    // Get experiences with pagination
    const offset = (page - 1) * limit;
    const experiencesResult = await c.env.DB.prepare(`
      SELECT *
      FROM companion_experiences 
      WHERE companion_id = ?
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `).bind(companionId, Number(limit), Number(offset)).all();
    
    // Map experiences to the expected format
    const experiences = (experiencesResult.results || []).map(exp => ({
      id: exp.id,
      title: exp.title,
      description: exp.description,
      durationMinutes: exp.duration_minutes,
      keywords: Array.isArray(exp.keywords) ? exp.keywords : 
               (typeof exp.keywords === 'string' && exp.keywords ? 
                 (() => { try { return JSON.parse(exp.keywords); } catch { return []; } })() : 
                 []),
      price: exp.price,
      currency: exp.currency,
      isActive: Boolean(exp.is_active),
      createdAt: exp.created_at,
      updatedAt: exp.updated_at
    }));
    
    // Create pagination data
    const pagination = {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit)
    };
    
    return c.json({
      success: true,
      data: {
        items: experiences,
        pagination
      },
      message: `Retrieved ${experiences.length} experiences successfully`
    });
  } catch (error) {
    console.error('Get experiences error:', error);
    return c.json({
      success: false,
      error: 'Failed to retrieve experiences',
      message: 'An error occurred while fetching experiences'
    }, 500);
  }
});

/**
 * DEBUG ENDPOINT - Shows all database diagnostics
 */
companions.get('/:id/experiences-debug', validateUUID('id'), async (c) => {
  const companionId = c.req.param('id');
  const results: {
    companionId: string;
    timestamp: string;
    diagnostics: Record<string, any>;
  } = {
    companionId,
    timestamp: new Date().toISOString(),
    diagnostics: {}
  };
  
  try {
    // 1. Basic database connection check
    results.diagnostics.connectionCheck = await c.env.DB.prepare('SELECT 1 as value').first();
    
    // 2. Count total experiences in the entire table
    const totalCountResult = await c.env.DB.prepare(
      `SELECT COUNT(*) as total FROM companion_experiences`
    ).first();
    results.diagnostics.totalExperiencesInDatabase = totalCountResult?.total || 0;
    
    // 3. Count experiences for this specific companion
    const companionCountResult = await c.env.DB.prepare(
      `SELECT COUNT(*) as total FROM companion_experiences WHERE companion_id = ?`
    ).bind(companionId).first();
    results.diagnostics.experiencesForThisCompanion = companionCountResult?.total || 0;
    
    // 4. Get all fields for every experience for this companion
    const allExperiencesResult = await c.env.DB.prepare(
      `SELECT * FROM companion_experiences WHERE companion_id = ?`
    ).bind(companionId).all();
    results.diagnostics.allExperiencesForCompanion = allExperiencesResult?.results || [];
    
    // 5. Get schema information
    const schemaResult = await c.env.DB.prepare(
      `SELECT sql FROM sqlite_master WHERE name = 'companion_experiences'`
    ).first();
    results.diagnostics.tableSchema = schemaResult?.sql;
    
    // 6. Check if companion exists
    const companionResult = await c.env.DB.prepare(
      `SELECT user_id, display_name FROM supplier_profiles WHERE user_id = ?`
    ).bind(companionId).first();
    results.diagnostics.companionExists = companionResult ? true : false;
    results.diagnostics.companionInfo = companionResult;
    
    return c.json({
      success: true,
      data: results
    }, 200, {
      'X-Debug-Enabled': 'true'
    });
    
  } catch (error) {
    return c.json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      companionId,
      timestamp: new Date().toISOString()
    }, 500, {
      'X-Debug-Error': 'true'
    });
  }
});

/**
 * Update companion experience
 */
companions.put('/:id/experiences/:experienceId', 
  validateUUID('id'), 
  validateUUID('experienceId'), 
  zValidator('json', experienceSchema), 
  async (c) => {
    const companionId = c.req.param('id');
    const experienceId = c.req.param('experienceId');
    const userId = c.get('userId');
    const userType = c.get('userType');
    const experienceData = c.req.valid('json');

    // Only companions can update their own experiences
    if (userType !== 'companion' || userId !== companionId) {
      return jsonError(c, 'Access denied', 'You can only update your own experiences', 403);
    }

    try {
      // Verify experience exists and belongs to companion
      const existingExp = await c.env.DB.prepare(`
        SELECT id FROM companion_experiences 
        WHERE id = ? AND companion_id = ?
      `).bind(experienceId, companionId).first();

      if (!existingExp) {
        return jsonError(c, 'Experience not found', 'The requested experience does not exist', 404);
      }

      const now = new Date().toISOString();

      await c.env.DB.prepare(`
        UPDATE companion_experiences 
        SET title = ?, description = ?, duration_minutes = ?, 
            keywords = ?, price = ?, currency = ?, updated_at = ?
        WHERE id = ? AND companion_id = ?
      `).bind(
        experienceData.title,
        experienceData.description || null,
        experienceData.durationMinutes,
        JSON.stringify(experienceData.keywords || []),
        experienceData.price,
        experienceData.currency,
        now,
        experienceId,
        companionId
      ).run();

      return jsonSuccess(c, { updated: true }, 'Experience updated successfully');

    } catch (error) {
      console.error('Update experience error:', error);
      return jsonError(c, 'Failed to update experience', 'An error occurred while updating the experience', 500);
    }
  }
);

/**
 * Delete companion experience
 */
companions.delete('/:id/experiences/:experienceId', 
  validateUUID('id'), 
  validateUUID('experienceId'), 
  async (c) => {
    const companionId = c.req.param('id');
    const experienceId = c.req.param('experienceId');
    const userId = c.get('userId');
    const userType = c.get('userType');

    // Only companions can delete their own experiences
    if (userType !== 'companion' || userId !== companionId) {
      return jsonError(c, 'Access denied', 'You can only delete your own experiences', 403);
    }

    try {
      // Verify experience exists and belongs to companion
      const existingExp = await c.env.DB.prepare(`
        SELECT id FROM companion_experiences 
        WHERE id = ? AND companion_id = ?
      `).bind(experienceId, companionId).first();

      if (!existingExp) {
        return jsonError(c, 'Experience not found', 'The requested experience does not exist', 404);
      }

      // Soft delete by setting is_active to false
      await c.env.DB.prepare(`
        UPDATE companion_experiences 
        SET is_active = FALSE, updated_at = ?
        WHERE id = ? AND companion_id = ?
      `).bind(new Date().toISOString(), experienceId, companionId).run();

      return jsonSuccess(c, { deleted: true }, 'Experience deleted successfully');

    } catch (error) {
      console.error('Delete experience error:', error);
      return jsonError(c, 'Failed to delete experience', 'An error occurred while deleting the experience', 500);
    }
  }
);

/**
 * Create companion location
 */
companions.post('/:id/locations', validateUUID('id'), zValidator('json', locationSchema), async (c) => {
  const companionId = c.req.param('id');
  const userId = c.get('userId');
  const userType = c.get('userType');
  const locationData = c.req.valid('json');

  // Only companions can create locations for themselves
  if (userType !== 'companion' || userId !== companionId) {
    return jsonError(c, 'Access denied', 'You can only create locations for your own profile', 403);
  }

  try {
    const locationId = crypto.randomUUID();
    const now = new Date().toISOString();

    await c.env.DB.prepare(`
      INSERT INTO companion_locations (
        id, companion_id, city, region, is_popular, description, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      locationId,
      companionId,
      locationData.city,
      locationData.region,
      locationData.isPopular,
      locationData.description || null,
      now,
      now
    ).run();

    return jsonSuccess(c, { 
      locationId,
      created: true 
    }, 'Location created successfully', 201);

  } catch (error) {
    console.error('Create location error:', error);
    return jsonError(c, 'Failed to create location', 'An error occurred while creating the location', 500);
  }
});

/**
 * Get companion locations
 */
companions.get('/:id/locations', validateUUID('id'), async (c) => {
  const companionId = c.req.param('id');

  try {
    const locationsResult = await c.env.DB.prepare(`
      SELECT *
      FROM companion_locations 
      WHERE companion_id = ?
      ORDER BY is_popular DESC, city ASC
    `).bind(companionId).all();

    const locations = locationsResult.results?.map((loc: any) => ({
      id: loc.id,
      city: loc.city,
      region: loc.region,
      isPopular: Boolean(loc.is_popular),
      description: loc.description,
      createdAt: loc.created_at,
      updatedAt: loc.updated_at
    })) || [];

    return jsonSuccess(c, { locations }, 'Locations retrieved successfully');

  } catch (error) {
    console.error('Get companion locations error:', error);
    return jsonError(c, 'Failed to retrieve locations', 'An error occurred while fetching locations', 500);
  }
});

/**
 * Update companion location
 */
companions.put('/:id/locations/:locationId', 
  validateUUID('id'), 
  validateUUID('locationId'), 
  zValidator('json', locationSchema), 
  async (c) => {
    const companionId = c.req.param('id');
    const locationId = c.req.param('locationId');
    const userId = c.get('userId');
    const userType = c.get('userType');
    const locationData = c.req.valid('json');

    // Only companions can update their own locations
    if (userType !== 'companion' || userId !== companionId) {
      return jsonError(c, 'Access denied', 'You can only update your own locations', 403);
    }

    try {
      // Verify location exists and belongs to companion
      const existingLoc = await c.env.DB.prepare(`
        SELECT id FROM companion_locations 
        WHERE id = ? AND companion_id = ?
      `).bind(locationId, companionId).first();

      if (!existingLoc) {
        return jsonError(c, 'Location not found', 'The requested location does not exist', 404);
      }

      const now = new Date().toISOString();

      await c.env.DB.prepare(`
        UPDATE companion_locations 
        SET city = ?, region = ?, is_popular = ?, description = ?, updated_at = ?
        WHERE id = ? AND companion_id = ?
      `).bind(
        locationData.city,
        locationData.region,
        locationData.isPopular,
        locationData.description || null,
        now,
        locationId,
        companionId
      ).run();

      return jsonSuccess(c, { updated: true }, 'Location updated successfully');

    } catch (error) {
      console.error('Update location error:', error);
      return jsonError(c, 'Failed to update location', 'An error occurred while updating the location', 500);
    }
  }
);

/**
 * Delete companion location
 */
companions.delete('/:id/locations/:locationId', 
  validateUUID('id'), 
  validateUUID('locationId'), 
  async (c) => {
    const companionId = c.req.param('id');
    const locationId = c.req.param('locationId');
    const userId = c.get('userId');
    const userType = c.get('userType');

    // Only companions can delete their own locations
    if (userType !== 'companion' || userId !== companionId) {
      return jsonError(c, 'Access denied', 'You can only delete your own locations', 403);
    }

    try {
      // Verify location exists and belongs to companion
      const existingLoc = await c.env.DB.prepare(`
        SELECT id FROM companion_locations 
        WHERE id = ? AND companion_id = ?
      `).bind(locationId, companionId).first();

      if (!existingLoc) {
        return jsonError(c, 'Location not found', 'The requested location does not exist', 404);
      }

      // Hard delete location
      await c.env.DB.prepare(`
        DELETE FROM companion_locations 
        WHERE id = ? AND companion_id = ?
      `).bind(locationId, companionId).run();

      return jsonSuccess(c, { deleted: true }, 'Location deleted successfully');

    } catch (error) {
      console.error('Delete location error:', error);
      return jsonError(c, 'Failed to delete location', 'An error occurred while deleting the location', 500);
    }
  }
);

/**
 * Set companion availability
 */
companions.post('/:id/availability', 
  validateUUID('id'), 
  zValidator('json', z.array(availabilitySchema)), 
  async (c) => {
    const companionId = c.req.param('id');
    const userId = c.get('userId');
    const userType = c.get('userType');
    const availabilityData = c.req.valid('json');

    // Only companions can set their own availability
    if (userType !== 'companion' || userId !== companionId) {
      return jsonError(c, 'Access denied', 'You can only set your own availability', 403);
    }

    try {
      // Delete existing availability
      await c.env.DB.prepare(`
        DELETE FROM supplier_availability WHERE supplier_id = ?
      `).bind(companionId).run();

      // Insert new availability
      for (const avail of availabilityData) {
        const availId = crypto.randomUUID();
        await c.env.DB.prepare(`
          INSERT INTO supplier_availability (
            id, supplier_id, day_of_week, start_time, end_time, is_available, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
          availId,
          companionId,
          avail.dayOfWeek,
          avail.startTime,
          avail.endTime,
          avail.isAvailable,
          new Date().toISOString(),
          new Date().toISOString()
        ).run();
      }

      return jsonSuccess(c, { updated: true }, 'Availability updated successfully');

    } catch (error) {
      console.error('Set availability error:', error);
      return jsonError(c, 'Failed to set availability', 'An error occurred while setting availability', 500);
    }
  }
);

/**
 * Get all companions (accessible to all users)
 */
companions.get('/all', async (c) => {
  // Removed admin check to allow all users to access this endpoint

  // Get query parameters with defaults
  const page = parseInt(c.req.query('page') || '1');
  const limit = parseInt(c.req.query('limit') || '20');
  const search = c.req.query('search');
  const status = c.req.query('status');
  const verificationStatus = c.req.query('verification');
  const sortBy = c.req.query('sortBy') || 'created_at';
  const sortOrder = c.req.query('sortOrder')?.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

  try {
    // First check if companion_experiences table exists
    const tableCheck = await c.env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='companion_experiences'"
    ).first();
    
    if (!tableCheck?.name) {
      console.error('Missing required table: companion_experiences');
      return jsonError(
        c, 
        'System maintenance', 
        'The system is currently undergoing maintenance. Please try again in a few minutes.', 
        503
      );
    }

    // Build the base query
    let query = `
      SELECT 
        u.id,
        u.email,
        u.phone,
        u.status as user_status,
        u.email_verified,
        u.phone_verified,
        u.preferred_language,
        u.created_at,
        u.last_login_at,
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
        sp.subscription_tier,
        sp.subscription_expires_at
      FROM users u
      JOIN supplier_profiles sp ON u.id = sp.user_id
      WHERE u.user_type = 'companion'
    `;

    const queryParams: any[] = [];

    // Add search condition if provided
    if (search) {
      query += ` AND (sp.display_name LIKE ? OR u.email LIKE ? OR u.phone LIKE ?)`;
      const searchTerm = `%${search}%`;
      queryParams.push(searchTerm, searchTerm, searchTerm);
    }

    // Add status filter if provided
    if (status) {
      query += ` AND u.status = ?`;
      queryParams.push(status);
    }

    // Add verification status filter if provided
    if (verificationStatus) {
      query += ` AND sp.verification_status = ?`;
      queryParams.push(verificationStatus);
    }

    // Add count query to get total records
    const countQuery = `SELECT COUNT(*) as total FROM (${query})`;
    const countResult = await c.env.DB.prepare(countQuery).bind(...queryParams).first();
    const total = countResult?.total as number || 0;

    // Add sorting and pagination
    const validSortColumns = ['created_at', 'display_name', 'rating_average', 'rating_count', 'last_login_at'];
    const sortColumn = validSortColumns.includes(sortBy) ? sortBy : 'created_at';
    
    query += ` ORDER BY ${sortColumn} ${sortOrder} LIMIT ? OFFSET ?`;
    const offset = (page - 1) * limit;
    queryParams.push(limit, offset);

    // Execute the final query
    const companionsResult = await c.env.DB.prepare(query).bind(...queryParams).all();

    // Format the data
    const companionsList = companionsResult.results.map((companion: any) => {
      // Parse JSON fields
      const profileImages = companion.profile_images ? JSON.parse(companion.profile_images) : [];
      const categories = companion.categories ? JSON.parse(companion.categories) : [];
      const regions = companion.regions ? JSON.parse(companion.regions) : [];
      const languages = companion.spoken_languages ? JSON.parse(companion.spoken_languages) : [];

      return {
        id: companion.id,
        email: companion.email,
        phone: companion.phone,
        displayName: companion.display_name,
        profileImage: profileImages[0] || null,
        gallery: profileImages,
        bio: companion.bio,
        categories: categories,
        regions: regions,
        languages: languages,
        rating: {
          average: companion.rating_average || 0,
          count: companion.rating_count || 0
        },
        userStatus: companion.user_status,
        verificationStatus: companion.verification_status,
        subscriptionStatus: companion.subscription_status,
        subscriptionTier: companion.subscription_tier,
        subscriptionExpiresAt: companion.subscription_expires_at,
        emailVerified: companion.email_verified === 1,
        phoneVerified: companion.phone_verified === 1,
        preferredLanguage: companion.preferred_language,
        createdAt: companion.created_at,
        lastLoginAt: companion.last_login_at
      };
    });

    // Return paginated response
    const pagination = createPagination(page, limit, total);
    return jsonPaginated(c, companionsList, pagination, 'All companions retrieved successfully');

  } catch (error) {
    console.error('Get all companions error:', error);
    return jsonError(c, 'Failed to retrieve companions', 'An error occurred while fetching companion data', 500);
  }
});

// Direct database query endpoint
companions.get('/:id/raw-experiences', validateUUID('id'), async (c) => {
  const companionId = c.req.param('id');
  try {
    const result = await c.env.DB.prepare(`
      SELECT * FROM companion_experiences WHERE companion_id = ?
    `).bind(companionId).all();
    
    return c.json({ 
      success: true, 
      count: result.results?.length || 0,
      data: result.results || []
    });
  } catch (error) {
    console.error('Raw experiences error:', error);
    return c.json({
      success: false,
      error: String(error)
    }, 500);
  }
});

export { companions as companionRoutes };
