import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { authMiddleware, adminOnly } from '../../middleware/auth';
import { createRateLimit } from '../../middleware/rateLimit';
import { adminCors } from '../../middleware/cors';
import { validatePagination, validateUUID } from '../../middleware/validation';
import { jsonSuccess, jsonError, jsonPaginated, createPagination } from '../../utils/response';
import type { Env, Variables } from '../../index';

const operations = new Hono<{ Bindings: Env; Variables: Variables }>();

operations.use('*', adminCors());
operations.use('*', authMiddleware);
operations.use('*', adminOnly);
operations.use('*', createRateLimit('admin'));

const modeSchema = z.object({
  mode: z.enum(['tirak', 'tirakplus']).default('tirak')
});

const bookingQuerySchema = modeSchema.extend({
  status: z.enum(['pending', 'confirmed', 'completed', 'cancelled']).optional()
});

const adminSettingsSchema = z.object({
  supportEmail: z.string().email().optional(),
  helpEmail: z.string().email().optional(),
  privacyPolicyUrl: z.string().url().optional(),
  notificationChannels: z.object({
    push: z.boolean(),
    email: z.boolean(),
    inApp: z.boolean()
  }).optional(),
  bookingReminderHours: z.number().min(1).max(72).optional()
});

const emptySettings = {
  supportEmail: 'support@tirak.app',
  helpEmail: 'help@tirak.app',
  privacyPolicyUrl: 'https://tirak.app/privacy',
  notificationChannels: {
    push: true,
    email: true,
    inApp: true
  },
  bookingReminderHours: 3
};

function isTirakPlus(mode: string) {
  return mode === 'tirakplus';
}

async function readSettings(env: Env) {
  const stored = await env.CACHE.get('admin:tirak:settings');
  if (!stored) {
    return emptySettings;
  }

  try {
    return {
      ...emptySettings,
      ...JSON.parse(stored)
    };
  } catch {
    return emptySettings;
  }
}

/**
 * Admin-wide operations summary for release readiness surfaces.
 */
operations.get('/summary', zValidator('query', modeSchema), async (c) => {
  const { mode } = c.req.valid('query');

  try {
    if (isTirakPlus(mode)) {
      return jsonSuccess(c, {
        mode,
        bookings: { pending: 0, confirmed: 0, upcoming: 0 },
        notifications: { unread: 0, recent: 0 },
        referrals: { awardedEvents: 0, coinsIssued: 0 },
        email: { configured: false, provider: 'demo', from: null },
        settings: emptySettings
      }, 'Tirak Plus operations are served by the admin app demo layer.');
    }

    const bookingStats = await c.env.DB.prepare(`
      SELECT
        COUNT(CASE WHEN status = 'pending' THEN 1 END) as pending,
        COUNT(CASE WHEN status = 'confirmed' THEN 1 END) as confirmed,
        COUNT(CASE WHEN status IN ('pending', 'confirmed') AND scheduled_at >= datetime('now') THEN 1 END) as upcoming
      FROM bookings
    `).first();

    const notificationStats = await c.env.DB.prepare(`
      SELECT
        COUNT(CASE WHEN read = FALSE THEN 1 END) as unread,
        COUNT(CASE WHEN created_at >= datetime('now', '-24 hours') THEN 1 END) as recent
      FROM notifications
    `).first();

    const referralStats = await c.env.DB.prepare(`
      SELECT
        COUNT(CASE WHEN status = 'awarded' THEN 1 END) as awarded_events,
        COALESCE(SUM(CASE WHEN status = 'awarded' THEN coins_awarded ELSE 0 END), 0) as coins_issued
      FROM referral_events
    `).first();

    return jsonSuccess(c, {
      mode,
      bookings: {
        pending: (bookingStats as any)?.pending || 0,
        confirmed: (bookingStats as any)?.confirmed || 0,
        upcoming: (bookingStats as any)?.upcoming || 0
      },
      notifications: {
        unread: (notificationStats as any)?.unread || 0,
        recent: (notificationStats as any)?.recent || 0
      },
      referrals: {
        awardedEvents: (referralStats as any)?.awarded_events || 0,
        coinsIssued: (referralStats as any)?.coins_issued || 0
      },
      email: {
        configured: Boolean(c.env.EMAIL || c.env.SENDGRID_API_KEY || c.env.MAILCHANNELS_API_KEY),
        provider: c.env.EMAIL_PROVIDER || (c.env.EMAIL ? 'cloudflare-email' : c.env.SENDGRID_API_KEY ? 'sendgrid' : c.env.MAILCHANNELS_API_KEY ? 'mailchannels' : 'unconfigured'),
        from: c.env.EMAIL_FROM || c.env.SENDGRID_FROM_EMAIL || c.env.MAILCHANNELS_FROM_EMAIL || null
      },
      settings: await readSettings(c.env)
    }, 'Admin operations summary retrieved successfully');
  } catch (error) {
    console.error('Admin operations summary error:', error);
    return jsonError(c, 'Failed to load operations', 'An error occurred while loading admin operations', 500);
  }
});

/**
 * Admin-wide booking queue.
 */
operations.get('/bookings', validatePagination(), zValidator('query', bookingQuerySchema), async (c) => {
  const { page, limit } = c.get('validatedQuery');
  const { mode, status } = c.req.valid('query');

  try {
    if (isTirakPlus(mode)) {
      return jsonPaginated(c, [], createPagination(page, limit, 0), 'Tirak Plus bookings are served by the admin app demo layer.');
    }

    const conditions: string[] = [];
    const params: string[] = [];
    if (status) {
      conditions.push('b.status = ?');
      params.push(status);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const offset = (page - 1) * limit;

    const count = await c.env.DB.prepare(`
      SELECT COUNT(*) as total
      FROM bookings b
      ${where}
    `).bind(...params).first();

    const rows = await c.env.DB.prepare(`
      SELECT
        b.id,
        b.status,
        b.scheduled_at,
        b.duration,
        b.total_amount,
        b.currency,
        b.notes,
        b.created_at,
        b.updated_at,
        b.customer_id,
        cu.email as customer_email,
        cu.phone as customer_phone,
        cp.display_name as customer_name,
        cp.profile_image as customer_profile_image,
        b.supplier_id,
        su.email as supplier_email,
        su.phone as supplier_phone,
        sp.display_name as supplier_name,
        sp.profile_images as supplier_profile_images,
        ss.title as service_name,
        ss.currency as service_currency
      FROM bookings b
      LEFT JOIN users cu ON cu.id = b.customer_id
      LEFT JOIN customer_profiles cp ON cp.user_id = b.customer_id
      LEFT JOIN users su ON su.id = b.supplier_id
      LEFT JOIN supplier_profiles sp ON sp.user_id = b.supplier_id
      LEFT JOIN supplier_services ss ON ss.id = b.service_id
      ${where}
      ORDER BY b.created_at DESC
      LIMIT ? OFFSET ?
    `).bind(...params, limit, offset).all();

    return jsonPaginated(c, rows.results || [], createPagination(page, limit, Number((count as any)?.total || 0)), 'Admin bookings retrieved successfully');
  } catch (error) {
    console.error('Admin bookings error:', error);
    return jsonError(c, 'Failed to load bookings', 'An error occurred while loading admin bookings', 500);
  }
});

/**
 * Admin-wide notification feed. This intentionally does not auto-mark read.
 */
operations.get('/notifications', validatePagination(), zValidator('query', modeSchema), async (c) => {
  const { page, limit } = c.get('validatedQuery');
  const { mode } = c.req.valid('query');

  try {
    if (isTirakPlus(mode)) {
      return jsonSuccess(c, {
        notifications: [],
        pagination: createPagination(page, limit, 0),
        unreadCount: 0
      }, 'Tirak Plus notifications are served by the admin app demo layer.');
    }

    const total = await c.env.DB.prepare('SELECT COUNT(*) as total FROM notifications').first();
    const unread = await c.env.DB.prepare('SELECT COUNT(*) as unread_count FROM notifications WHERE read = FALSE').first();
    const offset = (page - 1) * limit;
    const rows = await c.env.DB.prepare(`
      SELECT
        n.id,
        n.type,
        n.title,
        n.message,
        n.data,
        n.read,
        n.created_at,
        n.user_id,
        u.email as user_email,
        u.user_type
      FROM notifications n
      LEFT JOIN users u ON u.id = n.user_id
      ORDER BY n.created_at DESC
      LIMIT ? OFFSET ?
    `).bind(limit, offset).all();

    return jsonSuccess(c, {
      notifications: (rows.results || []).map((row: any) => ({
        ...row,
        data: JSON.parse(row.data || '{}'),
        createdAt: row.created_at
      })),
      pagination: createPagination(page, limit, Number((total as any)?.total || 0)),
      unreadCount: (unread as any)?.unread_count || 0
    }, 'Admin notifications retrieved successfully');
  } catch (error) {
    console.error('Admin notifications error:', error);
    return jsonError(c, 'Failed to load notifications', 'An error occurred while loading admin notifications', 500);
  }
});

operations.put('/notifications/:id/read', validateUUID('id'), async (c) => {
  const notificationId = c.req.param('id');

  try {
    const existing = await c.env.DB.prepare('SELECT id FROM notifications WHERE id = ?').bind(notificationId).first();
    if (!existing) {
      return jsonError(c, 'Notification not found', 'The requested notification does not exist', 404);
    }

    await c.env.DB.prepare(`
      UPDATE notifications
      SET read = TRUE, updated_at = ?
      WHERE id = ?
    `).bind(new Date().toISOString(), notificationId).run();

    return jsonSuccess(c, {}, 'Notification marked as read');
  } catch (error) {
    console.error('Admin notification read error:', error);
    return jsonError(c, 'Failed to mark notification', 'An error occurred while updating the notification', 500);
  }
});

operations.put('/notifications/read-all', async (c) => {
  try {
    const unread = await c.env.DB.prepare('SELECT COUNT(*) as unread_count FROM notifications WHERE read = FALSE').first();
    await c.env.DB.prepare(`
      UPDATE notifications
      SET read = TRUE, updated_at = ?
      WHERE read = FALSE
    `).bind(new Date().toISOString()).run();

    return jsonSuccess(c, {
      markedCount: (unread as any)?.unread_count || 0
    }, 'Admin notifications marked as read');
  } catch (error) {
    console.error('Admin notification read-all error:', error);
    return jsonError(c, 'Failed to mark notifications', 'An error occurred while updating notifications', 500);
  }
});

operations.delete('/notifications/:id', validateUUID('id'), async (c) => {
  const notificationId = c.req.param('id');

  try {
    const existing = await c.env.DB.prepare('SELECT id FROM notifications WHERE id = ?').bind(notificationId).first();
    if (!existing) {
      return jsonError(c, 'Notification not found', 'The requested notification does not exist', 404);
    }

    await c.env.DB.prepare('DELETE FROM notifications WHERE id = ?').bind(notificationId).run();
    return jsonSuccess(c, {}, 'Notification removed from admin feed');
  } catch (error) {
    console.error('Admin notification delete error:', error);
    return jsonError(c, 'Failed to remove notification', 'An error occurred while removing the notification', 500);
  }
});

operations.delete('/notifications', async (c) => {
  try {
    const existing = await c.env.DB.prepare('SELECT COUNT(*) as total FROM notifications').first();
    await c.env.DB.prepare('DELETE FROM notifications').run();
    return jsonSuccess(c, {
      removedCount: (existing as any)?.total || 0
    }, 'Admin notification feed cleared');
  } catch (error) {
    console.error('Admin notification clear error:', error);
    return jsonError(c, 'Failed to clear notifications', 'An error occurred while clearing notifications', 500);
  }
});

operations.get('/referrals', validatePagination(), zValidator('query', modeSchema), async (c) => {
  const { page, limit } = c.get('validatedQuery');
  const { mode } = c.req.valid('query');

  try {
    if (isTirakPlus(mode)) {
      return jsonSuccess(c, {
        summary: { accounts: 0, events: 0, coinsIssued: 0, coinsBalance: 0 },
        events: [],
        pagination: createPagination(page, limit, 0)
      }, 'Tirak Plus referrals are served by the admin app demo layer.');
    }

    const summary = await c.env.DB.prepare(`
      SELECT
        (SELECT COUNT(*) FROM referral_accounts) as accounts,
        (SELECT COUNT(*) FROM referral_events) as events,
        (SELECT COALESCE(SUM(coins_awarded), 0) FROM referral_events WHERE status = 'awarded') as coins_issued,
        (SELECT COALESCE(SUM(coin_balance), 0) FROM referral_accounts) as coins_balance
    `).first();
    const total = await c.env.DB.prepare('SELECT COUNT(*) as total FROM referral_events').first();
    const offset = (page - 1) * limit;
    const rows = await c.env.DB.prepare(`
      SELECT
        re.*,
        ru.email as referrer_email,
        uu.email as referred_email
      FROM referral_events re
      LEFT JOIN users ru ON ru.id = re.referrer_id
      LEFT JOIN users uu ON uu.id = re.referred_user_id
      ORDER BY re.created_at DESC
      LIMIT ? OFFSET ?
    `).bind(limit, offset).all();

    return jsonSuccess(c, {
      summary: {
        accounts: (summary as any)?.accounts || 0,
        events: (summary as any)?.events || 0,
        coinsIssued: (summary as any)?.coins_issued || 0,
        coinsBalance: (summary as any)?.coins_balance || 0
      },
      events: rows.results || [],
      pagination: createPagination(page, limit, Number((total as any)?.total || 0))
    }, 'Referral operations retrieved successfully');
  } catch (error) {
    console.error('Admin referrals error:', error);
    return jsonError(c, 'Failed to load referrals', 'An error occurred while loading referral operations', 500);
  }
});

operations.get('/settings', zValidator('query', modeSchema), async (c) => {
  const { mode } = c.req.valid('query');

  try {
    if (isTirakPlus(mode)) {
      return jsonSuccess(c, emptySettings, 'Tirak Plus settings are served by the admin app demo layer.');
    }

    return jsonSuccess(c, {
      ...(await readSettings(c.env)),
      email: {
        configured: Boolean(c.env.EMAIL || c.env.SENDGRID_API_KEY || c.env.MAILCHANNELS_API_KEY),
        provider: c.env.EMAIL_PROVIDER || (c.env.EMAIL ? 'cloudflare-email' : c.env.SENDGRID_API_KEY ? 'sendgrid' : c.env.MAILCHANNELS_API_KEY ? 'mailchannels' : 'unconfigured'),
        from: c.env.EMAIL_FROM || c.env.SENDGRID_FROM_EMAIL || c.env.MAILCHANNELS_FROM_EMAIL || null
      }
    }, 'Admin settings retrieved successfully');
  } catch (error) {
    console.error('Admin settings load error:', error);
    return jsonError(c, 'Failed to load settings', 'An error occurred while loading settings', 500);
  }
});

operations.patch('/settings', zValidator('query', modeSchema), zValidator('json', adminSettingsSchema), async (c) => {
  const { mode } = c.req.valid('query');
  const updates = c.req.valid('json');

  try {
    if (isTirakPlus(mode)) {
      return jsonError(c, 'Settings not persisted', 'Tirak Plus settings are local demo settings', 400);
    }

    const nextSettings = {
      ...(await readSettings(c.env)),
      ...updates,
      updatedAt: new Date().toISOString()
    };
    await c.env.CACHE.put('admin:tirak:settings', JSON.stringify(nextSettings));

    return jsonSuccess(c, nextSettings, 'Admin settings saved successfully');
  } catch (error) {
    console.error('Admin settings save error:', error);
    return jsonError(c, 'Failed to save settings', 'An error occurred while saving settings', 500);
  }
});

export { operations as operationRoutes };
