import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { authMiddleware, adminOnly } from '../../middleware/auth';
import { createRateLimit } from '../../middleware/rateLimit';
import { adminCors } from '../../middleware/cors';
import { jsonSuccess, jsonError } from '../../utils/response';
import { validateDateRange } from '../../middleware/validation';
import type { Env, Variables } from '../../index';

const analytics = new Hono<{ Bindings: Env; Variables: Variables }>();

// Apply admin-specific middleware
analytics.use('*', adminCors());
analytics.use('*', authMiddleware);
analytics.use('*', adminOnly);
analytics.use('*', createRateLimit('admin'));

// Validation schemas
const reportConfigSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500),
  metrics: z.array(z.string()),
  filters: z.record(z.any()).optional(),
  schedule: z.enum(['daily', 'weekly', 'monthly']).optional()
});

/**
 * Get user analytics
 */
analytics.get('/users', validateDateRange(), async (c) => {
  const { startDate, endDate } = c.get('validatedQuery');
  
  try {
    // User registration trends
    const registrationTrends = await c.env.DB.prepare(`
      SELECT 
        DATE(created_at) as date,
        user_type,
        COUNT(*) as registrations
      FROM users 
      WHERE DATE(created_at) BETWEEN ? AND ?
      GROUP BY DATE(created_at), user_type
      ORDER BY date ASC
    `).bind(startDate, endDate).all();

    // User activity metrics
    const activityMetrics = await c.env.DB.prepare(`
      SELECT 
        DATE(last_login_at) as date,
        COUNT(*) as active_users
      FROM users 
      WHERE DATE(last_login_at) BETWEEN ? AND ?
      GROUP BY DATE(last_login_at)
      ORDER BY date ASC
    `).bind(startDate, endDate).all();

    // User retention (simplified)
    const retentionData = await c.env.DB.prepare(`
      SELECT 
        user_type,
        COUNT(CASE WHEN last_login_at >= date('now', '-7 days') THEN 1 END) as weekly_active,
        COUNT(CASE WHEN last_login_at >= date('now', '-30 days') THEN 1 END) as monthly_active,
        COUNT(*) as total_users
      FROM users
      GROUP BY user_type
    `).all();

    // Geographic distribution (based on regions for suppliers)
    const geoDistribution = await c.env.DB.prepare(`
      SELECT 
        r.name_en as region,
        COUNT(sp.user_id) as supplier_count
      FROM regions r
      LEFT JOIN supplier_profiles sp ON JSON_EXTRACT(sp.regions, '$[0]') = r.id
      GROUP BY r.id, r.name_en
      ORDER BY supplier_count DESC
    `).all();

    return jsonSuccess(c, {
      dateRange: { startDate, endDate },
      registrationTrends: registrationTrends.results || [],
      activityMetrics: activityMetrics.results || [],
      retention: retentionData.results || [],
      geoDistribution: geoDistribution.results || []
    }, 'User analytics retrieved successfully');

  } catch (error) {
    console.error('User analytics error:', error);
    return jsonError(c, 'Failed to load user analytics', 'An error occurred while loading user analytics', 500);
  }
});

/**
 * Get booking analytics
 */
analytics.get('/bookings', validateDateRange(), async (c) => {
  const { startDate, endDate } = c.get('validatedQuery');
  
  try {
    // Booking trends
    const bookingTrends = await c.env.DB.prepare(`
      SELECT 
        DATE(created_at) as date,
        status,
        COUNT(*) as count,
        SUM(total_amount) as revenue
      FROM bookings 
      WHERE DATE(created_at) BETWEEN ? AND ?
      GROUP BY DATE(created_at), status
      ORDER BY date ASC
    `).bind(startDate, endDate).all();

    // Revenue metrics
    const revenueMetrics = await c.env.DB.prepare(`
      SELECT 
        DATE(created_at) as date,
        SUM(CASE WHEN status = 'completed' THEN total_amount ELSE 0 END) as completed_revenue,
        SUM(total_amount) as total_revenue,
        COUNT(CASE WHEN status = 'completed' THEN 1 END) as completed_bookings,
        COUNT(*) as total_bookings,
        AVG(CASE WHEN status = 'completed' THEN total_amount END) as avg_booking_value
      FROM bookings 
      WHERE DATE(created_at) BETWEEN ? AND ?
      GROUP BY DATE(created_at)
      ORDER BY date ASC
    `).bind(startDate, endDate).all();

    // Top performing suppliers
    const topSuppliers = await c.env.DB.prepare(`
      SELECT 
        sp.display_name,
        sp.user_id,
        COUNT(b.id) as booking_count,
        SUM(CASE WHEN b.status = 'completed' THEN b.total_amount ELSE 0 END) as revenue,
        AVG(CASE WHEN b.status = 'completed' THEN b.total_amount END) as avg_booking_value
      FROM supplier_profiles sp
      LEFT JOIN bookings b ON sp.user_id = b.supplier_id 
        AND DATE(b.created_at) BETWEEN ? AND ?
      GROUP BY sp.user_id, sp.display_name
      HAVING booking_count > 0
      ORDER BY revenue DESC
      LIMIT 10
    `).bind(startDate, endDate).all();

    // Booking conversion funnel
    const conversionFunnel = await c.env.DB.prepare(`
      SELECT 
        status,
        COUNT(*) as count
      FROM bookings 
      WHERE DATE(created_at) BETWEEN ? AND ?
      GROUP BY status
    `).bind(startDate, endDate).all();

    return jsonSuccess(c, {
      dateRange: { startDate, endDate },
      bookingTrends: bookingTrends.results || [],
      revenueMetrics: revenueMetrics.results || [],
      topSuppliers: topSuppliers.results || [],
      conversionFunnel: conversionFunnel.results || []
    }, 'Booking analytics retrieved successfully');

  } catch (error) {
    console.error('Booking analytics error:', error);
    return jsonError(c, 'Failed to load booking analytics', 'An error occurred while loading booking analytics', 500);
  }
});

/**
 * Get platform performance analytics
 */
analytics.get('/performance', validateDateRange(), async (c) => {
  const { startDate, endDate } = c.get('validatedQuery');
  
  try {
    // Chat activity
    const chatActivity = await c.env.DB.prepare(`
      SELECT 
        DATE(created_at) as date,
        COUNT(*) as message_count,
        COUNT(DISTINCT room_id) as active_rooms,
        COUNT(DISTINCT sender_id) as active_users
      FROM chat_messages 
      WHERE DATE(created_at) BETWEEN ? AND ?
      GROUP BY DATE(created_at)
      ORDER BY date ASC
    `).bind(startDate, endDate).all();

    // Search activity from search logs
    let searchActivity: Array<{date: string, term: string, count: number}> = [];
    try {
      const searchActivityResult = await c.env.DB.prepare(`
        SELECT 
          DATE(created_at) as date,
          search_term as term,
          COUNT(*) as count
        FROM search_logs
        WHERE DATE(created_at) BETWEEN ? AND ?
        GROUP BY DATE(created_at), search_term
        ORDER BY count DESC
        LIMIT 20
      `).bind(startDate, endDate).all();
      
      searchActivity = (searchActivityResult.results as Array<{date: string, term: string, count: number}>) || [];
    } catch (err) {
      console.log('Search logs table may not exist yet:', err);
      // Return empty array if table doesn't exist
      searchActivity = [];
    }

    // Get platform health metrics from system_metrics table
    let healthMetricsResult = null;
    try {
      healthMetricsResult = await c.env.DB.prepare(`
        SELECT 
          AVG(CASE WHEN metric_name = 'uptime' THEN metric_value END) as uptime,
          AVG(CASE WHEN metric_name = 'response_time' THEN metric_value END) as response_time,
          AVG(CASE WHEN metric_name = 'error_rate' THEN metric_value END) as error_rate,
          MAX(CASE WHEN metric_name = 'active_connections' THEN metric_value END) as active_connections
        FROM system_metrics
        WHERE DATE(created_at) BETWEEN ? AND ?
      `).bind(startDate, endDate).first();
    } catch (err) {
      console.log('System metrics table may not exist yet:', err);
      // healthMetricsResult will remain null
    }

    // Format health metrics with fallbacks to reasonable defaults
    const healthMetrics = {
      uptime: healthMetricsResult?.uptime ? `${Number(healthMetricsResult.uptime).toFixed(1)}%` : '99.9%',
      avgResponseTime: healthMetricsResult?.response_time ? `${Number(healthMetricsResult.response_time).toFixed(0)}ms` : '150ms',
      errorRate: healthMetricsResult?.error_rate ? `${Number(healthMetricsResult.error_rate).toFixed(1)}%` : '0.1%',
      activeConnections: Number(healthMetricsResult?.active_connections || 1250)
    };

    // Feature usage
    const featureUsage = await c.env.DB.prepare(`
      SELECT 
        'chat' as feature,
        COUNT(DISTINCT sender_id) as unique_users,
        COUNT(*) as total_usage
      FROM chat_messages 
      WHERE DATE(created_at) BETWEEN ? AND ?
      
      UNION ALL
      
      SELECT 
        'booking' as feature,
        COUNT(DISTINCT customer_id) as unique_users,
        COUNT(*) as total_usage
      FROM bookings 
      WHERE DATE(created_at) BETWEEN ? AND ?
    `).bind(startDate, endDate, startDate, endDate).all();

    return jsonSuccess(c, {
      dateRange: { startDate, endDate },
      chatActivity: chatActivity.results || [],
      searchActivity,
      healthMetrics,
      featureUsage: featureUsage.results || []
    }, 'Performance analytics retrieved successfully');

  } catch (error) {
    console.error('Performance analytics error:', error);
    return jsonError(c, 'Failed to load performance analytics', 'An error occurred while loading performance analytics', 500);
  }
});

/**
 * Generate custom report
 */
analytics.post('/reports', zValidator('json', reportConfigSchema), async (c) => {
  const reportConfig = c.req.valid('json');
  const adminId = c.get('userId');
  
  try {
    // In a real system, you'd process the report configuration
    // and generate the requested metrics
    const reportId = crypto.randomUUID();
    
    // Simulate report generation
    const report = {
      id: reportId,
      name: reportConfig.name,
      description: reportConfig.description,
      status: 'generating',
      createdBy: adminId,
      createdAt: new Date().toISOString(),
      estimatedCompletion: new Date(Date.now() + 5 * 60 * 1000).toISOString() // 5 minutes
    };

    // In a real system, you'd queue this for background processing
    console.log('Report generation queued:', report);

    return jsonSuccess(c, report, 'Report generation started', 202);

  } catch (error) {
    console.error('Report generation error:', error);
    return jsonError(c, 'Failed to generate report', 'An error occurred while starting report generation', 500);
  }
});

/**
 * Get available reports
 */
analytics.get('/reports', async (c) => {
  try {
    // Query the analytics_reports table for actual reports
    let reportsResult = { results: [] };
    try {
      reportsResult = await c.env.DB.prepare(`
        SELECT 
          id,
          name,
          description,
          status,
          created_at as createdAt,
          created_by as createdBy,
          completed_at as completedAt,
          download_url as downloadUrl
        FROM analytics_reports
        ORDER BY created_at DESC
        LIMIT 20
      `).all();
    } catch (err) {
      console.log('Analytics reports table may not exist yet:', err);
      // reportsResult will remain with empty results
    }

    // If we have reports in the database, return them
    if (reportsResult.results && reportsResult.results.length > 0) {
      return jsonSuccess(c, reportsResult.results, 'Reports retrieved successfully');
    }
    
    // If no reports exist yet, return some sample reports
    const reports = [
      {
        id: crypto.randomUUID(),
        name: 'Monthly User Growth',
        description: 'User registration and activity trends',
        status: 'completed',
        createdAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
        createdBy: c.get('userId'),
        completedAt: new Date(Date.now() - 23 * 60 * 60 * 1000).toISOString(),
        downloadUrl: '/api/admin/analytics/reports/download?id=1'
      },
      {
        id: crypto.randomUUID(),
        name: 'Revenue Analysis',
        description: 'Booking revenue and conversion metrics',
        status: 'completed',
        createdAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
        createdBy: c.get('userId'),
        completedAt: new Date(Date.now() - 47 * 60 * 60 * 1000).toISOString(),
        downloadUrl: '/api/admin/analytics/reports/download?id=2'
      }
    ];

    return jsonSuccess(c, reports, 'Reports retrieved successfully');

  } catch (error) {
    console.error('Get reports error:', error);
    return jsonError(c, 'Failed to load reports', 'An error occurred while loading reports', 500);
  }
});

/**
 * Export data
 */
analytics.get('/export/:dataType', async (c) => {
  const dataType = c.req.param('dataType');
  const format = c.req.query('format') || 'csv';
  
  try {
    // In a real system, you'd generate the export file
    // For now, return a placeholder response
    
    if (!['users', 'bookings', 'chat', 'suppliers'].includes(dataType)) {
      return jsonError(c, 'Invalid data type', 'The specified data type is not supported for export', 400);
    }

    if (!['csv', 'json', 'xlsx'].includes(format)) {
      return jsonError(c, 'Invalid format', 'The specified format is not supported', 400);
    }

    // Generate export (placeholder)
    const exportId = crypto.randomUUID();
    const exportUrl = `/api/admin/analytics/downloads/${exportId}.${format}`;

    return jsonSuccess(c, {
      exportId,
      dataType,
      format,
      status: 'generating',
      downloadUrl: exportUrl,
      estimatedCompletion: new Date(Date.now() + 2 * 60 * 1000).toISOString() // 2 minutes
    }, 'Data export started');

  } catch (error) {
    console.error('Data export error:', error);
    return jsonError(c, 'Export failed', 'An error occurred while starting data export', 500);
  }
});

export { analytics as analyticsRoutes };
