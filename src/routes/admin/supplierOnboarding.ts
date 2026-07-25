import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { validatePagination } from '../../middleware/validation';
import { hashPassword } from '../../utils/auth';
import { sendEmail, createEmailConfig, renderBasicEmail } from '../../utils/communication';
import { jsonSuccess, jsonPaginated, jsonError, createPagination } from '../../utils/response';
import type { Env, Variables } from '../../index';

const adminSupplierOnboarding = new Hono<{ Bindings: Env; Variables: Variables }>();

const rejectSchema = z.object({
  reason: z.string().trim().max(500).optional(),
});

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
             brochure_urls, categories, mode, status, created_at
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
    }));

    return jsonPaginated(c, items, createPagination(page, limit, total), 'Supplier onboarding applications.');
  } catch (error) {
    console.error('Failed to list supplier onboarding applications:', error);
    return jsonError(c, 'ONBOARDING_LIST_FAILED', 'Could not load applications.', 500);
  }
});

adminSupplierOnboarding.get('/:id', async (c) => {
  const applicationId = c.req.param('id');

  try {
    const row = await c.env.DB.prepare(`
      SELECT id, business_name, contact_name, email, phone, location, bio,
             brochure_urls, categories, mode, status, rejection_reason,
             reviewed_user_id, reviewed_at, created_at
      FROM supplier_onboarding_applications
      WHERE id = ?
    `)
      .bind(applicationId)
      .first();

    if (!row) {
      return jsonError(c, 'APPLICATION_NOT_FOUND', 'Application not found.', 404);
    }

    const record = row as Record<string, unknown>;

    return jsonSuccess(c, {
      id: record.id,
      businessName: record.business_name,
      contactName: record.contact_name,
      email: record.email,
      phone: record.phone,
      location: record.location,
      bio: record.bio,
      brochureUrls: JSON.parse((record.brochure_urls as string) || '[]'),
      categories: JSON.parse((record.categories as string) || '[]'),
      mode: record.mode,
      status: record.status,
      rejectionReason: record.rejection_reason,
      reviewedUserId: record.reviewed_user_id,
      reviewedAt: record.reviewed_at,
      createdAt: record.created_at,
    }, 'Supplier onboarding application.');
  } catch (error) {
    console.error('Failed to load supplier onboarding application:', error);
    return jsonError(c, 'ONBOARDING_LOAD_FAILED', 'Could not load the application.', 500);
  }
});

adminSupplierOnboarding.post('/:id/approve', async (c) => {
  const applicationId = c.req.param('id');
  const adminUserId = c.get('userId');

  try {
    const row = await c.env.DB.prepare(
      'SELECT * FROM supplier_onboarding_applications WHERE id = ?'
    )
      .bind(applicationId)
      .first();

    if (!row) {
      return jsonError(c, 'APPLICATION_NOT_FOUND', 'Application not found.', 404);
    }

    const application = row as Record<string, unknown>;

    if (application.status !== 'pending') {
      return jsonError(c, 'ALREADY_REVIEWED', 'This application has already been reviewed.', 409);
    }

    const existingUser = await c.env.DB.prepare(
      'SELECT id FROM users WHERE email = ?'
    )
      .bind(application.email as string)
      .first();

    if (existingUser) {
      return jsonError(c, 'EMAIL_EXISTS', 'A user with this email already exists.', 409);
    }

    const tempPassword = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
    const passwordHash = await hashPassword(tempPassword);
    const userId = crypto.randomUUID();

    await c.env.DB.prepare(`
      INSERT INTO users (
        id, email, phone, password_hash, user_type, status,
        email_verified, phone_verified, preferred_language,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'supplier', 'pending', 1, 0, 'en', datetime('now'), datetime('now'))
    `)
      .bind(userId, application.email as string, application.phone as string, passwordHash)
      .run();

    const applicationCategories = JSON.parse((application.categories as string) || '[]') as { name?: string }[];
    const categoryNames = applicationCategories
      .map((category) => category?.name)
      .filter((name): name is string => typeof name === 'string');

    await c.env.DB.prepare(`
      INSERT INTO supplier_profiles (
        user_id, display_name, bio, location, categories,
        verification_status, subscription_status, subscription_tier,
        subscription_expires_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'pending', 'active', 'basic', datetime('now', '+30 days'), datetime('now'), datetime('now'))
    `)
      .bind(
        userId,
        application.business_name as string,
        (application.bio as string | null) ?? null,
        application.location as string,
        JSON.stringify(categoryNames)
      )
      .run();

    const inviteToken = crypto.randomUUID();
    await c.env.CACHE.put(
      `reset:${inviteToken}`,
      JSON.stringify({ userId, expiresAt: new Date(Date.now() + 24 * 3600 * 1000).toISOString() })
    );

    const inviteLink = `https://tirak.app/auth/new?token=${encodeURIComponent(inviteToken)}`;
    const emailConfig = createEmailConfig(c.env);
    const emailResult = await sendEmail(
      emailConfig,
      application.email as string,
      'Welcome to Tirak — your supplier account is ready',
      renderBasicEmail(
        'Welcome to Tirak',
        `Hi ${application.business_name as string}, your supplier account is ready.\nTemporary password: ${tempPassword}\nUse the button below to set your own password. This link expires in 24 hours.`,
        { label: 'Set your password', url: inviteLink }
      )
    );
    const emailSent = emailResult.status === 'sent';

    await c.env.DB.prepare(`
      UPDATE supplier_onboarding_applications
      SET status = 'approved', reviewed_user_id = ?, approved_user_id = ?,
          reviewed_at = datetime('now'), updated_at = datetime('now')
      WHERE id = ?
    `)
      .bind(adminUserId, userId, applicationId)
      .run();

    await c.env.DB.prepare(`
      INSERT INTO notifications (id, user_id, type, title, message, data, read, created_at)
      VALUES (?, ?, ?, ?, ?, ?, FALSE, ?)
    `)
      .bind(
        crypto.randomUUID(),
        userId,
        'supplier_application_approved',
        'Application approved',
        'Welcome to Tirak! Your supplier application has been approved.',
        JSON.stringify({ applicationId, reviewedBy: adminUserId }),
        new Date().toISOString()
      )
      .run();

    return jsonSuccess(c, {
      applicationId,
      userId,
      email: application.email,
      tempPassword,
      emailSent,
    }, 'Application approved.');
  } catch (error) {
    console.error('Supplier onboarding approval failed:', error);
    return jsonError(c, 'ONBOARDING_APPROVAL_FAILED', 'Could not approve the application.', 500);
  }
});

adminSupplierOnboarding.post('/:id/reject', zValidator('json', rejectSchema), async (c) => {
  const applicationId = c.req.param('id');
  const adminUserId = c.get('userId');
  const { reason } = c.req.valid('json');

  try {
    const row = await c.env.DB.prepare(
      'SELECT id, status FROM supplier_onboarding_applications WHERE id = ?'
    )
      .bind(applicationId)
      .first();

    if (!row) {
      return jsonError(c, 'APPLICATION_NOT_FOUND', 'Application not found.', 404);
    }

    if ((row as Record<string, unknown>).status !== 'pending') {
      return jsonError(c, 'ALREADY_REVIEWED', 'This application has already been reviewed.', 409);
    }

    await c.env.DB.prepare(`
      UPDATE supplier_onboarding_applications
      SET status = 'rejected', rejection_reason = ?, reviewed_user_id = ?,
          reviewed_at = datetime('now'), updated_at = datetime('now')
      WHERE id = ?
    `)
      .bind(reason ?? null, adminUserId, applicationId)
      .run();

    return jsonSuccess(c, { applicationId }, 'Application rejected.');
  } catch (error) {
    console.error('Supplier onboarding rejection failed:', error);
    return jsonError(c, 'ONBOARDING_REJECTION_FAILED', 'Could not reject the application.', 500);
  }
});

export { adminSupplierOnboarding as adminSupplierOnboardingRoutes };
