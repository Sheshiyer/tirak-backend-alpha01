import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { validateUUID, validatePagination } from '../middleware/validation';
import { authMiddleware } from '../middleware/auth';
import { createRateLimit } from '../middleware/rateLimit';
import { jsonSuccess, jsonError, jsonPaginated, createPagination } from '../utils/response';
import {
  createPromptPayCharge,
  OmiseRequestError,
  paymentStatusFromCharge,
  qrCodeFromCharge,
  retrieveOmiseCharge,
  verifyOmiseWebhookSignature,
  webhookReplayKey,
  type OmiseCharge,
  type PaymentAttemptStatus,
} from '../services/omise';
import type { Env, Variables } from '../index';

const payments = new Hono<{ Bindings: Env; Variables: Variables }>();

// Payment method creation schema
const createPaymentMethodSchema = z.object({
  type: z.literal('promptpay', {
    errorMap: () => ({ message: 'Only PromptPay payment methods are accepted' })
  }),
  details: z.object({
    phoneNumber: z.string().min(9).max(20)
  }).strict(),
  isDefault: z.boolean().optional().default(false)
}).strict();

const promptPayBookingSchema = z.object({
  bookingId: z.string().uuid('Invalid booking ID'),
  method: z.literal('promptpay', {
    errorMap: () => ({ message: 'Only PromptPay charges are accepted' }),
  }),
}).strict();

const recoverPromptPayChargeSchema = z.object({
  bookingId: z.string().uuid('Invalid booking ID'),
  chargeId: z.string().min(1).max(128).regex(/^chrg_[A-Za-z0-9_-]+$/, 'Invalid charge ID'),
}).strict();

interface BookingPaymentRow {
  id: string;
  customer_id: string;
  status: string;
  total_amount: number;
  currency: string | null;
  payment_status?: string;
}

interface PaymentAttemptRow {
  id: string;
  booking_id: string;
  customer_id: string;
  provider_charge_id: string | null;
  idempotency_key: string;
  attempt_number: number;
  amount: number;
  currency: string;
  status: PaymentAttemptStatus;
  qr_code_url: string | null;
  expires_at?: string | null;
  indeterminate_at?: string | null;
  last_error_at?: string | null;
  last_error_code?: string | null;
  recovered_at?: string | null;
  created_at?: string;
  updated_at?: string;
}

const FINAL_ATTEMPT_STATUSES = new Set<PaymentAttemptStatus>(['successful', 'failed', 'expired']);

function safeAttemptResponse(attempt: PaymentAttemptRow) {
  return {
    chargeId: attempt.provider_charge_id,
    qrCode: attempt.qr_code_url,
    amount: attempt.amount,
    currency: attempt.currency.toUpperCase(),
    status: attempt.status,
    ...(attempt.expires_at ? { expiresAt: attempt.expires_at } : {}),
  };
}

function toSatang(amount: unknown): number | null {
  const thb = Number(amount);
  if (!Number.isFinite(thb) || thb <= 0) return null;
  const unrounded = thb * 100;
  const satang = Math.round(unrounded);
  if (!Number.isSafeInteger(satang) || Math.abs(unrounded - satang) > 1e-7) return null;
  return satang;
}

async function ownedBooking(db: D1Database, bookingId: string, customerId: string): Promise<BookingPaymentRow | null> {
  return db.prepare(`
    SELECT id, customer_id, status, total_amount, currency, payment_status
    FROM bookings
    WHERE id = ? AND customer_id = ?
    LIMIT 1
  `).bind(bookingId, customerId).first<BookingPaymentRow>();
}

async function latestAttempt(db: D1Database, bookingId: string, customerId: string): Promise<PaymentAttemptRow | null> {
  return db.prepare(`
    SELECT id, booking_id, customer_id, provider_charge_id, idempotency_key,
           attempt_number, amount, currency, status, qr_code_url, expires_at,
           indeterminate_at, last_error_at, last_error_code, recovered_at,
           created_at, updated_at
    FROM payment_attempts
    WHERE booking_id = ? AND customer_id = ? AND provider = 'omise' AND payment_method = 'promptpay'
    ORDER BY attempt_number DESC
    LIMIT 1
  `).bind(bookingId, customerId).first<PaymentAttemptRow>();
}

async function ownedAttemptByCharge(
  db: D1Database,
  chargeId: string,
  customerId: string,
): Promise<PaymentAttemptRow | null> {
  return db.prepare(`
    SELECT pa.id, pa.booking_id, pa.customer_id, pa.provider_charge_id, pa.idempotency_key,
           pa.attempt_number, pa.amount, pa.currency, pa.status, pa.qr_code_url,
           pa.expires_at, pa.indeterminate_at, pa.last_error_at, pa.last_error_code,
           pa.recovered_at, pa.created_at, pa.updated_at
    FROM payment_attempts pa
    INNER JOIN bookings b ON b.id = pa.booking_id
    WHERE pa.provider = 'omise'
      AND pa.payment_method = 'promptpay'
      AND pa.provider_charge_id = ?
      AND b.customer_id = ?
      AND pa.customer_id = b.customer_id
    LIMIT 1
  `).bind(chargeId, customerId).first<PaymentAttemptRow>();
}

async function reconcileAttempt(
  db: D1Database,
  attempt: PaymentAttemptRow,
  charge: OmiseCharge,
): Promise<PaymentAttemptRow> {
  if (
    !attempt.provider_charge_id
    || charge.id !== attempt.provider_charge_id
    || charge.amount !== attempt.amount
    || charge.currency?.toUpperCase() !== attempt.currency.toUpperCase()
  ) {
    throw new OmiseRequestError('Omise charge no longer matches the payment attempt', 502);
  }
  if (FINAL_ATTEMPT_STATUSES.has(attempt.status)) return attempt;

  const status = paymentStatusFromCharge(charge);
  const qrCode = qrCodeFromCharge(charge) || attempt.qr_code_url;
  const now = new Date().toISOString();
  await db.prepare(`
    UPDATE payment_attempts
    SET status = ?, qr_code_url = ?, expires_at = ?, last_checked_at = ?,
        recovered_at = CASE WHEN status = 'indeterminate' THEN ? ELSE recovered_at END,
        last_error_code = CASE WHEN status = 'indeterminate' THEN NULL ELSE last_error_code END,
        updated_at = ?
    WHERE id = ? AND status NOT IN ('successful', 'failed', 'expired')
  `).bind(status, qrCode, charge.expires_at || attempt.expires_at || null, now, now, now, attempt.id).run();

  if (status === 'successful') {
    await db.prepare(`
      UPDATE bookings
      SET payment_status = 'completed', updated_at = ?
      WHERE id = ? AND customer_id = ? AND payment_status != 'completed'
    `).bind(now, attempt.booking_id, attempt.customer_id).run();
  } else if (status === 'failed' || status === 'expired') {
    await db.prepare(`
      UPDATE bookings
      SET payment_status = 'failed', updated_at = ?
      WHERE id = ? AND customer_id = ? AND payment_status != 'completed'
    `).bind(now, attempt.booking_id, attempt.customer_id).run();
  }

  return {
    ...attempt,
    status,
    qr_code_url: qrCode,
    expires_at: charge.expires_at || attempt.expires_at || null,
    recovered_at: attempt.status === 'indeterminate' ? now : attempt.recovered_at,
    last_error_code: attempt.status === 'indeterminate' ? null : attempt.last_error_code,
    updated_at: now,
  };
}

function omiseFailure(c: Parameters<typeof jsonError>[0], error: unknown): Response {
  if (error instanceof OmiseRequestError) {
    return jsonError(c, 'Payment provider unavailable', error.message, error.status);
  }
  console.error('Omise payment error:', error);
  return jsonError(c, 'Payment provider unavailable', 'Unable to process the payment safely', 502);
}

/**
 * Omise webhook. This route is intentionally registered before authentication.
 */
payments.post('/webhooks/omise', async (c) => {
  const webhookSecret = c.env.OMISE_WEBHOOK_SECRET;
  const secretKey = c.env.OMISE_SECRET_KEY;
  if (!webhookSecret || !secretKey) {
    return jsonError(c, 'Payment service unavailable', 'Omise webhook configuration is missing', 503);
  }

  const signature = c.req.header('Omise-Signature');
  const timestamp = c.req.header('Omise-Signature-Timestamp');
  if (!signature || !timestamp) {
    return jsonError(c, 'Invalid webhook', 'Missing Omise signature headers', 401);
  }

  const rawBody = await c.req.text();
  const signatureValid = await verifyOmiseWebhookSignature({
    rawBody,
    timestamp,
    signature,
    webhookSecret,
  });
  if (!signatureValid) {
    return jsonError(c, 'Invalid webhook', 'Signature is invalid or stale', 401);
  }

  let event: { id?: unknown; data?: { id?: unknown } };
  try {
    event = JSON.parse(rawBody) as typeof event;
  } catch {
    return jsonError(c, 'Invalid webhook', 'Webhook body is not valid JSON', 400);
  }
  const chargeId = typeof event.data?.id === 'string' ? event.data.id : null;
  if (!chargeId) {
    return jsonError(c, 'Invalid webhook', 'Webhook does not identify a charge', 400);
  }

  const replayKey = await webhookReplayKey(timestamp, rawBody);
  let eventReplayKey = replayKey;
  const receivedAt = new Date().toISOString();
  const providerEventId = typeof event.id === 'string' ? event.id : null;
  const insert = await c.env.DB.prepare(`
    INSERT OR IGNORE INTO payment_webhook_events (
      replay_key, provider_event_id, provider_charge_id, signature_timestamp, received_at, status
    ) VALUES (?, ?, ?, ?, ?, 'received')
  `).bind(
    replayKey,
    providerEventId,
    chargeId,
    Number(timestamp),
    receivedAt,
  ).run();
  if (Number(insert.meta?.changes || 0) === 0) {
    const existing = await c.env.DB.prepare(`
      SELECT replay_key, status
      FROM payment_webhook_events
      WHERE replay_key = ? OR provider_event_id = ?
      LIMIT 1
    `).bind(replayKey, providerEventId).first<{ replay_key: string; status: string }>();
    if (!existing || existing.status !== 'failed') {
      return jsonSuccess(c, { received: true, duplicate: true });
    }

    const reclaimed = await c.env.DB.prepare(`
      UPDATE payment_webhook_events
      SET status = 'received', received_at = ?, processed_at = NULL
      WHERE replay_key = ? AND status = 'failed'
    `).bind(receivedAt, existing.replay_key).run();
    if (Number(reclaimed.meta?.changes || 0) === 0) {
      return jsonSuccess(c, { received: true, duplicate: true });
    }
    eventReplayKey = existing.replay_key;
  }

  const attempt = await c.env.DB.prepare(`
    SELECT id, booking_id, customer_id, provider_charge_id, idempotency_key,
           attempt_number, amount, currency, status, qr_code_url, expires_at,
           created_at, updated_at
    FROM payment_attempts
    WHERE provider = 'omise' AND provider_charge_id = ?
    LIMIT 1
  `).bind(chargeId).first<PaymentAttemptRow>();

  if (!attempt) {
    await c.env.DB.prepare(`
      UPDATE payment_webhook_events SET status = 'ignored', processed_at = ? WHERE replay_key = ?
    `).bind(receivedAt, eventReplayKey).run();
    return jsonSuccess(c, { received: true });
  }

  try {
    const charge = await retrieveOmiseCharge(secretKey, chargeId);
    await reconcileAttempt(c.env.DB, attempt, charge);
    await c.env.DB.prepare(`
      UPDATE payment_webhook_events SET status = 'processed', processed_at = ? WHERE replay_key = ?
    `).bind(new Date().toISOString(), eventReplayKey).run();
    return jsonSuccess(c, { received: true });
  } catch (error) {
    await c.env.DB.prepare(`
      UPDATE payment_webhook_events SET status = 'failed', processed_at = ? WHERE replay_key = ?
    `).bind(new Date().toISOString(), eventReplayKey).run();
    return omiseFailure(c, error);
  }
});

// Every non-webhook payment route requires authentication and rate limiting.
payments.use('*', authMiddleware);
payments.use('*', createRateLimit('payment'));

/**
 * Create an Omise PromptPay charge for an owned, confirmed booking.
 */
payments.post('/charges', zValidator('json', promptPayBookingSchema), async (c) => {
  const secretKey = c.env.OMISE_SECRET_KEY;
  if (!secretKey) {
    return jsonError(c, 'Payment service unavailable', 'Omise configuration is missing', 503);
  }

  const customerId = c.get('userId');
  if (!customerId) {
    return jsonError(c, 'Authentication required', 'Please log in', 401);
  }
  const { bookingId } = c.req.valid('json');
  const booking = await ownedBooking(c.env.DB, bookingId, customerId);
  if (!booking) {
    return jsonError(c, 'Booking not found', 'The booking does not exist', 404);
  }
  if (booking.status !== 'confirmed') {
    return jsonError(c, 'Booking is not payable', 'Only confirmed bookings can be paid', 409);
  }
  if (['completed', 'paid', 'refunded'].includes(String(booking.payment_status || '').toLowerCase())) {
    return jsonError(c, 'Booking is not payable', 'This booking has already been paid', 409);
  }
  if (booking.currency?.toUpperCase() !== 'THB') {
    return jsonError(c, 'Booking is not payable', 'PromptPay bookings must use THB', 409);
  }

  const amount = toSatang(booking.total_amount);
  if (amount === null) {
    return jsonError(c, 'Booking is not payable', 'Booking amount is invalid', 409);
  }

  const currentAttempt = await latestAttempt(c.env.DB, bookingId, customerId);
  if (
    currentAttempt?.provider_charge_id
    && (currentAttempt.status === 'pending' || currentAttempt.status === 'successful')
  ) {
    return jsonSuccess(c, safeAttemptResponse(currentAttempt));
  }
  if (currentAttempt?.status === 'creating') {
    return jsonError(c, 'Payment creation in progress', 'Retry after the current booking payment attempt completes', 409);
  }
  if (currentAttempt?.status === 'indeterminate') {
    return jsonError(
      c,
      'Payment outcome requires recovery',
      'Do not create another charge; reconcile the existing Omise outcome first',
      409,
    );
  }

  let attempt: PaymentAttemptRow;
  const count = await c.env.DB.prepare(`
    SELECT COALESCE(MAX(attempt_number), 0) AS retry_count
    FROM payment_attempts
    WHERE booking_id = ?
  `).bind(bookingId).first<{ retry_count: number }>();
  const attemptNumber = Number(count?.retry_count || 0) + 1;
  const attemptId = crypto.randomUUID();
  const idempotencyKey = `tirak:promptpay:booking:${bookingId}:${attemptNumber}`;
  const now = new Date().toISOString();
  attempt = {
    id: attemptId,
    booking_id: bookingId,
    customer_id: customerId,
    provider_charge_id: null,
    idempotency_key: idempotencyKey,
    attempt_number: attemptNumber,
    amount,
    currency: 'THB',
    status: 'creating',
    qr_code_url: null,
    expires_at: null,
    created_at: now,
    updated_at: now,
  };
  const inserted = await c.env.DB.prepare(`
    INSERT OR IGNORE INTO payment_attempts (
      id, booking_id, customer_id, provider, payment_method, idempotency_key,
      attempt_number, amount, currency, status, created_at, updated_at
    ) VALUES (?, ?, ?, 'omise', 'promptpay', ?, ?, ?, 'THB', 'creating', ?, ?)
  `).bind(
    attemptId,
    bookingId,
    customerId,
    idempotencyKey,
    attemptNumber,
    amount,
    now,
    now,
  ).run();
  if (Number(inserted.meta?.changes || 0) === 0) {
    const racedAttempt = await latestAttempt(c.env.DB, bookingId, customerId);
    if (racedAttempt?.provider_charge_id) {
      return jsonSuccess(c, safeAttemptResponse(racedAttempt));
    }
    return jsonError(c, 'Payment creation in progress', 'Retry after the current booking payment attempt completes', 409);
  }

  try {
    const created = await createPromptPayCharge({
      secretKey,
      bookingId,
      amount,
      currency: 'THB',
      attemptNumber,
    });
    const status = paymentStatusFromCharge(created.charge);
    const now = new Date().toISOString();
    attempt = {
      ...attempt,
      provider_charge_id: created.charge.id,
      idempotency_key: created.idempotencyKey,
      status,
      qr_code_url: created.qrCode,
      expires_at: created.charge.expires_at || null,
      updated_at: now,
    };
    await c.env.DB.prepare(`
      UPDATE payment_attempts
      SET provider_charge_id = ?, idempotency_key = ?, status = ?, qr_code_url = ?,
          expires_at = ?, last_checked_at = ?, updated_at = ?
      WHERE id = ? AND status = 'creating'
    `).bind(
      attempt.provider_charge_id,
      attempt.idempotency_key,
      attempt.status,
      attempt.qr_code_url,
      attempt.expires_at,
      now,
      now,
      attempt.id,
    ).run();

    if (status === 'successful') {
      await c.env.DB.prepare(`
        UPDATE bookings SET payment_status = 'completed', updated_at = ?
        WHERE id = ? AND customer_id = ? AND payment_status != 'completed'
      `).bind(now, bookingId, customerId).run();
    } else if (status === 'failed' || status === 'expired') {
      await c.env.DB.prepare(`
        UPDATE bookings SET payment_status = 'failed', updated_at = ?
        WHERE id = ? AND customer_id = ? AND payment_status != 'completed'
      `).bind(now, bookingId, customerId).run();
    } else {
      await c.env.DB.prepare(`
        UPDATE bookings SET payment_status = 'processing', updated_at = ?
        WHERE id = ? AND customer_id = ? AND payment_status != 'completed'
      `).bind(now, bookingId, customerId).run();
    }

    return jsonSuccess(c, safeAttemptResponse(attempt), 'PromptPay charge created', 201);
  } catch (error) {
    const errorAt = new Date().toISOString();
    const indeterminate = !(error instanceof OmiseRequestError) || error.indeterminate;
    const errorCode = error instanceof OmiseRequestError ? error.code : 'unexpected_provider_error';
    const nextStatus: PaymentAttemptStatus = indeterminate ? 'indeterminate' : 'failed';
    await c.env.DB.prepare(`
      UPDATE payment_attempts
      SET status = ?, indeterminate_at = CASE WHEN ? = 'indeterminate' THEN ? ELSE indeterminate_at END,
          last_error_at = ?, last_error_code = ?, updated_at = ?
      WHERE id = ? AND status = 'creating'
    `).bind(nextStatus, nextStatus, errorAt, errorAt, errorCode, errorAt, attempt.id).run();

    await c.env.DB.prepare(`
      UPDATE bookings SET payment_status = ?, updated_at = ?
      WHERE id = ? AND customer_id = ? AND payment_status != 'completed'
    `).bind(indeterminate ? 'processing' : 'failed', errorAt, bookingId, customerId).run();

    if (indeterminate) {
      return jsonError(
        c,
        'Payment outcome indeterminate',
        'Do not create another charge; use POST /api/payments/charges/recover with the Omise charge ID',
        502,
      );
    }
    return omiseFailure(c, error);
  }
});

/**
 * Bind an operator-discovered Omise charge to an ambiguous booking attempt.
 * This endpoint never creates a provider charge.
 */
payments.post('/charges/recover', zValidator('json', recoverPromptPayChargeSchema), async (c) => {
  const secretKey = c.env.OMISE_SECRET_KEY;
  if (!secretKey) {
    return jsonError(c, 'Payment service unavailable', 'Omise configuration is missing', 503);
  }

  const customerId = c.get('userId');
  if (!customerId) {
    return jsonError(c, 'Authentication required', 'Please log in', 401);
  }
  const { bookingId, chargeId } = c.req.valid('json');
  const booking = await ownedBooking(c.env.DB, bookingId, customerId);
  if (!booking) {
    return jsonError(c, 'Booking not found', 'The booking does not exist', 404);
  }
  const amount = toSatang(booking.total_amount);
  if (amount === null || booking.currency?.toUpperCase() !== 'THB') {
    return jsonError(c, 'Booking is not recoverable', 'Booking amount or currency is invalid', 409);
  }

  const attempt = await latestAttempt(c.env.DB, bookingId, customerId);
  if (!attempt || attempt.status !== 'indeterminate') {
    return jsonError(c, 'Payment is not recoverable', 'No indeterminate payment attempt exists', 409);
  }
  if (attempt.provider_charge_id && attempt.provider_charge_id !== chargeId) {
    return jsonError(c, 'Payment recovery conflict', 'This attempt is already bound to another charge', 409);
  }

  try {
    const charge = await retrieveOmiseCharge(secretKey, chargeId);
    if (
      charge.amount !== amount
      || charge.amount !== attempt.amount
      || charge.currency?.toUpperCase() !== 'THB'
      || charge.currency?.toUpperCase() !== attempt.currency.toUpperCase()
      || charge.metadata?.booking_id !== bookingId
      || charge.source?.type !== 'promptpay'
    ) {
      return jsonError(c, 'Invalid recovery charge', 'Omise charge does not belong to this booking', 409);
    }

    const recoveredAt = new Date().toISOString();
    const claimed = await c.env.DB.prepare(`
      UPDATE payment_attempts
      SET provider_charge_id = ?, last_checked_at = ?, updated_at = ?
      WHERE id = ? AND status = 'indeterminate'
        AND (provider_charge_id IS NULL OR provider_charge_id = ?)
    `).bind(chargeId, recoveredAt, recoveredAt, attempt.id, chargeId).run();

    let boundAttempt: PaymentAttemptRow = { ...attempt, provider_charge_id: chargeId, updated_at: recoveredAt };
    if (Number(claimed.meta?.changes || 0) === 0) {
      const racedAttempt = await latestAttempt(c.env.DB, bookingId, customerId);
      if (!racedAttempt || racedAttempt.provider_charge_id !== chargeId) {
        return jsonError(c, 'Payment recovery conflict', 'Another recovery already claimed this attempt', 409);
      }
      boundAttempt = racedAttempt;
    }

    const reconciled = await reconcileAttempt(c.env.DB, boundAttempt, charge);
    return jsonSuccess(c, safeAttemptResponse(reconciled), 'Payment attempt recovered');
  } catch (error) {
    return omiseFailure(c, error);
  }
});

/**
 * Retrieve Omise directly, then reconcile a booking owner's latest attempt.
 */
payments.get('/charges/:chargeId', async (c) => {
  const secretKey = c.env.OMISE_SECRET_KEY;
  if (!secretKey) {
    return jsonError(c, 'Payment service unavailable', 'Omise configuration is missing', 503);
  }

  const chargeIdResult = z.string().min(1).max(128).regex(/^chrg_[A-Za-z0-9_-]+$/).safeParse(c.req.param('chargeId'));
  if (!chargeIdResult.success) {
    return jsonError(c, 'Invalid charge ID', 'Charge ID is invalid', 400);
  }
  const chargeId = chargeIdResult.data;
  const customerId = c.get('userId');
  if (!customerId) {
    return jsonError(c, 'Authentication required', 'Please log in', 401);
  }
  const attempt = await ownedAttemptByCharge(c.env.DB, chargeId, customerId);
  if (!attempt?.provider_charge_id) {
    return jsonError(c, 'Payment attempt not found', 'No PromptPay charge exists for this booking', 404);
  }

  try {
    const charge = await retrieveOmiseCharge(secretKey, attempt.provider_charge_id);
    const reconciled = await reconcileAttempt(c.env.DB, attempt, charge);
    return jsonSuccess(c, safeAttemptResponse(reconciled));
  } catch (error) {
    return omiseFailure(c, error);
  }
});

/**
 * Get user payment methods
 */
payments.get('/payment-methods', async (c) => {
  const userId = c.get('userId');
  
  try {
    const paymentMethods = await c.env.DB.prepare(`
      SELECT id, type, is_default, details, created_at
      FROM payment_methods
      WHERE user_id = ? AND is_active = TRUE AND type = 'promptpay'
      ORDER BY is_default DESC, created_at DESC
    `).bind(userId).all();

    const methods = paymentMethods.results.map((pm: any) => {
      const details = JSON.parse(pm.details || '{}');
      
      // Mask sensitive information
      const maskedDetails = { phoneNumber: details.phoneNumber };

      return {
        id: pm.id,
        type: pm.type,
        isDefault: pm.is_default,
        details: maskedDetails,
        createdAt: pm.created_at
      };
    });

    return jsonSuccess(c, {
      paymentMethods: methods
    }, 'Payment methods retrieved successfully');

  } catch (error) {
    console.error('Get payment methods error:', error);
    return jsonError(c, 'Failed to retrieve payment methods', 'An error occurred while fetching payment methods', 500);
  }
});

/**
 * Add payment method
 */
payments.post('/payment-methods', zValidator('json', createPaymentMethodSchema), async (c) => {
  const userId = c.get('userId');
  const { type, details, isDefault } = c.req.valid('json');
  
  try {
    // This endpoint stores only a PromptPay contact reference. Raw PAN, CVV,
    // expiry, bank-account, and wallet credentials are rejected by the strict schema.
    const processedDetails = { phoneNumber: details.phoneNumber };

    // If this is set as default, unset other defaults
    if (isDefault) {
      await c.env.DB.prepare(`
        UPDATE payment_methods 
        SET is_default = FALSE 
        WHERE user_id = ? AND is_active = TRUE
      `).bind(userId).run();
    }

    // Create payment method
    const paymentMethodId = crypto.randomUUID();
    const now = new Date().toISOString();

    await c.env.DB.prepare(`
      INSERT INTO payment_methods (
        id, user_id, type, details, is_default, is_active, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      paymentMethodId,
      userId,
      type,
      JSON.stringify(processedDetails),
      isDefault,
      true,
      now,
      now
    ).run();

    // Track payment method addition
    await c.env.ANALYTICS_QUEUE.send({
      eventType: 'payment_method_added',
      userId,
      properties: {
        paymentMethodId,
        type,
        isDefault
      },
      timestamp: now
    });

    return jsonSuccess(c, {
      paymentMethod: {
        id: paymentMethodId,
        type,
        isDefault,
        details: processedDetails
      }
    }, 'Payment method added successfully', 201);

  } catch (error) {
    console.error('Add payment method error:', error);
    return jsonError(c, 'Failed to add payment method', 'An error occurred while adding the payment method', 500);
  }
});

/**
 * Remove payment method
 */
payments.delete('/payment-methods/:id', validateUUID('id'), async (c) => {
  const paymentMethodId = c.req.param('id');
  const userId = c.get('userId');
  
  try {
    // Check if payment method exists and belongs to user
    const paymentMethod = await c.env.DB.prepare(`
      SELECT id, is_default FROM payment_methods
      WHERE id = ? AND user_id = ? AND is_active = TRUE
    `).bind(paymentMethodId, userId).first();

    if (!paymentMethod) {
      return jsonError(c, 'Payment method not found', 'The requested payment method does not exist', 404);
    }

    // Check if there are pending payments using this method
    const pendingPayments = await c.env.DB.prepare(`
      SELECT id FROM bookings
      WHERE payment_method_id = ? AND payment_status = 'pending'
    `).bind(paymentMethodId).first();

    if (pendingPayments) {
      return jsonError(c, 'Cannot remove payment method', 'This payment method has pending transactions', 409);
    }

    // Soft delete the payment method
    await c.env.DB.prepare(`
      UPDATE payment_methods 
      SET is_active = FALSE, updated_at = ?
      WHERE id = ?
    `).bind(new Date().toISOString(), paymentMethodId).run();

    // If this was the default method, set another as default
    if (paymentMethod.is_default) {
      const nextMethod = await c.env.DB.prepare(`
        SELECT id FROM payment_methods
        WHERE user_id = ? AND is_active = TRUE
        ORDER BY created_at DESC
        LIMIT 1
      `).bind(userId).first();

      if (nextMethod) {
        await c.env.DB.prepare(`
          UPDATE payment_methods 
          SET is_default = TRUE 
          WHERE id = ?
        `).bind(nextMethod.id).run();
      }
    }

    // Track payment method removal
    await c.env.ANALYTICS_QUEUE.send({
      eventType: 'payment_method_removed',
      userId,
      properties: {
        paymentMethodId
      },
      timestamp: new Date().toISOString()
    });

    return jsonSuccess(c, {}, 'Payment method removed successfully');

  } catch (error) {
    console.error('Remove payment method error:', error);
    return jsonError(c, 'Failed to remove payment method', 'An error occurred while removing the payment method', 500);
  }
});

/**
 * Get payment history
 */
payments.get('/payments/history', validatePagination(), async (c) => {
  const userId = c.get('userId');
  const { page, limit } = c.get('validatedQuery');
  const status = c.req.query('status');
  
  try {
    let query = `
      SELECT 
        b.id as booking_id,
        b.total_amount,
        b.service_fee,
        b.payment_status,
        b.created_at,
        b.updated_at,
        pm.type as payment_method_type,
        JSON_EXTRACT(pm.details, '$.last4') as payment_method_last4,
        sp.display_name as companion_name,
        s.title as service_name
      FROM bookings b
      LEFT JOIN payment_methods pm ON b.payment_method_id = pm.id
      LEFT JOIN supplier_profiles sp ON b.companion_id = sp.user_id
      LEFT JOIN supplier_services s ON b.service_id = s.id
      WHERE b.customer_id = ?
    `;

    const queryParams = [userId];

    if (status) {
      query += ` AND b.payment_status = ?`;
      queryParams.push(status);
    }

    query += ` ORDER BY b.created_at DESC`;

    // Get total count
    const countQuery = query.replace(/SELECT.*FROM/, 'SELECT COUNT(*) as total FROM');
    const countResult = await c.env.DB.prepare(countQuery).bind(...queryParams).first();
    const total = countResult?.total as number || 0;

    // Get paginated results
    const offset = (page - 1) * limit;
    const paginatedQuery = `${query} LIMIT ? OFFSET ?`;
    const paymentsResult = await c.env.DB.prepare(paginatedQuery)
      .bind(...queryParams, limit, offset).all();

    const paymentsList = paymentsResult.results.map((payment: any) => ({
      id: payment.booking_id,
      bookingId: payment.booking_id,
      amount: payment.total_amount - payment.service_fee,
      serviceFee: payment.service_fee,
      totalAmount: payment.total_amount,
      currency: 'THB',
      status: payment.payment_status,
      paymentMethod: {
        type: payment.payment_method_type,
        last4: payment.payment_method_last4
      },
      companionName: payment.companion_name,
      serviceName: payment.service_name,
      createdAt: payment.created_at,
      completedAt: payment.payment_status === 'completed' ? payment.updated_at : null
    }));

    return jsonSuccess(c, {
      payments: paymentsList,
      pagination: createPagination(page, limit, total)
    });

  } catch (error) {
    console.error('Get payment history error:', error);
    return jsonError(c, 'Failed to retrieve payment history', 'An error occurred while fetching payment history', 500);
  }
});

export { payments as paymentRoutes };
