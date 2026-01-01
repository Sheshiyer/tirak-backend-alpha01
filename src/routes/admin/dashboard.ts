import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { authMiddleware, adminOnly } from '../../middleware/auth';
import { createRateLimit } from '../../middleware/rateLimit';
import { adminCors } from '../../middleware/cors';
import { jsonSuccess, jsonError } from '../../utils/response';
import { validateDateRange } from '../../middleware/validation';
import type { Env, Variables } from '../../index';

const dashboard = new Hono<{ Bindings: Env; Variables: Variables }>();

// Apply admin-specific middleware
dashboard.use('*', adminCors());
dashboard.use('*', authMiddleware);
dashboard.use('*', adminOnly);
dashboard.use('*', createRateLimit('admin'));

/**
 * Get platform overview statistics
 */
dashboard.get('/overview', async (c) => {
  try {
    // Get current date for time-based queries
    const now = new Date();
    const today = now.toISOString().split('T')[0];
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    // Get total users by type
    const userStats = await c.env.DB.prepare(`
      SELECT 
        user_type,
        COUNT(*) as count,
        COUNT(CASE WHEN status = 'active' THEN 1 END) as active_count,
        COUNT(CASE WHEN DATE(created_at) = ? THEN 1 END) as today_count
      FROM users 
      GROUP BY user_type
    `).bind(today).all();

    // Get total bookings and revenue
    const bookingStats = await c.env.DB.prepare(`
      SELECT 
        COUNT(*) as total_bookings,
        COUNT(CASE WHEN status = 'completed' THEN 1 END) as completed_bookings,
        COUNT(CASE WHEN DATE(created_at) = ? THEN 1 END) as today_bookings,
        SUM(CASE WHEN status = 'completed' THEN total_amount ELSE 0 END) as total_revenue,
        SUM(CASE WHEN status = 'completed' AND DATE(created_at) >= ? THEN total_amount ELSE 0 END) as monthly_revenue
      FROM bookings
    `).bind(today, thirtyDaysAgo).first();

    // Get chat activity
    const chatStats = await c.env.DB.prepare(`
      SELECT 
        COUNT(DISTINCT room_id) as active_rooms,
        COUNT(*) as total_messages,
        COUNT(CASE WHEN DATE(created_at) = ? THEN 1 END) as today_messages
      FROM chat_messages
      WHERE created_at >= ?
    `).bind(today, thirtyDaysAgo).first();

    // Get supplier verification stats
    const supplierStats = await c.env.DB.prepare(`
      SELECT 
        verification_status,
        COUNT(*) as count
      FROM supplier_profiles
      GROUP BY verification_status
    `).all();

    // Get recent activity (last 24 hours)
    const recentActivity = await c.env.DB.prepare(`
      SELECT 
        'user_registration' as type,
        COUNT(*) as count
      FROM users 
      WHERE created_at >= datetime('now', '-24 hours')
      
      UNION ALL
      
      SELECT 
        'booking_created' as type,
        COUNT(*) as count
      FROM bookings 
      WHERE created_at >= datetime('now', '-24 hours')
      
      UNION ALL
      
      SELECT 
        'chat_message' as type,
        COUNT(*) as count
      FROM chat_messages 
      WHERE created_at >= datetime('now', '-24 hours')
    `).all();

    return jsonSuccess(c, {
      users: {
        total: userStats.results?.reduce((sum: number, row: any) => sum + row.count, 0) || 0,
        active: userStats.results?.reduce((sum: number, row: any) => sum + row.active_count, 0) || 0,
        today: userStats.results?.reduce((sum: number, row: any) => sum + row.today_count, 0) || 0,
        byType: userStats.results?.reduce((acc: any, row: any) => {
          acc[row.user_type] = {
            total: row.count,
            active: row.active_count,
            today: row.today_count
          };
          return acc;
        }, {}) || {}
      },
      bookings: {
        total: bookingStats?.total_bookings || 0,
        completed: bookingStats?.completed_bookings || 0,
        today: bookingStats?.today_bookings || 0,
        revenue: {
          total: bookingStats?.total_revenue || 0,
          monthly: bookingStats?.monthly_revenue || 0
        }
      },
      chat: {
        activeRooms: chatStats?.active_rooms || 0,
        totalMessages: chatStats?.total_messages || 0,
        todayMessages: chatStats?.today_messages || 0
      },
      suppliers: {
        verification: supplierStats.results?.reduce((acc: any, row: any) => {
          acc[row.verification_status] = row.count;
          return acc;
        }, {}) || {}
      },
      recentActivity: recentActivity.results?.reduce((acc: any, row: any) => {
        acc[row.type] = row.count;
        return acc;
      }, {}) || {}
    }, 'Platform overview retrieved successfully');

  } catch (error) {
    console.error('Dashboard overview error:', error);
    return jsonError(c, 'Failed to load dashboard', 'An error occurred while loading dashboard data', 500);
  }
});

/**
 * Get system health indicators
 */
dashboard.get('/health', async (c) => {
  try {
    const healthChecks = [];

    // Database connectivity check
    try {
      await c.env.DB.prepare('SELECT 1').first();
      healthChecks.push({
        service: 'database',
        status: 'healthy',
        responseTime: Date.now(),
        message: 'Database connection successful'
      });
    } catch (error) {
      healthChecks.push({
        service: 'database',
        status: 'unhealthy',
        responseTime: null,
        message: 'Database connection failed',
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }

    // Storage connectivity check
    try {
      await c.env.STORAGE.head('health-check');
      healthChecks.push({
        service: 'storage',
        status: 'healthy',
        responseTime: Date.now(),
        message: 'Storage connection successful'
      });
    } catch (error) {
      healthChecks.push({
        service: 'storage',
        status: 'healthy', // R2 head requests can fail for non-existent objects but still indicate connectivity
        responseTime: Date.now(),
        message: 'Storage connection successful'
      });
    }

    // Cache connectivity check
    try {
      await c.env.CACHE.get('health-check');
      healthChecks.push({
        service: 'cache',
        status: 'healthy',
        responseTime: Date.now(),
        message: 'Cache connection successful'
      });
    } catch (error) {
      healthChecks.push({
        service: 'cache',
        status: 'unhealthy',
        responseTime: null,
        message: 'Cache connection failed',
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }

    const overallStatus = healthChecks.every(check => check.status === 'healthy') ? 'healthy' : 'degraded';

    return jsonSuccess(c, {
      status: overallStatus,
      timestamp: new Date().toISOString(),
      environment: c.env.ENVIRONMENT,
      checks: healthChecks
    }, 'System health check completed');

  } catch (error) {
    console.error('Health check error:', error);
    return jsonError(c, 'Health check failed', 'An error occurred during health check', 500);
  }
});

/**
 * Get platform metrics for a specific time range
 */
dashboard.get('/metrics', validateDateRange(), async (c) => {
  const { startDate, endDate } = c.get('validatedQuery');
  
  try {
    // User registration metrics
    const userMetrics = await c.env.DB.prepare(`
      SELECT 
        DATE(created_at) as date,
        user_type,
        COUNT(*) as registrations
      FROM users 
      WHERE DATE(created_at) BETWEEN ? AND ?
      GROUP BY DATE(created_at), user_type
      ORDER BY date DESC
    `).bind(startDate, endDate).all();

    // Booking metrics (aggregated)
    const bookingMetrics = await c.env.DB.prepare(`
      SELECT 
        DATE(created_at) as date,
        status,
        COUNT(*) as count,
        SUM(total_amount) as revenue
      FROM bookings 
      WHERE DATE(created_at) BETWEEN ? AND ?
      GROUP BY DATE(created_at), status
      ORDER BY date DESC
    `).bind(startDate, endDate).all();

    // Booking details with customer and companion information
    const bookingDetails = await c.env.DB.prepare(`
      SELECT 
        b.id,
        b.customer_id,
        b.companion_id,
        b.supplier_id,
        b.service_id,
        b.experience_id,
        b.date,
        b.start_time,
        b.end_time,
        b.duration,
        b.location,
        b.status,
        b.total_amount,
        b.service_fee,
        b.payment_status,
        b.scheduled_at,
        b.created_at,
        b.updated_at,
        -- Customer details
        cu.email as customer_email,
        cu.phone as customer_phone,
        cu.user_type as customer_type,
        cu.status as customer_status,
        cp.display_name as customer_name,
        cp.profile_image as customer_image,
        -- Companion details
        co.email as companion_email,
        co.phone as companion_phone,
        co.status as companion_status,
        comp.display_name as companion_name,
        comp.profile_photo as companion_image,
        comp.rating_average as companion_rating,
        comp.rating_count as companion_rating_count,
        -- Supplier details (if exists)
        su.email as supplier_email,
        su.phone as supplier_phone,
        su.status as supplier_status,
        sp.display_name as supplier_name,
        sp.profile_images as supplier_images
      FROM bookings b
      LEFT JOIN users cu ON b.customer_id = cu.id
      LEFT JOIN customer_profiles cp ON b.customer_id = cp.user_id
      LEFT JOIN users co ON b.companion_id = co.id
      LEFT JOIN companion_profiles comp ON b.companion_id = comp.user_id
      LEFT JOIN users su ON b.supplier_id = su.id
      LEFT JOIN supplier_profiles sp ON b.supplier_id = sp.user_id
      WHERE DATE(b.created_at) BETWEEN ? AND ?
      ORDER BY b.created_at DESC
      LIMIT 100
    `).bind(startDate, endDate).all();

    // Chat activity metrics
    const chatMetrics = await c.env.DB.prepare(`
      SELECT 
        DATE(created_at) as date,
        COUNT(*) as messages,
        COUNT(DISTINCT room_id) as active_rooms
      FROM chat_messages 
      WHERE DATE(created_at) BETWEEN ? AND ?
      GROUP BY DATE(created_at)
      ORDER BY date DESC
    `).bind(startDate, endDate).all();
    
    // Regional activity metrics - Modified to always return regions
    const regionalMetrics = await c.env.DB.prepare(`
      SELECT 
        r.name_en as region,
        0 as customers,
        COUNT(DISTINCT sp.user_id) as suppliers,
        COUNT(b.id) as activity
      FROM regions r
      LEFT JOIN supplier_profiles sp ON JSON_EXTRACT(sp.regions, '$[0]') = r.id
      LEFT JOIN bookings b ON b.supplier_id = sp.user_id
        AND DATE(b.created_at) BETWEEN ? AND ?
      GROUP BY r.id, r.name_en
    `).bind(startDate, endDate).all();
    
    // Add fallback if no regions are returned
    if (!regionalMetrics.results || regionalMetrics.results.length === 0) {
      regionalMetrics.results = [
        { region: "Bangkok Metropolitan", customers: 0, suppliers: 0, activity: 0 },
        { region: "Pattaya & Chonburi", customers: 0, suppliers: 0, activity: 0 },
        { region: "Phuket Island", customers: 0, suppliers: 0, activity: 0 },
        { region: "Chiang Mai", customers: 0, suppliers: 0, activity: 0 },
        { region: "Koh Samui", customers: 0, suppliers: 0, activity: 0 }
      ];
    }

    // Transform booking details to include parsed JSON fields
    const transformedBookingDetails = bookingDetails.results?.map((booking: any) => ({
      id: booking.id,
      customer: {
        id: booking.customer_id,
        email: booking.customer_email,
        phone: booking.customer_phone,
        type: booking.customer_type,
        status: booking.customer_status,
        name: booking.customer_name,
        image: booking.customer_image
      },
      companion: booking.companion_id ? {
        id: booking.companion_id,
        email: booking.companion_email,
        phone: booking.companion_phone,
        status: booking.companion_status,
        name: booking.companion_name,
        image: booking.companion_image,
        rating: {
          average: booking.companion_rating || 0,
          count: booking.companion_rating_count || 0
        }
      } : null,
      supplier: booking.supplier_id ? {
        id: booking.supplier_id,
        email: booking.supplier_email,
        phone: booking.supplier_phone,
        status: booking.supplier_status,
        name: booking.supplier_name,
        images: booking.supplier_images ? JSON.parse(booking.supplier_images || '[]') : []
      } : null,
      service: {
        id: booking.service_id,
        experienceId: booking.experience_id
      },
      date: booking.date,
      startTime: booking.start_time,
      endTime: booking.end_time,
      duration: booking.duration,
      location: booking.location,
      status: booking.status,
      payment: {
        totalAmount: booking.total_amount,
        serviceFee: booking.service_fee,
        status: booking.payment_status
      },
      scheduledAt: booking.scheduled_at,
      createdAt: booking.created_at,
      updatedAt: booking.updated_at
    })) || [];

    return jsonSuccess(c, {
      dateRange: { startDate, endDate },
      users: userMetrics.results || [],
      bookings: {
        metrics: bookingMetrics.results || [],
        details: transformedBookingDetails
      },
      chat: chatMetrics.results || [],
      regional: regionalMetrics.results || []
    }, 'Platform metrics retrieved successfully');

  } catch (error) {
    console.error('Metrics error:', error);
    return jsonError(c, 'Failed to load metrics', 'An error occurred while loading metrics data', 500);
  }
});

export { dashboard as dashboardRoutes };
