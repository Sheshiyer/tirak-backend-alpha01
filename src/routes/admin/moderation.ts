import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { authMiddleware, adminOnly } from '../../middleware/auth';
import { createRateLimit } from '../../middleware/rateLimit';
import { adminCors } from '../../middleware/cors';
import { jsonSuccess, jsonError, jsonPaginated, createPagination } from '../../utils/response';
import { validatePagination, validateUUID } from '../../middleware/validation';
import type { Env, Variables } from '../../index';

const moderation = new Hono<{ Bindings: Env; Variables: Variables }>();

// Apply admin-specific middleware
moderation.use('*', adminCors());
moderation.use('*', authMiddleware);
moderation.use('*', adminOnly);
moderation.use('*', createRateLimit('admin'));

// Validation schemas
const moderationActionSchema = z.object({
  action: z.enum(['approve', 'reject', 'flag', 'remove']),
  reason: z.string().min(1).max(500),
  severity: z.enum(['low', 'medium', 'high']).optional()
});

const moderationRuleSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500),
  contentType: z.enum(['profile', 'message', 'review', 'service']),
  keywords: z.array(z.string()).optional(),
  action: z.enum(['flag', 'auto_reject', 'require_review']),
  isActive: z.boolean().default(true)
});

const reportSchema = z.object({
  reportedUserId: z.string().uuid(),
  reportedContentId: z.string().uuid().optional(),
  contentType: z.enum(['profile', 'message', 'review', 'service', 'user']),
  reason: z.enum(['inappropriate', 'spam', 'harassment', 'fake', 'other']),
  description: z.string().max(1000)
});

/**
 * Get pending moderation queue
 */
moderation.get('/queue', validatePagination(), async (c) => {
  const { page, limit } = c.get('validatedQuery');
  
  try {
    // For now, we'll check supplier profiles pending verification
    // In a real system, you'd have a dedicated moderation_queue table
    
    const offset = (page - 1) * limit;

    // Get pending supplier verifications
    const pendingSuppliers = await c.env.DB.prepare(`
      SELECT 
        sp.user_id,
        sp.display_name,
        sp.bio,
        sp.profile_images,
        sp.verification_status,
        sp.created_at,
        u.email,
        u.phone,
        'supplier_verification' as content_type
      FROM supplier_profiles sp
      JOIN users u ON sp.user_id = u.id
      WHERE sp.verification_status = 'pending'
      ORDER BY sp.created_at ASC
      LIMIT ? OFFSET ?
    `).bind(limit, offset).all();

    // Get count for pagination
    const countResult = await c.env.DB.prepare(`
      SELECT COUNT(*) as total 
      FROM supplier_profiles 
      WHERE verification_status = 'pending'
    `).first();

    const total = countResult?.total as number || 0;
    const pagination = createPagination(page, limit, total);

    return jsonPaginated(c, pendingSuppliers.results || [], pagination, 'Moderation queue retrieved successfully');

  } catch (error) {
    console.error('Moderation queue error:', error);
    return jsonError(c, 'Failed to load moderation queue', 'An error occurred while loading the moderation queue', 500);
  }
});

/**
 * Take moderation action on content
 */
moderation.post('/action/:contentId', validateUUID('contentId'), zValidator('json', moderationActionSchema), async (c) => {
  const contentId = c.req.param('contentId');
  const { action, reason, severity } = c.req.valid('json');
  const moderatorId = c.get('userId');
  
  try {
    // For supplier verification, update the verification status
    if (action === 'approve') {
      await c.env.DB.prepare(`
        UPDATE supplier_profiles 
        SET verification_status = 'verified', updated_at = CURRENT_TIMESTAMP 
        WHERE user_id = ?
      `).bind(contentId).run();
    } else if (action === 'reject') {
      await c.env.DB.prepare(`
        UPDATE supplier_profiles 
        SET verification_status = 'rejected', updated_at = CURRENT_TIMESTAMP 
        WHERE user_id = ?
      `).bind(contentId).run();
    }

    // Log moderation action (in a real system, you'd have a moderation_actions table)
    console.log(`Moderation action by ${moderatorId}:`, {
      contentId,
      action,
      reason,
      severity,
      timestamp: new Date().toISOString()
    });

    // Send notification to user (placeholder - would integrate with notification system)
    // await sendModerationNotification(contentId, action, reason);

    return jsonSuccess(c, {
      contentId,
      action,
      moderatorId,
      timestamp: new Date().toISOString()
    }, 'Moderation action completed successfully');

  } catch (error) {
    console.error('Moderation action error:', error);
    return jsonError(c, 'Moderation action failed', 'An error occurred while processing the moderation action', 500);
  }
});

/**
 * Get moderation statistics
 */
moderation.get('/stats', async (c) => {
  try {
    // Get verification stats
    const verificationStats = await c.env.DB.prepare(`
      SELECT 
        verification_status,
        COUNT(*) as count
      FROM supplier_profiles
      GROUP BY verification_status
    `).all();

    // Get user status stats
    const userStats = await c.env.DB.prepare(`
      SELECT 
        status,
        COUNT(*) as count
      FROM users
      GROUP BY status
    `).all();

    // Get recent moderation activity (last 30 days)
    const recentActivity = await c.env.DB.prepare(`
      SELECT 
        DATE(updated_at) as date,
        verification_status,
        COUNT(*) as count
      FROM supplier_profiles
      WHERE updated_at >= date('now', '-30 days')
      AND verification_status IN ('verified', 'rejected')
      GROUP BY DATE(updated_at), verification_status
      ORDER BY date DESC
    `).all();

    return jsonSuccess(c, {
      verification: verificationStats.results?.reduce((acc: any, row: any) => {
        acc[row.verification_status] = row.count;
        return acc;
      }, {}) || {},
      users: userStats.results?.reduce((acc: any, row: any) => {
        acc[row.status] = row.count;
        return acc;
      }, {}) || {},
      recentActivity: recentActivity.results || []
    }, 'Moderation statistics retrieved successfully');

  } catch (error) {
    console.error('Moderation stats error:', error);
    return jsonError(c, 'Failed to load moderation stats', 'An error occurred while loading moderation statistics', 500);
  }
});

/**
 * Get moderation rules
 */
moderation.get('/rules', async (c) => {
  try {
    // In a real system, you'd have a moderation_rules table
    // For now, return some default rules
    const defaultRules = [
      {
        id: '1',
        name: 'Inappropriate Content Filter',
        description: 'Flags content with inappropriate keywords',
        contentType: 'profile',
        keywords: ['inappropriate', 'explicit'],
        action: 'flag',
        isActive: true,
        createdAt: new Date().toISOString()
      },
      {
        id: '2',
        name: 'Spam Detection',
        description: 'Detects spam patterns in messages',
        contentType: 'message',
        keywords: ['spam', 'promotion'],
        action: 'require_review',
        isActive: true,
        createdAt: new Date().toISOString()
      }
    ];

    return jsonSuccess(c, defaultRules, 'Moderation rules retrieved successfully');

  } catch (error) {
    console.error('Moderation rules error:', error);
    return jsonError(c, 'Failed to load moderation rules', 'An error occurred while loading moderation rules', 500);
  }
});

/**
 * Create new moderation rule
 */
moderation.post('/rules', zValidator('json', moderationRuleSchema), async (c) => {
  const ruleData = c.req.valid('json');
  const adminId = c.get('userId');
  
  try {
    // In a real system, you'd insert into moderation_rules table
    const ruleId = crypto.randomUUID();
    
    console.log(`Admin ${adminId} created moderation rule:`, {
      id: ruleId,
      ...ruleData,
      createdAt: new Date().toISOString()
    });

    return jsonSuccess(c, {
      id: ruleId,
      ...ruleData,
      createdAt: new Date().toISOString()
    }, 'Moderation rule created successfully', 201);

  } catch (error) {
    console.error('Create moderation rule error:', error);
    return jsonError(c, 'Failed to create rule', 'An error occurred while creating the moderation rule', 500);
  }
});

/**
 * Submit content report
 */
moderation.post('/report', zValidator('json', reportSchema), async (c) => {
  const reportData = c.req.valid('json');
  const reporterId = c.get('userId');
  
  try {
    // In a real system, you'd insert into content_reports table
    const reportId = crypto.randomUUID();
    
    console.log(`Content report submitted by ${reporterId}:`, {
      id: reportId,
      ...reportData,
      reporterId,
      createdAt: new Date().toISOString(),
      status: 'pending'
    });

    // Add to moderation queue for review
    // await addToModerationQueue(reportId, reportData);

    return jsonSuccess(c, {
      reportId,
      status: 'submitted'
    }, 'Report submitted successfully', 201);

  } catch (error) {
    console.error('Submit report error:', error);
    return jsonError(c, 'Failed to submit report', 'An error occurred while submitting the report', 500);
  }
});

/**
 * Get content reports
 */
moderation.get('/reports', validatePagination(), async (c) => {
  const { page, limit } = c.get('validatedQuery');
  
  try {
    // In a real system, you'd query content_reports table
    // For now, return empty results with proper pagination structure
    const reports: any[] = [];
    const total = 0;
    
    const pagination = createPagination(page, limit, total);

    return jsonPaginated(c, reports, pagination, 'Content reports retrieved successfully');

  } catch (error) {
    console.error('Get reports error:', error);
    return jsonError(c, 'Failed to load reports', 'An error occurred while loading content reports', 500);
  }
});

export { moderation as moderationRoutes };
