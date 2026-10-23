import { Hono } from 'hono';
import { jsonSuccess, jsonError } from '../utils/response';
import { hashStatusToken } from '../utils/supplier-onboarding';
import type { Env, Variables } from '../index';

const evidenceRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

const VALID_KINDS = new Set(['id_front', 'id_back', 'selfie', 'portfolio']);
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const ALLOWED_MIME = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/heic',
  'application/pdf',
]);

/**
 * POST /supplier-onboarding/:id/evidence
 *
 * Multipart file upload with kind (id_front, id_back, selfie, portfolio).
 * Bearer statusToken authentication (same token as application intake).
 * Files stored in R2 with private prefix: private-core-onboarding/<app>/<opaque>
 * DB metadata for ownership. Duplicate kind is idempotent-safe.
 */
evidenceRoutes.post('/:id/evidence', async (c) => {
  const applicationId = c.req.param('id');

  // Authenticate via Bearer statusToken
  const authHeader = c.req.header('Authorization');
  let providedToken = '';
  if (authHeader?.startsWith('Bearer ')) {
    providedToken = authHeader.slice(7).trim();
  }
  if (!providedToken) {
    return jsonError(c, 'NOT_FOUND', 'Application not found.', 404);
  }

  const providedHash = await hashStatusToken(providedToken);

  // Verify application and token
  const app = await c.env.DB.prepare(
    `SELECT id, status, status_token_hash FROM supplier_onboarding_applications WHERE id = ?`
  ).bind(applicationId).first<{ id: string; status: string; status_token_hash: string | null }>();

  if (!app || !app.status_token_hash || app.status_token_hash !== providedHash) {
    return jsonError(c, 'NOT_FOUND', 'Application not found.', 404);
  }

  // Reject retired application upload
  if (app.status === 'rejected') {
    return jsonError(c, 'APPLICATION_REJECTED', 'Cannot upload evidence for a rejected application.', 400);
  }

  // Parse multipart form
  let formData: FormData;
  try {
    formData = await c.req.formData();
  } catch {
    return jsonError(c, 'INVALID_REQUEST', 'Expected multipart/form-data.', 400);
  }

  const kind = formData.get('kind') as string | null;
  const file = formData.get('file') as File | null;

  if (!kind || !VALID_KINDS.has(kind)) {
    return jsonError(c, 'INVALID_KIND', 'kind must be one of: id_front, id_back, selfie, portfolio.', 400);
  }
  if (!file || !(file instanceof File)) {
    return jsonError(c, 'NO_FILE', 'A file is required.', 400);
  }

  // Size validation
  if (file.size > MAX_FILE_SIZE) {
    return jsonError(c, 'FILE_TOO_LARGE', `Maximum file size is 10MB.`, 400);
  }
  if (file.size === 0) {
    return jsonError(c, 'EMPTY_FILE', 'File must not be empty.', 400);
  }

  // MIME validation
  const mimeType = file.type || 'application/octet-stream';
  if (!ALLOWED_MIME.has(mimeType)) {
    return jsonError(c, 'INVALID_MIME', `Allowed types: JPEG, PNG, WebP, HEIC, PDF.`, 400);
  }

  // Check for duplicate kind (idempotent-safe: return existing evidenceId)
  const existing = await c.env.DB.prepare(
    `SELECT id FROM supplier_onboarding_evidence WHERE application_id = ? AND kind = ?`
  ).bind(applicationId, kind).first<{ id: string }>();

  if (existing) {
    return jsonSuccess(c, {
      evidenceId: existing.id,
      kind,
    }, 'Evidence already submitted (idempotent).', 200);
  }

  // Generate opaque ID and R2 key
  const evidenceId = crypto.randomUUID();
  const r2Key = `private-core-onboarding/${applicationId}/${evidenceId}`;

  // Upload to R2 with private prefix
  try {
    const arrayBuffer = await file.arrayBuffer();
    await c.env.STORAGE.put(r2Key, arrayBuffer, {
      httpMetadata: {
        contentType: mimeType,
      },
      customMetadata: {
        applicationId,
        evidenceId,
        kind,
        originalName: file.name,
      },
    });
  } catch (r2Err) {
    // R2 failure — no false complete
    console.error('R2 upload failed for evidence');
    return jsonError(c, 'UPLOAD_FAILED', 'Could not store evidence file.', 500);
  }

  // Insert DB metadata — race-safe: UNIQUE(application_id, kind) may conflict
  try {
    await c.env.DB.prepare(
      `INSERT INTO supplier_onboarding_evidence (id, application_id, kind, r2_key, file_size, mime_type)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(evidenceId, applicationId, kind, r2Key, file.size, mimeType).run();
  } catch (dbErr) {
    const dbMsg = (dbErr as Error)?.message || '';
    if (dbMsg.includes('UNIQUE') || dbMsg.includes('unique')) {
      // Race condition: another request won this kind. Cleanup own R2 object, return existing.
      try { await c.env.STORAGE.delete(r2Key); } catch { /* best-effort cleanup own upload */ }
      const existingWinner = await c.env.DB.prepare(
        `SELECT id FROM supplier_onboarding_evidence WHERE application_id = ? AND kind = ?`
      ).bind(applicationId, kind).first<{ id: string }>();
      return jsonSuccess(c, {
        evidenceId: existingWinner?.id || evidenceId,
        kind,
      }, 'Evidence already submitted (race-resolved).', 200);
    }
    // Other DB failure — remove orphan R2 object best-effort
    try { await c.env.STORAGE.delete(r2Key); } catch { /* best-effort cleanup */ }
    console.error('DB metadata insert failed for evidence');
    return jsonError(c, 'METADATA_FAILED', 'Could not record evidence metadata.', 500);
  }

  return jsonSuccess(c, {
    evidenceId,
    kind,
  }, 'Evidence uploaded.', 201);
});

export { evidenceRoutes };
