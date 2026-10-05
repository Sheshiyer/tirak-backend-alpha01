import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { validatePagination } from '../../middleware/validation';
import { jsonPaginated, jsonError, createPagination, jsonSuccess, jsonResponse, errorResponse } from '../../utils/response';
import { createEmailConfig, sendEmail, renderBasicEmail, recordEmailOutcome } from '../../utils/communication';
import { normalizeEmail, validateApplicationData, ApplicationDataValidationError } from '../../utils/supplier-onboarding';
import type { Env, Variables } from '../../index';

const adminSupplierOnboarding = new Hono<{ Bindings: Env; Variables: Variables }>();

type ApprovalStateRow = {
  id: string;
  status: string;
  approved_user_id: string | null;
  reviewed_user_id: string | null;
  invitation_delivery_status?: string | null;
};

function requireCoreMode(row: { mode?: unknown } | null) {
  return row && row.mode === 'tirak';
}

function isUniqueConstraintError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = String((error as { code?: unknown }).code || '');
  const message = error.message || '';
  return code === 'SQLITE_CONSTRAINT_UNIQUE' || message.includes('UNIQUE constraint failed');
}

async function loadApprovalState(c: { env: Env }, id: string): Promise<ApprovalStateRow | null> {
  return c.env.DB.prepare(
    `SELECT id, status, approved_user_id, reviewed_user_id, invitation_delivery_status
     FROM supplier_onboarding_applications
     WHERE id = ?`
  ).bind(id).first<ApprovalStateRow>();
}

function buildApprovedReplayPayload(row: ApprovalStateRow) {
  return {
    applicationId: row.id,
    userId: row.approved_user_id,
    approvedUserId: row.approved_user_id,
    reviewedUserId: row.reviewed_user_id,
    status: row.status,
    invitationDelivery: { status: row.invitation_delivery_status || 'unknown' },
  };
}

function jsonAlreadyReviewedWithState(c: Parameters<typeof jsonSuccess>[0], row: ApprovalStateRow): Response {
  return jsonResponse(c, {
    ...errorResponse('ALREADY_REVIEWED', 'Application has already been reviewed'),
    data: buildApprovedReplayPayload(row),
  }, 409);
}

// List (existing, lightly enhanced to include new review columns when present)
adminSupplierOnboarding.get('/', validatePagination(), async (c) => {
  const { page, limit } = c.get('validatedQuery');
  const status = c.req.query('status');
  const mode = c.req.query('mode');
  const allowedStatuses = ['pending', 'approved', 'rejected'];
  const allowedModes = ['tirak', 'tirakplus'];

  if (status && !allowedStatuses.includes(status)) {
    return jsonError(c, 'INVALID_STATUS', 'Status must be pending, approved, or rejected.', 400);
  }
  if (mode && !allowedModes.includes(mode)) {
    return jsonError(c, 'INVALID_MODE', 'Mode must be tirak or tirakplus.', 400);
  }

  try {
    const conditions: string[] = [];
    const bindValues: unknown[] = [];
    if (status) { conditions.push('status = ?'); bindValues.push(status); }
    if (mode) { conditions.push('mode = ?'); bindValues.push(mode); }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

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
             reviewed_at, rejection_reason, approved_user_id, reviewed_user_id
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
      reviewedUserId: row.reviewed_user_id || undefined,
    }));

    return jsonPaginated(c, items, createPagination(page, limit, total), 'Supplier onboarding applications.');
  } catch (error) {
    console.error('Failed to list supplier onboarding applications');
    return jsonError(c, 'ONBOARDING_LIST_FAILED', 'Could not load applications.', 500);
  }
});

// Detail — includes evidence refs
adminSupplierOnboarding.get('/:id', async (c) => {
  const id = c.req.param('id');
  try {
    const row = await c.env.DB.prepare(`
      SELECT id, business_name, contact_name, email, phone, location, bio,
             brochure_urls, categories, mode, status, created_at,
             reviewed_at, rejection_reason, approved_user_id, reviewed_user_id,
             application_data, invitation_delivery_status
      FROM supplier_onboarding_applications
      WHERE id = ?
    `).bind(id).first();

    if (!row) {
      return jsonError(c, 'NOT_FOUND', 'Application not found', 404);
    }
    if (!requireCoreMode(row as Record<string, unknown>)) {
      return jsonError(c, 'CORE_MODE_REQUIRED', 'This endpoint only serves Core supplier onboarding applications.', 404);
    }

    // Load evidence refs (table may not exist yet)
    let evidenceRefs: Array<{ evidenceId: string; kind: string }> = [];
    try {
      const evRows = await c.env.DB.prepare(
        `SELECT id, kind FROM supplier_onboarding_evidence WHERE application_id = ?`
      ).bind(id).all<{ id: string; kind: string }>();
      evidenceRefs = (evRows.results ?? []).map(r => ({ evidenceId: r.id, kind: r.kind }));
    } catch {
      // Table may not exist
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
      reviewedUserId: row.reviewed_user_id || undefined,
      applicationData: row.application_data ? JSON.parse(row.application_data as string) : undefined,
      evidence: evidenceRefs,
      invitationDelivery: { status: (row as any).invitation_delivery_status || 'unknown' },
    };

    return jsonSuccess(c, item, 'Application detail.');
  } catch (error) {
    console.error('Failed to get supplier onboarding application');
    return jsonError(c, 'ONBOARDING_DETAIL_FAILED', 'Could not load application.', 500);
  }
});

const rejectSchema = z.object({
  reason: z.string().trim().min(3).max(500).optional(),
});

/**
 * POST /:id/approve — Atomic CAS-guarded approval with D1 batch.
 *
 * 1. Generate candidate guide ID.
 * 2. Pre-check email existence (race window is acceptable; batch is the fence).
 * 3. D1 batch:
 *    a. CAS UPDATE application (WHERE status='pending' AND approved_user_id IS NULL).
 *    b. INSERT INTO users SELECT from application WHERE approved_user_id matches.
 *    c. INSERT INTO supplier_profiles SELECT from application.
 *    d. INSERT service drafts (inactive).
 *    e. INSERT availability schedule.
 *    f. (Optional) QA cohort enrollment if reviewer is active cohort admin.
 * 4. If CAS changed 0 rows → loser path: read actual winning state, insert nothing.
 * 5. Email after commit (KV success != provider accepted).
 */
adminSupplierOnboarding.post('/:id/approve', async (c) => {
  const id = c.req.param('id');
  const adminUserId = c.get('userId') as string | undefined;

  try {
    // Load application
    const app = await c.env.DB.prepare(`
      SELECT id, email, email_normalized, business_name, contact_name, phone, location, bio,
             status, approved_user_id, application_data, mode
      FROM supplier_onboarding_applications
      WHERE id = ?
    `).bind(id).first<{
      id: string;
      email: string;
      email_normalized: string | null;
      business_name: string;
      contact_name: string;
      phone: string;
      location: string;
      bio: string | null;
      status: string;
      approved_user_id: string | null;
      application_data: string | null;
      mode: string;
    }>();

    if (!app) {
      return jsonError(c, 'NOT_FOUND', 'Application not found', 404);
    }
    if (app.mode !== 'tirak') {
      return jsonError(c, 'CORE_MODE_REQUIRED', 'This endpoint only approves Core supplier onboarding applications.', 404);
    }
    if (app.status !== 'pending') {
      if (app.status === 'approved' && app.approved_user_id) {
        const approved = await loadApprovalState(c, id);
        if (approved && approved.status === 'approved' && approved.approved_user_id) {
          return jsonAlreadyReviewedWithState(c, approved);
        }
      }
      return jsonError(c, 'ALREADY_REVIEWED', 'Application has already been reviewed', 409);
    }

    // Existing-email collisions always require manual resolution.
    // Never reuse an existing user, including an existing supplier account.
    const emailToUse = app.email_normalized || normalizeEmail(app.email);
    const existingUser = await c.env.DB.prepare(
      `SELECT id, user_type FROM users WHERE LOWER(TRIM(email)) = ?`
    ).bind(emailToUse).first<{ id: string; user_type: string }>();

    if (existingUser) {
      return jsonError(c, 'IDENTITY_CONFLICT',
        'An account with this email already exists. Manual resolution required.', 409);
    }

    if (c.env.ENVIRONMENT === 'core-qa') {
      if (!adminUserId) {
        return jsonError(c, 'QA_ACCESS_DENIED', 'Approval requires an authenticated QA admin reviewer.', 403);
      }

      try {
        const qaReviewer = await c.env.DB.prepare(
          `SELECT reviewer.id
           FROM users reviewer
           JOIN core_qa_accounts qa
             ON qa.user_id = reviewer.id
            AND qa.role = 'admin'
            AND qa.revoked_at IS NULL
           WHERE reviewer.id = ?
             AND reviewer.user_type = 'admin'
             AND reviewer.status = 'active'`
        ).bind(adminUserId).first<{ id: string }>();

        if (!qaReviewer) {
          return jsonError(c, 'QA_ACCESS_DENIED', 'Approval requires an active QA admin reviewer.', 403);
        }
      } catch (dbErr) {
        const err = dbErr as Error;
        if (err.message?.includes('no such table')) {
          return jsonError(c, 'QA_UNAVAILABLE', 'QA cohort system is not available.', 503);
        }
        console.error('QA reviewer check failed');
        return jsonError(c, 'QA_CHECK_FAILED', 'Could not verify QA reviewer membership.', 500);
      }
    }

    const userId = crypto.randomUUID();
    const now = new Date().toISOString();
    const trialExpires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

    // Parse application data for profile/service/schedule
    let appData: Record<string, unknown> = {};
    try {
      const parsed = app.application_data ? JSON.parse(app.application_data) : null;
      const validated = validateApplicationData(parsed);
      if (!validated) {
        return jsonError(c, 'INVALID_APPLICATION_DATA', 'Structured application details are required before approval.', 400);
      }
      appData = validated as Record<string, unknown>;
    } catch (error) {
      if (error instanceof ApplicationDataValidationError) {
        return jsonError(c, 'INVALID_APPLICATION_DATA', error.message, 400);
      }
      return jsonError(c, 'INVALID_APPLICATION_DATA', 'Stored application details are malformed and require correction before approval.', 400);
    }
    const firstName = (appData.firstName as string) || app.contact_name?.split(' ')[0] || app.business_name;
    const lastName = (appData.lastName as string) || app.contact_name?.split(' ').slice(1).join(' ') || '';
    const profileBio = (appData.bio as string) || app.bio || null;
    const profileLocation = (appData.location as string) || app.location || null;
    const profileLanguages = appData.languages ? JSON.stringify(appData.languages) : null;
    const profileInterests = appData.interests ? JSON.stringify(appData.interests) : null;

    // Generate a reset token for invitation
    const resetToken = crypto.randomUUID();

    // Evidence prereqs: Core approval requires id_front, id_back, selfie (not portfolio)
    let requiredEvidence = new Set(['id_front', 'id_back', 'selfie']);
    try {
      const evRows = await c.env.DB.prepare(
        `SELECT kind FROM supplier_onboarding_evidence WHERE application_id = ?`
      ).bind(id).all<{ kind: string }>();
      for (const ev of (evRows.results ?? [])) {
        requiredEvidence.delete(ev.kind);
      }
    } catch {
      // Table may not exist — evidence prereqs cannot be verified
      return jsonError(c, 'EVIDENCE_UNAVAILABLE',
        'Cannot verify required evidence. Ensure migration 021+ is applied.', 500);
    }
    if (requiredEvidence.size > 0) {
      return jsonError(c, 'EVIDENCE_INCOMPLETE',
        `Missing required evidence: ${[...requiredEvidence].join(', ')}`, 400);
    }

    // Build D1 batch statements
    const statements: any[] = [];

    // Statement 1: CAS UPDATE — claim the pending application
    statements.push(
      c.env.DB.prepare(`
        UPDATE supplier_onboarding_applications
        SET status = 'approved', approved_user_id = ?, reviewed_user_id = ?, reviewed_at = ?,
            invitation_delivery_status = 'pending'
        WHERE id = ? AND status = 'pending' AND approved_user_id IS NULL
      `).bind(userId, adminUserId || null, now, id)
    );

    // Statement 2: INSERT user (conditional on CAS success via SELECT from application)
    statements.push(
      c.env.DB.prepare(`
        INSERT INTO users (id, email, phone, password_hash, user_type, status,
          email_verified, phone_verified, preferred_language, created_at, updated_at)
        SELECT ?, email, phone, '', 'supplier', 'pending',
          0, 0, 'en', ?, ?
        FROM supplier_onboarding_applications
        WHERE id = ? AND status = 'approved' AND approved_user_id = ? AND reviewed_user_id = ?
      `).bind(userId, now, now, id, userId, adminUserId || null)
    );

    // Statement 3: INSERT profile (conditional on CAS success)
    // Persist firstName, lastName, location, interests, bio, languages
    statements.push(
      c.env.DB.prepare(`
        INSERT INTO supplier_profiles (user_id, display_name, first_name, last_name, bio,
          profile_images, categories, regions, spoken_languages, interests, location,
          rating_average, rating_count,
          verification_status, subscription_status, subscription_tier,
          subscription_expires_at, created_at, updated_at)
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 'pending', 'active', 'basic', ?, ?, ?
        FROM supplier_onboarding_applications
        WHERE id = ? AND status = 'approved' AND approved_user_id = ?
      `).bind(
        userId,
        `${firstName} ${lastName}`.trim(),
        firstName,
        lastName,
        profileBio,
        null, // profile_images
        null, // categories
        profileLocation ? JSON.stringify([profileLocation]) : null, // regions
        profileLanguages,
        profileInterests,
        profileLocation,
        trialExpires,
        now, now,
        id, userId,
      )
    );

    // Statement 4: INSERT service drafts (inactive, conditional on CAS success)
    const serviceDrafts = (appData.serviceDrafts as Array<Record<string, unknown>>) || [];
    for (let i = 0; i < serviceDrafts.length; i++) {
      const draft = serviceDrafts[i] as Record<string, unknown> | undefined;
      if (!draft) continue;
      const serviceId = crypto.randomUUID();
      const price = typeof draft.price === 'number' ? draft.price : 0;
      const durationMinutes = typeof draft.durationMinutes === 'number' ? draft.durationMinutes : 60;
      statements.push(
        c.env.DB.prepare(`
          INSERT INTO supplier_services (id, supplier_id, title, description, price_min, price_max,
            currency, duration_hours, is_active, created_at, updated_at)
          SELECT ?, ?, ?, ?, ?, ?, 'THB', ?, 0, ?, ?
          FROM supplier_onboarding_applications
          WHERE id = ? AND status = 'approved' AND approved_user_id = ?
        `).bind(
          serviceId, userId,
          (draft.title as string) || `Service ${i + 1}`,
          (draft.description as string) || null,
          price, price,
          durationMinutes / 60,
          now, now,
          id, userId,
        )
      );
    }

    // Statement 5: INSERT availability schedule (conditional on CAS success)
    const schedule = appData.schedule as Record<string, unknown> | undefined;
    const days = (schedule?.days as Array<Record<string, unknown>>) || [];
    for (const day of days) {
      const availId = crypto.randomUUID();
      statements.push(
        c.env.DB.prepare(`
          INSERT INTO supplier_availability (id, supplier_id, day_of_week, start_time, end_time,
            is_available, created_at, updated_at)
          SELECT ?, ?, ?, ?, ?, ?, ?, ?
          FROM supplier_onboarding_applications
          WHERE id = ? AND status = 'approved' AND approved_user_id = ?
        `).bind(
          availId, userId,
          day.dayOfWeek,
          day.startTime || '09:00',
          day.endTime || '17:00',
          day.isAvailable !== false ? 1 : 0,
          now, now,
          id, userId,
        )
      );
    }

    // Statement 6: QA cohort enrollment (same batch, guarded by actual active admin membership)
    if (adminUserId) {
      statements.push(
        c.env.DB.prepare(`
          INSERT INTO core_qa_accounts (user_id, role, source_application_id, enrolled_by, enrolled_at)
          SELECT ?, 'guide', ?, ?, ?
          FROM supplier_onboarding_applications
          WHERE id = ? AND mode = 'tirak' AND status = 'approved' AND approved_user_id = ? AND reviewed_user_id = ?
            AND EXISTS (
              SELECT 1
              FROM users reviewer
              JOIN core_qa_accounts qa
                ON qa.user_id = reviewer.id
               AND qa.role = 'admin'
               AND qa.revoked_at IS NULL
              WHERE reviewer.id = ?
                AND reviewer.user_type = 'admin'
                AND reviewer.status = 'active'
            )
        `).bind(userId, id, adminUserId, now, id, userId, adminUserId, adminUserId)
      );
    }

    // Execute the batch atomically
    let batchResults: Array<{ success: boolean; meta?: { changes?: number } }>;
    try {
      batchResults = await c.env.DB.batch(statements) as Array<{ success: boolean; meta?: { changes?: number } }>;
    } catch (batchErr) {
      // Batch failed (UNIQUE constraint, FK violation, etc.) — all rolled back
      if (isUniqueConstraintError(batchErr)) {
        // Possible concurrent approval race — read actual state
        let winner = await loadApprovalState(c, id);
        if ((!winner || !winner.approved_user_id || winner.status !== 'approved')) {
          winner = await loadApprovalState(c, id);
        }

        if (winner?.status === 'approved' && winner.approved_user_id) {
          return jsonSuccess(c, {
            ...buildApprovedReplayPayload(winner),
            raceRecovery: true,
          }, 'Application was already approved by another reviewer.');
        }
      }
      console.error('Approval batch failed');
      return jsonError(c, 'APPROVE_FAILED', 'Could not approve application.', 500);
    }

    // Check if CAS succeeded (first statement should have changed 1 row)
    const casResult = batchResults[0];
    if (!casResult || casResult.meta?.changes === 0) {
      // CAS loser path: another admin already claimed this application.
      // Batch rolled back (or INSERTs matched 0 rows). Read actual winning state.
      const winner = await loadApprovalState(c, id);

      if (winner?.status === 'approved' && winner.approved_user_id) {
        return jsonResponse(c, {
          ...errorResponse('ALREADY_REVIEWED', 'Application has already been reviewed'),
          data: {
            ...buildApprovedReplayPayload(winner),
            raceRecovery: true,
          },
        }, 409);
      }

      return jsonError(c, 'ALREADY_REVIEWED', 'Application has already been reviewed', 409);
    }

    // CAS succeeded — batch committed. Now handle post-commit operations.
    // Store KV reset token (best effort)
    let invitationOutcome: 'pending' | 'failed' | 'unknown' = 'unknown';
    try {
      await c.env.CACHE.put(
        `reset:${resetToken}`,
        JSON.stringify({
          email: app.email,
          userId,
          purpose: 'supplier-onboarding',
          expiresAt: new Date(Date.now() + 86400_000).toISOString(),
        }),
        { expirationTtl: 86400 },
      );
      invitationOutcome = 'pending';
    } catch (kvError) {
      console.warn('KV reset token storage failed; applicant can use forgot-password recovery');
      invitationOutcome = 'failed';
    }

    // Build URLs for invitation email.
    // Browser reset URL: owns backend request origin /auth/new#token.
    // App deep link: tirak://auth/new?token.
    // Derive backend origin from HOST header (safe: CORS validates caller origins).
    const hostHeader = c.req.header('Host') || '';
    const proto = hostHeader.includes('localhost') || hostHeader.includes('127.0.0.1') ? 'http' : 'https';
    const backendOrigin = hostHeader ? `${proto}://${hostHeader}` : (c.env.FRONTEND_URLS?.split(',')[0]?.trim() || 'https://tirak.app');
    const browserResetUrl = `${backendOrigin}/auth/new#token=${encodeURIComponent(resetToken)}`;
    const appDeepLink = `tirak://auth/new?token=${encodeURIComponent(resetToken)}`;

    // Send email (only if KV token was stored successfully)
    let emailSent = false;
    if (invitationOutcome === 'pending') {
      try {
        const emailConfig = createEmailConfig(c.env);
        const subject = 'Your Tirak supplier account has been approved';
        const body = `Welcome to Tirak!\n\nYour application for ${app.business_name} has been approved.\n\nSet your permanent password using the link below (expires in 24 hours):\n${browserResetUrl}\n\nOr open in the app: ${appDeepLink}`;
        const html = renderBasicEmail(subject, body, { label: 'Set password in Tirak', url: appDeepLink })
          .replace('</main>', `<p>Or <a href="${browserResetUrl}">set your password securely in your browser</a>.</p></main>`);
        const delivery = await sendEmail(emailConfig, app.email, subject, html);
        recordEmailOutcome('supplier_invite', delivery, crypto.randomUUID());
        // sent != delivered; only provider acceptance is confirmed
        emailSent = delivery.status === 'sent';
        // Never claim accepted/delivered post-commit; keep the receipt truthful.
        invitationOutcome = delivery.status === 'sent' ? 'pending' : 'failed';
        // Update invitation delivery status (best effort)
        try {
          await c.env.DB.prepare(
            `UPDATE supplier_onboarding_applications SET invitation_delivery_status = ? WHERE id = ?`
          ).bind(invitationOutcome, id).run();
        } catch { /* non-fatal */ }
      } catch {
        console.warn('Failed to send supplier onboarding email; applicant can use forgot-password recovery');
        // Post-commit send failure is truthful
        invitationOutcome = 'failed';
        try {
          await c.env.DB.prepare(
            `UPDATE supplier_onboarding_applications SET invitation_delivery_status = 'failed' WHERE id = ?`
          ).bind(id).run();
        } catch { /* non-fatal */ }
      }
    } else {
      // KV failed — do NOT send invalid reset link
      invitationOutcome = 'failed';
      try {
        await c.env.DB.prepare(
          `UPDATE supplier_onboarding_applications SET invitation_delivery_status = 'failed' WHERE id = ?`
        ).bind(id).run();
      } catch { /* non-fatal */ }
    }

    // Create in-app notification (best effort)
    try {
      const notifId = crypto.randomUUID();
      const notificationMessage = emailSent
        ? 'Your supplier application has been approved. Check your email to set your password.'
        : 'Your supplier application has been approved. Use forgot-password to set your password.';
      await c.env.DB.prepare(`
        INSERT INTO notifications (id, user_id, type, title, message, data, read, created_at, updated_at)
        VALUES (?, ?, 'supplier_approved', 'Application Approved', ?, ?, 0, ?, ?)
      `).bind(notifId, userId, notificationMessage, JSON.stringify({ applicationId: id }), now, now).run();
    } catch {
      // Non-fatal
    }

    return jsonSuccess(c, {
      applicationId: id,
      userId,
      approvedUserId: userId,
      reviewedUserId: adminUserId || null,
      status: 'approved',
      email: app.email,
      emailSent,
      invitationDelivery: { status: invitationOutcome },
    }, 'Supplier approved.');
  } catch (error) {
    console.error('Approve supplier onboarding failed');
    return jsonError(c, 'APPROVE_FAILED', 'Could not approve application.', 500);
  }
});

// Reject — preserves reviewer, never writes admin into guide link
adminSupplierOnboarding.post('/:id/reject', zValidator('json', rejectSchema), async (c) => {
  const id = c.req.param('id');
  const { reason } = c.req.valid('json');
  const adminUserId = c.get('userId') as string | undefined;

  try {
    const app = await c.env.DB.prepare(`
      SELECT id, status, mode FROM supplier_onboarding_applications WHERE id = ?
    `).bind(id).first<{ id: string; status: string; mode: string }>();

    if (!app) {
      return jsonError(c, 'NOT_FOUND', 'Application not found', 404);
    }
    if (app.mode !== 'tirak') {
      return jsonError(c, 'CORE_MODE_REQUIRED', 'This endpoint only rejects Core supplier onboarding applications.', 404);
    }
    const now = new Date().toISOString();
    // reviewed_user_id captures admin; approved_user_id stays NULL (no guide link)
    const result = await c.env.DB.prepare(`
      UPDATE supplier_onboarding_applications
      SET status = 'rejected', reviewed_at = ?, rejection_reason = ?, reviewed_user_id = ?
      WHERE id = ? AND status = 'pending' AND approved_user_id IS NULL
    `).bind(now, reason || null, adminUserId || null, id).run();

    if ((result.meta?.changes ?? 0) === 0) {
      const winner = await loadApprovalState(c, id);
      if (winner) {
        return jsonAlreadyReviewedWithState(c, winner);
      }
      return jsonError(c, 'ALREADY_REVIEWED', 'Application has already been reviewed', 409);
    }

    return jsonSuccess(c, { applicationId: id }, 'Application rejected.');
  } catch (error) {
    console.error('Reject supplier onboarding failed');
    return jsonError(c, 'REJECT_FAILED', 'Could not reject application.', 500);
  }
});

export { adminSupplierOnboarding as adminSupplierOnboardingRoutes };
