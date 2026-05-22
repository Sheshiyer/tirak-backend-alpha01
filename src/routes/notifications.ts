import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { validateUUID, validatePagination } from '../middleware/validation';
import { authMiddleware } from '../middleware/auth';
import { createRateLimit } from '../middleware/rateLimit';
import { jsonSuccess, jsonError, jsonPaginated, createPagination } from '../utils/response';
import type { Env, Variables } from '../index';

const notifications = new Hono<{ Bindings: Env; Variables: Variables }>();

// Apply authentication middleware to all routes
notifications.use('*', authMiddleware);
notifications.use('*', createRateLimit('notification'));

const registerPushTokenSchema = z.object({
  token: z.string().min(1),
  deviceType: z.enum(['ios', 'android', 'web']),
  deviceInfo: z.record(z.unknown()).optional()
});

/**
 * Get user notifications
 */
notifications.get('/', validatePagination(), async (c) => {
  const userId = c.get('userId');
  const { page, limit } = c.get('validatedQuery');
  const read = c.req.query('read');
  
  try {
    let query = `
      SELECT 
        id, type, title, message, data, read, created_at
      FROM notifications
      WHERE user_id = ?
    `;

    const queryParams: Array<string | number | undefined> = [userId];

    if (read !== undefined) {
      query += ` AND read = ?`;
      queryParams.push(read === 'true' ? 1 : 0);
    }

    query += ` ORDER BY created_at DESC`;

    // Get total count
    const countQuery = query.replace(/SELECT.*FROM/, 'SELECT COUNT(*) as total FROM');
    const countResult = await c.env.DB.prepare(countQuery).bind(...queryParams).first();
    const total = countResult?.total as number || 0;

    // Get unread count
    const unreadResult = await c.env.DB.prepare(`
      SELECT COUNT(*) as unread_count
      FROM notifications
      WHERE user_id = ? AND read = FALSE
    `).bind(userId).first();
    const unreadCount = unreadResult?.unread_count as number || 0;

    // Get paginated results
    const offset = (page - 1) * limit;
    const paginatedQuery = `${query} LIMIT ? OFFSET ?`;
    const notificationsResult = await c.env.DB.prepare(paginatedQuery)
      .bind(...queryParams, limit, offset).all();

    const notificationsList = notificationsResult.results.map((notification: any) => ({
      id: notification.id,
      type: notification.type,
      title: notification.title,
      message: notification.message,
      data: JSON.parse(notification.data || '{}'),
      read: notification.read,
      createdAt: notification.created_at
    }));

    return jsonSuccess(c, {
      notifications: notificationsList,
      pagination: createPagination(page, limit, total),
      unreadCount
    }, 'Notifications retrieved successfully');

  } catch (error) {
    console.error('Get notifications error:', error);
    return jsonError(c, 'Failed to retrieve notifications', 'An error occurred while fetching notifications', 500);
  }
});

/**
 * Register or refresh a device push token.
 */
notifications.post('/push-token', zValidator('json', registerPushTokenSchema), async (c) => {
  const userId = c.get('userId') as string;
  const { token, deviceType, deviceInfo } = c.req.valid('json');
  const now = new Date().toISOString();

  try {
    const existing = await c.env.DB.prepare(`
      SELECT id, push_tokens FROM user_devices
      WHERE user_id = ? AND device_type = ? AND is_active = TRUE
      ORDER BY last_seen DESC
      LIMIT 1
    `).bind(userId, deviceType).first();

    if (existing?.id) {
      const tokens = new Set<string>(JSON.parse(String(existing.push_tokens || '[]')));
      tokens.add(token);

      await c.env.DB.prepare(`
        UPDATE user_devices
        SET push_tokens = ?, device_info = ?, last_seen = ?
        WHERE id = ?
      `).bind(
        JSON.stringify([...tokens]),
        JSON.stringify(deviceInfo || {}),
        now,
        existing.id
      ).run();
    } else {
      await c.env.DB.prepare(`
        INSERT INTO user_devices (
          id, user_id, device_type, push_tokens, device_info, is_active, last_seen, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        crypto.randomUUID(),
        userId,
        deviceType,
        JSON.stringify([token]),
        JSON.stringify(deviceInfo || {}),
        true,
        now,
        now
      ).run();
    }

    return jsonSuccess(c, {}, 'Push token registered successfully');
  } catch (error) {
    console.error('Register push token error:', error);
    return jsonError(c, 'Failed to register push token', 'An error occurred while saving the device token', 500);
  }
});

/**
 * Mark notification as read
 */
notifications.put('/:id/read', validateUUID('id'), async (c) => {
  const notificationId = c.req.param('id');
  const userId = c.get('userId');
  
  try {
    // Check if notification exists and belongs to user
    const notification = await c.env.DB.prepare(`
      SELECT id, read FROM notifications
      WHERE id = ? AND user_id = ?
    `).bind(notificationId, userId).first();

    if (!notification) {
      return jsonError(c, 'Notification not found', 'The requested notification does not exist', 404);
    }

    if (notification.read) {
      return jsonSuccess(c, {}, 'Notification already marked as read');
    }

    // Mark as read
    await c.env.DB.prepare(`
      UPDATE notifications 
      SET read = TRUE, updated_at = ?
      WHERE id = ?
    `).bind(new Date().toISOString(), notificationId).run();

    // Track notification read event
    await c.env.ANALYTICS_QUEUE.send({
      eventType: 'notification_read',
      userId,
      properties: {
        notificationId
      },
      timestamp: new Date().toISOString()
    });

    return jsonSuccess(c, {}, 'Notification marked as read');

  } catch (error) {
    console.error('Mark notification as read error:', error);
    return jsonError(c, 'Failed to mark notification as read', 'An error occurred while updating the notification', 500);
  }
});

/**
 * Mark all notifications as read
 */
notifications.put('/read-all', async (c) => {
  const userId = c.get('userId');
  
  try {
    // Get count of unread notifications
    const unreadResult = await c.env.DB.prepare(`
      SELECT COUNT(*) as unread_count
      FROM notifications
      WHERE user_id = ? AND read = FALSE
    `).bind(userId).first();
    
    const unreadCount = unreadResult?.unread_count as number || 0;

    if (unreadCount === 0) {
      return jsonSuccess(c, {}, 'No unread notifications to mark');
    }

    // Mark all as read
    await c.env.DB.prepare(`
      UPDATE notifications 
      SET read = TRUE, updated_at = ?
      WHERE user_id = ? AND read = FALSE
    `).bind(new Date().toISOString(), userId).run();

    // Track bulk read event
    await c.env.ANALYTICS_QUEUE.send({
      eventType: 'notifications_read_all',
      userId,
      properties: {
        count: unreadCount
      },
      timestamp: new Date().toISOString()
    });

    return jsonSuccess(c, {
      markedCount: unreadCount
    }, `${unreadCount} notifications marked as read`);

  } catch (error) {
    console.error('Mark all notifications as read error:', error);
    return jsonError(c, 'Failed to mark notifications as read', 'An error occurred while updating notifications', 500);
  }
});

/**
 * Create notification (internal use)
 */
export async function createNotification(
  db: any,
  queue: any,
  userId: string,
  type: string,
  title: string,
  message: string,
  data: any = {},
  options: {
    channels?: ('push' | 'email' | 'sms' | 'in_app')[];
    priority?: 'low' | 'medium' | 'high' | 'urgent';
    scheduledFor?: string;
  } = {}
) {
  try {
    const notificationId = crypto.randomUUID();
    const now = new Date().toISOString();

    await db.prepare(`
      INSERT INTO notifications (
        id, user_id, type, title, message, data, read, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      notificationId,
      userId,
      type,
      title,
      message,
      JSON.stringify(data),
      false,
      now,
      now
    ).run();

    // Send to notification queue for push notification processing
    await queue.send({
      id: notificationId,
      type: 'push',
      userId,
      title,
      message,
      data,
      priority: options.priority || 'medium',
      channels: options.channels || ['push'],
      scheduledFor: options.scheduledFor,
      retryCount: 0,
      maxRetries: 3,
    });

    return notificationId;
  } catch (error) {
    console.error('Create notification error:', error);
    throw error;
  }
}

/**
 * Get notification types and their counts
 */
notifications.get('/types', async (c) => {
  const userId = c.get('userId');
  
  try {
    const typesResult = await c.env.DB.prepare(`
      SELECT 
        type,
        COUNT(*) as total_count,
        SUM(CASE WHEN read = FALSE THEN 1 ELSE 0 END) as unread_count
      FROM notifications
      WHERE user_id = ?
      GROUP BY type
      ORDER BY total_count DESC
    `).bind(userId).all();

    const types = typesResult.results.map((typeData: any) => ({
      type: typeData.type,
      totalCount: typeData.total_count,
      unreadCount: typeData.unread_count
    }));

    return jsonSuccess(c, {
      types
    }, 'Notification types retrieved successfully');

  } catch (error) {
    console.error('Get notification types error:', error);
    return jsonError(c, 'Failed to retrieve notification types', 'An error occurred while fetching notification types', 500);
  }
});

/**
 * Delete notification
 */
notifications.delete('/:id', validateUUID('id'), async (c) => {
  const notificationId = c.req.param('id');
  const userId = c.get('userId');
  
  try {
    // Check if notification exists and belongs to user
    const notification = await c.env.DB.prepare(`
      SELECT id FROM notifications
      WHERE id = ? AND user_id = ?
    `).bind(notificationId, userId).first();

    if (!notification) {
      return jsonError(c, 'Notification not found', 'The requested notification does not exist', 404);
    }

    // Delete notification
    await c.env.DB.prepare(`
      DELETE FROM notifications WHERE id = ?
    `).bind(notificationId).run();

    // Track notification deletion
    await c.env.ANALYTICS_QUEUE.send({
      eventType: 'notification_deleted',
      userId,
      properties: {
        notificationId
      },
      timestamp: new Date().toISOString()
    });

    return jsonSuccess(c, {}, 'Notification deleted successfully');

  } catch (error) {
    console.error('Delete notification error:', error);
    return jsonError(c, 'Failed to delete notification', 'An error occurred while deleting the notification', 500);
  }
});

/**
 * Update notification preferences
 */
const updatePreferencesSchema = z.object({
  push: z.boolean().optional(),
  email: z.boolean().optional(),
  sms: z.boolean().optional(),
  in_app: z.boolean().optional(),
  types: z.object({
    booking_created: z.boolean().optional(),
    booking_request: z.boolean().optional(),
    booking_confirmed: z.boolean().optional(),
    booking_cancelled: z.boolean().optional(),
    booking_reminder: z.boolean().optional(),
    booking_status_update: z.boolean().optional(),
    new_message: z.boolean().optional(),
    review_received: z.boolean().optional(),
    payment_completed: z.boolean().optional()
  }).optional()
});

const defaultPreferences = {
  push: true,
  email: true,
  sms: false,
  in_app: true,
  types: {
    booking_created: true,
    booking_request: true,
    booking_confirmed: true,
    booking_cancelled: true,
    booking_reminder: true,
    booking_status_update: true,
    new_message: true,
    review_received: true,
    payment_completed: true,
  },
};

notifications.get('/preferences', async (c) => {
  const userId = c.get('userId') as string;

  try {
    const currentPrefs = await c.env.DB.prepare(`
      SELECT notification_preferences FROM users WHERE id = ?
    `).bind(userId).first();

    const current = JSON.parse(String(currentPrefs?.notification_preferences || '{}'));
    return jsonSuccess(c, {
      preferences: {
        ...defaultPreferences,
        ...current,
        types: {
          ...defaultPreferences.types,
          ...(current.types || {}),
        },
      },
    }, 'Notification preferences retrieved successfully');
  } catch (error) {
    console.error('Get notification preferences error:', error);
    return jsonError(c, 'Failed to retrieve preferences', 'An error occurred while fetching notification preferences', 500);
  }
});

notifications.put('/preferences', zValidator('json', updatePreferencesSchema), async (c) => {
  const userId = c.get('userId') as string;
  const preferences = c.req.valid('json');
  
  try {
    // Get current preferences
    const currentPrefs = await c.env.DB.prepare(`
      SELECT notification_preferences FROM users WHERE id = ?
    `).bind(userId).first();

    const current = JSON.parse(String(currentPrefs?.notification_preferences || '{}'));
    const updated = {
      ...defaultPreferences,
      ...current,
      ...preferences,
      types: {
        ...defaultPreferences.types,
        ...(current.types || {}),
        ...(preferences.types || {}),
      },
    };

    // Update preferences
    await c.env.DB.prepare(`
      UPDATE users 
      SET notification_preferences = ?, updated_at = ?
      WHERE id = ?
    `).bind(JSON.stringify(updated), new Date().toISOString(), userId).run();

    return jsonSuccess(c, {
      preferences: updated
    }, 'Notification preferences updated successfully');

  } catch (error) {
    console.error('Update notification preferences error:', error);
    return jsonError(c, 'Failed to update preferences', 'An error occurred while updating notification preferences', 500);
  }
});

export { notifications as notificationRoutes };
