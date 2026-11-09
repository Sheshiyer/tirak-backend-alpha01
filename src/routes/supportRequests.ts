import { Hono } from 'hono';
import { z } from 'zod';
import { jsonSuccess, jsonError } from '../utils/response';
import {
  computeIdempotencyKeyHash,
  computePayloadDigest,
  normalizeEmail,
} from '../utils/supplier-onboarding';
import { rateLimit } from '../middleware/rateLimit';
import type { Env, Variables } from '../index';
import { processSupportNotification } from '../background/supportNotifications';

/**
 * Public Core support intake (contact + privacy/deletion requests).
 *
 * POST only. There is intentionally no public GET / lookup by email or id.
 * A privacy_deletion request is recorded as intent only; this module never
 * deletes or modifies accounts. Raw bodies, emails, messages and idempotency
 * keys are never logged.
 */
const supportRequestRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

const MAX_BODY_BYTES = 16 * 1024;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// eslint-disable-next-line no-control-regex
const SINGLE_LINE_CONTROL_RE = /[\u0000-\u001F\u007F]/;
// Allows \n and \t in the message body only.
// eslint-disable-next-line no-control-regex
const MESSAGE_CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

const singleLine = (max: number) =>
  z.string().trim().min(1).max(max).refine((v) => !SINGLE_LINE_CONTROL_RE.test(v), {
    message: 'Control characters are not allowed.',
  });

const supportRequestSchema = z
  .object({
    kind: z.enum(['contact', 'privacy_deletion']),
    name: singleLine(120),
    email: z.string().trim().min(3).max(254).email(),
    subject: singleLine(150),
    message: z
      .string()
      .transform((v) => v.replace(/\r\n?/g, '\n').trim())
      .pipe(
        z.string().min(1).max(4000).refine((v) => !MESSAGE_CONTROL_RE.test(v), {
          message: 'Control characters are not allowed.',
        }),
      ),
    honeypot: z.string().max(200).optional(),
  })
  .strict();

const supportRequestLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 5,
  keyGenerator: (c) => {
    const ip =
      c.req.header('CF-Connecting-IP') ||
      c.req.header('X-Forwarded-For')?.split(',')[0]?.trim() ||
      c.req.header('X-Real-IP') ||
      'unknown';
    return `support-requests:ip:${ip}`;
  },
});

interface ExistingRow {
  id: string;
  payload_digest: string;
}

function received(c: Parameters<typeof jsonSuccess>[0], requestId: string, replay: boolean) {
  c.header('Cache-Control', 'no-store');
  if (replay) c.header('Idempotency-Replayed', 'true');
  return jsonSuccess(
    c,
    { requestId, status: 'received' as const },
    replay ? 'Support request already received.' : 'Support request received.',
    replay ? 200 : 201,
  );
}

function conflict(c: Parameters<typeof jsonError>[0]) {
  c.header('Cache-Control', 'no-store');
  return jsonError(
    c,
    'IDEMPOTENCY_CONFLICT',
    'A different support request was already submitted with this key.',
    409,
  );
}

function failure(c: Parameters<typeof jsonError>[0]) {
  c.header('Cache-Control', 'no-store');
  return jsonError(c, 'SUPPORT_REQUEST_FAILED', 'Could not record support request.', 500);
}

/**
 * POST /api/support-requests
 *
 * Requires `Idempotency-Key: <uuid>`. Same key + same normalized payload
 * returns the original requestId (200); same key + different payload is 409.
 * Success is returned only after the row is durably inserted.
 */
supportRequestRoutes.post('/', supportRequestLimiter, async (c) => {
  c.header('Cache-Control', 'no-store');

  const idempotencyKey = c.req.header('Idempotency-Key')?.trim();
  if (!idempotencyKey) {
    return jsonError(c, 'IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key header is required.', 400);
  }
  if (!UUID_RE.test(idempotencyKey)) {
    return jsonError(c, 'INVALID_IDEMPOTENCY_KEY', 'Idempotency-Key must be a UUID.', 400);
  }

  const declaredLength = Number(c.req.header('Content-Length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    return jsonError(c, 'PAYLOAD_TOO_LARGE', 'Request body is too large.', 413);
  }

  let rawBody: string;
  try {
    rawBody = await c.req.text();
  } catch {
    return jsonError(c, 'VALIDATION_ERROR', 'Request body could not be read.', 400);
  }
  if (new TextEncoder().encode(rawBody).length > MAX_BODY_BYTES) {
    return jsonError(c, 'PAYLOAD_TOO_LARGE', 'Request body is too large.', 413);
  }

  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    return jsonError(c, 'VALIDATION_ERROR', 'Request body must be valid JSON.', 400);
  }

  const parsed = supportRequestSchema.safeParse(json);
  if (!parsed.success) {
    // Report field names only; never echo submitted values.
    const fields = Array.from(
      new Set(parsed.error.issues.map((i) => (i.path.length ? i.path.join('.') : 'body'))),
    ).join(', ');
    return jsonError(c, 'VALIDATION_ERROR', `Invalid support request fields: ${fields}.`, 400);
  }

  const payload = parsed.data;
  if (payload.honeypot && payload.honeypot.trim().length > 0) {
    // Bot trap: never persist and never return a request reference.
    return jsonError(c, 'VALIDATION_ERROR', 'Invalid support request fields: honeypot.', 400);
  }

  const emailNormalized = normalizeEmail(payload.email);

  let keyHash: string;
  let payloadDigest: string;
  try {
    keyHash = await computeIdempotencyKeyHash(idempotencyKey.toLowerCase());
    payloadDigest = await computePayloadDigest({
      kind: payload.kind,
      name: payload.name,
      email: emailNormalized,
      subject: payload.subject,
      message: payload.message,
    });
  } catch {
    console.error('Support request hashing failed');
    return failure(c);
  }

  const lookup = () =>
    c.env.DB.prepare(
      `SELECT id, payload_digest FROM core_support_requests
       WHERE idempotency_key_hash = ? AND mode = 'tirak'`,
    )
      .bind(keyHash)
      .first<ExistingRow>();

  const respondToExisting = (existing: ExistingRow) =>
    existing.payload_digest === payloadDigest
      ? received(c, existing.id, true)
      : conflict(c);

  try {
    const existing = await lookup();
    if (existing) return respondToExisting(existing);
  } catch {
    console.error('Support request lookup failed');
    return failure(c);
  }

  const requestId = crypto.randomUUID();
  try {
    const insert = c.env.DB.prepare(
      `INSERT INTO core_support_requests
         (id, mode, kind, status, name, email_normalized, subject, message,
          idempotency_key_hash, payload_digest)
       VALUES (?, 'tirak', ?, 'received', ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        requestId,
        payload.kind,
        payload.name,
        emailNormalized,
        payload.subject,
        payload.message,
        keyHash,
        payloadDigest,
      )
      ;
    const outbox = c.env.DB.prepare("INSERT INTO core_support_notification_outbox(request_id) SELECT ? WHERE EXISTS (SELECT 1 FROM core_support_requests WHERE id=? AND mode='tirak')").bind(requestId, requestId);
    const result = await c.env.DB.batch([insert, outbox]);
    if (result.length !== 2 || result.some(row => !row.success || Number(row.meta?.changes) !== 1)) {
      console.error('Support request insert did not persist');
      return failure(c);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (/UNIQUE|idempotency_key_hash/i.test(message)) {
      // Concurrent duplicate won the race: resolve against the winner.
      try {
        const winner = await lookup();
        if (winner) return respondToExisting(winner);
      } catch {
        // fall through to generic failure
      }
    }
    console.error('Support request insert failed');
    return failure(c);
  }

  try { c.executionCtx.waitUntil(processSupportNotification(c.env, requestId)); } catch { /* Durable cron/manual retry remains available. */ }
  return received(c, requestId, false);
});

export { supportRequestRoutes };
