import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { optionalAuthMiddleware } from '../middleware/auth';
import { createRateLimit } from '../middleware/rateLimit';
import { jsonSuccess, jsonError } from '../utils/response';
import type { Env, Variables } from '../index';

const search = new Hono<{ Bindings: Env; Variables: Variables }>();

type SearchSuggestion = {
  type: 'companion' | 'service' | 'location';
  id: string;
  text: string;
  subtitle?: string;
  image: string | null;
};

// Apply optional authentication and rate limiting
search.use('*', optionalAuthMiddleware);
search.use('*', createRateLimit('search'));

// Search suggestions schema
const searchSuggestionsSchema = z.object({
  query: z.string().min(1, 'Query is required'),
  type: z.enum(['companions', 'services', 'locations']).optional()
});

/**
 * Get search suggestions
 */
search.get('/suggestions', zValidator('query', searchSuggestionsSchema), async (c) => {
  const { query, type } = c.req.valid('query');
  
  try {
    const suggestions: SearchSuggestion[] = [];
    const searchTerm = `%${query}%`;

    // Search companions if no type specified or type is companions
    if (!type || type === 'companions') {
      const companionSuggestions = await c.env.DB.prepare(`
        SELECT 
          sp.user_id as id,
          sp.display_name as text,
          sp.bio as subtitle,
          sp.profile_images as image
        FROM supplier_profiles sp
        JOIN users u ON sp.user_id = u.id
        WHERE (sp.display_name LIKE ? OR sp.bio LIKE ?)
          AND COALESCE(sp.subscription_status, 'active') = 'active'
          AND COALESCE(sp.verification_status, 'pending') != 'rejected'
          AND u.status = 'active'
        ORDER BY sp.rating_average DESC
        LIMIT 5
      `).bind(searchTerm, searchTerm).all();

      companionSuggestions.results.forEach((companion: any) => {
        const images = JSON.parse(companion.image || '[]');
        suggestions.push({
          type: 'companion',
          id: companion.id,
          text: companion.text,
          subtitle: companion.subtitle?.substring(0, 100) + '...',
          image: images[0] || null
        });
      });
    }

    // Search services if no type specified or type is services
    if (!type || type === 'services') {
      const serviceSuggestions = await c.env.DB.prepare(`
        SELECT 
          ss.id,
          ss.title as text,
          ss.description as subtitle,
          sp.profile_images as image
        FROM supplier_services ss
        JOIN supplier_profiles sp ON ss.supplier_id = sp.user_id
        WHERE (ss.title LIKE ? OR ss.description LIKE ?)
          AND ss.is_active = TRUE
          AND COALESCE(sp.subscription_status, 'active') = 'active'
          AND COALESCE(sp.verification_status, 'pending') != 'rejected'
        ORDER BY sp.rating_average DESC
        LIMIT 5
      `).bind(searchTerm, searchTerm).all();

      serviceSuggestions.results.forEach((service: any) => {
        const images = JSON.parse(service.image || '[]');
        suggestions.push({
          type: 'service',
          id: service.id,
          text: service.text,
          subtitle: service.subtitle?.substring(0, 100) + '...',
          image: images[0] || null
        });
      });
    }

    // Search locations if no type specified or type is locations
    if (!type || type === 'locations') {
      const locationSuggestions = await c.env.DB.prepare(`
        SELECT 
          r.id,
          r.name_en as text,
          r.country_code as subtitle,
          NULL as image
        FROM regions r
        WHERE r.name_en LIKE ? OR r.name_th LIKE ?
          AND r.is_active = TRUE
        ORDER BY r.sort_order ASC
        LIMIT 5
      `).bind(searchTerm, searchTerm).all();

      locationSuggestions.results.forEach((location: any) => {
        suggestions.push({
          type: 'location',
          id: location.id,
          text: location.text,
          subtitle: location.subtitle,
          image: null
        });
      });
    }

    // Sort suggestions by relevance (exact matches first)
    suggestions.sort((a, b) => {
      const aExact = a.text.toLowerCase().includes(query.toLowerCase()) ? 1 : 0;
      const bExact = b.text.toLowerCase().includes(query.toLowerCase()) ? 1 : 0;
      return bExact - aExact;
    });

    return jsonSuccess(c, {
      suggestions: suggestions.slice(0, 10) // Limit to 10 total suggestions
    }, 'Search suggestions retrieved successfully');

  } catch (error) {
    console.error('Get search suggestions error:', error);
    return jsonError(c, 'Failed to retrieve suggestions', 'An error occurred while fetching search suggestions', 500);
  }
});

/**
 * Get categories
 */
search.get('/categories', async (c) => {
  try {
    // Check cache first
    const cacheKey = 'categories:all';
    const cached = await c.env.CACHE.get(cacheKey);
    
    if (cached) {
      return jsonSuccess(c, JSON.parse(cached), 'Categories retrieved from cache');
    }

    const categoriesResult = await c.env.DB.prepare(`
      SELECT 
        c.id,
        c.name_en as name,
        c.icon,
        c.color,
        c.description_en as description,
        COUNT(DISTINCT sp.user_id) as companionCount
      FROM categories c
      LEFT JOIN supplier_profiles sp ON JSON_EXTRACT(sp.categories, '$') LIKE '%"' || c.id || '"%'
        AND COALESCE(sp.subscription_status, 'active') = 'active'
        AND COALESCE(sp.verification_status, 'pending') != 'rejected'
      WHERE c.is_active = TRUE
      GROUP BY c.id, c.name_en, c.icon, c.color, c.description_en
      ORDER BY c.sort_order ASC, companionCount DESC
    `).all();

    const categories = categoriesResult.results.map((category: any) => ({
      id: category.id,
      name: category.name,
      icon: category.icon,
      color: category.color,
      description: category.description,
      companionCount: category.companionCount
    }));

    // Cache for 1 hour
    await c.env.CACHE.put(cacheKey, JSON.stringify({ categories }), { expirationTtl: 3600 });

    return jsonSuccess(c, {
      categories
    }, 'Categories retrieved successfully');

  } catch (error) {
    console.error('Get categories error:', error);
    return jsonError(c, 'Failed to retrieve categories', 'An error occurred while fetching categories', 500);
  }
});

/**
 * Get locations
 */
search.get('/locations', async (c) => {
  try {
    // Check cache first
    const cacheKey = 'locations:all';
    const cached = await c.env.CACHE.get(cacheKey);
    
    if (cached) {
      return jsonSuccess(c, JSON.parse(cached), 'Locations retrieved from cache');
    }

    const locationsResult = await c.env.DB.prepare(`
      SELECT 
        r.id,
        r.name_en as name,
        r.name_th as region,
        r.country_code as country,
        COUNT(DISTINCT sp.user_id) as companionCount,
        0 as latitude,
        0 as longitude
      FROM regions r
      LEFT JOIN supplier_profiles sp ON JSON_EXTRACT(sp.regions, '$') LIKE '%"' || r.id || '"%'
        AND COALESCE(sp.subscription_status, 'active') = 'active'
        AND COALESCE(sp.verification_status, 'pending') != 'rejected'
      WHERE r.is_active = TRUE
      GROUP BY r.id, r.name_en, r.name_th, r.country_code
      ORDER BY r.sort_order ASC, companionCount DESC
    `).all();

    const locations = locationsResult.results.map((location: any) => ({
      id: location.id,
      name: location.name,
      region: location.region,
      country: location.country,
      companionCount: location.companionCount,
      coordinates: {
        latitude: location.latitude,
        longitude: location.longitude
      }
    }));

    // Cache for 1 hour
    await c.env.CACHE.put(cacheKey, JSON.stringify({ locations }), { expirationTtl: 3600 });

    return jsonSuccess(c, {
      locations
    }, 'Locations retrieved successfully');

  } catch (error) {
    console.error('Get locations error:', error);
    return jsonError(c, 'Failed to retrieve locations', 'An error occurred while fetching locations', 500);
  }
});

/**
 * Get popular searches
 */
search.get('/popular', async (c) => {
  try {
    // Check cache first
    const cacheKey = 'popular_searches';
    const cached = await c.env.CACHE.get(cacheKey);
    
    if (cached) {
      return jsonSuccess(c, JSON.parse(cached), 'Popular searches retrieved from cache');
    }

    // Get popular categories
    const popularCategories = await c.env.DB.prepare(`
      SELECT 
        c.id,
        c.name_en as name,
        COUNT(DISTINCT sp.user_id) as count
      FROM categories c
      JOIN supplier_profiles sp ON JSON_EXTRACT(sp.categories, '$') LIKE '%"' || c.id || '"%'
      WHERE c.is_active = TRUE
        AND COALESCE(sp.subscription_status, 'active') = 'active'
        AND COALESCE(sp.verification_status, 'pending') != 'rejected'
      GROUP BY c.id, c.name_en
      ORDER BY count DESC
      LIMIT 5
    `).all();

    // Get popular locations
    const popularLocations = await c.env.DB.prepare(`
      SELECT 
        r.id,
        r.name_en as name,
        COUNT(DISTINCT sp.user_id) as count
      FROM regions r
      JOIN supplier_profiles sp ON JSON_EXTRACT(sp.regions, '$') LIKE '%"' || r.id || '"%'
      WHERE r.is_active = TRUE
        AND COALESCE(sp.subscription_status, 'active') = 'active'
        AND COALESCE(sp.verification_status, 'pending') != 'rejected'
      GROUP BY r.id, r.name_en
      ORDER BY count DESC
      LIMIT 5
    `).all();

    // Get trending searches from analytics (simplified)
    const trendingSearches = [
      { term: 'Bangkok tour guide', count: 150 },
      { term: 'Food companion', count: 120 },
      { term: 'Shopping assistant', count: 95 },
      { term: 'Cultural experience', count: 80 },
      { term: 'Language practice', count: 65 }
    ];

    const popularData = {
      categories: popularCategories.results.map((cat: any) => ({
        id: cat.id,
        name: cat.name,
        count: cat.count
      })),
      locations: popularLocations.results.map((loc: any) => ({
        id: loc.id,
        name: loc.name,
        count: loc.count
      })),
      searches: trendingSearches
    };

    // Cache for 30 minutes
    await c.env.CACHE.put(cacheKey, JSON.stringify(popularData), { expirationTtl: 1800 });

    return jsonSuccess(c, popularData, 'Popular searches retrieved successfully');

  } catch (error) {
    console.error('Get popular searches error:', error);
    return jsonError(c, 'Failed to retrieve popular searches', 'An error occurred while fetching popular searches', 500);
  }
});

/**
 * Track search query (for analytics)
 */
const trackSearchSchema = z.object({
  query: z.string().min(1, 'Query is required'),
  filters: z.object({
    category: z.string().optional(),
    location: z.string().optional(),
    priceRange: z.object({
      min: z.number().optional(),
      max: z.number().optional()
    }).optional()
  }).optional(),
  resultsCount: z.number().min(0).optional()
});

search.post('/track', zValidator('json', trackSearchSchema), async (c) => {
  const userId = c.get('userId'); // Optional
  const searchData = c.req.valid('json');
  
  try {
    // Track search event for analytics
    await c.env.ANALYTICS_QUEUE.send({
      eventType: 'search_performed',
      userId: userId || 'anonymous',
      properties: {
        query: searchData.query,
        filters: searchData.filters || {},
        resultsCount: searchData.resultsCount || 0,
        hasFilters: !!searchData.filters && Object.keys(searchData.filters).length > 0
      },
      timestamp: new Date().toISOString()
    });

    return jsonSuccess(c, {}, 'Search tracked successfully');

  } catch (error) {
    console.error('Track search error:', error);
    return jsonError(c, 'Failed to track search', 'An error occurred while tracking the search', 500);
  }
});

export { search as searchRoutes };
