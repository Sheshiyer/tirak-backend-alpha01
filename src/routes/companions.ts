import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { validateUUID, validatePagination } from '../middleware/validation';
import { optionalAuthMiddleware } from '../middleware/auth';
import { createRateLimit } from '../middleware/rateLimit';
import { jsonSuccess, jsonError, jsonPaginated, createPagination } from '../utils/response';
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
      WHERE sp.subscription_status = 'active' 
        AND sp.verification_status = 'verified'
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

    if (searchParams.verified !== undefined) {
      query += ` AND sp.verification_status = ?`;
      queryParams.push(searchParams.verified ? 'verified' : 'pending');
    }

    // Group by supplier
    query += ` GROUP BY sp.user_id`;

    // Add price filter after grouping
    if (searchParams.minPrice !== undefined) {
      query += ` HAVING MIN(ss.price_min) >= ?`;
      queryParams.push(searchParams.minPrice);
    }

    if (searchParams.maxPrice !== undefined) {
      if (searchParams.minPrice !== undefined) {
        query += ` AND MIN(ss.price_min) <= ?`;
      } else {
        query += ` HAVING MIN(ss.price_min) <= ?`;
      }
      queryParams.push(searchParams.maxPrice);
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
      WHERE sp.subscription_status = 'active' 
        AND sp.verification_status = 'verified'
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
        AND sp.subscription_status = 'active' 
        AND sp.verification_status = 'verified'
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
        AND sp.subscription_status = 'active'
        AND sp.verification_status = 'verified'
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
        AND sp.subscription_status = 'active'
        AND sp.verification_status = 'verified'
        AND u.status = 'active'
    `).bind(companionId).first();

    if (!companion) {
      return jsonError(c, 'Companion not found', 'The requested companion does not exist or is not available', 404);
    }

    // Get services
    const services = await c.env.DB.prepare(`
      SELECT
        ss.*,
        c.name_en as category_name
      FROM supplier_services ss
      LEFT JOIN categories c ON ss.category_id = c.id
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
        cp.profile_images as customer_images
      FROM reviews r
      JOIN customer_profiles cp ON r.customer_id = cp.user_id
      WHERE r.companion_id = ?
      ORDER BY r.created_at DESC
      LIMIT 10
    `).bind(companionId).all();

    // Format data
    const profileImages = JSON.parse(companion.profile_images || '[]');
    const categories = JSON.parse(companion.categories || '[]');
    const regions = JSON.parse(companion.regions || '[]');
    const languages = JSON.parse(companion.spoken_languages || '[]');

    const weeklySchedule = {
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
      const dayName = dayNames[avail.day_of_week];
      if (avail.is_available) {
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
      rating: Math.round((companion.rating_average || 0) * 10) / 10,
      reviewCount: companion.rating_count || 0,
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
          id: review.customer_id,
          name: review.customer_name,
          profileImage: JSON.parse(review.customer_images || '[]')[0] || null
        },
        rating: review.rating,
        comment: review.comment,
        date: review.created_at,
        verified: review.verified
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
  const companionId = c.req.param('id');
  const startDate = c.req.query('startDate');
  const endDate = c.req.query('endDate');

  if (!startDate || !endDate) {
    return jsonError(c, 'Missing parameters', 'startDate and endDate are required', 400);
  }

  try {
    // Verify companion exists
    const companion = await c.env.DB.prepare(`
      SELECT user_id FROM supplier_profiles
      WHERE user_id = ? AND subscription_status = 'active' AND verification_status = 'verified'
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

    for (let date = new Date(start); date <= end; date.setDate(date.getDate() + 1)) {
      const dateStr = date.toISOString().split('T')[0];
      const dayOfWeek = date.getDay();

      // Get weekly schedule for this day
      const daySchedule = weeklyAvailability.results.filter((avail: any) =>
        avail.day_of_week === dayOfWeek && avail.is_available
      );

      // Get bookings for this date
      const dayBookings = bookings.results.filter((booking: any) =>
        booking.date === dateStr
      );

      // Generate time slots
      const timeSlots = [];

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

export { companions as companionRoutes };
