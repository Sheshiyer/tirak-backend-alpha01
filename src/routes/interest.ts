import { Hono } from 'hono';
import { attributionSchema, computeIntakeDigests, matchesIntakeDigest, type IntakeDigests } from '../utils/acquisition';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { jsonSuccess, jsonError } from '../utils/response';
import { normalizeEmail, computeIdempotencyKeyHash } from '../utils/supplier-onboarding';
import type { Env, Variables } from '../index';

const interestRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

interestRoutes.use('*', async (c, next) => { c.header('Cache-Control', 'no-store'); await next(); });

const interestSchema = z.object({
  email: z.string().trim().email().max(320),
  name: z.string().trim().min(1).max(200).optional(),
  source: z.string().trim().min(1).max(100).optional(),
  attribution: attributionSchema.optional(),
});

/**
 * POST /api/interest — Persist a waitlist interest entry.
 *
 * Separate from applications. No account, guide, or email is created.
 * Returns interestId in canonical envelope: { success: true, data: { interestId } }.
 * Idempotent: same key + same payload → same interestId.
 * Same key + different payload → 409.
 */
interestRoutes.post('/', zValidator('json', interestSchema), async (c) => {
  const payload = c.req.valid('json');
  const emailNormalized = normalizeEmail(payload.email);

  // Idempotency-Key processing (optional for interest)
  const idempotencyKey = c.req.header('Idempotency-Key');
  let keyHash: string | null = null;
  let digests: IntakeDigests | null = null;

  if (idempotencyKey) {
    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRe.test(idempotencyKey)) {
      return jsonError(c, 'INVALID_IDEMPOTENCY_KEY', 'Idempotency-Key must be a UUID.', 400);
    }

    keyHash = await computeIdempotencyKeyHash(idempotencyKey);
    digests = await computeIntakeDigests({
      email: emailNormalized,
      name: payload.name ?? null,
      source: payload.source ?? null,
    }, payload.attribution);

    // Check for existing entry
    try {
      const existing = await c.env.DB.prepare(
        `SELECT id, payload_digest FROM interest_entries WHERE idempotency_key_hash = ?`
      ).bind(keyHash).first<{ id: string; payload_digest: string | null }>();

      if (existing) {
        if (!matchesIntakeDigest(existing.payload_digest, digests)) {
          return jsonError(c, 'IDEMPOTENCY_CONFLICT',
            'A different interest entry was already submitted with this key.', 409);
        }
        return jsonSuccess(c, { interestId: existing.id }, 'Interest recorded (replay).', 201);
      }
    } catch {
      // DB error → fall through to insert
    }
  }

  try {
    const interestId = crypto.randomUUID();

    const inserted = await c.env.DB.prepare(
      `INSERT INTO interest_entries (id, email_normalized, name, source, idempotency_key_hash, payload_digest)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(interestId, emailNormalized, payload.name ?? null, payload.source ?? null, keyHash, digests?.core ?? null).run();

    if (!inserted.success || Number(inserted.meta?.changes) !== 1) {
      return jsonError(c, 'INTEREST_FAILED', 'Could not confirm recorded interest.', 500);
    }
    return jsonSuccess(c, { interestId }, 'Interest recorded.', 201);
  } catch (error) {
    if (error instanceof Error && error.message?.includes('idempotency_key_hash')) {
      if (keyHash && digests) {
        try {
          const winner = await c.env.DB.prepare(
            'SELECT id, payload_digest FROM interest_entries WHERE idempotency_key_hash = ?'
          ).bind(keyHash).first<{ id: string; payload_digest: string | null }>();
          if (winner && matchesIntakeDigest(winner.payload_digest, digests)) {
            return jsonSuccess(c, { interestId: winner.id }, 'Interest recorded (replay).', 201);
          }
          if (!winner) return jsonError(c, 'INTEREST_FAILED', 'Could not confirm recorded interest.', 500);
        } catch {
          return jsonError(c, 'INTEREST_FAILED', 'Could not confirm recorded interest.', 500);
        }
      }
      return jsonError(c, 'IDEMPOTENCY_CONFLICT',
        'A different interest entry was already submitted with this key.', 409);
    }
    console.error('Interest submission failed');
    return jsonError(c, 'INTEREST_FAILED', 'Could not record interest.', 500);
  }
});

export { interestRoutes };
