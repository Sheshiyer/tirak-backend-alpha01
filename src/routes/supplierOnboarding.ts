import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { createRateLimit } from '../middleware/rateLimit';
import { jsonSuccess, jsonError } from '../utils/response';
import {
  normalizeEmail,
  computeIdempotencyKeyHash,
  computePayloadDigest,
  deriveStatusToken,
  generateStatusToken,
  hashStatusToken,
  validateApplicationData,
  ApplicationDataValidationError,
} from '../utils/supplier-onboarding';
import type { Env, Variables } from '../index';

const supplierOnboardingRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();
type SupplierOnboardingContext = Context<{ Bindings: Env; Variables: Variables }>;

type ExistingApplicationRow = {
  id: string;
  payload_digest: string | null;
  status_token_hash: string | null;
  status: string;
};

const onboardingSchema = z.object({
  businessName: z.string().trim().min(2).max(200),
  contactName: z.string().trim().min(2).max(200),
  email: z.string().trim().email().max(320),
  phone: z.string().trim().min(8).max(32),
  location: z.string().trim().min(2).max(200),
  bio: z.string().trim().max(500).optional(),
  brochureUrls: z.array(z.string().trim().url()).max(5).default([]),
  categories: z
    .array(
      z.object({
        name: z.string().trim().min(2).max(120),
        memberCount: z.number().int().min(1).max(100000),
      })
    )
    .min(1)
    .max(50),
  mode: z.enum(['tirak', 'tirakplus']).default('tirak'),
  applicationData: z.unknown().optional(),
});

supplierOnboardingRoutes.use('*', createRateLimit('general'));

function isUniqueConstraintError(error: unknown, column?: string): boolean {
  if (!(error instanceof Error)) return false;
  const code = String((error as { code?: unknown }).code || '');
  const message = error.message || '';

  if (code === 'SQLITE_CONSTRAINT_UNIQUE') {
    return !column || message.includes(column);
  }

  if (!message.includes('UNIQUE constraint failed')) {
    return false;
  }

  return !column || message.includes(column);
}

async function loadExistingApplicationByKey(
  c: SupplierOnboardingContext,
  keyHash: string,
): Promise<ExistingApplicationRow | null> {
  return c.env.DB.prepare(
    `SELECT id, payload_digest, status_token_hash, status
     FROM supplier_onboarding_applications
     WHERE idempotency_key_hash = ?`
  ).bind(keyHash).first<ExistingApplicationRow>();
}

async function buildReplayResponse(
  c: SupplierOnboardingContext,
  existing: ExistingApplicationRow,
  idempotencyKey: string,
  payloadDigest: string,
) {
  if (existing.payload_digest && existing.payload_digest !== payloadDigest) {
    return jsonError(c, 'IDEMPOTENCY_CONFLICT',
      'A different application was already submitted with this Idempotency-Key.', 409);
  }

  if (!existing.status_token_hash) {
    return jsonSuccess(c, {
      applicationId: existing.id,
      status: existing.status,
    }, 'Application received (replay).', 201);
  }

  let replayToken: string;
  try {
    replayToken = await deriveStatusToken(c.env.JWT_SECRET, existing.id, idempotencyKey);
  } catch {
    return jsonError(c, 'IDEMPOTENCY_RECOVERY_FAILED',
      'The existing application receipt cannot be safely recovered. Contact support.', 409);
  }

  const replayHash = await hashStatusToken(replayToken);
  if (replayHash !== existing.status_token_hash) {
    return jsonError(c, 'IDEMPOTENCY_RECOVERY_FAILED',
      'The existing application receipt cannot be safely recovered. Contact support.', 409);
  }

  return jsonSuccess(c, {
    applicationId: existing.id,
    statusToken: replayToken,
    status: existing.status,
  }, 'Application received (replay).', 201);
}

/**
 * POST / — Submit a Core supplier application.
 *
 * Core-only: mode is forced to 'tirak'. Plus behavior is preserved where
 * shared but never inspected or activated.
 *
 * Idempotency-Key header: UUID required for new clients.
 * Same key + same payload → replay same receipt (HMAC-derived status token).
 * Same key + conflicting payload → 409.
 * No Idempotency-Key → random token (legacy path).
 *
 * Key hash alone is the UNIQUE constraint; payload digest is stored separately
 * for conflict detection. DB failures on idempotency check are NOT swallowed.
 * Existing normalized email collision → 409 (no traveler conversion).
 */
supplierOnboardingRoutes.post('/', zValidator('json', onboardingSchema), async (c) => {
  const rawPayload = c.req.valid('json');

  // Force Core mode
  const payload = { ...rawPayload, mode: 'tirak' as const };

  // Normalize email
  const emailNormalized = normalizeEmail(payload.email);

  // Validate structured applicationData (optional, bounded, canonical)
  let applicationDataJson: string | null = null;
  try {
    const validated = validateApplicationData(payload.applicationData);
    if (validated) {
      applicationDataJson = JSON.stringify(validated);
    }
  } catch (err) {
    if (err instanceof ApplicationDataValidationError) {
      return jsonError(c, 'INVALID_APPLICATION_DATA', err.message, 400);
    }
    throw err;
  }

  // Build canonical payload for digest (canonical contract fields only)
  const canonicalPayload = {
    businessName: payload.businessName,
    contactName: payload.contactName,
    email: emailNormalized,
    phone: payload.phone,
    location: payload.location,
    bio: payload.bio ?? null,
    brochureUrls: payload.brochureUrls,
    categories: payload.categories,
    applicationData: applicationDataJson,
  };

  // Idempotency-Key processing
  const idempotencyKey = c.req.header('Idempotency-Key');
  let keyHash: string | null = null;
  let payloadDigest: string | null = null;

  if (idempotencyKey) {
    // Validate UUID format — required for new clients
    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRe.test(idempotencyKey)) {
      return jsonError(c, 'INVALID_IDEMPOTENCY_KEY', 'Idempotency-Key must be a UUID.', 400);
    }

    keyHash = await computeIdempotencyKeyHash(idempotencyKey);
    payloadDigest = await computePayloadDigest(canonicalPayload);

    // Check for existing application with this key hash.
    // DB errors are NOT swallowed — they propagate as 500.
    try {
      const existing = await c.env.DB.prepare(
        `SELECT id, payload_digest, status_token_hash
         FROM supplier_onboarding_applications
         WHERE idempotency_key_hash = ?`
      ).bind(keyHash).first<{
        id: string;
        payload_digest: string | null;
        status_token_hash: string | null;
      }>();

      if (existing) {
        return buildReplayResponse(c, {
          id: existing.id,
          payload_digest: existing.payload_digest,
          status_token_hash: existing.status_token_hash,
          status: (await c.env.DB.prepare(
            `SELECT status FROM supplier_onboarding_applications WHERE id = ?`
          ).bind(existing.id).first<{ status: string | null }>())?.status || 'pending',
        }, idempotencyKey, payloadDigest);
      }
    } catch (dbErr) {
      // DB error on idempotency check — do NOT swallow. Surface as 500.
      console.error('Idempotency check DB error');
      return jsonError(c, 'ONBOARDING_DB_ERROR', 'Could not verify application uniqueness.', 500);
    }
  }

  // Check for existing normalized email collision — 409, no traveler conversion
  try {
    const emailCollision = await c.env.DB.prepare(
      `SELECT id FROM supplier_onboarding_applications WHERE email_normalized = ?`
    ).bind(emailNormalized).first<{ id: string }>();

    if (emailCollision) {
      return jsonError(c, 'EMAIL_ALREADY_REGISTERED',
        'An application with this email already exists.', 409);
    }
  } catch {
    console.error('Email collision check DB error');
    return jsonError(c, 'ONBOARDING_DB_ERROR', 'Could not verify email uniqueness.', 500);
  }

  try {
    const applicationId = crypto.randomUUID();

    // Derive or generate status token
    let statusToken: string;
    if (idempotencyKey) {
      statusToken = await deriveStatusToken(c.env.JWT_SECRET, applicationId, idempotencyKey);
    } else {
      statusToken = generateStatusToken();
    }
    const statusTokenHash = await hashStatusToken(statusToken);

    const result = await c.env.DB.prepare(`
      INSERT INTO supplier_onboarding_applications (
        id, business_name, contact_name, email, email_normalized, phone, location, bio,
        brochure_urls, categories, mode, status,
        idempotency_key_hash, payload_digest, status_token_hash, application_data
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'tirak', 'pending', ?, ?, ?, ?
      WHERE NOT EXISTS (
        SELECT 1 FROM supplier_onboarding_applications WHERE email_normalized = ?
      )
    `)
      .bind(
        applicationId,
        payload.businessName,
        payload.contactName,
        payload.email,
        emailNormalized,
        payload.phone,
        payload.location,
        payload.bio ?? null,
        JSON.stringify(payload.brochureUrls),
        JSON.stringify(payload.categories),
        keyHash,
        payloadDigest,
        statusTokenHash,
        applicationDataJson,
        emailNormalized,
      )
      .run();

    if (!result.success) {
      return jsonError(c, 'ONBOARDING_INSERT_FAILED', 'Could not save the application.', 500);
    }

    if ((result.meta?.changes || 0) === 0) {
      if (keyHash && idempotencyKey && payloadDigest) {
        const existing = await loadExistingApplicationByKey(c, keyHash);
        if (existing) {
          return buildReplayResponse(c as never, existing, idempotencyKey, payloadDigest);
        }
      }

      const collision = await c.env.DB.prepare(
        `SELECT id FROM supplier_onboarding_applications WHERE email_normalized = ?`
      ).bind(emailNormalized).first<{ id: string }>();
      if (collision) {
        return jsonError(c, 'EMAIL_ALREADY_REGISTERED',
          'An application with this email already exists.', 409);
      }

      return jsonError(c, 'ONBOARDING_INSERT_FAILED', 'Could not save the application.', 500);
    }

    return jsonSuccess(c, {
      applicationId,
      statusToken,
      status: 'pending',
    }, 'Application received.', 201);
  } catch (error) {
    // UNIQUE constraint violation on idempotency_key_hash → race condition.
    // Another request inserted the same key between our SELECT and INSERT.
    if (isUniqueConstraintError(error, 'supplier_onboarding_applications.idempotency_key_hash')
      || isUniqueConstraintError(error, 'idempotency_key_hash')) {
      if (keyHash && idempotencyKey && payloadDigest) {
        try {
          const raced = await loadExistingApplicationByKey(c, keyHash);

          if (raced) {
            return buildReplayResponse(c as never, raced, idempotencyKey, payloadDigest);
          }
        } catch {
          return jsonError(c, 'ONBOARDING_DB_ERROR', 'Could not verify application uniqueness.', 500);
        }
      }
      return jsonError(c, 'IDEMPOTENCY_CONFLICT',
        'A different application was already submitted with this Idempotency-Key.', 409);
    }
    console.error('Supplier onboarding submission failed');
    return jsonError(c, 'ONBOARDING_SUBMISSION_FAILED', 'Submission failed.', 500);
  }
});

/**
 * GET /:id/status — Check application status by bearer status token.
 *
 * Requires Authorization: Bearer <statusToken>.
 * Constant uniform denial on missing/invalid token — no email lookup.
 * Returns blockers, evidence refs, and invitation delivery status.
 */
supplierOnboardingRoutes.get('/:id/status', async (c) => {
  const applicationId = c.req.param('id');
  const authHeader = c.req.header('Authorization');
  const bearerPrefix = 'Bearer ';

  // Constant uniform denial: extract token or use empty string
  let providedToken = '';
  if (authHeader?.startsWith(bearerPrefix)) {
    providedToken = authHeader.slice(bearerPrefix.length).trim();
  }

  if (!providedToken) {
    return jsonError(c, 'NOT_FOUND', 'Application not found.', 404);
  }

  const providedHash = await hashStatusToken(providedToken);

  try {
    const app = await c.env.DB.prepare(`
      SELECT id, status, status_token_hash, approved_user_id, created_at,
             reviewed_at, rejection_reason, application_data
      FROM supplier_onboarding_applications
      WHERE id = ?
    `).bind(applicationId).first<{
      id: string;
      status: string;
      status_token_hash: string | null;
      approved_user_id: string | null;
      created_at: string;
      reviewed_at: string | null;
      rejection_reason: string | null;
      application_data: string | null;
    }>();

    // Constant uniform denial: same response whether app missing or token wrong
    if (!app || !app.status_token_hash || app.status_token_hash !== providedHash) {
      return jsonError(c, 'NOT_FOUND', 'Application not found.', 404);
    }

    // Load evidence list (table may not exist yet)
    let evidenceList: Array<{ evidenceId: string; kind: string }> = [];
    try {
      const evidenceRows = await c.env.DB.prepare(
        `SELECT id, kind FROM supplier_onboarding_evidence WHERE application_id = ?`
      ).bind(applicationId).all<{ id: string; kind: string }>();
      evidenceList = (evidenceRows.results ?? []).map(r => ({
        evidenceId: r.id,
        kind: r.kind,
      }));
    } catch {
      // Table may not exist yet (migration 021 not applied)
    }

    // Build blockers based on actual joined state.
    // Query real account/profile/publication/trial states; reject missing tables/failure
    // instead of swallowed empty success.
    const blockers: Record<string, string> = {};
    let resolvedAccountStatus = 'unknown';
    let resolvedProfileStatus = 'none';
    let resolvedExpiresAt: string | null = null;
    let publicationStatus: 'awaiting_approval' | 'blocked' | 'draft' | 'active' = 'blocked';

    if (app.status === 'pending') {
      resolvedAccountStatus = 'not_provisioned';
      publicationStatus = 'awaiting_approval';
      blockers.account = 'application_pending';
      blockers.profile = 'application_pending';
    } else if (app.status === 'rejected') {
      publicationStatus = 'blocked';
      blockers.account = 'application_rejected';
    } else if (app.status === 'approved') {
      publicationStatus = 'blocked';

      if (!app.approved_user_id) {
        resolvedAccountStatus = 'not_provisioned';
        blockers.account = 'account_not_provisioned';
      } else {
        let accountReady = false;
        let profileReady = false;

        // Check actual account state — query real joined user status
        const user = await c.env.DB.prepare(
          `SELECT status FROM users WHERE id = ?`
        ).bind(app.approved_user_id).first<{ status: string }>();
        if (!user) {
          blockers.account = 'account_not_provisioned';
          resolvedAccountStatus = 'not_provisioned';
        } else {
          // Map actual user.status truthfully (no suspended→active, no rejected→verified)
          resolvedAccountStatus = user.status;
          if (user.status === 'active') {
            accountReady = true;
          } else if (user.status === 'suspended') {
            blockers.account = 'account_suspended';
          } else if (user.status === 'pending') {
            blockers.account = 'account_pending';
          } else {
            blockers.account = 'account_inactive';
          }
        }

        // Check profile verification — query actual verification_status
        const profile = await c.env.DB.prepare(
          `SELECT verification_status, subscription_expires_at FROM supplier_profiles WHERE user_id = ?`
        ).bind(app.approved_user_id).first<{ verification_status: string; subscription_expires_at: string | null }>();
        if (!profile) {
          blockers.profile = 'profile_not_provisioned';
          resolvedProfileStatus = 'none';
        } else {
          // Map actual verification_status truthfully (no rejected→verified)
          resolvedProfileStatus = profile.verification_status;
          if (profile.verification_status === 'verified') {
            profileReady = true;
          } else if (profile.verification_status === 'pending') {
            blockers.profile = 'profile_pending_verification';
          } else if (profile.verification_status === 'rejected') {
            blockers.profile = 'profile_rejected';
          } else {
            blockers.profile = 'profile_unverified';
          }
          // Read real trial/subscription expiry
          resolvedExpiresAt = profile.subscription_expires_at || null;
        }

        // Preserve the concrete service blocker even while activation/verification is pending.
        {
          try {
            const services = await c.env.DB.prepare(
              `SELECT COUNT(*) as cnt FROM supplier_services WHERE supplier_id = ? AND is_active = 1 AND archived_at IS NULL`
            ).bind(app.approved_user_id).first<{ cnt: number }>();
            if (!services || Number(services.cnt) === 0) {
              if (accountReady && profileReady) publicationStatus = 'draft';
              blockers.publication = 'no_active_services';
            } else if (accountReady && profileReady) {
              publicationStatus = 'active';
            }
          } catch {
            publicationStatus = 'blocked';
            blockers.publication = 'service_query_failed';
          }
        }
      }
    }

    // Determine invitation delivery status from actual stored value
    let invitationDelivery: { status: string } = { status: 'unknown' };
    try {
      const inv = await c.env.DB.prepare(
        `SELECT invitation_delivery_status FROM supplier_onboarding_applications WHERE id = ?`
      ).bind(applicationId).first<{ invitation_delivery_status: string | null }>();
      if (inv?.invitation_delivery_status) {
        invitationDelivery = { status: inv.invitation_delivery_status };
      }
    } catch (invErr) {
      // Column missing is a schema error — surface it as unknown, not silent success
      const errMsg = (invErr as Error)?.message || '';
      if (!errMsg.includes('no such column')) {
        // Unexpected DB error — fail the status check
        return jsonError(c, 'STATUS_CHECK_FAILED', 'Could not check invitation delivery status.', 500);
      }
    }

    return jsonSuccess(c, {
      applicationId: app.id,
      status: app.status,
      accountStatus: resolvedAccountStatus,
      profileStatus: resolvedProfileStatus,
      publicationStatus,
      blockers,
      evidence: evidenceList,
      expiresAt: resolvedExpiresAt,
      paymentStatus: 'unavailable',
      invitationDelivery,
    }, 'Application status.');
  } catch (error) {
    console.error('Failed to check application status');
    return jsonError(c, 'STATUS_CHECK_FAILED', 'Could not check application status.', 500);
  }
});

export { supplierOnboardingRoutes };
