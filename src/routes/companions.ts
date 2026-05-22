import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { validateUUID } from '../middleware/validation';
import { authMiddleware, optionalAuthMiddleware } from '../middleware/auth';
import { createRateLimit } from '../middleware/rateLimit';
import { jsonSuccess, jsonError, jsonPaginated, createPagination } from '../utils/response';
import { firstProfileImage } from '../utils/profileImages';
import { getUserById, updateUser } from '../utils/database';
import type { Env, Variables } from '../index';

const companions = new Hono<{ Bindings: Env; Variables: Variables }>();

// Apply optional authentication and rate limiting
companions.use('*', optionalAuthMiddleware);
companions.use('*', createRateLimit('search'));

const booleanQuery = z.preprocess((value) => {
  if (value === undefined) return undefined;
  if (typeof value === 'string') return value.toLowerCase() === 'true';
  return value;
}, z.boolean().optional());

// Companion search schema
const companionSearchSchema = z.object({
  search: z.string().optional(),
  category: z.string().optional(),
  location: z.string().optional(),
  minPrice: z.coerce.number().min(0).optional(),
  maxPrice: z.coerce.number().min(0).optional(),
  rating: z.coerce.number().min(1).max(5).optional(),
  languages: z.string().optional(), // comma-separated
  available: booleanQuery,
  verified: booleanQuery,
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(50).default(20),
  sortBy: z.enum(['rating', 'price', 'distance', 'reviews']).default('rating'),
  sortOrder: z.enum(['asc', 'desc']).default('desc')
});

const availabilitySaveSchema = z.array(z.object({
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  startTime: z.string().regex(/^\d{2}:\d{2}$/),
  endTime: z.string().regex(/^\d{2}:\d{2}$/),
  isAvailable: z.boolean()
})).min(1);

/**
 * Get companions list (mobile-optimized)
 */
companions.get('/', zValidator('query', companionSearchSchema), async (c) => {
  const searchParams = c.req.valid('query');
  const userId = c.get('userId'); // Optional - for distance calculation
  
  try {
    // Build base query
    let query = `
      SELECT 
        sp.user_id as id,
        sp.display_name as name,
        sp.display_name,
        sp.profile_images,
        sp.bio,
        sp.categories,
        sp.regions,
        sp.spoken_languages as languages,
        sp.rating_average as rating,
        sp.rating_count as reviewCount,
        sp.verification_status as verified,
        sp.subscription_status,
        sp.created_at,
        u.status as online,
        u.last_login_at as lastSeen,
        MIN(ss.price_min) as price,
        COUNT(ss.id) as serviceCount,
        AVG(ss.duration_hours) as avgDuration
      FROM supplier_profiles sp
      JOIN users u ON sp.user_id = u.id
      LEFT JOIN supplier_services ss ON sp.user_id = ss.supplier_id AND ss.is_active = TRUE
      WHERE COALESCE(sp.subscription_status, 'active') = 'active'
        AND COALESCE(sp.verification_status, 'pending') != 'rejected'
        AND u.status = 'active'
    `;

    const queryParams: any[] = [];

    // Add search filters
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

    if (searchParams.languages) {
      const languages = searchParams.languages.split(',');
      const languageConditions = languages.map(() => `JSON_EXTRACT(sp.spoken_languages, '$') LIKE ?`).join(' OR ');
      query += ` AND (${languageConditions})`;
      languages.forEach(lang => queryParams.push(`%"${lang.trim()}"%`));
    }

    if (searchParams.rating) {
      query += ` AND sp.rating_average >= ?`;
      queryParams.push(searchParams.rating);
    }

    if (searchParams.verified === true) {
      query += ` AND sp.verification_status = ?`;
      queryParams.push('verified');
    }

    // Group by supplier
    query += ` GROUP BY sp.user_id`;

    // Add price filter after grouping. New local guides may not have services
    // yet, so a zero/minimum price filter should not hide otherwise valid
    // active profiles before they finish service setup.
    const havingClauses: string[] = [];
    if (searchParams.minPrice !== undefined) {
      havingClauses.push(`(MIN(ss.price_min) IS NULL OR MIN(ss.price_min) >= ?)`);
      queryParams.push(searchParams.minPrice);
    }

    if (searchParams.maxPrice !== undefined) {
      havingClauses.push(`(MIN(ss.price_min) IS NULL OR MIN(ss.price_min) <= ?)`);
      queryParams.push(searchParams.maxPrice);
    }

    if (havingClauses.length > 0) {
      query += ` HAVING ${havingClauses.join(' AND ')}`;
    }

    // Add sorting
    let orderBy = '';
    switch (searchParams.sortBy) {
      case 'rating':
        orderBy = `sp.rating_average ${searchParams.sortOrder.toUpperCase()}`;
        break;
      case 'price':
        orderBy = `MIN(ss.price_min) ${searchParams.sortOrder.toUpperCase()}`;
        break;
      case 'reviews':
        orderBy = `sp.rating_count ${searchParams.sortOrder.toUpperCase()}`;
        break;
      case 'distance':
        // For now, sort by creation date as distance calculation requires user location
        orderBy = `sp.created_at ${searchParams.sortOrder.toUpperCase()}`;
        break;
      default:
        orderBy = `sp.rating_average DESC`;
    }

    query += ` ORDER BY ${orderBy}`;

    // Get total count for pagination
    const countQuery = `
      SELECT COUNT(DISTINCT sp.user_id) as total
      FROM supplier_profiles sp
      JOIN users u ON sp.user_id = u.id
      LEFT JOIN supplier_services ss ON sp.user_id = ss.supplier_id AND ss.is_active = TRUE
      WHERE COALESCE(sp.subscription_status, 'active') = 'active'
        AND COALESCE(sp.verification_status, 'pending') != 'rejected'
        AND u.status = 'active'
    `;

    // Apply same filters to count query (simplified)
    let countQueryWithFilters = countQuery;
    const countParams = [];

    if (searchParams.search) {
      countQueryWithFilters += ` AND (sp.display_name LIKE ? OR sp.bio LIKE ?)`;
      const searchTerm = `%${searchParams.search}%`;
      countParams.push(searchTerm, searchTerm);
    }

    if (searchParams.category) {
      countQueryWithFilters += ` AND JSON_EXTRACT(sp.categories, '$') LIKE ?`;
      countParams.push(`%"${searchParams.category}"%`);
    }

    if (searchParams.location) {
      countQueryWithFilters += ` AND JSON_EXTRACT(sp.regions, '$') LIKE ?`;
      countParams.push(`%"${searchParams.location}"%`);
    }

    if (searchParams.verified === true) {
      countQueryWithFilters += ` AND sp.verification_status = ?`;
      countParams.push('verified');
    }

    const countResult = await c.env.DB.prepare(countQueryWithFilters).bind(...countParams).first();
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
        reviewCount: companion.reviewCount || 0,
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
        AND COALESCE(sp.subscription_status, 'active') = 'active'
        AND COALESCE(sp.verification_status, 'pending') != 'rejected'
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
        AND COALESCE(sp.subscription_status, 'active') = 'active'
        AND COALESCE(sp.verification_status, 'pending') != 'rejected'
      WHERE r.is_active = TRUE
      GROUP BY r.id, r.name_en
      ORDER BY location_count DESC
    `).all();

    const priceRangeResult = await c.env.DB.prepare(`
      SELECT 
        MIN(ss.price_min) as min_price,
        MAX(ss.price_max) as max_price
      FROM supplier_services ss
      JOIN supplier_profiles sp ON ss.supplier_id = sp.user_id
      WHERE ss.is_active = TRUE 
        AND COALESCE(sp.subscription_status, 'active') = 'active'
        AND COALESCE(sp.verification_status, 'pending') != 'rejected'
    `).first();

    const filters = {
      categories: filtersResult.results.map((cat: any) => ({
        id: cat.category_id,
        name: cat.category_name,
        count: cat.category_count
      })),
      locations: locationsResult.results.map((loc: any) => ({
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
 * Get companion services in the mobile booking-flow shape.
 */
companions.get('/:id/services', validateUUID('id'), async (c) => {
  const companionId = c.req.param('id') as string;

  try {
    const companion = await c.env.DB.prepare(`
      SELECT user_id FROM supplier_profiles
      WHERE user_id = ?
        AND COALESCE(subscription_status, 'active') = 'active'
        AND COALESCE(verification_status, 'pending') != 'rejected'
    `).bind(companionId).first();

    if (!companion) {
      return jsonError(c, 'Companion not found', 'The requested companion does not exist', 404);
    }

    const servicesResult = await c.env.DB.prepare(`
      SELECT id, title, description, price_min, currency, duration_hours
      FROM supplier_services
      WHERE supplier_id = ? AND is_active = TRUE
      ORDER BY price_min ASC, created_at DESC
    `).bind(companionId).all();

    const services = servicesResult.results?.map((service: any) => ({
      id: service.id,
      name: service.title,
      description: service.description || '',
      price: Number(service.price_min || 0),
      currency: service.currency || 'THB',
      duration: Math.max(30, Math.round(Number(service.duration_hours || 1) * 60)),
      category: 'Local experience'
    })) || [];

    return jsonSuccess(c, { services }, 'Companion services retrieved successfully');

  } catch (error) {
    console.error('Get companion services error:', error);
    return jsonError(c, 'Failed to retrieve services', 'An error occurred while fetching companion services', 500);
  }
});

/**
 * Get companion details
 */
companions.get('/:id', validateUUID('id'), async (c) => {
  const companionId = c.req.param('id') as string;

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
        AND COALESCE(sp.subscription_status, 'active') = 'active'
        AND COALESCE(sp.verification_status, 'pending') != 'rejected'
        AND u.status = 'active'
    `).bind(companionId).first();

    if (!companion) {
      return jsonError(c, 'Companion not found', 'The requested companion does not exist or is not available', 404);
    }

    // Get services
    const services = await c.env.DB.prepare(`
      SELECT
        ss.*,
        NULL as category_name
      FROM supplier_services ss
      WHERE ss.supplier_id = ? AND ss.is_active = TRUE
      ORDER BY ss.price_min ASC
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
        cp.profile_image as customer_image
      FROM reviews r
      JOIN customer_profiles cp ON r.reviewer_id = cp.user_id
      WHERE r.reviewee_id = ? AND r.is_public = TRUE
      ORDER BY r.created_at DESC
      LIMIT 10
    `).bind(companionId).all();

    // Format data
    const companionRow = companion as any;
    const profileImages = JSON.parse(String(companionRow.profile_images || '[]'));
    const categories = JSON.parse(String(companionRow.categories || '[]'));
    const regions = JSON.parse(String(companionRow.regions || '[]'));
    const languages = JSON.parse(String(companionRow.spoken_languages || '[]'));

    const weeklySchedule: Record<string, Array<{ start: string; end: string }>> = {
      monday: [],
      tuesday: [],
      wednesday: [],
      thursday: [],
      friday: [],
      saturday: [],
      sunday: []
    };

    const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

    availability.results.forEach((avail: any) => {
      const dayName = dayNames[Number(avail.day_of_week)];
      const slots = dayName ? weeklySchedule[dayName] : undefined;
      if (slots && avail.is_available) {
        slots.push({
          start: avail.start_time,
          end: avail.end_time
        });
      }
    });

    const companionData = {
      id: companionRow.user_id,
      name: companionRow.display_name,
      displayName: companionRow.display_name,
      profileImage: profileImages[0] || null,
      gallery: profileImages,
      location: regions[0] || null,
      rating: Math.round(Number(companionRow.rating_average || 0) * 10) / 10,
      reviewCount: companionRow.rating_count || 0,
      price: 0, // Will be set from services
      services: services.results.map((service: any) => ({
        id: service.id,
        name: service.title,
        description: service.description,
        price: service.price_min,
        duration: `${service.duration_hours} hours`,
        category: service.category_name || 'General'
      })),
      languages: languages,
      verified: companionRow.verification_status === 'verified',
      online: companionRow.user_status === 'active',
      lastSeen: companionRow.last_login_at,
      categories: categories,
      bio: companionRow.bio,
      age: null, // Calculate from date_of_birth if available
      responseTime: '< 1 hour',
      completionRate: 95,
      joinedDate: companionRow.joined_date,
      availability: {
        weeklySchedule,
        exceptions: [] // Would come from a separate table
      },
      reviews: reviews.results.map((review: any) => ({
        id: review.id,
        user: {
          id: review.reviewer_id,
          name: review.customer_name,
          profileImage: firstProfileImage(review.customer_image)
        },
        rating: review.rating,
        comment: review.comment,
        date: review.created_at,
        verified: true
      }))
    };

    // Set price from cheapest service
    if (services.results.length > 0) {
      companionData.price = Math.min(...services.results.map((s: any) => s.price_min));
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
  const companionId = c.req.param('id') as string;
  const startDate = c.req.query('startDate');
  const endDate = c.req.query('endDate');

  if (!startDate || !endDate) {
    return jsonError(c, 'Missing parameters', 'startDate and endDate are required', 400);
  }

  try {
    // Verify companion exists
    const companion = await c.env.DB.prepare(`
      SELECT user_id FROM supplier_profiles
      WHERE user_id = ?
        AND COALESCE(subscription_status, 'active') = 'active'
        AND COALESCE(verification_status, 'pending') != 'rejected'
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
      SELECT
        date(scheduled_at) as booking_date,
        time(scheduled_at) as start_time,
        time(datetime(scheduled_at, '+' || duration || ' minutes')) as end_time
      FROM bookings
      WHERE supplier_id = ?
        AND date(scheduled_at) BETWEEN ? AND ?
        AND status IN ('confirmed', 'in_progress')
    `).bind(companionId, startDate, endDate).all();

    // Generate availability for each day in the range
    const availability = [];
    const start = new Date(startDate);
    const end = new Date(endDate);

    for (let date = new Date(start); date <= end; date.setDate(date.getDate() + 1)) {
      const dateStr = date.toISOString().split('T')[0];
      const dayOfWeek = date.getDay();

      // Get weekly schedule for this day
      const daySchedule = weeklyAvailability.results.filter((avail: any) =>
        avail.day_of_week === dayOfWeek && avail.is_available
      );

      // Get bookings for this date
      const dayBookings = bookings.results.filter((booking: any) =>
        booking.booking_date === dateStr
      );

      // Generate time slots
      const timeSlots: Array<{ start: string; end: string; available: boolean; price: number }> = [];

      if (daySchedule.length > 0) {
        daySchedule.forEach((schedule: any) => {
          // Generate hourly slots between start and end time
          const startHour = parseInt(schedule.start_time.split(':')[0]);
          const endHour = parseInt(schedule.end_time.split(':')[0]);

          for (let hour = startHour; hour < endHour; hour++) {
            const slotStart = `${hour.toString().padStart(2, '0')}:00`;
            const slotEnd = `${(hour + 1).toString().padStart(2, '0')}:00`;

            // Check if this slot conflicts with any booking
            const isBooked = dayBookings.some((booking: any) => {
              return (slotStart >= booking.start_time && slotStart < booking.end_time) ||
                     (slotEnd > booking.start_time && slotEnd <= booking.end_time);
            });

            timeSlots.push({
              start: slotStart,
              end: slotEnd,
              available: !isBooked,
              price: 1000 // Default hourly rate
            });
          }
        });
      }

      availability.push({
        date: dateStr,
        available: timeSlots.some(slot => slot.available),
        timeSlots
      });
    }

    return jsonSuccess(c, {
      availability
    }, 'Availability retrieved successfully');

  } catch (error) {
    console.error('Get companion availability error:', error);
    return jsonError(c, 'Failed to retrieve availability', 'An error occurred while fetching availability', 500);
  }
});

/**
 * Save companion availability from the mobile local-guide flow.
 */
companions.post('/:id/availability', validateUUID('id'), authMiddleware, zValidator('json', availabilitySaveSchema), async (c) => {
  const companionId = c.req.param('id') as string;
  const userId = c.get('userId');
  const userType = c.get('userType');
  const slots = c.req.valid('json');

  if (userType !== 'admin' && userId !== companionId) {
    return jsonError(c, 'Access denied', 'You can only update your own availability', 403);
  }

  try {
    const companion = await c.env.DB.prepare(`
      SELECT user_id FROM supplier_profiles
      WHERE user_id = ?
        AND COALESCE(subscription_status, 'active') = 'active'
        AND COALESCE(verification_status, 'pending') != 'rejected'
    `).bind(companionId).first();

    if (!companion) {
      return jsonError(c, 'Companion not found', 'The requested companion does not exist', 404);
    }

    const savedAvailability: Array<{
      date: string;
      available: boolean;
      slots: Array<{ start: string; end: string; available: boolean }>;
    }> = [];

    for (const slot of slots) {
      const start = new Date(`${slot.startDate}T00:00:00Z`);
      const end = new Date(`${slot.endDate}T00:00:00Z`);

      if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) {
        return jsonError(c, 'Invalid availability range', 'End date must be on or after start date', 400);
      }

      for (let cursor = new Date(start); cursor <= end; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
        const date = cursor.toISOString().slice(0, 10);
        const dayOfWeek = cursor.getUTCDay();

        await c.env.DB.prepare(`
          INSERT INTO supplier_availability (supplier_id, day_of_week, start_time, end_time, is_available, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
          ON CONFLICT(supplier_id, day_of_week) DO UPDATE SET
            start_time = excluded.start_time,
            end_time = excluded.end_time,
            is_available = excluded.is_available,
            updated_at = CURRENT_TIMESTAMP
        `).bind(
          companionId,
          dayOfWeek,
          slot.startTime,
          slot.endTime,
          slot.isAvailable ? 1 : 0
        ).run();

        savedAvailability.push({
          date,
          available: slot.isAvailable,
          slots: [{ start: slot.startTime, end: slot.endTime, available: slot.isAvailable }]
        });
      }
    }

    await c.env.CACHE.delete(`supplier:${companionId}`);

    await c.env.ANALYTICS_QUEUE.send({
      eventType: 'companion_availability_update',
      userId: companionId,
      properties: {
        ranges: slots.length,
        days: savedAvailability.length
      },
      timestamp: new Date().toISOString()
    });

    return jsonSuccess(c, {
      availability: savedAvailability
    }, 'Availability saved successfully');

  } catch (error) {
    console.error('Save companion availability error:', error);
    return jsonError(c, 'Failed to save availability', 'An error occurred while saving availability', 500);
  }
});

export { companions as companionRoutes };
