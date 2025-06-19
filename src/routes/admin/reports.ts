import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { authMiddleware, adminOnly } from '../../middleware/auth';
import { createRateLimit } from '../../middleware/rateLimit';
import { adminCors } from '../../middleware/cors';
import { jsonSuccess, jsonError, jsonPaginated, createPagination } from '../../utils/response';
import { validatePagination, validateUUID, validateDateRange } from '../../middleware/validation';
import type { Env, Variables } from '../../index';

const reports = new Hono<{ Bindings: Env; Variables: Variables }>();

// Apply admin-specific middleware
reports.use('*', adminCors());
reports.use('*', authMiddleware);
reports.use('*', adminOnly);
reports.use('*', createRateLimit('admin'));

// Validation schemas
const reportGenerateSchema = z.object({
  templateId: z.string().min(1),
  parameters: z.record(z.any()),
});

const reportScheduleSchema = z.object({
  templateId: z.string().min(1),
  name: z.string().min(1).max(200),
  frequency: z.enum(['daily', 'weekly', 'monthly']),
  parameters: z.record(z.any()),
  recipients: z.array(z.string().email()).optional(),
});

/**
 * Get reports statistics
 */
reports.get('/stats', async (c) => {
  try {
    // Get monthly revenue
    const revenueResult = await c.env.DB.prepare(`
      SELECT SUM(total_amount) as monthly_revenue
      FROM bookings
      WHERE created_at >= date('now', '-30 days')
      AND status = 'completed'
    `).first();
    
    // Get total users
    const usersResult = await c.env.DB.prepare(`
      SELECT COUNT(*) as total_users
      FROM users
    `).first();
    
    // Get total bookings
    const bookingsResult = await c.env.DB.prepare(`
      SELECT COUNT(*) as total_bookings
      FROM bookings
    `).first();
    
    // Calculate growth rate (comparing current month to previous month)
    const growthResult = await c.env.DB.prepare(`
      SELECT 
        (current_month.revenue - previous_month.revenue) * 100.0 / 
        CASE WHEN previous_month.revenue = 0 THEN 1 ELSE previous_month.revenue END as growth_rate
      FROM (
        SELECT COALESCE(SUM(total_amount), 0) as revenue
        FROM bookings
        WHERE created_at >= date('now', '-30 days')
        AND status = 'completed'
      ) as current_month,
      (
        SELECT COALESCE(SUM(total_amount), 0) as revenue
        FROM bookings
        WHERE created_at >= date('now', '-60 days')
        AND created_at < date('now', '-30 days')
        AND status = 'completed'
      ) as previous_month
    `).first();
    
    // Get recent reports count
    const recentReportsResult = await c.env.DB.prepare(`
      SELECT COUNT(*) as count
      FROM reports
      WHERE created_at >= date('now', '-30 days')
    `).first();
    
    // Get scheduled reports count
    const scheduledReportsResult = await c.env.DB.prepare(`
      SELECT COUNT(*) as count
      FROM scheduled_reports
    `).first();
    
    // Get available templates count
    const templatesResult = await c.env.DB.prepare(`
      SELECT COUNT(*) as count
      FROM report_templates
    `).first();
    
    const statsData = {
      monthlyRevenue: Number(revenueResult?.monthly_revenue || 0),
      totalUsers: Number(usersResult?.total_users || 0),
      totalBookings: Number(bookingsResult?.total_bookings || 0),
      growthRate: Number(growthResult?.growth_rate || 0),
      recentReports: Number(recentReportsResult?.count || 0),
      scheduledReports: Number(scheduledReportsResult?.count || 0),
      availableTemplates: Number(templatesResult?.count || 0)
    };

    return jsonSuccess(c, statsData, 'Report statistics retrieved successfully');

  } catch (error) {
    console.error('Report stats error:', error);
    return jsonError(c, 'Failed to load report stats', 'An error occurred while loading report statistics', 500);
  }
});

/**
 * Get all reports with filtering and pagination
 */
reports.get('/', validatePagination(), async (c) => {
  const { page, limit } = c.get('validatedQuery');
  const search = c.req.query('search');
  const category = c.req.query('category');
  const format = c.req.query('format');
  
  try {
    // Build WHERE clause
    const conditions = [];
    const params = [];
    
    if (search) {
      conditions.push('(name LIKE ? OR description LIKE ?)');
      const searchTerm = `%${search}%`;
      params.push(searchTerm, searchTerm);
    }
    
    if (category && category !== 'all') {
      conditions.push('category = ?');
      params.push(category);
    }
    
    if (format && format !== 'all') {
      conditions.push('format = ?');
      params.push(format);
    }
    
    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    
    // Get total count
    const countQuery = `
      SELECT COUNT(*) as total 
      FROM reports
      ${whereClause}
    `;
    
    const countResult = await c.env.DB.prepare(countQuery).bind(...params).first();
    const total = Number(countResult?.total || 0);
    
    // Get reports
    const offset = (page - 1) * limit;
    const reportsQuery = `
      SELECT 
        id,
        name,
        description,
        category,
        format,
        size,
        template_id as templateId,
        download_count as downloadCount,
        created_at as lastGenerated,
        generated_by as generatedBy
      FROM reports
      ${whereClause}
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `;
    
    const reportsResult = await c.env.DB.prepare(reportsQuery)
      .bind(...params, limit, offset)
      .all();
    
    const pagination = createPagination(page, limit, total);
    
    return jsonPaginated(c, reportsResult.results || [], pagination, 'Reports retrieved successfully');
    
  } catch (error) {
    console.error('Reports list error:', error);
    return jsonError(c, 'Failed to retrieve reports', 'An error occurred while retrieving reports', 500);
  }
});

/**
 * Get report templates
 */
reports.get('/templates', async (c) => {
  try {
    const templatesQuery = `
      SELECT 
        id,
        name,
        description,
        category,
        icon,
        parameters,
        created_at as createdAt,
        updated_at as updatedAt
      FROM report_templates
      ORDER BY name ASC
    `;
    
    const templatesResult = await c.env.DB.prepare(templatesQuery).all();
    
    // Parse parameters JSON for each template
    const templates = templatesResult.results?.map((template: any) => {
      try {
        if (template.parameters) {
          template.parameters = JSON.parse(template.parameters);
        }
      } catch (e) {
        console.error('Error parsing template parameters:', e);
        template.parameters = [];
      }
      return template;
    }) || [];
    
    return jsonSuccess(c, templates, 'Report templates retrieved successfully');
    
  } catch (error) {
    console.error('Report templates error:', error);
    return jsonError(c, 'Failed to retrieve report templates', 'An error occurred while retrieving report templates', 500);
  }
});

/**
 * Get specific report details
 */
reports.get('/details/:reportId', validateUUID('reportId'), async (c) => {
  const reportId = c.req.param('reportId');
  
  try {
    // Get report details
    const reportResult = await c.env.DB.prepare(`
      SELECT 
        r.id,
        r.name,
        r.description,
        r.category,
        r.format,
        r.size,
        r.url,
        r.template_id as templateId,
        r.parameters,
        r.generated_by as generatedBy,
        r.download_count as downloadCount,
        r.last_downloaded_at as lastDownloadedAt,
        r.created_at as createdAt,
        r.updated_at as updatedAt,
        rt.name as templateName,
        rt.description as templateDescription
      FROM reports r
      JOIN report_templates rt ON r.template_id = rt.id
      WHERE r.id = ?
    `).bind(reportId).first();
    
    if (!reportResult) {
      return jsonError(c, 'Report not found', 'The specified report does not exist', 404);
    }
    
    // Parse parameters JSON
    try {
      if (reportResult.parameters) {
        reportResult.parameters = JSON.parse(String(reportResult.parameters));
      } else {
        reportResult.parameters = {};
      }
    } catch (e) {
      console.error('Error parsing report parameters:', e);
      reportResult.parameters = {};
    }
    
    return jsonSuccess(c, reportResult, 'Report details retrieved successfully');
    
  } catch (error) {
    console.error('Report details error:', error);
    return jsonError(c, 'Failed to retrieve report details', 'An error occurred while retrieving report details', 500);
  }
});

/**
 * Generate a report
 */
reports.post('/generate', zValidator('json', reportGenerateSchema), async (c) => {
  const { templateId, parameters } = c.req.valid('json');
  const adminId = c.get('userId');
  const adminName = 'Admin';
  
  try {
    // Check if template exists
    const templateResult = await c.env.DB.prepare(`
      SELECT id, name, description, category
      FROM report_templates
      WHERE id = ?
    `).bind(templateId).first();
    
    if (!templateResult) {
      return jsonError(c, 'Template not found', 'The specified report template does not exist', 404);
    }
    
    // In a real system, you'd generate the actual report here
    // For now, we'll simulate report generation with placeholder data
    
    const reportId = crypto.randomUUID();
    const now = new Date().toISOString();
    const format = parameters.format || 'PDF';
    const reportSize = format === 'PDF' ? '1.2 MB' : format === 'Excel' ? '850 KB' : '420 KB';
    const reportUrl = `/api/admin/reports/download/${reportId}`;
    
    // Insert report record
    await c.env.DB.prepare(`
      INSERT INTO reports (
        id, name, description, category, format, size, url,
        template_id, parameters, generated_by, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      reportId,
      templateResult.name,
      templateResult.description,
      templateResult.category,
      format,
      reportSize,
      reportUrl,
      templateId,
      JSON.stringify(parameters),
      adminId,
      now,
      now
    ).run();
    
    return jsonSuccess(c, {
      reportId,
      name: templateResult.name,
      format,
      url: reportUrl
    }, 'Report generated successfully', 201);
    
  } catch (error) {
    console.error('Report generation error:', error);
    return jsonError(c, 'Failed to generate report', 'An error occurred while generating the report', 500);
  }
});

/**
 * Download a report
 */
reports.get('/download/:reportId', validateUUID('reportId'), async (c) => {
  const reportId = c.req.param('reportId');
  
  try {
    // Get report details
    const reportResult = await c.env.DB.prepare(`
      SELECT id, name, format
      FROM reports
      WHERE id = ?
    `).bind(reportId).first();
    
    if (!reportResult) {
      return jsonError(c, 'Report not found', 'The specified report does not exist', 404);
    }
    
    // Update download count and last downloaded timestamp
    await c.env.DB.prepare(`
      UPDATE reports
      SET download_count = download_count + 1, last_downloaded_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(reportId).run();
    
    // In a real system, you'd retrieve the actual report file and stream it
    // For now, we'll return a success message
    
    return jsonSuccess(c, {
      reportId,
      name: reportResult.name,
      format: reportResult.format,
      downloadUrl: `/api/admin/reports/download/${reportId}`
    }, 'Report download initiated');
    
  } catch (error) {
    console.error('Report download error:', error);
    return jsonError(c, 'Failed to download report', 'An error occurred while downloading the report', 500);
  }
});

/**
 * Schedule a report
 */
reports.post('/schedule', zValidator('json', reportScheduleSchema), async (c) => {
  const { templateId, name, frequency, parameters, recipients } = c.req.valid('json');
  const adminId = c.get('userId');
  
  try {
    // Check if template exists
    const templateExists = await c.env.DB.prepare(`
      SELECT id FROM report_templates WHERE id = ?
    `).bind(templateId).first();
    
    if (!templateExists) {
      return jsonError(c, 'Template not found', 'The specified report template does not exist', 404);
    }
    
    // Calculate next run date based on frequency
    let nextRun = new Date();
    switch (frequency) {
      case 'daily':
        nextRun.setDate(nextRun.getDate() + 1);
        nextRun.setHours(8, 0, 0, 0); // 8:00 AM tomorrow
        break;
      case 'weekly':
        nextRun.setDate(nextRun.getDate() + (7 - nextRun.getDay())); // Next Sunday
        nextRun.setHours(8, 0, 0, 0); // 8:00 AM
        break;
      case 'monthly':
        nextRun.setMonth(nextRun.getMonth() + 1);
        nextRun.setDate(1); // 1st of next month
        nextRun.setHours(8, 0, 0, 0); // 8:00 AM
        break;
    }
    
    const scheduleId = crypto.randomUUID();
    const now = new Date().toISOString();
    
    // Insert scheduled report
    await c.env.DB.prepare(`
      INSERT INTO scheduled_reports (
        id, template_id, name, frequency, parameters, recipients,
        next_run, created_by, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      scheduleId,
      templateId,
      name,
      frequency,
      JSON.stringify(parameters),
      recipients ? JSON.stringify(recipients) : null,
      nextRun.toISOString(),
      adminId,
      now,
      now
    ).run();
    
    return jsonSuccess(c, {
      scheduleId,
      name,
      frequency,
      nextRun: nextRun.toISOString()
    }, 'Report scheduled successfully', 201);
    
  } catch (error) {
    console.error('Report scheduling error:', error);
    return jsonError(c, 'Failed to schedule report', 'An error occurred while scheduling the report', 500);
  }
});

/**
 * Get scheduled reports
 */
reports.get('/schedule', async (c) => {
  try {
    const scheduledReportsQuery = `
      SELECT 
        id,
        template_id as templateId,
        name,
        frequency,
        parameters,
        recipients,
        next_run as nextRun,
        last_run as lastRun,
        created_by as createdBy,
        created_at as createdAt
      FROM scheduled_reports
      ORDER BY next_run ASC
    `;
    
    const scheduledReportsResult = await c.env.DB.prepare(scheduledReportsQuery).all();
    
    // Parse JSON fields
    const scheduledReports = scheduledReportsResult.results?.map((report: any) => {
      try {
        if (report.parameters) {
          report.parameters = JSON.parse(report.parameters);
        }
        if (report.recipients) {
          report.recipients = JSON.parse(report.recipients);
        }
      } catch (e) {
        console.error('Error parsing scheduled report data:', e);
      }
      return report;
    }) || [];
    
    return jsonSuccess(c, scheduledReports, 'Scheduled reports retrieved successfully');
    
  } catch (error) {
    console.error('Scheduled reports error:', error);
    return jsonError(c, 'Failed to retrieve scheduled reports', 'An error occurred while retrieving scheduled reports', 500);
  }
});

/**
 * Get live analytics data
 */
reports.get('/analytics', async (c) => {
  try {
    // Get active users count (users with activity in the last hour)
    const activeUsersResult = await c.env.DB.prepare(`
      SELECT COUNT(DISTINCT user_id) as active_users
      FROM user_sessions
      WHERE last_active_at >= datetime('now', '-1 hour')
    `).first();
    
    // Get today's bookings
    const todayBookingsResult = await c.env.DB.prepare(`
      SELECT COUNT(*) as today_bookings
      FROM bookings
      WHERE DATE(created_at) = CURRENT_DATE
    `).first();
    
    // Get today's revenue
    const todayRevenueResult = await c.env.DB.prepare(`
      SELECT SUM(total_amount) as today_revenue
      FROM bookings
      WHERE DATE(created_at) = CURRENT_DATE
      AND status = 'completed'
    `).first();
    
    // Get conversion rate (completed bookings / total bookings) for today
    const conversionRateResult = await c.env.DB.prepare(`
      SELECT 
        CASE 
          WHEN total_bookings > 0 
          THEN (completed_bookings * 100.0 / total_bookings) 
          ELSE 0 
        END as conversion_rate
      FROM (
        SELECT 
          COUNT(*) as total_bookings,
          COUNT(CASE WHEN status = 'completed' THEN 1 END) as completed_bookings
        FROM bookings
        WHERE DATE(created_at) = CURRENT_DATE
      )
    `).first();
    
    // Get trending services (most booked today)
    const trendingServicesResult = await c.env.DB.prepare(`
      SELECT 
        s.name,
        COUNT(b.id) as count
      FROM bookings b
      JOIN supplier_services s ON b.service_id = s.id
      WHERE DATE(b.created_at) = CURRENT_DATE
      GROUP BY s.id
      ORDER BY count DESC
      LIMIT 5
    `).all();
    
    // Get users by region
    const usersByRegionResult = await c.env.DB.prepare(`
      SELECT 
        r.name_en as region,
        COUNT(DISTINCT sp.user_id) as supplier_count,
        COUNT(DISTINCT cp.user_id) as customer_count
      FROM regions r
      LEFT JOIN supplier_profiles sp ON JSON_EXTRACT(sp.regions, '$[0]') = r.id
      LEFT JOIN customer_profiles cp ON cp.preferred_region = r.id
      GROUP BY r.id, r.name_en
      ORDER BY supplier_count + customer_count DESC
      LIMIT 10
    `).all();
    
    // Get revenue by hour for today
    const revenueByHourResult = await c.env.DB.prepare(`
      SELECT 
        strftime('%H', created_at) as hour,
        SUM(total_amount) as revenue
      FROM bookings
      WHERE DATE(created_at) = CURRENT_DATE
      GROUP BY strftime('%H', created_at)
      ORDER BY hour ASC
    `).all();
    
    // Format the analytics data
    const analyticsData = {
      activeUsers: Number(activeUsersResult?.active_users || 0),
      todayBookings: Number(todayBookingsResult?.today_bookings || 0),
      todayRevenue: Number(todayRevenueResult?.today_revenue || 0),
      conversionRate: Number(conversionRateResult?.conversion_rate || 0).toFixed(1),
      trendingServices: trendingServicesResult.results || [],
      usersByRegion: usersByRegionResult.results?.reduce((acc: Record<string, number>, row: any) => {
        acc[row.region] = Number(row.supplier_count || 0) + Number(row.customer_count || 0);
        return acc;
      }, {}) || {},
      revenueByHour: revenueByHourResult.results?.map((row: any) => ({
        hour: Number(row.hour),
        revenue: Number(row.revenue || 0)
      })) || []
    };
    
    return jsonSuccess(c, analyticsData, 'Live analytics data retrieved successfully');
    
  } catch (error) {
    console.error('Live analytics error:', error);
    return jsonError(c, 'Failed to retrieve live analytics', 'An error occurred while retrieving live analytics data', 500);
  }
});

export { reports as reportsRoutes };
