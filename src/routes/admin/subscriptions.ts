import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { authMiddleware, adminOnly } from '../../middleware/auth';
import { createRateLimit } from '../../middleware/rateLimit';
import { adminCors } from '../../middleware/cors';
import { jsonSuccess, jsonError, jsonPaginated, createPagination } from '../../utils/response';
import { validatePagination, validateUUID } from '../../middleware/validation';
import type { Env, Variables } from '../../index';

const subscriptions = new Hono<{ Bindings: Env; Variables: Variables }>();

// Apply admin-specific middleware
subscriptions.use('*', adminCors());
subscriptions.use('*', authMiddleware);
subscriptions.use('*', adminOnly);
subscriptions.use('*', createRateLimit('admin'));

// Validation schemas
const subscriptionUpdateSchema = z.object({
  subscriptionStatus: z.enum(['active', 'inactive', 'expired']).optional(),
  subscriptionTier: z.enum(['basic', 'premium', 'enterprise']).optional(),
  subscriptionExpiresAt: z.string().datetime().optional(),
  reason: z.string().max(500).optional()
});

const billingActionSchema = z.object({
  action: z.enum(['refund', 'extend', 'upgrade', 'downgrade']),
  amount: z.number().positive().optional(),
  days: z.number().positive().optional(),
  reason: z.string().min(1).max(500)
});

/**
 * Get subscription overview
 */
subscriptions.get('/overview', async (c) => {
  try {
    // Subscription status distribution
    const statusDistribution = await c.env.DB.prepare(`
      SELECT 
        subscription_status,
        subscription_tier,
        COUNT(*) as count
      FROM supplier_profiles
      GROUP BY subscription_status, subscription_tier
    `).all();

    // Revenue metrics
    const revenueMetrics = await c.env.DB.prepare(`
      SELECT 
        subscription_tier,
        COUNT(*) as subscriber_count,
        COUNT(CASE WHEN subscription_status = 'active' THEN 1 END) as active_subscribers
      FROM supplier_profiles
      GROUP BY subscription_tier
    `).all();

    // Expiring subscriptions (next 30 days)
    const expiringSubscriptions = await c.env.DB.prepare(`
      SELECT 
        COUNT(*) as expiring_count
      FROM supplier_profiles
      WHERE subscription_status = 'active'
      AND subscription_expires_at <= date('now', '+30 days')
      AND subscription_expires_at > date('now')
    `).first();

    // Monthly recurring revenue (simplified calculation)
    const tierPricing = {
      basic: 99,
      premium: 299,
      enterprise: 599
    };

    const mrr = revenueMetrics.results?.reduce((total: number, tier: any) => {
      const price = tierPricing[tier.subscription_tier as keyof typeof tierPricing] || 0;
      return total + (tier.active_subscribers * price);
    }, 0) || 0;

    return jsonSuccess(c, {
      statusDistribution: statusDistribution.results || [],
      revenueMetrics: revenueMetrics.results || [],
      expiringSubscriptions: expiringSubscriptions?.expiring_count || 0,
      monthlyRecurringRevenue: mrr,
      totalActiveSubscribers: revenueMetrics.results?.reduce((sum: number, tier: any) => sum + tier.active_subscribers, 0) || 0
    }, 'Subscription overview retrieved successfully');

  } catch (error) {
    console.error('Subscription overview error:', error);
    return jsonError(c, 'Failed to load subscription overview', 'An error occurred while loading subscription data', 500);
  }
});

/**
 * Get all subscriptions with filtering
 */
subscriptions.get('/', validatePagination(), async (c) => {
  const { page, limit } = c.req.valid('query');
  const status = c.req.query('status');
  const tier = c.req.query('tier');
  const search = c.req.query('search');
  
  try {
    // Build WHERE clause
    const conditions = [];
    const params = [];

    if (status) {
      conditions.push('sp.subscription_status = ?');
      params.push(status);
    }

    if (tier) {
      conditions.push('sp.subscription_tier = ?');
      params.push(tier);
    }

    if (search) {
      conditions.push('(sp.display_name LIKE ? OR u.email LIKE ?)');
      const searchTerm = `%${search}%`;
      params.push(searchTerm, searchTerm);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // Get total count
    const countQuery = `
      SELECT COUNT(*) as total 
      FROM supplier_profiles sp
      JOIN users u ON sp.user_id = u.id
      ${whereClause}
    `;
    
    const countResult = await c.env.DB.prepare(countQuery).bind(...params).first();
    const total = countResult?.total as number || 0;

    // Get subscriptions
    const offset = (page - 1) * limit;
    const subscriptionsQuery = `
      SELECT 
        sp.user_id,
        sp.display_name,
        sp.subscription_status,
        sp.subscription_tier,
        sp.subscription_expires_at,
        sp.created_at as subscription_created_at,
        sp.updated_at as subscription_updated_at,
        u.email,
        u.phone,
        u.status as user_status
      FROM supplier_profiles sp
      JOIN users u ON sp.user_id = u.id
      ${whereClause}
      ORDER BY sp.subscription_expires_at ASC
      LIMIT ? OFFSET ?
    `;

    const subscriptionsResult = await c.env.DB.prepare(subscriptionsQuery)
      .bind(...params, limit, offset)
      .all();

    const pagination = createPagination(page, limit, total);

    return jsonPaginated(c, subscriptionsResult.results || [], pagination, 'Subscriptions retrieved successfully');

  } catch (error) {
    console.error('Subscriptions list error:', error);
    return jsonError(c, 'Failed to retrieve subscriptions', 'An error occurred while retrieving subscriptions', 500);
  }
});

/**
 * Get specific subscription details
 */
subscriptions.get('/:userId', validateUUID('userId'), async (c) => {
  const userId = c.req.param('userId');
  
  try {
    // Get subscription details
    const subscription = await c.env.DB.prepare(`
      SELECT 
        sp.*,
        u.email,
        u.phone,
        u.status as user_status,
        u.created_at as user_created_at
      FROM supplier_profiles sp
      JOIN users u ON sp.user_id = u.id
      WHERE sp.user_id = ?
    `).bind(userId).first();

    if (!subscription) {
      return jsonError(c, 'Subscription not found', 'The specified subscription does not exist', 404);
    }

    // Get billing history (placeholder - in real system you'd have a billing_transactions table)
    const billingHistory = [
      {
        id: '1',
        date: '2024-01-01',
        amount: 299,
        status: 'paid',
        description: 'Premium subscription - January 2024'
      },
      {
        id: '2',
        date: '2024-02-01',
        amount: 299,
        status: 'paid',
        description: 'Premium subscription - February 2024'
      }
    ];

    // Get usage metrics (placeholder)
    const usageMetrics = {
      profileViews: 1250,
      bookingsReceived: 45,
      messagesExchanged: 230,
      averageRating: 4.8
    };

    return jsonSuccess(c, {
      subscription,
      billingHistory,
      usageMetrics
    }, 'Subscription details retrieved successfully');

  } catch (error) {
    console.error('Subscription details error:', error);
    return jsonError(c, 'Failed to retrieve subscription', 'An error occurred while retrieving subscription details', 500);
  }
});

/**
 * Update subscription
 */
subscriptions.patch('/:userId', validateUUID('userId'), zValidator('json', subscriptionUpdateSchema), async (c) => {
  const userId = c.req.param('userId');
  const updates = c.req.valid('json');
  const adminId = c.get('userId');
  
  try {
    // Check if subscription exists
    const existingSubscription = await c.env.DB.prepare('SELECT user_id FROM supplier_profiles WHERE user_id = ?').bind(userId).first();
    if (!existingSubscription) {
      return jsonError(c, 'Subscription not found', 'The specified subscription does not exist', 404);
    }

    // Build update query
    const updateFields = [];
    const params = [];

    if (updates.subscriptionStatus !== undefined) {
      updateFields.push('subscription_status = ?');
      params.push(updates.subscriptionStatus);
    }

    if (updates.subscriptionTier !== undefined) {
      updateFields.push('subscription_tier = ?');
      params.push(updates.subscriptionTier);
    }

    if (updates.subscriptionExpiresAt !== undefined) {
      updateFields.push('subscription_expires_at = ?');
      params.push(updates.subscriptionExpiresAt);
    }

    if (updateFields.length === 0) {
      return jsonError(c, 'No updates provided', 'At least one field must be updated', 400);
    }

    updateFields.push('updated_at = CURRENT_TIMESTAMP');
    params.push(userId);

    // Update subscription
    await c.env.DB.prepare(`
      UPDATE supplier_profiles 
      SET ${updateFields.join(', ')}
      WHERE user_id = ?
    `).bind(...params).run();

    // Log admin action
    console.log(`Admin ${adminId} updated subscription ${userId}:`, updates);

    return jsonSuccess(c, { userId, updates }, 'Subscription updated successfully');

  } catch (error) {
    console.error('Subscription update error:', error);
    return jsonError(c, 'Failed to update subscription', 'An error occurred while updating the subscription', 500);
  }
});

/**
 * Process billing action
 */
subscriptions.post('/:userId/billing', validateUUID('userId'), zValidator('json', billingActionSchema), async (c) => {
  const userId = c.req.param('userId');
  const { action, amount, days, reason } = c.req.valid('json');
  const adminId = c.get('userId');
  
  try {
    // Check if subscription exists
    const subscription = await c.env.DB.prepare('SELECT * FROM supplier_profiles WHERE user_id = ?').bind(userId).first();
    if (!subscription) {
      return jsonError(c, 'Subscription not found', 'The specified subscription does not exist', 404);
    }

    // Process the billing action
    let result = {};

    switch (action) {
      case 'extend':
        if (!days) {
          return jsonError(c, 'Days required', 'Number of days is required for extend action', 400);
        }
        
        const currentExpiry = new Date(subscription.subscription_expires_at || Date.now());
        const newExpiry = new Date(currentExpiry.getTime() + days * 24 * 60 * 60 * 1000);
        
        await c.env.DB.prepare(`
          UPDATE supplier_profiles 
          SET subscription_expires_at = ?, updated_at = CURRENT_TIMESTAMP
          WHERE user_id = ?
        `).bind(newExpiry.toISOString(), userId).run();
        
        result = { newExpiryDate: newExpiry.toISOString() };
        break;

      case 'upgrade':
      case 'downgrade':
        // In a real system, you'd handle tier changes and prorated billing
        result = { message: `${action} processed - billing adjustment will be applied` };
        break;

      case 'refund':
        if (!amount) {
          return jsonError(c, 'Amount required', 'Refund amount is required', 400);
        }
        // In a real system, you'd process the refund through payment gateway
        result = { refundAmount: amount, status: 'processed' };
        break;
    }

    // Log billing action
    console.log(`Admin ${adminId} performed billing action ${action} for subscription ${userId}:`, {
      amount,
      days,
      reason,
      result
    });

    return jsonSuccess(c, {
      action,
      userId,
      result,
      processedBy: adminId,
      processedAt: new Date().toISOString()
    }, 'Billing action processed successfully');

  } catch (error) {
    console.error('Billing action error:', error);
    return jsonError(c, 'Billing action failed', 'An error occurred while processing the billing action', 500);
  }
});

/**
 * Get billing analytics
 */
subscriptions.get('/analytics/billing', async (c) => {
  try {
    // Monthly revenue trends (last 12 months)
    const revenueTrends = [];
    for (let i = 11; i >= 0; i--) {
      const date = new Date();
      date.setMonth(date.getMonth() - i);
      const monthKey = date.toISOString().slice(0, 7); // YYYY-MM format
      
      // In a real system, you'd calculate actual revenue from billing records
      revenueTrends.push({
        month: monthKey,
        revenue: Math.floor(Math.random() * 50000) + 20000, // Placeholder data
        subscribers: Math.floor(Math.random() * 200) + 100
      });
    }

    // Churn analysis
    const churnAnalysis = {
      monthlyChurnRate: 5.2,
      averageLifetimeValue: 2400,
      retentionRate: 94.8
    };

    // Revenue by tier
    const revenueByTier = await c.env.DB.prepare(`
      SELECT 
        subscription_tier,
        COUNT(CASE WHEN subscription_status = 'active' THEN 1 END) as active_count
      FROM supplier_profiles
      GROUP BY subscription_tier
    `).all();

    return jsonSuccess(c, {
      revenueTrends,
      churnAnalysis,
      revenueByTier: revenueByTier.results || []
    }, 'Billing analytics retrieved successfully');

  } catch (error) {
    console.error('Billing analytics error:', error);
    return jsonError(c, 'Failed to load billing analytics', 'An error occurred while loading billing analytics', 500);
  }
});

export { subscriptions as subscriptionRoutes };
