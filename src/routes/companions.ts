import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { validateUUID } from '../middleware/validation';
import { optionalAuthMiddleware } from '../middleware/auth';
import { createRateLimit } from '../middleware/rateLimit';
import { jsonSuccess, jsonError, createPagination } from '../utils/response';
import { firstProfileImage, publicProfileImages } from '../utils/profileImages';
import { publicIdentity, publicCompanionVisibility } from '../utils/guideVisibility';
import { registerGuideManagement } from '../utils/guideManagement';
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

registerGuideManagement(companions);

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
      LEFT JOIN supplier_services ss ON sp.user_id = ss.supplier_id AND ss.is_active = TRUE AND ss.archived_at IS NULL
      WHERE ${publicCompanionVisibility}
    `;

    const queryParams: any[] = [...publicIdentity.parameters];

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

    // Count the same grouped/filtered profile set, before ordering and paging.
    const countQuery = `SELECT COUNT(*) as total FROM (${query}) visible_companions`;
    const countResult = await c.env.DB.prepare(countQuery).bind(...queryParams).first();
    const total = countResult?.total as number || 0;

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

    // Get paginated results
    const offset = (searchParams.page - 1) * searchParams.limit;
    const paginatedQuery = `${query} LIMIT ? OFFSET ?`;
    const companionsResult = await c.env.DB.prepare(paginatedQuery)
      .bind(...queryParams, searchParams.limit, offset).all();

    // Format companions data
    const companionsList = companionsResult.results.map((companion: any) => {
      const profileImages = publicProfileImages(companion.profile_images);
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
        responseTime: null, // No measured response-time aggregate exists yet.
        completionRate: null, // No measured completion-rate aggregate exists yet.
        distance: null // Would calculate if user location available
      };
    });

    // Get filter options for the response
    const filtersResult = await c.env.DB.prepare(`
      SELECT 
        c.id as category_id,
        c.name_en as category_name,
        COUNT(DISTINCT CASE WHEN ${publicCompanionVisibility} THEN sp.user_id END) as category_count
      FROM categories c
      LEFT JOIN supplier_profiles sp ON JSON_EXTRACT(sp.categories, '$') LIKE '%"' || c.id || '"%'
      LEFT JOIN users u ON sp.user_id = u.id
      WHERE c.is_active = TRUE
      GROUP BY c.id, c.name_en
      ORDER BY category_count DESC
    `).bind(...publicIdentity.parameters).all();

    const locationsResult = await c.env.DB.prepare(`
      SELECT 
        r.id as location_id,
        r.name_en as location_name,
        COUNT(DISTINCT CASE WHEN ${publicCompanionVisibility} THEN sp.user_id END) as location_count
      FROM regions r
      LEFT JOIN supplier_profiles sp ON JSON_EXTRACT(sp.regions, '$') LIKE '%"' || r.id || '"%'
      LEFT JOIN users u ON sp.user_id = u.id
      WHERE r.is_active = TRUE
      GROUP BY r.id, r.name_en
      ORDER BY location_count DESC
    `).bind(...publicIdentity.parameters).all();

    const priceRangeResult = await c.env.DB.prepare(`
      SELECT 
        MIN(ss.price_min) as min_price,
        MAX(ss.price_max) as max_price
      FROM supplier_services ss
      JOIN supplier_profiles sp ON ss.supplier_id = sp.user_id
      JOIN users u ON sp.user_id = u.id
      WHERE ss.is_active = TRUE AND ss.archived_at IS NULL
        AND ${publicCompanionVisibility}
    `).bind(...publicIdentity.parameters).first();

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
        max: priceRangeResult?.max_price || 0
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
      SELECT sp.user_id FROM supplier_profiles sp
      JOIN users u ON sp.user_id = u.id
      WHERE sp.user_id = ? AND ${publicCompanionVisibility}
    `).bind(companionId, ...publicIdentity.parameters).first();

    if (!companion) {
      return jsonError(c, 'Companion not found', 'The requested companion does not exist', 404);
    }

    const servicesResult = await c.env.DB.prepare(`
      SELECT id, title, description, price_min, currency, duration_hours
      FROM supplier_services
      WHERE supplier_id = ? AND is_active = TRUE AND archived_at IS NULL
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
        AND ${publicCompanionVisibility}
    `).bind(companionId, ...publicIdentity.parameters).first();

    if (!companion) {
      return jsonError(c, 'Companion not found', 'The requested companion does not exist or is not available', 404);
    }

    // Get services
    const services = await c.env.DB.prepare(`
      SELECT
        ss.*,
        NULL as category_name
      FROM supplier_services ss
      WHERE ss.supplier_id = ? AND ss.is_active = TRUE AND ss.archived_at IS NULL
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
    const profileImages = publicProfileImages(companionRow.profile_images);
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
      responseTime: null,
      completionRate: null,
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

export { companions as companionRoutes };
