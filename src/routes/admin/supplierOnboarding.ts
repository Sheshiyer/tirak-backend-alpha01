import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { validatePagination } from '../../middleware/validation';
import { jsonPaginated, jsonError, createPagination, jsonSuccess } from '../../utils/response';
import { createEmailConfig, sendEmail, renderBasicEmail } from '../../utils/communication';
import { hashPassword } from '../../utils/auth';
import type { Env, Variables } from '../../index';

const adminSupplierOnboarding = new Hono<{ Bindings: Env; Variables: Variables }>();

// List (existing, lightly enhanced to include new review columns when present)
adminSupplierOnboarding.get('/', validatePagination(), async (c) => {
  const { page, limit } = c.get('validatedQuery');
  const status = c.req.query('status');
  const allowedStatuses = ['pending', 'approved', 'rejected'];

  if (status && !allowedStatuses.includes(status)) {
    return jsonError(c, 'INVALID_STATUS', 'Status must be pending, approved, or rejected.', 400);
  }

  try {
    const where = status ? 'WHERE status = ?' : '';
    const bindValues = status ? [status] : [];

    const countRow = await c.env.DB.prepare(
      `SELECT COUNT(*) as total FROM supplier_onboarding_applications ${where}`
    )
      .bind(...bindValues)
      .first();
    const total = Number((countRow as Record<string, unknown> | null)?.total ?? 0);

    const offset = (page - 1) * limit;
    const rows = await c.env.DB.prepare(`
      SELECT id, business_name, contact_name, email, phone, location, bio,
             brochure_urls, categories, mode, status, created_at,
             reviewed_at, rejection_reason, approved_user_id
      FROM supplier_onboarding_applications
      ${where}
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `)
      .bind(...bindValues, limit, offset)
      .all();

    const items = ((rows.results ?? []) as Record<string, unknown>[]).map((row) => ({
      id: row.id,
      businessName: row.business_name,
      contactName: row.contact_name,
      email: row.email,
      phone: row.phone,
      location: row.location,
      bio: row.bio,
      brochureUrls: JSON.parse((row.brochure_urls as string) || '[]'),
      categories: JSON.parse((row.categories as string) || '[]'),
      mode: row.mode,
      status: row.status,
      createdAt: row.created_at,
      reviewedAt: row.reviewed_at || undefined,
      rejectionReason: row.rejection_reason || undefined,
      approvedUserId: row.approved_user_id || undefined,
    }));

    return jsonPaginated(c, items, createPagination(page, limit, total), 'Supplier onboarding applications.');
  } catch (error) {
    console.error('Failed to list supplier onboarding applications:', error);
    return jsonError(c, 'ONBOARDING_LIST_FAILED', 'Could not load applications.', 500);
  }
});

// Detail
adminSupplierOnboarding.get('/:id', async (c) => {
  const id = c.req.param('id');
  try {
    const row = await c.env.DB.prepare(`
      SELECT id, business_name, contact_name, email, phone, location, bio,
             brochure_urls, categories, mode, status, created_at,
             reviewed_at, rejection_reason, approved_user_id
      FROM supplier_onboarding_applications
      WHERE id = ?
    `).bind(id).first();

    if (!row) {
      return jsonError(c, 'NOT_FOUND', 'Application not found', 404);
    }

    const item = {
      id: row.id,
      businessName: row.business_name,
      contactName: row.contact_name,
      email: row.email,
      phone: row.phone,
      location: row.location,
      bio: row.bio,
      brochureUrls: JSON.parse((row.brochure_urls as string) || '[]'),
      categories: JSON.parse((row.categories as string) || '[]'),
      mode: row.mode,
      status: row.status,
      createdAt: row.created_at,
      reviewedAt: row.reviewed_at || undefined,
      rejectionReason: row.rejection_reason || undefined,
      approvedUserId: row.approved_user_id || undefined,
    };

    return jsonSuccess(c, item, 'Application detail.');
  } catch (error) {
    console.error('Failed to get supplier onboarding application:', error);
    return jsonError(c, 'ONBOARDING_DETAIL_FAILED', 'Could not load application.', 500);
  }
});

const rejectSchema = z.object({
  reason: z.string().trim().min(3).max(500).optional(),
});

// Approve
adminSupplierOnboarding.post('/:id/approve', async (c) => {
  const id = c.req.param('id');
  const adminUserId = c.get('userId') as string | undefined;

  try {
    // Load application
    const app = await c.env.DB.prepare(`
      SELECT id, email, business_name, contact_name, status
      FROM supplier_onboarding_applications
      WHERE id = ?
    `).bind(id).first<{ id: string; email: string; business_name: string; contact_name: string; status: string }>();

    if (!app) {
      return jsonError(c, 'NOT_FOUND', 'Application not found', 404);
    }
    if (app.status !== 'pending') {
      return jsonError(c, 'ALREADY_REVIEWED', 'Application has already been reviewed', 409);
    }

    // Check duplicate email
    const existingUser = await c.env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(app.email).first();
    if (existingUser) {
      return jsonError(c, 'EMAIL_EXISTS', 'A user with this email already exists', 409);
    }

    // Generate 12-char temporary password
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
    let tempPassword = '';
    const array = new Uint8Array(12);
    crypto.getRandomValues(array);
    for (let i = 0; i < 12; i++) {
      tempPassword += chars[(array[i] ?? 0) % chars.length];
    }

    const passwordHash = await hashPassword(tempPassword);
    const userId = crypto.randomUUID();
    const now = new Date().toISOString();
    const trialExpires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    const phoneToUse = app.phone || '';

    // Create pending supplier user (bypass createUser which forces active)
    await c.env.DB.prepare(`
      INSERT INTO users (
        id, email, phone, password_hash, user_type, status,
        email_verified, phone_verified, preferred_language,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'supplier', 'pending', 0, 0, 'en', ?, ?)
    `    ).bind(userId, app.email, phoneToUse, passwordHash, now, now).run();

    // Create supplier profile with basic 30-day trial
    await c.env.DB.prepare(`
      INSERT INTO supplier_profiles (
        user_id, display_name, first_name, last_name, bio, location,
        profile_images, cover_photo, social_links, categories, regions, spoken_languages,
        certifications, experience_stats, verification_status, subscription_status,
        subscription_tier, subscription_expires_at,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, '[]', NULL, '{}', '[]', '[]', '[]', '[]', '{}', 'pending', 'active', 'basic', ?, ?, ?)
    `).bind(
      userId,
      app.contact_name || app.business_name,
      app.contact_name?.split(' ')[0] || app.business_name,
      app.contact_name?.split(' ').slice(1).join(' ') || '',
      null,
      null,
      trialExpires,
      now,
      now
    ).run();

    // Update application as approved
    await c.env.DB.prepare(`
      UPDATE supplier_onboarding_applications
      SET status = 'approved', reviewed_at = ?, approved_user_id = ?
      WHERE id = ?
    `).bind(now, adminUserId || null, id).run();

    // Create reset token (24h) for the "set password" flow (reuses existing KV pattern)
    const resetToken = crypto.randomUUID();
    await c.env.CACHE.put(
      `reset:${resetToken}`,
      JSON.stringify({ email: app.email, userId, purpose: 'supplier-onboarding' }),
      { expirationTtl: 86400 }
    );

    // Send email (best effort)
    let emailSent = false;
    try {
      const emailConfig = createEmailConfig(c.env);
      const subject = 'Your Tirak supplier account has been approved';
      const body = `Welcome to Tirak!\n\nYour application for ${app.business_name} has been approved.\n\nTemporary password (shown once): ${tempPassword}\n\nUse this link to set your permanent password (expires in 24 hours):\nhttps://tirak.app/auth/new?token=${encodeURIComponent(resetToken)}\n\nOr open in the app: tirak://auth/new?token=${encodeURIComponent(resetToken)}`;
      await sendEmail(emailConfig, app.email, subject, body);
      emailSent = true;
    } catch (e) {
      console.warn('Failed to send supplier onboarding credentials email (will show temp password in UI):', e);
    }

    // Create in-app notification for the new supplier
    try {
      const notifId = crypto.randomUUID();
      await c.env.DB.prepare(`
        INSERT INTO notifications (id, user_id, type, title, message, data, read, created_at, updated_at)
        VALUES (?, ?, 'supplier_approved', 'Application Approved', 'Your supplier application has been approved. Check your email for login credentials.', ?, 0, ?, ?)
      `).bind(notifId, userId, JSON.stringify({ applicationId: id }), now, now).run();
    } catch (e) {
      console.warn('Failed to create supplier approval notification:', e);
    }

    return jsonSuccess(c, {
      applicationId: id,
      userId,
      email: app.email,
      tempPassword,
      emailSent,
    }, 'Supplier approved. Credentials generated.');
  } catch (error) {
    console.error('Approve supplier onboarding failed:', error);
    return jsonError(c, 'APPROVE_FAILED', 'Could not approve application.', 500);
  }
});

// Reject
adminSupplierOnboarding.post('/:id/reject', zValidator('json', rejectSchema), async (c) => {
  const id = c.req.param('id');
  const { reason } = c.req.valid('json');
  const adminUserId = c.get('userId') as string | undefined;

  try {
    const app = await c.env.DB.prepare(`
      SELECT id, status FROM supplier_onboarding_applications WHERE id = ?
    `).bind(id).first<{ id: string; status: string }>();

    if (!app) {
      return jsonError(c, 'NOT_FOUND', 'Application not found', 404);
    }
    if (app.status !== 'pending') {
      return jsonError(c, 'ALREADY_REVIEWED', 'Application has already been reviewed', 409);
    }

    const now = new Date().toISOString();
    await c.env.DB.prepare(`
      UPDATE supplier_onboarding_applications
      SET status = 'rejected', reviewed_at = ?, rejection_reason = ?, approved_user_id = ?
      WHERE id = ?
    `).bind(now, reason || null, adminUserId || null, id).run();

    return jsonSuccess(c, { applicationId: id }, 'Application rejected.');
  } catch (error) {
    console.error('Reject supplier onboarding failed:', error);
    return jsonError(c, 'REJECT_FAILED', 'Could not reject application.', 500);
  }
});

export { adminSupplierOnboarding as adminSupplierOnboardingRoutes };
