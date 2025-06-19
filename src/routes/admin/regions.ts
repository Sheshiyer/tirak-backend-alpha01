import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { authMiddleware, adminOnly } from '../../middleware/auth';
import { createRateLimit } from '../../middleware/rateLimit';
import { adminCors } from '../../middleware/cors';
import { jsonSuccess, jsonError, jsonPaginated, createPagination } from '../../utils/response';
import { validatePagination, validateUUID } from '../../middleware/validation';
import type { Env, Variables } from '../../index';

const regions = new Hono<{ Bindings: Env; Variables: Variables }>();

// Apply admin-specific middleware
regions.use('*', adminCors());
regions.use('*', authMiddleware);
regions.use('*', adminOnly);
regions.use('*', createRateLimit('admin'));

// Validation schemas
const regionUpdateSchema = z.object({
  manager: z.string().optional(),
  settings: z.record(z.any()).optional(),
  isActive: z.boolean().optional(),
  priorityLevel: z.enum(['low', 'medium', 'high']).optional(),
});

/**
 * Get regional management stats
 */
regions.get('/stats', async (c) => {
  try {
    // Get total revenue from bookings
    const revenueResult = await c.env.DB.prepare(`
      SELECT SUM(total_amount) as total_revenue
      FROM bookings
      WHERE status = 'completed'
    `).first();
    
    // Get total suppliers count
    const suppliersResult = await c.env.DB.prepare(`
      SELECT COUNT(*) as total_suppliers
      FROM supplier_profiles
      WHERE verification_status = 'verified'
    `).first();
    
    // Get total customers count
    const customersResult = await c.env.DB.prepare(`
      SELECT COUNT(*) as total_customers
      FROM customer_profiles
    `).first();
    
    // Get total bookings count
    const bookingsResult = await c.env.DB.prepare(`
      SELECT COUNT(*) as total_bookings
      FROM bookings
    `).first();
    
    // Calculate average growth from business metrics
    const growthResult = await c.env.DB.prepare(`
      SELECT AVG(
        (current.revenue - previous.revenue) / previous.revenue * 100
      ) as avg_growth
      FROM (
        SELECT date, revenue
        FROM business_metrics
        ORDER BY date DESC
        LIMIT 30
      ) as current
      JOIN (
        SELECT date, revenue
        FROM business_metrics
        ORDER BY date DESC
        LIMIT 30 OFFSET 30
      ) as previous
      ON 1=1
    `).first();
    
    // Find best performing region based on revenue
    const bestRegionResult = await c.env.DB.prepare(`
      SELECT r.name_en as region_name
      FROM regions r
      JOIN (
        SELECT 
          json_extract(sp.regions, '$[0]') as region_id,
          SUM(b.total_amount) as revenue
        FROM bookings b
        JOIN supplier_profiles sp ON b.supplier_id = sp.user_id
        WHERE b.status = 'completed'
        GROUP BY json_extract(sp.regions, '$[0]')
        ORDER BY revenue DESC
        LIMIT 1
      ) as top_region ON r.id = top_region.region_id
    `).first();
    
    // Find worst performing region based on revenue
    const worstRegionResult = await c.env.DB.prepare(`
      SELECT r.name_en as region_name
      FROM regions r
      JOIN (
        SELECT 
          json_extract(sp.regions, '$[0]') as region_id,
          SUM(b.total_amount) as revenue
        FROM bookings b
        JOIN supplier_profiles sp ON b.supplier_id = sp.user_id
        WHERE b.status = 'completed'
        GROUP BY json_extract(sp.regions, '$[0]')
        ORDER BY revenue ASC
        LIMIT 1
      ) as bottom_region ON r.id = bottom_region.region_id
    `).first();
    
    // Handle the avgGrowth value properly to avoid "toFixed is not a function" error
    const avgGrowthValue = Number(growthResult?.avg_growth || 0);
    
    const statsData = {
      totalRevenue: Number(revenueResult?.total_revenue || 0),
      totalSuppliers: Number(suppliersResult?.total_suppliers || 0),
      totalCustomers: Number(customersResult?.total_customers || 0),
      totalBookings: Number(bookingsResult?.total_bookings || 0),
      avgGrowth: isNaN(avgGrowthValue) ? "0.0" : avgGrowthValue.toFixed(1),
      bestPerforming: bestRegionResult?.region_name || 'Bangkok',
      worstPerforming: worstRegionResult?.region_name || 'Chiang Rai'
    };

    return jsonSuccess(c, statsData, 'Regional statistics retrieved successfully');

  } catch (error) {
    console.error('Regional stats error:', error);
    return jsonError(c, 'Failed to load regional stats', 'An error occurred while loading regional statistics', 500);
  }
});

/**
 * Get all regions with filtering and pagination
 */
regions.get('/', validatePagination(), async (c) => {
  const { page, limit } = c.get('validatedQuery');
  const regionFilter = c.req.query('region');
  
  try {
    // Build the base query for counting total regions
    let countQuery = `
      SELECT COUNT(*) as total
      FROM regions r
      WHERE r.is_active = TRUE
    `;
    
    // Build the base query for fetching regions with metrics
    let regionsQuery = `
      SELECT 
        r.id,
        r.name_en as region,
        r.country_code as province,
        (
          SELECT COUNT(*)
          FROM supplier_profiles sp
          WHERE json_extract(sp.regions, '$') LIKE '%' || r.id || '%'
          AND sp.verification_status = 'verified'
        ) as active_suppliers,
        (
          SELECT COUNT(DISTINCT b.customer_id)
          FROM bookings b
          JOIN supplier_profiles sp ON b.supplier_id = sp.user_id
          WHERE json_extract(sp.regions, '$') LIKE '%' || r.id || '%'
        ) as active_customers,
        (
          SELECT COUNT(*)
          FROM bookings b
          JOIN supplier_profiles sp ON b.supplier_id = sp.user_id
          WHERE json_extract(sp.regions, '$') LIKE '%' || r.id || '%'
        ) as total_bookings,
        (
          SELECT COALESCE(SUM(b.total_amount), 0)
          FROM bookings b
          JOIN supplier_profiles sp ON b.supplier_id = sp.user_id
          WHERE json_extract(sp.regions, '$') LIKE '%' || r.id || '%'
          AND b.status = 'completed'
        ) as revenue,
        (
          SELECT COALESCE(
            (
              SELECT (current.revenue - previous.revenue) / NULLIF(previous.revenue, 0) * 100
              FROM (
                SELECT SUM(b.total_amount) as revenue
                FROM bookings b
                JOIN supplier_profiles sp ON b.supplier_id = sp.user_id
                WHERE json_extract(sp.regions, '$') LIKE '%' || r.id || '%'
                AND b.created_at >= date('now', '-30 days')
              ) as current,
              (
                SELECT SUM(b.total_amount) as revenue
                FROM bookings b
                JOIN supplier_profiles sp ON b.supplier_id = sp.user_id
                WHERE json_extract(sp.regions, '$') LIKE '%' || r.id || '%'
                AND b.created_at >= date('now', '-60 days')
                AND b.created_at < date('now', '-30 days')
              ) as previous
            ), 0
          )
        ) as growth_rate,
        CASE
          WHEN (
            SELECT AVG(r.rating)
            FROM reviews r
            JOIN bookings b ON r.booking_id = b.id
            JOIN supplier_profiles sp ON b.supplier_id = sp.user_id
            WHERE json_extract(sp.regions, '$') LIKE '%' || r.id || '%'
          ) > 4.5 THEN 'excellent'
          WHEN (
            SELECT AVG(r.rating)
            FROM reviews r
            JOIN bookings b ON r.booking_id = b.id
            JOIN supplier_profiles sp ON b.supplier_id = sp.user_id
            WHERE json_extract(sp.regions, '$') LIKE '%' || r.id || '%'
          ) > 4.0 THEN 'good'
          ELSE 'needs_improvement'
        END as compliance,
        (
          SELECT u.email
          FROM users u
          WHERE u.user_type = 'admin'
          ORDER BY u.created_at
          LIMIT 1
        ) as manager
      FROM regions r
      WHERE r.is_active = TRUE
    `;
    
    // Add filter conditions if a region filter is provided
    let params = [];
    if (regionFilter && regionFilter !== 'all') {
      countQuery += ` AND r.id LIKE ?`;
      regionsQuery += ` AND r.id LIKE ?`;
      params.push(`${regionFilter}%`);
    }
    
    // Add sorting and pagination
    regionsQuery += ` ORDER BY r.sort_order ASC, r.name_en ASC LIMIT ? OFFSET ?`;
    const offset = (page - 1) * limit;
    params.push(limit, offset);
    
    // Execute count query
    const countResult = await c.env.DB.prepare(countQuery).bind(...params.slice(0, -2)).first();
    const total = Number(countResult?.total || 0);
    
    // Execute regions query
    const regionsResult = await c.env.DB.prepare(regionsQuery).bind(...params).all();
    
    // Format the results
    const regions = regionsResult.results?.map((r: any) => ({
      id: r.id,
      region: r.region,
      province: r.province,
      activeSuppliers: Number(r.active_suppliers || 0),
      activeCustomers: Number(r.active_customers || 0),
      totalBookings: Number(r.total_bookings || 0),
      revenue: Number(r.revenue || 0),
      growthRate: Number(r.growth_rate || 0),
      compliance: r.compliance || 'good',
      manager: r.manager || 'Admin'
    })) || [];
    
    // Create pagination info
    const pagination = createPagination(page, limit, total);

    return jsonPaginated(c, regions, pagination, 'Regions retrieved successfully');

  } catch (error) {
    console.error('Regions error:', error);
    return jsonError(c, 'Failed to retrieve regions', 'An error occurred while retrieving regions', 500);
  }
});

/**
 * Get specific region details
 */
regions.get('/details/:regionId', validateUUID('regionId'), async (c) => {
  const regionId = c.req.param('regionId');
  
  try {
    // Get basic region info
    const regionResult = await c.env.DB.prepare(`
      SELECT 
        r.id,
        r.name_en as region,
        r.country_code as province,
        r.created_at as established
      FROM regions r
      WHERE r.id = ?
    `).bind(regionId).first();
    
    if (!regionResult) {
      return jsonError(c, 'Region not found', 'The specified region does not exist', 404);
    }
    
    // Get region metrics
    const metricsResult = await c.env.DB.prepare(`
      SELECT 
        (
          SELECT COUNT(*)
          FROM supplier_profiles sp
          WHERE json_extract(sp.regions, '$') LIKE '%' || ? || '%'
          AND sp.verification_status = 'verified'
        ) as active_suppliers,
        (
          SELECT COUNT(DISTINCT b.customer_id)
          FROM bookings b
          JOIN supplier_profiles sp ON b.supplier_id = sp.user_id
          WHERE json_extract(sp.regions, '$') LIKE '%' || ? || '%'
        ) as active_customers,
        (
          SELECT COUNT(*)
          FROM bookings b
          JOIN supplier_profiles sp ON b.supplier_id = sp.user_id
          WHERE json_extract(sp.regions, '$') LIKE '%' || ? || '%'
        ) as total_bookings,
        (
          SELECT COALESCE(SUM(b.total_amount), 0)
          FROM bookings b
          JOIN supplier_profiles sp ON b.supplier_id = sp.user_id
          WHERE json_extract(sp.regions, '$') LIKE '%' || ? || '%'
          AND b.status = 'completed'
        ) as revenue,
        (
          SELECT COALESCE(
            (
              SELECT (current.revenue - previous.revenue) / NULLIF(previous.revenue, 0) * 100
              FROM (
                SELECT SUM(b.total_amount) as revenue
                FROM bookings b
                JOIN supplier_profiles sp ON b.supplier_id = sp.user_id
                WHERE json_extract(sp.regions, '$') LIKE '%' || ? || '%'
                AND b.created_at >= date('now', '-30 days')
              ) as current,
              (
                SELECT SUM(b.total_amount) as revenue
                FROM bookings b
                JOIN supplier_profiles sp ON b.supplier_id = sp.user_id
                WHERE json_extract(sp.regions, '$') LIKE '%' || ? || '%'
                AND b.created_at >= date('now', '-60 days')
                AND b.created_at < date('now', '-30 days')
              ) as previous
            ), 0
          )
        ) as growth_rate,
        CASE
          WHEN (
            SELECT AVG(r.rating)
            FROM reviews r
            JOIN bookings b ON r.booking_id = b.id
            JOIN supplier_profiles sp ON b.supplier_id = sp.user_id
            WHERE json_extract(sp.regions, '$') LIKE '%' || ? || '%'
          ) > 4.5 THEN 'excellent'
          WHEN (
            SELECT AVG(r.rating)
            FROM reviews r
            JOIN bookings b ON r.booking_id = b.id
            JOIN supplier_profiles sp ON b.supplier_id = sp.user_id
            WHERE json_extract(sp.regions, '$') LIKE '%' || ? || '%'
          ) > 4.0 THEN 'good'
          ELSE 'needs_improvement'
        END as compliance,
        (
          SELECT u.email
          FROM users u
          WHERE u.user_type = 'admin'
          ORDER BY u.created_at
          LIMIT 1
        ) as manager
    `).bind(
      regionId, regionId, regionId, regionId, 
      regionId, regionId, regionId, regionId
    ).first();
    
    // Get population and area data (this would typically come from a region_details table,
    // but since we don't have one, we'll use a system_config table or fallback to defaults)
    const regionDetailsResult = await c.env.DB.prepare(`
      SELECT 
        COALESCE(
          (SELECT value FROM system_config WHERE key = ?), 
          CASE 
            WHEN ? LIKE 'BKK%' THEN '8281000'
            WHEN ? LIKE 'CNX%' THEN '1200000'
            WHEN ? LIKE 'HKT%' THEN '416000'
            ELSE '300000'
          END
        ) as population,
        COALESCE(
          (SELECT value FROM system_config WHERE key = ?), 
          CASE 
            WHEN ? LIKE 'BKK%' THEN '1569'
            WHEN ? LIKE 'CNX%' THEN '20107'
            WHEN ? LIKE 'HKT%' THEN '576'
            ELSE '500'
          END
        ) as area
    `).bind(
      `region_${regionId}_population`, regionId, regionId, regionId,
      `region_${regionId}_area`, regionId, regionId, regionId
    ).first();
    
    // Get service categories
    const serviceCategoriesResult = await c.env.DB.prepare(`
      SELECT 
        c.name_en as name,
        COUNT(ss.id) as count,
        COALESCE(
          (
            SELECT (current.count - previous.count) / NULLIF(previous.count, 0) * 100
            FROM (
              SELECT COUNT(*) as count
              FROM supplier_services ss
              JOIN supplier_profiles sp ON ss.supplier_id = sp.user_id
              WHERE json_extract(sp.regions, '$') LIKE '%' || ? || '%'
              AND ss.category_id = c.id
              AND ss.created_at >= date('now', '-30 days')
            ) as current,
            (
              SELECT COUNT(*) as count
              FROM supplier_services ss
              JOIN supplier_profiles sp ON ss.supplier_id = sp.user_id
              WHERE json_extract(sp.regions, '$') LIKE '%' || ? || '%'
              AND ss.category_id = c.id
              AND ss.created_at >= date('now', '-60 days')
              AND ss.created_at < date('now', '-30 days')
            ) as previous
          ), 0
        ) as growth
      FROM categories c
      JOIN supplier_services ss ON ss.category_id = c.id
      JOIN supplier_profiles sp ON ss.supplier_id = sp.user_id
      WHERE json_extract(sp.regions, '$') LIKE '%' || ? || '%'
      GROUP BY c.id
      ORDER BY count DESC
      LIMIT 4
    `).bind(regionId, regionId, regionId).all();
    
    // Get top suppliers
    const topSuppliersResult = await c.env.DB.prepare(`
      SELECT 
        sp.user_id as id,
        sp.display_name as name,
        sp.rating_average as rating,
        COUNT(b.id) as bookings,
        SUM(b.total_amount) as revenue
      FROM supplier_profiles sp
      JOIN bookings b ON sp.user_id = b.supplier_id
      WHERE json_extract(sp.regions, '$') LIKE '%' || ? || '%'
      AND b.status = 'completed'
      GROUP BY sp.user_id
      ORDER BY revenue DESC
      LIMIT 3
    `).bind(regionId).all();
    
    // Get monthly trends
    const monthlyTrendsResult = await c.env.DB.prepare(`
      SELECT 
        strftime('%m', b.created_at) as month_num,
        CASE strftime('%m', b.created_at)
          WHEN '01' THEN 'Jan'
          WHEN '02' THEN 'Feb'
          WHEN '03' THEN 'Mar'
          WHEN '04' THEN 'Apr'
          WHEN '05' THEN 'May'
          WHEN '06' THEN 'Jun'
          WHEN '07' THEN 'Jul'
          WHEN '08' THEN 'Aug'
          WHEN '09' THEN 'Sep'
          WHEN '10' THEN 'Oct'
          WHEN '11' THEN 'Nov'
          WHEN '12' THEN 'Dec'
        END as month,
        COUNT(b.id) as bookings,
        SUM(b.total_amount) as revenue,
        COUNT(DISTINCT b.customer_id) as customers
      FROM bookings b
      JOIN supplier_profiles sp ON b.supplier_id = sp.user_id
      WHERE json_extract(sp.regions, '$') LIKE '%' || ? || '%'
      AND b.created_at >= date('now', '-5 months')
      GROUP BY month_num
      ORDER BY month_num
      LIMIT 5
    `).bind(regionId).all();
    
    // Format the results
    const serviceCategories = serviceCategoriesResult.results?.map((cat: any) => ({
      name: cat.name,
      count: Number(cat.count || 0),
      growth: Number(cat.growth || 0)
    })) || [];
    
    const topSuppliers = topSuppliersResult.results?.map((sup: any) => ({
      id: sup.id,
      name: sup.name,
      rating: Number(sup.rating || 0),
      bookings: Number(sup.bookings || 0),
      revenue: Number(sup.revenue || 0)
    })) || [];
    
    const monthlyTrends = monthlyTrendsResult.results?.map((trend: any) => ({
      month: trend.month,
      bookings: Number(trend.bookings || 0),
      revenue: Number(trend.revenue || 0),
      customers: Number(trend.customers || 0)
    })) || [];
    
    // Combine all data
    const regionDetails = {
      id: regionResult.id,
      region: regionResult.region,
      province: regionResult.province,
      activeSuppliers: Number(metricsResult?.active_suppliers || 0),
      activeCustomers: Number(metricsResult?.active_customers || 0),
      totalBookings: Number(metricsResult?.total_bookings || 0),
      revenue: Number(metricsResult?.revenue || 0),
      growthRate: Number(metricsResult?.growth_rate || 0),
      compliance: metricsResult?.compliance || 'good',
      manager: metricsResult?.manager || 'Admin',
      population: Number(regionDetailsResult?.population || 0),
      area: Number(regionDetailsResult?.area || 0),
      established: regionResult.established,
      serviceCategories,
      topSuppliers,
      monthlyTrends
    };

    return jsonSuccess(c, regionDetails, 'Region details retrieved successfully');
  } catch (error) {
    console.error('Region details error:', error);
    return jsonError(c, 'Failed to retrieve region details', 'An error occurred while retrieving region details', 500);
  }
});

/**
 * Get regional map data
 */
regions.get('/map', async (c) => {
  try {
    // Get regions with coordinates from system_config
    // In a real system, coordinates would likely be stored in a dedicated table
    // Here we're using system_config as a flexible storage for this data
    const regionsResult = await c.env.DB.prepare(`
      SELECT 
        r.id,
        r.name_en as name,
        COALESCE(
          (SELECT value FROM system_config WHERE key = 'region_' || r.id || '_lat'), 
          CASE 
            WHEN r.id LIKE 'BKK%' THEN '13.7563'
            WHEN r.id LIKE 'PTY%' THEN '12.9236'
            WHEN r.id LIKE 'CNX%' THEN '18.7883'
            WHEN r.id LIKE 'HKT%' THEN '7.9519'
            WHEN r.id LIKE 'KBV%' THEN '8.0863'
            WHEN r.id LIKE 'URT%' THEN '9.1393'
            WHEN r.id LIKE 'HDY%' THEN '7.0086'
            WHEN r.id LIKE 'KKC%' THEN '16.4419'
            WHEN r.id LIKE 'UTH%' THEN '17.4139'
            WHEN r.id LIKE 'UBP%' THEN '15.2400'
            ELSE '13.7563' -- Default to Bangkok
          END
        ) as lat,
        COALESCE(
          (SELECT value FROM system_config WHERE key = 'region_' || r.id || '_lng'), 
          CASE 
            WHEN r.id LIKE 'BKK%' THEN '100.5018'
            WHEN r.id LIKE 'PTY%' THEN '100.8824'
            WHEN r.id LIKE 'CNX%' THEN '98.9853'
            WHEN r.id LIKE 'HKT%' THEN '98.3381'
            WHEN r.id LIKE 'KBV%' THEN '98.9063'
            WHEN r.id LIKE 'URT%' THEN '99.3217'
            WHEN r.id LIKE 'HDY%' THEN '100.4747'
            WHEN r.id LIKE 'KKC%' THEN '102.8360'
            WHEN r.id LIKE 'UTH%' THEN '102.7871'
            WHEN r.id LIKE 'UBP%' THEN '104.8470'
            ELSE '100.5018' -- Default to Bangkok
          END
        ) as lng,
        (
          SELECT COUNT(*)
          FROM supplier_profiles sp
          WHERE json_extract(sp.regions, '$') LIKE '%' || r.id || '%'
          AND sp.verification_status = 'verified'
        ) as suppliers,
        (
          SELECT COUNT(DISTINCT b.customer_id)
          FROM bookings b
          JOIN supplier_profiles sp ON b.supplier_id = sp.user_id
          WHERE json_extract(sp.regions, '$') LIKE '%' || r.id || '%'
        ) as customers,
        (
          SELECT COALESCE(SUM(b.total_amount), 0)
          FROM bookings b
          JOIN supplier_profiles sp ON b.supplier_id = sp.user_id
          WHERE json_extract(sp.regions, '$') LIKE '%' || r.id || '%'
          AND b.status = 'completed'
        ) as revenue
      FROM regions r
      WHERE r.is_active = TRUE
    `).all();
    
    // Format the results
    const regions = regionsResult.results?.map((r: any) => ({
      id: r.id,
      name: r.name,
      coordinates: [Number(r.lat), Number(r.lng)],
      metrics: {
        suppliers: Number(r.suppliers || 0),
        customers: Number(r.customers || 0),
        revenue: Number(r.revenue || 0)
      }
    })) || [];
    
    // Generate heatmap data based on revenue
    const heatmap = regions.map(r => ({
      lat: r.coordinates[0],
      lng: r.coordinates[1],
      weight: Math.min(1.0, r.metrics.revenue / 2000000) // Normalize weight between 0 and 1
    }));
    
    const mapData = {
      regions,
      heatmap
    };

    return jsonSuccess(c, mapData, 'Regional map data retrieved successfully');

  } catch (error) {
    console.error('Regional map error:', error);
    return jsonError(c, 'Failed to retrieve regional map data', 'An error occurred while retrieving regional map data', 500);
  }
});

/**
 * Update region settings
 */
regions.post('/update/:regionId', validateUUID('regionId'), zValidator('json', regionUpdateSchema), async (c) => {
  const regionId = c.req.param('regionId');
  const settings = c.req.valid('json');
  const adminId = c.get('userId');
  
  try {
    // Check if region exists
    const regionExists = await c.env.DB.prepare(`
      SELECT id FROM regions WHERE id = ?
    `).bind(regionId).first();
    
    if (!regionExists) {
      return jsonError(c, 'Region not found', 'The specified region does not exist', 404);
    }
    
    // Update region settings
    // For each setting, we'll store it in the system_config table
    const updatePromises = [];
    
    if (settings.manager) {
      updatePromises.push(
        c.env.DB.prepare(`
          INSERT OR REPLACE INTO system_config (key, value, description, updated_at)
          VALUES (?, ?, 'Region manager email', CURRENT_TIMESTAMP)
        `).bind(`region_${regionId}_manager`, settings.manager, `Manager for region ${regionId}`).run()
      );
    }
    
    if (settings.isActive !== undefined) {
      updatePromises.push(
        c.env.DB.prepare(`
          UPDATE regions
          SET is_active = ?
          WHERE id = ?
        `).bind(settings.isActive ? 1 : 0, regionId).run()
      );
    }
    
    if (settings.priorityLevel) {
      updatePromises.push(
        c.env.DB.prepare(`
          INSERT OR REPLACE INTO system_config (key, value, description, updated_at)
          VALUES (?, ?, 'Region priority level', CURRENT_TIMESTAMP)
        `).bind(`region_${regionId}_priority`, settings.priorityLevel).run()
      );
    }
    
    // If there are additional settings in the settings object, store them as JSON
    if (settings.settings) {
      updatePromises.push(
        c.env.DB.prepare(`
          INSERT OR REPLACE INTO system_config (key, value, description, updated_at)
          VALUES (?, ?, 'Region custom settings', CURRENT_TIMESTAMP)
        `).bind(`region_${regionId}_settings`, JSON.stringify(settings.settings)).run()
      );
    }
    
    // Wait for all updates to complete
    await Promise.all(updatePromises);
    
    const updateResult = {
      regionId,
      settings,
      updatedBy: adminId,
      updatedAt: new Date().toISOString(),
      success: true
    };

    return jsonSuccess(c, updateResult, 'Region settings updated successfully');

  } catch (error) {
    console.error('Region update error:', error);
    return jsonError(c, 'Failed to update region settings', 'An error occurred while updating region settings', 500);
  }
});

export { regions as regionsRoutes };
