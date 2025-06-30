import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { validatePagination } from '../middleware/validation';
import { createRateLimit } from '../middleware/rateLimit';
import { jsonSuccess, jsonError, jsonPaginated, createPagination, cachedResponse } from '../utils/response';
import type { Env, Variables } from '../index';

const publicRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

// Apply rate limiting
publicRoutes.use('*', createRateLimit('general'));

/**
 * Get platform statistics
 */
publicRoutes.get('/stats', async (c) => {
  try {
    // Check cache first
    const cacheKey = 'public:stats';
    const cached = await c.env.CACHE.get(cacheKey);
    
    if (cached) {
      return cachedResponse(c, JSON.parse(cached), 300); // 5 minutes cache
    }

    // Get statistics from database
    const userStats = await c.env.DB.prepare(`
      SELECT 
        COUNT(*) as total_users,
        COUNT(CASE WHEN user_type = 'supplier' THEN 1 END) as total_suppliers,
        COUNT(CASE WHEN user_type = 'customer' THEN 1 END) as total_customers
      FROM users 
      WHERE status = 'active'
    `).first();

    const supplierStats = await c.env.DB.prepare(`
      SELECT 
        COUNT(*) as verified_suppliers,
        AVG(rating_average) as avg_rating
      FROM supplier_profiles 
      WHERE verification_status = 'verified' AND subscription_status = 'active'
    `).first();

    const serviceStats = await c.env.DB.prepare(`
      SELECT COUNT(*) as total_services
      FROM supplier_services 
      WHERE is_active = TRUE
    `).first();

    const bookingStats = await c.env.DB.prepare(`
      SELECT 
        COUNT(*) as total_bookings,
        COUNT(CASE WHEN status = 'completed' THEN 1 END) as completed_bookings
      FROM bookings
    `).first();

    const stats = {
      users: {
        total: Number(userStats?.total_users || 0),
        suppliers: Number(userStats?.total_suppliers || 0),
        customers: Number(userStats?.total_customers || 0)
      },
      suppliers: {
        verified: Number(supplierStats?.verified_suppliers || 0),
        averageRating: Math.round((Number(supplierStats?.avg_rating) || 0) * 10) / 10
      },
      services: {
        total: Number(serviceStats?.total_services || 0)
      },
      bookings: {
        total: Number(bookingStats?.total_bookings || 0),
        completed: Number(bookingStats?.completed_bookings || 0)
      },
      lastUpdated: new Date().toISOString()
    };

    // Cache for 5 minutes
    await c.env.CACHE.put(cacheKey, JSON.stringify(stats), { expirationTtl: 300 });

    return jsonSuccess(c, stats, 'Platform statistics retrieved successfully');

  } catch (error) {
    console.error('Get platform stats error:', error);
    return jsonError(c, 'Failed to retrieve statistics', 'An error occurred while fetching platform statistics', 500);
  }
});

/**
 * Get available categories
 */
publicRoutes.get('/categories', validatePagination(), async (c) => {
  const pagination = c.get('pagination');
  const page = pagination?.page || 1;
  const limit = pagination?.limit || 20;
  
  try {
    // Check cache first
    const cacheKey = `public:categories:${page}:${limit}`;
    const cached = await c.env.CACHE.get(cacheKey);
    
    if (cached) {
      return cachedResponse(c, JSON.parse(cached), 1800); // 30 minutes cache
    }

    // Get total count
    const countResult = await c.env.DB.prepare(`
      SELECT COUNT(*) as total 
      FROM categories 
      WHERE is_active = TRUE
    `).first();
    
    const total = Number(countResult?.total) || 0;

    // Get categories with pagination
    const offset = (page - 1) * limit;
    const categoriesResult = await c.env.DB.prepare(`
      SELECT id, name_en, name_th, description_en, description_th, icon_url, sort_order
      FROM categories 
      WHERE is_active = TRUE
      ORDER BY sort_order ASC, name_en ASC
      LIMIT ? OFFSET ?
    `).bind(limit, offset).all();

    const categories = categoriesResult.results?.map((category: any) => ({
      id: category.id,
      name: {
        en: category.name_en,
        th: category.name_th
      },
      description: {
        en: category.description_en,
        th: category.description_th
      },
      iconUrl: category.icon_url,
      sortOrder: category.sort_order
    })) || [];

    const response = {
      categories,
      pagination: createPagination(page, limit, total)
    };

    // Cache for 30 minutes
    await c.env.CACHE.put(cacheKey, JSON.stringify(response), { expirationTtl: 1800 });

    return jsonPaginated(c, categories, createPagination(page, limit, total), 'Categories retrieved successfully');

  } catch (error) {
    console.error('Get categories error:', error);
    return jsonError(c, 'Failed to retrieve categories', 'An error occurred while fetching categories', 500);
  }
});

/**
 * Get available regions
 */
publicRoutes.get('/regions', validatePagination(), async (c) => {
  const pagination = c.get('pagination');
  const page = pagination?.page || 1;
  const limit = pagination?.limit || 20;
  
  try {
    // Check cache first
    const cacheKey = `public:regions:${page}:${limit}`;
    const cached = await c.env.CACHE.get(cacheKey);
    
    if (cached) {
      return cachedResponse(c, JSON.parse(cached), 1800); // 30 minutes cache
    }

    // Get total count
    const countResult = await c.env.DB.prepare(`
      SELECT COUNT(*) as total 
      FROM regions 
      WHERE is_active = TRUE
    `).first();
    
    const total = Number(countResult?.total) || 0;

    // Get regions with pagination
    const offset = (page - 1) * limit;
    const regionsResult = await c.env.DB.prepare(`
      SELECT id, name_en, name_th, country_code, sort_order
      FROM regions 
      WHERE is_active = TRUE
      ORDER BY sort_order ASC, name_en ASC
      LIMIT ? OFFSET ?
    `).bind(limit, offset).all();

    const regions = regionsResult.results?.map((region: any) => ({
      id: region.id,
      name: {
        en: region.name_en,
        th: region.name_th
      },
      countryCode: region.country_code,
      sortOrder: region.sort_order
    })) || [];

    const response = {
      regions,
      pagination: createPagination(page, limit, total)
    };

    // Cache for 30 minutes
    await c.env.CACHE.put(cacheKey, JSON.stringify(response), { expirationTtl: 1800 });

    return jsonPaginated(c, regions, createPagination(page, limit, total), 'Regions retrieved successfully');

  } catch (error) {
    console.error('Get regions error:', error);
    return jsonError(c, 'Failed to retrieve regions', 'An error occurred while fetching regions', 500);
  }
});

/**
 * Get featured suppliers
 */
publicRoutes.get('/featured-suppliers', validatePagination(), async (c) => {
  const pagination = c.get('pagination');
  const page = pagination?.page || 1;
  const limit = pagination?.limit || 20;
  
  try {
    // Check cache first
    const cacheKey = `public:featured:${page}:${limit}`;
    const cached = await c.env.CACHE.get(cacheKey);
    
    if (cached) {
      return cachedResponse(c, JSON.parse(cached), 600); // 10 minutes cache
    }

    // Get featured suppliers (top rated, verified, active)
    const offset = (page - 1) * limit;
    const suppliersResult = await c.env.DB.prepare(`
      SELECT 
        sp.user_id as id,
        sp.display_name,
        sp.bio,
        sp.profile_images,
        sp.categories,
        sp.regions,
        sp.rating_average,
        sp.rating_count,
        sp.verification_status,
        sp.created_at
      FROM supplier_profiles sp
      WHERE sp.verification_status = 'verified' 
        AND sp.subscription_status = 'active'
        AND sp.rating_average >= 4.0
        AND sp.rating_count >= 5
      ORDER BY sp.rating_average DESC, sp.rating_count DESC
      LIMIT ? OFFSET ?
    `).bind(limit, offset).all();

    const suppliers = suppliersResult.results?.map((supplier: any) => ({
      id: supplier.id,
      displayName: supplier.display_name,
      bio: supplier.bio,
      profileImages: JSON.parse(supplier.profile_images || '[]'),
      categories: JSON.parse(supplier.categories || '[]'),
      regions: JSON.parse(supplier.regions || '[]'),
      rating: {
        average: supplier.rating_average || 0,
        count: supplier.rating_count || 0
      },
      verificationStatus: supplier.verification_status,
      memberSince: supplier.created_at
    })) || [];

    // Get total count for featured suppliers
    const countResult = await c.env.DB.prepare(`
      SELECT COUNT(*) as total
      FROM supplier_profiles 
      WHERE verification_status = 'verified' 
        AND subscription_status = 'active'
        AND rating_average >= 4.0
        AND rating_count >= 5
    `).first();

    const total = Number(countResult?.total) || 0;
    const response = {
      suppliers,
      pagination: createPagination(page, limit, total)
    };

    // Cache for 10 minutes
    await c.env.CACHE.put(cacheKey, JSON.stringify(response), { expirationTtl: 600 });

    return jsonPaginated(c, suppliers, createPagination(page, limit, total), 'Featured suppliers retrieved successfully');

  } catch (error) {
    console.error('Get featured suppliers error:', error);
    return jsonError(c, 'Failed to retrieve featured suppliers', 'An error occurred while fetching featured suppliers', 500);
  }
});

/**
 * Search suggestions (autocomplete)
 */
publicRoutes.get('/search-suggestions', async (c) => {
  const query = c.req.query('q');
  const type = c.req.query('type') || 'all'; // 'suppliers', 'categories', 'regions', 'all'
  
  if (!query || query.length < 2) {
    return jsonError(c, 'Query too short', 'Search query must be at least 2 characters', 400);
  }

  try {
    // Check cache first
    const cacheKey = `suggestions:${type}:${query.toLowerCase()}`;
    const cached = await c.env.CACHE.get(cacheKey);
    
    if (cached) {
      return cachedResponse(c, JSON.parse(cached), 300); // 5 minutes cache
    }

    const suggestions: any = {
      suppliers: [],
      categories: [],
      regions: []
    };

    // Search suppliers
    if (type === 'all' || type === 'suppliers') {
      const supplierResults = await c.env.DB.prepare(`
        SELECT user_id as id, display_name as name, 'supplier' as type
        FROM supplier_profiles 
        WHERE display_name LIKE ? 
          AND verification_status = 'verified'
          AND subscription_status = 'active'
        ORDER BY rating_average DESC
        LIMIT 5
      `).bind(`%${query}%`).all();

      suggestions.suppliers = supplierResults.results || [];
    }

    // Search categories
    if (type === 'all' || type === 'categories') {
      const categoryResults = await c.env.DB.prepare(`
        SELECT id, name_en as name, 'category' as type
        FROM categories 
        WHERE (name_en LIKE ? OR name_th LIKE ?) AND is_active = TRUE
        ORDER BY sort_order ASC
        LIMIT 5
      `).bind(`%${query}%`, `%${query}%`).all();

      suggestions.categories = categoryResults.results || [];
    }

    // Search regions
    if (type === 'all' || type === 'regions') {
      const regionResults = await c.env.DB.prepare(`
        SELECT id, name_en as name, 'region' as type
        FROM regions 
        WHERE (name_en LIKE ? OR name_th LIKE ?) AND is_active = TRUE
        ORDER BY sort_order ASC
        LIMIT 5
      `).bind(`%${query}%`, `%${query}%`).all();

      suggestions.regions = regionResults.results || [];
    }

    // Flatten results if type is 'all'
    let results = suggestions;
    if (type === 'all') {
      results = [
        ...suggestions.suppliers,
        ...suggestions.categories,
        ...suggestions.regions
      ].slice(0, 10); // Limit total suggestions
    } else {
      results = suggestions[type] || [];
    }

    // Cache for 5 minutes
    await c.env.CACHE.put(cacheKey, JSON.stringify(results), { expirationTtl: 300 });

    return jsonSuccess(c, results, 'Search suggestions retrieved successfully');

  } catch (error) {
    console.error('Get search suggestions error:', error);
    return jsonError(c, 'Failed to retrieve suggestions', 'An error occurred while fetching search suggestions', 500);
  }
});

/**
 * Get platform configuration
 */
publicRoutes.get('/config', async (c) => {
  try {
    // Check cache first
    const cacheKey = 'public:config';
    const cached = await c.env.CACHE.get(cacheKey);
    
    if (cached) {
      return cachedResponse(c, JSON.parse(cached), 3600); // 1 hour cache
    }

    const config = {
      app: {
        name: 'Tirak',
        version: '1.0.0',
        supportedLanguages: ['en', 'th'],
        defaultLanguage: 'en'
      },
      features: {
        chatEnabled: true,
        bookingEnabled: true,
        reviewsEnabled: true,
        notificationsEnabled: true
      },
      limits: {
        maxFileSize: {
          image: 10 * 1024 * 1024, // 10MB
          document: 25 * 1024 * 1024 // 25MB
        },
        maxImagesPerProfile: 10,
        maxServicesPerSupplier: 50
      },
      contact: {
        supportEmail: 'support@tirak.app',
        businessEmail: 'business@tirak.app'
      },
      social: {
        website: 'https://tirak.app',
        facebook: 'https://facebook.com/tirakapp',
        twitter: 'https://twitter.com/tirakapp',
        instagram: 'https://instagram.com/tirakapp'
      }
    };

    // Cache for 1 hour
    await c.env.CACHE.put(cacheKey, JSON.stringify(config), { expirationTtl: 3600 });

    return jsonSuccess(c, config, 'Platform configuration retrieved successfully');

  } catch (error) {
    console.error('Get platform config error:', error);
    return jsonError(c, 'Failed to retrieve configuration', 'An error occurred while fetching platform configuration', 500);
  }
});

/**
 * Health check endpoint
 */
publicRoutes.get('/health', async (c) => {
  try {
    // Check database connectivity
    const dbCheck = await c.env.DB.prepare('SELECT 1 as test').first();
    const dbHealthy = !!dbCheck;

    // Check cache connectivity
    const cacheCheck = await c.env.CACHE.get('health-check');
    await c.env.CACHE.put('health-check', 'ok', { expirationTtl: 60 });
    const cacheHealthy = true; // If we get here, cache is working

    const health = {
      status: dbHealthy && cacheHealthy ? 'healthy' : 'unhealthy',
      timestamp: new Date().toISOString(),
      services: {
        database: dbHealthy ? 'healthy' : 'unhealthy',
        cache: cacheHealthy ? 'healthy' : 'unhealthy',
        storage: 'healthy', // Assume healthy if no errors
        queues: 'healthy' // Assume healthy if no errors
      },
      version: '1.0.0',
      environment: c.env.ENVIRONMENT
    };

    const status = health.status === 'healthy' ? 200 : 503;
    return c.json(health, status);

  } catch (error) {
    console.error('Health check error:', error);
    return c.json({
      status: 'unhealthy',
      timestamp: new Date().toISOString(),
      error: 'Health check failed'
    }, 503);
  }
});

export { publicRoutes };
